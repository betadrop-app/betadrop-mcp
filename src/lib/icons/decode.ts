// Turns a PNG or JPEG file into straight RGBA pixels, in pure JavaScript (pngjs, jpeg-js).
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ImageFormat } from "@/lib/appIcon/imageMeta";
import type { RgbaImage } from "./raster.js";

/** The web generator's limit on the file, and a cap on the pixels a decode may allocate. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_MEGAPIXELS = 100;

export function decodeImage(bytes: Uint8Array, format: ImageFormat): RgbaImage {
  if (format === "png") {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (png.width * png.height > MAX_MEGAPIXELS * 1e6) throw new Error(`The image is over ${MAX_MEGAPIXELS} megapixels.`);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  if (format === "jpeg") {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data };
  }
  const named = format === "unknown" ? "This file is not a PNG or JPEG image" : `${format.toUpperCase()} images can't be read here`;
  throw new Error(`${named}. The icon generator reads PNG and JPEG; the web generator at https://betadrop.app/app-icon-generator/ also reads WebP and SVG.`);
}
