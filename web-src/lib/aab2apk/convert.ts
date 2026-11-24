/**
 * AAB -> universal APK, in the browser. `preflight` reads the bundle's
 * structure and either returns a Plan or a Refusal; `convert` turns a Plan
 * into a signed APK. Nothing here touches the network or the DOM.
 *
 * Runs on the calling thread with `await` points between files (no worker).
 */

import { flattenTable } from "./arsc";
import { decodeXml, flattenXml } from "./axml";
import { androidVersionName, editManifest, readManifestInfo, readModuleKind } from "./manifest";
import type { ManifestInfo } from "./manifest";
import { PbMessage } from "./pb";
import { decodeResourceTable, ResourcesUnsupported } from "./resourcesProto";
import type { TableModel } from "./resourcesProto";
import { buildV1Files, isV1SignatureFile, signV2 } from "./sign";
import type { TestKey } from "./testKey";
import { blobSource, deflateRaw, inflateRaw, ZipFormatError, ZipReader } from "./zipReader";
import type { ZipEntry, ZipSource } from "./zipReader";
import { crc32, ZipWriter } from "./zipWriter";
import type { ZipWriteEntry } from "./zipWriter";

export const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;

export type RefusalReason = "not_aab" | "feature_module" | "asset_pack" | "resources" | "too_large" | "corrupt" | "browser";

export interface Refusal {
  refused: true;
  reason: RefusalReason;
  /** The file is an APK already (reason not_aab). */
  isApk?: boolean;
  /** Internal detail for tests and logs. Never shown or sent as an event. */
  detail?: string;
}

export class ConvertRefused extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

export interface Plan {
  refused: false;
  fileName: string;
  fileSize: number;
  manifest: ManifestInfo;
  /** "Installs on Android X and newer". */
  minAndroid: string;
  /** Modules fused into the APK, base first. */
  modules: string[];
  /** Install-time asset packs included. */
  assetPacks: string[];
  abis: string[];
  /** Native libraries stored uncompressed and page-aligned (extractNativeLibs=false). */
  storeNativeLibs: boolean;
  nativeAlignment: number;
  signV1: boolean;
  outputName: string;
  /** Internal state for convert(). */
  readonly internal: PlanInternal;
}

interface PlanInternal {
  reader: ZipReader;
  table: TableModel;
  uncompressed: RegExp[];
  storePackAssets: boolean;
}

export const STEPS = ["Reading bundle", "Converting resources", "Writing APK", "Signing"] as const;

export interface Progress {
  /** Index into STEPS. */
  step: number;
  /** 0..1 within the step. */
  fraction: number;
}

export interface ConvertResult {
  apk: Blob;
  name: string;
  size: number;
  sha256: string;
}

export function browserSupported(): boolean {
  return (
    typeof CompressionStream === "function" &&
    typeof DecompressionStream === "function" &&
    typeof crypto !== "undefined" &&
    !!crypto.subtle &&
    typeof Blob === "function" &&
    typeof Response === "function"
  );
}

const refuse = (reason: RefusalReason, detail: string, extra: Partial<Refusal> = {}): Refusal => ({ refused: true, reason, detail, ...extra });

