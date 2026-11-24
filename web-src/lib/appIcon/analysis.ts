/**
 * Pixel arithmetic that does not need a browser: the statistics the checks read, and the two
 * per-pixel transforms the renderer applies (grayscale for the tinted icon, silhouette for the
 * monochrome layer). The renderer hands these an ImageData's `data`; the tests hand them arrays.
 */

/** A pixel counts as part of the artwork above this alpha (about 10%). */
export const CONTENT_ALPHA = 24;

/** The shape map's cells per side: 64 cells of an image analysed at 512 px are 8 px each. */
export const SHAPE_SIZE = 64;

export interface PixelStats {
  /** Share of pixels that are fully (≥ 250) opaque. */
  opaqueRatio: number;
  /** Share of pixels that are fully (≤ 5) transparent. */
  transparentRatio: number;
  /** All four corners are see-through while most of the image is opaque: pre-rounded art. */
  cornersTransparent: boolean;
  /**
   * The artwork's extent, in units of the square the image is fitted into (0…1 on each axis),
   * so a 16:9 image fitted into the square has its own band, not the whole square. Null when
   * nothing is visible.
   */
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Farthest visible point from the square's centre, in the same units (0.707 = a corner). */
  maxRadius: number;
  /**
   * Where the artwork is, coarsely: a SHAPE_SIZE x SHAPE_SIZE grid over the same square, 1 where
   * a cell holds a visible pixel, row by row from the top. The checks measure moved art with it
   * (how far it reaches, whether a rounded corner cuts it), which the bbox and radius can only
   * bound. Null when nothing is visible.
   */
  shape: Uint8Array | null;
  /** Average colour of the opaque pixels along the image's border, as #RRGGBB. */
  edgeColor: string;
  /** Average brightness (0 … 1) of the visible pixels: a white logo needs a dark background. */
  meanLuminance: number;
  /** Share of the visible pixels that are dark (brightness under 0.35). */
  darkShare: number;
}

/**
 * Statistics for an image drawn at `width` x `height` (its own aspect ratio, not padded to a
 * square). Positions are reported as if the image were fitted, centred, into a square of side
 * max(width, height) — which is exactly how the renderer places it.
 */
export function pixelStats(data: Uint8Array | Uint8ClampedArray, width: number, height: number): PixelStats {
  const n = width * height;
  const side = Math.max(width, height);
  const shape = new Uint8Array(SHAPE_SIZE * SHAPE_SIZE);
  const cell = side / SHAPE_SIZE;
  const ox = (side - width) / 2;
  const oy = (side - height) / 2;
  const c = side / 2;

  let opaque = 0;
  let transparent = 0;
  let lumSum = 0;
  let lumCount = 0;
  let darkCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxR2 = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a >= 250) opaque++;
      else if (a <= 5) transparent++;
      if (a > 127) {
        const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        lumSum += lum;
        lumCount++;
        if (lum < 0.35) darkCount++;
      }
      if (a <= CONTENT_ALPHA) continue;
      const sx = x + ox;
      const sy = y + oy;
      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx + 1 > maxX) maxX = sx + 1;
      if (sy + 1 > maxY) maxY = sy + 1;
      // The pixel's corner farthest from the centre, so a filled square reaches exactly 0.707.
      const dx = Math.max(Math.abs(sx - c), Math.abs(sx + 1 - c));
      const dy = Math.max(Math.abs(sy - c), Math.abs(sy + 1 - c));
      const r2 = dx * dx + dy * dy;
      if (r2 > maxR2) maxR2 = r2;
      shape[Math.min(SHAPE_SIZE - 1, Math.floor(sy / cell)) * SHAPE_SIZE + Math.min(SHAPE_SIZE - 1, Math.floor(sx / cell))] = 1;
    }
  }

  const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  const corners = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)];

  return {
    opaqueRatio: n ? opaque / n : 0,
    transparentRatio: n ? transparent / n : 0,
    // Rounded-square art is ~92–97% opaque; a circular logo (78.5%) must not count as one.
    cornersTransparent: corners.every((a) => a < 20) && n > 0 && opaque / n > 0.85,
    bbox:
      maxX > minX
        ? { minX: minX / side, minY: minY / side, maxX: maxX / side, maxY: maxY / side }
        : null,
    maxRadius: Math.sqrt(maxR2) / side,
    shape: maxX > minX ? shape : null,
    edgeColor: edgeColor(data, width, height),
    meanLuminance: lumCount ? lumSum / lumCount : 0,
    darkShare: lumCount ? darkCount / lumCount : 0,
  };
}

