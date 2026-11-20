import { describe, it, expect } from 'vitest';
import { crc32, crc32Hex } from '../src/lib/crc32';
import { snapToFrame, nudgeFrame, secToTimecode, timecodeToSec } from '../src/lib/timecode';
import { SectorMapper, buildSectorLut, buildInverseSectorLut } from '../src/lib/sector-mapper';
import { TelemetrySimulator } from '../src/lib/telemetry';
import { parseCalibrationCsv, interp1d } from '../src/lib/pwm';
import { brightnessAtLux, upsertAnchor, DEFAULT_AMBIENT_CURVE } from '../src/lib/ambient';
import { parseCubeLut, identityCubeText, applyLut } from '../src/lib/lut';
import { buildPacket, verifyPacket, PACKET_MAGIC } from '../src/lib/export';

// Node 测试环境无 ImageData，用最小结构垫片（applyLut 只访问 data/width/height）
class ImageDataShim {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height = 1) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
(globalThis as unknown as { ImageData: unknown }).ImageData ??= ImageDataShim;

describe('CRC32', () => {
  it('与已知校验值一致（"123456789" -> CBF43926）', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes).toString(16).toUpperCase()).toBe('CBF43926');
    expect(crc32Hex(bytes)).toBe('CBF43926');
  });
  it('空输入为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('时间码', () => {
  it('秒与 HH:MM:SS:FF 互转并对齐帧边界', () => {
    // 3661.5s @25fps = 91537.5 帧，四舍五入到第 13 帧
    expect(secToTimecode(3661.5, 25)).toBe('01:01:01:13');
    expect(timecodeToSec('01:01:01:12', 25)).toBeCloseTo(3661.48, 1);
    expect(snapToFrame(0.123456, 25)).toBeCloseTo(0.12, 5);
  });
  it('逐帧微调并 clamp', () => {
    expect(nudgeFrame(0, 25, 1, 10)).toBeCloseTo(0.04, 5);
    expect(nudgeFrame(10, 25, 5, 10)).toBe(10);
    expect(nudgeFrame(0, 25, -3, 10)).toBe(0);
  });
});

describe('转速漂移补偿 SectorMapper', () => {
  it('恒速下角度随时间线性增长', () => {
    const m = new SectorMapper();
    // 900rpm => 周期 1/15 s
    const period = 60 / 900;
    for (let i = 1; i <= 5; i++) m.pushRevolution(i * period, period);
    const a = m.angleAt(3 * period, 1);
    expect(a / (2 * Math.PI)).toBeCloseTo(3, 5);
  });
  it('转速突变时同一物理时刻的角度由实测周期决定（不拉伸）', () => {
    const m = new SectorMapper();
    const slow = 60 / 600; // 0.1s
    const fast = 60 / 1200; // 0.05s
    m.pushRevolution(slow, slow);
    m.pushRevolution(slow + fast, fast);
    // 第二圈内中点：1.5 圈
    const a = m.angleAt(slow + fast / 2, 1) / (2 * Math.PI);
    expect(a).toBeCloseTo(1.5, 5);
  });
  it('逆时针方向符号为负', () => {
    const m = new SectorMapper();
    const p = 60 / 900;
    m.pushRevolution(p, p);
    expect(m.angleAt(p / 2, -1)).toBeCloseTo(-Math.PI, 5);
  });
  it('遥测仿真确定性：同输入产生同周期序列', () => {
    const a = new TelemetrySimulator(900, 10);
    const b = new TelemetrySimulator(900, 10);
    const ra = a.advance(1).map((x) => x.periodSec);
    const rb = b.advance(1).map((x) => x.periodSec);
    expect(ra).toEqual(rb);
  });
  it('电压突变后实测周期立即改变（无漂移时可精确断言）', () => {
    const sim = new TelemetrySimulator(900, 0);
    // 先推进 0.05s（不足一圈，900rpm 周期 66.7ms）
    sim.advance(0.05);
    // 在 0.15s 处突变到 1800rpm：此前至少能完成一个完整的 900rpm 圈
    sim.addVoltageJump(0.15, 1800);
    const after = sim.advance(0.25);
    const periods = after.map((r) => r.periodSec);
    expect(periods.some((p) => Math.abs(p - 60 / 1800) < 0.002)).toBe(true);
    expect(periods.some((p) => Math.abs(p - 60 / 900) < 0.002)).toBe(true);
    // 突变后周期必然短于突变前
    const first = periods[0];
    const last = periods[periods.length - 1];
    expect(last).toBeLessThan(first);
  });
  it('逆扇形 LUT 无空洞且恒速下角度与帧位近似互逆', () => {
    const m = new SectorMapper();
    const period = 60 / 900;
    for (let i = 1; i <= 4; i++) m.pushRevolution(i * period, period);
    const fpr = 360;
    const forward = buildSectorLut(m, fpr, 0, 1);
    const inv = buildInverseSectorLut(forward);
    expect(inv.length).toBe(fpr);
    // 无 -1 空洞
    expect(inv.every((v) => v >= 0 && v <= 1)).toBe(true);
    // 恒速：forward[f] ≈ f/fpr，逆查表在角度桶 fpr*forward[f] 处应回到 f/fpr 附近
    const f = 120;
    const bucket = Math.floor(forward[f] * fpr) % fpr;
    expect(Math.abs(inv[bucket] - f / fpr)).toBeLessThan(2 / fpr);
  });
});

