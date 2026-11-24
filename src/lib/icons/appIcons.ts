/**
 * The web App Icon Generator's pipeline, run in Node: the same plan (web/src/lib/appIcon/plan.ts),
 * checks (checks.ts), PNG encoder (png.ts) and export self-check (selfCheck.ts), with render.ts's
 * canvas swapped for raster.ts. What it builds is the web generator's "Xcode + Android Studio"
 * zip, unzipped: ios/AppIcon.appiconset, android/app/src/main/res, store/ and README.txt.
 *
 * The settings the web page picks on its own for a new image are picked the same way here: logo
 * or full icon from the transparency, the padding, the background colour, and the iOS 18 dark and
 * tinted icons and the Android themed icon made from a logo.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { darkStrategy, pixelStats, type PixelStats } from "@/lib/appIcon/analysis";
import {
  exportFinding,
  playIconFinding,
  runChecks,
  sortFindings,
  type Finding,
  type Mode,
} from "@/lib/appIcon/checks";
import { readImageMeta, type ImageMeta } from "@/lib/appIcon/imageMeta";
import { buildPlan, buildReadme, normalizeHex, type PlanItem, type PlanOptions, type RenderSpec } from "@/lib/appIcon/plan";
import { encodePng, type PngEncoding } from "@/lib/appIcon/png";
import { verifyExport, type ExportVerification } from "@/lib/appIcon/selfCheck";
import { CENTRED, clampPadding } from "@/lib/appIcon/spec";
import { MAX_FILE_BYTES, decodeImage } from "./decode.js";
import { Canvas, SourceImage, hexToRgb } from "./raster.js";
import { renderSpec, type NodeScene } from "./render.js";

export interface AppIconOptions {
  imagePath: string;
  ios: boolean;
  android: boolean;
  /** "logo" (art on a background) or "full" (a finished icon); picked from the image when absent. */
  mode?: Mode;
  /** Share of the icon square left empty on each side, -0.5 … 0.4. */
  padding?: number;
  backgroundColor?: string;
}

export interface AppIconBuild {
  /** Plan path → bytes, README.txt included. */
  files: Map<string, Uint8Array>;
  items: PlanItem[];
  findings: Finding[];
  verification: ExportVerification;
  mode: Mode;
  padding: number;
  background: string;
  source: { width: number; height: number; meta: ImageMeta };
  made: { dark: boolean; tinted: boolean; monochrome: boolean };
  /** A small PNG of the main icon, to show. */
  preview: Uint8Array;
}

/** As the web page measures a source: drawn at up to 512 px on its own aspect ratio. */
const ANALYSIS_PX = 512;
const PREVIEW_PX = 192;

