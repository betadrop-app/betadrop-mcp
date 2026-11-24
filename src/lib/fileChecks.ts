/**
 * The checks `betadrop_inspect` runs on this computer, before (or without) asking the API.
 *
 * Every rule comes from the website's own readers in web/src/lib, imported rather than copied, so
 * the connector and the pages cannot drift: the 16 KB page size engine, the APK identity reader
 * behind the Android verification checker, the App Bundle inspector, and the provisioning profile
 * decoder. This file only opens the file and words the facts as report lines.
 *
 * Nothing here sends the file anywhere. The one network call is the Google registration lookup,
 * which sends the package name and certificate SHA-256 only (androidRegistration.ts).
 */
import { openAsBlob } from "node:fs";
import path from "node:path";
import { checkPageSize } from "@/lib/pageSize16k/index";
import type { LibraryCheck, PageSizeReport, PageSizeResult } from "@/lib/pageSize16k/index";
import { PLAY_DEADLINE, GOOGLE_PAGE_SIZES_URL } from "@/app/16kb-page-size-checker/facts";
import { ApkReadError, readApkIdentity, readSigningBlock } from "@/lib/androidVerification/apkIdentity";
import { colonHex } from "@/lib/androidVerification/format";
import { blobSource, openZip } from "@/lib/appIcon/buildCheck/zip";
import type { Archive } from "@/lib/appIcon/buildCheck/types";
import { isDict, parsePlist } from "@/lib/appIcon/buildCheck/plist";
import type { PlistValue } from "@/lib/appIcon/buildCheck/plist";
import { findAppPath } from "@/lib/appIcon/buildCheck/ios";
import {
  certToBase64,
  detectProfileType,
  extractEmbeddedPlistXml,
  profileBundleId,
  profileTeamId,
} from "@/lib/provisioningProfile";
import type { ProvisioningProfilePlist } from "@/lib/provisioningProfile";
import { analyzeAab } from "@/lib/aabAnalyzer";
import { lookupRegistration, registrationLine } from "./androidRegistration.js";

export type Level = "ok" | "warning" | "error";
export interface CheckLine {
  level: Level;
  message: string;
}
export interface Section {
  title: string;
  lines: CheckLine[];
}

/** What the local checks found: a heading, plain facts, marked checks, and a verdict of their own. */
export interface LocalReport {
  kind: "ipa" | "apk" | "aab" | "mobileprovision";
  heading: string;
  details: string[];
  sections: Section[];
  /** Used when there is no install-link verdict from the API (an .aab, a profile, or no sign-in). */
  verdict: string;
}

export const INSPECT_EXTENSIONS = [".ipa", ".apk", ".aab", ".mobileprovision", ".provisionprofile"] as const;

const ok = (message: string): CheckLine => ({ level: "ok", message });
const warn = (message: string): CheckLine => ({ level: "warning", message });
const fail = (message: string): CheckLine => ({ level: "error", message });

export const mark = (level: Level) => (level === "error" ? "✗" : level === "warning" ? "!" : "✓");

/** The file as a Blob read from disk on demand, the way the pages read a dropped File. */
export async function fileBlob(filePath: string): Promise<Blob> {
  return (await openAsBlob(filePath)) as unknown as Blob;
}

/** A File the readers that want one (the AAB inspector, the converter) can take. Not read here. */
export async function fileFromDisk(filePath: string): Promise<File> {
  return new File([await fileBlob(filePath)], path.basename(filePath));
}

