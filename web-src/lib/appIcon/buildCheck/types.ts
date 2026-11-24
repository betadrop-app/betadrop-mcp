/**
 * Shared shapes for the build icon check (index.ts): the archive the readers pull entries from,
 * the preview image, and the facts each platform reader returns for report.ts to judge.
 *
 * The readers state what the build contains and never judge it; report.ts turns facts into
 * findings. That split keeps the wording in one file and lets the tests check facts and wording
 * separately.
 */

/** A zip read lazily: names from the central directory, each entry inflated only when asked for. */
export interface Archive {
  /** Every file entry's name, in central-directory order (no directory entries). */
  readonly names: readonly string[];
  /** Uncompressed size from the central directory, or undefined when there is no such entry. */
  size(name: string): number | undefined;
  /** The entry's bytes; null when it is missing, larger than `limit`, encrypted or corrupt. */
  read(name: string, limit: number): Promise<Uint8Array | null>;
}

export type ImageType = "image/png" | "image/webp" | "image/jpeg";

/** The best bitmap of the built icon, for the report's preview and "Use this icon". */
export interface IconPreview {
  /** PNG on iOS (CgBI files are converted); on Android the file as stored, PNG, WebP or JPEG. */
  bytes: Uint8Array;
  type: ImageType;
  /** Pixel size from the file header; 0 when it could not be read. */
  width: number;
  height: number;
  /** Where in the archive it came from. */
  path: string;
  /** What it is, in a few words: "Legacy icon, xxxhdpi" or "AppIcon76x76@2x~ipad.png". */
  label: string;
}

// ── iOS ──────────────────────────────────────────────────────────────────────────────────────

export interface IosIconSet {
  /** The facet name in Assets.car, e.g. "AppIcon". */
  name: string;
  /** How Info.plist refers to it: the primary icon, an alternate icon, or not at all. */
  role: "primary" | "alternate" | "unlisted";
  /** False when Info.plist names a set that the compiled catalog does not contain. */
  found: boolean;
  /** Distinct pixel sizes of the default (Any appearance) images, ascending. */
  sizes: number[];
  /** Device families it has images for: "iPhone", "iPad", "App Store", "Apple Watch", … */
  idioms: string[];
  /** Appearances with images, besides the default one: "dark", "tinted", or a raw name. */
  appearances: string[];
  dark: boolean;
  tinted: boolean;
  /** A 1024 px default image: the single-size image (Xcode 14+) or an ios-marketing one. */
  appStore: boolean;
  /** Every default image on the device idioms is 1024 px: one image Xcode scales down. */
  singleSize: boolean;
  /** Images for iPad (pad idiom, or universal). */
  hasPad: boolean;
  /** Made in Icon Composer (Xcode 26): the catalog holds the icon's layer stack. */
  iconComposer: boolean;
  /** The default-appearance images on the device idioms, for the required-size checks. */
  deviceImages: { idiom: "iPhone" | "iPad" | "universal"; px: number; scale: number }[];
}

export interface IosLooseIcon {
  path: string;
  width: number;
  height: number;
  /** Apple's crushed PNG variant, which only Apple's decoders read as-is. */
  cgbi: boolean;
}

/** An entry of CFBundleAlternateIcons. */
export interface IosAlternate {
  key: string;
  /** CFBundleIconName: an icon set in the asset catalog. Absent for a file-based alternate. */
  iconName?: string;
  /** CFBundleIconFiles: loose PNGs, the way icons were named before asset catalogs. */
  files: string[];
  /** Those files as found in the bundle root. */
  found: IosLooseIcon[];
}

export interface IosFacts {
  /** "Payload/Name.app/" (or "Name.app/" for a zipped .app). */
  appPath: string;
  plist: "read" | "missing" | "unreadable";
  displayName?: string;
  bundleId?: string;
  version?: string;
  build?: string;
  minimumOS?: string;
  /** UIDeviceFamily: 1 iPhone, 2 iPad, … */
  deviceFamilies: number[];
  /** CFBundleIcons › CFBundlePrimaryIcon › CFBundleIconName (iPhone, else iPad). */
  primaryIconName?: string;
  /** Every CFBundleIconFiles entry (primary, alternates, the legacy top-level keys), deduplicated. */
  iconFiles: string[];
  /** CFBundleIcons › CFBundlePrimaryIcon › CFBundleIconFiles, iPhone and iPad, deduplicated. */
  primaryIconFiles: string[];
  alternates: IosAlternate[];
  /** CFBundleAlternateIcons entries past the first 50, which are not checked. */
  alternatesSkipped?: number;
  catalog: "read" | "missing" | "unreadable" | "too-large";
  /** Set when the catalog could not be read: why, in plain words. */
  catalogProblem?: string;
  /**
   * The catalog's thinning arguments ("optimized <idiom 1> <scale 3> …") when it was thinned for
   * one device, as App Store downloads and Xcode builds for a run destination are.
   */
  thinning?: string;
  /** Info.plist was not readable, so the catalog's only app icon set is taken as the app icon. */
  primaryGuessed?: boolean;
  /** Primary first, then alternates, then icon sets in the catalog that Info.plist never names. */
  sets: IosIconSet[];
  /** Loose PNG icons in the bundle root that the primary icon's CFBundleIconFiles point at. */
  looseIcons: IosLooseIcon[];
  /** Anything else that could not be read; each becomes an "info" finding. */
  problems: string[];
}

