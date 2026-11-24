/**
 * What goes in the zip: every file's path, pixel size and how it is drawn, plus the text files
 * (Contents.json, adaptive-icon XML, manifests, snippets, README).
 *
 * Pure on purpose. The browser half (render.ts, generate.ts) only paints and encodes what this
 * module lists, so the parts a toolchain actually validates — file names, sizes, the JSON Xcode
 * reads and the XML aapt2 reads — are decided here, where `node --test` and
 * `scripts/verify-app-icon-output.mjs` (actool + aapt2) can check them without a browser.
 */

import {
  ANDROID_DENSITIES,
  ANDROID_LAYER_DP,
  ANDROID_LEGACY_DP,
  APPLE_TOUCH_ICON_PX,
  FAVICON_ICO_SIZES,
  IOS_LEGACY_ENTRIES,
  IOS_SINGLE_SIZE_PX,
  LAYOUT_LABELS,
  MACOS_POINT_SIZES,
  PLAY_ICON_PX,
  PWA_ICON_SIZES,
  WATCHOS_SINGLE_SIZE_PX,
  WEB_ICON_SIZES,
  type WebDisplay,
  cleanProjectName,
  type Layout,
  type Platform,
} from "./spec";

export type Variant = "any" | "dark" | "tinted";

/** How one image is drawn. render.ts implements each kind; the plan only names it. */
export type RenderSpec =
  /** The icon square: background, art and padding. iOS, watchOS, web and store icons. */
  | { kind: "square"; variant: Variant; badge: boolean }
  /** One 108 dp Android adaptive layer. */
  | { kind: "layer"; layer: "foreground" | "background" | "monochrome"; badge: boolean }
  /** A pre-Android 8 launcher icon, already in its shape. */
  | { kind: "legacy"; shape: "square" | "circle"; badge: boolean }
  /** A PWA icon whose content sits inside the maskable safe circle. */
  | { kind: "maskable" }
  /** macOS: the art on Apple's rounded-square template, transparent around it. */
  | { kind: "macos" };

/** `rgb` writes PNG colour type 2: no alpha channel at all, which is what ITMS-90717 demands. */
export type Encoding = "rgb" | "rgba";

export interface PngItem {
  type: "png";
  path: string;
  px: number;
  spec: RenderSpec;
  encoding: Encoding;
}
export interface IcoItem {
  type: "ico";
  path: string;
  sizes: readonly number[];
  spec: RenderSpec;
}
export interface TextItem {
  type: "text";
  path: string;
  content: string;
}
/** An SVG drawn from the scene (web/favicon.svg): the source SVG on the background. */
export interface SvgItem {
  type: "svg";
  path: string;
}
export type PlanItem = PngItem | IcoItem | TextItem | SvgItem;

/**
 * The plain web set's manifest fields. They are written only once the app has a name or a short
 * name; blank ones are left out.
 */
export interface WebAppManifest {
  name: string;
  shortName: string;
  startUrl: string;
  display: WebDisplay;
  themeColor: string;
  backgroundColor: string;
}

export type AndroidBackground = { kind: "color"; hex: string } | { kind: "image" };

export interface PlanOptions {
  layout: Layout;
  platforms: Readonly<Record<Platform, boolean>>;
  /** Also write every legacy iOS size into the set (for tooling older than Xcode 14). */
  iosLegacySizes: boolean;
  /** Which iOS 18 appearances have artwork. A missing one gets no entry, and iOS makes its own. */
  appearances: { readonly dark: boolean; readonly tinted: boolean };
  /** An Android 13+ monochrome layer is available. */
  monochrome: boolean;
  /** A solid colour becomes a colour resource; anything else becomes a background PNG layer. */
  androidBackground: AndroidBackground;
  /** Also write the badged set for test builds. */
  beta: boolean;
  /** React Native only: the folder under ios/ that holds Images.xcassets. */
  rnProjectName: string;
  /** The plain web set's manifest fields; without them site.webmanifest lists only the icons. */
  webApp?: WebAppManifest;
  /** Also write web/favicon.svg: the source is an SVG on a colour or gradient background. */
  faviconSvg?: boolean;
}

