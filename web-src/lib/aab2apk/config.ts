/**
 * aapt2 pb.Configuration to the 64-byte ResTable_config that resources.arsc
 * carries in every RES_TABLE_TYPE chunk.
 *
 * Ported from aapt2 format/proto/ProtoDeserialize.cpp (DeserializeConfigFromPb)
 * and androidfw Locale.cpp / ResourceTypes.h (packLanguage, packRegion).
 * Copyright (C) 2017 The Android Open Source Project.
 * Licensed under the Apache License, Version 2.0.
 */

import { PbMessage } from "./pb";

export const CONFIG_SIZE = 64;

/** Configuration.proto field numbers this module maps. */
const KNOWN_CONFIG_FIELDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

export class ConfigError extends Error {}

export interface ConfigResult {
  bytes: Uint8Array;
  /** Product name; aapt2 resolves products at link time, so anything but "" is unusual. */
  product: string;
}

/** Enum value in the proto to the ResTable_config constant. Index = proto value. */
const ORIENTATION = [0, 1, 2, 3];
const TOUCHSCREEN = [0, 1, 2, 3];
const KEYBOARD = [0, 1, 2, 3];
const NAVIGATION = [0, 1, 2, 3, 4];
const KEYS_HIDDEN = [0, 1, 2, 3];
const NAV_HIDDEN = [0, 0x04, 0x08];
const LAYOUT_DIR = [0, 0x40, 0x80];
const SCREEN_SIZE = [0, 1, 2, 3, 4];
const SCREEN_LONG = [0, 0x20, 0x10];
const SCREEN_ROUND = [0, 0x02, 0x01];
const WIDE_GAMUT = [0, 0x02, 0x01];
const HDR = [0, 0x08, 0x04];
const UI_TYPE = [0, 1, 2, 3, 4, 5, 6, 7];
const UI_NIGHT = [0, 0x20, 0x10];
const GRAM_GENDER = [0, 1, 2, 3];

function pick(table: number[], v: number, what: string): number {
  if (v < 0 || v >= table.length) throw new ConfigError(`unknown ${what} ${v}`);
  return table[v];
}

interface Locale {
  language: string;
  region: string;
  script: string;
  variant: string;
}

/** LocaleValue::InitFromBcp47Tag. Lowercases every subtag, then cases them back per role. */
export function parseBcp47(tag: string): Locale {
  const sub = tag.split("-").map((s) => s.toLowerCase());
  const loc: Locale = { language: "", region: "", script: "", variant: "" };
  const lang = (s: string) => (loc.language = s.slice(0, 4));
  const region = (s: string) => (loc.region = s.slice(0, 4).toUpperCase());
  const script = (s: string) => (loc.script = s.slice(0, 4).replace(/^./, (c) => c.toUpperCase()));
  const variant = (s: string) => (loc.variant = s.slice(0, 8));
  if (sub.length === 1) lang(sub[0]);
  else if (sub.length === 2) {
    lang(sub[0]);
    const s = sub[1];
    if (s.length === 2 || s.length === 3) region(s);
    else if (s.length === 4 && !(s[0] >= "0" && s[0] <= "9")) script(s);
    else if (s.length >= 4 && s.length <= 8) variant(s);
    else throw new ConfigError(`invalid locale ${tag}`);
  } else if (sub.length === 3) {
    lang(sub[0]);
    if (sub[1].length === 4) script(sub[1]);
    else if (sub[1].length === 2 || sub[1].length === 3) region(sub[1]);
    else throw new ConfigError(`invalid locale ${tag}`);
    if (sub[2].length >= 4) variant(sub[2]);
    else region(sub[2]);
  } else if (sub.length === 4) {
    lang(sub[0]);
    script(sub[1]);
    region(sub[2]);
    variant(sub[3]);
  } else throw new ConfigError(`invalid locale ${tag}`);
  return loc;
}

/** ResTable_config::packLanguageOrRegion. */
function packLanguageOrRegion(s: string, base: number): [number, number] {
  const c = (i: number) => (i < s.length ? s.charCodeAt(i) : 0);
  if (c(0) === 0) return [0, 0];
  if (c(2) === 0 || c(2) === 0x2d) return [c(0), c(1)];
  const first = (c(0) - base) & 0x7f;
  const second = (c(1) - base) & 0x7f;
  const third = (c(2) - base) & 0x7f;
  return [(0x80 | (third << 2) | (second >> 3)) & 0xff, ((second << 5) | first) & 0xff];
}

