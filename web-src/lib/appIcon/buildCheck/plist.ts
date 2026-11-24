/**
 * Property lists, binary (bplist00, what Xcode writes into an iOS build) and XML (what older
 * builds and hand-made bundles carry), read into plain values.
 *
 * Written here rather than taken from the bplist-parser and plist packages because those lean on
 * Node's Buffer and on an XML DOM; this runs unchanged in the browser and in the Node tests. It
 * reads Info.plist only, so it is small, but every offset and count is checked and the nesting is
 * bounded: a build is a file from someone else's machine.
 */

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | PlistDict | null;
export interface PlistDict {
  [key: string]: PlistValue;
}

export class PlistError extends Error {}

const MAX_DEPTH = 64;
const MAX_OBJECTS = 1_000_000;

export function parsePlist(bytes: Uint8Array): PlistValue {
  if (bytes.length >= 8 && String.fromCharCode(...Array.from(bytes.subarray(0, 6))) === "bplist") return parseBinary(bytes);
  return parseXml(new TextDecoder("utf-8").decode(bytes));
}

export const isDict = (v: PlistValue | undefined): v is PlistDict =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

// ── Binary ───────────────────────────────────────────────────────────────────────────────────

function parseBinary(b: Uint8Array): PlistValue {
  if (b.length < 8 + 32) throw new PlistError("binary plist too short");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b.length - 32;
  const offsetSize = b[t + 6];
  const refSize = b[t + 7];
  const count = uint(b, t + 8, 8);
  const top = uint(b, t + 16, 8);
  const tableAt = uint(b, t + 24, 8);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new PlistError("bad binary plist trailer");
  if (count < 1 || count > MAX_OBJECTS || top >= count || tableAt + count * offsetSize > t) throw new PlistError("bad binary plist trailer");

  const offsetOf = (ref: number): number => {
    if (ref >= count) throw new PlistError("object reference out of range");
    const at = uint(b, tableAt + ref * offsetSize, offsetSize);
    if (at < 8 || at >= tableAt) throw new PlistError("object offset out of range");
    return at;
  };
  // Objects may be shared (two keys pointing at one string), so each is parsed once and reused:
  // without that, arrays that each list the next one twice would cost 2^depth.
  const done = new Map<number, PlistValue>();
  const active = new Set<number>();

  /** The length nibble of a marker, or the integer object that follows when it is 0xF. */
  const lengthAt = (at: number): [number, number] => {
    const low = b[at] & 0x0f;
    if (low !== 0x0f) return [low, at + 1];
    const marker = b[at + 1];
    if (marker >> 4 !== 0x1) throw new PlistError("bad length");
    const n = 1 << (marker & 0x0f);
    if (n > 8 || at + 2 + n > tableAt) throw new PlistError("bad length");
    return [uint(b, at + 2, n), at + 2 + n];
  };

  const object = (ref: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("plist nested too deeply");
    if (active.has(ref)) throw new PlistError("plist object contains itself");
    if (done.has(ref)) return done.get(ref) as PlistValue;
    const value = parseObject(ref, depth);
    done.set(ref, value);
    return value;
  };

  const parseObject = (ref: number, depth: number): PlistValue => {
    const at = offsetOf(ref);
    const marker = b[at];
    const hi = marker >> 4;
    const lo = marker & 0x0f;
    switch (hi) {
      case 0x0:
        return marker === 0x09 ? true : marker === 0x08 ? false : null;
      case 0x1: {
        const n = 1 << lo;
        if (n > 16 || at + 1 + n > tableAt) throw new PlistError("bad integer");
        // 8-byte integers are signed; 16-byte ones carry their value in the low 8 bytes.
        if (n === 8 || n === 16) return Number(v.getBigInt64(at + 1 + n - 8));
        return uint(b, at + 1, n);
      }
      case 0x2: {
        if (lo === 2 && at + 5 <= tableAt) return v.getFloat32(at + 1);
        if (lo === 3 && at + 9 <= tableAt) return v.getFloat64(at + 1);
        throw new PlistError("bad real");
      }
      case 0x3:
        if (marker !== 0x33 || at + 9 > tableAt) throw new PlistError("bad date");
        return new Date(Date.UTC(2001, 0, 1) + v.getFloat64(at + 1) * 1000);
      case 0x4: {
        const [len, start] = lengthAt(at);
        if (start + len > tableAt) throw new PlistError("data runs past the object table");
        return b.slice(start, start + len);
      }
      case 0x5: {
        const [len, start] = lengthAt(at);
        if (start + len > tableAt) throw new PlistError("string runs past the object table");
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(b[start + i]);
        return s;
      }
      case 0x6: {
        const [len, start] = lengthAt(at);
        if (start + len * 2 > tableAt) throw new PlistError("string runs past the object table");
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint16(start + i * 2));
        return s;
      }
      case 0x8:
        if (at + 2 + lo > tableAt) throw new PlistError("bad uid");
        return uint(b, at + 1, lo + 1);
      case 0xa:
      case 0xc: {
        const [len, start] = lengthAt(at);
        if (start + len * refSize > tableAt) throw new PlistError("array runs past the object table");
        active.add(ref);
        const out: PlistValue[] = [];
        for (let i = 0; i < len; i++) out.push(object(uint(b, start + i * refSize, refSize), depth + 1));
        active.delete(ref);
        return out;
      }
      case 0xd: {
        const [len, start] = lengthAt(at);
        if (start + len * 2 * refSize > tableAt) throw new PlistError("dictionary runs past the object table");
        active.add(ref);
        const out: PlistDict = {};
        for (let i = 0; i < len; i++) {
          const key = object(uint(b, start + i * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new PlistError("dictionary key is not a string");
          out[key] = object(uint(b, start + (len + i) * refSize, refSize), depth + 1);
        }
        active.delete(ref);
        return out;
      }
      default:
        throw new PlistError(`unknown plist object 0x${marker.toString(16)}`);
    }
  };

  return object(top, 0);
}

/** A big-endian unsigned integer of `n` bytes (n ≤ 8), as a Number. */
function uint(b: Uint8Array, at: number, n: number): number {
  if (at < 0 || at + n > b.length) throw new PlistError("read past the end");
  let x = 0;
  for (let i = 0; i < n; i++) x = x * 256 + b[at + i];
  return x;
}

// ── XML ──────────────────────────────────────────────────────────────────────────────────────

interface Tag {
  name: string;
  close: boolean;
  empty: boolean;
  /** Text between the previous tag and this one. */
  text: string;
}

/** An element name right after `<` or `</`, matched on a short slice so no match can scan far. */
const NAME = /^<(\/?)([A-Za-z][\w.-]{0,127})/;

/**
 * Splits the XML into tags in one pass. Each terminator is found with indexOf and a missing one
 * is an error: a pattern that retried from every `<` would rescan the rest of the file each time,
 * so an Info.plist of unclosed `<!--` froze the tab for minutes.
 */
function tokenize(text: string): Tag[] {
  const tags: Tag[] = [];
  let pending = "";
  let textStart = 0;
  let pos = 0;
  const skip = (lt: number, opener: string, closer: string, what: string, keep: boolean) => {
    const end = text.indexOf(closer, lt + opener.length);
    if (end < 0) throw new PlistError(`unclosed ${what}`);
    pending += decodeEntities(text.slice(textStart, lt)) + (keep ? text.slice(lt + opener.length, end) : "");
    textStart = pos = end + closer.length;
  };
  for (;;) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) skip(lt, "<!--", "-->", "comment", false);
    else if (text.startsWith("<![CDATA[", lt)) skip(lt, "<![CDATA[", "]]>", "CDATA section", true); // literal text
    else if (text.startsWith("<?", lt)) skip(lt, "<?", "?>", "processing instruction", false);
    else if (text.startsWith("<!", lt)) skip(lt, "<!", ">", "declaration", false); // the DOCTYPE
    else {
      const m = NAME.exec(text.slice(lt, lt + 130));
      if (!m) {
        // A bare "<" that starts no element: text, as a lenient reader has always taken it.
        pos = lt + 1;
        continue;
      }
      const gt = text.indexOf(">", lt + m[0].length);
      if (gt < 0) throw new PlistError(`unclosed <${m[2]}`);
      tags.push({ name: m[2], close: m[1] === "/", empty: text[gt - 1] === "/", text: pending + decodeEntities(text.slice(textStart, lt)) });
      pending = "";
      if (tags.length > MAX_OBJECTS) throw new PlistError("plist too large");
      textStart = pos = gt + 1;
    }
  }
  return tags;
}