const ANY: RenderSpec = { kind: "square", variant: "any", badge: false };

const square = (variant: Variant, badge: boolean): RenderSpec => ({ kind: "square", variant, badge });
const layer = (which: "foreground" | "background" | "monochrome", badge = false): RenderSpec => ({
  kind: "layer",
  layer: which,
  badge,
});

function png(path: string, px: number, spec: RenderSpec, encoding: Encoding): PngItem {
  return { type: "png", path, px, spec, encoding };
}
function text(path: string, content: string): TextItem {
  return { type: "text", path, content };
}

// ── Where each layout keeps its icons ────────────────────────────────────────────────────────

interface Bases {
  /** Folder that holds AppIcon.appiconset, or null when the layout ships iOS icons another way. */
  iosCatalog: string | null;
  androidRes: string | null;
  androidDebugRes: string | null;
  macCatalog: string;
  watchCatalog: string;
  web: "generic" | "flutter" | "expo";
}

function bases(o: PlanOptions): Bases {
  const main = "android/app/src/main/res";
  // The debug source set: Gradle merges it over main for debug builds only, so a badged icon
  // there needs no build-script change at all.
  const debug = "android/app/src/debug/res";
  switch (o.layout) {
    case "native":
      return { iosCatalog: "ios", androidRes: main, androidDebugRes: debug, macCatalog: "macos", watchCatalog: "watchos", web: "generic" };
    case "flutter":
      return {
        iosCatalog: "ios/Runner/Assets.xcassets",
        androidRes: main,
        androidDebugRes: debug,
        macCatalog: "macos/Runner/Assets.xcassets",
        watchCatalog: "watchos",
        web: "flutter",
      };
    case "expo":
      return { iosCatalog: null, androidRes: null, androidDebugRes: null, macCatalog: "macos", watchCatalog: "watchos", web: "expo" };
    case "capacitor":
      return { iosCatalog: "ios/App/App/Assets.xcassets", androidRes: main, androidDebugRes: debug, macCatalog: "macos", watchCatalog: "watchos", web: "generic" };
    case "react-native":
      return {
        iosCatalog: `ios/${cleanProjectName(o.rnProjectName)}/Images.xcassets`,
        androidRes: main,
        androidDebugRes: debug,
        macCatalog: "macos",
        watchCatalog: "watchos",
        web: "generic",
      };
  }
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

export function buildPlan(o: PlanOptions): PlanItem[] {
  const b = bases(o);
  const p = o.platforms;
  const items: PlanItem[] = [];

  if (o.layout === "expo") {
    items.push(...expoAssets(o));
  } else {
    if (p.ios && b.iosCatalog) {
      items.push(...iosAppIconSet(`${b.iosCatalog}/AppIcon.appiconset`, false, o));
      if (o.beta) items.push(...iosAppIconSet(`${b.iosCatalog}/AppIcon-Beta.appiconset`, true, o));
    }
    if (p.android && b.androidRes) {
      items.push(...androidRes(b.androidRes, false, o));
      if (o.beta && b.androidDebugRes) items.push(...androidRes(b.androidDebugRes, true, o));
    }
  }
  if (p.macos) items.push(...macAppIconSet(`${b.macCatalog}/AppIcon.appiconset`));
  if (p.watchos) items.push(...watchAppIconSet(`${b.watchCatalog}/AppIcon.appiconset`));
  if (p.web) items.push(...webIcons(b.web, o));
  if (p.ios) items.push(png("store/app-store-1024.png", IOS_SINGLE_SIZE_PX, ANY, "rgb"));
  if (p.android) items.push(png("store/play-store-512.png", PLAY_ICON_PX, ANY, "rgba"));
  return items;
}

// ── Apple ────────────────────────────────────────────────────────────────────────────────────

const XCODE_INFO = { author: "xcode", version: 1 };

function iosAppIconSet(dir: string, badge: boolean, o: PlanOptions): PlanItem[] {
  const any = square("any", badge);
  const items: PlanItem[] = [];
  const images: Record<string, unknown>[] = [];

  if (o.iosLegacySizes) {
    for (const e of IOS_LEGACY_ENTRIES) {
      const filename = `AppIcon-${e.idiom}-${e.pt}@${e.scale}x.png`;
      items.push(png(`${dir}/${filename}`, Math.round(e.pt * e.scale), any, "rgb"));
      images.push({ filename, idiom: e.idiom, scale: `${e.scale}x`, size: `${e.pt}x${e.pt}` });
    }
    // The classic format names the App Store icon `ios-marketing`. Xcode 27 still accepts it,
    // and accepts the universal dark/tinted entries beside it (both checked with actool).
    images.push({ filename: "AppIcon-1024.png", idiom: "ios-marketing", scale: "1x", size: "1024x1024" });
  } else {
    images.push({ filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" });
  }
  items.push(png(`${dir}/AppIcon-1024.png`, IOS_SINGLE_SIZE_PX, any, "rgb"));

  for (const variant of ["dark", "tinted"] as const) {
    if (!o.appearances[variant]) continue;
    const filename = `AppIcon-1024-${variant}.png`;
    images.push({
      appearances: [{ appearance: "luminosity", value: variant }],
      filename,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    });
    // Apple: the dark icon has "a transparent background so the system-provided background can
    // show through", so these two keep their alpha. Only the Any image is the App Store icon.
    items.push(png(`${dir}/${filename}`, IOS_SINGLE_SIZE_PX, square(variant, badge), "rgba"));
  }

  items.push(text(`${dir}/Contents.json`, xcodeJson({ images, info: XCODE_INFO })));
  return items;
}

function macAppIconSet(dir: string): PlanItem[] {
  const items: PlanItem[] = [];
  const images: Record<string, unknown>[] = [];
  for (const pt of MACOS_POINT_SIZES) {
    for (const scale of [1, 2] as const) {
      const filename = `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`;
      items.push(png(`${dir}/${filename}`, pt * scale, { kind: "macos" }, "rgba"));
      images.push({ filename, idiom: "mac", scale: `${scale}x`, size: `${pt}x${pt}` });
    }
  }
  items.push(text(`${dir}/Contents.json`, xcodeJson({ images, info: XCODE_INFO })));
  return items;
}

function watchAppIconSet(dir: string): PlanItem[] {
  const filename = "AppIcon-1024.png";
  return [
    png(`${dir}/${filename}`, WATCHOS_SINGLE_SIZE_PX, ANY, "rgb"),
    text(
      `${dir}/Contents.json`,
      xcodeJson({
        images: [{ filename, idiom: "universal", platform: "watchos", size: "1024x1024" }],
        info: XCODE_INFO,
      }),
    ),
  ];
}

/**
 * JSON the way Xcode writes it: keys sorted, `" : "` between key and value, two-space indent.
 * Xcode reads any valid JSON; matching its style keeps the diff clean when the set is committed.
 */
export function xcodeJson(value: unknown): string {
  return `${format(value, 0)}\n`;
}

function format(value: unknown, depth: number): string {
  const pad = (n: number) => "  ".repeat(n);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[\n${value.map((v) => pad(depth + 1) + format(v, depth + 1)).join(",\n")}\n${pad(depth)}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((k) => `${pad(depth + 1)}${JSON.stringify(k)} : ${format((value as Record<string, unknown>)[k], depth + 1)}`)
      .join(",\n");
    return `{\n${body}\n${pad(depth)}}`;
  }
  return JSON.stringify(value);
}

// ── Android ──────────────────────────────────────────────────────────────────────────────────

/**
 * One `res` folder. The main one carries everything; the debug one (`badge`) only the images that
 * differ — Gradle resolves the XML and the colour from main, and @mipmap/ic_launcher_foreground
 * from debug, so the badge appears without duplicating anything else.
 */
function androidRes(res: string, badge: boolean, o: PlanOptions): PlanItem[] {
  const items: PlanItem[] = [];
  for (const d of ANDROID_DENSITIES) {
    const dir = `${res}/mipmap-${d.name}`;
    const legacyPx = Math.round(ANDROID_LEGACY_DP * d.scale);
    const layerPx = Math.round(ANDROID_LAYER_DP * d.scale);
    items.push(png(`${dir}/ic_launcher.png`, legacyPx, { kind: "legacy", shape: "square", badge }, "rgba"));
    items.push(png(`${dir}/ic_launcher_round.png`, legacyPx, { kind: "legacy", shape: "circle", badge }, "rgba"));
    items.push(png(`${dir}/ic_launcher_foreground.png`, layerPx, layer("foreground", badge), "rgba"));
    if (badge) continue;
    if (o.androidBackground.kind === "image") {
      items.push(png(`${dir}/ic_launcher_background.png`, layerPx, layer("background"), "rgb"));
    }
    if (o.monochrome) {
      items.push(png(`${dir}/ic_launcher_monochrome.png`, layerPx, layer("monochrome"), "rgba"));
    }
  }
  if (!badge) {
    const xml = adaptiveIconXml(o);
    items.push(text(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, xml));
    items.push(text(`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, xml));
    if (o.androidBackground.kind === "color") {
      items.push(text(`${res}/values/ic_launcher_background.xml`, backgroundColorXml(o.androidBackground.hex)));
    }
  }
  return items;
}

export function adaptiveIconXml(o: Pick<PlanOptions, "androidBackground" | "monochrome">): string {
  const background =
    o.androidBackground.kind === "color" ? "@color/ic_launcher_background" : "@mipmap/ic_launcher_background";
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
    `    <background android:drawable="${background}"/>`,
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
    ...(o.monochrome ? ['    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>'] : []),
    "</adaptive-icon>",
    "",
  ].join("\n");
}

export function backgroundColorXml(hex: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<resources>",
    `    <color name="ic_launcher_background">${normalizeHex(hex)}</color>`,
    "</resources>",
    "",
  ].join("\n");
}

/** `#abc`, `abc`, `#aabbcc` → `#AABBCC`. Anything else falls back to white rather than writing bad XML. */
export function normalizeHex(hex: string): string {
  const h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${h.split("").map((c) => c + c).join("").toUpperCase()}`;
  if (/^[0-9a-f]{6}$/i.test(h)) return `#${h.toUpperCase()}`;
  return "#FFFFFF";
}

// ── Web ──────────────────────────────────────────────────────────────────────────────────────

function webIcons(kind: Bases["web"], o: PlanOptions): PlanItem[] {
  if (kind === "expo") {
    // Expo's web build reads one favicon from app.json; the snippet points at this file.
    return [png("assets/images/favicon.png", 48, ANY, "rgba")];
  }
  if (kind === "flutter") {
    // The names `flutter create` already uses, so web/manifest.json and index.html need no edit.
    return [
      png("web/favicon.png", 32, ANY, "rgba"),
      ...PWA_ICON_SIZES.map((s) => png(`web/icons/Icon-${s}.png`, s, ANY, "rgba")),
      ...PWA_ICON_SIZES.map((s) => png(`web/icons/Icon-maskable-${s}.png`, s, { kind: "maskable" }, "rgba")),
    ];
  }
  return [
    { type: "ico", path: "web/favicon.ico", sizes: FAVICON_ICO_SIZES, spec: ANY },
    ...(o.faviconSvg ? [{ type: "svg", path: "web/favicon.svg" } as const] : []),
    // iOS fills an apple-touch-icon's transparency with black, so this one is flattened.
    png("web/apple-touch-icon.png", APPLE_TOUCH_ICON_PX, ANY, "rgb"),
    ...WEB_ICON_SIZES.map((s) => png(`web/icon-${s}.png`, s, ANY, "rgba")),
    ...PWA_ICON_SIZES.map((s) => png(`web/icon-maskable-${s}.png`, s, { kind: "maskable" }, "rgba")),
    text("web/site.webmanifest", webManifest(o.webApp)),
    text("web/head-snippet.html", headSnippet({ svg: Boolean(o.faviconSvg), themeColor: webAppNamed(o.webApp) ? o.webApp!.themeColor : undefined })),
  ];
}

/** Whether the app has a name or a short name, so its fields are written. */
export function webAppNamed(app?: WebAppManifest): app is WebAppManifest {
  return Boolean(app && (app.name.trim() || app.shortName.trim()));
}

/** A start URL is a path on the site: "/", "/app/", "./", "?source=pwa". Anything else means "/". */
export function webStartUrl(url: string): string {
  const u = url.trim();
  return /^(\/|\.{1,2}\/|\?)/.test(u) ? u : "/";
}

/**
 * site.webmanifest: the app's name, start URL, display mode and colours, then the icons. Chrome
 * needs a name or short name and the 192 and 512 px icons to offer installing the app.
 *
 * The app's fields are written only once it has a name: the defaults alone, merged into a site's
 * own manifest, would replace its start_url. No `id` is written either: browsers take start_url
 * as the id when there is none, and an id that differs from an installed copy's turns the next
 * install into a second app.
 */
export function webManifest(app?: WebAppManifest): string {
  const out: Record<string, unknown> = {};
  if (webAppNamed(app)) {
    const name = app.name.trim();
    const shortName = app.shortName.trim();
    if (name) out.name = name;
    if (shortName) out.short_name = shortName;
    out.start_url = webStartUrl(app.startUrl);
    out.display = app.display;
    out.background_color = normalizeHex(app.backgroundColor);
    out.theme_color = normalizeHex(app.themeColor);
  }
  out.icons = [
    ...WEB_ICON_SIZES.map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png" })),
    // Separate maskable entries rather than `"any maskable"`: a maskable image shown as `any`
    // looks shrunk, because its content is inset for the mask.
    ...PWA_ICON_SIZES.map((s) => ({ src: `/icon-maskable-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "maskable" })),
  ];
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function headSnippet(opts: { svg?: boolean; themeColor?: string } = {}): string {
  return [
    // Beside an SVG favicon the .ico declares only 32x32: Chrome takes a link that lists the
    // exact 16 and 32 px it wants over the SVG, and with this it shows the SVG. Firefox prefers an
    // SVG either way; browsers that draw no SVG favicons keep the .ico.
    opts.svg ? '<link rel="icon" href="/favicon.ico" sizes="32x32">' : '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
    ...(opts.svg ? ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">'] : []),
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    ...(opts.themeColor ? [`<meta name="theme-color" content="${normalizeHex(opts.themeColor)}">`] : []),
    "",
  ].join("\n");
}

// ── Expo ─────────────────────────────────────────────────────────────────────────────────────

const EXPO_DIR = "assets/images";

function expoAssets(o: PlanOptions): PlanItem[] {
  const p = o.platforms;
  const items: PlanItem[] = [];
  const set = (dir: string, badge: boolean) => {
    const out: PlanItem[] = [];
    if (p.ios || p.android) out.push(png(`${dir}/icon.png`, 1024, square("any", badge), "rgb"));
    if (p.ios && o.appearances.dark) out.push(png(`${dir}/icon-dark.png`, 1024, square("dark", badge), "rgba"));
    if (p.ios && o.appearances.tinted) out.push(png(`${dir}/icon-tinted.png`, 1024, square("tinted", badge), "rgba"));
    // Expo's foregroundImage is the whole 108 dp layer, scaled to 1024 px.
    if (p.android) out.push(png(`${dir}/adaptive-icon.png`, 1024, layer("foreground", badge), "rgba"));
    return out;
  };
  items.push(...set(EXPO_DIR, false));
  if (p.android && o.androidBackground.kind === "image") {
    items.push(png(`${EXPO_DIR}/adaptive-icon-background.png`, 1024, layer("background"), "rgb"));
  }
  if (p.android && o.monochrome) {
    items.push(png(`${EXPO_DIR}/adaptive-icon-monochrome.png`, 1024, layer("monochrome"), "rgba"));
  }
  if (o.beta && (p.ios || p.android)) items.push(...set(`${EXPO_DIR}/beta`, true));
  if (p.ios || p.android || p.web) items.push(text("snippets/app.json", expoAppJson(o)));
  if (o.beta && (p.ios || p.android)) items.push(text("snippets/app.config.js", expoAppConfig(o)));
  return items;
}

/** The keys to merge into app.json. Field names from Expo's app config reference (SDK 54+). */
export function expoAppJson(o: PlanOptions): string {
  const p = o.platforms;
  const img = (name: string) => `./${EXPO_DIR}/${name}`;
  const expo: Record<string, unknown> = {};
  if (p.ios || p.android) expo.icon = img("icon.png");
  if (p.ios && (o.appearances.dark || o.appearances.tinted)) {
    const icon: Record<string, string> = { light: img("icon.png") };
    if (o.appearances.dark) icon.dark = img("icon-dark.png");
    if (o.appearances.tinted) icon.tinted = img("icon-tinted.png");
    expo.ios = { icon };
  }
  if (p.android) {
    const adaptiveIcon: Record<string, string> = { foregroundImage: img("adaptive-icon.png") };
    if (o.androidBackground.kind === "color") adaptiveIcon.backgroundColor = normalizeHex(o.androidBackground.hex);
    else adaptiveIcon.backgroundImage = img("adaptive-icon-background.png");
    if (o.monochrome) adaptiveIcon.monochromeImage = img("adaptive-icon-monochrome.png");
    expo.android = { adaptiveIcon };
  }
  if (p.web) expo.web = { favicon: img("favicon.png") };
  return `${JSON.stringify({ expo }, null, 2)}\n`;
}

/** An app.config.js that swaps in the badged icons when APP_VARIANT=beta. */
export function expoAppConfig(o: PlanOptions): string {
  const p = o.platforms;
  const lines = [
    "// Merge into your app.config.js. Builds with APP_VARIANT=beta (for example an EAS build",
    "// profile with \"env\": { \"APP_VARIANT\": \"beta\" }) use the badged icons in assets/images/beta/.",
    'const IS_BETA = process.env.APP_VARIANT === "beta";',
    `const img = (name) => \`./${EXPO_DIR}/\${IS_BETA ? "beta/" : ""}\${name}\`;`,
    "",
    "export default ({ config }) => ({",
    "  ...config,",
    '  icon: img("icon.png"),',
  ];
  if (p.ios && (o.appearances.dark || o.appearances.tinted)) {
    const parts = ['light: img("icon.png")'];
    if (o.appearances.dark) parts.push('dark: img("icon-dark.png")');
    if (o.appearances.tinted) parts.push('tinted: img("icon-tinted.png")');
    lines.push(`  ios: { ...config.ios, icon: { ${parts.join(", ")} } },`);
  }
  if (p.android) {
    const parts = ['foregroundImage: img("adaptive-icon.png")'];
    if (o.androidBackground.kind === "color") parts.push(`backgroundColor: "${normalizeHex(o.androidBackground.hex)}"`);
    else parts.push(`backgroundImage: "./${EXPO_DIR}/adaptive-icon-background.png"`);
    if (o.monochrome) parts.push(`monochromeImage: "./${EXPO_DIR}/adaptive-icon-monochrome.png"`);
    lines.push(`  android: { ...config.android, adaptiveIcon: { ${parts.join(", ")} } },`);
  }
  lines.push("});", "");
  return lines.join("\n");
}

// ── README ───────────────────────────────────────────────────────────────────────────────────

export interface ReadmeFinding {
  level: "ok" | "info" | "warn" | "error";
  title: string;
  detail?: string;
}

/** The README.txt at the root of the zip: where every folder goes, and what the checks found. */
export function buildReadme(
  o: PlanOptions,
  items: readonly PlanItem[],
  findings: readonly ReadmeFinding[],
  generatedOn: string,
): string {
  const b = bases(o);
  const has = (prefix: string) => items.some((i) => i.path.startsWith(prefix));
  const out: string[] = [
    "App icons from BetaDrop's App Icon Generator",
    "https://betadrop.app/app-icon-generator/",
    `Made in your browser on ${generatedOn}. Your image was never uploaded.`,
    "",
    `Project layout: ${LAYOUT_LABELS[o.layout]}`,
    o.layout === "native"
      ? "Each folder below says where it goes."
      : "Paths match a standard project, so each folder goes to the same place in yours.",
    "",
  ];
  const section = (title: string, lines: string[]) => {
    out.push(title, ...lines.map((l) => `- ${l}`), "");
  };

  if (o.layout === "expo" && (has(`${EXPO_DIR}/`) || has("snippets/app.json"))) {
    const lines: string[] = [];
    if (has(`${EXPO_DIR}/`)) lines.push(`${EXPO_DIR}/ - copy into your project's ${EXPO_DIR} folder.`);
    if (has("snippets/app.json")) {
      lines.push(
        "snippets/app.json - merge these keys into your app.json (or app.config.js), then run `npx expo prebuild --clean` or start a new EAS build.",
      );
    }
    if (has(`${EXPO_DIR}/beta/`)) {
      lines.push(
        `${EXPO_DIR}/beta/ and snippets/app.config.js - builds with APP_VARIANT=beta use the badged icons. Set it in an EAS build profile's env.`,
      );
    }
    section("Expo", lines);
  }

  if (b.iosCatalog && has(`${b.iosCatalog}/AppIcon.appiconset/`)) {
    const set = `${b.iosCatalog}/AppIcon.appiconset`;
    const lines = [
      o.layout === "native"
        ? `${set} - in Xcode, open your app target's Assets.xcassets, delete the existing AppIcon, and drag this folder in.`
        : `${set} - delete the existing AppIcon.appiconset folder first, then copy this one in, so no unused images are left behind.`,
      o.iosLegacySizes
        ? "Every iPhone and iPad size is its own file (the classic all-sizes format, for tooling older than Xcode 14), plus the 1024 x 1024 App Store icon, saved with no alpha channel."
        : "One 1024 x 1024 image: Xcode 14 and later builds every other size from it. It is also the App Store icon, saved with no alpha channel.",
    ];
    if (o.appearances.dark && o.appearances.tinted) {
      lines.push("The iOS 18 dark and tinted icons are in the same set (Xcode 16 or later).");
    } else if (o.appearances.dark || o.appearances.tinted) {
      lines.push(
        `The iOS 18 ${o.appearances.dark ? "dark" : "tinted"} icon is in the same set (Xcode 16 or later); iOS makes the ${o.appearances.dark ? "tinted" : "dark"} one itself.`,
      );
    } else {
      lines.push("No dark or tinted icon was made, so iOS 18 generates its own.");
    }
    section("iOS", lines);
  }

  if (b.androidRes && has(`${b.androidRes}/`)) {
    const lines = [
      `First delete the old launcher images in your mipmap-*dpi folders (ic_launcher*.png or .webp). Android Studio's template ships them as .webp, and the same name in two formats fails the build with "Duplicate resources".`,
      `${b.androidRes} - then copy it over your project's res folder.`,
      "mipmap-anydpi-v26/ holds the adaptive icon used on Android 8 and later; the PNGs in mipmap-*dpi/ cover older versions. If your project has a mipmap-anydpi/ic_launcher.xml, delete it too, so only this one is left.",
      'Your AndroidManifest.xml needs android:icon="@mipmap/ic_launcher". android:roundIcon="@mipmap/ic_launcher_round" is optional.',
    ];
    if (o.monochrome) lines.push("The monochrome layer gives you an Android 13+ themed icon.");
    if (o.androidBackground.kind === "color") {
      lines.push(
        `values/ic_launcher_background.xml sets the background colour (${normalizeHex(o.androidBackground.hex)}). If another values file already defines ic_launcher_background, keep only one.`,
      );
    }
    section("Android", lines);
  }

  const betaLines: string[] = [];
  if (b.androidDebugRes && has(`${b.androidDebugRes}/`)) {
    betaLines.push(
      `${b.androidDebugRes} - Gradle uses these instead of the main icons in debug builds only, with no build-script change. For another build type or flavor, rename debug/ to its name (for example src/beta/res).`,
    );
  }
  if (b.iosCatalog && has(`${b.iosCatalog}/AppIcon-Beta.appiconset/`)) {
    betaLines.push(
      `${b.iosCatalog}/AppIcon-Beta.appiconset - add it beside AppIcon. In Xcode, select your target, then Build Settings > Primary App Icon Set Name (ASSETCATALOG_COMPILER_APPICON_NAME), and set it to AppIcon-Beta for the configuration you send to testers.`,
    );
  }
  if (betaLines.length) section("Beta icons", betaLines);

  if (has(`${b.macCatalog}/AppIcon.appiconset/`)) {
    section("macOS", [
      `${b.macCatalog}/AppIcon.appiconset - replace the AppIcon set in your Mac target's asset catalog.`,
      "macOS does not mask icons, so these are drawn on Apple's rounded-square template with a transparent margin. For the macOS 26 look, build an icon in Apple's Icon Composer.",
    ]);
  }
  if (has(`${b.watchCatalog}/AppIcon.appiconset/`)) {
    section("watchOS", [
      `${b.watchCatalog}/AppIcon.appiconset - replace the AppIcon set in your watch app's asset catalog. One 1024 x 1024 image with no transparency; watchOS makes it round.`,
    ]);
  }

  if (b.web === "generic" && has("web/")) {
    section("Web", [
      `web/ - copy the images${has("web/favicon.svg") ? ", favicon.svg" : ""} and site.webmanifest to your site's public root.`,
      "Add the tags in web/head-snippet.html to your <head>. If your site already has a manifest, merge web/site.webmanifest into it.",
      webAppNamed(o.webApp)
        ? "site.webmanifest has your app's name, start URL, display mode and colours, and lists every icon; browsers need its name and the 192 and 512 px icons to offer installing the app. If the app is already installed from your site, keep your manifest's own start_url (and id, if it has one) when you merge: installed copies are known by them."
        : "site.webmanifest lists every icon. Give the app a name or short name in the generator to get its name, start URL, display mode and colours too: browsers offer to install a web app only when its manifest names it.",
      "icon-384.png fills the gap between the install sizes; icon-1024.png is a high-resolution master for app stores and splash screens.",
      ...(has("web/favicon.svg")
        ? ["favicon.svg is your SVG on the background, sharp at every size. Chrome, Edge and Firefox show it; browsers that draw no SVG favicons keep favicon.ico."]
        : []),
      "The maskable icons put your icon in the central 80%, the circle every launcher mask keeps. A logo with the default padding stays inside it; edge-to-edge art loses its corners, as on Android.",
    ]);
  } else if (b.web === "flutter" && has("web/")) {
    section("Web", ["web/ - replaces favicon.png and the icons your web/manifest.json already lists."]);
  }

  const store: string[] = [];
  if (has("store/app-store-1024.png")) {
    store.push(
      "store/app-store-1024.png - the App Store icon: 1024 x 1024, no alpha channel. Xcode already takes it from the asset catalog, so you only need this copy for other uses.",
    );
  }
  if (has("store/play-store-512.png")) {
    store.push(
      "store/play-store-512.png - the Google Play icon: 512 x 512, 32-bit PNG. Upload it in Play Console > Store listing. Play rounds the corners itself.",
    );
  }
  if (store.length) section("Store icons", store);

  if (findings.length) {
    const mark = { ok: "[ok]  ", info: "[note]", warn: "[warn]", error: "[FAIL]" } as const;
    out.push("Checks");
    for (const f of findings) out.push(`${mark[f.level]} ${f.title}${f.detail ? ` - ${f.detail}` : ""}`);
    out.push("");
  }

  out.push("Next: send the build to testers with an install link - https://betadrop.app/", "");
  return out.join("\n");
}