function edgeColor(data: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const take = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128) return;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  };
  for (let x = 0; x < width; x++) {
    take(x, 0);
    take(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    take(0, y);
    take(width - 1, y);
  }
  if (!count) return "#FFFFFF";
  const hex = (v: number) => Math.round(v / count).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

/**
 * The tinted icon: Apple asks for "a grayscale image", and iOS tints it by brightness over a
 * dark background — so a logo that converts to dark grey comes out faint, and a black one
 * disappears. With `normalize` (artwork made from the main logo), mostly-dark artwork is
 * flipped so its shape comes out light, then stretched so its lightest part is near white.
 * Uploaded tinted art is only converted: someone who drew a tinted icon meant its tones.
 */
export function grayscaleInPlace(data: Uint8Array | Uint8ClampedArray, normalize: boolean): void {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = y;
    if (data[i + 3] > 127) {
      sum += data[i];
      count++;
    }
  }
  if (!normalize || !count) return;

  const invert = sum / count < 90;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (invert) data[i] = data[i + 1] = data[i + 2] = 255 - data[i];
    if (data[i + 3] > 127 && data[i] > max) max = data[i];
  }
  if (max <= 0 || max >= 235) return;
  const k = Math.min(240 / max, 12);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.min(255, data[i] * k);
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/**
 * How to make the iOS dark icon from a transparent logo. It sits on iOS's own dark backdrop, so
 * a dark logo used as-is disappears there.
 *  - `asis`: the logo is light enough to show.
 *  - `lighten`: nearly all of it is dark (a black or navy wordmark): flip its lightness, keeping
 *    the hue, so black becomes white and navy becomes light blue.
 *  - `skip`: dark with light parts too. Flipping would turn the light parts dark, so make no dark
 *    icon and let iOS generate its own.
 */
export type DarkStrategy = "asis" | "lighten" | "skip";

export function darkStrategy(stats: Pick<PixelStats, "meanLuminance" | "darkShare">): DarkStrategy {
  if (stats.meanLuminance >= 0.3) return "asis";
  return stats.darkShare >= 0.9 ? "lighten" : "skip";
}

/** HSL lightness → 1 − lightness, hue and saturation kept. Alpha untouched. */
export function invertLightnessInPlace(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    // Back to RGB with the new lightness.
    const nl = 1 - l;
    const c = (1 - Math.abs(2 * nl - 1)) * s;
    const x = c * (1 - Math.abs((((h % 6) + 6) % 6) % 2 - 1));
    const m = nl - c / 2;
    const sector = Math.floor((((h % 6) + 6) % 6));
    const [rr, gg, bb] =
      sector === 0 ? [c, x, 0] : sector === 1 ? [x, c, 0] : sector === 2 ? [0, c, x] : sector === 3 ? [0, x, c] : sector === 4 ? [x, 0, c] : [c, 0, x];
    data[i] = Math.round((rr + m) * 255);
    data[i + 1] = Math.round((gg + m) * 255);
    data[i + 2] = Math.round((bb + m) * 255);
  }
}

/** The monochrome layer: Android reads only its shape, so every visible pixel becomes white. */
export function silhouetteInPlace(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 255;
  }
}

/** Black or white text, whichever has the higher WCAG contrast against the colour. */
export function readableTextColor(hex: string): "#111111" | "#FFFFFF" {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onBlack >= onWhite ? "#111111" : "#FFFFFF";
}

/** Relative luminance of #RRGGBB (0 black … 1 white), for picking readable badge text. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const v = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
}