export interface IosResult {
  facts: IosFacts;
  preview: IconPreview | null;
}

// ── Android ──────────────────────────────────────────────────────────────────────────────────

export type AndroidLayerKind = "bitmap" | "vector" | "colour" | "xml" | "missing" | "unknown";

export interface AndroidBitmap {
  /** Path inside the archive: "res/mipmap-xxxhdpi-v4/ic_launcher.png" (in an AAB, "base/res/…"). */
  path: string;
  /** ResTable_config density: 120 to 640, 0 when unspecified, 0xfffe anydpi, 0xffff nodpi. */
  density: number;
  /** "mdpi" … "xxxhdpi", "nodpi", "anydpi", or "" for the default configuration. */
  qualifier: string;
  /** Pixel size from the file header; 0 when it could not be read. */
  width: number;
  height: number;
  type: ImageType | null;
  /** A night (dark theme) configuration. */
  night: boolean;
}

export interface AndroidLayer {
  kind: AndroidLayerKind;
  /** The resource it points at, as "@mipmap/ic_launcher_foreground", when it is a reference. */
  ref?: string;
  /** "#RRGGBB", or "#AARRGGBB" when not opaque, for a colour layer. */
  color?: string;
  /** Root element of an XML drawable that is not a vector, e.g. "inset" or "layer-list". */
  tag?: string;
  /** The bitmaps behind a bitmap layer, highest density first. */
  bitmaps: AndroidBitmap[];
}

export interface AndroidAdaptiveIcon {
  /** The <adaptive-icon> XML file inside the archive. */
  path: string;
  /** Its configuration, e.g. "anydpi-v26". */
  qualifier: string;
  foreground: AndroidLayer;
  background: AndroidLayer;
  /** Null when the XML has no <monochrome> element. */
  monochrome: AndroidLayer | null;
}

export interface AndroidIconResource {
  /** "@mipmap/ic_launcher"; "@android:…" for a framework id; "0x7f0d0000" when it has no name. */
  ref: string;
  id: number;
  /** A framework (package 0x01) resource: the app ships no icon of its own. */
  system: boolean;
  /** The id is not in the app's resource table. */
  missing: boolean;
  /**
   * The <adaptive-icon> current Android uses: of the day (not night) configurations, the one with
   * the highest SDK level, normally anydpi-v26 or a later -v33 that adds a monochrome layer.
   */
  adaptive: AndroidAdaptiveIcon | null;
  /** Every <adaptive-icon> configuration, so a layer only some of them have shows. */
  adaptiveVariants: { path: string; qualifier: string; sdk: number; night: boolean; monochrome: boolean }[];
  /** The legacy icon: bitmap configurations, highest density first. */
  bitmaps: AndroidBitmap[];
  /** XML configurations that are not adaptive icons (a vector legacy icon, say). */
  drawables: { path: string; qualifier: string; tag: string }[];
  /** Following it failed or went past the work limit: nothing is known about its files. */
  notChecked?: boolean;
}

export interface AndroidFacts {
  format: "apk" | "aab";
  manifest: "read" | "missing" | "unreadable";
  /** resources.arsc (APK) or resources.pb (AAB). */
  table: "read" | "missing" | "unreadable";
  packageName?: string;
  label?: string;
  versionName?: string;
  versionCode?: string;
  minSdk?: number;
  targetSdk?: number;
  /** The manifest's split attribute ("config.xxhdpi"): a split APK, which holds only part of the app. */
  split?: string;
  /**
   * The launcher icon: the MAIN/LAUNCHER activity's or alias's android:icon when it sets one (as
   * aapt2 dump badging reads it), else <application>'s; null when neither is set.
   */
  icon: AndroidIconResource | null;
  /** android:roundIcon, from the same place as the icon; null when it is not set. */
  roundIcon: AndroidIconResource | null;
  /** Set when the icon comes from a launcher activity or alias instead of <application>. */
  iconFrom?: { element: "activity" | "activity-alias"; name: string; appIcon?: string };
  /** Anything else that could not be read; each becomes an "info" finding. */
  problems: string[];
}

export interface AndroidResult {
  facts: AndroidFacts;
  preview: IconPreview | null;
}
