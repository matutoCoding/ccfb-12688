/**
 * 转速漂移补偿核心。
 *
 * 真机上控制板按编码器脉冲实测每圈周期 T（电压波动会令 T 漂移）。
 * 若按"标称转速"把内容帧均匀铺到 360°，转速突变时画面会被拉伸/压缩。
 * 这里以实测周期序列构建 物理时间 -> 机械角 的映射，内容帧始终按
 * 其应出现的物理时刻查映射得到扇形区间，角速度变化时成像不拉伸不压缩。
 */

export interface RevolutionSample {
  /** 该圈结束时刻（秒，模拟时钟） */
  tEnd: number;
  /** 该圈实测周期（秒） */
  periodSec: number;
}

export class SectorMapper {
  private samples: RevolutionSample[] = [];
  /** 最新瞬时角速度（rad/s，带符号） */
  angularVelocity = 0;
  /** 最新一圈周期（秒） */
  currentPeriodSec = 60 / 900;

  /**
   * 喂入一整圈的实测周期（真机来自编码器脉冲，仿真来自 TelemetrySimulator）。
   */
  pushRevolution(tEnd: number, periodSec: number): void {
    this.currentPeriodSec = Math.max(1e-4, periodSec);
    this.samples.push({ tEnd, periodSec: this.currentPeriodSec });
    // 只保留最近 8 圈，足够覆盖插值窗口
    if (this.samples.length > 8) this.samples.shift();
  }

  /**
   * 物理时刻 t 对应的机械角（弧度，未归一化，可跨多圈）。
   * 方向由 directionSign 决定：cw=+1，ccw=-1。
   */
  angleAt(t: number, directionSign: 1 | -1): number {
    if (this.samples.length === 0) {
      const w = directionSign * ((2 * Math.PI) / this.currentPeriodSec);
      this.angularVelocity = w;
      return w * t;
    }
    const last = this.samples[this.samples.length - 1];
    // 最新一圈之后：用最新周期外推
    if (t >= last.tEnd) {
      const w = directionSign * ((2 * Math.PI) / last.periodSec);
      this.angularVelocity = w;
      const revsBefore = this.samples.length; // 样本即已完成圈数
      const baseAngle = directionSign * revsBefore * 2 * Math.PI;
      return baseAngle + w * (t - last.tEnd);
    }
    // 历史区间内：找到 t 所在圈，按该圈实测周期线性插值
    let revs = 0;
    let segStart = 0;
    let segEnd = this.samples[0].tEnd;
    for (let i = 0; i < this.samples.length; i++) {
      const prevEnd = i === 0 ? 0 : this.samples[i - 1].tEnd;
      if (t <= this.samples[i].tEnd) {
        revs = i;
        segStart = prevEnd;
        segEnd = this.samples[i].tEnd;
        break;
      }
    }
    const period = segEnd - segStart || this.currentPeriodSec;
    const local = (t - segStart) / period; // 圈内切向位置 0..1
    const w = directionSign * ((2 * Math.PI) / period);
    this.angularVelocity = w;
    return directionSign * (revs + local) * 2 * Math.PI;
  }

  /**
   * 给定内容帧的时间窗口 [t0, t1]，返回它扫过的机械角区间（弧度，已 mod 2π）。
   * 渲染端据此把帧贴到正确扇形位置——这正是"动态调整每帧画面对应的扇形角区间"。
   */
  sectorFor(t0: number, t1: number, directionSign: 1 | -1): { a0: number; a1: number } {
    const a0 = mod2pi(this.angleAt(t0, directionSign));
    const a1 = mod2pi(this.angleAt(t1, directionSign));
    return { a0, a1 };
  }

  get measuredRpm(): number {
    return 60 / this.currentPeriodSec;
  }

  reset(): void {
    this.samples = [];
  }
}

export function mod2pi(a: number): number {
  const twoPi = 2 * Math.PI;
  return ((a % twoPi) + twoPi) % twoPi;
}

/**
 * 构建内容帧 -> 机械角 的 LUT（每帧一个角度，用于着色器 sectorMap 纹理）。
 * framesPerRevolution 帧按内容时间均匀切分一圈，角度由实测映射决定。
 */
export function buildSectorLut(
  mapper: SectorMapper,
  framesPerRevolution: number,
  contentTimeOffsetSec: number,
  directionSign: 1 | -1,
): Float32Array {
  const out = new Float32Array(framesPerRevolution);
  const period = mapper.currentPeriodSec;
  for (let f = 0; f < framesPerRevolution; f++) {
    const t0 = contentTimeOffsetSec + (f / framesPerRevolution) * period;
    const t1 = contentTimeOffsetSec + ((f + 1) / framesPerRevolution) * period;
    const { a0 } = mapper.sectorFor(t0, t1, directionSign);
    out[f] = a0 / (2 * Math.PI); // 归一化 0..1，便于纹素存储
  }
  return out;
}

/**
 * 逆映射 LUT：机械角(0..1) -> 内容帧位(0..1)。
 * 正向 LUT 在转速漂移时不保证单调，着色器内二分不可靠；
 * 这里在 CPU 以角度桶直接采样正向表（最近邻），天然处理环绕与非单调。
 * 输出长度 = framesPerRevolution，第 i 项 = 落在角度桶 i 内的内容帧位。
 */
export function buildInverseSectorLut(forward: Float32Array): Float32Array {
  const n = forward.length;
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = -1;
  for (let f = 0; f < n; f++) {
    const bucket = Math.floor(forward[f] * n) % n;
    if (inv[bucket] < 0) inv[bucket] = f / n;
  }
  // 填空洞：沿角度环向前找最近已填帧
  for (let i = 0; i < n; i++) {
    if (inv[i] >= 0) continue;
    for (let step = 1; step < n; step++) {
      const v = inv[(i + step) % n];
      if (v >= 0) {
        inv[i] = v;
        break;
      }
    }
  }
  return inv;
}