export async function buildAppIcons(o: AppIconOptions): Promise<AppIconBuild> {
  const stat = await fs.stat(o.imagePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`No image file at ${o.imagePath}.`);
  if (stat.size > MAX_FILE_BYTES) throw new Error("That file is over 30 MB. App icon artwork is usually 1024–2048 px.");
  const bytes = new Uint8Array(await fs.readFile(o.imagePath));
  const meta = await readImageMeta(bytes);
  const art = new SourceImage(decodeImage(bytes, meta.format));
  if (!art.width || !art.height) throw new Error("The image has no pixels.");
  const stats = analyse(art);
  if (!stats.bbox) {
    throw new Error("This image is completely transparent, so there is nothing to make an icon from.");
  }

  // The web page's choices for a new image (AppIconGeneratorClient `adoptArt`).
  const mode: Mode = o.mode ?? (stats.transparentRatio > 0.04 && !stats.cornersTransparent ? "logo" : "full");
  const padding = clampPadding(o.padding ?? (mode === "logo" ? 0.18 : 0));
  const background = o.backgroundColor
    ? normalizeHex(o.backgroundColor)
    : mode === "full"
      ? stats.edgeColor
      : stats.meanLuminance > 0.75
        ? "#111827"
        : "#FFFFFF";

  // Dark, tinted and themed versions are made from a logo; a full icon has none to make them from.
  const fromLogo = mode === "logo";
  const darkPlan = fromLogo ? darkStrategy(stats) : "asis";
  const made = { dark: fromLogo && darkPlan !== "skip", tinted: fromLogo, monochrome: fromLogo };

  const platforms = { ios: o.ios, android: o.android, web: false, macos: false, watchos: false };
  const planOptions: PlanOptions = {
    layout: "native",
    platforms,
    iosLegacySizes: false,
    appearances: { dark: made.dark, tinted: made.tinted },
    monochrome: made.monochrome,
    androidBackground: { kind: "color", hex: background },
    beta: false,
    rnProjectName: "MyApp",
  };
  const items = buildPlan(planOptions);

  const checks = runChecks({
    meta,
    width: art.width,
    height: art.height,
    stats,
    mode,
    padding,
    offset: CENTRED,
    platforms,
    dark: made.dark ? "made" : "none",
    tinted: made.tinted ? "made" : "none",
    monochrome: made.monochrome ? "made" : "none",
    darkNote: fromLogo && darkPlan === "lighten" ? "lightened" : fromLogo && darkPlan === "skip" ? "skipped" : undefined,
    variantSources: [],
    maskable: false,
  }).map((f) => forThisTool(f, mode));

  const scene: NodeScene = { padding, background: hexToRgb(background), art, lightenDark: darkPlan === "lighten" };
  const { files, blank } = await paint(items, scene);
  const verification = verifyExport(files, items, blank);
  const playBytes = files.get("store/play-store-512.png")?.length;
  const verified = exportFinding(verification);
  const findings = sortFindings([
    ...checks,
    ...(playBytes === undefined ? [] : [playIconFinding(playBytes)]),
    // There is no zip here: the files are written as they are.
    { ...verified, detail: verified.detail?.replace("the size and format the zip lists", "the size and format the set calls for") },
  ]);
  const generatedOn = new Date().toISOString().slice(0, 10);
  files.set(
    "README.txt",
    new TextEncoder().encode(
      buildReadme(planOptions, items, findings, generatedOn).replace(
        /^Made in your browser on (.+)\. Your image was never uploaded\.$/m,
        "Made on this computer by the BetaDrop MCP server on $1. The image was not uploaded anywhere.",
      ),
    ),
  );

  const preview = await encodePng(renderSpec({ kind: "square", variant: "any", badge: false }, PREVIEW_PX, scene).toRgba(), PREVIEW_PX, PREVIEW_PX, "rgb");
  return { files, items, findings, verification, mode, padding, background, source: { width: art.width, height: art.height, meta }, made, preview };
}

function analyse(art: SourceImage): PixelStats {
  const k = Math.min(1, ANALYSIS_PX / Math.max(art.width, art.height));
  const w = Math.max(1, Math.round(art.width * k));
  const h = Math.max(1, Math.round(art.height * k));
  const c = new Canvas(w, h);
  c.drawContained(art, { x: 0, y: 0, w, h });
  return pixelStats(c.toRgba(), w, h);
}

/** Every planned file's bytes, each distinct image painted once (generate.ts `generateZip`). */
async function paint(items: readonly PlanItem[], scene: NodeScene) {
  const cache = new Map<string, Promise<Uint8Array>>();
  const blankKeys = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const keyOf = (spec: RenderSpec, px: number, encoding: PngEncoding) => `${JSON.stringify(spec)}|${px}|${encoding}`;
  const encoded = (spec: RenderSpec, px: number, encoding: PngEncoding) => {
    const key = keyOf(spec, px, encoding);
    let p = cache.get(key);
    if (!p) {
      const rgba = renderSpec(spec, px, scene).toRgba();
      if (mustShowSomething(spec) && !hasVisiblePixel(rgba)) blankKeys.add(key);
      p = encodePng(rgba, px, px, encoding);
      cache.set(key, p);
    }
    return p;
  };
  for (const item of items) {
    if (item.type === "text") files.set(item.path, new TextEncoder().encode(item.content));
    else if (item.type === "png") files.set(item.path, await encoded(item.spec, item.px, item.encoding));
    else throw new Error(`${item.path}: not made by the MCP tool`);
  }
  const blank = items.filter((i) => i.type === "png" && blankKeys.has(keyOf(i.spec, i.px, i.encoding))).map((i) => i.path);
  return { files, blank };
}

