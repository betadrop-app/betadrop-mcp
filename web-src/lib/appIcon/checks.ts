/**
 * The checks shown before download. Each one answers a question that otherwise surfaces as a
 * store rejection or a cropped launcher icon, after the build has already gone out.
 */

import { SHAPE_SIZE, type PixelStats } from "./analysis";
import type { ImageMeta } from "./imageMeta";
import {
  ANDROID_MIN_LOGO_DP,
  ANDROID_SAFE_DP,
  ANDROID_VIEWPORT_DP,
  IOS_SINGLE_SIZE_PX,
  PLAY_ICON_MAX_BYTES,
  clampOffset,
  offsetLength,
  type Offset,
  type Platform,
} from "./spec";

/** `error` is reserved for the export self-check: a file the zip promised that isn't right. */
export type Level = "ok" | "info" | "warn" | "error";

export interface Finding {
  id: string;
  level: Level;
  title: string;
  detail?: string;
}

export type Mode = "full" | "logo";
export type ExtraSource = "made" | "uploaded" | "none";

export interface CheckInput {
  meta: ImageMeta;
  /** Natural size of the artwork (an SVG's declared or viewBox size). */
  width: number;
  height: number;
  stats: PixelStats;
  mode: Mode;
  /** Fraction of the icon square left empty on each side, -0.5 … 0.4; below 0 the art is cropped. */
  padding: number;
  /** Where the art sits off-centre (spec.ts Offset); centred when absent. */
  offset?: Offset;
  platforms: Readonly<Record<Platform, boolean>>;
  dark: ExtraSource;
  tinted: ExtraSource;
  monochrome: ExtraSource;
  /** What happened to the dark icon of a dark logo (see `darkStrategy` in analysis.ts). */
  darkNote?: "lightened" | "skipped";
  /**
   * The images other than the main art that the dark, tinted and monochrome versions are drawn
   * from (the full-icon logo layer, uploaded overrides), each with the versions that really use
   * it and the padding it is drawn at.
   */
  variantSources?: readonly VariantSource[];
  /**
   * The plain web set (site.webmanifest, the favicons), when the zip has it: the manifest's app
   * name, and whether web/favicon.svg was made, or why not.
   */
  web?: { name: string; shortName: string; faviconSvg: "made" | "not-svg" | "image-background" | "too-large" };
  /** The zip has maskable web icons (the plain web set and Flutter's; Expo's web build has none). */
  maskable?: boolean;
}

export type VariantRole = "dark" | "tinted" | "mono";

/** An image the dark, tinted or monochrome versions are drawn from, other than the main art. */
export interface VariantSource {
  /** How findings name it: "The logo layer", "Your dark icon", ... */
  label: string;
  /** The versions actually drawn from it, already limited to the enabled platforms. */
  usedFor: readonly VariantRole[];
  stats: PixelStats;
  width: number;
  height: number;
  vector: boolean;
  /** Only its shape is used (a logo layer, a monochrome image), so an opaque file is a mistake. */
  needsTransparency: boolean;
  /** The padding it is drawn at, and the slider that sets it. */
  padding: number;
  paddingName: "padding" | "logo padding";
  /** Where it sits off-centre: the art's offset when drawn like the art, centred at the logo padding. */
  offset?: Offset;
}

/** The share of the art cut off on each side at a negative padding: drawn at 1 - 2p, cropped to 1. */
export function cropShare(padding: number): number {
  return padding < 0 ? -padding / (1 - 2 * padding) : 0;
}

/** Whether visible art lands outside the icon square at this padding and position. */
function isCut(stats: PixelStats, padding: number, offset?: Offset): boolean {
  if (!stats.bbox) return false;
  // Art units are scaled by (1 - 2p) about the centre and moved by the offset; anything outside
  // 0…1 is cut off.
  const o = clampOffset(offset, padding);
  const toFrame = (u: number, shift: number) => (u - 0.5) * (1 - 2 * padding) + 0.5 + shift;
  const b = stats.bbox;
  return toFrame(b.minX, o.x) < -0.002 || toFrame(b.minY, o.y) < -0.002 || toFrame(b.maxX, o.x) > 1.002 || toFrame(b.maxY, o.y) > 1.002;
}

