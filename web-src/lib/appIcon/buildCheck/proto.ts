/**
 * The two protobuf formats inside an Android App Bundle (.aab), read into the same models as
 * their APK counterparts: aapt2's XmlNode (base/manifest/AndroidManifest.xml and every
 * base/res/**.xml) becomes the element tree axml.ts builds, and the ResourceTable in
 * base/resources.pb becomes the `ResTable` arsc.ts builds. android.ts then reads a bundle the
 * way it reads an APK.
 *
 * The reader is lenient on purpose. src/lib/aab2apk/ decodes these files strictly, because it
 * re-encodes them and must not drop anything; this only looks things up, so unknown fields are
 * skipped, and a value it cannot use reads as nothing. Field numbers are aapt2's Resources.proto,
 * Configuration.proto and Resources.proto's XmlNode messages.
 *
 * The table is indexed lazily: packages and types on open, a type's entries the first time one
 * of them is looked up, and an entry's values only when that entry is.
 */

import { AndroidBinaryError, MAX_DEPTH, TYPE_ATTRIBUTE, TYPE_INT_BOOLEAN, TYPE_REFERENCE, TYPE_STRING, view } from "./axml";
import type { ResValue, XmlAttribute, XmlElement } from "./axml";
import { folderLocale, makeConfig, orientationName, uiTypeName } from "./arsc";
import type { ResConfig, ResConfigValue, ResEntry, ResTable } from "./arsc";

const MAX_ELEMENTS = 100_000;
const utf8 = new TextDecoder("utf-8");

/**
 * Calls `visit` for each field of the message in b[start, end). `value` is the varint or fixed32
 * (as an unsigned 32-bit number) or, for length-delimited fields, 0 with [from, to) the payload.
 * Returning true stops the walk. Throws AndroidBinaryError on bytes that are not protobuf.
 */
function eachField(
  b: Uint8Array,
  start: number,
  end: number,
  visit: (field: number, wire: number, value: number, from: number, to: number) => boolean | void,
): void {
  const v = view(b);
  let p = start;
  while (p < end) {
    let key: number;
    [key, p] = varint(b, p, end);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 0) throw new AndroidBinaryError("protobuf field 0");
    let value = 0;
    let from = p;
    let to = p;
    if (wire === 0) {
      [value, p] = varint(b, p, end);
    } else if (wire === 1) {
      if (p + 8 > end) throw new AndroidBinaryError("short fixed64");
      value = v.getUint32(p, true);
      p += 8;
    } else if (wire === 2) {
      let len: number;
      [len, p] = varint(b, p, end);
      if (len > end - p) throw new AndroidBinaryError("protobuf field runs past its message");
      from = p;
      to = p + len;
      p = to;
    } else if (wire === 5) {
      if (p + 4 > end) throw new AndroidBinaryError("short fixed32");
      value = v.getUint32(p, true);
      p += 4;
    } else {
      throw new AndroidBinaryError(`protobuf wire type ${wire}`);
    }
    if (visit(field, wire, value, from, to)) return;
  }
}

/** A varint's low 32 bits, unsigned, and the offset after it. */
function varint(b: Uint8Array, p: number, end: number): [number, number] {
  let lo = 0;
  for (let i = 0; i < 10; i++) {
    if (p >= end) throw new AndroidBinaryError("truncated varint");
    const byte = b[p++];
    if (i < 5) lo |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [lo >>> 0, p];
  }
  throw new AndroidBinaryError("varint too long");
}

const text = (b: Uint8Array, from: number, to: number) => utf8.decode(b.subarray(from, to));