function human(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function shortDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysUntil(d: Date): number {
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

const asDate = (v: unknown): Date | null => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

// ── Run ──────────────────────────────────────────────────────────────────────────────────

export async function localChecks(filePath: string): Promise<LocalReport> {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const blob = await fileBlob(filePath);
  switch (ext) {
    case ".apk":
      return apkChecks(blob, name);
    case ".aab":
      return aabChecks(filePath, blob, name);
    case ".ipa":
      return ipaChecks(blob, name);
    default:
      return profileChecks(blob, name);
  }
}

// ── 16 KB page size (APK, AAB) ───────────────────────────────────────────────────────────

const PROBLEM_WORDS: Record<LibraryCheck["problems"][number], string> = {
  elf: "LOAD segments not 16 KB aligned",
  zip: "stored uncompressed off a 16 KB boundary",
  relro: "RELRO end not 16 KB aligned",
};

/** The 16 KB section: the verdict, failing libraries (up to 10), and the flags that change its meaning. */
export function pageSizeSection(result: PageSizeResult): Section {
  const title = "16 KB page size";
  if (!result.ok) {
    return { title, lines: [warn("The 16 KB page size check couldn't read this file's libraries.")] };
  }
  const r: PageSizeReport = result;
  const { counts } = r;
  const noun = r.kind === "aab" ? "This bundle" : "This APK";
  const lines: CheckLine[] = [];
  switch (r.verdict) {
    case "supported":
      lines.push(
        ok(
          `${noun} supports 16 KB page sizes: ${plural(counts.passed, "64-bit library", "64-bit libraries")} pass ` +
            (r.kind === "aab"
              ? `the ELF alignment and RELRO checks, and the bundle's settings give its APKs ${r.bundle && !r.bundle.effectiveUncompressed ? "compressed libraries" : "libraries on 16 KB boundaries"}.`
              : "the ELF alignment, zip alignment and RELRO checks."),
        ),
      );
      break;
    case "no_native_code":
      lines.push(ok("No native libraries, so nothing to align for 16 KB page sizes."));
      break;
    case "no_64bit":
      lines.push(ok("No 64-bit libraries, so Google's 16 KB rule (for 64-bit devices) doesn't apply."));
      break;
    case "inconclusive":
      lines.push(
        warn(
          `16 KB page size: no library failed, but ${plural(counts.unreadable, "64-bit library", "64-bit libraries")} couldn't be read.`,
        ),
      );
      break;
    case "not_supported": {
      const what =
        counts.failed === 0
          ? "the libraries pass, but the bundle's settings give the APKs built from it uncompressed libraries on 4 KB boundaries"
          : `${counts.failed} of ${plural(counts.subject, "64-bit library", "64-bit libraries")} ${counts.failed === 1 ? "fails" : "fail"}`;
      lines.push(
        fail(
          `${noun} does not support 16 KB page sizes: ${what}. From ${PLAY_DEADLINE}, Google Play refuses updates without 16 KB support for apps targeting Android 15 (API 35) and higher. Fixes: ${GOOGLE_PAGE_SIZES_URL}`,
        ),
      );
      break;
    }
  }
  const failed = r.libraries.filter((l) => l.result === "fail");
  for (const lib of failed.slice(0, 10)) {
    const why = lib.problems.map((p) => PROBLEM_WORDS[p]);
    if (lib.problems.includes("elf") && lib.elf.minLoadAlign !== null) why[0] += ` (${lib.elf.minLoadAlign / 1024} KB)`;
    lines.push(fail(`${lib.path}: ${why.join("; ")}`));
  }
  if (failed.length > 10) lines.push(fail(`…and ${failed.length - 10} more libraries`));

  for (const flag of r.flags) {
    switch (flag) {
      case "bundle_alignment_4k":
        lines.push(fail("BundleConfig.pb asks for uncompressed libraries on 4 KB boundaries (PAGE_ALIGNMENT_4K)."));
        break;
      case "bundle_alignment_unspecified":
        lines.push(
          fail(
            `Built with bundletool ${r.bundle?.bundletoolVersion ?? "(version not recorded)"}, which aligns uncompressed libraries to 4 KB when the bundle names no alignment (16 KB is the default from 1.17.0).`,
          ),
        );
        break;
      case "split_apk":
        lines.push(warn("This APK is one part of a split set; the app's libraries may be in another part."));
        break;
      case "zipalign_would_fail_32bit_only":
        lines.push(warn("Some uncompressed 32-bit libraries are off a 16 KB boundary: no effect on 16 KB support, but `zipalign -c -P 16` reports the APK as failed."));
        break;
      case "so_outside_lib":
        lines.push(warn("Some .so files sit outside the library folders (for example under assets/); they don't change the result."));
        break;
      case "target_below_35":
        // Facts only: the target SDK is listed with the app's details.
        break;
    }
  }
  return { title, lines };
}

// ── APK ──────────────────────────────────────────────────────────────────────────────────

const SCHEME_IDS: [string, number][] = [
  ["v2", 0x7109871a],
  ["v3", 0xf05368c0],
  ["v3.1", 0x1b93ad61],
];

async function apkChecks(blob: Blob, name: string): Promise<LocalReport> {
  const src = blobSource(blob);
  const details: string[] = [];
  const sections: Section[] = [];
  let packageName: string | null = null;
  let certSha256: string | null = null;

  // Signing: which schemes are present (the APK signature checker's question), and the
  // certificate Android checks (the verification checker's).
  const signing: CheckLine[] = [];
  try {
    const identity = await readApkIdentity(src);
    packageName = identity.packageName;
    certSha256 = identity.certSha256;
    const schemes: string[] = [];
    const archive = await openZip(src);
    if (archive.names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n))) schemes.push("v1");
    const block = await readSigningBlock(src);
    for (const [scheme, id] of SCHEME_IDS) if (block?.some((p) => p.id === id)) schemes.push(scheme);

    if (identity.certSha256) {
      signing.push(ok(`Signed with APK Signature Scheme ${schemes.join(", ") || identity.scheme}.`));
      details.push(`Signing certificate SHA-256: ${colonHex(identity.certSha256)}`);
      if (identity.otherCertSha256.length) {
        details.push(`Also signed with: ${identity.otherCertSha256.map(colonHex).join(", ")}`);
      }
    } else if (identity.signatureUnreadable) {
      signing.push(warn("The APK has signature data, but its signing certificate couldn't be read."));
    } else {
      signing.push(fail("Not signed. Android won't install an unsigned APK."));
    }
    if (!identity.packageName) signing.push(warn("The package name couldn't be read from AndroidManifest.xml."));
  } catch (error) {
    const problem = error instanceof ApkReadError ? error.problem : null;
    signing.push(
      fail(
        problem === "aab"
          ? "This is an App Bundle with an .apk name."
          : problem === "no_manifest"
            ? "No AndroidManifest.xml, so this isn't an APK."
            : "This file couldn't be read as an APK. It may be damaged.",
      ),
    );
  }
  sections.push({ title: "Signing", lines: signing });

  const pageSize = await checkPageSize(blob, name);
  if (pageSize.ok) {
    packageName ??= pageSize.packageName;
    if (pageSize.targetSdk !== null) details.unshift(`targetSdk ${pageSize.targetSdk}`);
  }
  sections.push(pageSizeSection(pageSize));

  if (packageName && certSha256) {
    const outcome = await lookupRegistration(packageName, certSha256);
    sections.push({ title: "Google developer verification", lines: [registrationLine(outcome)] });
  }

  return {
    kind: "apk",
    heading: `**${name}** · android${packageName ? ` · ${packageName}` : ""}`,
    details,
    sections,
    verdict: localVerdict(sections),
  };
}

