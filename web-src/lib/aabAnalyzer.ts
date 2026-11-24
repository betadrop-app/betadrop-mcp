// ──────────────────────────────────────────────────────────────────────────
// In-browser Android App Bundle (.aab) inspector. 100% client-side.
//
// WHY AN .aab NEEDS ITS OWN TOOL RATHER THAN THE APK ONE
//
// An .aab is not an installable app and its size is not the size anyone
// downloads. It is a publishing format: Play splits it per device and delivers
// only the matching pieces, so a 60MB bundle can be a 15MB install. Opening one
// in an APK tool answers the wrong question twice over — the manifest is
// protobuf rather than binary XML (see `protoXml.ts`), and the total file size
// is a number no user will ever experience.
//
// So the question this tool answers is the one the format actually raises:
// what will a real device download, and which of the parts are pulling weight.
// ──────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { findAll, parseProtoXml, type ProtoXmlElement } from "@/lib/protoXml";

/** Matches the APK inspector's ceiling, and for the same reason: this all happens in a tab. */
export const MAX_SIZE_BYTES = 250 * 1024 * 1024;

export type Severity = "high" | "warning" | "info" | "secure";

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

export interface AabModule {
  name: string;
  /** base | feature | asset-pack — read from the module's own `<module>` dist element. */
  kind: "base" | "feature" | "asset-pack";
  /** install-time | on-demand | conditional | unknown */
  delivery: string;
  downloadBytes: number;
  fileCount: number;
  hasDex: boolean;
}

export interface AabManifest {
  packageName?: string;
  versionName?: string;
  versionCode?: string;
  minSdk?: string;
  targetSdk?: string;
  debuggable: boolean;
  usesCleartextTraffic?: boolean;
  permissions: string[];
  /** Attribute names whose value came out of a compiled protobuf item, not a literal string. */
  compiledFields: string[];
}

export interface DeliveryEstimate {
  /** The whole .aab as it sits on disk. */
  bundleBytes: number;
  /** What one representative device is estimated to download. */
  deviceBytes: number;
  /**
   * Bytes every device gets regardless of configuration, across the modules
   * that are actually installed. Excludes on-demand, conditional and
   * asset-pack modules — those are counted in `deferredBytes` instead.
   */
  sharedBytes: number;
  abi?: { chosen: string; bytes: number; available: string[] };
  density?: { chosen: string; bytes: number; available: string[] };
  language?: { chosen: string; bytes: number; available: string[] };
  /** Modules Play does NOT ship at install time. */
  deferredBytes: number;
  assumptions: string[];
}

export interface AabAnalysis {
  fileName: string;
  fileSize: number;
  manifest: AabManifest;
  modules: AabModule[];
  delivery: DeliveryEstimate;
  signed: boolean;
  findings: Finding[];
}

/** JSZip keeps per-entry sizes on a private field; the APK analyzer reads it the same way. */
type ZipEntryData = { _data?: { uncompressedSize: number; compressedSize: number } };

function entrySizes(entry: JSZip.JSZipObject): { raw: number; packed: number } {
  const d = (entry as unknown as ZipEntryData)._data;
  return { raw: d?.uncompressedSize ?? 0, packed: d?.compressedSize ?? 0 };
}

/**
 * Density qualifiers, coarsest first.
 *
 * `nodpi`/`anydpi` are deliberately absent: they are density-INDEPENDENT and
 * ship to every device, so counting them as one bucket's cost would both
 * understate the shared floor and overstate whichever bucket got them.
 */
const DENSITIES = ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi", "tvdpi"];

/** The density a mainstream phone pulls, when the bundle offers it. */
const TYPICAL_DENSITY = "xxhdpi";
/** The ABI virtually every current device uses; Play requires 64-bit. */
const TYPICAL_ABI = "arm64-v8a";

/** `base/lib/arm64-v8a/libfoo.so` → `arm64-v8a`. */
function abiOf(path: string): string | undefined {
  const m = /(?:^|\/)lib\/([^/]+)\//.exec(path);
  return m?.[1];
}

/**
 * The density bucket a resource path belongs to, if any.
 *
 * Matches a `-<density>` qualifier on the resource directory rather than a bare
 * substring: `drawable-xxhdpi` and `drawable-en-rGB-xxhdpi` both count, while a
 * file that merely has "hdpi" in its name does not.
 */
function densityOf(path: string): string | undefined {
  const dir = /(?:^|\/)res\/([^/]+)\//.exec(path)?.[1];
  if (!dir) return undefined;
  const parts = dir.split("-");
  return parts.find((p) => DENSITIES.includes(p));
}

