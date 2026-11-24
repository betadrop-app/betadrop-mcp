/**
 * The Node half of the web App Icon Generator's renderer (web/src/lib/appIcon/render.ts): the
 * same geometry, drawn with raster.ts instead of a browser canvas. Only the kinds a native iOS and
 * Android set uses are here; the badge, maskable web icons and macOS template are web-only.
 *
 * The geometry, as render.ts puts it: the "icon square" is the artwork's frame. On iOS and the
 * stores it is the whole image. On Android it is the 72 dp area a launcher shows, centred in the
 * 108 dp adaptive layer; the background fills the full 108 dp. `padding` is the share of the
 * square left empty on each side.
 */

import { grayscaleInPlace, invertLightnessInPlace, silhouetteInPlace } from "@/lib/appIcon/analysis";
import type { RenderSpec, Variant } from "@/lib/appIcon/plan";
import { ANDROID_LAYER_DP, ANDROID_VIEWPORT_DP, CENTRED, clampOffset, clampPadding } from "@/lib/appIcon/spec";
import { Canvas, circleMask, roundedRectMask, type Mask, type Rect, type SourceImage } from "./raster.js";

export interface NodeScene {
  padding: number;
  background: readonly [number, number, number];
  art: SourceImage;
  /** Flip the logo's lightness for the derived dark icon (`darkStrategy` in analysis.ts). */
  lightenDark: boolean;
}

export function renderSpec(spec: RenderSpec, px: number, scene: NodeScene): Canvas {
  switch (spec.kind) {
    case "square":
      if (spec.badge) break;
      return renderSquare(spec.variant, px, scene);
    case "layer":
      if (spec.badge) break;
      return renderLayer(spec.layer, px, scene);
    case "legacy":
      if (spec.badge) break;
      return renderLegacy(spec.shape, px, scene);
  }
  throw new Error(`No Node renderer for ${JSON.stringify(spec)}`);
}

function renderSquare(variant: Variant, px: number, scene: NodeScene): Canvas {
  const c = new Canvas(px, px);
  const square = { x: 0, y: 0, w: px, h: px };
  if (variant === "any") {
    c.fillRect(square, scene.background);
    drawArt(c, scene, square);
  } else if (variant === "dark") {
    // Transparent background: iOS draws its own dark one behind it.
    drawArt(c, scene, square);
    if (scene.lightenDark) c.transform(invertLightnessInPlace);
  } else {
    drawArt(c, scene, square);
    // Made from the art, never uploaded, so the tones are normalised (render.ts: !scene.tinted).
    c.transform((d) => grayscaleInPlace(d, true));
  }
  return c;
}

function viewportOf(px: number): Rect {
  const v = (px * ANDROID_VIEWPORT_DP) / ANDROID_LAYER_DP;
  const off = (px - v) / 2;
  return { x: off, y: off, w: v, h: v };
}

function renderLayer(which: "foreground" | "background" | "monochrome", px: number, scene: NodeScene): Canvas {
  const c = new Canvas(px, px);
  if (which === "background") {
    c.fillRect({ x: 0, y: 0, w: px, h: px }, scene.background);
  } else {
    drawArt(c, scene, viewportOf(px));
    if (which === "monochrome") c.transform(silhouetteInPlace);
  }
  return c;
}

/**
 * A pre-Android 8 launcher icon: background plus art, cut to a rounded square or a circle, with
 * Material's 2 dp margin in the 48 dp box.
 */
function renderLegacy(shape: "square" | "circle", px: number, scene: NodeScene): Canvas {
  const c = new Canvas(px, px);
  const inset = (px * 2) / 48;
  const s = px - 2 * inset;
  const frame = { x: inset, y: inset, w: s, h: s };
  const clip: Mask = shape === "circle" ? circleMask(px, px, frame) : roundedRectMask(px, px, frame, s * 0.16);
  const layerSide = (s * ANDROID_LAYER_DP) / ANDROID_VIEWPORT_DP;
  const lo = (px - layerSide) / 2;
  c.fillRect({ x: lo, y: lo, w: layerSide, h: layerSide }, scene.background, clip);
  drawArt(c, scene, frame, clip);
  return c;
}

/** The art in `frame`, less the padding (render.ts `drawArt`; the MCP tool never moves it off-centre). */
function drawArt(c: Canvas, scene: NodeScene, frame: Rect, clip?: Mask): void {
  const p = clampPadding(scene.padding) * frame.w;
  const o = clampOffset(CENTRED, scene.padding);
  c.drawContained(scene.art, { x: frame.x + p + o.x * frame.w, y: frame.y + p + o.y * frame.h, w: frame.w - 2 * p, h: frame.h - 2 * p }, clip);
}