function parseXml(text: string): PlistValue {
  const tags = tokenize(text);

  let i = 0;
  const value = (depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("plist nested too deeply");
    const open = tags[i++];
    if (!open || open.close) throw new PlistError("expected a value");
    const leaf = (): string => {
      if (open.empty) return "";
      const close = tags[i++];
      if (!close || !close.close || close.name !== open.name) throw new PlistError(`unclosed <${open.name}>`);
      return close.text;
    };
    switch (open.name) {
      case "dict": {
        const out: PlistDict = {};
        if (open.empty) return out;
        for (;;) {
          const next = tags[i];
          if (!next) throw new PlistError("unclosed <dict>");
          if (next.close && next.name === "dict") {
            i++;
            return out;
          }
          if (next.name !== "key" || next.close) throw new PlistError("expected <key>");
          i++;
          let key = "";
          if (!next.empty) {
            const close = tags[i++];
            if (!close || !close.close || close.name !== "key") throw new PlistError("unclosed <key>");
            key = close.text;
          }
          out[key] = value(depth + 1);
        }
      }
      case "array": {
        const out: PlistValue[] = [];
        if (open.empty) return out;
        for (;;) {
          const next = tags[i];
          if (!next) throw new PlistError("unclosed <array>");
          if (next.close && next.name === "array") {
            i++;
            return out;
          }
          out.push(value(depth + 1));
        }
      }
      case "string":
        return leaf();
      case "integer": {
        const n = Number(leaf().trim());
        return Number.isFinite(n) ? n : 0;
      }
      case "real": {
        const n = Number(leaf().trim());
        return Number.isFinite(n) ? n : 0;
      }
      case "true":
        if (!open.empty) leaf();
        return true;
      case "false":
        if (!open.empty) leaf();
        return false;
      case "date":
        return new Date(leaf().trim());
      case "data":
        return base64(leaf());
      default:
        throw new PlistError(`unknown plist element <${open.name}>`);
    }
  };

  // Skip the <plist> wrapper when there is one.
  if (tags[i]?.name === "plist" && !tags[i].close) i++;
  return value(0);
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function base64(s: string): Uint8Array {
  try {
    const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
