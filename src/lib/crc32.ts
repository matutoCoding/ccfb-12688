/** CRC32（IEEE 802.3 多项式，与常见固件校验一致），纯实现无依赖 */

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  let crc = seed;
  for (let i = 0; i < bytes.length; i++) {
    crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 8 位十六进制，便于写进包头与报告 */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).toUpperCase().padStart(8, '0');
}
