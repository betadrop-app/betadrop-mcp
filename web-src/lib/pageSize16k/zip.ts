/**
 * A random-access zip reader for the 16 KB check: the central directory, then per entry its local
 * header, its data offset and a prefix of its data. A build of several hundred MB is never read
 * whole; checking a library touches its local header and the first few hundred bytes of it.
 *
 * It differs from src/lib/appIcon/buildCheck/zip.ts (which reads whole entries) in what it exposes:
 * the compression method, the local header offset, the data offset worked out from the LOCAL
 * header (30 + name length + extra length, because zipalign pads through the local extra field and
 * the central directory's extra field need not match it), and a prefix read that inflates only as
 * much of a deflated entry as asked for and then cancels the stream.
 */

export class ZipError extends Error {}

/** Bytes by offset: a File or Blob in the browser, a buffer in the tests. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  stream(offset: number, length: number): ReadableStream<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    stream: (offset, length) => blob.slice(offset, offset + length).stream() as ReadableStream<Uint8Array>,
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
    stream: (offset, length) => {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + length));
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          // Small chunks, so a prefix read really does stop early in the tests too.
          if (sent) return controller.close();
          for (let i = 0; i < part.length; i += 4096) controller.enqueue(part.slice(i, i + 4096));
          sent = true;
          controller.close();
        },
      });
    },
  };
}

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate; anything else cannot be read. */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  /** Uncompressed size, from the central directory. */
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const utf8 = new TextDecoder("utf-8");

function u64(v: DataView, at: number): number | null {
  const hi = v.getUint32(at + 4, true);
  if (hi > 0x1fffff) return null;
  return hi * 0x100000000 + v.getUint32(at, true);
}

export interface Zip {
  /** Every file entry in central directory order; the first entry of a duplicated name only. */
  entries: ZipEntry[];
  /** Names that appear more than once in the central directory (each listed once). */
  duplicates: string[];
  get(name: string): ZipEntry | undefined;
  /** Offset of the entry's data, from its local header. Throws ZipError on a bad local header. */
  dataOffset(e: ZipEntry): Promise<number>;
  /** The whole entry, or null when it is over `limit`, encrypted, or will not read. */
  read(e: ZipEntry, limit: number): Promise<Uint8Array | null>;
  /** A growing prefix of the entry's uncompressed data; see PrefixReader. */
  prefix(e: ZipEntry): Promise<PrefixReader | null>;
}

/**
 * Reads the leading bytes of one entry on demand. `ensure(n)` returns at least min(n, size) bytes
 * (fewer only when the data ends or is damaged). `close()` stops the inflater.
 */
export interface PrefixReader {
  ensure(n: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function openZip(src: ByteSource): Promise<Zip> {
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

  const directory =
    directoryOffset >= tailStart
      ? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
      : await src.read(directoryOffset, directorySize);
  const d = view(directory);
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  const duplicates = new Set<string>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || d.getUint32(p, true) !== CENTRAL) throw new ZipError("bad zip directory");
    const flags = d.getUint16(p + 8, true);
    const nameLength = d.getUint16(p + 28, true);
    const extraLength = d.getUint16(p + 30, true);
    const commentLength = d.getUint16(p + 32, true);
    if (p + 46 + nameLength + extraLength > directory.length) throw new ZipError("bad zip directory");
    const name = utf8.decode(directory.subarray(p + 46, p + 46 + nameLength));
    const entry: ZipEntry = {
      name,
      method: d.getUint16(p + 10, true),
      encrypted: (flags & 1) !== 0,
      compressedSize: d.getUint32(p + 20, true),
      size: d.getUint32(p + 24, true),
      localHeaderOffset: d.getUint32(p + 42, true),
    };
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      readZip64Extra(directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength), entry);
    }
    if (entry.localHeaderOffset + 30 > src.size) throw new ZipError("zip entry out of range");
    // The first entry of a name wins, as in Android's own zip reader; directories are skipped.
    if (!name.endsWith("/")) {
      if (!byName.has(name)) {
        byName.set(name, entry);
        entries.push(entry);
      } else duplicates.add(name);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }

  const offsets = new Map<ZipEntry, number>();
  const dataOffset = async (e: ZipEntry): Promise<number> => {
    const known = offsets.get(e);
    if (known !== undefined) return known;
    const header = await src.read(e.localHeaderOffset, 30);
    const h = view(header);
    if (header.length < 30 || h.getUint32(0, true) !== LOCAL) throw new ZipError(`bad local header for ${e.name}`);
    const start = e.localHeaderOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (start + e.compressedSize > src.size) throw new ZipError(`zip entry ${e.name} runs past the file`);
    offsets.set(e, start);
    return start;
  };

  const readable = (e: ZipEntry) => !e.encrypted && (e.method === 0 || e.method === 8) && plausibleCompressedSize(e);

  return {
    entries,
    duplicates: Array.from(duplicates),
    get: (name) => byName.get(name),
    dataOffset,
    async read(e, limit) {
      if (!readable(e) || e.size > limit) return null;
      try {
        const start = await dataOffset(e);
        if (e.method === 0) {
          const raw = await src.read(start, e.size);
          return raw.length === e.size ? raw : null;
        }
        const pr = inflatePrefix(src.stream(start, e.compressedSize), e.size);
        const out = await pr.ensure(e.size);
        await pr.close();
        return out.length === e.size ? out : null;
      } catch {
        return null;
      }
    },
    async prefix(e) {
      if (!readable(e)) return null;
      const start = await dataOffset(e);
      if (e.method === 0) {
        return {
          ensure: async (n) => src.read(start, Math.min(n, e.size)),
          close: async () => {},
        };
      }
      return inflatePrefix(src.stream(start, e.compressedSize), e.size);
    },
  };
}

function readZip64Extra(extra: Uint8Array, e: ZipEntry): void {
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
      if (e.localHeaderOffset === 0xffffffff) e.localHeaderOffset = next();
      return;
    }
    p += 4 + len;
  }
}

/** Stored data is the same length; deflate never grows data by more than about 5 bytes per 16 KB. */
function plausibleCompressedSize(e: ZipEntry): boolean {
  if (e.method === 0) return e.compressedSize === e.size;
  return e.compressedSize <= e.size + Math.ceil(e.size / 16384) * 5 + 1024;
}

/**
 * Inflates a raw deflate stream only as far as asked. Output past `size` is never kept, and the
 * stream is cancelled on close, so a 100 MB library costs the few KB of input its headers need.
 * Chunks are collected and joined once per `ensure`, not copied into a growing buffer per chunk.
 */
function inflatePrefix(input: ReadableStream<Uint8Array>, size: number): PrefixReader {
  const reader = (input as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let joined: Uint8Array = new Uint8Array(0);
  let done = false;
  return {
    async ensure(n) {
      const want = Math.max(0, Math.min(n, size));
      while (!done && total < want) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          // Corrupt data, or bytes after the end of the deflate stream (which some decoders reject).
          // When a DecompressionStream errors, the Streams spec discards output still queued in
          // it, in every browser, so only what was already read is kept.
          done = true;
          break;
        }
        if (chunk.done) {
          done = true;
          break;
        }
        const room = size - total;
        const value = chunk.value.length > room ? chunk.value.subarray(0, room) : chunk.value;
        chunks.push(value);
        total += value.length;
        if (total >= size) done = true;
      }
      if (joined.length !== total) {
        joined = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          joined.set(c, o);
          o += c.length;
        }
        chunks.length = 0;
        chunks.push(joined);
      }
      return joined.subarray(0, Math.min(total, want));
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}
