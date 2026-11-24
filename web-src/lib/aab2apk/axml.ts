/**
 * Proto XML (pb.XmlNode, as stored in an .aab) -> binary XML, a port of aapt2
 * format/proto/ProtoDeserialize.cpp DeserializeXmlFromPb and
 * format/binary/XmlFlattener.cpp with `aapt2 convert` options (keep_raw_values
 * off; UTF-16 pool for the manifest, UTF-8 for res/ files).
 * Copyright (C) 2015 The Android Open Source Project.
 * Licensed under the Apache License, Version 2.0.
 */

import { ByteWriter, startChunk } from "./bytes";
import { PbMessage } from "./pb";
import { decodePrimitive, decodeReference, ResourcesUnsupported, strict, TYPE_INT_BOOLEAN, TYPE_STRING } from "./resourcesProto";
import type { ResItem } from "./resourcesProto";
import { compareCodePoints, StringPool } from "./stringPool";
import type { PoolRef } from "./stringPool";

export const ANDROID_NS = "http://schemas.android.com/apk/res/android";
export const TOOLS_NS = "http://schemas.android.com/tools";
export const DIST_NS = "http://schemas.android.com/apk/distribution";

const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const LOW_PRIORITY = 0xffffffff;
const ID_ATTR = 0x010100d0;

export interface XNamespace {
  prefix: string;
  uri: string;
  line: number;
}

/** A compiled attribute value: a plain string, or a flattened Res_value. */
export type XCompiled = { text: string } | { item: ResItem };

export interface XAttribute {
  ns: string;
  name: string;
  value: string;
  /** Attribute resource id, 0 when not compiled. */
  resourceId: number;
  compiled: XCompiled | null;
}

export interface XText {
  kind: "text";
  text: string;
  line: number;
}

export interface XElement {
  kind: "element";
  ns: string;
  name: string;
  line: number;
  namespaces: XNamespace[];
  attributes: XAttribute[];
  children: (XElement | XText)[];
}

function line(m: PbMessage | null): number {
  if (!m) return 0;
  m.expectOnly("SourcePosition", [1, 2]);
  return m.uint(1);
}

function decodeCompiled(m: PbMessage): XCompiled {
  m.expectOnly("Item", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  if (m.uint(8) !== 0 || m.str(10) !== "" || m.bool(9)) throw new ResourcesUnsupported("flagged XML value");
  const kinds = m.fields.filter((f) => f.n <= 7);
  if (kinds.length === 0) throw new ResourcesUnsupported("empty XML value");
  const which = kinds[kinds.length - 1].n;
  const body = m.msg(which) as PbMessage;
  switch (which) {
    case 1:
      return { item: decodeReference(body).item };
    case 2:
      body.expectOnly("String", [1]);
      return { text: body.str(1) };
    case 6:
      body.expectOnly("Id", []);
      return { item: { dataType: TYPE_INT_BOOLEAN, data: 0 } };
    case 7:
      return { item: decodePrimitive(body) };
    default:
      // Raw, styled and file values never appear on attributes aapt2 compiles.
      throw new ResourcesUnsupported(`XML attribute value kind ${which}`);
  }
}

function decodeElement(node: PbMessage): XElement {
  node.expectOnly("XmlNode", [1, 2, 3]);
  const el = node.msg(1);
  if (!el) throw new ResourcesUnsupported("XML node is not an element");
  el.expectOnly("XmlElement", [1, 2, 3, 4, 5]);
  const out: XElement = {
    kind: "element",
    ns: el.str(2),
    name: el.str(3),
    line: line(node.msg(3)),
    namespaces: el.msgs(1).map((n) => {
      n.expectOnly("XmlNamespace", [1, 2, 3]);
      return { prefix: n.str(1), uri: n.str(2), line: line(n.msg(3)) };
    }),
    attributes: el.msgs(4).map((a) => {
      a.expectOnly("XmlAttribute", [1, 2, 3, 4, 5, 6]);
      line(a.msg(4));
      const item = a.msg(6);
      return {
        ns: a.str(1),
        name: a.str(2),
        value: a.str(3),
        resourceId: a.uint(5),
        compiled: item ? decodeCompiled(item) : null,
      };
    }),
    children: [],
  };
  for (const child of el.msgs(5)) {
    child.expectOnly("XmlNode", [1, 2, 3]);
    if (child.has(1)) {
      out.children.push(decodeElement(child));
    } else if (child.has(2)) {
      out.children.push({ kind: "text", text: child.str(2), line: line(child.msg(3)) });
    } else {
      throw new ResourcesUnsupported("empty XML node");
    }
  }
  return out;
}

/** Decode a proto XML file. Throws ResourcesUnsupported on anything unexpected. */
export function decodeXml(buf: Uint8Array): XElement {
  return strict(() => decodeElement(new PbMessage(buf)));
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
}

function trimWhitespace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s[a])) a++;
  while (b > a && isSpace(s[b - 1])) b--;
  return s.slice(a, b);
}

/** ResourceUtils::StringBuilder(preserve_spaces=true).AppendText: backslash escapes only. */
export function processEscapes(text: string): string {
  const cps = Array.from(text);
  let out = "";
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    if (i + 1 >= cps.length) continue;
    const n = cps[++i];
    if (n === "t") out += "\t";
    else if (n === "n") out += "\n";
    else if (n === "u") {
      let code = 0;
      for (let k = 0; k < 4 && i + 1 < cps.length; k++) {
        const h = cps[++i];
        const v = /^[0-9a-fA-F]$/.test(h) ? parseInt(h, 16) : -1;
        if (v < 0) throw new ResourcesUnsupported("invalid unicode escape in XML attribute");
        code = (code << 4) | v;
      }
      if (code >= 0xd800 && code <= 0xdfff) throw new ResourcesUnsupported("invalid unicode escape in XML attribute");
      out += String.fromCodePoint(code);
    } else out += n;
  }
  return out;
}

