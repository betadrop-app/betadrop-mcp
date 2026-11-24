/**
 * resources.arsc, the compiled resource table in an APK, read just far enough to answer "what is
 * resource 0x7f0d0000, and what does each configuration of it point at?".
 *
 * The icon check needs every configuration of a resource, not only the default one: an app icon
 * is a set of files, one per screen density plus the adaptive icon under anydpi-v26, and what is
 * missing from that set is the whole point. So a lookup walks every RES_TABLE_TYPE chunk of the
 * resource's type and returns each configuration's density, SDK level and value.
 *
 * proto.ts builds the same `ResTable` from a bundle's resources.pb, so android.ts has one path.
 * Chunks are indexed once; entries, configurations and strings are decoded only when looked up.
 */

import { AndroidBinaryError, StringPool, TYPE_STRING, view, type ResValue } from "./axml";

/** The parts of a ResTable_config that show up in icon folders, plus a readable qualifier. */
export interface ResConfig {
  /** 0 when unspecified; 120 to 640; 0xfffe anydpi; 0xffff nodpi. */
  density: number;
  /** Minimum SDK level of the configuration, 0 when unspecified. */
  sdk: number;
  night: boolean;
  /** Folder-style locale ("en-rUS", "b+sr+Latn"), "" for the default. */
  locale: string;
  /** The folder suffix, short: "anydpi-v26", "xxxhdpi" (the implied -v4 dropped), "" for default. */
  qualifier: string;
}

export interface ResConfigValue {
  config: ResConfig;
  /** Null for a complex (bag) entry, such as a style or an array. */
  value: ResValue | null;
}

export interface ResEntry {
  id: number;
  typeName: string;
  entryName: string;
  values: ResConfigValue[];
}

export interface ResTable {
  lookup(id: number): ResEntry | null;
}

export const DENSITY_ANY = 0xfffe;
export const DENSITY_NONE = 0xffff;

const DENSITY_NAMES: Record<number, string> = {
  120: "ldpi",
  160: "mdpi",
  213: "tvdpi",
  240: "hdpi",
  320: "xhdpi",
  480: "xxhdpi",
  640: "xxxhdpi",
  [DENSITY_ANY]: "anydpi",
  [DENSITY_NONE]: "nodpi",
};

export function densityName(density: number): string {
  if (!density) return "";
  return DENSITY_NAMES[density] ?? `${density}dpi`;
}

/** The fields a qualifier is built from, already decoded from either table format. */
export interface ConfigParts {
  locale: string;
  layoutDir: "" | "ldltr" | "ldrtl";
  smallestWidthDp: number;
  widthDp: number;
  heightDp: number;
  round: "" | "round" | "notround";
  orientation: "" | "port" | "land" | "square";
  uiType: string;
  night: "" | "night" | "notnight";
  density: number;
  sdk: number;
}

const UI_TYPES = ["", "", "desk", "car", "television", "appliance", "watch", "vrheadset"];
export const uiTypeName = (n: number) => UI_TYPES[n] ?? "";
const ORIENTATIONS = ["", "port", "land", "square"] as const;
export const orientationName = (n: number) => ORIENTATIONS[n] ?? "";

