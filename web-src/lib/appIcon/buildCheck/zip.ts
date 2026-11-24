/**
 * A random-access zip reader for .ipa, .apk and .aab files.
 *
 * It reads the end record and the central directory from the tail of the file, then single
 * entries by offset, through `Blob.slice`. A 300 MB build is never loaded whole: checking its
 * icons touches the directory, a few small files and the asset catalog. A deflated entry is
 * streamed from the file through `DecompressionStream("deflate-raw")` into one buffer of its
 * stated size, so a 150 MB Assets.car costs about 150 MB, not a compressed copy plus inflated
 * chunks plus their join. The decompressor is native in current browsers and in Node 18+, so the
 * tests run this exact code on the real fixtures.
 *
 * ZIP64 is read (the end record and the per-entry extra field), because Xcode writes it for large
 * archives. Encrypted entries and methods other than stored and deflate read as null.
 */

import type { Archive } from "./types";

export class ZipError extends Error {}

/** Bytes by offset: a File or Blob in the browser, a buffer in the tests. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** The same range as a stream, so a large entry is inflated without first being read whole. */
  stream?(offset: number, length: number): ReadableStream<Chunk>;
}

/** What a stream into DecompressionStream may carry: bytes on a plain (not shared) ArrayBuffer. */
type Chunk = Uint8Array<ArrayBuffer>;

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    stream: (offset, length) => blob.slice(offset, offset + length).stream(),
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    stream: (offset, length) => streamOf(bytes.subarray(offset, offset + length)),
  };
}

/** One buffer as a stream, without copying it. Every buffer here is on a plain ArrayBuffer. */
function streamOf(bytes: Uint8Array): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes as Chunk);
      controller.close();
    },
  });
}

interface Entry {
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Past these, the file is not a build this tool can sensibly read. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A u64 as a Number; null past 2^53, which no real archive reaches. */
function u64(v: DataView, at: number): number | null {
  const hi = v.getUint32(at + 4, true);
  if (hi > 0x1fffff) return null;
  return hi * 0x100000000 + v.getUint32(at, true);
}

const utf8 = new TextDecoder("utf-8");

export async function openZip(src: ByteSource): Promise<Archive> {
  const tailLength = Math.min(src.size, 22 + 0xffff + 20);
  if (tailLength < 22) throw new ZipError("too small to be a zip");
  const tailStart = src.size - tailLength;
  const tail = await src.read(tailStart, tailLength);
  const t = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("no zip end record");

  let count = t.getUint16(eocd + 10, true);
  let directorySize = t.getUint32(eocd + 12, true);
  let directoryOffset = t.getUint32(eocd + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    // ZIP64: the locator sits just before the classic end record and points at the real one.
    if (eocd < 20 || t.getUint32(eocd - 20, true) !== EOCD64_LOCATOR) throw new ZipError("ZIP64 locator missing");
    const at = u64(t, eocd - 20 + 8);
    if (at === null || at + 56 > src.size) throw new ZipError("ZIP64 end record out of range");
    const rec = await src.read(at, 56);
    const r = view(rec);
    if (rec.length < 56 || r.getUint32(0, true) !== EOCD64) throw new ZipError("bad ZIP64 end record");
    const c = u64(r, 32);
    const s = u64(r, 40);
    const o = u64(r, 48);
    if (c === null || s === null || o === null) throw new ZipError("ZIP64 sizes out of range");
    count = c;
    directorySize = s;
    directoryOffset = o;
  }
  if (count > MAX_ENTRIES || directorySize > MAX_DIRECTORY_BYTES) throw new ZipError("zip directory too large");
  if (directoryOffset + directorySize > src.size) throw new ZipError("zip directory out of range");

  // The directory is usually inside the tail already read.
  const directory =
    directoryOffset >= tailStart && directoryOffset + directorySize <= src.size
      ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
      : await src.read(directoryOffset, directorySize);
  const d = view(directory);
  const entries = new Map<string, Entry>();
  const names: string[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || d.getUint32(p, true) !== CENTRAL) throw new ZipError("bad zip directory");
    const flags = d.getUint16(p + 8, true);
    const nameLength = d.getUint16(p + 28, true);
    const extraLength = d.getUint16(p + 30, true);
    const commentLength = d.getUint16(p + 32, true);
    if (p + 46 + nameLength + extraLength > directory.length) throw new ZipError("bad zip directory");
    const name = utf8.decode(directory.subarray(p + 46, p + 46 + nameLength));
    const entry: Entry = {
      method: d.getUint16(p + 10, true),
      encrypted: (flags & 1) !== 0,
      compressedSize: d.getUint32(p + 20, true),
      size: d.getUint32(p + 24, true),
      offset: d.getUint32(p + 42, true),
    };
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.offset === 0xffffffff) {
      readZip64Extra(directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength), entry);
    }
    // The first entry of a name wins, as in Android's own zip reader; directories are skipped.
    if (!name.endsWith("/") && !entries.has(name)) {
      entries.set(name, entry);
      names.push(name);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names,
    size: (name) => entries.get(name)?.size,
    read: async (name, limit) => {
      const e = entries.get(name);
      if (!e || e.encrypted || e.size > limit) return null;
      try {
        return await readEntry(src, e, limit);
      } catch {
        return null;
      }
    },
  };
}

