/**
 * The manifest facts the 16 KB check reports (targetSdk, package, extractNativeLibs, split
 * markers), from an APK's binary XML or an AAB's proto XML, and the native-library settings in an
 * AAB's BundleConfig.pb.
 *
 * Both manifest formats are parsed by the build icon check's readers (src/lib/appIcon/buildCheck/
 * axml.ts and proto.ts) into one element model, so this reads either the same way.
 */

import { ANDROID_NS, findAttribute, parseAxml, TYPE_INT_BOOLEAN, TYPE_INT_DEC, TYPE_INT_HEX, TYPE_STRING } from "../appIcon/buildCheck/axml";
import type { ResValue, XmlElement } from "../appIcon/buildCheck/axml";
import { parseProtoXml } from "../appIcon/buildCheck/proto";
import type { BundleNativeConfig } from "./types";

/** android:* attribute resource ids, from `aapt2 dump resources android.jar` (platform 36). */
const ATTR = {
  name: 0x01010003,
  value: 0x01010024,
  targetSdkVersion: 0x01010270,
  extractNativeLibs: 0x010104ea,
  isSplitRequired: 0x01010591,
  requiredSplitTypes: 0x0101064e,
} as const;

export interface ManifestFacts {
  packageName: string | null;
  targetSdk: number | null;
  extractNativeLibs: boolean | null;
  /** The manifest has a `split` attribute, or declares that other splits are required. */
  split: boolean;
}

const EMPTY: ManifestFacts = { packageName: null, targetSdk: null, extractNativeLibs: null, split: false };

function intValue(v: ResValue | null | undefined): number | null {
  if (!v) return null;
  if (v.dataType === TYPE_INT_DEC || v.dataType === TYPE_INT_HEX) return v.data | 0;
  if (v.dataType === TYPE_STRING && v.string && /^\d+$/.test(v.string.trim())) return Number(v.string.trim());
  return null;
}

function boolValue(v: ResValue | null | undefined): boolean | null {
  if (!v) return null;
  if (v.dataType === TYPE_INT_BOOLEAN) return v.data !== 0;
  if (v.dataType === TYPE_STRING && v.string !== undefined) {
    const s = v.string.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
}

function stringValue(v: ResValue | null | undefined, raw?: string): string | null {
  if (v?.dataType === TYPE_STRING) return v.string ?? raw ?? null;
  return raw ?? null;
}

export function readManifestFacts(root: XmlElement): ManifestFacts {
  if (root.name !== "manifest") return EMPTY;
  const pkg = findAttribute(root, 0, "package");
  const facts: ManifestFacts = { ...EMPTY, packageName: stringValue(pkg?.value, pkg?.raw) || null };

  const sdk = root.children.find((c) => c.name === "uses-sdk");
  if (sdk) facts.targetSdk = intValue(findAttribute(sdk, ATTR.targetSdkVersion, "targetSdkVersion")?.value);

  const splitAttr = findAttribute(root, 0, "split");
  if (stringValue(splitAttr?.value, splitAttr?.raw)) facts.split = true;
  const required = findAttribute(root, ATTR.requiredSplitTypes, "requiredSplitTypes");
  if (stringValue(required?.value, required?.raw)) facts.split = true;

  const app = root.children.find((c) => c.name === "application" && (c.ns === "" || c.ns === ANDROID_NS));
  if (app) {
    facts.extractNativeLibs = boolValue(findAttribute(app, ATTR.extractNativeLibs, "extractNativeLibs")?.value);
    if (boolValue(findAttribute(app, ATTR.isSplitRequired, "isSplitRequired")?.value)) facts.split = true;
    // What Play's tooling writes into a base APK that needs its config splits.
    for (const md of app.children.filter((c) => c.name === "meta-data")) {
      const n = findAttribute(md, ATTR.name, "name");
      if (stringValue(n?.value, n?.raw) === "com.android.vending.splits.required" && boolValue(findAttribute(md, ATTR.value, "value")?.value)) {
        facts.split = true;
      }
    }
  }
  return facts;
}

/** An APK's AndroidManifest.xml (binary XML). Empty facts when it will not parse. */
export function apkManifestFacts(bytes: Uint8Array): ManifestFacts {
  try {
    return readManifestFacts(parseAxml(bytes));
  } catch {
    return EMPTY;
  }
}

/** An AAB's base/manifest/AndroidManifest.xml (proto XML). The split markers do not apply to a bundle. */
export function aabManifestFacts(bytes: Uint8Array): ManifestFacts {
  try {
    return { ...readManifestFacts(parseProtoXml(bytes)), split: false };
  } catch {
    return EMPTY;
  }
}

/** Binary XML starts with RES_XML_TYPE (0x0003) and an 8-byte header size. */
export function isBinaryXml(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x03 && head[1] === 0x00 && head[2] === 0x08 && head[3] === 0x00;
}

/** An AAR's AndroidManifest.xml is plain text: its package attribute, when it has one. */
export function textManifestPackage(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, 64 * 1024));
  const m = /<manifest\b[^>]*?\spackage\s*=\s*["']([^"']+)["']/.exec(text);
  return m ? m[1] : null;
}