/**
 * Calls `visit` with each visible cell of the shape map, placed in the frame at this padding and
 * position: the cell's centre and half its side, in frame units from the frame's centre.
 */
function eachCell(stats: PixelStats, padding: number, offset: Offset | undefined, visit: (x: number, y: number, half: number) => boolean | void): void {
  const map = stats.shape;
  if (!map) return;
  const s = 1 - 2 * padding;
  const o = clampOffset(offset, padding);
  const half = (s / SHAPE_SIZE) / 2;
  for (let j = 0; j < SHAPE_SIZE; j++) {
    for (let i = 0; i < SHAPE_SIZE; i++) {
      if (!map[j * SHAPE_SIZE + i]) continue;
      if (visit(((i + 0.5) / SHAPE_SIZE - 0.5) * s + o.x, ((j + 0.5) / SHAPE_SIZE - 0.5) * s + o.y, half)) return;
    }
  }
}

/**
 * How far the art reaches from the frame's centre, as a share of the frame's side, at this
 * padding and position. Exact when centred (the farthest visible pixel). When moved, the farthest
 * visible cell of the shape map, which overshoots by at most a cell and never more than the
 * radius plus the move: a wide wordmark moved across its long side stays the length it is.
 */
function reach(stats: PixelStats, padding: number, offset?: Offset): number {
  const viaRadius = stats.maxRadius * (1 - 2 * padding) + offsetLength(offset, padding);
  if (offsetLength(offset, padding) === 0 || !stats.shape) return viaRadius;
  let farthest = 0;
  eachCell(stats, padding, offset, (x, y, half) => {
    farthest = Math.max(farthest, Math.hypot(Math.abs(x) + half, Math.abs(y) + half));
  });
  return Math.min(farthest, viaRadius);
}

/**
 * Whether visible art falls in a corner of the frame outside a rounded corner of radius `r` (a
 * share of the side), at this padding and position: what iOS's mask and the macOS template cut
 * (r ≈ 0.22), or watchOS's circle (r = 0.5). Cell centres are tested, so a sliver within half a
 * cell of the arc passes; art past the square's edge is the crop check's.
 */
function cutByCorners(stats: PixelStats, padding: number, offset: Offset | undefined, r: number): boolean {
  const k = 0.5 - r;
  let cut = false;
  eachCell(stats, padding, offset, (x, y) => {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (ax <= 0.5 && ay <= 0.5 && ax > k && ay > k && Math.hypot(ax - k, ay - k) > r) cut = true;
    return cut;
  });
  return cut;
}

/** Corner radius of the icon mask as a share of the side: iOS's (about 22.4%) and Apple's macOS template (185.4 of 824). */
const ROUNDED_CORNER = 0.225;

export function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const round = (n: number) => Math.round(n);

