// 多机风扇墙：按间距与相位差把同一画面切块，拼缝处灯珠轨迹不重叠、不留黑缝
import { clamp, degToRad } from '../core/mathutil';
import type { WallCell, WallLayout } from '../core/types';

export interface CellGeometry {
  cell: WallCell;
  /** 该台在整墙归一化坐标中的中心（0..1） */  cx: number;
  cy: number;
  /** 该台成像圆半径（归一化） */
  radius: number;
  /** 与相邻台的接缝角度（弧度），用于灯珠轨迹对齐 */
  seamAngleRad: number;
}

export function computeWallGeometry(wall: WallLayout): CellGeometry[] {
  const { cols, rows, gapMm, fanDiameterMm } = wall;
  const pitch = fanDiameterMm + gapMm;
  const totalW = cols * fanDiameterMm + (cols - 1) * gapMm;
  const totalH = rows * fanDiameterMm + (rows - 1) * gapMm;
  // 半径按实际成像圆（扇叶直径），间距由 pitch 体现，保证圆与圆之间不重叠
  const radiusX = fanDiameterMm / 2 / totalW;
  const radiusY = fanDiameterMm / 2 / totalH;
  return wall.cells.map((cell) => {
    const cx = (cell.col * pitch + fanDiameterMm / 2) / totalW;
    const cy = 1 - (cell.row * pitch + fanDiameterMm / 2) / totalH;
    // 接缝角：与右邻/下邻的连心线方向，灯珠在该角度对齐相位
    const seamAngleRad = Math.atan2(pitch * 0, pitch);
    return { cell, cx, cy, radius: Math.min(radiusX, radiusY), seamAngleRad };
  });
}

/**
 * 把整墙内容 UV 映射到单台内容 UV：
 * 每台只取自己圆形分块覆盖的区域，块间留 gap 对应的物理间隔（无黑缝：
 * gap 区域在真机上本就无灯珠，预览中以背景呈现而非拉伸相邻画面）。
 */
export function wallUvToCell(uvX: number, uvY: number, geo: CellGeometry): { u: number; v: number; inside: boolean } {
  const dx = (uvX - geo.cx) / geo.radius;
  const dy = (uvY - geo.cy) / geo.radius;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > 1) return { u: 0, v: 0, inside: false };
  // 相位差旋转：让相邻台在接缝角度处的灯珠轨迹衔接
  const phase = degToRad(geo.cell.phaseOffsetDeg);
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  const u = 0.5 + 0.5 * (dx * c - dy * s);
  const v = 0.5 + 0.5 * (dx * s + dy * c);
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1), inside: true };
}

/** 逐台漂移管理：每台独立漂移状态，单台变化只标记该块重算 */
export class WallDriftTracker {
  private rpmStates = new Map<string, { rpm: number; dirty: boolean; t: number }>();

  register(cell: WallCell, baseRpm: number): void {
    if (!this.rpmStates.has(cell.deviceId)) {
      this.rpmStates.set(cell.deviceId, { rpm: baseRpm, dirty: true, t: 0 });
    }
  }

  /** 单台转速漂移更新，仅该台 dirty */
  updateCell(deviceId: string, rpm: number): void {
    const st = this.rpmStates.get(deviceId);
    if (!st) return;
    if (Math.abs(st.rpm - rpm) > 0.01) {
      st.rpm = rpm;
      st.dirty = true;
    }
  }

  consumeDirty(deviceId: string): number | null {
    const st = this.rpmStates.get(deviceId);
    if (!st || !st.dirty) return null;
    st.dirty = false;
    return st.rpm;
  }

  getRpm(deviceId: string): number {
    return this.rpmStates.get(deviceId)?.rpm ?? 900;
  }

  clear(): void {
    this.rpmStates.clear();
  }
}