// ── BundleConfig.pb ──────────────────────────────────────────────────────────────────────────

/** A lenient protobuf walk: field number, wire type, varint value or [from, to) of a payload. */
function fields(b: Uint8Array): { n: number; w: number; v: number; s: number; e: number }[] {
  const out: { n: number; w: number; v: number; s: number; e: number }[] = [];
  let p = 0;
  const varint = (): number => {
    let lo = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (p >= b.length) throw new Error("truncated varint");
      const byte = b[p++];
      if (i < 7) lo += (byte & 0x7f) * mul;
      mul *= 128;
      if (!(byte & 0x80)) return lo;
    }
    throw new Error("varint too long");
  };
  while (p < b.length) {
    const key = varint();
    const n = Math.floor(key / 8);
    const w = key % 8;
    if (n === 0) throw new Error("field 0");
    if (w === 0) out.push({ n, w, v: varint(), s: 0, e: 0 });
    else if (w === 2) {
      const len = varint();
      if (len > b.length - p) throw new Error("field runs past its message");
      out.push({ n, w, v: 0, s: p, e: p + len });
      p += len;
    } else if (w === 5) {
      if (p + 4 > b.length) throw new Error("short fixed32");
      p += 4;
    } else if (w === 1) {
      if (p + 8 > b.length) throw new Error("short fixed64");
      p += 8;
    } else throw new Error(`wire type ${w}`);
  }
  return out;
}

/**
 * Every occurrence of a length-delimited field, in order. Protobuf merges repeated occurrences of
 * a singular message field (each later scalar overrides, sub-messages merge recursively), so a
 * reader must walk all of them, not only the last.
 */
function subs(b: Uint8Array, n: number): Uint8Array[] {
  return fields(b)
    .filter((x) => x.n === n && x.w === 2)
    .map((f) => b.subarray(f.s, f.e));
}

/** The last value of a varint field across one message's fields. */
function lastVarint(b: Uint8Array, n: number): number | undefined {
  return fields(b)
    .filter((x) => x.n === n && x.w === 0)
    .pop()?.v;
}

export interface BundletoolVersion {
  major: number;
  minor: number;
  revision: number;
  qualifier: string | null;
}

/**
 * bundletool's own model/version/Version.java: `^(\d+?)\.(\d+?)\.(\d+?)(-(.+))?$`. Anything else
 * (bundletool throws on it) is null here, and treated as old by effectiveBundle.
 */
export function parseVersion(v: string): BundletoolVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) return null;
  const [major, minor, revision] = [m[1], m[2], m[3]].map(Number);
  // Java's Integer.parseInt would throw past 2^31 - 1.
  if (![major, minor, revision].every((n) => n <= 0x7fffffff)) return null;
  return { major, minor, revision, qualifier: m[4] ?? null };
}

/**
 * Version.compareTo: major, minor, revision, then the qualifier with "dev" first, other
 * qualifiers in natural (UTF-16 code unit) order, and no qualifier last. So "1.17.0-alpha01",
 * "1.17.0-rc01" and "1.17.0-dev" are all older than "1.17.0".
 */
export function compareVersions(a: BundletoolVersion, b: BundletoolVersion): number {
  const d = a.major - b.major || a.minor - b.minor || a.revision - b.revision;
  if (d) return d;
  if (a.qualifier === b.qualifier) return 0;
  if (a.qualifier === null) return 1;
  if (b.qualifier === null) return -1;
  const qa = a.qualifier === "dev" ? "" : a.qualifier;
  const qb = b.qualifier === "dev" ? "" : b.qualifier;
  return qa < qb ? -1 : qa > qb ? 1 : 0;
}

