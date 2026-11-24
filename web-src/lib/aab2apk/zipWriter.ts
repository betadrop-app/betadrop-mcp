/**
 * ZIP writer for APKs: CRC-32, stored or deflated entries, and alignment of
 * stored entries by padding the local header's extra field (what zipalign
 * does). The archive is built as a list of parts so the final Blob is
 * assembled without one big copy.
 */

import { utf8Encoder } from "./bytes";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipWriteEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  crc: number;
  size: number;
  /** Bytes as they go in the archive (deflated when method is 8). */
  data: Uint8Array;
  /** Alignment of the data start for stored entries (1 for none). */
  align: number;
}

interface Written {
  entry: ZipWriteEntry;
  offset: number;
  name: Uint8Array;
}

// 1980-01-01 00:00, the DOS epoch, so output does not depend on the clock.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

/** Bundletool / zipalign marker extra field id for alignment padding. */
const ALIGN_EXTRA_ID = 0xd935;

export class ZipWriter {
  readonly parts: Uint8Array[] = [];
  private offset = 0;
  private readonly written: Written[] = [];

  get length(): number {
    return this.offset;
  }

  private push(b: Uint8Array): void {
    this.parts.push(b);
    this.offset += b.length;
  }

  add(entry: ZipWriteEntry): void {
    const name = utf8Encoder.encode(entry.name);
    const headerEnd = this.offset + 30 + name.length;
    let extraLen = 0;
    if (entry.method === 0 && entry.align > 1) {
      const pad = (entry.align - ((headerEnd + 6) % entry.align)) % entry.align;
      extraLen = 6 + pad;
    }
    const h = new Uint8Array(30 + name.length + extraLen);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, entry.method === 0 ? 10 : 20, true);
    v.setUint16(6, UTF8_FLAG, true);
    v.setUint16(8, entry.method, true);
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, entry.crc, true);
    v.setUint32(18, entry.data.length, true);
    v.setUint32(22, entry.size, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, extraLen, true);
    h.set(name, 30);
    if (extraLen) {
      v.setUint16(30 + name.length, ALIGN_EXTRA_ID, true);
      v.setUint16(32 + name.length, extraLen - 4, true);
      v.setUint16(34 + name.length, entry.align, true);
    }
    this.written.push({ entry, offset: this.offset, name });
    this.push(h);
    this.push(entry.data);
  }

  /** Bytes from the first central directory record to the end of the archive. */
  centralDirectory(): Uint8Array {
    const size = this.written.reduce((n, w) => n + 46 + w.name.length, 0);
    const out = new Uint8Array(size + 22);
    const v = new DataView(out.buffer);
    let p = 0;
    for (const w of this.written) {
      const e = w.entry;
      v.setUint32(p, 0x02014b50, true);
      v.setUint16(p + 4, 20, true);
      v.setUint16(p + 6, e.method === 0 ? 10 : 20, true);
      v.setUint16(p + 8, UTF8_FLAG, true);
      v.setUint16(p + 10, e.method, true);
      v.setUint16(p + 12, DOS_TIME, true);
      v.setUint16(p + 14, DOS_DATE, true);
      v.setUint32(p + 16, e.crc, true);
      v.setUint32(p + 20, e.data.length, true);
      v.setUint32(p + 24, e.size, true);
      v.setUint16(p + 28, w.name.length, true);
      v.setUint32(p + 42, w.offset, true);
      out.set(w.name, p + 46);
      p += 46 + w.name.length;
    }
    v.setUint32(p, 0x06054b50, true);
    v.setUint16(p + 8, this.written.length, true);
    v.setUint16(p + 10, this.written.length, true);
    v.setUint32(p + 12, size, true);
    v.setUint32(p + 16, this.offset, true);
    return out;
  }
}
