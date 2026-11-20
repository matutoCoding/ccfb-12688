/**
 * 真机转速遥测仿真器。
 * 真机由控制板回传编码器脉冲；无设备联调时用它产生带电压漂移的周期序列，
 * 驱动 SectorMapper，验证转速突变下画面不拉伸不压缩。
 */
import type { RotationDirection } from '../types';

export class TelemetrySimulator {
  targetRpm: number;
  /** 漂移幅度（rpm 的标准差），0 表示恒速 */
  driftAmplitude: number;
  /** 电压突变事件队列：在 atSec 时刻把目标转速瞬时切到 jumpRpm */
  private jumps: { atSec: number; jumpRpm: number }[] = [];
  private elapsed = 0;
  private currentRpm: number;

  /** 当前仿真时钟（秒） */
  get clock(): number {
    return this.elapsed;
  }

  constructor(targetRpm = 900, driftAmplitude = 12) {
    this.targetRpm = targetRpm;
    this.currentRpm = targetRpm;
    this.driftAmplitude = driftAmplitude;
  }

  addVoltageJump(atSec: number, jumpRpm: number): void {
    this.jumps.push({ atSec, jumpRpm });
    this.jumps.sort((a, b) => a.atSec - b.atSec);
  }

  reset(): void {
    this.elapsed = 0;
    this.currentRpm = this.targetRpm;
    this.jumps = [];
  }

  get rpm(): number {
    return this.currentRpm;
  }

  /**
   * 推进 dt 秒，返回本步内完成的若干圈（每圈给出结束时刻与实测周期）。
   * 用连续圈数累积 + 事件边界切分，保证电压突变在其发生时刻立即生效，
   * 突变所在圈按突变后的转速计周期，与真机编码器在突变后测得的周期一致。
   * 漂移用确定性正弦叠加，避免 Math.random 造成跨帧抖动。
   */
  advance(dt: number): { tEnd: number; periodSec: number }[] {
    const revs: { tEnd: number; periodSec: number }[] = [];
    const stepEnd = this.elapsed + dt;
    // 本时间步内的事件边界（含步末），事件在其时刻才生效
    const boundaries: { at: number; jumpRpm?: number }[] = [{ at: stepEnd }];
    for (const j of this.jumps) {
      if (j.atSec > this.elapsed && j.atSec <= stepEnd) boundaries.push({ at: j.atSec, jumpRpm: j.jumpRpm });
    }
    boundaries.sort((a, b) => a.at - b.at);
    this.jumps = this.jumps.filter((j) => !(j.atSec > this.elapsed && j.atSec <= stepEnd));

    let cursor = this.elapsed;
    let segStart = this.elapsed;
    for (const seg of boundaries) {
      const segEnd = seg.at;
      // 段内逐圈完成；瞬时转速 = 当前工作点 + 确定性漂移。cursor 跨段连续，不丢圈不重圈
      while (true) {
        const rpmNow = Math.max(30, this.currentRpm + this.instantDrift(cursor));
        const period = 60 / rpmNow;
        const nextEnd = cursor + period;
        if (nextEnd > segEnd + 1e-9) break;
        revs.push({ tEnd: nextEnd, periodSec: period });
        cursor = nextEnd;
        // 调速器按真实时间向目标缓变回归（时间常数约 2s，不会一圈就拉回）
        this.currentRpm += (this.targetRpm - this.currentRpm) * Math.min(1, period * 0.5);
      }
      this.currentRpm += (this.targetRpm - this.currentRpm) * Math.min(1, (segEnd - segStart) * 0.5);
      // 段末（=下一事件时刻）才应用突变，保证本段圈周期完全由本段转速决定
      if (seg.jumpRpm !== undefined) {
        this.currentRpm = seg.jumpRpm;
        this.targetRpm = seg.jumpRpm;
      }
      segStart = segEnd;
    }
    this.elapsed = stepEnd;
    return revs;
  }

  /** 确定性漂移：双频正弦叠加，不使用随机数，保证同输入同输出、无闪烁 */
  private instantDrift(t: number): number {
    if (this.driftAmplitude === 0) return 0;
    return (
      this.driftAmplitude * 0.6 * Math.sin(t * 2.1) +
      this.driftAmplitude * 0.4 * Math.sin(t * 0.7 + 1.7)
    );
  }
}

export function directionSign(dir: RotationDirection): 1 | -1 {
  return dir === 'cw' ? 1 : -1;
}

export const RPM_MIN = 300;
export const RPM_MAX = 1800;
