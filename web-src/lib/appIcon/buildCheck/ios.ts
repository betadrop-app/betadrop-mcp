/**
 * What an iOS build's app icon actually is, read from the .ipa: the icon names Info.plist gives
 * (CFBundleIcons and CFBundleIcons~ipad: the primary icon's CFBundleIconName and
 * CFBundleIconFiles, and the alternate icons), the icon sets the compiled asset catalog in the
 * bundle root holds (Assets.car, see assetsCar.ts), and the loose PNGs Xcode writes beside it.
 *
 * The preview comes from the primary icon's loose PNGs, because the catalog's own images are
 * LZFSE-compressed and not decoded here. They are small (120 px on iPhone, 152 or 167 px on iPad),
 * and Xcode crushes them into CgBI, which cgbi.ts converts back to a standard PNG. An alternate
 * icon's files are never the preview: they are not the icon people see first.
 *
 * This states facts and never judges them; report.ts decides what is missing or wrong. Nothing
 * here throws: a part that cannot be read is recorded as such and the rest still runs.
 */

import { readAssetsCar, IDIOMS, LAYOUT_ICON_STACK, LAYOUT_MULTISIZE_SET, type CarCatalog, type CarRendition } from "./assetsCar";
import { cgbiToPng, isCgbi } from "./cgbi";
import { sniffImage } from "./image";
import { isDict, parsePlist, type PlistDict, type PlistValue } from "./plist";
import type { Archive, IconPreview, IosAlternate, IosFacts, IosIconSet, IosLooseIcon, IosResult } from "./types";

const MB = 1024 * 1024;
/** Info.plist files are a few KB; 1 MB leaves room for any real one. */
const LIMIT = { plist: 1 * MB, car: 192 * MB, png: 8 * MB };

/** Idioms that make up an iOS app's own icon set (not the watch or Mac sets it may bundle). */
const IOS_IDIOMS = new Set([0, 1, 2, 6]);
const DEVICE_IDIOMS = new Set([0, 1, 2]);
const IDIOM_MARKETING = 6;
const DEVICE_NAMES: Record<number, "iPhone" | "iPad" | "universal"> = { 0: "universal", 1: "iPhone", 2: "iPad" };

