// U 盘回传播放日志解析
// 支持两种格式：
//  CSV: serial,material,start_unix,end_unix,rpm
//  控制板风格 TXT: [SN] PLAY <code> <start> <end> <rpm>
import type { PlayLogEntry } from '../core/types';
import { readFileAsText } from '../core/mathutil';

export interface ParsedPlayLog {
  entries: PlayLogEntry[];
  unknownMaterials: string[];
  errors: string[];
}

export async function parsePlayLogFile(file: File): Promise<ParsedPlayLog> {
  const text = await readFileAsText(file);
  return parsePlayLogText(text);
}

export function parsePlayLogText(text: string): ParsedPlayLog {
  const entries: PlayLogEntry[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  const unknown = new Set<string>();

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      if (line.startsWith('[')) {
        const m = /^\[([^\]]+)\]\s+PLAY\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)/.exec(line);
        if (!m) throw new Error('行格式不匹配');
        entries.push({
          deviceSerial: m[1],
          materialCode: m[2],
          startUnix: parseInt(m[3], 10),
          endUnix: parseInt(m[4], 10),
          measuredRpm: parseFloat(m[5]),
        });
      } else {
        const cols = line.split(/[,\t;]/).map((s) => s.trim());
        if (i === 0 && /serial|material/i.test(cols[0])) return; // 表头
        if (cols.length < 5) throw new Error('列数不足 5');
        entries.push({
          deviceSerial: cols[0],
          materialCode: cols[1],
          startUnix: parseInt(cols[2], 10),
          endUnix: parseInt(cols[3], 10),
          measuredRpm: parseFloat(cols[4]),
        });
      }
    } catch (e) {
      errors.push(`第 ${i + 1} 行解析失败：${(e as Error).message}`);
    }
  });

  return { entries, unknownMaterials: [...unknown], errors };
}

/** 与工程素材编号绑定表对照，标出工程中不存在的素材编号（异常记录） */
export function classifyEntries(
  parsed: ParsedPlayLog,
  knownCodes: Set<string>,
): { normal: PlayLogEntry[]; abnormal: PlayLogEntry[] } {
  const normal: PlayLogEntry[] = [];
  const abnormal: PlayLogEntry[] = [];
  for (const e of parsed.entries) {
    if (knownCodes.has(e.materialCode)) normal.push(e);
    else abnormal.push(e);
  }
  return { normal, abnormal };
}

export interface MaterialStat {
  materialCode: string;
  playCount: number;
  totalDurationSec: number;
  avgRpm: number;
  devices: string[];
}

export function aggregateByMaterial(entries: PlayLogEntry[]): MaterialStat[] {
  const map = new Map<string, { count: number; dur: number; rpmSum: number; rpmN: number; devs: Set<string> }>();
  for (const e of entries) {
    let row = map.get(e.materialCode);
    if (!row) {
      row = { count: 0, dur: 0, rpmSum: 0, rpmN: 0, devs: new Set() };
      map.set(e.materialCode, row);
    }
    row.count += 1;
    row.dur += Math.max(0, e.endUnix - e.startUnix);
    row.rpmSum += e.measuredRpm;
    row.rpmN += 1;
    row.devs.add(e.deviceSerial);
  }
  return [...map.entries()]
    .map(([materialCode, v]) => ({
      materialCode,
      playCount: v.count,
      totalDurationSec: v.dur,
      avgRpm: v.rpmN ? v.rpmSum / v.rpmN : 0,
      devices: [...v.devs],
    }))
    .sort((a, b) => b.playCount - a.playCount);
}

/** 生成一份示例日志供演示/测试下载 */
export function buildDemoLog(serial: string, codes: string[], rows = 40): string {
  const now = Math.floor(Date.now() / 1000);
  const lines = ['serial,material,start_unix,end_unix,rpm'];
  let t = now - rows * 300;
  for (let i = 0; i < rows; i++) {
    const code = codes[i % codes.length] ?? `MAT-UNKNOWN${i % 3}`;
    const dur = 60 + (i % 5) * 30;
    const rpm = 880 + ((i * 37) % 60);
    lines.push(`${serial},${code},${t},${t + dur},${rpm}`);
    t += dur + 120;
  }
  return lines.join('\n');
}
