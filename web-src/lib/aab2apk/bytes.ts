/**
 * Byte helpers for the in-browser AAB to APK converter: a growable
 * little-endian writer and chunk helpers for the Android binary formats.
 *
 * Pure functions, no network, no DOM. Runs the same in the browser and in
 * Node (unit tests and scripts/verify-aab2apk.mjs).
 */

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): number {
    this.ensure(1);
    const at = this.length;
    this.buf[this.length++] = v & 0xff;
    return at;
  }

  u16(v: number): number {
    this.ensure(2);
    const at = this.length;
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
    return at;
  }

  u32(v: number): number {
    this.ensure(4);
    const at = this.length;
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return at;
  }

  bytes(b: Uint8Array): number {
    this.ensure(b.length);
    const at = this.length;
    this.buf.set(b, this.length);
    this.length += b.length;
    return at;
  }

  zeros(n: number): number {
    this.ensure(n);
    const at = this.length;
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return at;
  }

  align4(): void {
    while (this.length % 4 !== 0) this.u8(0);
  }

  setU8(at: number, v: number): void {
    this.buf[at] = v & 0xff;
  }

  setU16(at: number, v: number): void {
    this.view.setUint16(at, v & 0xffff, true);
  }

  setU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true);
  }

  getU32(at: number): number {
    return this.view.getUint32(at, true);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * Start a chunk (aapt2 ChunkWriter): writes a ResChunk_header plus a zeroed
 * header body up to `headerSize`, and returns a finisher that pads to 4 bytes
 * and patches the chunk size.
 */
export function startChunk(w: ByteWriter, type: number, headerSize: number): { start: number; finish: () => void } {
  const start = w.length;
  w.u16(type);
  w.u16(headerSize);
  w.u32(0);
  w.zeros(headerSize - 8);
  return {
    start,
    finish: () => {
      w.align4();
      w.setU32(start + 4, w.length - start);
    },
  };
}

const utf8Decoder = new TextDecoder("utf-8");
export const utf8Encoder = new TextEncoder();

export function utf8(b: Uint8Array): string {
  return utf8Decoder.decode(b);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