const V1_17_0: BundletoolVersion = { major: 1, minor: 17, revision: 0, qualifier: null };

const ALIGNMENTS = { 0: "unspecified", 1: "4k", 2: "16k", 3: "64k" } as const;

/**
 * BundleConfig.pb's native-library settings, and what bundletool does with them.
 *
 * Field numbers, from bundletool's src/main/proto/config.proto (read 2026-11-24):
 *   BundleConfig { Bundletool bundletool = 1; Optimizations optimizations = 2; }
 *   Bundletool { string version = 2; }
 *   Optimizations { UncompressNativeLibraries uncompress_native_libraries = 2; }
 *   UncompressNativeLibraries { bool enabled = 1; PageAlignment alignment = 2; }
 *   PageAlignment { UNSPECIFIED = 0; 4K = 1; 16K = 2; 64K = 3; }
 *
 * The effective values follow bundletool 1.18.3's own source:
 *   - optimizations/OptimizationsMerger.java mergeWithDefaults: uncompress = the config's
 *     uncompress_native_libraries message when present, its `enabled`, else the default; alignment
 *     = the config's when not UNSPECIFIED, else the default. The defaults are picked by
 *     bundletool.version (the bundletool that built the bundle; empty means the running one).
 *   - optimizations/ApkOptimizations.java getDefaultOptimizationsForVersion: uncompressed native
 *     libraries in every default from 0.6.0 on; PAGE_ALIGNMENT_16K from 1.17.0 on, unspecified
 *     before.
 *   - io/ApkSerializerModule.java: 16K → 16384, 64K → 65536, UNSPECIFIED and 4K → 4096.
 * Versions are ordered as bundletool's model/version/Version.java orders them (see compareVersions):
 * a prerelease of 1.17.0 ("1.17.0-alpha01", "-rc01", "-dev") is older than 1.17.0, so 4 KB.
 * A version older than 0.6.0 is not given a compressed default here: no such bundle can still be
 * uploaded, and treating it as uncompressed is the cautious side. A version string that does not
 * match bundletool's pattern (bundletool itself would refuse it) is treated as old, so 4 KB, also
 * the cautious side.
 */
export function readBundleConfig(bytes: Uint8Array | null): BundleNativeConfig {
  let uncompressNativeLibs: boolean | null = null;
  let alignment: BundleNativeConfig["alignment"] = "unspecified";
  let bundletoolVersion: string | null = null;
  if (bytes) {
    try {
      for (const bt of subs(bytes, 1)) {
        const ver = subs(bt, 2).pop();
        if (ver) bundletoolVersion = ver.length ? new TextDecoder("utf-8").decode(ver) : null;
      }
      let enabled: number | undefined;
      let align: number | undefined;
      let present = false;
      for (const opt of subs(bytes, 2)) {
        for (const unc of subs(opt, 2)) {
          present = true;
          enabled = lastVarint(unc, 1) ?? enabled;
          align = lastVarint(unc, 2) ?? align;
        }
      }
      if (present) {
        uncompressNativeLibs = (enabled ?? 0) !== 0;
        // A value outside the enum is what bundletool's proto runtime calls UNRECOGNIZED, and
        // io/ApkSerializerModule.java maps everything but 16K and 64K to 4096: so "4k".
        alignment = ALIGNMENTS[(align ?? 0) as 0 | 1 | 2 | 3] ?? "4k";
      }
    } catch {
      // A damaged config: what was read before the damage stays, the rest are defaults.
    }
  }
  return { uncompressNativeLibs, alignment, bundletoolVersion, ...effectiveBundle(uncompressNativeLibs, alignment, bundletoolVersion) };
}

export function effectiveBundle(
  uncompressNativeLibs: boolean | null,
  alignment: BundleNativeConfig["alignment"],
  bundletoolVersion: string | null,
): Pick<BundleNativeConfig, "effectiveUncompressed" | "effectiveAlignment"> {
  const effectiveUncompressed = uncompressNativeLibs ?? true;
  let effectiveAlignment: BundleNativeConfig["effectiveAlignment"];
  if (alignment !== "unspecified") effectiveAlignment = alignment;
  else if (!bundletoolVersion) effectiveAlignment = "16k";
  else {
    const v = parseVersion(bundletoolVersion);
    effectiveAlignment = v && compareVersions(v, V1_17_0) >= 0 ? "16k" : "4k";
  }
  return { effectiveUncompressed, effectiveAlignment };
}
