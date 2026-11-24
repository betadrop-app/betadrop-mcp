/**
 * The numbers an app icon set is built from, in one place.
 *
 * Everything here was checked against a primary source or a real toolchain on 2026-11-22, not
 * copied from another generator: the Apple formats by compiling them with Xcode 27.2's `actool`,
 * the Android ones by linking them with `aapt2` (build-tools 36.1.0) against android-36. The
 * script that repeats those checks is `scripts/verify-app-icon-output.mjs`.
 *
 * No JSX, no `@/` imports, no DOM: `node --test` imports this module directly.
 */

export const PLATFORMS = ["ios", "android", "web", "macos", "watchos"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  ios: "iOS & iPadOS",
  android: "Android",
  web: "Web & PWA",
  macos: "macOS",
  watchos: "watchOS",
};

/** Where the files land in the zip, so it can be copied straight into a project of that kind. */
export const LAYOUTS = ["native", "flutter", "expo", "capacitor", "react-native"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const LAYOUT_LABELS: Record<Layout, string> = {
  native: "Xcode + Android Studio",
  flutter: "Flutter",
  expo: "Expo",
  capacitor: "Capacitor / Ionic",
  "react-native": "React Native",
};

// ── Apple ────────────────────────────────────────────────────────────────────────────────────

/** Xcode 14+ builds every iOS size from this one image; it is also the App Store icon. */
export const IOS_SINGLE_SIZE_PX = 1024;

/**
 * The classic "all sizes" set, in the iphone/ipad/ios-marketing format every Xcode understands.
 *
 * The iPad @1x sizes are left out on purpose: actool reports "76x76@1x app icons only apply to
 * iPad apps targeting releases of iOS prior to 10.0", and nothing current targets iOS 9.
 */
export const IOS_LEGACY_ENTRIES: readonly { idiom: "iphone" | "ipad"; pt: number; scale: 2 | 3 }[] = [
  { idiom: "iphone", pt: 20, scale: 2 },
  { idiom: "iphone", pt: 20, scale: 3 },
  { idiom: "iphone", pt: 29, scale: 2 },
  { idiom: "iphone", pt: 29, scale: 3 },
  { idiom: "iphone", pt: 40, scale: 2 },
  { idiom: "iphone", pt: 40, scale: 3 },
  { idiom: "iphone", pt: 60, scale: 2 },
  { idiom: "iphone", pt: 60, scale: 3 },
  { idiom: "ipad", pt: 20, scale: 2 },
  { idiom: "ipad", pt: 29, scale: 2 },
  { idiom: "ipad", pt: 40, scale: 2 },
  { idiom: "ipad", pt: 76, scale: 2 },
  { idiom: "ipad", pt: 83.5, scale: 2 },
];

/** macOS asset catalogs still want every size: these points at @1x and @2x (16 … 1024 px). */
export const MACOS_POINT_SIZES = [16, 32, 128, 256, 512] as const;

/**
 * The macOS icon template: a rounded square 824 px wide, centred in the 1024 px canvas (so a
 * 100 px inset), with a corner radius of about 185 px. macOS draws the icon as-is — unlike iOS
 * it applies no mask — so the shape has to be in the artwork.
 */
export const MACOS_TEMPLATE = { inset: 100 / 1024, radius: 185.4 / 1024 } as const;

export const WATCHOS_SINGLE_SIZE_PX = 1024;

// ── Android ──────────────────────────────────────────────────────────────────────────────────

export const ANDROID_DENSITIES: readonly { name: string; scale: number }[] = [
  { name: "mdpi", scale: 1 },
  { name: "hdpi", scale: 1.5 },
  { name: "xhdpi", scale: 2 },
  { name: "xxhdpi", scale: 3 },
  { name: "xxxhdpi", scale: 4 },
];

/** Pre-Android 8 launcher icon. */
export const ANDROID_LEGACY_DP = 48;
/** Each adaptive layer; the outer 18 dp per side is reserved for the mask and launcher effects. */
export const ANDROID_LAYER_DP = 108;
/** The part of a layer a launcher can show at rest. */
export const ANDROID_VIEWPORT_DP = 72;
/** Google: "the inner 66x66 dp of the icon appears within the masked viewport". */
export const ANDROID_SAFE_DP = 66;
/** Google: "Use a logo that's at least 48x48 dp." */
export const ANDROID_MIN_LOGO_DP = 48;

/** Google Play: 512 x 512, 32-bit PNG, sRGB, "Max file size: 1024KB". */
export const PLAY_ICON_PX = 512;
export const PLAY_ICON_MAX_BYTES = 1024 * 1024;

// ── Web ──────────────────────────────────────────────────────────────────────────────────────

export const FAVICON_ICO_SIZES = [16, 32, 48] as const;
export const APPLE_TOUCH_ICON_PX = 180;
/** Flutter's web/icons and the maskable pair: the sizes browsers need to install an app. */
export const PWA_ICON_SIZES = [192, 512] as const;
/** The plain web set's any-purpose icons: the install pair, 384 between them, and a 1024 px master. */
export const WEB_ICON_SIZES = [192, 384, 512, 1024] as const;
/**
 * The display modes that keep a web app installable. "browser" is left out: it is what a manifest
 * without `display` gets anyway, and Chrome will not offer to install an app that opens in a tab.
 */
export const WEB_DISPLAY_MODES = ["standalone", "minimal-ui", "fullscreen"] as const;
export type WebDisplay = (typeof WEB_DISPLAY_MODES)[number];
/** The manifest's own terms, which developers know; the field's hint explains them. */
export const WEB_DISPLAY_LABELS: Record<WebDisplay, string> = {
  standalone: "Standalone",
  "minimal-ui": "Minimal UI",
  fullscreen: "Fullscreen",
};
/**
 * favicon.svg embeds the source SVG, base64-encoded (a third larger); past this much source it
 * is not worth its weight on every page load, and the zip leaves it out. The file stays under
 * about 130 KB.
 */
export const FAVICON_SVG_MAX_BYTES = 96 * 1024;
/**
 * How much of a maskable icon an Android launcher shows. Chrome maps the icon's 80% safe circle
 * onto the adaptive icon's 66 dp safe zone, so the icon spans 66 / 0.8 = 82.5 dp, of which the
 * launcher's 72 dp viewport shows the centre: about 87%.
 */
export const MASKABLE_ANDROID_VISIBLE = 72 / (66 / 0.8);
/**
 * A maskable icon's safe zone is the central circle, 80% of the width across. The icon square is
 * placed in the central 80%: a padded logo stays inside the circle, while edge-to-edge art loses
 * its corners to round masks, the same as on Android.
 */
export const MASKABLE_SAFE_FRACTION = 0.8;

// ── Padding ──────────────────────────────────────────────────────────────────────────────────

/**
 * Padding is the share of the icon square left empty on each side. Below zero the artwork is
 * drawn larger than the square and its edges are cropped: for logos exported with empty margins,
 * or art that should fill more of the icon. -0.5 draws it at twice the size.
 */
export const MIN_PADDING = -0.5;
export const MAX_PADDING = 0.4;

export function clampPadding(p: number): number {
  return Math.min(MAX_PADDING, Math.max(MIN_PADDING, Number.isFinite(p) ? p : 0));
}

// ── Position ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where the art sits, off the centre of the frame it is drawn in, as a share of that frame's
 * side (like padding): +x moves it right, +y down. For a logo that looks off-centre, or to choose
 * which part of zoomed-in art shows.
 */
export interface Offset {
  x: number;
  y: number;
}
export const CENTRED: Offset = Object.freeze({ x: 0, y: 0 });
export const MAX_OFFSET = 0.25;

/**
 * How far the art may move at a padding: a quarter of the frame, or further when zoomed in past
 * -25%, so that zoomed-in art can be panned until its own edge meets the frame's.
 */
export function maxOffsetFor(padding?: number): number {
  return padding === undefined ? MAX_OFFSET : Math.max(MAX_OFFSET, -clampPadding(padding));
}

export function clampOffset(o: Offset | undefined, padding?: number): Offset {
  const max = maxOffsetFor(padding);
  const c = (v: number) => Math.min(max, Math.max(-max, Number.isFinite(v) ? v : 0));
  return o ? { x: c(o.x), y: c(o.y) } : CENTRED;
}

/** How far the art moved from the centre, in the same units. */
export function offsetLength(o: Offset | undefined, padding?: number): number {
  const c = clampOffset(o, padding);
  return Math.hypot(c.x, c.y);
}

// ── Beta badge ───────────────────────────────────────────────────────────────────────────────

export const BADGE_MAX_LENGTH = 10;
export const DEFAULT_BADGE_LABEL = "BETA";

/** Keeps a label short and printable; the band has room for about ten capitals. */
export function cleanBadgeLabel(label: string): string {
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, BADGE_MAX_LENGTH);
  return cleaned || DEFAULT_BADGE_LABEL;
}

/**
 * The folder React Native's template names after the app (ios/<Name>/Images.xcassets). Only
 * characters Xcode project names actually use survive, so a typo cannot write outside `ios/`.
 */
export function cleanProjectName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  return cleaned || "MyApp";
}
