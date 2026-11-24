/**
 * Android's binary XML (AXML): the format aapt2 writes AndroidManifest.xml and every res/**.xml
 * into an APK. It is read here into a small element tree, the same model proto.ts builds from a
 * bundle's protobuf XML, so android.ts reads a manifest or an adaptive icon one way for both.
 *
 * Each attribute keeps its attribute resource id from the file's resource map. That id, not the
 * name, is what Android itself matches on, and it survives manifest obfuscation that rewrites or
 * blanks the names; android.ts looks attributes up by id first for that reason.
 *
 * Every count and offset in the file is checked against the buffer before it is used, and the
 * string pool decodes one string at a time, on request: a hostile header claiming four billion
 * strings costs nothing until a string is actually asked for, and then only that one.
 */

export class AndroidBinaryError extends Error {}

export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

/** A Res_value: a data type (TYPE_* below) and its 32 bits; strings are resolved for TYPE_STRING. */
export interface ResValue {
  dataType: number;
  data: number;
  string?: string;
}

export interface XmlAttribute {
  ns: string;
  name: string;
  /** The attribute's resource id (0x0101xxxx for android:), 0 when the file does not map it. */
  resId: number;
  /** The attribute's text as written, when the file keeps it. */
  raw?: string;
  value: ResValue | null;
}

export interface XmlElement {
  ns: string;
  name: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
}

export const TYPE_NULL = 0x00;
export const TYPE_REFERENCE = 0x01;
export const TYPE_ATTRIBUTE = 0x02;
export const TYPE_STRING = 0x03;
export const TYPE_DYNAMIC_REFERENCE = 0x07;
export const TYPE_INT_DEC = 0x10;
export const TYPE_INT_HEX = 0x11;
export const TYPE_INT_BOOLEAN = 0x12;
export const TYPE_INT_COLOR_ARGB8 = 0x1c;
export const TYPE_INT_COLOR_RGB8 = 0x1d;
export const TYPE_INT_COLOR_ARGB4 = 0x1e;
export const TYPE_INT_COLOR_RGB4 = 0x1f;

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;

/** Bounds a hostile file cannot push past: real manifests have a few hundred elements. */
const MAX_CHUNKS = 400_000;
const MAX_ELEMENTS = 100_000;
export const MAX_DEPTH = 64;

export const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const utf8 = new TextDecoder("utf-8");
const utf16 = new TextDecoder("utf-16le");

/** A ResStringPool, decoded lazily: `get` reads one string and caches it. */
export class StringPool {
  private readonly cache = new Map<number, string | null>();
  private readonly bytes: Uint8Array;
  private readonly v: DataView;
  private readonly offsetsAt: number;
  private readonly dataAt: number;
  private readonly end: number;
  private readonly utf8: boolean;
  readonly count: number;

  // Plain fields rather than parameter properties: Node's type stripping (the tests) refuses those.
  private constructor(bytes: Uint8Array, offsetsAt: number, dataAt: number, end: number, utf8: boolean, count: number) {
    this.bytes = bytes;
    this.v = view(bytes);
    this.offsetsAt = offsetsAt;
    this.dataAt = dataAt;
    this.end = end;
    this.utf8 = utf8;
    this.count = count;
  }

  /** The pool whose chunk starts at `at` and is `size` bytes long. */
  static parse(bytes: Uint8Array, at: number, size: number): StringPool {
    const v = view(bytes);
    if (size < 28 || at + size > bytes.length || v.getUint16(at, true) !== RES_STRING_POOL_TYPE) {
      throw new AndroidBinaryError("bad string pool");
    }
    const headerSize = v.getUint16(at + 2, true);
    if (headerSize < 28 || headerSize > size) throw new AndroidBinaryError("bad string pool header");
    const declared = v.getUint32(at + 8, true);
    const flags = v.getUint32(at + 16, true);
    const stringsStart = v.getUint32(at + 20, true);
    // The offsets array has to fit in the chunk; a larger count is a lie, not a reason to loop.
    const fits = Math.floor((size - headerSize) / 4);
    const count = stringsStart > size ? 0 : Math.min(declared, fits);
    return new StringPool(bytes, at + headerSize, at + stringsStart, at + size, (flags & UTF8_FLAG) !== 0, count);
  }

