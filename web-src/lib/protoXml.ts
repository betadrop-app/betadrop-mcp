// ──────────────────────────────────────────────────────────────────────────
// Minimal protobuf wire-format reader, and the aapt2 "proto XML" decoder built
// on it. 100% client-side, no dependencies.
//
// WHY THIS EXISTS
//
// An .aab stores AndroidManifest.xml as PROTOBUF, not as the binary XML (AXML)
// an .apk uses — aapt2 emits the compiled `XmlNode` message from Android's
// Resources.proto. So none of `apkAnalyzer.ts`'s AXML machinery applies, and a
// protobuf library would be a dependency added to every page in the bundle to
// decode one message shape. The wire format is small enough to read directly.
//
// HOW MUCH OF THE SCHEMA THIS KNOWS
//
// Deliberately very little, and tolerantly. The decoder relies only on the
// field numbers that carry NAMES and VALUES, as aapt2's Resources.proto
// (frameworks/base/tools/aapt2/Resources.proto) defines them:
//
//   XmlNode      { XmlElement element = 1; string text = 2; }
//   XmlElement   { ... string namespace_uri = 2; string name = 3;
//                  repeated XmlAttribute attribute = 4;
//                  repeated XmlNode child = 5; }
//   XmlAttribute { string namespace_uri = 1; string name = 2;
//                  string value = 3; SourcePosition source = 4;
//                  uint32 resource_id = 5; Item compiled_item = 6; }
//
// This table once had resource_id = 4 and compiled_item = 5, so the decoder
// looked for the compiled value in resource_id's slot and never found it.
//
// Numeric attributes (versionCode, minSdkVersion, a boolean like `debuggable`)
// are the awkward case. Gradle's `aapt2 link --proto-format` keeps the source
// text in `value` beside `compiled_item`, so the string is normally there. A
// manifest that went through binary XML first has lost it: an APK turned into
// a bundle with `aapt2 convert --output-format proto` has an empty `value` and
// the number only in `compiled_item`, whose inner `Primitive` assigns a
// DIFFERENT field number per primitive type. Rather than hardcode that table,
// `scalarFromCompiledItem` walks the submessage and returns the first varint
// or fixed32 it finds at any depth.
//
// That is deliberately loose, and safe here because of WHERE it is used: it is
// only consulted for an attribute whose string value is absent, and the ones
// this tool reads are numbers and booleans. A wrong guess (a `@integer/…`
// reference yields its resource ID) is a wrong number, never a crash and never
// a wrong package name — and the caller marks such values as
// decoded-from-compiled so the UI can distinguish them.
// ──────────────────────────────────────────────────────────────────────────

/** A decoded proto-XML element. Attribute lookup is by local name, namespace ignored. */
export interface ProtoXmlElement {
  name: string;
  /** Local attribute name → its string value (or the stringified compiled scalar). */
  attrs: Record<string, string>;
  /** Attribute names whose value came from `compiled_item` rather than a literal string. */
  compiledAttrs: Set<string>;
  children: ProtoXmlElement[];
}

/** Wire types. Only 0, 1, 2 and 5 exist; 3 and 4 are the deprecated groups. */
const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

/**
 * A cursor over a protobuf buffer.
 *
 * Fields are declared and assigned rather than written as constructor parameter
 * properties, because those need a TypeScript *transform* while everything else
 * here only needs types stripped — and keeping the module strippable is what
 * lets `scripts/verify-proto-xml.mjs` run the real decoder under plain node,
 * with no build step between the source and the thing being tested.
 */
