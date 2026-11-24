/**
 * What the file itself says, before any pixel is decoded: the format, the declared size, whether
 * it carries an alpha channel, and its colour profile.
 *
 * The pixels cannot answer two of those. A PNG saved as RGBA with every pixel opaque looks
 * identical to an RGB one once decoded — and it is precisely the file App Store Connect rejects
 * (ITMS-90717), so the check has to read the header. And the browser converts colours to sRGB
 * while decoding, so only the file knows it started as Display P3, Adobe RGB or CMYK.
 */

import { readPngChunks, zlibInflateLimited } from "./png";

/** Real ICC profiles are kilobytes; a few hundred KB at most. */
const MAX_ICC_BYTES = 4 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "svg" | "avif" | "heic" | "unknown";

export interface ImageMeta {
  format: ImageFormat;
  /** Declared pixel size, when the header gives one (SVG sizes are read by the loader). */
  width: number | null;
  height: number | null;
  /** The file has an alpha channel: PNG colour type 4/6 or a tRNS chunk, or WebP's alpha flag. */
  alphaChannel: boolean;
  /** The embedded ICC profile's description, or "sRGB" for a PNG sRGB chunk; null when untagged. */
  colorProfile: string | null;
  /** A four-channel (CMYK) JPEG, or an ICC profile whose colour space is CMYK. */
  cmyk: boolean;
}

const EMPTY: ImageMeta = { format: "unknown", width: null, height: null, alphaChannel: false, colorProfile: null, cmyk: false };

export async function readImageMeta(bytes: Uint8Array): Promise<ImageMeta> {
  const format = detectFormat(bytes);
  try {
    switch (format) {
      case "png":
        return await pngMeta(bytes);
      case "jpeg":
        return jpegMeta(bytes);
      case "webp":
        return webpMeta(bytes);
      case "gif":
        return {
          ...EMPTY,
          format,
          width: bytes[6] | (bytes[7] << 8),
          height: bytes[8] | (bytes[9] << 8),
        };
      default:
        return { ...EMPTY, format };
    }
  } catch {
    // A truncated or odd header must not stop the image from being used; the pixels still decode.
    return { ...EMPTY, format };
  }
}

export function detectFormat(bytes: Uint8Array): ImageFormat {
  const at = (o: number, s: string) => s.split("").every((ch, i) => bytes[o + i] === ch.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG")) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (bytes.length >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "gif";
  if (bytes.length >= 12 && at(4, "ftyp")) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis") return "avif";
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "heic";
  }
  // SVG is text: allow a BOM, an XML declaration, comments and a doctype before the root.
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "svg";
  return "unknown";
}

async function pngMeta(bytes: Uint8Array): Promise<ImageMeta> {
  const chunks = readPngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  const meta: ImageMeta = { ...EMPTY, format: "png" };
  if (ihdr && ihdr.data.length >= 13) {
    const v = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    meta.width = v.getUint32(0);
    meta.height = v.getUint32(4);
    const colorType = ihdr.data[9];
    meta.alphaChannel = colorType === 4 || colorType === 6;
  }
  if (chunks.some((c) => c.type === "tRNS")) meta.alphaChannel = true;
  if (chunks.some((c) => c.type === "sRGB")) meta.colorProfile = "sRGB";
  const iccp = chunks.find((c) => c.type === "iCCP");
  if (iccp) {
    // keyword (1-79 bytes) NUL, compression method (0), then the zlib-compressed profile.
    const nul = iccp.data.indexOf(0);
    const keyword = nul > 0 ? latin1(iccp.data.subarray(0, nul)) : "";
    let description: string | null = null;
    let cmyk = false;
    // On a corrupt or oversized profile, keep the keyword: it is often the profile's name anyway.
    const profile = nul > 0 ? await zlibInflateLimited(iccp.data.subarray(nul + 2), MAX_ICC_BYTES) : null;
    if (profile) {
      description = iccDescription(profile);
      cmyk = iccColorSpace(profile) === "CMYK";
    }
    meta.colorProfile = description ?? (keyword || meta.colorProfile);
    meta.cmyk = cmyk;
  }
  return meta;
}