/** Java PathMatcher "glob:" syntax, as bundletool uses for uncompressed_glob. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      inGroup = true;
    } else if (c === "}" && inGroup) {
      re += ")";
      inGroup = false;
    } else if (c === "," && inGroup) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += `[${body}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      re += "\\" + glob[++i];
    } else re += c.replace(/[.+^$()|\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function readBundleConfig(buf: Uint8Array | null): {
  type: number;
  uncompressed: RegExp[];
  storePackAssets: boolean;
  uncompressNative: boolean;
  nativeAlignment: number;
} {
  const out = { type: 0, uncompressed: [] as RegExp[], storePackAssets: false, uncompressNative: true, nativeAlignment: 16384 };
  if (!buf) return out;
  const config = new PbMessage(buf);
  out.type = config.uint(8);
  const compression = config.msg(3);
  if (compression) {
    out.uncompressed = compression.strs(1).map(globToRegExp);
    out.storePackAssets = compression.uint(2) === 1;
  }
  const native = config.msg(2)?.msg(2);
  if (native) {
    out.uncompressNative = native.bool(1);
    const a = native.uint(2);
    out.nativeAlignment = a === 1 ? 4096 : a === 3 ? 65536 : 16384;
  }
  return out;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function outputFileName(m: ManifestInfo): string {
  const parts = [safeName(m.packageName) || "app"];
  const v = safeName(m.versionName);
  if (v) parts.push(v);
  parts.push("universal");
  return `${parts.join("-")}.apk`;
}

const MODULE_SKIP = new Set(["assets.pb", "native.pb", "apex.pb", "resources.pb"]);

/** Check a bundle and plan its conversion. Never throws. */
export async function preflight(file: Blob & { name?: string }, opts: { maxBytes?: number; source?: ZipSource } = {}): Promise<Plan | Refusal> {
  const name = file.name ?? "bundle.aab";
  const lower = name.toLowerCase();
  if (lower.endsWith(".apk")) return refuse("not_aab", "apk", { isApk: true });
  if (/\.(apks|xapk|zip|ipa)$/.test(lower)) return refuse("not_aab", "extension");
  if (file.size > (opts.maxBytes ?? MAX_BUNDLE_BYTES)) return refuse("too_large", `${file.size} bytes`);
  if (!browserSupported()) return refuse("browser", "missing CompressionStream or WebCrypto");

  let reader: ZipReader;
  try {
    reader = await ZipReader.open(opts.source ?? blobSource(file));
  } catch (e) {
    return refuse(lower.endsWith(".aab") ? "corrupt" : "not_aab", e instanceof Error ? e.message : String(e));
  }

  const baseManifest = reader.get("base/manifest/AndroidManifest.xml");
  if (!baseManifest) {
    if (reader.get("AndroidManifest.xml")) return refuse("not_aab", "apk inside", { isApk: true });
    return refuse("not_aab", "no base module");
  }

  try {
    const configEntry = reader.get("BundleConfig.pb");
    const config = readBundleConfig(configEntry ? await reader.data(configEntry) : null);
    if (config.type === 1) return refuse("not_aab", "APEX bundle");
    if (config.type === 2) return refuse("asset_pack", "asset-only bundle");

    const moduleNames = new Set<string>();
    for (const e of reader.entries) {
      const m = /^([^/]+)\/manifest\/AndroidManifest\.xml$/.exec(e.name);
      if (m && m[1] !== "base") moduleNames.add(m[1]);
    }
    const assetPacks: string[] = [];
    for (const mod of Array.from(moduleNames).sort()) {
      const kind = readModuleKind(decodeXml(await reader.data(reader.get(`${mod}/manifest/AndroidManifest.xml`) as ZipEntry)));
      if (kind.kind === "feature") return refuse("feature_module", mod);
      if (kind.delivery !== "install-time") return refuse("asset_pack", `${mod} ${kind.delivery}`);
      assetPacks.push(mod);
    }

    const root = decodeXml(await reader.data(baseManifest));
    const manifest = readManifestInfo(root);
    if (manifest.hasSplitName) return refuse("not_aab", "base manifest is a split");
    if (manifest.minSdk < 18) throw new ResourcesUnsupported(`minSdk ${manifest.minSdk} needs SHA-1 JAR signing`);

    const resEntry = reader.get("base/resources.pb");
    if (!resEntry) throw new ResourcesUnsupported("no base/resources.pb");
    const table = decodeResourceTable(await reader.data(resEntry));

    const abis = new Set<string>();
    for (const e of reader.entries) {
      const m = /^base\/lib\/([^/]+)\/[^/]+$/.exec(e.name);
      if (m) abis.add(m[1]);
      if (/^[^/]+\/assets\/(.*\/)?[^/]*#[^/]*\//.test(e.name)) throw new ResourcesUnsupported("targeted asset folders");
    }

    const storeNativeLibs = abis.size > 0 && config.uncompressNative && manifest.minSdk >= 23;
    return {
      refused: false,
      fileName: name,
      fileSize: file.size,
      manifest,
      minAndroid: androidVersionName(manifest.minSdk),
      modules: ["base", ...assetPacks],
      assetPacks,
      abis: Array.from(abis).sort(),
      storeNativeLibs,
      nativeAlignment: config.nativeAlignment,
      signV1: manifest.minSdk < 24,
      outputName: outputFileName(manifest),
      internal: { reader, table, uncompressed: config.uncompressed, storePackAssets: config.storePackAssets },
    };
  } catch (e) {
    if (e instanceof ResourcesUnsupported) return refuse("resources", e.message);
    if (e instanceof ZipFormatError) return refuse("corrupt", e.message);
    return refuse("corrupt", e instanceof Error ? e.message : String(e));
  }
}

/** Where a bundle entry goes in the APK, or null when it is dropped. */
export function apkPath(entryName: string, assetPacks: readonly string[]): string | null {
  const profile = /^BUNDLE-METADATA\/com\.android\.tools\.build\.profiles\/(baseline\.profm?)$/.exec(entryName);
  if (profile) return `assets/dexopt/${profile[1]}`;
  const slash = entryName.indexOf("/");
  if (slash < 0) return null;
  const mod = entryName.slice(0, slash);
  const rest = entryName.slice(slash + 1);
  if (mod === "base") {
    if (rest.startsWith("dex/")) return /^dex\/classes\d*\.dex$/.test(rest) ? rest.slice(4) : null;
    if (rest.startsWith("res/") || rest.startsWith("assets/") || rest.startsWith("lib/")) return rest;
    if (rest.startsWith("root/")) {
      const p = rest.slice(5);
      return isV1SignatureFile(p) ? null : p;
    }
    return null;
  }
  if (assetPacks.includes(mod) && rest.startsWith("assets/")) return rest;
  return null;
}

function isCompressedMedia(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|mp3|mp4|ogg|wav|m4a|aac|3gp|zip|jar|arsc)$/i.test(path);
}

