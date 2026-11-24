/**
 * favicon.ico with PNG images inside — the form every browser since IE 11 / Windows Vista reads,
 * and far smaller than the old BMP entries.
 */
export function packIco(images: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const headerSize = 6 + 16 * images.length;
  const total = headerSize + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // 1 = icon
  view.setUint16(4, images.length, true);
  let offset = headerSize;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    out[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    out[e + 1] = img.size >= 256 ? 0 : img.size;
    out[e + 2] = 0; // no palette
    out[e + 3] = 0;
    view.setUint16(e + 4, 1, true); // colour planes
    view.setUint16(e + 6, 32, true); // bits per pixel
    view.setUint32(e + 8, img.png.length, true);
    view.setUint32(e + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}

/** The directory of an .ico, for tests: each entry's declared size and the bytes it points at. */
export function readIco(bytes: Uint8Array): { size: number; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 6 || view.getUint16(2, true) !== 1) return [];
  const count = view.getUint16(4, true);
  const out: { size: number; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    if (e + 16 > bytes.length) break;
    const size = bytes[e] === 0 ? 256 : bytes[e];
    const len = view.getUint32(e + 8, true);
    const off = view.getUint32(e + 12, true);
    out.push({ size, data: bytes.subarray(off, off + len) });
  }
  return out;
}
