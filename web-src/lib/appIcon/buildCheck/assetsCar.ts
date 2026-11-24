/**
 * Assets.car, the compiled asset catalog in an iOS app, read far enough to say which app icon
 * sets it holds and what each has: the pixel sizes, the device idioms, and the appearances (the
 * iOS 18 dark and tinted icons).
 *
 * The catalog is a BOM file (bom.ts) holding, among others:
 *   FACETKEYS       asset name ("AppIcon") to its attributes; attribute 17 is its identifier.
 *   APPEARANCEKEYS  appearance name ("UIAppearanceDark") to its numeric id. The ids are assigned
 *                   per file, so they are always read from here, never assumed.
 *   KEYFORMAT       the attribute order of every rendition key ('tmfk', then u32 attribute ids).
 *   RENDITIONS      rendition key (one u16 per KEYFORMAT attribute) to a CSI header ('ISTC'):
 *                   width @12, height @16, scale × 100 @20, layout u16 @36, name[128] @40.
 * All of it little-endian. Attribute ids: 7 appearance, 12 scale, 15 idiom, 17 identifier.
 *
 * An app icon set compiles to one multisize-set rendition (layout 0x3f2, 0 × 0) plus one rendition
 * per image; images may be packed into shared atlases (layout 0x3ec, identifier 0) that the icon's
 * own renditions (0x3eb) point into, still with their own size in the header. An Icon Composer
 * icon (Xcode 26) adds its layer stack (layout 0x3fb, "AppIcon.iconstack") per appearance, beside
 * flat 1024 px images for older iOS. The pixels are LZFSE-compressed and are not decoded here, so
 * nothing can be said about opacity: the check does not claim to.
 *
 * EXTENDED_METADATA ('META') holds the thinning arguments at offset 4: empty for a normal build,
 * "optimized <idiom 1> <scale 3> …" when the catalog was thinned for one device.
 *
 * Checked against `xcrun assetutil --info` on catalogs compiled by Xcode 27.2's actool.
 */

import { readBom } from "./bom";

export class CarError extends Error {}

export interface CarRendition {
  identifier: number;
  appearance: number;
  idiom: number;
  /** Scale (1, 2, 3): from the key, else from the rendition header; 0 when neither says. */
  scale: number;
  width: number;
  height: number;
  layout: number;
  /** The source file name the rendition was compiled from, e.g. "AppIcon-1024.png". */
  name: string;
}

export interface CarCatalog {
  /** Asset name to identifier. */
  facets: Map<string, number>;
  /** Appearance id to name; empty when the catalog has no appearances (id 0 is the default). */
  appearances: Map<number, string>;
  /** Renditions of the app icon sets and of any identifier asked for. */
  renditions: CarRendition[];
  /** Identifiers that are app icon sets (they own a multisize-set rendition). */
  iconSets: Set<number>;
  /** The thinning arguments; "" when the catalog was not thinned. */
  thinning: string;
}

const ATTR_APPEARANCE = 7;
const ATTR_SCALE = 12;
const ATTR_IDIOM = 15;
const ATTR_IDENTIFIER = 17;

export const LAYOUT_MULTISIZE_SET = 0x3f2;
export const LAYOUT_PACKED_ATLAS = 0x3ec;
/** An Icon Composer layer stack. */
export const LAYOUT_ICON_STACK = 0x3fb;

const CSI_HEADER = 168;
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...Array.from(b.subarray(at, at + n)));
const le = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Device idiom names, as an asset catalog's Contents.json spells them. */
export const IDIOMS: Record<number, string> = {
  0: "universal",
  1: "iPhone",
  2: "iPad",
  3: "Apple TV",
  4: "CarPlay",
  5: "Apple Watch",
  6: "App Store",
  7: "Mac",
  8: "Apple Vision Pro",
};

/**
 * Reads the catalog. `wanted` are identifiers to keep renditions for even when they are not app
 * icon sets (the set Info.plist names, which might be a plain image set by mistake).
 */
