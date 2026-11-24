/**
 * TableModel -> resources.arsc, a port of aapt2 format/binary/TableFlattener.cpp
 * and ResEntryWriter.cpp with the options `aapt2 convert` uses by default:
 * no sparse entries, no compact entries, no value de-duplication, no key
 * collapsing. Copyright (C) 2015 The Android Open Source Project.
 * Licensed under the Apache License, Version 2.0.
 */

import { ByteWriter, startChunk } from "./bytes";
import { compareConfig, diffConfig } from "./config";
import { itemData } from "./resourcesProto";
import type { ResItem, TableModel, TypeModel } from "./resourcesProto";
import { StringPool } from "./stringPool";
import type { PoolContext } from "./stringPool";

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const FLAG_COMPLEX = 0x0001;
const FLAG_PUBLIC = 0x0002;
const FLAG_WEAK = 0x0004;
const SPEC_PUBLIC = 0x40000000;
const NO_ENTRY = 0xffffffff;

/** The value-pool order TableFlattener::Consume sorts into: priority, then config. */
export function tableContextCompare(a: PoolContext, b: PoolContext): number {
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  return compareConfig(a.config, b.config);
}

function writeResValue(w: ByteWriter, item: ResItem): void {
  w.u16(8);
  w.u8(0);
  w.u8(item.dataType);
  w.u32(itemData(item));
}

function flattenTypes(w: ByteWriter, types: TypeModel[], typePool: StringPool, keyPool: StringPool): void {
  let expected = 1;
  for (const type of types) {
    if (type.name === "styleable" || type.name === "macro") continue;
    while (type.id > expected) {
      typePool.ref(`?${expected}`);
      expected++;
    }
    expected++;
    typePool.ref(type.name);

    // FlattenTypeSpec
    const spec = startChunk(w, RES_TABLE_TYPE_SPEC_TYPE, 16);
    w.setU8(spec.start + 8, type.id);
    const numEntries = type.entries.length ? type.entries[type.entries.length - 1].id + 1 : 0;
    const typesCountAt = spec.start + 10;
    if (numEntries > 0) {
      w.setU32(spec.start + 12, numEntries);
      const masksAt = w.length;
      w.zeros(numEntries * 4);
      for (const entry of type.entries) {
        let mask = w.getU32(masksAt + 4 * entry.id);
        if (entry.isPublic) mask |= SPEC_PUBLIC;
        for (let i = 0; i < entry.values.length; i++) {
          for (let j = i + 1; j < entry.values.length; j++) {
            mask |= diffConfig(entry.values[i].config, entry.values[j].config);
          }
        }
        w.setU32(masksAt + 4 * entry.id, mask);
      }
    }
    spec.finish();

    // Group values per configuration (std::map<ConfigDescription, ...>, ordered by compare).
    interface Flat {
      entryId: number;
      key: number;
      isPublic: boolean;
      value: (typeof type.entries)[number]["values"][number]["value"];
    }
    const groups: { config: Uint8Array; flats: Flat[] }[] = [];
    for (const entry of type.entries) {
      const key = keyPool.ref(entry.name).index;
      for (const cv of entry.values) {
        let g = groups.find((x) => compareConfig(x.config, cv.config) === 0);
        if (!g) {
          g = { config: cv.config, flats: [] };
          groups.push(g);
        }
        g.flats.push({ entryId: entry.id, key, isPublic: entry.isPublic, value: cv.value });
      }
    }
    groups.sort((a, b) => compareConfig(a.config, b.config));

    for (const g of groups) {
      // FlattenConfig: values written to their own buffer, then appended after the offsets.
      const values = new ByteWriter(512);
      const offsets = new Array<number>(numEntries).fill(NO_ENTRY);
      for (const f of g.flats) {
        if (f.value.kind === "skip") throw new Error("styleable value in a flattened type");
        offsets[f.entryId] = values.length;
        let flags = 0;
        if (f.isPublic) flags |= FLAG_PUBLIC;
        if (f.value.weak) flags |= FLAG_WEAK;
        if (f.value.kind === "item") {
          values.u16(8);
          values.u16(flags);
          values.u32(f.key);
          writeResValue(values, f.value.item);
        } else {
          values.u16(16);
          values.u16(flags | FLAG_COMPLEX);
          values.u32(f.key);
          values.u32(f.value.parent);
          values.u32(f.value.pairs.length);
          for (const p of f.value.pairs) {
            values.u32(p.key);
            writeResValue(values, p.item);
          }
        }
      }
      const chunk = startChunk(w, RES_TABLE_TYPE_TYPE, 84);
      w.setU8(chunk.start + 8, type.id);
      w.setU32(chunk.start + 12, numEntries);
      for (let i = 0; i < 64; i++) w.setU8(chunk.start + 20 + i, g.config[i]);
      for (const o of offsets) w.u32(o);
      w.align4();
      w.setU32(chunk.start + 16, w.length - chunk.start);
      w.bytes(values.toBytes());
      chunk.finish();
    }
    w.setU16(typesCountAt, Math.min(groups.length, 0xffff));
  }
}

function writeUtf16Name(w: ByteWriter, at: number, name: string, max: number): void {
  // strcpy16_htod: copies at most max-1 units and always NUL-terminates.
  const n = Math.min(name.length, max - 1);
  for (let i = 0; i < n; i++) w.setU16(at + 2 * i, name.charCodeAt(i));
}

/** Flatten a decoded table into resources.arsc bytes. Sorts the table's value pool. */
export function flattenTable(table: TableModel): Uint8Array {
  table.pool.sort(tableContextCompare);
  const w = new ByteWriter(64 * 1024);
  const header = startChunk(w, RES_TABLE_TYPE, 12);
  w.setU32(header.start + 8, 1);
  table.pool.flatten(w, true);

  // PackageFlattener::FlattenPackage
  const pkg = startChunk(w, RES_TABLE_PACKAGE_TYPE, 288);
  w.setU32(pkg.start + 8, table.packageId);
  writeUtf16Name(w, pkg.start + 12, table.packageName, 128);
  const typePool = new StringPool();
  const keyPool = new StringPool();
  const typeBuf = new ByteWriter(64 * 1024);
  flattenTypes(typeBuf, table.types, typePool, keyPool);
  w.setU32(pkg.start + 268, w.length - pkg.start); // typeStrings
  typePool.flatten(w, false);
  w.setU32(pkg.start + 276, w.length - pkg.start); // keyStrings
  keyPool.flatten(w, true);
  w.bytes(typeBuf.toBytes());
  pkg.finish();
  header.finish();
  return w.toBytes();
}

