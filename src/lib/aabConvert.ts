/**
 * AAB → universal APK on this computer, with the website's converter (web/src/lib/aab2apk), the
 * one behind /aab-to-apk/. Only the parts a browser does differently live here: the file comes
 * from disk, the APK goes back to disk, and the test signing key is kept in a file next to the
 * BetaDrop config instead of the browser's IndexedDB.
 *
 * The key is the browser's in kind: an RSA-2048 key and a self-signed certificate made on this
 * machine, reused for every conversion so a newer APK installs over an older one. It is never the
 * developer's upload or release key, and it never leaves this machine.
 */
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { convert, preflight, STEPS } from "@/lib/aab2apk/convert";
import type { ConvertResult, Plan, RefusalReason } from "@/lib/aab2apk/convert";
import { ConvertRefused } from "@/lib/aab2apk/convert";
import { createTestKey } from "@/lib/aab2apk/testKey";
import type { TestKey } from "@/lib/aab2apk/testKey";
import { fileFromDisk } from "./fileChecks.js";

/** The website's refusals (AabToApkClient's REFUSAL_COPY), with "browser" read as this Node. */
export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  not_aab: "This isn't an Android App Bundle.",
  feature_module: "This bundle has feature modules, which the converter can't merge yet.",
  asset_pack: "This bundle has asset packs that Play delivers after install, which a single APK can't include here.",
  resources: "This bundle uses resource features the converter doesn't handle yet.",
  too_large: "Bundles over 250 MB are too big for the converter.",
  corrupt: "This file looks damaged or incomplete.",
  browser: "This Node.js lacks CompressionStream or WebCrypto, which the converter needs (Node 20 and newer have both).",
};

// ── The test key, on disk ────────────────────────────────────────────────────────────────

/** Same folder as config.json (lib/config.ts). */
function keyFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "betadrop", "aab-test-key.json") : path.join(os.homedir(), ".betadrop", "aab-test-key.json");
}

interface StoredKey {
  version: 1;
  pkcs8: string;
  certificate: string;
  publicKeyInfo: string;
  issuer: string;
  serial: string;
  sha1: string;
  sha256: string;
  createdAt: number;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const SIGN_PARAMS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function loadKey(): Promise<TestKey | null> {
  let stored: StoredKey;
  try {
    stored = JSON.parse(await fs.readFile(keyFilePath(), "utf8")) as StoredKey;
  } catch {
    return null;
  }
  if (stored?.version !== 1 || typeof stored.pkcs8 !== "string") return null;
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", unb64(stored.pkcs8), SIGN_PARAMS, false, ["sign"]);
    return {
      privateKey,
      certificate: unb64(stored.certificate),
      publicKeyInfo: unb64(stored.publicKeyInfo),
      issuer: unb64(stored.issuer),
      serial: unb64(stored.serial),
      sha1: stored.sha1,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
    };
  } catch {
    return null;
  }
}

/** A new key, saved (owner-only) for the conversions after this one. `stored` false when it couldn't be. */
async function newKey(): Promise<{ key: TestKey; stored: boolean }> {
  const key = await createTestKey(new Date(), { extractable: true });
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const stored: StoredKey = {
    version: 1,
    pkcs8: b64(pkcs8),
    certificate: b64(key.certificate),
    publicKeyInfo: b64(key.publicKeyInfo),
    issuer: b64(key.issuer),
    serial: b64(key.serial),
    sha1: key.sha1,
    sha256: key.sha256,
    createdAt: key.createdAt,
  };
  try {
    const file = keyFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(stored), { mode: 0o600 });
    await fs.rename(tmp, file);
    return { key, stored: true };
  } catch {
    return { key, stored: false };
  }
}

export interface KeyChoice {
  key: TestKey;
  /** made for this conversion (none was stored, or a new one was asked for) */
  created: boolean;
  /** a key existed before this one replaced it */
  replaced: boolean;
  stored: boolean;
  file: string;
}

export async function testKey(fresh: boolean): Promise<KeyChoice> {
  const existing = await loadKey();
  if (existing && !fresh) return { key: existing, created: false, replaced: false, stored: true, file: keyFilePath() };
  const made = await newKey();
  return { ...made, created: true, replaced: !!existing, file: keyFilePath() };
}

// ── Convert ──────────────────────────────────────────────────────────────────────────────

export class ConvertError extends Error {}

export interface Converted {
  plan: Plan;
  result: ConvertResult;
  key: KeyChoice;
  outputPath: string;
}

/**
 * Convert the bundle at `inputPath` and write the APK to `outputPath`. `onProgress` gets the step
 * name and the overall fraction (0..1). Throws ConvertError with the website's wording when the
 * bundle is refused.
 */
export async function convertAab(
  inputPath: string,
  outputPath: string,
  opts: { freshKey?: boolean; onProgress?: (fraction: number, step: string) => void } = {},
): Promise<Converted> {
  const plan = await preflight(await fileFromDisk(inputPath));
  if (plan.refused) {
    throw new ConvertError(plan.isApk ? "This is already an APK, so there is nothing to convert." : REFUSAL_TEXT[plan.reason]);
  }
  const key = await testKey(opts.freshKey === true);
  let last = -1;
  let result: ConvertResult;
  try {
    result = await convert(plan, key.key, ({ step, fraction }) => {
      // A whole-percent change at most, so a client is not flooded.
      const overall = Math.floor(((step + fraction) / STEPS.length) * 100);
      if (overall === last) return;
      last = overall;
      opts.onProgress?.(overall / 100, STEPS[step]);
    });
  } catch (error) {
    if (error instanceof ConvertRefused) throw new ConvertError(REFUSAL_TEXT[error.reason]);
    throw error;
  }

  // Written beside the target and renamed into place, so a failed write never leaves half an APK.
  const tmp = `${outputPath}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(result.apk.stream() as import("node:stream/web").ReadableStream), createWriteStream(tmp));
    await fs.rename(tmp, outputPath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return { plan, result, key, outputPath };
}