function jpegMeta(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { ...EMPTY, format: "jpeg" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iccParts: { seq: number; data: Uint8Array }[] = [];
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) break;
    const marker = bytes[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
    const len = view.getUint16(o + 2);
    const seg = bytes.subarray(o + 4, o + 2 + len);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && seg.length >= 6) {
      meta.height = (seg[1] << 8) | seg[2];
      meta.width = (seg[3] << 8) | seg[4];
      if (seg[5] === 4) meta.cmyk = true;
    } else if (marker === 0xe2 && seg.length > 14 && latin1(seg.subarray(0, 11)) === "ICC_PROFILE") {
      iccParts.push({ seq: seg[12], data: seg.subarray(14) });
    }
    o += 2 + len;
  }
  if (iccParts.length) {
    iccParts.sort((a, b) => a.seq - b.seq);
    const profile = concat(iccParts.map((p) => p.data));
    meta.colorProfile = iccDescription(profile);
    if (iccColorSpace(profile) === "CMYK") meta.cmyk = true;
  }
  return meta;
}

function webpMeta(bytes: Uint8Array): ImageMeta {
  const meta: ImageMeta = { ...EMPTY, format: "webp" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const type = latin1(bytes.subarray(o, o + 4));
    const len = view.getUint32(o + 4, true);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === "VP8X" && data.length >= 10) {
      meta.alphaChannel = (data[0] & 0x10) !== 0;
      meta.width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      meta.height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
    } else if (type === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
      const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
      meta.width = (bits & 0x3fff) + 1;
      meta.height = ((bits >>> 14) & 0x3fff) + 1;
      meta.alphaChannel = meta.alphaChannel || ((bits >>> 28) & 1) === 1;
    } else if (type === "VP8 " && data.length >= 10 && meta.width === null) {
      meta.width = (data[6] | (data[7] << 8)) & 0x3fff;
      meta.height = (data[8] | (data[9] << 8)) & 0x3fff;
    } else if (type === "ALPH") {
      meta.alphaChannel = true;
    } else if (type === "ICCP") {
      meta.colorProfile = iccDescription(data);
      meta.cmyk = iccColorSpace(data) === "CMYK";
    }
    o += 8 + len + (len & 1);
  }
  return meta;
}

// ── ICC ──────────────────────────────────────────────────────────────────────────────────────

/** The profile's `desc` tag: ICC v2 `desc` (ASCII) or v4 `mluc` (UTF-16BE). */
export function iccDescription(icc: Uint8Array): string | null {
  if (icc.length < 132) return null;
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const count = view.getUint32(128);
  for (let i = 0; i < count; i++) {
    const t = 132 + i * 12;
    if (t + 12 > icc.length) break;
    if (latin1(icc.subarray(t, t + 4)) !== "desc") continue;
    const off = view.getUint32(t + 4);
    const size = view.getUint32(t + 8);
    if (off + 12 > icc.length) return null;
    const type = latin1(icc.subarray(off, off + 4));
    if (type === "desc") {
      const n = Math.min(view.getUint32(off + 8), size - 12, icc.length - off - 12);
      return clean(latin1(icc.subarray(off + 12, off + 12 + n)));
    }
    if (type === "mluc" && off + 28 <= icc.length) {
      const records = view.getUint32(off + 8);
      if (records < 1) return null;
      const len = view.getUint32(off + 20);
      const strOff = view.getUint32(off + 24);
      const start = off + strOff;
      if (start + len > icc.length) return null;
      let s = "";
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode((icc[start + k] << 8) | icc[start + k + 1]);
      return clean(s);
    }
    return null;
  }
  return null;
}

/** The header's data colour space: "RGB", "CMYK", "GRAY", … */
export function iccColorSpace(icc: Uint8Array): string | null {
  if (icc.length < 20) return null;
  return latin1(icc.subarray(16, 20)).trim() || null;
}

function clean(s: string): string | null {
  const t = s.replace(/\u0000/g, "").trim();
  return t || null;
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