export function readAssetsCar(bytes: Uint8Array, wanted: ReadonlySet<number> = new Set()): CarCatalog {
  let bom;
  try {
    bom = readBom(bytes);
  } catch (e) {
    throw new CarError(e instanceof Error ? e.message : "not a BOM file");
  }

  const strip = (b: Uint8Array) => {
    let end = b.length;
    while (end > 0 && b[end - 1] === 0) end--;
    return new TextDecoder("utf-8").decode(b.subarray(0, end));
  };

  try {
    // The key format: which attribute each u16 of a rendition key is.
    const kfId = bom.vars.get("KEYFORMAT");
    const kf = kfId === undefined ? null : bom.block(kfId);
    if (!kf || kf.length < 12 || ascii(kf, 0, 4) !== "tmfk") throw new CarError("no KEYFORMAT");
    const kfv = le(kf);
    const tokens = kfv.getUint32(8, true);
    if (tokens > 64 || 12 + tokens * 4 > kf.length) throw new CarError("bad KEYFORMAT");
    const slot = new Map<number, number>();
    for (let i = 0; i < tokens; i++) slot.set(kfv.getUint32(12 + i * 4, true), i);

    const facets = new Map<string, number>();
    for (const e of bom.tree("FACETKEYS") ?? []) {
      const fv = le(e.value);
      if (e.value.length < 6) continue;
      const n = fv.getUint16(4, true);
      for (let i = 0; i < n && 10 + i * 4 <= e.value.length; i++) {
        if (fv.getUint16(6 + i * 4, true) === ATTR_IDENTIFIER) facets.set(strip(e.key), fv.getUint16(8 + i * 4, true));
      }
    }

    const appearances = new Map<number, string>();
    for (const e of bom.tree("APPEARANCEKEYS") ?? []) {
      const av = le(e.value);
      if (e.value.length >= 2) appearances.set(e.value.length >= 4 ? av.getUint32(0, true) : av.getUint16(0, true), strip(e.key));
    }

    // 'META', then the thinning arguments as a C string in a 256-byte field.
    let thinning = "";
    const metaId = bom.vars.get("EXTENDED_METADATA");
    const meta = metaId === undefined ? null : bom.block(metaId);
    if (meta && meta.length >= 8 && ascii(meta, 0, 4) === "META") {
      const field = meta.subarray(4, Math.min(meta.length, 260));
      const nul = field.indexOf(0);
      thinning = new TextDecoder("utf-8").decode(nul < 0 ? field : field.subarray(0, nul)).trim();
    }

    const at = (key: DataView, attr: number) => {
      const i = slot.get(attr);
      return i === undefined || i * 2 + 2 > key.byteLength ? 0 : key.getUint16(i * 2, true);
    };

    // One pass over every rendition: keep the light fields, decide what to keep afterwards.
    const all: (CarRendition & { value: Uint8Array })[] = [];
    const iconSets = new Set<number>();
    for (const e of bom.tree("RENDITIONS") ?? []) {
      if (e.value.length < CSI_HEADER || ascii(e.value, 0, 4) !== "ISTC") continue;
      const k = le(e.key);
      const c = le(e.value);
      const r = {
        identifier: at(k, ATTR_IDENTIFIER),
        appearance: at(k, ATTR_APPEARANCE),
        idiom: at(k, ATTR_IDIOM),
        scale: at(k, ATTR_SCALE) || Math.round(c.getUint32(20, true) / 100),
        width: c.getUint32(12, true),
        height: c.getUint32(16, true),
        layout: c.getUint16(36, true),
        name: "",
        value: e.value,
      };
      if (r.layout === LAYOUT_MULTISIZE_SET && r.identifier) iconSets.add(r.identifier);
      all.push(r);
    }

    const renditions: CarRendition[] = [];
    for (const r of all) {
      if (!r.identifier || r.layout === LAYOUT_PACKED_ATLAS) continue;
      if (!iconSets.has(r.identifier) && !wanted.has(r.identifier)) continue;
      const { value, ...rest } = r;
      // A C string in a 128-byte field: whatever follows its NUL is not part of it.
      const field = value.subarray(40, CSI_HEADER);
      const nul = field.indexOf(0);
      renditions.push({ ...rest, name: new TextDecoder("utf-8").decode(nul < 0 ? field : field.subarray(0, nul)) });
    }
    return { facets, appearances, renditions, iconSets, thinning };
  } catch (e) {
    if (e instanceof CarError) throw e;
    throw new CarError(e instanceof Error ? e.message : "unreadable asset catalog");
  }
}
