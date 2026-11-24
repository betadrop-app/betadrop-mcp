/**
 * Apple's CgBI PNG, turned back into a standard PNG.
 *
 * Xcode crushes the PNGs it copies into an iOS app (actool --compress-pngs, pngcrush -iphone): a
 * CgBI chunk goes before IHDR, the IDAT stream is raw deflate with no zlib header, and the pixels
 * are premultiplied BGRA. Browsers refuse such a file, so the loose app icons in an .ipa need
 * converting before they can be shown or handed to the generator: inflate, undo the PNG row
 * filters, swap to RGBA, divide the alpha back out, and encode with encodePng.
 *
 * Premultiplying loses precision where alpha is low, so translucent pixels come back within a
 * step or two of the original colour; opaque pixels come back exactly.
 */

import { encodePng, readPngChunks, zlibInflateLimited } from "../png";
import { inflateRawLimited } from "./zip";

/** App icons are 1024 px at most; this leaves room without letting a header claim gigapixels. */
const MAX_SIDE = 4096;

/** A CgBI file: a PNG whose first chunk is CgBI (it always goes before IHDR). */
export function isCgbi(b: Uint8Array): boolean {
  return b.length >= 16 && b[0] === 0x89 && b[12] === 0x43 && b[13] === 0x67 && b[14] === 0x42 && b[15] === 0x49;
}

/** A standard RGBA PNG of a CgBI file; null when it is not one or does not decode. */
export async function cgbiToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const chunks = readPngChunks(bytes, false);
  if (!chunks.some((c) => c.type === "CgBI")) return null;
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;
  const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = h.getUint32(0);
  const height = h.getUint32(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  // Xcode writes 8-bit BGRA (type 6), and BGR (type 2) for some opaque images.
  if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) return null;
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) return null;

  const idat = chunks.filter((c) => c.type === "IDAT");
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.data.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c.data, o);
    o += c.data.length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  // Raw deflate is the CgBI norm; a file whose stream still has its zlib header is read as zlib.
  const raw = (await inflateRawLimited(joined, expected, expected)) ?? (await zlibInflateLimited(joined, expected));
  if (!raw || raw.length < expected) return null;

  const pixels = unfilter(raw, width, height, bpp);
  if (!pixels) return null;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += bpp, j += 4) {
    const b = pixels[i];
    const g = pixels[i + 1];
    const r = pixels[i + 2];
    const a = bpp === 4 ? pixels[i + 3] : 255;
    if (a === 0) continue; // fully transparent stays 0,0,0,0
    if (a === 255) {
      rgba[j] = r;
      rgba[j + 1] = g;
      rgba[j + 2] = b;
    } else {
      rgba[j] = Math.min(255, Math.round((r * 255) / a));
      rgba[j + 1] = Math.min(255, Math.round((g * 255) / a));
      rgba[j + 2] = Math.min(255, Math.round((b * 255) / a));
    }
    rgba[j + 3] = a;
  }
  return encodePng(rgba, width, height, "rgba");
}

/** Undoes the five PNG row filters; null on an unknown filter byte. */
export function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array | null {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return null;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y > 0 ? out[row - stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[row - stride + i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + i] = (raw[src + i] + pred) & 0xff;
    }
  }
  return out;
}
