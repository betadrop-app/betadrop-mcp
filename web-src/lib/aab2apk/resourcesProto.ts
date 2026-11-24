/**
 * Decoder for the aapt2 Resources.proto messages an .aab carries
 * (base/resources.pb and proto XML files), into the small model arsc.ts and
 * axml.ts flatten.
 *
 * Follows aapt2 format/proto/ProtoDeserialize.cpp: string values go into one
 * value pool in proto order with the same contexts aapt2 uses, so the later
 * sort produces the same pool. Anything this converter can't reproduce
 * exactly (overlayables, staged ids, dynamic references, feature flags,
 * macros, products, unknown proto fields) throws ResourcesUnsupported, which
 * becomes the "resources" refusal.
 * Copyright (C) 2017 The Android Open Source Project.
 * Licensed under the Apache License, Version 2.0.
 */

import { PbMessage, PbUnknownField } from "./pb";
import { ConfigError, configToBytes, DEFAULT_CONFIG } from "./config";
import { PRIORITY_HIGH, PRIORITY_NORMAL, StringPool } from "./stringPool";
import type { PoolRef } from "./stringPool";

export class ResourcesUnsupported extends Error {}

/** android::Res_value data types. */
export const TYPE_NULL = 0x00;
export const TYPE_REFERENCE = 0x01;
export const TYPE_ATTRIBUTE = 0x02;
export const TYPE_STRING = 0x03;
export const TYPE_FLOAT = 0x04;
export const TYPE_DIMENSION = 0x05;
export const TYPE_FRACTION = 0x06;
export const TYPE_INT_DEC = 0x10;
export const TYPE_INT_HEX = 0x11;
export const TYPE_INT_BOOLEAN = 0x12;
export const TYPE_INT_COLOR_ARGB8 = 0x1c;
export const TYPE_INT_COLOR_RGB8 = 0x1d;
export const TYPE_INT_COLOR_ARGB4 = 0x1e;
export const TYPE_INT_COLOR_RGB4 = 0x1f;

/** A flattened Res_value. String values carry a pool ref resolved after the pool is sorted. */
export interface ResItem {
  dataType: number;
  data: number;
  ref?: PoolRef;
}

export function itemData(item: ResItem): number {
  return item.ref ? item.ref.index : item.data >>> 0;
}

export interface MapPair {
  key: number;
  item: ResItem;
}

export type ResValueModel =
  | { kind: "item"; weak: boolean; item: ResItem; fileType?: number }
  | { kind: "map"; weak: boolean; parent: number; pairs: MapPair[] }
  | { kind: "skip" };

export interface ConfigValueModel {
  config: Uint8Array;
  value: ResValueModel;
}

export interface EntryModel {
  id: number;
  name: string;
  isPublic: boolean;
  values: ConfigValueModel[];
}

export interface TypeModel {
  id: number;
  name: string;
  entries: EntryModel[];
}

export interface TableModel {
  packageId: number;
  packageName: string;
  types: TypeModel[];
  pool: StringPool;
  /** Every FileReference in the table: path and pb FileReference.Type. */
  files: { path: string; type: number }[];
}

/** ResTable_map ids aapt2 uses as keys for attributes, arrays and plurals. */
const ATTR_TYPE = 0x01000000;
const ATTR_MIN = 0x01000001;
const ATTR_MAX = 0x01000002;
const ATTR_OTHER = 0x01000004;
const ATTR_ZERO = 0x01000005;

function unsupported(what: string): never {
  throw new ResourcesUnsupported(what);
}

/** Run a decoder and turn proto/config strictness errors into ResourcesUnsupported. */
export function strict<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PbUnknownField || e instanceof ConfigError) throw new ResourcesUnsupported(e.message);
    throw e;
  }
}

/** pb.Reference -> Res_value (Reference::Flatten). */
export function decodeReference(m: PbMessage): { item: ResItem; id: number } {
  m.expectOnly("Reference", [1, 2, 3, 4, 5, 6, 7]);
  const isDynamic = m.msg(5)?.expectOnly("Boolean", [1]).bool(1) ?? false;
  if (isDynamic) unsupported("dynamic reference");
  const id = m.uint(2);
  const type = m.uint(1);
  if (type > 1) unsupported(`reference type ${type}`);
  return { item: { dataType: type === 1 ? TYPE_ATTRIBUTE : TYPE_REFERENCE, data: id }, id };
}