interface Pending {
  path: string;
  build: () => Promise<{ entry: ZipWriteEntry; plain: Uint8Array | null }>;
}

async function deflated(path: string, data: Uint8Array): Promise<ZipWriteEntry> {
  const crc = crc32(data);
  if (!isCompressedMedia(path) && data.length > 0) {
    const d = await deflateRaw(data);
    if (d.length < data.length) return { name: path, method: 8, crc, size: data.length, data: d, align: 1 };
  }
  return { name: path, method: 0, crc, size: data.length, data, align: 4 };
}

function stored(path: string, data: Uint8Array, align: number): ZipWriteEntry {
  return { name: path, method: 0, crc: crc32(data), size: data.length, data, align };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  // Hash the APK parts as one buffer; the APK is at most a few hundred MB.
  const size = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Convert a planned bundle to a signed universal APK. Throws ConvertRefused or an engine error. */
export async function convert(plan: Plan, key: TestKey, onProgress: (p: Progress) => void = () => {}): Promise<ConvertResult> {
  const { reader, table, uncompressed, storePackAssets } = plan.internal;
  const report = (step: number, fraction: number) => onProgress({ step, fraction: Math.max(0, Math.min(1, fraction)) });
  try {
    report(0, 0);
    const xmlPaths = new Set(table.files.filter((f) => f.type === 3).map((f) => f.path));
    const pending = new Map<string, Pending>();
    const add = (p: Pending) => {
      if (pending.has(p.path)) throw new ConvertRefused("corrupt", `duplicate APK path ${p.path}`);
      pending.set(p.path, p);
    };

    const manifestRoot = decodeXml(await reader.data(reader.get("base/manifest/AndroidManifest.xml") as ZipEntry));
    editManifest(manifestRoot, plan.modules, plan.abis.length ? !plan.storeNativeLibs : null);
    const manifestBin = flattenXml(manifestRoot, true);
    add({ path: "AndroidManifest.xml", build: async () => ({ entry: await deflated("AndroidManifest.xml", manifestBin), plain: manifestBin }) });
    report(0, 1);

    report(1, 0);
    const arsc = flattenTable(table);
    add({ path: "resources.arsc", build: async () => ({ entry: stored("resources.arsc", arsc, 4), plain: arsc }) });

    const entries = reader.entries.filter((e) => apkPath(e.name, plan.assetPacks) !== null);
    let done = 0;
    for (const e of entries) {
      const path = apkPath(e.name, plan.assetPacks) as string;
      const isPackAsset = !e.name.startsWith("base/") && !path.startsWith("assets/dexopt/");
      if (path.startsWith("res/") && xmlPaths.has(path)) {
        const bin = flattenXml(decodeXml(await reader.data(e)), false);
        add({ path, build: async () => ({ entry: await deflated(path, bin), plain: bin }) });
        done++;
        if (done % 50 === 0) {
          report(1, done / entries.length);
          await tick();
        }
        continue;
      }
      // Baseline profiles are stored, as bundletool stores them.
      const mustStore =
        uncompressed.some((r) => r.test(path)) || (isPackAsset && storePackAssets) || path.startsWith("assets/dexopt/");
      const isLib = path.startsWith("lib/") && path.endsWith(".so");
      add({
        path,
        build: async () => {
          if (isLib && plan.storeNativeLibs) {
            const data = await reader.data(e);
            return { entry: stored(path, data, plan.nativeAlignment), plain: data };
          }
          if (mustStore) {
            const data = await reader.data(e);
            return { entry: stored(path, data, 4), plain: data };
          }
          if (e.method === 8 && !plan.signV1) {
            // Copy the bundle's own deflate stream as it is.
            const raw = await reader.rawData(e);
            return { entry: { name: path, method: 8, crc: e.crc, size: e.size, data: raw, align: 1 }, plain: null };
          }
          if (e.method === 8) {
            const raw = await reader.rawData(e);
            const plain = await inflateRaw(raw);
            if (plain.length !== e.size || crc32(plain) !== e.crc) throw new ConvertRefused("corrupt", `${e.name} fails its CRC`);
            return { entry: { name: path, method: 8, crc: e.crc, size: e.size, data: raw, align: 1 }, plain };
          }
          const data = await reader.data(e);
          return { entry: await deflated(path, data), plain: data };
        },
      });
    }
    report(1, 1);

    report(2, 0);
    const names = Array.from(pending.keys()).filter((n) => n !== "AndroidManifest.xml").sort();
    names.unshift("AndroidManifest.xml");
    const zip = new ZipWriter();
    const v1Digests = new Map<string, Uint8Array>();
    let i = 0;
    for (const n of names) {
      const { entry, plain } = await (pending.get(n) as Pending).build();
      if (plan.signV1) {
        if (!plain) throw new Error(`no plain bytes for ${n}`);
        v1Digests.set(n, new Uint8Array(await crypto.subtle.digest("SHA-256", plain as BufferSource)));
      }
      zip.add(entry);
      i++;
      report(2, i / names.length);
      if (i % 25 === 0) await tick();
    }

    report(3, 0);
    if (plan.signV1) {
      for (const f of await buildV1Files(v1Digests, key)) zip.add(await deflated(f.name, f.data));
    }
    const totalChunks = Math.max(1, Math.ceil(zip.length / (1024 * 1024)));
    let chunk = 0;
    const parts = await signV2(zip, key, async () => {
      chunk++;
      report(3, chunk / totalChunks);
      if (chunk % 8 === 0) await tick();
    });
    const sha256 = await sha256Hex(parts);
    report(3, 1);
    const apk = new Blob(parts as BlobPart[], { type: "application/vnd.android.package-archive" });
    return { apk, name: plan.outputName, size: apk.size, sha256 };
  } catch (e) {
    if (e instanceof ResourcesUnsupported) throw new ConvertRefused("resources", e.message);
    if (e instanceof ZipFormatError) throw new ConvertRefused("corrupt", e.message);
    throw e;
  }
}
