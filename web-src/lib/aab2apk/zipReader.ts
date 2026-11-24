/**
 * Minimal random-access ZIP reader. Reads the central directory once, then
 * single entries on demand, so a 250 MB bundle never has to sit in memory as
 * a whole. Works on a browser Blob/File or on bytes in Node.
 */

import { utf8 } from "./bytes";

export interface ZipSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ZipSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export function bytesSource(bytes: Uint8Array): ZipSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

export class ZipFormatError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export class ZipReader {
  private readonly src: ZipSource;
  readonly entries: ZipEntry[];
  private readonly byName: Map<string, ZipEntry>;

  private constructor(src: ZipSource, entries: ZipEntry[], byName: Map<string, ZipEntry>) {
    this.src = src;
    this.entries = entries;
    this.byName = byName;
  }

  static async open(src: ZipSource): Promise<ZipReader> {
    const tailLen = Math.min(src.size, 22 + 0xffff);
    if (tailLen < 22) throw new ZipFormatError("file is too small to be a ZIP");
    const tail = await src.read(src.size - tailLen, tailLen);
    const t = dv(tail);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (t.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipFormatError("no ZIP end record");
    const count = t.getUint16(eocd + 10, true);
    const cdSize = t.getUint32(eocd + 12, true);
    const cdOffset = t.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipFormatError("ZIP64 is not supported");
    if (cdOffset + cdSize > src.size) throw new ZipFormatError("ZIP central directory is out of range");
    const cd = await src.read(cdOffset, cdSize);
    const c = dv(cd);
    const entries: ZipEntry[] = [];
    const byName = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || c.getUint32(p, true) !== CEN_SIG) throw new ZipFormatError("bad ZIP central directory");
      const flags = c.getUint16(p + 8, true);
      const nameLen = c.getUint16(p + 28, true);
      const extraLen = c.getUint16(p + 30, true);
      const commentLen = c.getUint16(p + 32, true);
      const entry: ZipEntry = {
        name: utf8(cd.subarray(p + 46, p + 46 + nameLen)),
        method: c.getUint16(p + 10, true),
        crc: c.getUint32(p + 16, true),
        compressedSize: c.getUint32(p + 20, true),
        size: c.getUint32(p + 24, true),
        localHeaderOffset: c.getUint32(p + 42, true),
      };
      if (flags & 1) throw new ZipFormatError("encrypted ZIP entries are not supported");
      if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) throw new ZipFormatError("ZIP64 is not supported");
      if (!entry.name.endsWith("/")) {
        if (byName.has(entry.name)) throw new ZipFormatError(`duplicate ZIP entry ${entry.name}`);
        entries.push(entry);
        byName.set(entry.name, entry);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipReader(src, entries, byName);
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** The entry's bytes exactly as stored in the archive (deflated or not). */
  async rawData(e: ZipEntry): Promise<Uint8Array> {
    const h = await this.src.read(e.localHeaderOffset, 30);
    const v = dv(h);
    if (h.length < 30 || v.getUint32(0, true) !== LOC_SIG) throw new ZipFormatError(`bad local header for ${e.name}`);
    const start = e.localHeaderOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    if (start + e.compressedSize > this.src.size) throw new ZipFormatError(`${e.name} is truncated`);
    return this.src.read(start, e.compressedSize);
  }

  /** The entry's uncompressed bytes. */
  async data(e: ZipEntry): Promise<Uint8Array> {
    const raw = await this.rawData(e);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new ZipFormatError(`${e.name} uses unsupported compression ${e.method}`);
    const out = await inflateRaw(raw);
    if (out.length !== e.size) throw new ZipFormatError(`${e.name} inflated to the wrong size`);
    return out;
  }
}

async function streamThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return streamThrough(data, new DecompressionStream("deflate-raw"));
}

export function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return streamThrough(data, new CompressionStream("deflate-raw"));
}