/**
 * The language a resource path is specific to, if any.
 *
 * Android qualifiers are `values-fr`, `values-fr-rCA`, or BCP-47 `values-b+sr+Latn`.
 * Two-letter lowercase after the resource type is the reliable signal; anything
 * else (a density, a screen size, `night`) is not a language.
 */
function languageOf(path: string): string | undefined {
  const dir = /(?:^|\/)res\/([^/]+)\//.exec(path)?.[1];
  if (!dir) return undefined;
  const parts = dir.split("-");
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^b\+[a-z]{2,3}(\+.+)?$/i.test(p)) return p;
    if (/^[a-z]{2}$/.test(p) && !DENSITIES.includes(p)) {
      const region = parts[i + 1];
      return /^r[A-Z]{2}$/.test(region ?? "") ? `${p}-${region}` : p;
    }
  }
  return undefined;
}

/** Read the `<dist:module>` element a feature module declares about itself. */
function moduleDelivery(root: ProtoXmlElement): { kind: AabModule["kind"]; delivery: string } {
  const mod = findAll(root, "module")[0];
  const kindAttr = mod?.attrs["type"];
  const kind: AabModule["kind"] = kindAttr === "asset-pack" ? "asset-pack" : "feature";

  const delivery = findAll(root, "delivery")[0];
  if (delivery) {
    if (findAll(delivery, "install-time").length) return { kind, delivery: "install-time" };
    if (findAll(delivery, "on-demand").length) return { kind, delivery: "on-demand" };
    if (findAll(delivery, "conditions").length) return { kind, delivery: "conditional" };
  }
  // The pre-`<dist:delivery>` spelling, still emitted by older Gradle plugins.
  // Gradle keeps the text "true"/"false"; a module whose manifest went through
  // binary XML first (an APK converted with `aapt2 convert`) has only the
  // compiled boolean, which protoXml reads as "1"/"0", as with `debuggable`.
  const onDemand = mod?.attrs["onDemand"] ?? "";
  if (["true", "1"].includes(onDemand)) return { kind, delivery: "on-demand" };
  if (["false", "0"].includes(onDemand)) return { kind, delivery: "install-time" };
  return { kind, delivery: "unknown" };
}

function readManifest(root: ProtoXmlElement): AabManifest {
  const app = findAll(root, "application")[0];
  const usesSdk = findAll(root, "uses-sdk")[0];
  const compiled: string[] = [];

  const pick = (el: ProtoXmlElement | undefined, attr: string, label: string) => {
    if (!el) return undefined;
    const v = el.attrs[attr];
    if (v === undefined || v === "") return undefined;
    if (el.compiledAttrs.has(attr)) compiled.push(label);
    return v;
  };

  return {
    packageName: root.attrs["package"] || undefined,
    versionName: pick(root, "versionName", "versionName"),
    versionCode: pick(root, "versionCode", "versionCode"),
    minSdk: pick(usesSdk, "minSdkVersion", "minSdkVersion"),
    targetSdk: pick(usesSdk, "targetSdkVersion", "targetSdkVersion"),
    // Through `pick` like every other value: a compiled boolean arrives as
    // "1"/"0" from the deliberately loose scalar scan, and reading it straight
    // off `attrs` meant the one field that drives a high-severity finding was
    // the one field never marked as inferred.
    debuggable: ["true", "1"].includes(pick(app, "debuggable", "debuggable") ?? ""),
    usesCleartextTraffic: (() => {
      const v = pick(app, "usesCleartextTraffic", "usesCleartextTraffic");
      return v === undefined ? undefined : ["true", "1"].includes(v);
    })(),
    permissions: findAll(root, "uses-permission")
      .map((p) => p.attrs["name"])
      .filter((n): n is string => !!n)
      .sort(),
    compiledFields: Array.from(new Set(compiled)),
  };
}

