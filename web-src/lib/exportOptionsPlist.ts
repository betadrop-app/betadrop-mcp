/**
 * ExportOptions.plist, the xcodebuild line and the fastlane block that /exportoptions-plist-generator/
 * shows. The text used to be built inside ExportOptionsPlistClient; it moved here so the BetaDrop
 * MCP server writes the same file from the same code. The page's behaviour is unchanged: it
 * imports what it used to declare.
 *
 * The method list is the current set of distribution options Apple names in its own
 * documentation, checked on 2026-09-03; the page prose carries the sources. `ad-hoc` is
 * deliberately not offered: Xcode 15.4 deprecated it. Current Xcode (27.0 checked 2026-09-28)
 * still accepts it with a warning, so it is not a failing value, but a generator should emit the
 * current name rather than the alias.
 *
 * The fastlane block archives with gym and exports with xcodebuild rather than passing the method
 * to gym, because every released gym (to 2.240.1, checked 2026-09-24) validates export_method,
 * and a method inside export_options, against the OLD names and fails on release-testing,
 * app-store-connect and debugging with "Unsupported export_method". It also cannot print gym's
 * export_method with the legacy alias: validate-seo.mjs FORBIDDEN_PHRASES fails the build on
 * that string in rendered HTML.
 *
 * Deliberately dependency-free: no `@/` imports, no npm imports, no React.
 */

import type { ProvisioningProfileType } from "./provisioningProfile";

export type ExportMethod =
  | "app-store-connect"
  | "release-testing"
  | "enterprise"
  | "debugging"
  | "developer-id";

export const EXPORT_METHODS: { value: ExportMethod; label: string; hint: string }[] = [
  {
    value: "app-store-connect",
    label: "App Store Connect",
    hint: "TestFlight and App Store submissions. Replaces the old app-store value.",
  },
  {
    value: "release-testing",
    label: "Release testing",
    hint: "Builds for devices registered to your team. Replaces the old ad-hoc value.",
  },
  {
    value: "enterprise",
    label: "Enterprise",
    hint: "In-house distribution under the Apple Developer Enterprise Program.",
  },
  {
    value: "debugging",
    label: "Debugging",
    hint: "A build to install and debug on registered devices. Named development on older Xcode.",
  },
  {
    value: "developer-id",
    label: "Developer ID",
    hint: "Direct distribution of a notarized macOS app, outside the Mac App Store.",
  },
];

export const THINNING_OPTIONS: { value: string; label: string }[] = [
  { value: "<none>", label: "None: one universal, non-thinned app" },
  { value: "<thin-for-all-variants>", label: "All variants: universal app plus every thinned build" },
];