/** cmp_xml_attribute_by_id: compiled ids first in id order, then namespace and name. */
function compareAttributes(a: XAttribute, b: XAttribute): number {
  if (a.resourceId) {
    if (b.resourceId) return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
    return -1;
  }
  if (b.resourceId) return 1;
  return compareCodePoints(a.ns, b.ns) || compareCodePoints(a.name, b.name);
}

class Flattener {
  readonly pool = new StringPool();
  readonly w = new ByteWriter(4096);
  private readonly fixups: { at: number; ref: PoolRef }[] = [];

  str(at: number, s: string, priority = LOW_PRIORITY, emptyAsNull = false): void {
    if (emptyAsNull && s === "") {
      this.w.setU32(at, 0xffffffff);
      return;
    }
    this.fixups.push({ at, ref: this.pool.ref(s, priority) });
  }

  node(type: number, lineNumber: number, extSize: number): { at: number; finish: () => void } {
    const c = startChunk(this.w, type, 16);
    this.w.setU32(c.start + 8, lineNumber);
    this.w.setU32(c.start + 12, 0xffffffff);
    const at = this.w.length;
    this.w.zeros(extSize);
    return { at, finish: c.finish };
  }

  namespace(ns: XNamespace, type: number): void {
    const n = this.node(type, ns.line, 8);
    this.str(n.at, ns.prefix);
    this.str(n.at + 4, ns.uri);
    n.finish();
  }

  text(t: XText): void {
    let text = trimWhitespace(t.text);
    if (text === "") return;
    if (isSpace(t.text[0])) text = " " + text;
    if (isSpace(t.text[t.text.length - 1])) text += " ";
    const n = this.node(RES_XML_CDATA_TYPE, t.line, 12);
    this.str(n.at, text);
    n.finish();
  }

  element(el: XElement): void {
    const namespaces = el.namespaces.filter((d) => d.uri !== TOOLS_NS);
    for (const d of namespaces) this.namespace(d, RES_XML_START_NAMESPACE_TYPE);

    const start = this.node(RES_XML_START_ELEMENT_TYPE, el.line, 20);
    const w = this.w;
    this.str(start.at, el.ns, LOW_PRIORITY, true);
    this.str(start.at + 4, el.name, LOW_PRIORITY, true);
    w.setU16(start.at + 8, 20);
    w.setU16(start.at + 10, 20);
    const attrs = el.attributes.filter((a) => a.ns !== TOOLS_NS).sort(compareAttributes);
    w.setU16(start.at + 12, attrs.length);
    let index = 1;
    for (const a of attrs) {
      if (a.resourceId === ID_ATTR) w.setU16(start.at + 14, index);
      else if (a.ns === "") {
        if (a.name === "class") w.setU16(start.at + 16, index);
        else if (a.name === "style") w.setU16(start.at + 18, index);
      }
      index++;
      const at = w.length;
      w.zeros(20);
      this.str(at, a.ns, LOW_PRIORITY, true);
      w.setU32(at + 8, 0xffffffff);
      // Attribute names with an id go in the id-sorted head of the pool.
      this.str(at + 4, a.name, a.resourceId ? a.resourceId : LOW_PRIORITY);
      let text: string | null = null;
      if (a.compiled) {
        if ("text" in a.compiled) text = a.compiled.text;
        else {
          w.setU8(at + 15, a.compiled.item.dataType);
          w.setU32(at + 16, a.compiled.item.data >>> 0);
        }
      } else {
        text = processEscapes(a.value);
      }
      if (text !== null) {
        w.setU8(at + 15, TYPE_STRING);
        this.str(at + 16, text);
        this.str(at + 8, text);
      }
      w.setU16(at + 12, 8);
    }
    start.finish();

    for (const child of el.children) {
      if (child.kind === "element") this.element(child);
      else this.text(child);
    }

    const end = this.node(RES_XML_END_ELEMENT_TYPE, el.line, 8);
    this.str(end.at, el.ns, LOW_PRIORITY, true);
    this.str(end.at + 4, el.name);
    end.finish();

    for (let i = namespaces.length - 1; i >= 0; i--) this.namespace(namespaces[i], RES_XML_END_NAMESPACE_TYPE);
  }

  finish(utf16: boolean): Uint8Array {
    this.pool.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0));
    for (const f of this.fixups) this.w.setU32(f.at, f.ref.index);
    const out = new ByteWriter(this.w.length + 4096);
    const header = startChunk(out, RES_XML_TYPE, 8);
    this.pool.flatten(out, !utf16);
    const map = startChunk(out, RES_XML_RESOURCE_MAP_TYPE, 8);
    for (const s of this.pool.stringEntries()) {
      const id = s.context.priority >>> 0;
      if (id === LOW_PRIORITY || (id & 0x00ff0000) === 0) break; // ResourceId::is_valid
      out.u32(id);
    }
    map.finish();
    out.bytes(this.w.toBytes());
    header.finish();
    return out.toBytes();
  }
}

/** Flatten an XML tree to binary XML. `utf16` is true for AndroidManifest.xml. */
export function flattenXml(root: XElement, utf16: boolean): Uint8Array {
  const f = new Flattener();
  f.element(root);
  return f.finish(utf16);
}