function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export async function analyzeAab(file: File): Promise<AabAnalysis> {
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error(
      `This bundle is ${(file.size / 1048576).toFixed(0)} MB — too large for in-browser analysis (max ${(MAX_SIZE_BYTES / 1048576).toFixed(0)} MB).`,
    );
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // The one structural signature of an app bundle. An .apk renamed to .aab has
  // a top-level AndroidManifest.xml instead, and says so here rather than
  // failing later with something about protobuf.
  const baseManifest = zip.files["base/manifest/AndroidManifest.xml"];
  if (!baseManifest) {
    throw new Error(
      zip.files["AndroidManifest.xml"]
        ? "This looks like an .apk, not an .aab — try the APK inspector instead."
        : "No base/manifest/AndroidManifest.xml found — this is not an Android App Bundle.",
    );
  }

  const manifest = readManifest(parseProtoXml(await baseManifest.async("uint8array")));

  // ---- inventory -----------------------------------------------------------
  //
  // Entries are collected before anything is totalled, because whether a file
  // counts toward the device estimate depends on its MODULE's delivery mode,
  // and that is only known after each module's own manifest has been read.
  type Entry = { module: string; packed: number; isDex: boolean; abi?: string; density?: string; language?: string };
  const entries: Entry[] = [];
  let signed = false;

  // A top-level directory is a module only if it carries its own manifest.
  // Real AGP output also contains BUNDLE-METADATA/ (dependency and build
  // metadata), which is not a module and is never delivered to a device —
  // treating "first path segment" as a module name listed it as a phantom
  // feature and put its bytes in the download estimate.
  const moduleNames = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    const m = /^([^/]+)\/manifest\/AndroidManifest\.xml$/.exec(path);
    if (m) moduleNames.add(m[1]);
  }

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const { packed } = entrySizes(entry);

    if (path.startsWith("META-INF/")) {
      // A .aab is jar-signed for upload. That signature is NOT the one users
      // verify — Play re-signs the delivered APKs with the app signing key —
      // so it is reported as a fact about the upload, not as app integrity.
      if (/\.(RSA|DSA|EC|SF)$/i.test(path)) signed = true;
      continue;
    }

    const moduleName = path.slice(0, path.indexOf("/"));
    // BundleConfig.pb, BUNDLE-METADATA/… — bundle-level, not shipped.
    if (!path.includes("/") || !moduleNames.has(moduleName)) continue;

    entries.push({
      module: moduleName,
      packed,
      isDex: path.endsWith(".dex"),
      abi: abiOf(path),
      density: densityOf(path),
      language: languageOf(path),
    });
  }

  // ---- module list, with each module's own delivery declaration ------------
  const modules: AabModule[] = [];
  for (const name of Array.from(moduleNames)) {
    const own = entries.filter((e) => e.module === name);
    let kind: AabModule["kind"] = "base";
    let delivery = "install-time";
    if (name !== "base") {
      const mf = zip.files[`${name}/manifest/AndroidManifest.xml`];
      try {
        const decl = moduleDelivery(parseProtoXml(await mf.async("uint8array")));
        kind = decl.kind;
        delivery = decl.delivery;
      } catch {
        kind = "feature";
        delivery = "unknown";
      }
    }
    modules.push({
      name,
      kind,
      delivery,
      downloadBytes: own.reduce((n, e) => n + e.packed, 0),
      fileCount: own.length,
      hasDex: own.some((e) => e.isDex),
    });
  }
  modules.sort((a, b) => (a.name === "base" ? -1 : b.name === "base" ? 1 : b.downloadBytes - a.downloadBytes));

  // Anything not delivered at install time is excluded from the device estimate
  // and reported separately, since that is the whole point of declaring it.
  const deferred = new Set(
    modules
      .filter((m) => m.delivery === "on-demand" || m.delivery === "conditional" || m.kind === "asset-pack")
      .map((m) => m.name),
  );
  const deferredBytes = modules
    .filter((m) => deferred.has(m.name))
    .reduce((n, m) => n + m.downloadBytes, 0);

  // ---- per-configuration weight, over DELIVERED modules only ---------------
  //
  // Restricting the buckets here rather than subtracting deferred bytes at the
  // end is what makes the arithmetic hold. Subtracting a deferred module's
  // TOTAL from the shared pool took away bytes that were never in it — its
  // lib/ and res/ entries had gone to the abi and density buckets — which
  // under-counted every bundle with a deferred module and drove a lib-heavy
  // one negative, rendering the headline estimate as 0 B.
  const abiBytes = new Map<string, number>();
  const densityBytes = new Map<string, number>();
  const langBytes = new Map<string, number>();
  let sharedBytes = 0;

  for (const e of entries) {
    if (deferred.has(e.module)) continue;
    if (e.abi) abiBytes.set(e.abi, (abiBytes.get(e.abi) ?? 0) + e.packed);
    else if (e.density) densityBytes.set(e.density, (densityBytes.get(e.density) ?? 0) + e.packed);
    else if (e.language) langBytes.set(e.language, (langBytes.get(e.language) ?? 0) + e.packed);
    else sharedBytes += e.packed;
  }

  const biggest = (m: Map<string, number>) =>
    Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
  const pick = (m: Map<string, number>, preferred: string) =>
    m.has(preferred) ? ([preferred, m.get(preferred)!] as const) : biggest(m);

  const abiPick = abiBytes.size ? pick(abiBytes, TYPICAL_ABI) : undefined;
  const densityPick = densityBytes.size ? pick(densityBytes, TYPICAL_DENSITY) : undefined;
  const langPick = langBytes.size ? biggest(langBytes) : undefined;

  const assumptions = [
    "Compressed sizes, which is what a device transfers.",
    abiPick ? `One ABI only (${abiPick[0]}) — Play never ships the others to a device.` : "No native libraries in this bundle.",
    densityPick ? `One screen density (${densityPick[0]}).` : "No density-specific resources.",
    langPick ? `One language only, sized on the heaviest (${langPick[0]}) so the estimate errs high.` : "No per-language resources.",
    deferredBytes > 0
      ? // Conditional feature modules are declared inside <dist:install-time>, so moduleDelivery
        // labels them install-time and they stay IN the estimate — they ship at install on a device
        // that matches. Every asset pack is left out, install-time ones included, hence the add-back.
        `Excludes ${human(deferredBytes)} of on-demand modules and asset packs. On-demand modules and fast-follow or on-demand asset packs download after install; an install-time asset pack ships with the app, so add it back if your bundle has one.`
      : "No deferred modules to exclude.",
  ];

  // `sharedBytes` already excludes deferred modules, so nothing is subtracted here.
  const deviceBytes =
    sharedBytes + (abiPick?.[1] ?? 0) + (densityPick?.[1] ?? 0) + (langPick?.[1] ?? 0);

  const delivery: DeliveryEstimate = {
    bundleBytes: file.size,
    deviceBytes: Math.max(0, deviceBytes),
    sharedBytes,
    abi: abiPick ? { chosen: abiPick[0], bytes: abiPick[1], available: Array.from(abiBytes.keys()).sort() } : undefined,
    density: densityPick
      ? { chosen: densityPick[0], bytes: densityPick[1], available: Array.from(densityBytes.keys()).sort() }
      : undefined,
    language: langPick
      ? { chosen: langPick[0], bytes: langPick[1], available: Array.from(langBytes.keys()).sort() }
      : undefined,
    deferredBytes,
    assumptions,
  };

  // ---- findings ------------------------------------------------------------
  const findings: Finding[] = [];
  if (manifest.debuggable) {
    findings.push({
      severity: "high",
      title: "android:debuggable is on",
      detail:
        "Play rejects a debuggable release, and a debuggable build lets anyone with the device read your app's data and attach a debugger. Set it false for the upload.",
    });
  }
  if (!manifest.targetSdk) {
    findings.push({
      severity: "warning",
      title: "No targetSdkVersion in the manifest",
      detail:
        "Play enforces a minimum target API for new uploads. If Gradle sets this for you it is normally still written into the merged manifest, so its absence is worth checking.",
    });
  }
  if (manifest.usesCleartextTraffic) {
    findings.push({
      severity: "warning",
      title: "Cleartext HTTP is allowed",
      detail:
        "usesCleartextTraffic is true, so the app may send unencrypted traffic. Narrow it with a network security config if only one host needs it.",
    });
  }
  if (abiBytes.size === 1 && abiBytes.has("armeabi-v7a")) {
    findings.push({
      severity: "high",
      title: "32-bit only",
      detail:
        "The bundle carries armeabi-v7a and no 64-bit ABI. Play requires a 64-bit version for apps with native code.",
    });
  }
  if (!signed) {
    findings.push({
      severity: "info",
      title: "No JAR signature in META-INF",
      detail:
        "Play requires the uploaded bundle to be signed with your upload key. An unsigned bundle is fine for local bundletool runs but will be rejected on upload.",
    });
  }
  if (delivery.bundleBytes > 0 && delivery.deviceBytes / delivery.bundleBytes > 0.9 && abiBytes.size <= 1 && densityBytes.size <= 1) {
    findings.push({
      severity: "info",
      title: "Little to split",
      detail:
        "This bundle has essentially one configuration, so splitting saves almost nothing. That is expected for an app with no native code and few density-specific assets.",
    });
  }

  return { fileName: file.name, fileSize: file.size, manifest, modules, delivery, signed, findings };
}