// ── AAB ──────────────────────────────────────────────────────────────────────────────────

async function aabChecks(filePath: string, blob: Blob, name: string): Promise<LocalReport> {
  const details: string[] = [];
  const sections: Section[] = [];
  let heading = `**${name}** · android app bundle`;
  try {
    const a = await analyzeAab(await fileFromDisk(filePath));
    const m = a.manifest;
    heading = `**${name}** ${m.versionName ?? ""}${m.versionCode ? ` (${m.versionCode})` : ""} · android app bundle${m.packageName ? ` · ${m.packageName}` : ""}`;
    details.push(`minSdk ${m.minSdk ?? "?"}, targetSdk ${m.targetSdk ?? "?"}, debuggable ${m.debuggable}`);
    details.push(
      `Modules: ${a.modules.map((mod) => (mod.kind === "base" ? mod.name : `${mod.name} (${mod.kind}, ${mod.delivery})`)).join(", ")}`,
    );
    const abis = a.delivery.abi?.available;
    details.push(
      `Bundle ${human(a.delivery.bundleBytes)}; a typical device downloads about ${human(a.delivery.deviceBytes)}` +
        (abis?.length ? ` (ABIs: ${abis.join(", ")})` : ""),
    );
    if (m.permissions.length) details.push(`Permissions: ${m.permissions.length}`);

    const lines: CheckLine[] = [];
    lines.push(a.signed ? ok("Signed for upload (JAR signature in META-INF).") : warn("No upload signature in META-INF: Google Play refuses an unsigned bundle."));
    for (const f of a.findings) {
      if (f.title.startsWith("No JAR signature")) continue; // said above
      if (f.severity === "high") lines.push(fail(`${f.title}. ${f.detail}`));
      else if (f.severity === "warning") lines.push(warn(`${f.title}. ${f.detail}`));
      else if (f.severity === "secure") lines.push(ok(f.title));
      else details.push(`${f.title}: ${f.detail}`);
    }
    sections.push({ title: "Bundle", lines });
  } catch (error) {
    sections.push({ title: "Bundle", lines: [fail(error instanceof Error ? error.message : "This bundle couldn't be read.")] });
  }
  sections.push(pageSizeSection(await checkPageSize(blob, name)));
  const problems = countErrors(sections);
  return {
    kind: "aab",
    heading,
    details,
    sections,
    verdict:
      (problems ? `Verdict: ${plural(problems, "✗ item")} above. ` : "Verdict: no problems found in the bundle. ") +
      "An .aab doesn't install from a link (Google Play builds device APKs from it); betadrop_convert_aab makes a universal .apk from it, signed with a test key.",
  };
}

