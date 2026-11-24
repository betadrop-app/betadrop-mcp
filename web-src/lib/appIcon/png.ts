/**
 * A PNG encoder that writes the colour type it is told to — which is the whole reason it exists.
 *
 * `canvas.toBlob("image/png")` decides the colour type itself, and browsers write RGBA (type 6)
 * for an ordinary canvas even when every pixel is opaque. That file is exactly what App Store
 * Connect rejects with ITMS-90717 ("can't be transparent or contain an alpha channel"): the
 * check is on the channel, not on the pixels. So the App Store icon is encoded here as colour
 * type 2 (RGB, no alpha channel at all), and everything else as type 6.
 *
 * Deflate comes from `CompressionStream("deflate")`, whose output is the zlib format PNG's IDAT
 * expects. It exists in every current browser and in Node 18+, so the tests run the same code.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGB = colour type 2 (no alpha channel); RGBA = colour type 6. */
export type PngEncoding = "rgb" | "rgba";

/**
 * Encodes straight (not premultiplied) RGBA pixels, as `getImageData` returns them.
 *
 * In `rgb` mode any pixel that is not fully opaque is blended onto white first. The renderer
 * never hands one over for an `rgb` file — those are always drawn on a solid background — so
 * this only decides what a mistake would look like: a pale edge rather than a black one.
 */
export async function encodePng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  encoding: PngEncoding,
): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes for ${width}x${height}, got ${rgba.length}`);
  }
  const bpp = encoding === "rgb" ? 3 : 4;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);

  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));

  for (let y = 0; y < height; y++) {
    // Unpack this row into `cur` in the output channel layout.
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = rowStart + x * 4;
      const d = x * bpp;
      const a = rgba[s + 3];
      if (bpp === 4) {
        cur[d] = rgba[s];
        cur[d + 1] = rgba[s + 1];
        cur[d + 2] = rgba[s + 2];
        cur[d + 3] = a;
      } else if (a === 255) {
        cur[d] = rgba[s];
        cur[d + 1] = rgba[s + 1];
        cur[d + 2] = rgba[s + 2];
      } else {
        const k = a / 255;
        cur[d] = Math.round(rgba[s] * k + 255 * (1 - k));
        cur[d + 1] = Math.round(rgba[s + 1] * k + 255 * (1 - k));
        cur[d + 2] = Math.round(rgba[s + 2] * k + 255 * (1 - k));
      }
    }

    // Try all five filters and keep the one with the smallest sum of absolute values — the
    // heuristic the PNG spec recommends, and most of the size difference against no filter.
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = y > 0 ? prev[i] : 0;
        const upLeft = i >= bpp && y > 0 ? prev[i - bpp] : 0;
        let v: number;
        switch (f) {
          case 0:
            v = cur[i];
            break;
          case 1:
            v = cur[i] - left;
            break;
          case 2:
            v = cur[i] - up;
            break;
          case 3:
            v = cur[i] - ((left + up) >> 1);
            break;
          default:
            v = cur[i] - paeth(left, up, upLeft);
        }
        const byte = v & 0xff;
        out[i] = byte;
        score += byte < 128 ? byte : 256 - byte;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    // The early `break` above leaves losing candidates half-written, so redo the winner in full.
    const winner = candidates[best];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = y > 0 ? prev[i] : 0;
      const upLeft = i >= bpp && y > 0 ? prev[i - bpp] : 0;
      const pred = best === 0 ? 0 : best === 1 ? left : best === 2 ? up : best === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      winner[i] = (cur[i] - pred) & 0xff;
    }
    raw[y * (stride + 1)] = best;
    raw.set(winner, y * (stride + 1) + 1);
    prev.set(cur);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = encoding === "rgb" ? 2 : 6; // colour type
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const idat = await zlibDeflate(raw);
  // sRGB chunk, rendering intent 0 (perceptual): says outright that these are sRGB pixels, which
  // is what a canvas holds and what both stores expect.
  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("sRGB", new Uint8Array([0])),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** zlib-wrapped deflate (RFC 1950), as IDAT and iCCP carry. */
export function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream("deflate"));
}

/**
 * Inflates zlib data, giving up (null) past `limit` output bytes or on corrupt input. Deflate
 * compresses a run of zeros about 1000:1, so a few MB in a file's header could otherwise claim
 * gigabytes of memory and take the tab down.
 */
export async function zlibInflateLimited(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
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
    return null;
  }
  return concat(parts);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** The chunks up to and including the first IDAT (everything a header check needs). */
export function readPngChunks(bytes: Uint8Array, stopAtIdat = true): PngChunk[] {
  if (!isPng(bytes)) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PngChunk[] = [];
  let o = 8;
  while (o + 12 <= bytes.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (o + 12 + len > bytes.length) break;
    out.push({ type, data: bytes.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === "IEND" || (stopAtIdat && type === "IDAT")) break;
  }
  return out;
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  const ihdr = readPngChunks(bytes).find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  return { width: view.getUint32(0), height: view.getUint32(4), bitDepth: ihdr.data[8], colorType: ihdr.data[9] };
}