/** Fills in the 0xffffffff fields from the ZIP64 extended-information extra field, in order. */
function readZip64Extra(extra: Uint8Array, e: Entry): void {
  const v = view(extra);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      const next = (): number => {
        if (q + 8 > p + 4 + len) throw new ZipError("short ZIP64 extra field");
        const n = u64(v, q);
        q += 8;
        if (n === null) throw new ZipError("ZIP64 value out of range");
        return n;
      };
      if (e.size === 0xffffffff) e.size = next();
      if (e.compressedSize === 0xffffffff) e.compressedSize = next();
      if (e.offset === 0xffffffff) e.offset = next();
      return;
    }
    p += 4 + len;
  }
}

/**
 * Whether the compressed size fits the stated size. Stored data is the same length; deflate never
 * grows data by more than 5 bytes per 16 KB block plus a little. A damaged or hostile entry that
 * claims more would otherwise have this read up to the whole file for a few bytes of output.
 */
function plausibleCompressedSize(e: Entry): boolean {
  if (e.method === 0) return e.compressedSize === e.size;
  return e.compressedSize <= e.size + Math.ceil(e.size / 16384) * 5 + 1024;
}

async function readEntry(src: ByteSource, e: Entry, limit: number): Promise<Uint8Array | null> {
  if (e.offset + 30 > src.size || e.size > limit) return null;
  if ((e.method !== 0 && e.method !== 8) || !plausibleCompressedSize(e)) return null;
  const header = await src.read(e.offset, 30);
  const h = view(header);
  if (header.length < 30 || h.getUint32(0, true) !== LOCAL) return null;
  const start = e.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  if (start + e.compressedSize > src.size) return null;
  if (e.method === 0) {
    const raw = await src.read(start, e.compressedSize);
    return raw.length === e.size ? raw : null;
  }
  const input = src.stream ? src.stream(start, e.compressedSize) : streamOf(await src.read(start, e.compressedSize));
  return inflateExactly(input, e.size);
}

/**
 * Inflates a raw deflate stream into one buffer of exactly `size` bytes: null on corrupt data, or
 * when it inflates to any other size (a decompression bomb stops at `size + 1`). An error after
 * every byte has arrived is ignored: Chrome rejects data after the end of the deflate stream.
 */
async function inflateExactly(input: ReadableStream<Chunk>, size: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(size);
  const reader = input.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > size) {
        await reader.cancel().catch(() => {});
        return null;
      }
      out.set(value, total);
      total += value.length;
    }
  } catch {
    if (total !== size) return null;
  }
  return total === size ? out : null;
}

/**
 * Inflates raw deflate (no zlib header), giving up (null) past `limit` output bytes or on corrupt
 * input. Deflate turns a run of zeros into about a thousandth of its size, so a small entry
 * claiming a small size can still try to expand into gigabytes; the limit stops that midway.
 *
 * `expected` accepts output that ends in a decoder error once all of it has arrived: Chrome's
 * DecompressionStream rejects anything after the end of the deflate stream, which some writers
 * leave (padding after a CgBI image's data, for one).
 */
export async function inflateRawLimited(data: Uint8Array, limit: number, expected?: number): Promise<Uint8Array | null> {
  const reader = streamOf(data).pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    if (expected === undefined || total < expected) return null;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
