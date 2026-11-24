/**
 * ResStringPool writer, ported from aapt2's android::StringPool
 * (frameworks/base/libs/androidfw/StringPool.cpp).
 *
 * Copyright (C) 2015 The Android Open Source Project
 * Licensed under the Apache License, Version 2.0. Ported to TypeScript for
 * BetaDrop's in-browser AAB to APK converter; behaviour kept, structure simplified.
 */

import { ByteWriter, utf8Encoder } from "./bytes";

export const RES_STRING_POOL_TYPE = 0x0001;
const UTF8_FLAG = 0x100;
const SPAN_END = 0xffffffff;

export interface Span {
  /** Index of the tag name string in the same pool (resolved at flatten time). */
  name: PoolRef;
  firstChar: number;
  lastChar: number;
}

/** A reference whose final index is known only after the pool is sorted. */
export interface PoolRef {
  index: number;
}

export const PRIORITY_HIGH = 1;
export const PRIORITY_NORMAL = 0x7fffffff;
export const PRIORITY_LOW = 0xffffffff;

/** StringPool::Context: a priority and the configuration of the first value that used the string. */
export interface PoolContext {
  priority: number;
  config: Uint8Array | null;
}

interface StrEntry {
  value: string;
  context: PoolContext;
  ref: PoolRef;
}

interface StyleEntry {
  value: string;
  context: PoolContext;
  spans: Span[];
  ref: PoolRef;
}

export type ContextCompare = (a: PoolContext, b: PoolContext) => number;

export class StringPool {
  private strings: StrEntry[] = [];
  private styles: StyleEntry[] = [];
  private byKey = new Map<string, StrEntry>();

  /**
   * StringPool::MakeRef: deduplicated by value and priority only. A string
   * first added under one configuration keeps that context, as in aapt2.
   */
  ref(value: string, priority = PRIORITY_NORMAL, config: Uint8Array | null = null): PoolRef {
    const key = `${priority}\u0000${value}`;
    const hit = this.byKey.get(key);
    if (hit) return hit.ref;
    const entry: StrEntry = { value, context: { priority, config }, ref: { index: this.strings.length } };
    this.strings.push(entry);
    this.byKey.set(key, entry);
    this.reindex();
    return entry.ref;
  }

  /** A styled string; styles are never deduplicated. Span tag names use the default context. */
  styled(
    value: string,
    spans: { tag: string; firstChar: number; lastChar: number }[],
    priority = PRIORITY_NORMAL,
    config: Uint8Array | null = null,
  ): PoolRef {
    const entry: StyleEntry = {
      value,
      context: { priority, config },
      spans: spans.map((s) => ({ name: this.ref(s.tag), firstChar: s.firstChar, lastChar: s.lastChar })),
      ref: { index: -1 },
    };
    this.styles.push(entry);
    this.reindex();
    return entry.ref;
  }

  get size(): number {
    return this.strings.length + this.styles.length;
  }

  /** Plain strings with their contexts, in their current order. */
  stringEntries(): readonly { value: string; context: PoolContext }[] {
    return this.strings;
  }

  /** Plain strings in their current order (after styles in index space). */
  stringValues(): string[] {
    return this.strings.map((s) => s.value);
  }

  /** Styles take the first indices, then strings, matching the flattened layout. */
  private reindex(): void {
    let i = 0;
    for (const s of this.styles) s.ref.index = i++;
    for (const s of this.strings) s.ref.index = i++;
  }

  /** StringPool::Sort: by context, then by value (UTF-8 byte order). */
  sort(cmp: ContextCompare = () => 0): void {
    const order = (a: { context: PoolContext; value: string }, b: { context: PoolContext; value: string }) =>
      cmp(a.context, b.context) || compareCodePoints(a.value, b.value);
    this.styles = stableSort(this.styles, order);
    this.strings = stableSort(this.strings, order);
    this.reindex();
  }

  /** Reorder plain strings with an arbitrary comparator (XmlFlattener's attribute-first sort). */
  sortStrings(cmp: (a: { value: string; context: PoolContext }, b: { value: string; context: PoolContext }) => number): void {
    this.strings = stableSort(this.strings, cmp);
    this.reindex();
  }

  /** StringPool::Flatten, in the current order (call sort() first where aapt2 does). */
  flatten(w: ByteWriter, useUtf8: boolean): void {
    const start = w.length;
    w.u16(RES_STRING_POOL_TYPE);
    w.u16(28);
    const sizeAt = w.u32(0);
    w.u32(this.size);
    w.u32(this.styles.length);
    w.u32(useUtf8 ? UTF8_FLAG : 0);
    const stringsStartAt = w.u32(0);
    const stylesStartAt = w.u32(0);

    const indicesAt = w.length;
    w.zeros(this.size * 4);
    const styleIndicesAt = w.length;
    w.zeros(this.styles.length * 4);

    const beforeStrings = w.length;
    w.setU32(stringsStartAt, beforeStrings - start);
    let k = 0;
    for (const e of this.styles) {
      w.setU32(indicesAt + 4 * k++, w.length - beforeStrings);
      encodeString(w, e.value, useUtf8);
    }
    for (const e of this.strings) {
      w.setU32(indicesAt + 4 * k++, w.length - beforeStrings);
      encodeString(w, e.value, useUtf8);
    }
    w.align4();

    if (this.styles.length > 0) {
      const beforeStyles = w.length;
      w.setU32(stylesStartAt, beforeStyles - start);
      let s = 0;
      for (const e of this.styles) {
        w.setU32(styleIndicesAt + 4 * s++, w.length - beforeStyles);
        for (const span of e.spans) {
          w.u32(span.name.index);
          w.u32(span.firstChar);
          w.u32(span.lastChar);
        }
        w.u32(SPAN_END);
      }
      // Padding the size of a span minus its name, filled with 0xff (as aapt2 writes it).
      for (let i = 0; i < 8; i++) w.u8(0xff);
      w.align4();
    }
    w.setU32(sizeAt, w.length - start);
  }
}

/** UTF-8 byte order equals code point order; JS < compares UTF-16 units instead. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => ({ v, i }))
    .sort((a, b) => cmp(a.v, b.v) || a.i - b.i)
    .map((x) => x.v);
}

/** util::Utf8ToModifiedUtf8: supplementary characters as two 3-byte surrogates. */
function modifiedUtf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function hasSupplementary(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return true;
  }
  return false;
}

function encodeLen8(w: ByteWriter, len: number): void {
  if (len > 0x7f) {
    w.u8(0x80 | ((len >> 8) & 0x7f));
    w.u8(len & 0xff);
  } else w.u8(len);
}

function encodeLen16(w: ByteWriter, len: number): void {
  if (len > 0x7fff) {
    w.u16(0x8000 | ((len >> 16) & 0x7fff));
    w.u16(len & 0xffff);
  } else w.u16(len);
}

function encodeString(w: ByteWriter, str: string, useUtf8: boolean): void {
  if (useUtf8) {
    const bytes = hasSupplementary(str) ? modifiedUtf8(str) : utf8Encoder.encode(str);
    const u16len = str.length;
    if (bytes.length > 0x7fff || u16len > 0x7fff) {
      throw new Error("string too large for a UTF-8 string pool");
    }
    encodeLen8(w, u16len);
    encodeLen8(w, bytes.length);
    w.bytes(bytes);
    w.u8(0);
  } else {
    if (str.length > 0x7fffffff) throw new Error("string too large");
    encodeLen16(w, str.length);
    for (let i = 0; i < str.length; i++) w.u16(str.charCodeAt(i));
    w.u16(0);
  }
}