export function configToBytes(pb: PbMessage | null): ConfigResult {
  const out = new Uint8Array(CONFIG_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, CONFIG_SIZE, true);
  if (!pb) return { bytes: out, product: "" };
  const unknown = pb.unknown(KNOWN_CONFIG_FIELDS);
  if (unknown.length) throw new ConfigError(`unknown configuration field ${unknown[0]}`);

  dv.setUint16(4, pb.uint(1), true); // mcc
  dv.setUint16(6, pb.uint(2), true); // mnc

  const tag = pb.str(3);
  if (tag) {
    const loc = parseBcp47(tag);
    const [l0, l1] = packLanguageOrRegion(loc.language, 0x61);
    const [r0, r1] = packLanguageOrRegion(loc.region, 0x30);
    out[8] = l0;
    out[9] = l1;
    out[10] = r0;
    out[11] = r1;
    for (let i = 0; i < loc.script.length; i++) out[36 + i] = loc.script.charCodeAt(i);
    for (let i = 0; i < loc.variant.length; i++) out[40 + i] = loc.variant.charCodeAt(i);
  }

  let screenLayout = 0;
  screenLayout |= pick(LAYOUT_DIR, pb.uint(4), "layout direction");
  screenLayout |= pick(SCREEN_SIZE, pb.uint(10), "screen size");
  screenLayout |= pick(SCREEN_LONG, pb.uint(11), "screen long");
  out[28] = screenLayout;

  dv.setUint16(20, pb.uint(5), true); // screenWidth
  dv.setUint16(22, pb.uint(6), true); // screenHeight
  dv.setUint16(32, pb.uint(7), true); // screenWidthDp
  dv.setUint16(34, pb.uint(8), true); // screenHeightDp
  dv.setUint16(30, pb.uint(9), true); // smallestScreenWidthDp

  out[48] = pick(SCREEN_ROUND, pb.uint(12), "screen round");
  out[49] = pick(WIDE_GAMUT, pb.uint(13), "wide color gamut") | pick(HDR, pb.uint(14), "hdr");

  out[12] = pick(ORIENTATION, pb.uint(15), "orientation");
  out[29] = pick(UI_TYPE, pb.uint(16), "ui mode type") | pick(UI_NIGHT, pb.uint(17), "ui mode night");
  dv.setUint16(14, pb.uint(18), true); // density
  out[13] = pick(TOUCHSCREEN, pb.uint(19), "touchscreen");
  out[16] = pick(KEYBOARD, pb.uint(21), "keyboard");
  out[17] = pick(NAVIGATION, pb.uint(23), "navigation");
  out[18] = pick(KEYS_HIDDEN, pb.uint(20), "keys hidden") | pick(NAV_HIDDEN, pb.uint(22), "nav hidden");
  dv.setUint16(24, pb.uint(24), true); // sdkVersion
  out[19] = pick(GRAM_GENDER, pb.uint(26), "grammatical gender");

  return { bytes: out, product: pb.str(25) };
}