function mustShowSomething(spec: RenderSpec): boolean {
  if (spec.kind === "layer") return spec.layer !== "background";
  return spec.kind === "square" && spec.variant !== "any";
}

function hasVisiblePixel(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 8) return true;
  return false;
}

/**
 * The checks' wording, where it points at the web page's controls or at a browser, in terms of
 * this tool: its `mode` and `padding` inputs, and pixels that are read as stored.
 */
function forThisTool(f: Finding, mode: Mode): Finding {
  const web = "https://betadrop.app/app-icon-generator/";
  switch (f.id) {
    case "alpha":
      return f.level === "warn" && mode === "logo"
        ? { ...f, detail: 'As a logo it shows as a solid square on the background, and Android\'s themed icon becomes a square too. mode "full" treats it as a finished icon.' }
        : f;
    case "appearances":
      return f.level === "info"
        ? { ...f, detail: `iOS 18 will make its own. The web generator (${web}) can make them from a separate transparent logo.` }
        : f;
    case "darkskip":
      return {
        ...f,
        detail: "It is mostly dark with light parts, so it would be hard to see on iOS's dark background, and lightening it would darken the light parts. iOS makes its own dark icon.",
      };
    case "monochrome":
      return f.level === "info"
        ? {
            ...f,
            detail: `Without one, Android 16 QPR2 and later make a rough one by filtering your colour icon, and older versions leave it in colour. The web generator (${web}) can make one from a separate transparent logo.`,
          }
        : f;
    case "profile":
      return f.title === "CMYK image"
        ? { ...f, detail: "CMYK JPEGs are converted to RGB without the profile here, and colours can shift. An RGB export keeps them." }
        : { ...f, title: f.title.replace(/ converted to sRGB$/, " read as sRGB"), detail: "The pixel values are used as stored, so the most saturated colours can look slightly different from your design." };
    default:
      return f;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

export const IOS_SET = "ios/AppIcon.appiconset";
export const ANDROID_RES = "android/app/src/main/res";

/** Writes every file under `dir` at its plan path. */
export async function writeAll(build: AppIconBuild, dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, bytes] of build.files) {
    const dest = path.join(dir, ...rel.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
    written.push(dest);
  }
  return written;
}

/** Folders never searched for a project's icon sets: dependencies, build output, VCS. */
const SKIP_DIRS = new Set(["node_modules", "Pods", "build", "DerivedData", "Carthage", ".build", ".gradle", ".git", ".dart_tool", ".expo", "intermediates"]);

/** Directories under `root` (to `depth` levels) that `match` accepts, not descending into matches. */
async function findDirs(root: string, match: (dir: string, name: string) => boolean, depth = 7): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, level: number) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (match(p, e.name)) out.push(p);
      else if (level < depth) await walk(p, level + 1);
    }
  };
  await walk(root, 0);
  return out.sort();
}

export interface ProjectTargets {
  iosSet: string | null;
  androidRes: string | null;
}

/**
 * Where an iOS app icon set and an Android res folder live in a project: the one
 * AppIcon.appiconset in an asset catalog (preferring an ios/ folder when a Flutter or React
 * Native project also has macos/ or a watch app), and the one src/main/res (preferring app/).
 * Throws when a requested platform has none, or more than one candidate.
 */
