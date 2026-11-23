// 转速漂移模型：模拟控制板编码器脉冲实测
// 真机每圈周期 T(t) 随电压波动；这里用低频正弦 + 缓变随机游走重建该过程，
// 输出"瞬时实测转速"，FanRenderer 据此积分每帧扇形角区间。
export class RpmDriftModel {
  private target: number;
  private amplitude: number;
  private walk = 0;
  private t = 0;

  constructor(target = 900, amplitude = 0) {
    this.target = target;
    this.amplitude = amplitude;
  }

  setTarget(rpm: number): void {
    this.target = rpm;
  }

  setAmplitude(peakToPeak: number): void {
    this.amplitude = peakToPeak;
  }

  /**
   * @param dtSec 距上次采样的真实时间
   * @returns 瞬时实测 rpm（等价于 60 / 编码器实测每圈周期）
   */
  sample(dtSec: number): number {
    this.t += dtSec;
    // 随机游走：电压缓漂，限幅在振幅一半以内
    const wander = (Math.random() - 0.5) * this.amplitude * 0.15;
    this.walk = Math.max(-this.amplitude * 0.5, Math.min(this.amplitude * 0.5, this.walk + wander));
    // 0.7~2.5Hz 的电压纹波
    const ripple = Math.sin(this.t * 2 * Math.PI * 1.3) * this.amplitude * 0.35
      + Math.sin(this.t * 2 * Math.PI * 0.7 + 1.7) * this.amplitude * 0.15;
    return Math.max(300, Math.min(1800, this.target + this.walk + ripple));
  }

  /** 注入真实控制板回传的每圈周期（毫秒），Web Serial 路径使用 */
  fromPeriodMs(periodMs: number): number {
    if (periodMs <= 0) return this.target;
    this.target = 60000 / periodMs;
    return this.target;
  }
}