function f32bits(m: PbMessage, n: number): number {
  return m.fixed32(n);
}

export function decodePrimitive(m: PbMessage): ResItem {
  m.expectOnly("Primitive", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const set = m.fields.map((f) => f.n);
  const which = set.length ? set[set.length - 1] : 0;
  switch (which) {
    case 1:
      return { dataType: TYPE_NULL, data: 0 }; // DATA_NULL_UNDEFINED
    case 2:
      return { dataType: TYPE_NULL, data: 1 }; // DATA_NULL_EMPTY
    case 3:
      return { dataType: TYPE_FLOAT, data: f32bits(m, 3) };
    case 13:
      return { dataType: TYPE_DIMENSION, data: m.uint(13) };
    case 14:
      return { dataType: TYPE_FRACTION, data: m.uint(14) };
    case 6:
      return { dataType: TYPE_INT_DEC, data: m.int32(6) >>> 0 };
    case 7:
      return { dataType: TYPE_INT_HEX, data: m.uint(7) };
    case 8:
      return { dataType: TYPE_INT_BOOLEAN, data: m.bool(8) ? 0xffffffff : 0 };
    case 9:
      return { dataType: TYPE_INT_COLOR_ARGB8, data: m.uint(9) };
    case 10:
      return { dataType: TYPE_INT_COLOR_RGB8, data: m.uint(10) };
    case 11:
      return { dataType: TYPE_INT_COLOR_ARGB4, data: m.uint(11) };
    case 12:
      return { dataType: TYPE_INT_COLOR_RGB4, data: m.uint(12) };
    case 4:
      return { dataType: TYPE_DIMENSION, data: f32bits(m, 4) };
    case 5:
      return { dataType: TYPE_FRACTION, data: f32bits(m, 5) };
    default:
      return unsupported("empty primitive");
  }
}

export interface ItemContext {
  pool: StringPool;
  config: Uint8Array;
  files?: { path: string; type: number }[];
}

/** pb.Item -> Res_value (DeserializeItemFromPb + Item::Flatten). */
export function decodeItem(m: PbMessage, ctx: ItemContext): { item: ResItem; fileType?: number } {
  m.expectOnly("Item", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  if (m.uint(8) !== 0 || m.str(10) !== "" || m.bool(9)) unsupported("flagged resource value");
  const kinds = m.fields.filter((f) => f.n <= 7);
  if (kinds.length === 0) unsupported("empty item");
  const which = kinds[kinds.length - 1].n;
  const body = m.msg(which) as PbMessage;
  switch (which) {
    case 1:
      return { item: decodeReference(body).item };
    case 2:
    case 3: {
      body.expectOnly(which === 2 ? "String" : "RawString", [1]);
      const ref = ctx.pool.ref(body.str(1), PRIORITY_NORMAL, ctx.config);
      return { item: { dataType: TYPE_STRING, data: 0, ref } };
    }
    case 4: {
      body.expectOnly("StyledString", [1, 2]);
      const spans = body.msgs(2).map((s) => {
        s.expectOnly("StyledString.Span", [1, 2, 3]);
        return { tag: s.str(1), firstChar: s.uint(2), lastChar: s.uint(3) };
      });
      const ref = ctx.pool.styled(body.str(1), spans, PRIORITY_NORMAL, ctx.config);
      return { item: { dataType: TYPE_STRING, data: 0, ref } };
    }
    case 5: {
      body.expectOnly("FileReference", [1, 2]);
      const path = body.str(1);
      const type = body.uint(2);
      const ref = ctx.pool.ref(path, PRIORITY_HIGH, ctx.config);
      ctx.files?.push({ path, type });
      return { item: { dataType: TYPE_STRING, data: 0, ref }, fileType: type };
    }
    case 6:
      body.expectOnly("Id", []);
      return { item: { dataType: TYPE_INT_BOOLEAN, data: 0 } };
    case 7:
      return { item: decodePrimitive(body) };
    default:
      return unsupported(`item kind ${which}`);
  }
}

/** pb.CompoundValue -> map pairs, in the order ResEntryWriter writes them. */
function decodeCompound(m: PbMessage, ctx: ItemContext, weak: boolean): ResValueModel {
  m.expectOnly("CompoundValue", [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  if (m.uint(7) !== 0 || m.str(9) !== "" || m.bool(8)) unsupported("flagged resource value");
  const kinds = m.fields.filter((f) => f.n <= 6);
  if (kinds.length === 0) unsupported("empty compound value");
  const which = kinds[kinds.length - 1].n;
  const body = m.msg(which) as PbMessage;
  const pairs: MapPair[] = [];
  switch (which) {
    case 1: {
      body.expectOnly("Attribute", [1, 2, 3, 4]);
      pairs.push({ key: ATTR_TYPE, item: { dataType: TYPE_INT_DEC, data: body.uint(1) } });
      const minInt = body.int32(2);
      const maxInt = body.int32(3);
      if (minInt !== -2147483648) pairs.push({ key: ATTR_MIN, item: { dataType: TYPE_INT_DEC, data: minInt >>> 0 } });
      if (maxInt !== 2147483647) pairs.push({ key: ATTR_MAX, item: { dataType: TYPE_INT_DEC, data: maxInt >>> 0 } });
      for (const s of body.msgs(4)) {
        s.expectOnly("Attribute.Symbol", [1, 2, 3, 4, 5]);
        const name = s.msg(3);
        const key = name ? decodeReference(name).id : 0;
        if (!key) unsupported("attribute symbol without an id");
        const type = s.uint(5) !== 0 ? s.uint(5) : TYPE_INT_DEC;
        pairs.push({ key, item: { dataType: type, data: s.uint(4) } });
      }
      return { kind: "map", weak, parent: 0, pairs };
    }
    case 2: {
      body.expectOnly("Style", [1, 2, 3]);
      const parentMsg = body.msg(1);
      let parent = 0;
      if (parentMsg) {
        parent = decodeReference(parentMsg).id;
        if (!parent) unsupported("style parent without an id");
      }
      const entries: { key: number; item: ResItem }[] = [];
      for (const e of body.msgs(3)) {
        e.expectOnly("Style.Entry", [1, 2, 3, 4]);
        const keyMsg = e.msg(3);
        const key = keyMsg ? decodeReference(keyMsg).id : 0;
        if (!key) unsupported("style item without an id");
        const itemMsg = e.msg(4);
        if (!itemMsg) unsupported("style item without a value");
        entries.push({ key, item: decodeItem(itemMsg, ctx).item });
      }
      // less_style_entries + cmp_ids_dynamic_after_framework; std::sort, so ties keep no order.
      entries.sort((a, b) => cmpStyleKeys(a.key, b.key));
      return { kind: "map", weak, parent, pairs: entries };
    }
    case 3: {
      // Styleables never reach resources.arsc. Still validate the shape.
      body.expectOnly("Styleable", [1]);
      for (const e of body.msgs(1)) {
        e.expectOnly("Styleable.Entry", [1, 2, 3]);
        const a = e.msg(3);
        if (a) decodeReference(a);
      }
      return { kind: "skip" };
    }
    case 4: {
      body.expectOnly("Array", [1]);
      body.msgs(1).forEach((el, i) => {
        el.expectOnly("Array.Element", [1, 2, 3]);
        const itemMsg = el.msg(3);
        if (!itemMsg) unsupported("array element without a value");
        pairs.push({ key: ATTR_MIN + i, item: decodeItem(itemMsg, ctx).item });
      });
      return { kind: "map", weak, parent: 0, pairs };
    }
    case 5: {
      body.expectOnly("Plural", [1]);
      const slots: (ResItem | null)[] = [null, null, null, null, null, null];
      for (const e of body.msgs(1)) {
        e.expectOnly("Plural.Entry", [1, 2, 3, 4]);
        const arity = e.uint(3);
        if (arity > 5) unsupported(`plural arity ${arity}`);
        const itemMsg = e.msg(4);
        if (!itemMsg) unsupported("plural without a value");
        slots[arity] = decodeItem(itemMsg, ctx).item;
      }
      // Plural::Zero..Many map to ATTR_ZERO..ATTR_MANY; Other is ATTR_OTHER (0x01000004).
      slots.forEach((item, i) => {
        if (item) pairs.push({ key: i === 5 ? ATTR_OTHER : ATTR_ZERO + i, item });
      });
      return { kind: "map", weak, parent: 0, pairs };
    }
    default:
      return unsupported("macro");
  }
}

function cmpStyleKeys(a: number, b: number): number {
  const pa = a >>> 24;
  const pb = b >>> 24;
  if ((pa === 0x01 && pb === 0x00) || (pa === 0x00 && pb === 0x01)) return a > b ? -1 : a < b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** pb.Value -> model. */
export function decodeValue(m: PbMessage, ctx: ItemContext): ResValueModel {
  m.expectOnly("Value", [1, 2, 3, 4, 5]);
  const weak = m.bool(3);
  const item = m.msg(4);
  const compound = m.msg(5);
  if (item && !compound) {
    const r = decodeItem(item, ctx);
    return { kind: "item", weak, item: r.item, fileType: r.fileType };
  }
  if (compound && !item) return decodeCompound(compound, ctx, weak);
  return unsupported("value without an item");
}

/** base/resources.pb -> TableModel. */
export function decodeResourceTable(buf: Uint8Array): TableModel {
  return strict(() => {
    const table = new PbMessage(buf);
    table.expectOnly("ResourceTable", [1, 2, 3, 4, 5]);
    if (table.has(3)) unsupported("overlayable");
    if (table.has(5)) unsupported("dynamic reference table");
    const packages = table.msgs(2);
    if (packages.length !== 1) unsupported(`${packages.length} resource packages`);
    const pkg = packages[0];
    pkg.expectOnly("Package", [1, 2, 3]);
    const packageId = pkg.msg(1)?.expectOnly("PackageId", [1]).uint(1) ?? 0;
    if (packageId !== 0x7f) unsupported(`package id 0x${packageId.toString(16)}`);

    const pool = new StringPool();
    const files: { path: string; type: number }[] = [];
    const types: TypeModel[] = [];
    for (const t of pkg.msgs(3)) {
      t.expectOnly("Type", [1, 2, 3]);
      const tid = t.msg(1)?.expectOnly("TypeId", [1]).uint(1);
      const name = t.str(2);
      if (tid === undefined || tid < 1 || tid > 0xff) unsupported(`type ${name} without an id`);
      if (name === "macro") unsupported("macro");
      const entries: EntryModel[] = [];
      for (const e of t.msgs(3)) {
        e.expectOnly("Entry", [1, 2, 3, 4, 5, 6, 7, 8]);
        if (e.has(5)) unsupported("overlayable");
        if (e.has(7)) unsupported("staged resource id");
        if (e.has(8)) unsupported("flagged resource value");
        const eid = e.msg(1)?.expectOnly("EntryId", [1]).uint(1);
        if (eid === undefined || eid > 0xffff) unsupported("entry without an id");
        let isPublic = false;
        const vis = e.msg(3);
        if (vis) {
          vis.expectOnly("Visibility", [1, 2, 3, 4]);
          if (vis.bool(4)) unsupported("staged API");
          isPublic = vis.uint(1) === 2;
        }
        const values: ConfigValueModel[] = [];
        for (const cv of e.msgs(6)) {
          cv.expectOnly("ConfigValue", [1, 2]);
          const cfg = configToBytes(cv.msg(1));
          if (cfg.product !== "") unsupported("product-specific resource");
          const valueMsg = cv.msg(2);
          if (!valueMsg) unsupported("config value without a value");
          const config = cfg.bytes;
          if (values.some((v) => sameBytes(v.config, config))) unsupported("duplicate configuration");
          values.push({ config, value: decodeValue(valueMsg, { pool, config, files }) });
        }
        entries.push({ id: eid, name: e.str(2), isPublic, values });
      }
      entries.sort((a, b) => a.id - b.id);
      for (let i = 1; i < entries.length; i++) if (entries[i].id === entries[i - 1].id) unsupported("duplicate entry id");
      types.push({ id: tid, name, entries });
    }
    types.sort((a, b) => a.id - b.id);
    for (let i = 1; i < types.length; i++) if (types[i].id === types[i - 1].id) unsupported("duplicate type id");
    return { packageId, packageName: pkg.str(2), types, pool, files };
  });
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { DEFAULT_CONFIG };
