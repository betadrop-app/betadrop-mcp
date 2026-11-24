/**
 * 16 KB page size check for an .apk, .aab, .aar or bare .so, read in the browser.
 *
 * The file is told apart by its content, not its name. For a zip, only the central directory, the
 * manifest, BundleConfig.pb and, per .so entry, its local header and the first few hundred bytes
 * of its data (the ELF header and program header table) are read; a deflated library is inflated
 * only that far. Nothing is sent anywhere.
 *
 * The rules are Google's (https://developer.android.com/guide/practices/page-sizes); see elf.ts for
 * the ELF and RELRO checks and the readings taken where the sources are silent.
 */

import { abiOfMachine, checkLoadAlignment, checkRelro, readElf } from "./elf";
import type { ElfRead } from "./elf";
import { aabManifestFacts, apkManifestFacts, isBinaryXml, readBundleConfig, textManifestPackage } from "./manifest";
import type { ManifestFacts } from "./manifest";
import { PAGE_16K } from "./types";
import type {
  BundleNativeConfig,
  LibraryCheck,
  LibraryProblem,
  PageSizeFlag,
  PageSizeInputKind,
  PageSizeRefusal,
  PageSizeReport,
  PageSizeResult,
  PageSizeVerdict,
} from "./types";
import { blobSource, openZip, ZipError } from "./zip";
import type { ByteSource, Zip, ZipEntry } from "./zip";

export type * from "./types";
export { PAGE_16K } from "./types";

/** ABI folders whose libraries are 64-bit, used when the ELF header cannot say. */
const ABI_64 = new Set(["arm64-v8a", "x86_64", "riscv64", "mips64"]);
const MANIFEST_LIMIT = 16 * 1024 * 1024;
const CONFIG_LIMIT = 4 * 1024 * 1024;
/** Libraries checked at once: each is a couple of small reads. */
const CONCURRENCY = 4;
/** More .so entries than this and the file is refused (see checkArchive). */
export const MAX_LIBRARIES = 5000;

const refuse = (reason: PageSizeRefusal["reason"], detected?: PageSizeRefusal["detected"]): PageSizeRefusal =>
  detected ? { ok: false, reason, detected } : { ok: false, reason };

const extOf = (name: string) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
};
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Check a build for 16 KB page size support. The file is read by offset (the zip directory, the
 * first bytes of each library), never loaded whole and never sent anywhere.
 *
 * Never throws for a bad file: an unreadable or unsupported file comes back as a refusal.
 */
export async function checkPageSize(file: Blob, fileName: string): Promise<PageSizeResult> {
  try {
    return await checkSource(blobSource(file), fileName);
  } catch {
    return refuse("corrupt");
  }
}

/** The same check over any byte source (the tests use in-memory bytes). */
export async function checkSource(src: ByteSource, fileName: string): Promise<PageSizeResult> {
  const ext = extOf(fileName);
  const head = src.size >= 4 ? await src.read(0, 4) : new Uint8Array(0);
  const isElf = head.length === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  if (isElf) return checkBareSo(src, fileName);
  if (ext === "so") return refuse("corrupt");

  const looksZip = head.length === 4 && head[0] === 0x50 && head[1] === 0x4b;
  const zipNamed = ["apk", "aab", "aar", "apks", "xapk", "apkm", "ipa", "zip", "jar"].includes(ext);
  if (typeof DecompressionStream === "undefined") return refuse("browser");

  let zip: Zip;
  try {
    zip = await openZip(src);
  } catch (e) {
    if (e instanceof ZipError && !looksZip && !zipNamed) return refuse("unsupported_type", "other");
    return refuse("corrupt");
  }

  const { kind, manifest } = await detectZipKind(zip);
  if (kind === "ipa" || kind === "apk_set" || kind === "other") return refuse("unsupported_type", kind);

  try {
    return await checkArchive(src, zip, kind, fileName, manifest);
  } catch {
    return refuse("corrupt");
  }
}