  get(index: number): string | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return null;
    const hit = this.cache.get(index);
    if (hit !== undefined) return hit;
    const s = this.decode(index);
    this.cache.set(index, s);
    return s;
  }

  private decode(index: number): string | null {
    const b = this.bytes;
    const v = this.v;
    let p = this.dataAt + v.getUint32(this.offsetsAt + index * 4, true);
    const end = this.end;
    if (p < this.dataAt || p >= end) return null;
    if (this.utf8) {
      // Length in UTF-16 units (skipped), then length in bytes; each is one byte or two.
      if (b[p++] & 0x80) p++;
      if (p >= end) return null;
      let len = b[p++];
      if (len & 0x80) {
        if (p >= end) return null;
        len = ((len & 0x7f) << 8) | b[p++];
      }
      if (p + len > end) return null;
      return utf8.decode(b.subarray(p, p + len));
    }
    if (p + 2 > end) return null;
    let len = v.getUint16(p, true);
    p += 2;
    if (len & 0x8000) {
      if (p + 2 > end) return null;
      len = ((len & 0x7fff) << 16) | v.getUint16(p, true);
      p += 2;
    }
    if (p + len * 2 > end) return null;
    return utf16.decode(b.subarray(p, p + len * 2));
  }
}

/** Parses a binary XML file into its root element. Throws AndroidBinaryError when it is not one. */
export function parseAxml(bytes: Uint8Array): XmlElement {
  const v = view(bytes);
  if (bytes.length < 8 || v.getUint16(0, true) !== RES_XML_TYPE) throw new AndroidBinaryError("not binary XML");
  const headerSize = v.getUint16(2, true);
  const total = Math.min(v.getUint32(4, true), bytes.length);
  if (headerSize < 8 || headerSize > total) throw new AndroidBinaryError("bad binary XML header");

  let pool: StringPool | null = null;
  let mapAt = 0;
  let mapCount = 0;
  let root: XmlElement | null = null;
  // Elements past MAX_DEPTH are parsed for balance but not attached: null marks them.
  const stack: (XmlElement | null)[] = [];
  let elements = 0;

  const str = (i: number) => (i === NO_INDEX || !pool ? null : pool.get(i));

  let pos = headerSize;
  for (let chunks = 0; pos + 8 <= total; chunks++) {
    if (chunks >= MAX_CHUNKS) throw new AndroidBinaryError("too many chunks");
    const type = v.getUint16(pos, true);
    const hsize = v.getUint16(pos + 2, true);
    const size = v.getUint32(pos + 4, true);
    if (size < 8 || hsize < 8 || hsize > size || pos + size > total) throw new AndroidBinaryError("bad chunk");
    const end = pos + size;

    if (type === RES_STRING_POOL_TYPE) {
      if (!pool) pool = StringPool.parse(bytes, pos, size);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      mapAt = pos + hsize;
      mapCount = Math.floor((size - hsize) / 4);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (!pool) throw new AndroidBinaryError("element before the string pool");
      if (++elements > MAX_ELEMENTS) throw new AndroidBinaryError("too many elements");
      const ext = pos + hsize;
      if (ext + 20 > end) throw new AndroidBinaryError("short element");
      const el: XmlElement = {
        ns: str(v.getUint32(ext, true)) ?? "",
        name: str(v.getUint32(ext + 4, true)) ?? "",
        attributes: [],
        children: [],
      };
      const attrStart = v.getUint16(ext + 8, true);
      const attrSize = v.getUint16(ext + 10, true);
      const attrCount = v.getUint16(ext + 12, true);
      if (attrSize >= 20) {
        for (let i = 0; i < attrCount; i++) {
          const a = ext + attrStart + i * attrSize;
          if (a + 20 > end) break;
          const nameIndex = v.getUint32(a + 4, true);
          const rawIndex = v.getUint32(a + 8, true);
          const value: ResValue = { dataType: bytes[a + 15], data: v.getUint32(a + 16, true) };
          const raw = str(rawIndex) ?? undefined;
          if (value.dataType === TYPE_STRING) value.string = str(value.data) ?? raw;
          el.attributes.push({
            ns: str(v.getUint32(a, true)) ?? "",
            name: str(nameIndex) ?? "",
            resId: nameIndex < mapCount ? v.getUint32(mapAt + nameIndex * 4, true) : 0,
            raw,
            value,
          });
        }
      }
      const parent = stack.length ? stack[stack.length - 1] : undefined;
      if (stack.length === 0) {
        if (!root) root = el;
        stack.push(root === el ? el : null);
      } else if (parent && stack.length < MAX_DEPTH) {
        parent.children.push(el);
        stack.push(el);
      } else {
        stack.push(null);
      }
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      stack.pop();
    }
    pos = end;
  }
  if (!root) throw new AndroidBinaryError("no root element");
  return root;
}

/**
 * An android: attribute by its resource id, falling back to its name when the file does not map
 * ids. With `resId` 0 it finds a plain, unnamespaced attribute such as `package`.
 */
export function findAttribute(el: XmlElement, resId: number, name: string): XmlAttribute | undefined {
  if (resId) {
    const byId = el.attributes.find((a) => a.resId === resId);
    if (byId) return byId;
    return el.attributes.find((a) => a.resId === 0 && a.name === name && (a.ns === ANDROID_NS || a.ns === ""));
  }
  return el.attributes.find((a) => a.name === name && a.ns === "");
}