class Reader {
  private readonly buf: Uint8Array;
  public pos: number;
  public readonly end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /**
   * Base-128 varint.
   *
   * Capped at 10 bytes — the maximum a 64-bit varint can occupy. Without the
   * cap, a buffer of 0x80 bytes (every byte with the continuation bit set)
   * spins until the end of the file, which is exactly what a corrupt or
   * non-protobuf input looks like.
   */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10 && this.pos < this.end; i++) {
      const byte = this.buf[this.pos++];
      // `2 ** shift` rather than `<< shift`: JS bitwise operators coerce to
      // int32, so a field past 2^31 (a large versionCode is plausible) would
      // silently go negative.
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error("malformed varint");
  }

  bytes(len: number): Uint8Array {
    if (len < 0 || this.pos + len > this.end) throw new Error("length out of range");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  fixed32(): number {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  /**
   * The next `(fieldNumber, wireType)` pair, or null at the end.
   *
   * A method rather than a generator because `tsconfig.json` sets no `target`,
   * so tsc type-checks at ES5 where iterating a generator needs
   * `downlevelIteration`. Nothing else in this repo iterates one, so the choice
   * is between turning a compiler flag on for every file or not needing it
   * here — and the loop reads no worse.
   */
  nextTag(): [number, number] | null {
    if (this.done) return null;
    const tag = this.varint();
    // Field 0 is not legal; treat it as the end rather than looping on padding.
    if (tag === 0) return null;
    return [tag >>> 3, tag & 0x07];
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        break;
      case WIRE_64BIT:
        this.bytes(8);
        break;
      case WIRE_LEN:
        this.bytes(this.varint());
        break;
      case WIRE_32BIT:
        this.bytes(4);
        break;
      default:
        // Groups (3/4) were removed from proto3 and aapt2 never emits them.
        throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/**
 * The first varint or fixed32 anywhere inside a `compiled_item`, at any depth.
 *
 * See the header note: this trades exactness for not hardcoding Primitive's
 * per-type field numbers. Returns `undefined` when the submessage carries no
 * scalar at all (a string-valued Item, say).
 */
function scalarFromCompiledItem(buf: Uint8Array, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  const r = new Reader(buf);
  try {
    let t: [number, number] | null;
    while ((t = r.nextTag())) {
      const wire = t[1];
      if (wire === WIRE_VARINT) return r.varint();
      if (wire === WIRE_32BIT) return r.fixed32();
      if (wire === WIRE_LEN) {
        const nested = r.bytes(r.varint());
        const found = scalarFromCompiledItem(nested, depth + 1);
        if (found !== undefined) return found;
      } else {
        r.skip(wire);
      }
    }
  } catch {
    // A submessage that does not parse is not fatal: the attribute simply has
    // no readable compiled value, which the caller reports as absent.
    return undefined;
  }
  return undefined;
}

/** The local part of a possibly-namespaced name. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Decode one `XmlAttribute` message. */
function decodeAttribute(buf: Uint8Array): { name: string; value: string; compiled: boolean } | null {
  const r = new Reader(buf);
  let name = "";
  let value: string | undefined;
  let compiled: number | undefined;

  let t: [number, number] | null;
  while ((t = r.nextTag())) {
    const [field, wire] = t;
    if (wire === WIRE_LEN) {
      const data = r.bytes(r.varint());
      if (field === 2) name = utf8.decode(data);
      else if (field === 3) value = utf8.decode(data);
      else if (field === 6) compiled = scalarFromCompiledItem(data);
      // field 1 is namespace_uri and 4 is source, both ignored. resource_id
      // (5) is a varint, so it takes the skip below.
    } else {
      r.skip(wire);
    }
  }

  if (!name) return null;
  if (value !== undefined && value !== "") {
    return { name: localName(name), value, compiled: false };
  }
  if (compiled !== undefined) {
    return { name: localName(name), value: String(compiled), compiled: true };
  }
  // An attribute that is genuinely the empty string still exists and callers
  // may test for its presence, so report it rather than dropping it.
  return { name: localName(name), value: "", compiled: false };
}

/** Decode one `XmlElement` message. */
function decodeElement(buf: Uint8Array): ProtoXmlElement {
  const r = new Reader(buf);
  const el: ProtoXmlElement = {
    name: "",
    attrs: {},
    compiledAttrs: new Set(),
    children: [],
  };

  let t: [number, number] | null;
  while ((t = r.nextTag())) {
    const [field, wire] = t;
    if (wire !== WIRE_LEN) {
      r.skip(wire);
      continue;
    }
    const data = r.bytes(r.varint());
    if (field === 3) {
      el.name = localName(utf8.decode(data));
    } else if (field === 4) {
      const attr = decodeAttribute(data);
      if (attr) {
        el.attrs[attr.name] = attr.value;
        if (attr.compiled) el.compiledAttrs.add(attr.name);
      }
    } else if (field === 5) {
      const child = decodeNode(data);
      if (child) el.children.push(child);
    }
    // field 1 is namespace_declaration, 2 is namespace_uri — neither is needed
    // because attributes are looked up by local name.
  }

  return el;
}

/** Decode one `XmlNode`. Returns null for a text node, which carries no element. */
function decodeNode(buf: Uint8Array): ProtoXmlElement | null {
  const r = new Reader(buf);
  let t: [number, number] | null;
  while ((t = r.nextTag())) {
    const [field, wire] = t;
    if (wire === WIRE_LEN) {
      const data = r.bytes(r.varint());
      if (field === 1) return decodeElement(data);
      // field 2 is a text node; field 3 is source position.
    } else {
      r.skip(wire);
    }
  }
  return null;
}

/**
 * Decode a protobuf-encoded AndroidManifest.xml into its root element.
 *
 * Throws when the bytes are not a decodable `XmlNode` — which is how the caller
 * distinguishes an .aab manifest from the AXML an .apk would carry, since the
 * two share a filename and nothing else.
 */
export function parseProtoXml(bytes: Uint8Array): ProtoXmlElement {
  // AXML starts with the 0x00080003 chunk header. Recognising it here turns
  // "someone renamed an .apk to .aab" into a clear message instead of a
  // confusing parse failure deep in the wire reader.
  if (bytes.length >= 4 && bytes[0] === 0x03 && bytes[1] === 0x00 && bytes[2] === 0x08) {
    throw new Error(
      "This manifest is Android binary XML, not protobuf — the file looks like an .apk rather than an .aab.",
    );
  }
  const root = decodeNode(bytes);
  if (!root || !root.name) throw new Error("Manifest did not decode as a protobuf XmlNode.");
  return root;
}

/** Depth-first list of an element and all its descendants. */
export function walk(el: ProtoXmlElement, into: ProtoXmlElement[] = []): ProtoXmlElement[] {
  into.push(el);
  for (const child of el.children) walk(child, into);
  return into;
}

/** Every descendant with the given tag name. */
export function findAll(root: ProtoXmlElement, name: string): ProtoXmlElement[] {
  return walk(root).filter((el) => el.name === name);
}