/** A message holding one uint32 at field 1 (PackageId, TypeId, EntryId). */
function idMessage(b: Uint8Array, from: number, to: number): number {
  let id = 0;
  eachField(b, from, to, (f, w, value) => {
    if (f === 1 && w === 0) id = value;
  });
  return id;
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────

/** pb.Item to a Res_value. The last oneof member present wins, as protobuf decoders do. */
function item(b: Uint8Array, from: number, to: number): ResValue | null {
  let out: ResValue | null = null;
  eachField(b, from, to, (f, w, _value, s, e) => {
    if (w !== 2) return;
    if (f === 1) {
      // Reference: type 0 = REFERENCE, 1 = ATTRIBUTE; id at field 2.
      let type = 0;
      let id = 0;
      eachField(b, s, e, (rf, rw, rv) => {
        if (rw !== 0) return;
        if (rf === 1) type = rv;
        else if (rf === 2) id = rv;
      });
      out = { dataType: type === 1 ? TYPE_ATTRIBUTE : TYPE_REFERENCE, data: id };
    } else if (f === 2 || f === 3 || f === 4 || f === 5) {
      // String, RawString and StyledString keep their text at field 1; FileReference its path.
      let s1 = "";
      eachField(b, s, e, (sf, sw, _sv, ss, se) => {
        if (sf === 1 && sw === 2) s1 = text(b, ss, se);
      });
      out = { dataType: TYPE_STRING, data: 0, string: s1 };
    } else if (f === 6) {
      out = { dataType: TYPE_INT_BOOLEAN, data: 0 };
    } else if (f === 7) {
      out = primitive(b, s, e);
    }
  });
  return out;
}

/** pb.Primitive field number → Res_value data type. */
const PRIMITIVE_TYPES: Record<number, number> = {
  1: 0x00, // null
  2: 0x00, // empty
  3: 0x04, // float
  4: 0x05, // dimension (deprecated float form)
  5: 0x06, // fraction (deprecated float form)
  6: 0x10, // int decimal
  7: 0x11, // int hex
  8: 0x12, // boolean
  9: 0x1c, // colour ARGB8
  10: 0x1d, // colour RGB8
  11: 0x1e, // colour ARGB4
  12: 0x1f, // colour RGB4
  13: 0x05, // dimension
  14: 0x06, // fraction
};

function primitive(b: Uint8Array, from: number, to: number): ResValue | null {
  let out: ResValue | null = null;
  eachField(b, from, to, (f, w, value) => {
    const type = PRIMITIVE_TYPES[f];
    if (type === undefined || (w !== 0 && w !== 5 && w !== 2)) return;
    if (f === 2) out = { dataType: type, data: 1 };
    else if (f === 8) out = { dataType: type, data: value ? 0xffffffff : 0 };
    else out = { dataType: type, data: w === 2 ? 0 : value };
  });
  return out;
}

// ── XML ──────────────────────────────────────────────────────────────────────────────────────

/** Parses a proto XmlNode into its root element. Throws AndroidBinaryError when it is not one. */
export function parseProtoXml(bytes: Uint8Array): XmlElement {
  const counter = { n: 0 };
  let root: XmlElement | null = null;
  eachField(bytes, 0, bytes.length, (f, w, _v, s, e) => {
    if (f === 1 && w === 2) {
      root = element(bytes, s, e, 0, counter);
      return true;
    }
  });
  if (!root) throw new AndroidBinaryError("no root element");
  return root;
}

function element(b: Uint8Array, from: number, to: number, depth: number, counter: { n: number }): XmlElement {
  if (++counter.n > MAX_ELEMENTS) throw new AndroidBinaryError("too many elements");
  const el: XmlElement = { ns: "", name: "", attributes: [], children: [] };
  eachField(b, from, to, (f, w, _v, s, e) => {
    if (w !== 2) return;
    if (f === 2) el.ns = text(b, s, e);
    else if (f === 3) el.name = text(b, s, e);
    else if (f === 4) el.attributes.push(attribute(b, s, e));
    else if (f === 5 && depth + 1 < MAX_DEPTH) {
      // A child XmlNode: an element at field 1, or text at field 2 (skipped).
      eachField(b, s, e, (cf, cw, _cv, cs, ce) => {
        if (cf === 1 && cw === 2) {
          el.children.push(element(b, cs, ce, depth + 1, counter));
          return true;
        }
      });
    }
  });
  return el;
}

function attribute(b: Uint8Array, from: number, to: number): XmlAttribute {
  const a: XmlAttribute = { ns: "", name: "", resId: 0, value: null };
  eachField(b, from, to, (f, w, value, s, e) => {
    if (f === 1 && w === 2) a.ns = text(b, s, e);
    else if (f === 2 && w === 2) a.name = text(b, s, e);
    else if (f === 3 && w === 2) a.raw = text(b, s, e);
    else if (f === 5 && w === 0) a.resId = value;
    else if (f === 6 && w === 2) a.value = item(b, s, e);
  });
  // Uncompiled attributes (package="…", plain strings) carry only their text.
  if (!a.value && a.raw !== undefined) a.value = { dataType: TYPE_STRING, data: 0, string: a.raw };
  return a;
}

// ── Resource table ───────────────────────────────────────────────────────────────────────────

interface ProtoType {
  name: string;
  from: number;
  to: number;
  /** Entry id → [from, to) of its Entry message, built on first lookup. */
  entries?: Map<number, [number, number]>;
}

/** Parses base/resources.pb. Throws AndroidBinaryError when it is not a resource table. */
export function parseProtoTable(bytes: Uint8Array): ResTable {
  const packages = new Map<number, Map<number, ProtoType>>();
  eachField(bytes, 0, bytes.length, (f, w, _v, s, e) => {
    if (f !== 2 || w !== 2) return;
    let id = 0;
    const typeRanges: [number, number][] = [];
    eachField(bytes, s, e, (pf, pw, _pv, ps, pe) => {
      if (pw !== 2) return;
      if (pf === 1) id = idMessage(bytes, ps, pe);
      else if (pf === 3) typeRanges.push([ps, pe]);
    });
    if (packages.has(id)) return;
    const types = new Map<number, ProtoType>();
    for (const [ts, te] of typeRanges) {
      let typeId = 0;
      let name = "";
      eachField(bytes, ts, te, (tf, tw, _tv, s2, e2) => {
        if (tw !== 2) return;
        if (tf === 1) typeId = idMessage(bytes, s2, e2);
        else if (tf === 2) name = text(bytes, s2, e2);
      });
      if (typeId && !types.has(typeId)) types.set(typeId, { name, from: ts, to: te });
    }
    packages.set(id, types);
  });
  if (!packages.size) throw new AndroidBinaryError("no resource package");

  const indexEntries = (t: ProtoType): Map<number, [number, number]> => {
    if (t.entries) return t.entries;
    const map = new Map<number, [number, number]>();
    eachField(bytes, t.from, t.to, (f, w, _v, s, e) => {
      if (f !== 3 || w !== 2) return;
      let id = 0;
      eachField(bytes, s, e, (ef, ew, _ev, es, ee) => {
        if (ef === 1 && ew === 2) {
          id = idMessage(bytes, es, ee);
          return true;
        }
      });
      if (!map.has(id)) map.set(id, [s, e]);
    });
    t.entries = map;
    return map;
  };

  return {
    lookup(id: number): ResEntry | null {
      const type = packages.get(id >>> 24)?.get((id >>> 16) & 0xff);
      if (!type) return null;
      let range: [number, number] | undefined;
      try {
        range = indexEntries(type).get(id & 0xffff);
      } catch {
        return null;
      }
      if (!range) return null;
      let entryName = "";
      const values: ResConfigValue[] = [];
      try {
        eachField(bytes, range[0], range[1], (f, w, _v, s, e) => {
          if (w !== 2) return;
          if (f === 2) entryName = text(bytes, s, e);
          else if (f === 6) values.push(configValue(bytes, s, e));
        });
      } catch {
        return null;
      }
      if (!values.length) return null;
      return {
        id,
        typeName: type.name || `type${(id >>> 16) & 0xff}`,
        entryName: entryName || `0x${(id >>> 0).toString(16).padStart(8, "0")}`,
        values,
      };
    },
  };
}

function configValue(b: Uint8Array, from: number, to: number): ResConfigValue {
  let config: ResConfig | null = null;
  let value: ResValue | null = null;
  eachField(b, from, to, (f, w, _v, s, e) => {
    if (w !== 2) return;
    if (f === 1) config = configuration(b, s, e);
    else if (f === 2) {
      // pb.Value: an Item at field 4, or a CompoundValue (style, array, …) at field 5.
      eachField(b, s, e, (vf, vw, _vv, vs, ve) => {
        if (vf === 4 && vw === 2) value = item(b, vs, ve);
        else if (vf === 5 && vw === 2) value = null;
      });
    }
  });
  return { config: config ?? configuration(b, 0, 0), value };
}

/** pb.Configuration: only the fields icon folders use; the enums follow Configuration.proto. */
function configuration(b: Uint8Array, from: number, to: number): ResConfig {
  let locale = "";
  let layoutDir = 0;
  let widthDp = 0;
  let heightDp = 0;
  let smallestWidthDp = 0;
  let round = 0;
  let orientation = 0;
  let uiType = 0;
  let night = 0;
  let density = 0;
  let sdk = 0;
  eachField(b, from, to, (f, w, value, s, e) => {
    if (f === 3 && w === 2) locale = text(b, s, e);
    if (w !== 0) return;
    if (f === 4) layoutDir = value;
    else if (f === 7) widthDp = value;
    else if (f === 8) heightDp = value;
    else if (f === 9) smallestWidthDp = value;
    else if (f === 12) round = value;
    else if (f === 15) orientation = value;
    else if (f === 16) uiType = value;
    else if (f === 17) night = value;
    else if (f === 18) density = value;
    else if (f === 24) sdk = value;
  });
  return makeConfig({
    locale: bcp47ToFolder(locale),
    layoutDir: layoutDir === 1 ? "ldltr" : layoutDir === 2 ? "ldrtl" : "",
    smallestWidthDp,
    widthDp,
    heightDp,
    // Configuration.proto: SCREEN_ROUND_ROUND = 1, SCREEN_ROUND_NOTROUND = 2.
    round: round === 1 ? "round" : round === 2 ? "notround" : "",
    orientation: orientationName(orientation),
    uiType: uiTypeName(uiType),
    // UI_MODE_NIGHT_NIGHT = 1, UI_MODE_NIGHT_NOTNIGHT = 2.
    night: night === 1 ? "night" : night === 2 ? "notnight" : "",
    density,
    sdk,
  });
}

/** "en-US" → "en-rUS"; "sr-Latn-RS" → "b+sr+Latn+RS". */
function bcp47ToFolder(tag: string): string {
  if (!tag) return "";
  const parts = tag.split("-");
  const language = parts[0].toLowerCase();
  let region = "";
  let script = "";
  let variant = "";
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(part) && !script && !region) script = part[0].toUpperCase() + part.slice(1).toLowerCase();
    else if (/^([A-Za-z]{2}|\d{3})$/.test(part) && !region) region = part.toUpperCase();
    else variant = part;
  }
  return folderLocale(language, region, script, variant);
}