/** True when two configs are byte-identical (used to group values per TYPE chunk). */
export function configKey(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function memcmp(a: Uint8Array, b: Uint8Array, at: number, n: number): number {
  for (let i = at; i < at + n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const cmpNum = (a: number, b: number) => (a === b ? 0 : a > b ? 1 : -1);

/**
 * ResTable_config::compare over two 64-byte configs (ResourceTypes.cpp).
 * localeScriptWasComputed is always false here, as DeserializeConfigFromPb leaves it.
 */
export function compareConfig(a: Uint8Array | null, b: Uint8Array | null): number {
  const x = a ?? DEFAULT_CONFIG;
  const y = b ?? DEFAULT_CONFIG;
  return (
    cmpNum(u32(x, 4), u32(y, 4)) || // imsi
    cmpNum(u32(x, 8), u32(y, 8)) || // locale (language + country)
    Math.sign(memcmp(x, y, 36, 4)) || // localeScript
    Math.sign(memcmp(x, y, 40, 8)) || // localeVariant
    Math.sign(memcmp(x, y, 53, 8)) || // localeNumberingSystem
    cmpNum(x[19], y[19]) || // grammaticalInflection
    cmpNum(u32(x, 12), u32(y, 12)) || // screenType
    cmpNum(u32(x, 16) & 0xffffff, u32(y, 16) & 0xffffff) || // input
    cmpNum(u32(x, 20), u32(y, 20)) || // screenSize
    cmpNum(u32(x, 24), u32(y, 24)) || // version
    cmpNum(x[28], y[28]) || // screenLayout
    cmpNum(x[48], y[48]) || // screenLayout2
    cmpNum(x[49], y[49]) || // colorMode
    cmpNum(x[29], y[29]) || // uiMode
    cmpNum(u16(x, 30), u16(y, 30)) || // smallestScreenWidthDp
    cmpNum(u32(x, 32), u32(y, 32)) // screenSizeDp
  );
}

export const DEFAULT_CONFIG: Uint8Array = configToBytes(null).bytes;

/** Locale part of ResTable_config::compare (compareLocales), script never computed. */
function compareLocales(x: Uint8Array, y: Uint8Array): number {
  return (
    cmpNum(u32(x, 8), u32(y, 8)) ||
    Math.sign(memcmp(x, y, 36, 4)) ||
    Math.sign(memcmp(x, y, 40, 8)) ||
    Math.sign(memcmp(x, y, 53, 8))
  );
}

/**
 * ResTable_config::diff: the CONFIG_* bits on which two configs differ. The
 * type spec chunk ORs these across every pair of an entry's configurations.
 */
export function diffConfig(x: Uint8Array, y: Uint8Array): number {
  let d = 0;
  if (u16(x, 4) !== u16(y, 4)) d |= 0x0001; // CONFIG_MCC
  if (u16(x, 6) !== u16(y, 6)) d |= 0x0002; // CONFIG_MNC
  if (x[12] !== y[12]) d |= 0x0080; // CONFIG_ORIENTATION
  if (u16(x, 14) !== u16(y, 14)) d |= 0x0100; // CONFIG_DENSITY
  if (x[13] !== y[13]) d |= 0x0008; // CONFIG_TOUCHSCREEN
  if (((x[18] ^ y[18]) & (0x03 | 0x0c)) !== 0) d |= 0x0020; // CONFIG_KEYBOARD_HIDDEN
  if (x[16] !== y[16]) d |= 0x0010; // CONFIG_KEYBOARD
  if (x[17] !== y[17]) d |= 0x0040; // CONFIG_NAVIGATION
  if (u32(x, 20) !== u32(y, 20)) d |= 0x0200; // CONFIG_SCREEN_SIZE
  if (u32(x, 24) !== u32(y, 24)) d |= 0x0400; // CONFIG_VERSION
  if ((x[28] & 0xc0) !== (y[28] & 0xc0)) d |= 0x4000; // CONFIG_LAYOUTDIR
  if ((x[28] & ~0xc0 & 0xff) !== (y[28] & ~0xc0 & 0xff)) d |= 0x0800; // CONFIG_SCREEN_LAYOUT
  if ((x[48] & 0x03) !== (y[48] & 0x03)) d |= 0x8000; // CONFIG_SCREEN_ROUND
  if ((x[49] & 0x03) !== (y[49] & 0x03)) d |= 0x10000; // CONFIG_COLOR_MODE (wide gamut)
  if ((x[49] & 0x0c) !== (y[49] & 0x0c)) d |= 0x10000; // CONFIG_COLOR_MODE (hdr)
  if (x[29] !== y[29]) d |= 0x1000; // CONFIG_UI_MODE
  if (u16(x, 30) !== u16(y, 30)) d |= 0x2000; // CONFIG_SMALLEST_SCREEN_SIZE
  if (u32(x, 32) !== u32(y, 32)) d |= 0x0200; // CONFIG_SCREEN_SIZE (dp)
  if (x[19] !== y[19]) d |= 0x20000; // CONFIG_GRAMMATICAL_GENDER
  if (compareLocales(x, y) !== 0) d |= 0x0004; // CONFIG_LOCALE
  return d;
}

/** The SDK level in a config's version field (0 when unqualified). */
export function configSdk(bytes: Uint8Array): number {
  return u16(bytes, 24);
}
