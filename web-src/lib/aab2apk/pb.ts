/**
 * Strict protobuf wire-format reader for the aapt2 protos inside an .aab
 * (Resources.proto, Configuration.proto). The decoders in resourcesProto.ts
 * call `expectOnly` on every message so an unknown field number becomes a
 * refusal instead of being silently dropped.
 */

import { utf8 } from "./bytes";

export interface PbField {
  /** Field number. */
  n: number;
  /** Wire type: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  wt: number;
  /** Varint or fixed value. Varints above 2^53 keep only their low 32 bits. */
  num: number;
  /** Payload for wire type 2. */
  bytes: Uint8Array | null;
}

export class PbError extends Error {}

/** Thrown when a message carries a field number the decoder doesn't know. */
export class PbUnknownField extends Error {
  readonly messageName: string;
  readonly field: number;

  constructor(messageName: string, field: number) {
    super(`unknown field ${field} in ${messageName}`);
    this.messageName = messageName;
    this.field = field;
  }
}

export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  // Low and high words kept apart so a negative int32 (ten bytes on the wire)
  // keeps an exact two's-complement low word.
  let lo = 0;
  let hi = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new PbError("truncated varint");
    const b = buf[p++];
    const bits = b & 0x7f;
    if (shift < 28) lo |= bits << shift;
    else if (shift === 28) {
      lo |= (bits & 0x0f) << 28;
      hi |= bits >>> 4;
    } else if (shift < 64) hi |= bits << (shift - 32);
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new PbError("varint too long");
  }
  lo >>>= 0;
  hi >>>= 0;
  return [hi < 0x200000 ? hi * 4294967296 + lo : lo, p];
}

export function parsePb(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let p = 0;
  while (p < buf.length) {
    const [key, p1] = readVarint(buf, p);
    p = p1;
    const n = Math.floor(key / 8);
    const wt = key & 7;
    if (n === 0) throw new PbError("field number 0");
    if (wt === 0) {
      const [v, p2] = readVarint(buf, p);
      p = p2;
      out.push({ n, wt, num: v, bytes: null });
    } else if (wt === 2) {
      const [len, p2] = readVarint(buf, p);
      p = p2;
      if (p + len > buf.length) throw new PbError("truncated field");
      out.push({ n, wt, num: 0, bytes: buf.subarray(p, p + len) });
      p += len;
    } else if (wt === 5) {
      if (p + 4 > buf.length) throw new PbError("truncated fixed32");
      const v = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
      out.push({ n, wt, num: v, bytes: null });
      p += 4;
    } else if (wt === 1) {
      if (p + 8 > buf.length) throw new PbError("truncated fixed64");
      const v = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
      out.push({ n, wt, num: v, bytes: null });
      p += 8;
    } else {
      throw new PbError(`unsupported wire type ${wt}`);
    }
  }
  return out;
}

export class PbMessage {
  readonly fields: PbField[];

  constructor(buf: Uint8Array) {
    this.fields = parsePb(buf);
  }

  /** Field numbers present that are not in `known`. */
  unknown(known: readonly number[]): number[] {
    const out: number[] = [];
    for (const f of this.fields) if (!known.includes(f.n) && !out.includes(f.n)) out.push(f.n);
    return out;
  }

  /** Throw PbUnknownField if any field is outside `known`. */
  expectOnly(name: string, known: readonly number[]): this {
    const u = this.unknown(known);
    if (u.length) throw new PbUnknownField(name, u[0]);
    return this;
  }

  all(n: number): PbField[] {
    return this.fields.filter((f) => f.n === n);
  }

  has(n: number): boolean {
    return this.fields.some((f) => f.n === n);
  }

  /** Last occurrence wins, as protobuf specifies for scalar fields. */
  last(n: number): PbField | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) if (this.fields[i].n === n) return this.fields[i];
    return undefined;
  }

  uint(n: number): number {
    const f = this.last(n);
    return f ? f.num >>> 0 : 0;
  }

  int32(n: number): number {
    const f = this.last(n);
    return f ? f.num | 0 : 0;
  }

  bool(n: number): boolean {
    const f = this.last(n);
    return f ? f.num !== 0 : false;
  }

  /** Raw 32-bit pattern of a fixed32 or float field. */
  fixed32(n: number): number {
    const f = this.last(n);
    return f ? f.num >>> 0 : 0;
  }

  str(n: number): string {
    const f = this.last(n);
    return f && f.bytes ? utf8(f.bytes) : "";
  }

  raw(n: number): Uint8Array | null {
    const f = this.last(n);
    return f && f.bytes ? f.bytes : null;
  }

  msg(n: number): PbMessage | null {
    const f = this.last(n);
    return f && f.bytes ? new PbMessage(f.bytes) : null;
  }

  msgs(n: number): PbMessage[] {
    return this.all(n)
      .filter((f) => f.bytes)
      .map((f) => new PbMessage(f.bytes as Uint8Array));
  }

  /** Repeated string field. */
  strs(n: number): string[] {
    return this.all(n).map((f) => (f.bytes ? utf8(f.bytes) : ""));
  }
}
