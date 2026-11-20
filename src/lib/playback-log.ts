/**
 * U 盘回读播放日志解析 + 上播统计 + 验收报告。
 *
 * 日志行格式（设备端固件写出，CSV）：
 *   deviceSerial,materialCode,startEpoch,endEpoch,rpmAvg
 * 以 # 开头为注释行。
 */
import type { PlaybackLogEntry, PlaybackStats, Project } from '../types';
import { downloadBlob } from './dom';

export function parsePlaybackLog(text: string): PlaybackLogEntry[] {
  const entries: PlaybackLogEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(/[,\s]+/);
    if (cols.length < 5) continue;
    const [deviceSerial, materialCode, s0, s1, rpm] = cols;
    const startEpochSec = Number(s0);
    const endEpochSec = Number(s1);
    const measuredRpmAvg = Number(rpm);
    if (![startEpochSec, endEpochSec, measuredRpmAvg].every(Number.isFinite)) continue;
    entries.push({ deviceSerial, materialCode, startEpochSec, endEpochSec, measuredRpmAvg });
  }
  return entries;
}

/**
 * 按素材编号统计上播次数与累计时长。
 * 工程中不存在的素材编号 -> anomalous 异常记录，单独列出。
 */
export function buildStats(entries: PlaybackLogEntry[], project: Project | null, knownClipCodes: Set<string>): PlaybackStats {
  const map = new Map<string, { playCount: number; totalDurationSec: number }>();
  for (const e of entries) {
    const cur = map.get(e.materialCode) ?? { playCount: 0, totalDurationSec: 0 };
    cur.playCount += 1;
    cur.totalDurationSec += Math.max(0, e.endEpochSec - e.startEpochSec);
    map.set(e.materialCode, cur);
  }
  const byMaterial = [...map.entries()].map(([materialCode, v]) => ({
    materialCode,
    playCount: v.playCount,
    totalDurationSec: Math.round(v.totalDurationSec),
    anomalous: !knownClipCodes.has(materialCode),
  }));
  byMaterial.sort((a, b) => b.playCount - a.playCount);

  const anomalies = entries.filter((e) => !knownClipCodes.has(e.materialCode));
  void project;
  return { byMaterial, anomalies, totalEntries: entries.length };
}

/** 上播验收报告（Markdown，可直接交付客户） */
export function buildAcceptanceReport(
  stats: PlaybackStats,
  projectName: string,
  deviceSerials: string[],
): string {
  const lines: string[] = [];
  lines.push(`# 上播验收报告 · ${projectName}`);
  lines.push('');
  lines.push(`- 生成时间：${new Date().toLocaleString()}`);
  lines.push(`- 涉及设备：${deviceSerials.join('、') || '—'}`);
  lines.push(`- 日志条目总数：${stats.totalEntries}`);
  lines.push(`- 异常记录数：${stats.anomalies.length}`);
  lines.push('');
  lines.push('## 素材上播统计');
  lines.push('');
  lines.push('| 素材编号 | 上播次数 | 累计时长(s) | 状态 |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const m of stats.byMaterial) {
    lines.push(
      `| ${m.materialCode} | ${m.playCount} | ${m.totalDurationSec} | ${m.anomalous ? '⚠️ 异常（工程中不存在）' : '正常'} |`,
    );
  }
  if (stats.anomalies.length) {
    lines.push('');
    lines.push('## 异常记录明细');
    lines.push('');
    lines.push('| 设备 | 素材编号 | 起播时刻 | 结束时刻 | 平均转速(rpm) |');
    lines.push('| --- | --- | --- | --- | ---: |');
    for (const a of stats.anomalies) {
      lines.push(
        `| ${a.deviceSerial} | ${a.materialCode} | ${new Date(a.startEpochSec * 1000).toLocaleString()} | ${new Date(a.endEpochSec * 1000).toLocaleString()} | ${a.measuredRpmAvg.toFixed(0)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 上播次数分布');
  lines.push('');
  const maxCount = Math.max(1, ...stats.byMaterial.map((m) => m.playCount));
  for (const m of stats.byMaterial) {
    const bar = '█'.repeat(Math.round((m.playCount / maxCount) * 24));
    lines.push(`- ${m.materialCode.padEnd(12)} ${bar} ${m.playCount}`);
  }
  return lines.join('\n');
}

export function exportReport(markdown: string, projectName: string): void {
  downloadBlob(
    new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
    `${projectName}_上播验收报告.md`,
  );
}

/** 生成一份演示用日志文本（便于无设备时体验完整链路） */
export function sampleLogText(clipCodes: string[], serial: string): string {
  const now = Math.floor(Date.now() / 1000);
  const rows = ['# POV fan playback log', '# serial,material,startEpoch,endEpoch,rpmAvg'];
  let t = now - 3600 * 6;
  for (let i = 0; i < 24; i++) {
    const code = clipCodes[i % Math.max(1, clipCodes.length)] ?? `CLIP_${i}`;
    const dur = 20 + (i % 5) * 9;
    const rpm = 880 + (i % 4) * 12;
    rows.push(`${serial},${i % 7 === 3 ? 'UNKNOWN_X' : code},${t},${t + dur},${rpm}`);
    t += dur + 30;
  }
  return rows.join('\n');
}