// ── iOS: Info.plist and the provisioning profile ─────────────────────────────────────────

function str(v: PlistValue | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The profile's checks, for an .ipa's embedded profile or a .mobileprovision on its own. */
function profileLines(p: ProvisioningProfilePlist, appBundleId?: string): CheckLine[] {
  const lines: CheckLine[] = [];
  const type = detectProfileType(p);
  const team = `${p.TeamName ?? "?"} (${profileTeamId(p) ?? "?"})`;
  const label = p.Name ? `"${p.Name}"` : "";
  if (type === "App Store") {
    lines.push(fail(`App Store profile ${label}, team ${team}: iOS installs it only through the App Store or TestFlight, never from a link.`));
  } else if (type === "Unknown") {
    lines.push(warn(`Profile ${label} of an unknown type, team ${team}.`));
  } else {
    lines.push(ok(`${type} profile ${label}, team ${team}.`));
  }

  const expires = asDate(p.ExpirationDate);
  if (!expires) lines.push(warn("The profile has no readable expiry date."));
  else {
    const days = daysUntil(expires);
    if (days < 0) lines.push(fail(`Expired on ${shortDate(expires)}: iOS refuses to open an app whose profile has expired.`));
    else if (days <= 14) lines.push(warn(`Expires on ${shortDate(expires)}, in ${plural(days, "day")}.`));
    else lines.push(ok(`Valid until ${shortDate(expires)} (${plural(days, "day")}).`));
  }

  if (p.ProvisionsAllDevices) lines.push(ok("Installs on any device (Enterprise)."));
  else if (type === "Development" || type === "Ad Hoc") {
    const n = p.ProvisionedDevices?.length ?? 0;
    lines.push(n > 0 ? ok(`${plural(n, "device")} listed; iOS installs it only on those.`) : fail("The profile lists no devices, so iOS refuses to install it on any iPhone or iPad."));
  } else if (type === "Unknown") {
    lines.push(fail("The profile lists no devices, so iOS refuses to install it on any iPhone or iPad."));
  }

  const { bundleId, isWildcard } = profileBundleId(p);
  if (appBundleId && bundleId) {
    const matches = isWildcard ? appBundleId.startsWith(bundleId.slice(0, -1)) : bundleId === appBundleId;
    lines.push(
      matches
        ? ok(`Covers the app's bundle ID ${appBundleId}${isWildcard ? ` (wildcard ${bundleId})` : ""}.`)
        : fail(`The profile is for ${bundleId}, but the app's bundle ID is ${appBundleId}.`),
    );
  }
  return lines;
}

function profileFromBytes(bytes: Uint8Array): ProvisioningProfilePlist {
  const xml = extractEmbeddedPlistXml(bytes);
  const value = parsePlist(new TextEncoder().encode(xml));
  if (!isDict(value)) throw new Error("The profile's property list isn't a dictionary.");
  return value as unknown as ProvisioningProfilePlist;
}

async function ipaChecks(blob: Blob, name: string): Promise<LocalReport> {
  const details: string[] = [];
  const sections: Section[] = [];
  let heading = `**${name}** · ios`;
  let archive: Archive;
  try {
    archive = await openZip(blobSource(blob));
  } catch {
    return { kind: "ipa", heading, details, sections: [{ title: "App", lines: [fail("This file couldn't be read as an .ipa (zip). It may be damaged.")] }], verdict: "Verdict: not an installable .ipa." };
  }
  const appPath = findAppPath(archive.names);
  if (!appPath) {
    return { kind: "ipa", heading, details, sections: [{ title: "App", lines: [fail("No Payload/*.app folder, so this isn't an iOS app archive.")] }], verdict: "Verdict: not an installable .ipa." };
  }

  let bundleId: string | undefined;
  const infoBytes = await archive.read(`${appPath}Info.plist`, 8 * 1024 * 1024);
  const appLines: CheckLine[] = [];
  if (infoBytes) {
    try {
      const info = parsePlist(infoBytes);
      if (isDict(info)) {
        bundleId = str(info.CFBundleIdentifier);
        const display = str(info.CFBundleDisplayName) ?? str(info.CFBundleName);
        const version = str(info.CFBundleShortVersionString);
        const build = str(info.CFBundleVersion);
        heading = `**${display ?? name}** ${version ?? ""}${build ? ` (${build})` : ""} · ios${bundleId ? ` · ${bundleId}` : ""}`;
        const minOs = str(info.MinimumOSVersion);
        if (minOs) details.push(`Minimum iOS ${minOs}`);
      }
    } catch {
      appLines.push(warn("Info.plist couldn't be read."));
    }
  } else {
    appLines.push(fail("The app has no Info.plist."));
  }
  if (appLines.length) sections.push({ title: "App", lines: appLines });

  const profileBytes = await archive.read(`${appPath}embedded.mobileprovision`, 4 * 1024 * 1024);
  if (!profileBytes) {
    sections.push({
      title: "Provisioning profile",
      lines: [fail("No embedded.mobileprovision: the app isn't signed for distribution (a simulator or unsigned build), so it won't install on a device.")],
    });
  } else {
    try {
      sections.push({ title: "Provisioning profile", lines: profileLines(profileFromBytes(profileBytes), bundleId) });
    } catch (error) {
      sections.push({ title: "Provisioning profile", lines: [warn(`The embedded profile couldn't be decoded: ${error instanceof Error ? error.message : String(error)}`)] });
    }
  }
  return { kind: "ipa", heading, details, sections, verdict: localVerdict(sections) };
}

function entitlementValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(entitlementValue).join(", ");
  return JSON.stringify(value);
}