export function runChecks(c: CheckInput): Finding[] {
  const out: Finding[] = [];
  const vector = c.meta.format === "svg";

  // Size. The art is fitted by its longer side into the 1024 px square less the padding, so
  // that is the width it has to reach without being scaled up.
  const needed = Math.ceil(IOS_SINGLE_SIZE_PX * (1 - 2 * c.padding));
  const longSide = Math.max(c.width, c.height);
  if (vector) {
    out.push({ id: "size", level: "ok", title: "Vector image", detail: "SVG is drawn fresh at every size, so even the 16 px icons stay sharp." });
  } else if (longSide >= needed) {
    out.push({ id: "size", level: "ok", title: `${c.width} × ${c.height} px`, detail: "Large enough for the 1024 px App Store icon." });
  } else {
    // Scaling up a little is barely visible; past about 1.25x it is.
    const factor = needed / longSide;
    const zoomedIn = c.padding < 0 && longSide >= IOS_SINGLE_SIZE_PX;
    out.push({
      id: "size",
      level: factor > 1.25 ? "warn" : "info",
      title: zoomedIn ? "Zoomed in past the image's resolution" : `${c.width} × ${c.height} px is too small for the 1024 px icon`,
      detail: zoomedIn
        ? `At this padding the image is drawn ${needed} px wide, so the large icons are scaled up ${factor.toFixed(1)}x and may look soft. Export the artwork larger, or as SVG, for the sharpest result.`
        : `At this padding the artwork is drawn ${needed} px wide, so it is scaled up and will look soft. Export it at ${needed} px or larger.`,
    });
  }

  // Negative padding, or moving the art, crops. Harmless when only empty margin goes; worth
  // knowing when art does.
  const moved = offsetLength(c.offset, c.padding) > 0;
  if (isCut(c.stats, c.padding, c.offset)) {
    out.push(
      c.mode === "logo"
        ? {
            id: "crop",
            level: "warn",
            title: "The logo is cut off at the edges",
            detail: moved
              ? "At this padding and position part of it falls outside the icon. Move it back toward the centre, or raise the padding, until the whole logo shows in the previews."
              : "At this negative padding it is drawn larger than the icon. Raise the padding until the whole logo shows in the previews.",
          }
        : {
            id: "crop",
            level: "info",
            title: moved ? "Part of your art is cropped" : "Zoomed in: the edges of your art are cropped",
            detail: moved
              ? "At this padding and position some of it falls outside the icon, and the background shows on the side it moved away from. Check the previews."
              : `About ${Math.round(cropShare(c.padding) * 100)}% of it is cut off on each side. Check the previews.`,
          },
    );
  }

  // Shape of the canvas.
  if (c.width !== c.height && c.mode === "full") {
    out.push({
      id: "square",
      level: "warn",
      title: "Not square",
      detail: "It is fitted into a square and the empty bands are filled with the background colour. Square artwork avoids the bands.",
    });
  }

  // Transparency, and the alpha channel the App Store refuses.
  if (c.mode === "full") {
    if (c.stats.cornersTransparent) {
      out.push({
        id: "rounded",
        level: "warn",
        title: "The corners are already rounded",
        detail: "iOS and Android round icons themselves, so pre-rounded art shows the background colour in its corners. Export the artwork square, with no corner radius.",
      });
    } else if (c.stats.transparentRatio > 0) {
      out.push({
        id: "alpha",
        level: "info",
        title: "Transparent areas are filled",
        detail: "The App Store icon cannot be transparent, so those areas get the background colour, and the file is saved with no alpha channel.",
      });
    } else if (c.meta.alphaChannel) {
      out.push({
        id: "alpha",
        level: "info",
        title: "Hidden alpha channel removed",
        detail: "Your file has an alpha channel even though every pixel is opaque. App Store Connect rejects that (ITMS-90717); the App Store icon here is saved without one.",
      });
    } else {
      out.push({ id: "alpha", level: "ok", title: "No transparency", detail: "The App Store icon is saved with no alpha channel." });
    }
  } else if (c.stats.transparentRatio < 0.02) {
    out.push({
      id: "alpha",
      level: "warn",
      title: "This logo has no transparent areas",
      detail: "As a logo it shows as a solid square on the background, and Android's themed icon becomes a square too. Choose “A full icon”, or use a transparent PNG or SVG.",
    });
  } else {
    out.push({
      id: "alpha",
      level: "ok",
      title: "Transparent logo",
      detail: "It sits on your background, and the App Store icon is saved with no alpha channel.",
    });
  }

  // Colour profile: the browser has already converted to sRGB by the time anything is drawn.
  const profile = c.meta.colorProfile;
  if (c.meta.cmyk) {
    out.push({
      id: "profile",
      level: "warn",
      title: "CMYK image",
      detail: "Your browser converts it to RGB, and colours can shift. If they look off, export the artwork as RGB.",
    });
  } else if (profile && /p3/i.test(profile)) {
    out.push({
      id: "profile",
      level: "info",
      title: "Display P3 colours converted to sRGB",
      detail: "The most saturated colours can look slightly duller, the same as in most store screenshots.",
    });
  } else if (profile && !/srgb/i.test(profile)) {
    out.push({
      id: "profile",
      level: "info",
      title: `Colour profile “${profile}” converted to sRGB`,
      detail: "Check the previews: the colours should match your design.",
    });
  }

  // Android's safe zone, in dp. The icon square maps onto the 72 dp visible area, and the
  // padding shrinks the art inside it.
  if (c.platforms.android) {
    if (c.mode === "full") {
      out.push({
        id: "safezone",
        level: "info",
        title: "Edge-to-edge art on Android",
        detail: "Launchers cut the corners to their own shape (circle, squircle or rounded square). Keep text and logos inside the circle in the safe-zone preview.",
      });
    } else if (c.stats.bbox) {
      const side = ANDROID_VIEWPORT_DP * (1 - 2 * c.padding);
      const across = reach(c.stats, c.padding, c.offset) * ANDROID_VIEWPORT_DP * 2;
      const b = c.stats.bbox;
      const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY) * side;
      if (across > ANDROID_SAFE_DP + 1) {
        out.push({
          id: "safezone",
          level: "warn",
          title: "Logo reaches outside Android's safe zone",
          detail: moved
            ? `It reaches about ${round(across / 2)} dp from the centre, and launchers can cut anything past ${ANDROID_SAFE_DP / 2} dp (the central ${ANDROID_SAFE_DP} dp circle). Move it back toward the centre, or raise the padding.`
            : `It spans about ${round(across)} dp from corner to corner, and launchers can cut anything outside the central ${ANDROID_SAFE_DP} dp. Increase the padding until this check passes.`,
        });
      } else {
        out.push({ id: "safezone", level: "ok", title: "Inside Android's safe zone", detail: `The logo stays within the central ${ANDROID_SAFE_DP} dp, so no launcher mask cuts it.` });
      }
      if (extent < ANDROID_MIN_LOGO_DP - 1) {
        out.push({
          id: "logosize",
          level: "info",
          title: "The logo may look small on Android",
          detail: `It is about ${round(extent)} dp wide; Google suggests at least ${ANDROID_MIN_LOGO_DP} dp. Reduce the padding.`,
        });
      }
    }
  }

  // Rounded corners: iOS masks the icon and the macOS template clips it to a rounded square, and
  // watchOS to a circle. For a logo, part of it in a cut corner is lost. Android's safe zone is
  // stricter than any of these, so with Android on its own check covers it.
  if (c.mode === "logo" && !c.platforms.android && c.stats.bbox) {
    const rounded = (c.platforms.ios || c.platforms.macos) && cutByCorners(c.stats, c.padding, c.offset, ROUNDED_CORNER);
    const round_ = c.platforms.watchos && cutByCorners(c.stats, c.padding, c.offset, 0.5);
    if (rounded || round_) {
      const who = [rounded ? `${joinAnd([c.platforms.ios ? "iOS" : "", c.platforms.macos ? "macOS" : ""].filter(Boolean))} round${c.platforms.ios && c.platforms.macos ? "" : "s"} the icon's corners` : "", round_ ? "watchOS cuts it to a circle" : ""]
        .filter(Boolean)
        .join(", and ");
      out.push({
        id: "corners",
        level: "warn",
        title: "Rounded corners cut the logo",
        // Starts with a platform name, already cased as Apple writes it (iOS, macOS, watchOS).
        detail: `${who}, and at this padding${moved ? " and position" : ""} part of the logo falls where they cut. ${moved ? "Move it back toward the centre, or raise the padding." : "Raise the padding."}`,
      });
    }
  }

  // iOS 18 appearances.
  if (c.platforms.ios) {
    if (c.dark === "none" && c.tinted === "none") {
      out.push({
        id: "appearances",
        level: "info",
        title: "No dark or tinted icon",
        detail:
          c.mode === "full"
            ? "iOS 18 will make its own. For better ones, add your logo on a transparent background under “Dark, tinted and themed icons”."
            : "iOS 18 will make its own. For better ones, add your own under More options.",
      });
    } else {
      const made = [c.dark !== "none" ? "dark" : null, c.tinted !== "none" ? "tinted" : null].filter(Boolean).join(" and ");
      const from = c.dark === "uploaded" || c.tinted === "uploaded" ? "including your own images" : "from your logo";
      const lightened = c.darkNote === "lightened" && c.dark === "made" ? " Your logo is dark, so its dark icon is lightened to show on iOS's dark background." : "";
      out.push({ id: "appearances", level: "ok", title: `iOS 18 ${made} icon${made.includes(" and ") ? "s" : ""} made`, detail: `Built ${from}.${lightened}` });
    }
    if (c.darkNote === "skipped" && c.dark === "none") {
      out.push({
        id: "darkskip",
        level: "info",
        title: "No dark icon for this logo",
        detail: "It is mostly dark with light parts, so it would be hard to see on iOS's dark background, and lightening it would darken the light parts. iOS makes its own dark icon; add a light version under More options for a better one.",
      });
    }
  }

  // Android 13 themed icon.
  if (c.platforms.android) {
    if (c.monochrome === "none") {
      out.push({
        id: "monochrome",
        level: "info",
        title: "No themed (monochrome) icon",
        detail:
          c.mode === "full"
            ? "Without one, Android 16 QPR2 and later make a rough one by filtering your colour icon, and older versions leave it in colour. For one you control, add your logo on a transparent background under “Dark, tinted and themed icons”."
            : "Without one, Android 16 QPR2 and later make a rough one by filtering your colour icon, and older versions leave it in colour. For one you control, add a monochrome image under More options.",
      });
    } else {
      out.push({ id: "monochrome", level: "ok", title: "Themed icon made", detail: "Android 13+ tints your logo's shape to match the wallpaper." });
    }
  }

  // The plain web set: what a browser needs to install the app, and the SVG favicon.
  if (c.platforms.web && c.web) {
    if (!c.web.name.trim() && !c.web.shortName.trim()) {
      out.push({
        id: "webname",
        level: "info",
        title: "The web app has no name",
        detail: "Chrome offers to install a web app only when its manifest has a name or a short name. Add one under Web app manifest; the manifest then gets the app's start URL, display mode and colours too.",
      });
    }
    if (c.web.faviconSvg === "image-background" || c.web.faviconSvg === "too-large") {
      out.push({
        id: "faviconsvg",
        level: "info",
        title: "No favicon.svg",
        detail:
          c.web.faviconSvg === "image-background"
            ? "An SVG favicon is made from an SVG on a colour or gradient background; with an image background the zip has favicon.ico only."
            : "Your SVG is over 128 KB, too heavy to load on every page, so the zip has favicon.ico only. Simplify the SVG for a vector favicon.",
      });
    }
  }

  // Maskable web icons: the art sits in the central 80% square, and launcher masks keep at least
  // the central 80% circle. Android's adaptive safe zone is tighter, so with Android on its own
  // check already covers this.
  if (c.platforms.web && c.maskable && !c.platforms.android && c.stats.bbox && reach(c.stats, c.padding, c.offset) > 0.505) {
    out.push({
      id: "maskable",
      level: c.mode === "logo" ? "warn" : "info",
      title: "Round masks may cut the maskable web icon",
      detail:
        c.mode === "logo"
          ? `Installed web apps on Android and ChromeOS show the maskable icon in the launcher's shape, which always keeps at least its central 80% circle, and the logo reaches past it. ${moved ? "Move it back toward the centre, or raise the padding" : "Raise the padding until it fits"}; the Web app previews show what an Android launcher shows.`
          : "Installed web apps on Android and ChromeOS show the maskable icon in the launcher's shape, which always keeps at least its central 80% circle, so edge-to-edge art can lose its corners. The Web app previews show what an Android launcher shows.",
    });
  }

  // The images the dark, tinted and themed versions are drawn from, when that isn't the art
  // itself (the full-icon logo layer, uploaded overrides). Checked only for what really uses them.
  (c.variantSources ?? []).forEach((src, i) => {
    if (!src.usedFor.length) return;
    const id = `source-${i}`;
    const vp = src.padding;
    const raise = `Raise the ${src.paddingName}`;
    const names = src.usedFor.map((r) => (r === "mono" ? "themed" : r));
    const list = `${joinAnd(names)} icon${names.length > 1 ? "s" : ""}`;
    if (src.needsTransparency && src.stats.transparentRatio < 0.02) {
      out.push({
        id: `${id}-opaque`,
        level: "warn",
        title: `${src.label} has no transparent areas`,
        detail: `The ${list} use only its shape, so an opaque image becomes a solid square. Use a transparent PNG or SVG.`,
      });
      return;
    }
    // A whole icon drawn like the full-icon art is cropped exactly as the art is; "crop" above says so.
    const likeTheArt = c.mode === "full" && src.paddingName === "padding";
    if (!likeTheArt && isCut(src.stats, vp, src.offset)) {
      out.push({
        id: `${id}-crop`,
        level: "warn",
        title: `${src.label} is cut off at the edges`,
        detail:
          offsetLength(src.offset, vp) > 0
            ? `At this padding and position part of it falls outside the ${list}. Move the image back toward the centre, or ${raise.toLowerCase()}, until it shows whole in the previews.`
            : `At this padding it is drawn larger than the ${list}. ${raise} until it shows whole in the previews.`,
      });
    }
    const ios = names.filter((n) => n !== "themed");
    if (!src.vector && ios.length) {
      const needed = Math.ceil(IOS_SINGLE_SIZE_PX * (1 - 2 * vp));
      const longSide = Math.max(src.width, src.height);
      if (longSide < needed) {
        const factor = needed / longSide;
        const iosList = `${joinAnd(ios)} icon${ios.length > 1 ? "s" : ""}`;
        const zoomedIn = vp < 0 && longSide >= IOS_SINGLE_SIZE_PX;
        out.push({
          id: `${id}-size`,
          level: factor > 1.25 ? "warn" : "info",
          title: zoomedIn ? `${src.label} is zoomed in past its resolution` : `${src.label} is small for the 1024 px ${iosList}`,
          detail: zoomedIn
            ? `At this padding it is drawn ${needed} px wide, so the ${iosList} ${ios.length > 1 ? "are" : "is"} scaled up ${factor.toFixed(1)}x and may look soft. ${raise}, or use a larger PNG or an SVG.`
            : `It is drawn ${needed} px wide and scaled up ${factor.toFixed(1)}x, so it may look soft. Use a larger PNG or an SVG.`,
        });
      }
    }
    if (src.usedFor.includes("mono") && src.stats.bbox) {
      const across = reach(src.stats, vp, src.offset) * ANDROID_VIEWPORT_DP * 2;
      if (across > ANDROID_SAFE_DP + 1) {
        out.push({
          id: `${id}-safe`,
          level: "warn",
          title: `${src.label} reaches outside Android's safe zone`,
          detail:
            offsetLength(src.offset, vp) > 0
              ? `In the themed icon it reaches about ${round(across / 2)} dp from the centre, and launchers can cut anything past ${ANDROID_SAFE_DP / 2} dp. Move the image back toward the centre, or ${raise.toLowerCase()}.`
              : `In the themed icon it spans about ${round(across)} dp, and launchers can cut anything outside the central ${ANDROID_SAFE_DP} dp. ${raise}.`,
        });
      }
    }
  });

  return out;
}

