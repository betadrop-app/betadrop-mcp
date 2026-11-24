/**
 * The browser's test signing key: an RSA-2048 key made with WebCrypto (the
 * private key is non-extractable), a self-signed X.509 certificate for it,
 * and the PKCS#7 wrapper the v1 (JAR) signature needs. The key lives in this
 * browser's IndexedDB and is reused, so a second conversion can update the
 * first install.
 */

export const CERT_SUBJECT = "CN=Test build, OU=Converted from AAB in browser";
const VALIDITY_YEARS = 25;

export interface TestKey {
  privateKey: CryptoKey;
  /** DER X.509 certificate. */
  certificate: Uint8Array;
  /** DER SubjectPublicKeyInfo. */
  publicKeyInfo: Uint8Array;
  /** DER Name of the issuer (= subject). */
  issuer: Uint8Array;
  /** Serial number bytes (positive). */
  serial: Uint8Array;
  /** Uppercase colon-separated hex fingerprints of the certificate. */
  sha1: string;
  sha256: string;
  createdAt: number;
}

// ---- DER ----

export function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const len = content.reduce((n, c) => n + c.length, 0);
  const l = derLength(len);
  const out = new Uint8Array(1 + l.length + len);
  out[0] = tag;
  out.set(l, 1);
  let p = 1 + l.length;
  for (const c of content) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
export const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
const NULL = Uint8Array.of(0x05, 0x00);

export function derInteger(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && !(bytes[i + 1] & 0x80)) i++;
  const b = bytes.subarray(i);
  return b[0] & 0x80 ? tlv(0x02, Uint8Array.of(0), b) : tlv(0x02, b);
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const enc: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      enc.unshift(0x80 | (v & 0x7f));
      v = Math.floor(v / 128);
    }
    out.push(...enc);
  }
  return tlv(0x06, Uint8Array.from(out));
}

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_RSA = "1.2.840.113549.1.1.1";
export const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_CN = "2.5.4.3";
const OID_OU = "2.5.4.11";
const OID_DATA = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";

const algorithm = (o: string) => seq(oid(o), NULL);
const utf8String = (s: string) => tlv(0x0c, new TextEncoder().encode(s));

function derTime(d: Date): Uint8Array {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const rest = `${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050) return tlv(0x17, new TextEncoder().encode(`${p2(y % 100)}${rest}`));
  return tlv(0x18, new TextEncoder().encode(`${y}${rest}`));
}

/** Name for CERT_SUBJECT. RFC 4514 lists the last RDN first, so DER order is OU, CN. */
export function subjectName(): Uint8Array {
  return seq(
    set(seq(oid(OID_OU), utf8String("Converted from AAB in browser"))),
    set(seq(oid(OID_CN), utf8String("Test build"))),
  );
}

// ---- Key and certificate ----

export function hexFingerprint(digest: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: Uint8Array.of(1, 0, 1),
  hash: "SHA-256",
};

export function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.getRandomValues === "function";
}

export async function rsaSign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data as BufferSource));
}

/**
 * Make a new key and its self-signed certificate. Nothing is stored.
 *
 * `extractable` is for callers with no IndexedDB to keep a CryptoKey in (the MCP server keeps the
 * key in a file, so it has to export it). The browser leaves it off.
 */
export async function createTestKey(now = new Date(), opts: { extractable?: boolean } = {}): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, opts.extractable === true, ["sign", "verify"]);
  const publicKeyInfo = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 0x01;
  const name = subjectName();
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const tbs = seq(
    tlv(0xa0, derInteger(Uint8Array.of(2))),
    derInteger(serial),
    algorithm(OID_SHA256_RSA),
    name,
    seq(derTime(now), derTime(notAfter)),
    name,
    publicKeyInfo,
  );
  const signature = await rsaSign(pair.privateKey, tbs);
  const certificate = seq(tbs, algorithm(OID_SHA256_RSA), tlv(0x03, Uint8Array.of(0), signature));
  return {
    privateKey: pair.privateKey,
    certificate,
    publicKeyInfo,
    issuer: name,
    serial,
    sha1: hexFingerprint(await crypto.subtle.digest("SHA-1", certificate as BufferSource)),
    sha256: hexFingerprint(await crypto.subtle.digest("SHA-256", certificate as BufferSource)),
    createdAt: now.getTime(),
  };
}

/** PKCS#7 SignedData (detached, no signed attributes) for a v1 signature file. */
export function pkcs7SignedData(key: TestKey, signature: Uint8Array): Uint8Array {
  const signerInfo = seq(
    derInteger(Uint8Array.of(1)),
    seq(key.issuer, derInteger(key.serial)),
    algorithm(OID_SHA256),
    algorithm(OID_RSA),
    tlv(0x04, signature),
  );
  const signedData = seq(
    derInteger(Uint8Array.of(1)),
    set(algorithm(OID_SHA256)),
    seq(oid(OID_DATA)),
    tlv(0xa0, key.certificate),
    set(signerInfo),
  );
  return seq(oid(OID_SIGNED_DATA), tlv(0xa0, signedData));
}

// ---- IndexedDB ----

const DB_NAME = "betadrop-aab-to-apk";
const STORE = "keys";
const KEY_ID = "test-key";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function isTestKey(v: unknown): v is TestKey {
  const k = v as TestKey | undefined;
  return !!k && k.privateKey instanceof CryptoKey && k.certificate instanceof Uint8Array && typeof k.sha256 === "string";
}

/** The stored key, or null. */
export async function loadTestKey(): Promise<TestKey | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDb();
  try {
    const v = await tx<unknown>(db, "readonly", (s) => s.get(KEY_ID));
    return isTestKey(v) ? v : null;
  } finally {
    db.close();
  }
}

/**
 * Make a key and store it, replacing any earlier one. When storage is not
 * available (private windows in some browsers) the key still works for this
 * page visit, and `stored` is false.
 */
export async function newTestKey(): Promise<{ key: TestKey; stored: boolean }> {
  const key = await createTestKey();
  if (typeof indexedDB === "undefined") return { key, stored: false };
  try {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (s) => s.put(key, KEY_ID));
    } finally {
      db.close();
    }
    return { key, stored: true };
  } catch {
    return { key, stored: false };
  }
}

/** The stored key, or a new stored one. */
export async function getOrCreateTestKey(): Promise<{ key: TestKey; stored: boolean; created: boolean }> {
  try {
    const existing = await loadTestKey();
    if (existing) return { key: existing, stored: true, created: false };
  } catch {
    // Fall through to a new key.
  }
  const made = await newTestKey();
  return { ...made, created: true };
}
