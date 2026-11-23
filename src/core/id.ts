let counter = 0;

/** 时间前缀 + 递增计数，避免依赖 crypto.randomUUID（非安全上下文兜底） */
export function uid(prefix = 'id'): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}
