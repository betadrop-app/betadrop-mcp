/**
 * Image type and pixel size from a file's first bytes, for the bitmaps a build carries: PNG
 * (including Apple's CgBI variant, whose header is an ordinary IHDR), WebP (lossy, lossless and
 * extended) and JPEG. Nothing is decoded.
 */

import type { ImageType } from "./types";

export interface ImageHeader {
  type: ImageType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...Array.from(b.subarray(at, at + n)));

export function sniffImage(b: Uint8Array): ImageHeader | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);

  if (b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x)) {
    // The first chunk is IHDR in a standard PNG; a CgBI file puts its CgBI chunk first.
    let o = 8;
    for (let i = 0; i < 4 && o + 8 <= b.length; i++) {
      const len = v.getUint32(o);
      if (ascii(b, o + 4, 4) === "IHDR" && len >= 8 && o + 16 <= b.length) {
        return { type: "image/png", width: v.getUint32(o + 8), height: v.getUint32(o + 12) };
      }
      o += 12 + len;
    }
    return { type: "image/png", width: 0, height: 0 };
  }

  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8 " && b.length >= 30) {
      // Lossy: a key frame starts 9D 01 2A, then 14-bit width and height.
      if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return { type: "image/webp", width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
      }
    } else if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      // Lossless: 14 bits of width-1, then 14 bits of height-1, little-endian bit order.
      const bits = v.getUint32(21, true);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (kind === "VP8X" && b.length >= 30) {
      const w = b[24] | (b[25] << 8) | (b[26] << 16);
      const h = b[27] | (b[28] << 8) | (b[29] << 16);
      return { type: "image/webp", width: w + 1, height: h + 1 };
    }
    return { type: "image/webp", width: 0, height: 0 };
  }

  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the first start-of-frame (C0–CF, except C4 DHT, C8 and CC DAC).
    let o = 2;
    while (o + 9 <= b.length) {
      if (b[o] !== 0xff) break;
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = v.getUint16(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", width: v.getUint16(o + 7), height: v.getUint16(o + 5) };
      }
      if (len < 2) break;
      o += 2 + len;
    }
    return { type: "image/jpeg", width: 0, height: 0 };
  }

  return null;
}