export async function findProjectTargets(root: string, want: { ios: boolean; android: boolean }): Promise<ProjectTargets> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`No folder at ${root}.`);
  const pick = (found: string[], prefer: (p: string) => boolean) => {
    if (found.length <= 1) return found;
    const preferred = found.filter(prefer);
    return preferred.length ? preferred : found;
  };
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");

  let iosSet: string | null = null;
  if (want.ios) {
    const sets = await findDirs(root, (p, name) => name === "AppIcon.appiconset" && path.dirname(p).endsWith(".xcassets"));
    const segments = (p: string) => rel(p).toLowerCase().split("/");
    const chosen = pick(
      sets.filter((p) => !segments(p).some((s) => s === "macos" || s.includes("watch"))),
      (p) => segments(p)[0] === "ios",
    );
    if (chosen.length !== 1) {
      throw new Error(
        chosen.length === 0
          ? `No iOS AppIcon.appiconset inside an .xcassets catalog under ${root}.`
          : `${chosen.length} iOS app icon sets under ${root}: ${chosen.map(rel).join(", ")}. projectDir takes a folder with one of them.`,
      );
    }
    iosSet = chosen[0];
  }

  let androidRes: string | null = null;
  if (want.android) {
    const res = await findDirs(root, (p, name) => name === "res" && p.split(path.sep).slice(-3).join("/") === "src/main/res");
    const chosen = pick(res, (p) => p.split(path.sep).slice(-4)[0] === "app");
    if (chosen.length !== 1) {
      throw new Error(
        chosen.length === 0
          ? `No Android src/main/res folder under ${root}.`
          : `${chosen.length} Android res folders under ${root}: ${chosen.map(rel).join(", ")}. projectDir takes a folder with one of them.`,
      );
    }
    androidRes = chosen[0];
  }
  return { iosSet, androidRes };
}

/** Launcher resource names the set writes; another file with one of them would clash in Gradle. */
const LAUNCHER_NAMES = /^ic_launcher(_round|_foreground|_background|_monochrome)?\.(png|webp|xml|jpg)$/;

export interface ProjectWrite {
  written: string[];
  /** Old images and launcher files removed so they do not clash with the new ones. */
  removed: string[];
  /** Files left alone that still clash, with why. */
  notes: string[];
}

/**
 * Writes the iOS set and the Android res files into the project's own folders, replacing what
 * was there the way the README describes: the old AppIcon images go (Contents.json is replaced,
 * so they would be unassigned), and so do launcher images and XML under other names or formats
 * (Android Studio ships .webp; the same name in two formats fails the build with "Duplicate
 * resources"). Store icons are not part of a project and are not written.
 */
export async function writeIntoProject(build: AppIconBuild, targets: ProjectTargets): Promise<ProjectWrite> {
  const result: ProjectWrite = { written: [], removed: [], notes: [] };
  const mapped: Array<[string, Uint8Array]> = [];
  for (const [rel, bytes] of build.files) {
    if (targets.iosSet && rel.startsWith(`${IOS_SET}/`)) mapped.push([path.join(targets.iosSet, rel.slice(IOS_SET.length + 1)), bytes]);
    else if (targets.androidRes && rel.startsWith(`${ANDROID_RES}/`)) mapped.push([path.join(targets.androidRes, ...rel.slice(ANDROID_RES.length + 1).split("/")), bytes]);
  }
  const incoming = new Set(mapped.map(([p]) => p));

  if (targets.iosSet) {
    for (const name of await fs.readdir(targets.iosSet).catch(() => [] as string[])) {
      const p = path.join(targets.iosSet, name);
      if (/\.(png|jpe?g)$/i.test(name) && !incoming.has(p)) {
        await fs.rm(p, { force: true });
        result.removed.push(p);
      }
    }
  }
  if (targets.androidRes) {
    const res = targets.androidRes;
    for (const dir of await fs.readdir(res).catch(() => [] as string[])) {
      if (!dir.startsWith("mipmap-")) continue;
      for (const name of await fs.readdir(path.join(res, dir)).catch(() => [] as string[])) {
        const p = path.join(res, dir, name);
        if (LAUNCHER_NAMES.test(name) && !incoming.has(p)) {
          await fs.rm(p, { force: true });
          result.removed.push(p);
        }
      }
    }
    // ic_launcher_background defined as a colour in another values file would be a duplicate.
    const values = path.join(res, "values");
    for (const name of await fs.readdir(values).catch(() => [] as string[])) {
      if (name === "ic_launcher_background.xml" || !name.endsWith(".xml")) continue;
      const text = await fs.readFile(path.join(values, name), "utf8").catch(() => "");
      if (/<color\s+name="ic_launcher_background"/.test(text)) {
        result.notes.push(
          `values/${name} also defines the colour ic_launcher_background, which values/ic_launcher_background.xml now sets (${build.background}); with both, the build fails with a duplicate resource.`,
        );
      }
    }
  }

  for (const [dest, bytes] of mapped) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
    result.written.push(dest);
  }
  return result;
}
