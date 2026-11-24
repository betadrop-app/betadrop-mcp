/**
 * The little bit of a 2D canvas the app icon renderer needs, in plain TypeScript: no native
 * module, so `npx @betadrop/mcp` installs as fast as before.
 *
 * Pixels are kept premultiplied, as floats 0…255, and composited source-over like a browser
 * canvas. Images are scaled by area averaging (each output pixel is the exact coverage-weighted
 * mean of the source pixels under it) when shrinking, and bilinear when enlarging; partly covered
 * edge pixels get partial alpha, so nothing is nearest-neighbour or jagged. A source is shrunk by
 * halves first (as the web generator does), so a 4096 px image drawn at 16 px stays cheap.
 *
 * Clip shapes (rounded square, circle) are coverage masks from a signed distance at each pixel
 * centre: one pixel of anti-aliasing, as a canvas clip gives.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Straight (not premultiplied) RGBA bytes, as `getImageData` returns them. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Per-pixel coverage 0…1 for a canvas of the same size. */
export type Mask = Float32Array;

export class Canvas {
  readonly px: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.px = new Float32Array(width * height * 4);
  }

  /** Fills `r` (fractional edges get partial coverage) with an opaque colour, inside `mask`. */
  fillRect(r: Rect, rgb: readonly [number, number, number], mask?: Mask): void {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(this.width, Math.ceil(r.x + r.w));
    const y1 = Math.min(this.height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      const cy = overlap(y, y + 1, r.y, r.y + r.h);
      for (let x = x0; x < x1; x++) {
        let a = cy * overlap(x, x + 1, r.x, r.x + r.w);
        if (mask) a *= mask[y * this.width + x];
        if (a <= 0) continue;
        this.blend(y * this.width + x, rgb[0] * a, rgb[1] * a, rgb[2] * a, 255 * a);
      }
    }
  }

  /** Draws the whole image inside `r`, aspect ratio kept, centred (canvas `drawImage` "contain"). */
  drawContained(image: Drawable, r: Rect, mask?: Mask): void {
    const k = Math.min(r.w / image.width, r.h / image.height);
    const dw = image.width * k;
    const dh = image.height * k;
    this.drawScaled(image, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, k, mask);
  }

  /** Draws `image` with its top-left corner at (dx, dy), scaled by `k`. */
  drawScaled(image: Drawable, dx: number, dy: number, k: number, mask?: Mask): void {
    if (!(k > 0)) return;
    const level = image.levelFor(k);
    const lk = k * (image.width / level.width);
    const cols = contributions(level.width, dx, lk, this.width);
    const rows = contributions(level.height, dy, lk, this.height);
    if (!cols.length || !rows.length) return;

    // Source rows any output row reads from.
    let r0 = Infinity;
    let r1 = -Infinity;
    for (const row of rows) {
      r0 = Math.min(r0, row.start);
      r1 = Math.max(r1, row.start + row.weights.length);
    }
    const nCols = cols.length;
    const tmp = new Float32Array((r1 - r0) * nCols * 4);
    const src = level.px;
    const sw = level.width;
    for (let sy = r0; sy < r1; sy++) {
      const rowBase = sy * sw * 4;
      const tBase = (sy - r0) * nCols * 4;
      for (let c = 0; c < nCols; c++) {
        const { start, weights } = cols[c];
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = 0; t < weights.length; t++) {
          const w = weights[t];
          const i = rowBase + (start + t) * 4;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          a += src[i + 3] * w;
        }
        const o = tBase + c * 4;
        tmp[o] = r;
        tmp[o + 1] = g;
        tmp[o + 2] = b;
        tmp[o + 3] = a;
      }
    }
    for (const row of rows) {
      for (let c = 0; c < nCols; c++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let t = 0; t < row.weights.length; t++) {
          const w = row.weights[t];
          const o = ((row.start + t - r0) * nCols + c) * 4;
          r += tmp[o] * w;
          g += tmp[o + 1] * w;
          b += tmp[o + 2] * w;
          a += tmp[o + 3] * w;
        }
        const p = row.dest * this.width + cols[c].dest;
        const m = mask ? mask[p] : 1;
        if (a <= 0 || m <= 0) continue;
        this.blend(p, r * m, g * m, b * m, a * m);
      }
    }
  }

  /** Straight RGBA bytes of the whole canvas. */
  toRgba(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4);
    const px = this.px;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a <= 0) continue;
      const k = 255 / a;
      out[i] = clampByte(px[i] * k);
      out[i + 1] = clampByte(px[i + 1] * k);
      out[i + 2] = clampByte(px[i + 2] * k);
      out[i + 3] = clampByte(a);
    }
    return out;
  }

  /** Replaces the canvas with straight RGBA bytes (canvas `putImageData`). */
  fromRgba(data: Uint8Array | Uint8ClampedArray): void {
    const px = this.px;
    for (let i = 0; i < px.length; i += 4) {
      const a = data[i + 3];
      const k = a / 255;
      px[i] = data[i] * k;
      px[i + 1] = data[i + 1] * k;
      px[i + 2] = data[i + 2] * k;
      px[i + 3] = a;
    }
  }

  /** Runs a per-pixel transform over straight RGBA, the way render.ts does with get/putImageData. */
  transform(fn: (rgba: Uint8ClampedArray) => void): void {
    const data = new Uint8ClampedArray(this.toRgba().buffer);
    fn(data);
    this.fromRgba(data);
  }

  private blend(p: number, r: number, g: number, b: number, a: number): void {
    const i = p * 4;
    const keep = 1 - a / 255;
    const px = this.px;
    px[i] = r + px[i] * keep;
    px[i + 1] = g + px[i + 1] * keep;
    px[i + 2] = b + px[i + 2] * keep;
    px[i + 3] = a + px[i + 3] * keep;
  }
}