const str = (v: PlistValue | undefined): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const strings = (v: PlistValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v ? [v] : [];

/** "Payload/Name.app/", or "Name.app/" for a zipped .app; null when the archive holds no app. */
export function findAppPath(names: readonly string[]): string | null {
  const plists = names.filter((n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
  if (plists.length) return plists.sort((a, b) => a.length - b.length || a.localeCompare(b))[0].slice(0, -"Info.plist".length);
  const loose = names.find((n) => /^[^/]+\.app\/Info\.plist$/.test(n));
  if (loose) return loose.slice(0, -"Info.plist".length);
  // A bundle with no Info.plist is still an app, just a broken one.
  const any = names.find((n) => /^Payload\/[^/]+\.app\//.test(n));
  return any ? any.slice(0, any.indexOf(".app/") + 5) : null;
}

export async function readIosIcons(archive: Archive): Promise<IosResult | null> {
  const appPath = findAppPath(archive.names);
  if (!appPath) return null;
  const facts: IosFacts = {
    appPath,
    plist: "missing",
    deviceFamilies: [],
    primaryIconFiles: [],
    iconFiles: [],
    alternates: [],
    catalog: "missing",
    sets: [],
    looseIcons: [],
    problems: [],
  };
  let preview: IconPreview | null = null;
  try {
    const info = await readInfo(archive, appPath, facts);
    if (info) describeIcons(info, facts);
    await readCatalog(archive, appPath, facts);
    preview = await readLooseIcons(archive, appPath, facts);
  } catch {
    facts.problems.push("Part of the app bundle could not be read, so some icon details are missing.");
  }
  return { facts, preview };
}

async function readInfo(archive: Archive, appPath: string, facts: IosFacts): Promise<PlistDict | null> {
  const name = `${appPath}Info.plist`;
  if (archive.size(name) === undefined) return null;
  const bytes = await archive.read(name, LIMIT.plist);
  let info: PlistValue = null;
  try {
    if (bytes) info = parsePlist(bytes);
  } catch {
    info = null;
  }
  if (!isDict(info)) {
    facts.plist = "unreadable";
    return null;
  }
  facts.plist = "read";
  facts.displayName = str(info.CFBundleDisplayName) ?? str(info.CFBundleName);
  facts.bundleId = str(info.CFBundleIdentifier);
  facts.version = str(info.CFBundleShortVersionString);
  facts.build = str(info.CFBundleVersion);
  facts.minimumOS = str(info.MinimumOSVersion);
  const families = info.UIDeviceFamily;
  facts.deviceFamilies = (Array.isArray(families) ? families : [families]).filter((f): f is number => typeof f === "number");
  return info;
}

/**
 * Real apps list a handful of alternate icons and a few file names each. A hostile Info.plist (a
 * binary one can repeat one shared value thousands of times within 1 MB) could list tens of
 * thousands, and every name is matched against every file in the app, so only this many are checked.
 */
const MAX_ALTERNATES = 50;
const MAX_ICON_FILES = 50;

function describeIcons(info: PlistDict, facts: IosFacts): void {
  const primaryFiles = new Set<string>();
  const allFiles = new Set<string>();
  const alternates = new Map<string, IosAlternate>();
  const skipped = new Set<string>();
  for (const key of ["CFBundleIcons", "CFBundleIcons~ipad"]) {
    const icons = info[key];
    if (!isDict(icons)) continue;
    const primary = icons.CFBundlePrimaryIcon;
    if (isDict(primary)) {
      facts.primaryIconName ??= str(primary.CFBundleIconName);
      for (const f of strings(primary.CFBundleIconFiles)) primaryFiles.add(f);
    } else if (str(primary)) {
      facts.primaryIconName ??= str(primary);
    }
    const alt = icons.CFBundleAlternateIcons;
    if (isDict(alt)) {
      for (const [k, v] of Object.entries(alt)) {
        if (!alternates.has(k) && alternates.size >= MAX_ALTERNATES) {
          skipped.add(k);
          continue;
        }
        const entry = alternates.get(k) ?? { key: k, files: [], found: [] };
        if (isDict(v)) {
          entry.iconName ??= str(v.CFBundleIconName);
          for (const f of strings(v.CFBundleIconFiles)) {
            if (entry.files.length < MAX_ICON_FILES && !entry.files.includes(f)) entry.files.push(f);
          }
        }
        alternates.set(k, entry);
      }
    }
  }
  // The pre-iOS 5 keys name the primary icon too.
  for (const f of strings(info.CFBundleIconFiles)) primaryFiles.add(f);
  for (const f of strings(info.CFBundleIconFile)) primaryFiles.add(f);
  primaryFiles.forEach((f) => allFiles.add(f));
  alternates.forEach((a) => a.files.forEach((f) => allFiles.add(f)));
  facts.primaryIconFiles = Array.from(primaryFiles).slice(0, MAX_ICON_FILES);
  facts.iconFiles = Array.from(allFiles);
  facts.alternates = Array.from(alternates.values());
  if (skipped.size) facts.alternatesSkipped = skipped.size;
}

async function readCatalog(archive: Archive, appPath: string, facts: IosFacts): Promise<void> {
  const name = `${appPath}Assets.car`;
  const size = archive.size(name);
  if (size === undefined) return;
  if (size > LIMIT.car) {
    facts.catalog = "too-large";
    facts.catalogProblem = `Assets.car is ${Math.round(size / MB)} MB, more than this page reads (${LIMIT.car / MB} MB).`;
    return;
  }
  const bytes = await archive.read(name, LIMIT.car);
  if (!bytes) {
    facts.catalog = "unreadable";
    facts.catalogProblem = "Assets.car could not be extracted from the archive.";
    return;
  }
  const catalogAlternates = facts.alternates.filter((a): a is IosAlternate & { iconName: string } => Boolean(a.iconName));
  const listed = [facts.primaryIconName, ...catalogAlternates.map((a) => a.iconName)].filter((n): n is string => Boolean(n));
  let car: CarCatalog;
  try {
    const peek = readAssetsCar(bytes);
    // A second pass keeps renditions of a listed name that is not an app icon set (a plain image
    // set named in Info.plist by mistake), so the report can say what it found under that name.
    const extra = new Set(listed.map((n) => peek.facets.get(n)).filter((id): id is number => id !== undefined && !peek.iconSets.has(id)));
    car = extra.size ? readAssetsCar(bytes, extra) : peek;
  } catch {
    facts.catalog = "unreadable";
    facts.catalogProblem = "Assets.car is not a compiled asset catalog this page can read.";
    return;
  }
  facts.catalog = "read";
  if (car.thinning) facts.thinning = car.thinning;

  const seen = new Set<string>();
  const add = (setName: string, role: IosIconSet["role"]) => {
    if (seen.has(setName)) return;
    seen.add(setName);
    facts.sets.push(summarise(car, setName, role));
  };
  if (facts.primaryIconName) add(facts.primaryIconName, "primary");
  for (const a of catalogAlternates) add(a.iconName, "alternate");
  const names = new Map(Array.from(car.facets, ([n, id]) => [id, n] as const));
  car.iconSets.forEach((id) => {
    const n = names.get(id);
    if (n) add(n, "unlisted");
  });

  // Without Info.plist nothing names the app icon; a catalog with exactly one icon set is clear
  // enough to describe that set as the app icon, and the report says it was inferred.
  if (facts.plist !== "read") {
    const candidates = facts.sets.filter((s) => s.role === "unlisted" && s.found);
    if (candidates.length === 1) {
      candidates[0].role = "primary";
      facts.primaryGuessed = true;
    }
  }
}

/** Light is the default look: Icon Composer stacks and macOS name it, the rest leave it unnamed. */
function appearanceKind(car: CarCatalog, id: number): "default" | "dark" | "tinted" | string {
  const name = car.appearances.get(id);
  // NSAppearanceNameAqua is macOS's light look; NSAppearanceNameDarkAqua is not.
  if (id === 0 || !name || /(Any|Light|NameAqua)$/.test(name)) return "default";
  if (/dark/i.test(name)) return "dark";
  if (/tint/i.test(name)) return "tinted";
  return name.replace(/^(UI|IS|NS)Appearance(Name)?/, "").toLowerCase() || name;
}

function summarise(car: CarCatalog, name: string, role: IosIconSet["role"]): IosIconSet {
  const id = car.facets.get(name);
  const images: CarRendition[] =
    id === undefined ? [] : car.renditions.filter((r) => r.identifier === id && r.layout !== LAYOUT_MULTISIZE_SET && r.width > 0 && r.height > 0);
  const own = images.filter((r) => IOS_IDIOMS.has(r.idiom));
  const used = own.length ? own : images; // a watch-only or Mac-only set still reports its sizes
  const kinds = new Map<CarRendition, string>(used.map((r) => [r, appearanceKind(car, r.appearance)]));
  const defaults = used.filter((r) => kinds.get(r) === "default");
  const side = (r: CarRendition) => Math.max(r.width, r.height);
  const appearances = Array.from(new Set(Array.from(kinds.values()).filter((k) => k !== "default")));
  const onDevice = defaults.filter((r) => DEVICE_IDIOMS.has(r.idiom));
  const iconComposer = images.some((r) => r.layout === LAYOUT_ICON_STACK);
  return {
    name,
    role,
    found: images.length > 0,
    sizes: Array.from(new Set(defaults.map(side))).sort((a, b) => a - b),
    // Icon Composer stacks sit on the universal idiom; the devices are the flat images' idioms.
    idioms: Array.from(
      new Set(
        (defaults.some((r) => r.layout !== LAYOUT_ICON_STACK) ? defaults.filter((r) => r.layout !== LAYOUT_ICON_STACK) : defaults)
          .sort((x, y) => x.idiom - y.idiom)
          .map((r) => IDIOMS[r.idiom] ?? `idiom ${r.idiom}`),
      ),
    ),
    appearances,
    dark: appearances.includes("dark"),
    tinted: appearances.includes("tinted"),
    // Xcode makes the App Store icon from an Icon Composer stack, so the stack counts as one.
    appStore: iconComposer || defaults.some((r) => side(r) >= 1024 && (DEVICE_IDIOMS.has(r.idiom) || r.idiom === IDIOM_MARKETING)),
    singleSize: onDevice.length > 0 && onDevice.every((r) => side(r) >= 1024),
    hasPad: defaults.some((r) => r.idiom === 2 || r.idiom === 0),
    iconComposer,
    deviceImages: onDevice.map((r) => ({ idiom: DEVICE_NAMES[r.idiom], px: side(r), scale: r.scale })),
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The loose icons: the primary icon's (facts.looseIcons, and the preview: the largest that
 * decodes) and each file-based alternate's (alternate.found).
 */
async function readLooseIcons(archive: Archive, appPath: string, facts: IosFacts): Promise<IconPreview | null> {
  const root = archive.names.filter((n) => n.startsWith(appPath) && !n.slice(appPath.length).includes("/") && /\.png$/i.test(n));
  // CFBundleIconFiles stems name files as stem[@Nx][~ipad|~iphone].png. Without a declared stem,
  // actool's own names (AppIcon60x60@2x.png, AppIcon76x76@2x~ipad.png) put the size after it.
  const matches = (stems: string[], sizeInfix = false) => {
    const size = sizeInfix ? "(\\d+(?:\\.\\d+)?x\\d+(?:\\.\\d+)?)?" : "";
    const res = stems.map((s) => new RegExp(`^${escape(s.replace(/\.png$/i, ""))}${size}(@[0-9.]+x)?(~ipad|~iphone)?\\.png$`, "i"));
    return root.filter((n) => res.some((re) => re.test(n.slice(appPath.length))));
  };

  const read = async (paths: string[]) => {
    const found: { icon: IosLooseIcon; bytes: Uint8Array }[] = [];
    for (const path of paths.slice(0, 64)) {
      const bytes = await archive.read(path, LIMIT.png);
      const head = bytes && sniffImage(bytes);
      if (!bytes || !head || head.type !== "image/png") {
        facts.problems.push(`${path.slice(appPath.length)} could not be read.`);
        continue;
      }
      found.push({ icon: { path, width: head.width, height: head.height, cgbi: isCgbi(bytes) }, bytes });
    }
    return found;
  };

  for (const alt of facts.alternates) {
    if (alt.files.length) alt.found = (await read(matches(alt.files))).map((f) => f.icon);
  }

  let paths = matches(facts.primaryIconFiles);
  const declared = paths.length > 0;
  if (!declared) {
    // Nothing declared, or Info.plist unreadable: an icon-looking file in the root is still the
    // best picture there is. Alternates' files are left out: they are not the app's icon.
    const altFiles = new Set(facts.alternates.flatMap((a) => a.found.map((f) => f.path)));
    const primarySet = facts.sets.find((s) => s.role === "primary")?.name;
    const stems = Array.from(new Set([facts.primaryIconName, primarySet, "AppIcon", "Icon"].filter((s): s is string => Boolean(s))));
    paths = matches(stems, true).filter((p) => !altFiles.has(p));
  }
  const found = await read(paths);
  if (declared) facts.looseIcons = found.map((f) => f.icon);

  found.sort((a, b) => b.icon.width - a.icon.width);
  for (const { icon, bytes } of found) {
    const png = icon.cgbi ? await cgbiToPng(bytes) : bytes;
    if (!png) continue;
    return { bytes: png, type: "image/png", width: icon.width, height: icon.height, path: icon.path, label: icon.path.slice(appPath.length) };
  }
  return null;
}