/** Builds a ResConfig, ordering the qualifier the way Android orders folder qualifiers. */
export function makeConfig(p: ConfigParts): ResConfig {
  const parts: string[] = [];
  if (p.locale) parts.push(p.locale);
  if (p.layoutDir) parts.push(p.layoutDir);
  if (p.smallestWidthDp) parts.push(`sw${p.smallestWidthDp}dp`);
  if (p.widthDp) parts.push(`w${p.widthDp}dp`);
  if (p.heightDp) parts.push(`h${p.heightDp}dp`);
  if (p.round) parts.push(p.round);
  if (p.orientation) parts.push(p.orientation);
  if (p.uiType) parts.push(p.uiType);
  if (p.night) parts.push(p.night);
  if (p.density) parts.push(densityName(p.density));
  // aapt2 adds v4 to every density folder (densities arrived in API 4): noise, so it is dropped.
  if (p.sdk && !(p.sdk === 4 && p.density)) parts.push(`v${p.sdk}`);
  return { density: p.density, sdk: p.sdk, night: p.night === "night", locale: p.locale, qualifier: parts.join("-") };
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;
const ENTRY_FLAG_COMPLEX = 0x0001;
const ENTRY_FLAG_COMPACT = 0x0008;
const NO_ENTRY = 0xffffffff;
const MAX_CHUNKS = 400_000;

interface Package {
  typeStrings: StringPool | null;
  keyStrings: StringPool | null;
  typeIdOffset: number;
  /** Type id → offsets of its RES_TABLE_TYPE chunks, one per configuration. */
  types: Map<number, number[]>;
}

/** Two packed bytes of a language or region: two ASCII letters, or three 5-bit ones. */
function unpackCode(b0: number, b1: number, base: number): string {
  if (b0 & 0x80) {
    const first = b1 & 0x1f;
    const second = ((b1 & 0xe0) >> 5) | ((b0 & 0x03) << 3);
    const third = (b0 & 0x7c) >> 2;
    return String.fromCharCode(first + base, second + base, third + base);
  }
  if (!b0) return "";
  return b1 ? String.fromCharCode(b0, b1) : String.fromCharCode(b0);
}

/** Folder-style locale from its parts: "en-rUS", or "b+sr+Latn+RS" when there is a script or variant. */
export function folderLocale(language: string, region: string, script: string, variant: string): string {
  if (!language) return "";
  if (script || variant) return ["b", language, script, region, variant].filter(Boolean).join("+");
  return region ? `${language}-r${region}` : language;
}

export function parseArsc(bytes: Uint8Array): ResTable {
  const v = view(bytes);
  if (bytes.length < 12 || v.getUint16(0, true) !== RES_TABLE_TYPE) throw new AndroidBinaryError("not a resource table");
  const headerSize = v.getUint16(2, true);
  const total = Math.min(v.getUint32(4, true), bytes.length);
  if (headerSize < 12 || headerSize > total) throw new AndroidBinaryError("bad resource table header");

  let globalPool: StringPool | null = null;
  const packages = new Map<number, Package>();
  let chunks = 0;

  const readPool = (at: number, limit: number): StringPool | null => {
    if (at + 8 > limit || v.getUint16(at, true) !== RES_STRING_POOL_TYPE) return null;
    const size = v.getUint32(at + 4, true);
    if (at + size > limit) return null;
    try {
      return StringPool.parse(bytes, at, size);
    } catch {
      return null;
    }
  };

  const readPackage = (at: number, hsize: number, size: number) => {
    if (hsize < 284) throw new AndroidBinaryError("short package header");
    const id = v.getUint32(at + 8, true);
    if (packages.has(id)) return;
    const end = at + size;
    const typeStringsAt = v.getUint32(at + 268, true);
    const keyStringsAt = v.getUint32(at + 276, true);
    const pkg: Package = {
      typeStrings: typeStringsAt ? readPool(at + typeStringsAt, end) : null,
      keyStrings: keyStringsAt ? readPool(at + keyStringsAt, end) : null,
      typeIdOffset: hsize >= 288 ? v.getUint32(at + 284, true) : 0,
      types: new Map(),
    };
    let p = at + hsize;
    while (p + 8 <= end) {
      if (++chunks > MAX_CHUNKS) throw new AndroidBinaryError("too many chunks");
      const type = v.getUint16(p, true);
      const h = v.getUint16(p + 2, true);
      const s = v.getUint32(p + 4, true);
      if (s < 8 || h < 8 || h > s || p + s > end) throw new AndroidBinaryError("bad package chunk");
      if (type === RES_TABLE_TYPE_TYPE && h >= 20 + 4 && s >= h) {
        const typeId = bytes[p + 8];
        const list = pkg.types.get(typeId);
        if (list) list.push(p);
        else pkg.types.set(typeId, [p]);
      }
      p += s;
    }
    packages.set(id, pkg);
  };

  let pos = headerSize;
  while (pos + 8 <= total) {
    if (++chunks > MAX_CHUNKS) throw new AndroidBinaryError("too many chunks");
    const type = v.getUint16(pos, true);
    const hsize = v.getUint16(pos + 2, true);
    const size = v.getUint32(pos + 4, true);
    if (size < 8 || hsize < 8 || hsize > size || pos + size > total) throw new AndroidBinaryError("bad table chunk");
    if (type === RES_STRING_POOL_TYPE && !globalPool) globalPool = StringPool.parse(bytes, pos, size);
    else if (type === RES_TABLE_PACKAGE_TYPE) readPackage(pos, hsize, size);
    pos += size;
  }
  if (!globalPool) throw new AndroidBinaryError("no global string pool");
  const pool = globalPool;

  const configs = new Map<number, ResConfig>();
  const configAt = (chunk: number): ResConfig => {
    const cached = configs.get(chunk);
    if (cached) return cached;
    const c = chunk + 20;
    const chunkEnd = chunk + v.getUint32(chunk + 4, true);
    const csize = c + 4 <= chunkEnd ? v.getUint32(c, true) : 0;
    const has = (off: number, n: number) => off + n <= csize && c + off + n <= chunkEnd;
    const u8 = (off: number) => (has(off, 1) ? bytes[c + off] : 0);
    const u16 = (off: number) => (has(off, 2) ? v.getUint16(c + off, true) : 0);
    const text = (off: number, n: number) =>
      has(off, n) ? String.fromCharCode(...Array.from(bytes.subarray(c + off, c + off + n))).replace(/\0+$/, "") : "";
    const language = has(8, 2) ? unpackCode(bytes[c + 8], bytes[c + 9], 0x61) : "";
    const region = has(10, 2) ? unpackCode(bytes[c + 10], bytes[c + 11], 0x30) : "";
    const screenLayout = u8(28);
    const uiMode = u8(29);
    const round = u8(48) & 0x03;
    const config = makeConfig({
      locale: folderLocale(language, region, text(36, 4), text(40, 8)),
      layoutDir: (screenLayout & 0xc0) === 0x40 ? "ldltr" : (screenLayout & 0xc0) === 0x80 ? "ldrtl" : "",
      smallestWidthDp: u16(30),
      widthDp: u16(32),
      heightDp: u16(34),
      round: round === 2 ? "round" : round === 1 ? "notround" : "",
      orientation: orientationName(u8(12)),
      uiType: uiTypeName(uiMode & 0x0f),
      night: (uiMode & 0x30) === 0x20 ? "night" : (uiMode & 0x30) === 0x10 ? "notnight" : "",
      density: u16(14),
      sdk: u16(24),
    });
    configs.set(chunk, config);
    return config;
  };

  /** Offset of entry `index` in the type chunk at `chunk`, or -1 when this configuration lacks it. */
  const entryAt = (chunk: number, index: number): number => {
    const hsize = v.getUint16(chunk + 2, true);
    const size = v.getUint32(chunk + 4, true);
    const end = chunk + size;
    const flags = bytes[chunk + 9];
    const count = v.getUint32(chunk + 12, true);
    const entriesStart = v.getUint32(chunk + 16, true);
    const offsets = chunk + hsize;
    let offset = -1;
    if (flags & FLAG_SPARSE) {
      // Sorted {u16 index, u16 offset / 4} pairs.
      let lo = 0;
      let hi = Math.min(count, Math.floor((size - hsize) / 4)) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const at = v.getUint16(offsets + mid * 4, true);
        if (at === index) {
          offset = v.getUint16(offsets + mid * 4 + 2, true) * 4;
          break;
        }
        if (at < index) lo = mid + 1;
        else hi = mid - 1;
      }
    } else if (flags & FLAG_OFFSET16) {
      if (index >= count || offsets + index * 2 + 2 > end) return -1;
      const o = v.getUint16(offsets + index * 2, true);
      if (o !== 0xffff) offset = o * 4;
    } else {
      if (index >= count || offsets + index * 4 + 4 > end) return -1;
      const o = v.getUint32(offsets + index * 4, true);
      if (o !== NO_ENTRY) offset = o;
    }
    if (offset < 0) return -1;
    const at = chunk + entriesStart + offset;
    return at + 8 <= end ? at : -1;
  };

  return {
    lookup(id: number): ResEntry | null {
      const pkg = packages.get(id >>> 24);
      const chunkList = pkg?.types.get((id >>> 16) & 0xff);
      if (!pkg || !chunkList) return null;
      const index = id & 0xffff;
      let key = -1;
      const values: ResConfigValue[] = [];
      for (const chunk of chunkList) {
        const e = entryAt(chunk, index);
        if (e < 0) continue;
        const end = chunk + v.getUint32(chunk + 4, true);
        const flags = v.getUint16(e + 2, true);
        let value: ResValue | null;
        let entryKey: number;
        if (flags & ENTRY_FLAG_COMPACT) {
          // Compact entries (aapt2 --enable-compact-entries): key u16, type in the flags' high byte.
          entryKey = v.getUint16(e, true);
          value = { dataType: flags >>> 8, data: v.getUint32(e + 4, true) };
        } else {
          entryKey = v.getUint32(e + 4, true);
          const vp = e + v.getUint16(e, true);
          value = flags & ENTRY_FLAG_COMPLEX || vp + 8 > end ? null : { dataType: bytes[vp + 3], data: v.getUint32(vp + 4, true) };
        }
        if (value && value.dataType === TYPE_STRING) value.string = pool.get(value.data) ?? undefined;
        if (key < 0) key = entryKey;
        values.push({ config: configAt(chunk), value });
      }
      if (!values.length) return null;
      const typeId = (id >>> 16) & 0xff;
      const hex = `0x${(id >>> 0).toString(16).padStart(8, "0")}`;
      return {
        id,
        typeName: pkg.typeStrings?.get(typeId - 1 - pkg.typeIdOffset) ?? `type${typeId}`,
        entryName: pkg.keyStrings?.get(key) ?? hex,
        values,
      };
    },
  };
}
