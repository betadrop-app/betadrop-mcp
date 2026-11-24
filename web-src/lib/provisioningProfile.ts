/**
 * Reading an Apple provisioning profile (`.mobileprovision` / `.provisionprofile`).
 *
 * The parsing here used to live inside `ProvisioningProfileDecoderClient`, which was fine while
 * one page needed it. `/exportoptions-plist-generator/` needs the same three things (lift the
 * plist out of the PKCS #7 envelope, work out the profile type, turn a certificate blob into
 * Base64) plus the team ID and bundle ID, so the logic moved here rather than being copied. The
 * decoder's behaviour is unchanged: it imports the same functions it used to declare.
 *
 * Deliberately dependency-free. No `@/` imports, no npm imports, no React: a value import of the
 * `@/` alias breaks any module a plain `node --test` file loads, and the plist XML parsing itself
 * stays with the callers (the decoder uses the `plist` package) so this module can be used from
 * anywhere. It is pure data handling, so it runs equally in the browser or in a test.
 */

/** The keys of the property list inside a provisioning profile that we actually read. */
export interface ProvisioningProfilePlist {
  Name?: string;
  AppIDName?: string;
  TeamName?: string;
  TeamIdentifier?: string[];
  UUID?: string;
  CreationDate?: string | Date;
  ExpirationDate?: string | Date;
  ProvisionedDevices?: string[];
  Entitlements?: Record<string, unknown>;
  /** Raw DER blobs, or Base64 strings on some producers. Normalise with `certToBase64`. */
  DeveloperCertificates?: unknown[];
  IsXcodeManaged?: boolean;
  ProvisionsAllDevices?: boolean;
  Platform?: string[];
  ApplicationIdentifierPrefix?: string[];
  Version?: number;
  TimeToLive?: number;
}

export type ProvisioningProfileType =
  | "Development"
  | "Ad Hoc"
  | "Enterprise (In-House)"
  | "App Store"
  | "Unknown";

/**
 * Pull the XML property list out of the signed container.
 *
 * A profile is a PKCS #7 signed message wrapping a plist. We do not verify the signature (this
 * is a viewer, not a validator), so the extraction is a scan for the plist between the XML
 * declaration and the closing tag.
 */
export function extractEmbeddedPlistXml(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const startIdx = text.indexOf("<?xml");
  if (startIdx === -1) {
    throw new Error(
      "This file doesn't contain an XML plist. Make sure it's a real .mobileprovision file (not a renamed IPA).",
    );
  }
  const endTag = "</plist>";
  const endIdx = text.lastIndexOf(endTag);
  if (endIdx === -1 || endIdx < startIdx) throw new Error("Couldn't find the end of the embedded plist.");
  return text.slice(startIdx, endIdx + endTag.length);
}

/**
 * Which of the four profile types this is, from the decoded fields.
 *
 * Development and ad hoc both carry a device list; the entitlement `get-task-allow` is what
 * separates them, because a debugger can only attach when it is true.
 */
export function detectProfileType(p: ProvisioningProfilePlist): ProvisioningProfileType {
  const isDev = p.Entitlements?.["get-task-allow"] === true;
  if (isDev && p.ProvisionedDevices && p.ProvisionedDevices.length > 0) return "Development";
  if (p.ProvisionsAllDevices) return "Enterprise (In-House)";
  if (p.ProvisionedDevices && p.ProvisionedDevices.length > 0) return "Ad Hoc";
  if (p.UUID) return "App Store";
  return "Unknown";
}

/**
 * DeveloperCertificates entries are DER bytes (a Buffer/Uint8Array from the plist `<data>`
 * element) or, occasionally, an already-Base64 string. Normalise both to Base64 for display.
 */
export function certToBase64(cert: unknown): string | undefined {
  try {
    if (typeof cert === "string") return cert;
    const bytes =
      cert instanceof Uint8Array
        ? cert
        : Array.isArray(cert)
          ? Uint8Array.from(cert as number[])
          : cert &&
              typeof cert === "object" &&
              "data" in (cert as Record<string, unknown>) &&
              Array.isArray((cert as { data: unknown }).data)
            ? Uint8Array.from((cert as { data: number[] }).data)
            : undefined;
    if (!bytes) return undefined;
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    return undefined;
  }
}

/**
 * The ten-character Apple Developer team identifier, the value the `teamID` key wants.
 *
 * `TeamIdentifier` is an array because a profile can in principle list more than one; the first
 * entry is the issuing team. `ApplicationIdentifierPrefix` carries the same value on every
 * profile we have seen, and is the fallback when the array is missing.
 */
export function profileTeamId(p: ProvisioningProfilePlist): string | undefined {
  const fromTeam = p.TeamIdentifier?.find((value) => typeof value === "string" && value.trim() !== "");
  if (fromTeam) return fromTeam.trim();
  const fromPrefix = p.ApplicationIdentifierPrefix?.find(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  return fromPrefix?.trim();
}

/**
 * The bundle identifier the profile covers, with the team prefix stripped.
 *
 * `application-identifier` reads `ABCDE12345.com.example.app`. A wildcard App ID ends in `*`,
 * which is not a usable key in the ExportOptions `provisioningProfiles` dictionary (that map is
 * keyed by the target's real bundle ID), so `isWildcard` is reported rather than hidden.
 */
export function profileBundleId(p: ProvisioningProfilePlist): {
  bundleId?: string;
  isWildcard: boolean;
} {
  const raw = p.Entitlements?.["application-identifier"];
  if (typeof raw !== "string" || raw.trim() === "") return { isWildcard: false };

  const value = raw.trim();
  const prefix = profileTeamId(p);
  const withoutPrefix =
    prefix && value.startsWith(`${prefix}.`) ? value.slice(prefix.length + 1) : value.replace(/^[A-Z0-9]{10}\./, "");

  return { bundleId: withoutPrefix || undefined, isWildcard: withoutPrefix.endsWith("*") };
}