async function profileChecks(blob: Blob, name: string): Promise<LocalReport> {
  let p: ProvisioningProfilePlist;
  try {
    p = profileFromBytes(new Uint8Array(await blob.arrayBuffer()));
  } catch (error) {
    return {
      kind: "mobileprovision",
      heading: `**${name}** · provisioning profile`,
      details: [],
      sections: [{ title: "Profile", lines: [fail(error instanceof Error ? error.message : "This profile couldn't be decoded.")] }],
      verdict: "Verdict: not a readable provisioning profile.",
    };
  }
  const { bundleId, isWildcard } = profileBundleId(p);
  const details: string[] = [];
  if (p.UUID) details.push(`UUID ${p.UUID}`);
  if (bundleId) details.push(`App ID ${bundleId}${isWildcard ? " (wildcard)" : ""}${p.AppIDName ? ` — ${p.AppIDName}` : ""}`);
  if (p.Platform?.length) details.push(`Platform: ${p.Platform.join(", ")}`);
  const created = asDate(p.CreationDate);
  if (created) details.push(`Created ${shortDate(created)}${p.IsXcodeManaged ? ", Xcode-managed" : ""}`);
  const certs = (p.DeveloperCertificates ?? []).map(certToBase64).filter(Boolean);
  details.push(`${plural(certs.length, "developer certificate")}`);
  const entitlements = Object.entries(p.Entitlements ?? {});
  if (entitlements.length) {
    details.push(`Entitlements (${entitlements.length}):\n${entitlements.map(([k, v]) => `  - ${k} = ${entitlementValue(v)}`).join("\n")}`);
  }
  const devices = p.ProvisionedDevices ?? [];
  if (devices.length) {
    const shown = devices.slice(0, 100);
    details.push(
      `Devices (${devices.length}):\n${shown.map((d) => `  - ${d}`).join("\n")}${devices.length > shown.length ? `\n  - …and ${devices.length - shown.length} more` : ""}`,
    );
  }
  const sections: Section[] = [{ title: "Profile", lines: profileLines(p) }];
  const type = detectProfileType(p);
  const expires = asDate(p.ExpirationDate);
  const problems = countErrors(sections);
  return {
    kind: "mobileprovision",
    heading: `**${p.Name ?? name}** · ${type} provisioning profile · team ${p.TeamName ?? "?"} (${profileTeamId(p) ?? "?"})`,
    details,
    sections,
    verdict: problems
      ? `Verdict: ${plural(problems, "✗ item")} above; builds signed with this profile won't install from a link.`
      : `Verdict: ${/^[AEIOU]/.test(type) ? "an" : "a"} ${type} profile${expires ? `, valid until ${shortDate(expires)}` : ""}; builds signed with it can install from a link${type === "Enterprise (In-House)" ? " on any device" : " on the devices it lists"}.`,
  };
}

// ── Wording ──────────────────────────────────────────────────────────────────────────────

export function countErrors(sections: Section[]): number {
  return sections.reduce((n, s) => n + s.lines.filter((l) => l.level === "error").length, 0);
}

function localVerdict(sections: Section[]): string {
  const errors = countErrors(sections);
  const warnings = sections.reduce((n, s) => n + s.lines.filter((l) => l.level === "warning").length, 0);
  if (errors) return `Local checks: ${plural(errors, "✗ item")}${warnings ? ` and ${plural(warnings, "! item")}` : ""} above.`;
  if (warnings) return `Local checks: no ✗ items, ${plural(warnings, "! item")} above.`;
  return "Local checks: no problems found.";
}

/** The sections as text: a bold title per section, then its marked lines. */
export function renderSections(sections: Section[]): string {
  return sections
    .filter((s) => s.lines.length)
    .map((s) => `**${s.title}**\n${s.lines.map((l) => `${mark(l.level)} ${l.message}`).join("\n")}`)
    .join("\n\n");
}
