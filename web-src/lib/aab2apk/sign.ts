/**
 * APK signing with the browser's test key: JAR (v1) signature files for
 * Android 6 and older, and the APK Signature Scheme v2 block.
 * https://source.android.com/docs/security/features/apksigning/v2
 */

import { utf8Encoder } from "./bytes";
import { pkcs7SignedData, rsaSign } from "./testKey";
import type { TestKey } from "./testKey";
import type { ZipWriter } from "./zipWriter";

const CREATED_BY = "1.0 (BetaDrop AAB to APK)";
export const V1_SF_NAME = "META-INF/TESTKEY.SF";
export const V1_RSA_NAME = "META-INF/TESTKEY.RSA";
export const V1_MF_NAME = "META-INF/MANIFEST.MF";

/** Files a v1 signature covers: everything except the signature files themselves. */
export function isV1SignatureFile(name: string): boolean {
  if (!name.startsWith("META-INF/")) return false;
  const rest = name.slice("META-INF/".length);
  if (rest.includes("/")) return false;
  if (rest === "MANIFEST.MF") return true;
  return /\.(SF|RSA|DSA|EC)$/i.test(rest) || /^SIG-/i.test(rest);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/** A manifest line, wrapped to at most 72 bytes per line the way apksigner wraps. */
function manifestLine(text: string): Uint8Array[] {
  const b = utf8Encoder.encode(text);
  const crlf = Uint8Array.of(13, 10);
  if (b.length <= 70) return [b, crlf];
  const out: Uint8Array[] = [b.subarray(0, 70), crlf];
  for (let p = 70; p < b.length; p += 69) out.push(Uint8Array.of(32), b.subarray(p, Math.min(b.length, p + 69)), crlf);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const BLANK = Uint8Array.of(13, 10);

/**
 * Build MANIFEST.MF, the .SF and the PKCS#7 .RSA for a v1 signature.
 * `digests` maps each covered entry name to the SHA-256 of its uncompressed bytes.
 */
export async function buildV1Files(digests: Map<string, Uint8Array>, key: TestKey): Promise<{ name: string; data: Uint8Array }[]> {
  const names = Array.from(digests.keys()).sort();
  const mfMain = join([...manifestLine("Manifest-Version: 1.0"), ...manifestLine(`Created-By: ${CREATED_BY}`), BLANK]);
  const sections = names.map((n) =>
    join([...manifestLine(`Name: ${n}`), ...manifestLine(`SHA-256-Digest: ${b64(digests.get(n) as Uint8Array)}`), BLANK]),
  );
  const mf = join([mfMain, ...sections]);

  const sfParts: Uint8Array[] = [
    ...manifestLine("Signature-Version: 1.0"),
    ...manifestLine(`Created-By: ${CREATED_BY}`),
    ...manifestLine(`SHA-256-Digest-Manifest: ${b64(await sha256(mf))}`),
    ...manifestLine(`SHA-256-Digest-Manifest-Main-Attributes: ${b64(await sha256(mfMain))}`),
    // Tells Android 7+ verifiers that a v2 signature must be present (anti-stripping).
    ...manifestLine("X-Android-APK-Signed: 2"),
    BLANK,
  ];
  for (let i = 0; i < names.length; i++) {
    sfParts.push(...manifestLine(`Name: ${names[i]}`), ...manifestLine(`SHA-256-Digest: ${b64(await sha256(sections[i]))}`), BLANK);
  }
  const sf = join(sfParts);
  const rsa = pkcs7SignedData(key, await rsaSign(key.privateKey, sf));
  return [
    { name: V1_MF_NAME, data: mf },
    { name: V1_SF_NAME, data: sf },
    { name: V1_RSA_NAME, data: rsa },
  ];
}

// ---- v2 ----

const CHUNK = 1024 * 1024;
const SIG_RSA_PKCS1_SHA256 = 0x0103;
const V2_BLOCK_ID = 0x7109871a;
const MAGIC = utf8Encoder.encode("APK Sig Block 42");

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, n % 0x100000000, true);
  v.setUint32(4, Math.floor(n / 0x100000000), true);
  return b;
}

const lp = (...parts: Uint8Array[]) => join([u32(parts.reduce((n, p) => n + p.length, 0)), ...parts]);

/** Iterate 1 MB chunks over a section made of several byte arrays. */
function* chunks(parts: Uint8Array[]): Generator<Uint8Array> {
  let buf = new Uint8Array(CHUNK);
  let fill = 0;
  for (const part of parts) {
    let p = 0;
    while (p < part.length) {
      if (fill === 0 && part.length - p >= CHUNK) {
        yield part.subarray(p, p + CHUNK);
        p += CHUNK;
        continue;
      }
      const n = Math.min(CHUNK - fill, part.length - p);
      buf.set(part.subarray(p, p + n), fill);
      fill += n;
      p += n;
      if (fill === CHUNK) {
        yield buf;
        buf = new Uint8Array(CHUNK);
        fill = 0;
      }
    }
  }
  if (fill > 0) yield buf.subarray(0, fill);
}

/** The v2 content digest of (entries, central directory, end record). */
export async function contentDigest(sections: Uint8Array[][], onChunk?: () => void | Promise<void>): Promise<Uint8Array> {
  const digests: Uint8Array[] = [];
  const prefix = new Uint8Array(5);
  prefix[0] = 0xa5;
  for (const section of sections) {
    const it = chunks(section);
    for (let r = it.next(); !r.done; r = it.next()) {
      const c = r.value;
      new DataView(prefix.buffer).setUint32(1, c.length, true);
      digests.push(await sha256(join([prefix, c])));
      if (onChunk) await onChunk();
    }
  }
  const head = new Uint8Array(5);
  head[0] = 0x5a;
  new DataView(head.buffer).setUint32(1, digests.length, true);
  return sha256(join([head, ...digests]));
}

/**
 * Sign the archive with v2 and return the APK's parts in order: entries,
 * signing block, central directory with the end record pointing past the block.
 */
export async function signV2(zip: ZipWriter, key: TestKey, onChunk?: () => void | Promise<void>): Promise<Uint8Array[]> {
  const entries = zip.parts;
  const cdAndEocd = zip.centralDirectory();
  const eocdAt = cdAndEocd.length - 22;
  const cd = cdAndEocd.subarray(0, eocdAt);
  const eocd = cdAndEocd.slice(eocdAt);
  const digest = await contentDigest([entries, [cd], [eocd]], onChunk);

  const signedData = join([
    lp(lp(u32(SIG_RSA_PKCS1_SHA256), lp(digest))),
    lp(lp(key.certificate)),
    lp(),
  ]);
  const signature = await rsaSign(key.privateKey, signedData);
  const signer = join([lp(signedData), lp(lp(u32(SIG_RSA_PKCS1_SHA256), lp(signature))), lp(key.publicKeyInfo)]);
  const value = lp(lp(signer));
  const pair = join([u64(4 + value.length), u32(V2_BLOCK_ID), value]);
  const blockSize = pair.length + 8 + MAGIC.length;
  const block = join([u64(blockSize), pair, u64(blockSize), MAGIC]);

  new DataView(eocd.buffer, eocd.byteOffset).setUint32(16, zip.length + block.length, true);
  return [...entries, block, cd, eocd];
}
