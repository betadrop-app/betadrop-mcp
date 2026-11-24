/**
 * The two facts Google's developer verification keys on, read from an .apk in the browser: the
 * package name and the SHA-256 of the signing certificate. Nothing is uploaded; the file is read
 * a slice at a time through `Blob.slice`, so a 500 MB APK costs a few small reads.
 *
 * Built on the build icon check's readers (lib/appIcon/buildCheck): its zip reader for the
 * entries and its binary-XML parser for AndroidManifest.xml. What is new here is the signature:
 *
 *   - v2, v3 and v3.1 signatures live in the APK Signing Block, between the last file entry and
 *     the central directory, where no zip reader looks. It is found the way Android finds it:
 *     end record → central directory offset → the 24-byte footer just before it ("APK Sig Block
 *     42") → the block's id-value pairs. Each signer's signed data lists its certificates as
 *     length-prefixed DER, so no ASN.1 parsing is needed.
 *   - v1 (JAR) signatures are ordinary entries, META-INF/*.RSA, .DSA or .EC: a PKCS#7 SignedData
 *     whose certificate set is walked with the small DER reader below, picking the signer's own
 *     certificate by issuer and serial number. Read only when no v2+ certificate was found, and
 *     at most `MAX_V1_ENTRIES` of them.
 *
 * The fingerprint is SHA-256 over the certificate's DER bytes (WebCrypto), which is what
 * apksigner, keytool and Google's consoles print. Same order and same reading as the API's
 * `handlers/apk_cert.rs`, so the two agree on a file.
 *
 * Reads; never verifies. Nothing here checks that a signature covers the file.
 */

import { openZip, ZipError } from "../appIcon/buildCheck/zip";
import type { ByteSource } from "../appIcon/buildCheck/zip";
import { findAttribute, parseAxml, TYPE_STRING } from "../appIcon/buildCheck/axml";

export type SigningScheme = "v3.1" | "v3" | "v2" | "v1";

export interface ApkIdentity {
  /** From AndroidManifest.xml; null when the manifest could not be read. */
  packageName: string | null;
  /** 64 uppercase hex digits; null when the APK carries no readable certificate. */
  certSha256: string | null;
  /** Where that certificate was read from. */
  scheme: SigningScheme | null;
  /** Any other distinct certificates (key rotation, several signers), same form. v1 signatures
   *  are read only when there is no v2+ certificate, so a v1-only key beside one is not listed. */
  otherCertSha256: string[];
  /** True when signature material exists but no certificate could be read out of it. */
  signatureUnreadable: boolean;
}

/** Why a file could not be read as an APK at all. */
export type ApkReadProblem = "not_zip" | "aab" | "no_manifest";