/** A decoded image, premultiplied, with its halvings built on demand. */
export class SourceImage implements Drawable {
  readonly width: number;
  readonly height: number;
  private readonly levels: Level[];

  constructor(rgba: RgbaImage) {
    this.width = rgba.width;
    this.height = rgba.height;
    const px = new Float32Array(rgba.width * rgba.height * 4);
    const d = rgba.data;
    for (let i = 0; i < px.length; i += 4) {
      const k = d[i + 3] / 255;
      px[i] = d[i] * k;
      px[i + 1] = d[i + 1] * k;
      px[i + 2] = d[i + 2] * k;
      px[i + 3] = d[i + 3];
    }
    this.levels = [new Level(rgba.width, rgba.height, px)];
  }

  /** The smallest halving still at least as large as the drawn size, so the last step shrinks < 2x. */
  levelFor(k: number): Level {
    const dw = this.width * k;
    const dh = this.height * k;
    let i = 0;
    for (;;) {
      const cur = this.levels[i];
      if (cur.width / 2 < dw || cur.height / 2 < dh || cur.width < 4 || cur.height < 4) return cur;
      if (!this.levels[i + 1]) {
        const nw = Math.max(1, Math.round(cur.width / 2));
        const nh = Math.max(1, Math.round(cur.height / 2));
        const c = new Canvas(nw, nh);
        // Exact: each new pixel averages the 2x2 block under it.
        c.drawScaled(cur, 0, 0, nw / cur.width);
        this.levels.push(new Level(nw, nh, c.px));
      }
      i++;
    }
  }
}

/** One halving of a source image: premultiplied pixels, drawn as they are. */
class Level implements Drawable {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly px: Float32Array,
  ) {}
  levelFor(): Level {
    return this;
  }
}

/** Something `drawScaled` can draw: its size, and the pixels to read at a scale. */
export interface Drawable {
  readonly width: number;
  readonly height: number;
  levelFor(k: number): Level;
}

interface Contribution {
  /** Output pixel index along the axis. */
  dest: number;
  /** First source pixel read. */
  start: number;
  /** Weight of each source pixel from `start`; they sum to the output pixel's coverage. */
  weights: Float32Array;
}

/**
 * How each output pixel along one axis reads the source: a source of `len` pixels drawn from
 * `offset` at scale `k`, onto an axis `size` pixels long.
 */
function contributions(len: number, offset: number, k: number, size: number): Contribution[] {
  const out: Contribution[] = [];
  const end = offset + len * k;
  const d0 = Math.max(0, Math.floor(offset));
  const d1 = Math.min(size, Math.ceil(end));
  for (let d = d0; d < d1; d++) {
    // The output pixel [d, d+1] in source units.
    const s0 = (d - offset) / k;
    const s1 = (d + 1 - offset) / k;
    const coverage = overlap(d, d + 1, offset, end);
    if (coverage <= 0) continue;
    if (k <= 1) {
      // Shrinking: area average, each source pixel weighted by how much of it this pixel covers.
      const j0 = Math.max(0, Math.floor(s0));
      const j1 = Math.min(len, Math.ceil(s1));
      const weights = new Float32Array(Math.max(0, j1 - j0));
      for (let j = j0; j < j1; j++) weights[j - j0] = overlap(j, j + 1, s0, s1) * k;
      out.push({ dest: d, start: j0, weights });
    } else {
      // Enlarging: bilinear between the two nearest source pixel centres, edges clamped.
      const c = (d + 0.5 - offset) / k - 0.5;
      const j = Math.floor(c);
      const t = c - j;
      const a = Math.min(len - 1, Math.max(0, j));
      const b = Math.min(len - 1, Math.max(0, j + 1));
      if (a === b) out.push({ dest: d, start: a, weights: Float32Array.of(coverage) });
      else out.push({ dest: d, start: a, weights: Float32Array.of((1 - t) * coverage, t * coverage) });
    }
  }
  return out;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** A rounded-rectangle clip (canvas `arcTo` corners of radius `radius`). */
export function roundedRectMask(width: number, height: number, r: Rect, radius: number): Mask {
  const k = Math.min(radius, r.w / 2, r.h / 2);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const hx = r.w / 2 - k;
  const hy = r.h / 2 - k;
  return shapeMask(width, height, (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - k;
  });
}

/** A circle clip inscribed in `r`. */
export function circleMask(width: number, height: number, r: Rect): Mask {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return shapeMask(width, height, (x, y) => Math.hypot(x - cx, y - cy) - r.w / 2);
}

function shapeMask(width: number, height: number, sdf: (x: number, y: number) => number): Mask {
  const m = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = 0.5 - sdf(x + 0.5, y + 0.5);
      m[y * width + x] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  }
  return m;
}

/** `#RRGGBB` → [r, g, b]. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace(/^#/, ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