/** XML text escaping for the values that end up inside `<string>` elements. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Ruby string escaping for the fastlane snippet. */
function rubyEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Shell-safe enough for a path we print into a copyable command. */
function shellPath(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ExportOptionsForm {
  method: ExportMethod;
  teamId: string;
  signingStyle: "automatic" | "manual";
  bundleId: string;
  profileName: string;
  signingCertificate: string;
  destination: "export" | "upload";
  thinning: string;
  stripSwiftSymbols: boolean;
  uploadSymbols: boolean;
  scheme: string;
  /**
   * Further provisioningProfiles entries after bundleId → profileName, for an archive with app
   * extensions (manual signing only). The page never sets it.
   */
  extraProfiles?: ReadonlyArray<readonly [bundleId: string, profileName: string]>;
}

export const EXPORT_OPTIONS_INITIAL: ExportOptionsForm = {
  method: "release-testing",
  teamId: "",
  signingStyle: "manual",
  bundleId: "",
  profileName: "",
  signingCertificate: "",
  destination: "export",
  thinning: "<none>",
  stripSwiftSymbols: true,
  uploadSymbols: true,
  scheme: "",
};

export const EXPORT_OPTIONS_PLACEHOLDER = {
  teamId: "ABCDE12345",
  bundleId: "com.example.app",
  profileName: "MyApp Release Testing",
  scheme: "MyApp",
  signingCertificate: "Apple Distribution",
};

export function buildExportOptionsPlist(form: ExportOptionsForm): string {
  const lines: string[] = [];
  const push = (key: string, value: string) => {
    lines.push(`\t<key>${key}</key>`);
    lines.push(`\t${value}`);
  };

  push("method", `<string>${xmlEscape(form.method)}</string>`);
  if (form.teamId.trim()) push("teamID", `<string>${xmlEscape(form.teamId.trim())}</string>`);
  push("signingStyle", `<string>${form.signingStyle}</string>`);

  if (form.signingStyle === "manual") {
    const bundleId = form.bundleId.trim() || EXPORT_OPTIONS_PLACEHOLDER.bundleId;
    const profileName = form.profileName.trim() || EXPORT_OPTIONS_PLACEHOLDER.profileName;
    lines.push("\t<key>provisioningProfiles</key>");
    lines.push("\t<dict>");
    for (const [id, name] of [[bundleId, profileName] as const, ...(form.extraProfiles ?? [])]) {
      lines.push(`\t\t<key>${xmlEscape(id)}</key>`);
      lines.push(`\t\t<string>${xmlEscape(name)}</string>`);
    }
    lines.push("\t</dict>");
    if (form.signingCertificate.trim()) {
      push("signingCertificate", `<string>${xmlEscape(form.signingCertificate.trim())}</string>`);
    }
  }

  push("destination", `<string>${form.destination}</string>`);
  push("thinning", `<string>${xmlEscape(form.thinning)}</string>`);
  push("stripSwiftSymbols", form.stripSwiftSymbols ? "<true/>" : "<false/>");
  push("uploadSymbols", form.uploadSymbols ? "<true/>" : "<false/>");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...lines,
    "</dict>",
    "</plist>",
  ].join("\n");
}

export function buildXcodebuildExport(form: ExportOptionsForm): string {
  const scheme = form.scheme.trim() || EXPORT_OPTIONS_PLACEHOLDER.scheme;
  return [
    "xcodebuild -exportArchive \\",
    `  -archivePath ${shellPath(`build/${scheme}.xcarchive`)} \\`,
    "  -exportPath build/export \\",
    "  -exportOptionsPlist ExportOptions.plist",
  ].join("\n");
}

/**
 * Archive with gym, export with xcodebuild and the plist above. See the file header for why the
 * method is not handed to gym. `sh` runs inside ./fastlane while actions run from the project
 * root (fastlane's documented directory behaviour), hence the ../ on the export paths only.
 */
export function buildFastlaneExport(form: ExportOptionsForm): string {
  const scheme = form.scheme.trim() || EXPORT_OPTIONS_PLACEHOLDER.scheme;
  const archive = `build/${scheme}.xcarchive`;

  return [
    "# Fastfile. gym (fastlane 2.240.1 and earlier) only accepts the old method",
    "# names, so archive with gym, then export with xcodebuild and the plist above.",
    "# sh runs inside ./fastlane, hence the ../ paths.",
    "build_app(",
    `  scheme: "${rubyEscape(scheme)}",`,
    `  archive_path: "${rubyEscape(archive)}",`,
    "  skip_package_ipa: true",
    ")",
    'sh("xcodebuild -exportArchive" \\',
    `   " -archivePath ${rubyEscape(shellPath(`../${archive}`))}" \\`,
    '   " -exportPath ../build/export" \\',
    '   " -exportOptionsPlist ../ExportOptions.plist")',
  ].join("\n");
}

/** The export method a provisioning profile of this type is meant for; undefined when unknown. */
export function exportMethodForProfile(type: ProvisioningProfileType): ExportMethod | undefined {
  return type === "Ad Hoc"
    ? "release-testing"
    : type === "Development"
      ? "debugging"
      : type === "Enterprise (In-House)"
        ? "enterprise"
        : type === "App Store"
          ? "app-store-connect"
          : undefined;
}