export class ApkReadError extends Error {
  readonly problem: ApkReadProblem;
  constructor(problem: ApkReadProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** Block ids, newest scheme first: the order a certificate is preferred in. */
const SCHEME_IDS: [SigningScheme, number][] = [
  ["v3.1", 0x1b93ad61],
  ["v3", 0xf05368c0],
  ["v2", 0x7109871a],
];

const MAGIC = "APK Sig Block 42";
const EOCD = 0x06054b50;
/** Real signing blocks are a few KB; apksigner pads to 4 KB. Anything near this is not one. */
const MAX_SIGNING_BLOCK = 16 * 1024 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MAX_V1_ENTRY = 1024 * 1024;
/**
 * v1 signature files read at most. A real APK has one per signer, and in practice one. A hostile
 * zip can list thousands of `META-INF/*.RSA` names that all point at one large entry, and reading
 * each in turn hangs the tab; past this many, the rest are left unread and marked so.
 */
const MAX_V1_ENTRIES = 8;
/** More signers or certificates than any real APK has; stops a hostile file looping. */
const MAX_ITEMS = 64;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ── Reading ─────────────────────────────────────────────────────────────────────────────

export async function readApkIdentity(src: ByteSource): Promise<ApkIdentity> {
  let archive;
  try {
    archive = await openZip(src);
  } catch (error) {
    if (error instanceof ZipError) throw new ApkReadError("not_zip");
    throw error;
  }
  if (archive.size("AndroidManifest.xml") === undefined) {
    throw new ApkReadError(archive.size("base/manifest/AndroidManifest.xml") !== undefined ? "aab" : "no_manifest");
  }

  const packageName = readPackageName(await archive.read("AndroidManifest.xml", MAX_MANIFEST));

  // Certificates in preference order, as [scheme, DER] pairs.
  const found: [SigningScheme, Uint8Array][] = [];
  let unreadable = false;

  const block = await readSigningBlock(src);
  if (block) {
    for (const [scheme, id] of SCHEME_IDS) {
      for (const pair of block.filter((p) => p.id === id)) {
        const certs = signerCertificates(pair.value);
        if (certs.length === 0) unreadable = true;
        for (const der of certs) found.push([scheme, der]);
      }
    }
  }

  // v1 only when no newer scheme gave a certificate. Android verifies the newest scheme it has,
  // and a v1 certificate can never be the one chosen over it, so reading v1 then would only cost
  // time: on a hostile file, a lot of it.
  if (found.length === 0) {
    const v1Names = archive.names.filter((name) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name));
    if (v1Names.length > MAX_V1_ENTRIES) unreadable = true;
    for (const name of v1Names.slice(0, MAX_V1_ENTRIES)) {
      const bytes = await archive.read(name, MAX_V1_ENTRY);
      const der = bytes ? pkcs7SignerCertificate(bytes) : null;
      if (der) found.push(["v1", der]);
      else unreadable = true;
    }
  }

  const digests: { scheme: SigningScheme; hex: string }[] = [];
  for (const [scheme, der] of found) {
    const hex = await sha256Hex(der);
    if (!digests.some((d) => d.hex === hex)) digests.push({ scheme, hex });
  }

  return {
    packageName,
    certSha256: digests[0]?.hex ?? null,
    scheme: digests[0]?.scheme ?? null,
    otherCertSha256: digests.slice(1).map((d) => d.hex),
    signatureUnreadable: digests.length === 0 && unreadable,
  };
}

/** The `package` attribute of the manifest's root element, or null. */
export function readPackageName(manifest: Uint8Array | null): string | null {
  if (!manifest) return null;
  try {
    const root = parseAxml(manifest);
    if (root.name !== "manifest") return null;
    const attribute = findAttribute(root, 0, "package");
    const value =
      attribute?.value?.dataType === TYPE_STRING ? attribute.value.string : undefined;
    const name = (value ?? attribute?.raw ?? "").trim();
    return name || null;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

// ── The APK Signing Block ───────────────────────────────────────────────────────────────

export interface SigningBlockPair {
  id: number;
  value: Uint8Array;
}

/** A u64 as a Number, or null past 2^53 (no real file gets there). */
function u64(v: DataView, at: number): number | null {
  const hi = v.getUint32(at + 4, true);
  if (hi > 0x1fffff) return null;
  return hi * 0x100000000 + v.getUint32(at, true);
}

/**
 * The id-value pairs of the APK Signing Block, or null when the file has none (v1 only, or not
 * signed) or it is malformed. Never throws on a damaged file.
 */
export async function readSigningBlock(src: ByteSource): Promise<SigningBlockPair[] | null> {
  const tailLength = Math.min(src.size, 22 + 0xffff);
  if (tailLength < 22) return null;
  const tail = await src.read(src.size - tailLength, tailLength);
  const t = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // The end record whose comment runs exactly to the end of the file, as Android requires.
    if (t.getUint32(i, true) === EOCD && i + 22 + t.getUint16(i + 20, true) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const directoryOffset = t.getUint32(eocd + 16, true);
  // ZIP64 (0xffffffff): Android does not install those, so there is nothing to read.
  if (directoryOffset === 0xffffffff || directoryOffset < 32 || directoryOffset > src.size) return null;

  const footer = await src.read(directoryOffset - 24, 24);
  if (footer.length !== 24) return null;
  for (let i = 0; i < 16; i++) if (footer[8 + i] !== MAGIC.charCodeAt(i)) return null;
  const size = u64(view(footer), 0);
  if (size === null || size < 24 || size > MAX_SIGNING_BLOCK) return null;
  const start = directoryOffset - 8 - size;
  if (start < 0) return null;

  const block = await src.read(start, size + 8);
  if (block.length !== size + 8) return null;
  const b = view(block);
  if (u64(b, 0) !== size) return null;

  const pairs: SigningBlockPair[] = [];
  const end = block.length - 24;
  let p = 8;
  while (p + 12 <= end && pairs.length < MAX_ITEMS) {
    const length = u64(b, p);
    if (length === null || length < 4 || p + 8 + length > end) break;
    pairs.push({ id: b.getUint32(p + 8, true), value: block.subarray(p + 12, p + 8 + length) });
    p += 8 + length;
  }
  return pairs;
}

/** Length-prefixed (u32 LE) chunks, in order, from bytes[start, end). Stops at the first bad one. */
function chunks(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array[] {
  const out: Uint8Array[] = [];
  const v = view(bytes);
  let p = start;
  while (p + 4 <= end && out.length < MAX_ITEMS) {
    const length = v.getUint32(p, true);
    if (p + 4 + length > end) break;
    out.push(bytes.subarray(p + 4, p + 4 + length));
    p += 4 + length;
  }
  return out;
}

/**
 * The first certificate of each signer in a v2/v3/v3.1 value: signers → signer → signed data →
 * (digests, certificates) → first certificate. The first certificate is the signer's own; any
 * after it are its chain.
 */
export function signerCertificates(value: Uint8Array): Uint8Array[] {
  const [signers] = chunks(value);
  if (!signers) return [];
  const out: Uint8Array[] = [];
  for (const signer of chunks(signers)) {
    const [signedData] = chunks(signer);
    if (!signedData) continue;
    const [, certificates] = chunks(signedData);
    if (!certificates) continue;
    const [first] = chunks(certificates);
    if (first && first.length > 0) out.push(first);
  }
  return out;
}

// ── v1: PKCS#7 SignedData ───────────────────────────────────────────────────────────────

interface Tlv {
  tag: number;
  /** Where the tag byte is. */
  start: number;
  contentStart: number;
  contentEnd: number;
  /** One past the element (after the end-of-contents octets for an indefinite length). */
  end: number;
}

/**
 * One BER element at `pos`, within `limit`. Indefinite lengths are allowed on constructed
 * elements, because some old signers wrote the PKCS#7 wrapper that way; certificates inside are
 * DER either way. Null on anything malformed.
 */
function readTlv(b: Uint8Array, pos: number, limit: number, depth = 0): Tlv | null {
  if (depth > 32 || pos + 2 > limit) return null;
  const tag = b[pos];
  if ((tag & 0x1f) === 0x1f) return null; // high tag numbers: not in PKCS#7 or X.509
  const first = b[pos + 1];
  let p = pos + 2;
  if (first < 0x80) {
    const contentEnd = p + first;
    return contentEnd <= limit ? { tag, start: pos, contentStart: p, contentEnd, end: contentEnd } : null;
  }
  if (first === 0x80) {
    if ((tag & 0x20) === 0) return null;
    // Indefinite: walk the children to the end-of-contents octets.
    while (p + 2 <= limit) {
      if (b[p] === 0 && b[p + 1] === 0) return { tag, start: pos, contentStart: pos + 2, contentEnd: p, end: p + 2 };
      const child = readTlv(b, p, limit, depth + 1);
      if (!child) return null;
      p = child.end;
    }
    return null;
  }
  const count = first & 0x7f;
  if (count > 4 || p + count > limit) return null;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + b[p + i];
  p += count;
  const contentEnd = p + length;
  return contentEnd <= limit ? { tag, start: pos, contentStart: p, contentEnd, end: contentEnd } : null;
}

function children(b: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = parent.contentStart;
  while (p < parent.contentEnd && out.length < 256) {
    const child = readTlv(b, p, parent.contentEnd);
    if (!child) break;
    out.push(child);
    p = child.end;
  }
  return out;
}

const bytesOf = (b: Uint8Array, t: Tlv) => b.subarray(t.start, t.end);
const contentOf = (b: Uint8Array, t: Tlv) => b.subarray(t.contentStart, t.contentEnd);

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A certificate's issuer and serial number: TBSCertificate's optional [0] version, then serial, sig, issuer. */
function issuerAndSerial(b: Uint8Array, certificate: Tlv): { issuer: Uint8Array; serial: Uint8Array } | null {
  const [tbs] = children(b, certificate);
  if (!tbs || tbs.tag !== 0x30) return null;
  const fields = children(b, tbs);
  const i = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serial = fields[i];
  const issuer = fields[i + 2];
  if (serial?.tag !== 0x02 || issuer?.tag !== 0x30) return null;
  return { issuer: bytesOf(b, issuer), serial: contentOf(b, serial) };
}

/**
 * The signer's certificate from a v1 signature file (META-INF/*.RSA, .DSA, .EC): ContentInfo →
 * [0] SignedData → certificates [0], matched to the first SignerInfo by issuer and serial
 * number. Falls back to the first certificate when the SignerInfo names its signer another way.
 * Null when there is no certificate to read.
 */
export function pkcs7SignerCertificate(b: Uint8Array): Uint8Array | null {
  const contentInfo = readTlv(b, 0, b.length);
  if (!contentInfo || contentInfo.tag !== 0x30) return null;
  const wrapper = children(b, contentInfo).find((t) => t.tag === 0xa0);
  if (!wrapper) return null;
  const [signedData] = children(b, wrapper);
  if (!signedData || signedData.tag !== 0x30) return null;
  const fields = children(b, signedData);
  const certificateSet = fields.find((t) => t.tag === 0xa0);
  if (!certificateSet) return null;
  const certificates = children(b, certificateSet).filter((t) => t.tag === 0x30);
  if (certificates.length === 0) return null;

  const signerInfos = fields.filter((t) => t.tag === 0x31).pop();
  const [signerInfo] = signerInfos ? children(b, signerInfos) : [];
  const sid = signerInfo ? children(b, signerInfo)[1] : undefined;
  if (sid?.tag === 0x30) {
    const [issuer, serial] = children(b, sid);
    if (issuer?.tag === 0x30 && serial?.tag === 0x02) {
      const wanted = { issuer: bytesOf(b, issuer), serial: contentOf(b, serial) };
      const match = certificates.find((certificate) => {
        const id = issuerAndSerial(b, certificate);
        return !!id && equalBytes(id.issuer, wanted.issuer) && equalBytes(id.serial, wanted.serial);
      });
      if (match) return bytesOf(b, match);
    }
  }
  return bytesOf(b, certificates[0]);
}