type ZipKind = "apk" | "aab" | "aar" | "ipa" | "apk_set" | "other";

/** The kind, and the root AndroidManifest.xml when it was read to tell it (so it is inflated once). */
async function detectZipKind(zip: Zip): Promise<{ kind: ZipKind; manifest: Uint8Array | null }> {
  const names = zip.entries.map((e) => e.name);
  if (names.some((n) => /^Payload\/[^/]+\.app\//.test(n))) return { kind: "ipa", manifest: null };
  if (zip.get("BundleConfig.pb") && zip.get("base/manifest/AndroidManifest.xml")) return { kind: "aab", manifest: null };
  const entry = zip.get("AndroidManifest.xml");
  const manifest = entry ? await zip.read(entry, MANIFEST_LIMIT) : null;
  if (manifest && isBinaryXml(manifest)) return { kind: "apk", manifest };
  if (zip.get("classes.jar") || names.some((n) => n.startsWith("jni/"))) return { kind: "aar", manifest };
  // .apks (bundletool), .xapk and .apkm: a zip whose payload is .apk files.
  if (names.some((n) => n.toLowerCase().endsWith(".apk"))) return { kind: "apk_set", manifest: null };
  return { kind: "other", manifest: null };
}

interface Place {
  inLibFolder: boolean;
  abi: string | null;
  module?: string;
}

/**
 * Where a .so sits. A file in a subfolder below the ABI folder (lib/arm64-v8a/x/libfoo.so) counts
 * as in the library folder: the sources only say "lib/<abi>/", and counting it keeps a failure
 * from being hidden.
 */
function placeOf(kind: "apk" | "aab" | "aar", path: string): Place {
  if (kind === "apk") {
    const m = /^lib\/([^/]+)\/./.exec(path);
    return m ? { inLibFolder: true, abi: m[1] } : { inLibFolder: false, abi: null };
  }
  if (kind === "aar") {
    const m = /^jni\/([^/]+)\/./.exec(path);
    return m ? { inLibFolder: true, abi: m[1] } : { inLibFolder: false, abi: null };
  }
  const slash = path.indexOf("/");
  const moduleName = slash > 0 ? path.slice(0, slash) : undefined;
  if (moduleName === "BUNDLE-METADATA") return { inLibFolder: false, abi: null };
  const m = /^[^/]+\/lib\/([^/]+)\/./.exec(path);
  return m ? { inLibFolder: true, abi: m[1], module: moduleName } : { inLibFolder: false, abi: null, ...(moduleName ? { module: moduleName } : {}) };
}

async function checkArchive(src: ByteSource, zip: Zip, kind: "apk" | "aab" | "aar", fileName: string, rootManifest: Uint8Array | null): Promise<PageSizeReport> {
  // zipalign -P matches a name whose last "." starts ".so" exactly (ZipAlign.cpp getAlignment).
  const soEntries = zip.entries.filter((e) => e.name.endsWith(".so"));
  // No real app comes near this many libraries (large games ship tens); a crafted archive of a
  // million entries would otherwise take minutes. Past it the file is refused as damaged.
  if (soEntries.length > MAX_LIBRARIES) throw new ZipError("too many .so entries");
  // Android's zip reader refuses an archive with a duplicated entry name, so such a build cannot
  // install; judging only the first copy of a library could hide the one Android would never see.
  if (zip.duplicates.some((n) => n.endsWith(".so"))) throw new ZipError("duplicated .so entry");

  let facts: ManifestFacts = { packageName: null, targetSdk: null, extractNativeLibs: null, split: false };
  let bundle: BundleNativeConfig | undefined;
  if (kind === "apk") {
    if (rootManifest) facts = apkManifestFacts(rootManifest);
  } else if (kind === "aab") {
    const bytes = await zip.read(zip.get("base/manifest/AndroidManifest.xml")!, MANIFEST_LIMIT);
    if (bytes) facts = aabManifestFacts(bytes);
    bundle = readBundleConfig(await zip.read(zip.get("BundleConfig.pb")!, CONFIG_LIMIT));
  } else {
    if (rootManifest) facts = { ...facts, packageName: textManifestPackage(rootManifest) };
  }

  // A bad local header on any .so throws ZipError out of checkEntry: the file is refused as corrupt.
  const libraries = await mapLimit(soEntries, CONCURRENCY, (e) => checkEntry(zip, kind, e));
  return report(kind, fileName, src.size, libraries, facts, bundle);
}

async function checkEntry(zip: Zip, kind: "apk" | "aab" | "aar", e: ZipEntry): Promise<LibraryCheck> {
  const place = placeOf(kind, e.name);
  const dataOffset = await zip.dataOffset(e);
  let zipFact: LibraryCheck["zip"] = { status: "not_applicable" };
  if (kind === "apk") {
    if (e.method === 0) {
      zipFact = { status: dataOffset % PAGE_16K === 0 ? "aligned" : "unaligned", dataOffset };
    } else {
      zipFact = { status: "compressed" };
    }
  }
  let read: ElfRead = { kind: "unreadable" };
  const pr = await zip.prefix(e);
  if (pr) {
    try {
      read = await readElf((n) => pr.ensure(n));
    } finally {
      await pr.close();
    }
  }
  return libraryRow(e.name, place, e.size, read, zipFact);
}

async function checkBareSo(src: ByteSource, fileName: string): Promise<PageSizeResult> {
  const read = await readElf((n) => src.read(0, Math.min(n, src.size)));
  const is64 = read.kind === "elf" ? read.header.is64Bit : read.kind === "unreadable" ? read.is64Bit : undefined;
  // A .so whose ELF class byte cannot even be read is not a library this can describe.
  if (read.kind === "not_elf" || is64 === undefined) return refuse("corrupt");
  const name = baseName(fileName) || "library.so";
  const machine = read.kind === "elf" ? read.header.machine : read.machine;
  const place: Place = { inLibFolder: true, abi: machine !== undefined ? abiOfMachine(machine, is64) : null };
  const row = libraryRow(name, place, src.size, read, { status: "not_applicable" });
  return report("so", fileName, src.size, [row], { packageName: null, targetSdk: null, extractNativeLibs: null, split: false }, undefined);
}

function libraryRow(path: string, place: Place, size: number, read: ElfRead, zip: LibraryCheck["zip"]): LibraryCheck {
  let elf: LibraryCheck["elf"];
  let relro: LibraryCheck["relro"];
  let headerAbi: string | null = null;
  let is64Bit: boolean;
  if (read.kind === "elf") {
    elf = checkLoadAlignment(read.phdrs);
    relro = checkRelro(read.phdrs);
    is64Bit = read.header.is64Bit;
    headerAbi = abiOfMachine(read.header.machine, is64Bit);
  } else {
    elf = { status: read.kind === "not_elf" ? "not_elf" : "unreadable", minLoadAlign: null };
    relro = { status: "unknown" };
    is64Bit = read.kind === "unreadable" && read.is64Bit !== undefined ? read.is64Bit : place.abi !== null && ABI_64.has(place.abi);
  }
  const problems: LibraryProblem[] = [];
  if (elf.status === "unaligned") problems.push("elf");
  if (zip.status === "unaligned") problems.push("zip");
  if (relro.status === "misaligned") problems.push("relro");

  let result: LibraryCheck["result"];
  if (elf.status === "not_elf") {
    // Data shipped under a library name: Google's check_elf_alignment.sh skips non-ELF files, so it
    // is not subject, except that `zipalign -P 16` judges every name ending in .so, so one stored
    // off a 16 KB boundary in a 64-bit library folder of an APK still fails on zip.
    const sixtyFourFolder = place.inLibFolder && place.abi !== null && ABI_64.has(place.abi);
    result = sixtyFourFolder && zip.status === "unaligned" ? "fail" : "not_subject";
  } else if (!place.inLibFolder || !is64Bit) result = "not_subject";
  else if (problems.length) result = "fail";
  // ELF magic but headers that cannot be read, or an entry whose bytes cannot be read at all
  // (encrypted, or a compression method other than stored and deflate): nothing could be checked.
  else if (elf.status !== "aligned" || relro.status === "unknown") result = "unreadable";
  else result = "pass";

  return {
    path,
    name: baseName(path),
    abi: place.abi ?? headerAbi,
    ...(place.module ? { module: place.module } : {}),
    is64Bit,
    inLibFolder: place.inLibFolder,
    size,
    elf,
    zip,
    relro,
    result,
    problems,
  };
}

function report(
  kind: PageSizeInputKind,
  fileName: string,
  fileSize: number,
  libs: LibraryCheck[],
  facts: ManifestFacts,
  bundle: BundleNativeConfig | undefined,
): PageSizeReport {
  const failed = libs.filter((l) => l.result === "fail");
  const counts: PageSizeReport["counts"] = {
    total: libs.length,
    subject: libs.filter((l) => l.result !== "not_subject").length,
    passed: libs.filter((l) => l.result === "pass").length,
    failed: failed.length,
    elfFailed: failed.filter((l) => l.problems.includes("elf")).length,
    zipFailed: failed.filter((l) => l.problems.includes("zip")).length,
    relroFailed: failed.filter((l) => l.problems.includes("relro")).length,
    notSubject: libs.filter((l) => l.result === "not_subject").length,
    unreadable: libs.filter((l) => l.result === "unreadable").length,
  };

  const flags: PageSizeFlag[] = [];
  if (kind === "apk" && facts.split) flags.push("split_apk");
  if (kind === "apk") {
    const subjectZipFail = libs.some((l) => l.result !== "not_subject" && l.zip.status === "unaligned");
    const thirtyTwoZipFail = libs.some((l) => !l.is64Bit && l.inLibFolder && l.zip.status === "unaligned");
    if (thirtyTwoZipFail && !subjectZipFail) flags.push("zipalign_would_fail_32bit_only");
  }
  if (libs.some((l) => !l.inLibFolder)) flags.push("so_outside_lib");
  // Only where it matters: a bundle with no 64-bit library has nothing the 16 KB rule applies to,
  // so its alignment setting is not a problem to report. A set flag always means "not_supported".
  if (bundle && bundle.effectiveUncompressed && counts.subject > 0) {
    if (bundle.alignment === "4k") flags.push("bundle_alignment_4k");
    else if (bundle.alignment === "unspecified" && bundle.effectiveAlignment === "4k") flags.push("bundle_alignment_unspecified");
  }
  if (facts.targetSdk !== null && facts.targetSdk < 35) flags.push("target_below_35");

  const bundleFails = flags.includes("bundle_alignment_4k") || flags.includes("bundle_alignment_unspecified");
  let verdict: PageSizeVerdict;
  // Google: "If no shared object files are present or there is no lib folder, then your app doesn't
  // use native code." A .so only outside the library folders therefore reads as no native code
  // (with the so_outside_lib flag).
  if (!libs.some((l) => l.inLibFolder)) verdict = "no_native_code";
  else if (counts.subject === 0) verdict = "no_64bit";
  else if (counts.failed > 0 || bundleFails) verdict = "not_supported";
  else if (counts.unreadable > 0) verdict = "inconclusive";
  else verdict = "supported";

  const byPath = (a: LibraryCheck, b: LibraryCheck) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const libraries = [...failed.sort(byPath), ...libs.filter((l) => l.result !== "fail").sort(byPath)];

  return {
    ok: true,
    kind,
    fileName,
    fileSize,
    verdict,
    targetSdk: facts.targetSdk,
    packageName: facts.packageName,
    extractNativeLibs: facts.extractNativeLibs,
    libraries,
    counts,
    ...(bundle ? { bundle } : {}),
    flags,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