describe('PWM 校准', () => {
  it('解析 CSV 并重采样到 256 点', () => {
    const csv = ['0,0,0,0', '128,0.2,0.25,0.3', '255,1,1,1'].join('\n');
    const c = parseCalibrationCsv(csv);
    expect(c.r.length).toBe(256);
    expect(c.r[0]).toBe(0);
    expect(c.r[255]).toBe(1);
    expect(c.g[128]).toBeCloseTo(0.25, 4);
  });
  it('单调锚点插值越界取端点', () => {
    expect(interp1d([0, 1], [0.2, 0.8], -1)).toBe(0.2);
    expect(interp1d([0, 1], [0.2, 0.8], 2)).toBe(0.8);
    expect(interp1d([0, 1], [0.2, 0.8], 0.5)).toBeCloseTo(0.5, 5);
  });
});

describe('环境光曲线', () => {
  it('按锚点插值且白天亮夜间暗', () => {
    const night = brightnessAtLux(DEFAULT_AMBIENT_CURVE, 0);
    const day = brightnessAtLux(DEFAULT_AMBIENT_CURVE, 2000);
    expect(day).toBeGreaterThan(night);
    const next = upsertAnchor(DEFAULT_AMBIENT_CURVE, { lux: 300, brightness: 0.5 });
    expect(brightnessAtLux(next, 300)).toBeCloseTo(0.5, 5);
  });
});

describe('LUT', () => {
  it('恒等 LUT 套用后像素在插值量化误差内（9³ 格点，容差 4/255）', () => {
    const lut = parseCubeLut(identityCubeText(9), 'identity');
    expect(lut.size).toBe(9);
    const img = new ImageData(new Uint8ClampedArray([100, 150, 200, 255]), 1, 1);
    const out = applyLut(img, lut, 1, 0, 1);
    expect(Math.abs(out.data[0] - 100)).toBeLessThanOrEqual(4);
    expect(Math.abs(out.data[1] - 150)).toBeLessThanOrEqual(4);
    expect(Math.abs(out.data[2] - 200)).toBeLessThanOrEqual(4);
  });
  it('33³ 高精度恒等 LUT 误差更小（≤1/255）', () => {
    const lut = parseCubeLut(identityCubeText(33), 'identity33');
    const img = new ImageData(new Uint8ClampedArray([100, 150, 200, 255]), 1, 1);
    const out = applyLut(img, lut, 1, 0, 1);
    expect(Math.abs(out.data[0] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[2] - 200)).toBeLessThanOrEqual(1);
  });
  it('坏数据抛错', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0', 'bad')).toThrow();
  });
});

describe('固件数据包', () => {
  it('打包后魔数/CRC 自校验通过，篡改后校验失败', () => {
    const led = 16;
    const frames = Array.from({ length: 4 }, (_, f) => {
      const d = new Uint8ClampedArray(led * 4);
      for (let i = 0; i < led; i++) d.set([f * 40, 100, 200, 255], i * 4);
      return d;
    });
    const r = buildPacket(frames, led, 4, 0.9, 'proj');
    expect(r.info.crc32).toBeGreaterThan(0);
    expect(verifyPacket(r.bytes).ok).toBe(true);
    const dv = new DataView(r.bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(PACKET_MAGIC);
    const tampered = new Uint8Array(r.bytes);
    tampered[20] ^= 0xff;
    expect(verifyPacket(tampered).ok).toBe(false);
  });
  it('越界灯珠被记录并给出帧号', () => {
    const led = 32;
    const frame = new Uint8ClampedArray(led * 4);
    for (let i = 0; i < led; i++) frame.set([255, 255, 255, 255], i * 4);
    const r = buildPacket([frame], led, 1, 0.5, 'proj');
    expect(r.info.safetyViolations.length).toBe(1);
    expect(r.info.safetyViolations[0].frameIndex).toBe(0);
    expect(r.violationMask.some((v) => v === 1)).toBe(true);
  });
});