/** Added after the zip is built, when the real file size is known. */
export function playIconFinding(bytes: number): Finding {
  const kb = Math.ceil(bytes / 1024);
  return bytes > PLAY_ICON_MAX_BYTES
    ? {
        id: "play",
        level: "warn",
        title: `Google Play icon is ${kb} KB`,
        detail: "Play Console refuses icons over 1024 KB. Simplify fine textures or noise in the artwork.",
      }
    : { id: "play", level: "ok", title: `Google Play icon is ${kb} KB`, detail: "Under Play's 1024 KB limit." };
}

/** The export self-check's verdict (selfCheck.ts), added once the zip is built. */
export function exportFinding(v: { checked: number; problems: readonly string[] }): Finding {
  if (!v.problems.length) {
    return {
      id: "export",
      level: "ok",
      title: "Export verified",
      detail: `All ${v.checked} files were read back after building: every image has the size and format the zip lists, none came out blank, and every link between files resolves.`,
    };
  }
  const shown = v.problems.slice(0, 3).join("; ");
  return {
    id: "export",
    level: "error",
    title: `Export check found ${v.problems.length} problem${v.problems.length === 1 ? "" : "s"}`,
    detail: `${shown}${v.problems.length > 3 ? "; …" : ""}. Please tell us at betadrop.app/contact so we can fix it.`,
  };
}

/** Failures first, then warnings, notes and passes; the list reads as a to-do. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const order: Record<Level, number> = { error: 0, warn: 1, info: 2, ok: 3 };
  return [...findings].sort((a, b) => order[a.level] - order[b.level]);
}
