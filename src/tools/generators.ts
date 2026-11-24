// Generator tools, ported from BetaDrop's free developer tools on the website: app icon sets,
// ExportOptions.plist / manifest.plist, and QR codes. They make files from their inputs alone and
// never call the BetaDrop API, so they work without signing in.
import { promises as fs } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  EXPORT_METHODS,
  EXPORT_OPTIONS_INITIAL,
  buildExportOptionsPlist,
  buildFastlaneExport,
  buildXcodebuildExport,
  type ExportMethod,
  type ExportOptionsForm,
} from "@/lib/exportOptionsPlist";
import { buildManifestPlist, isHttpsUrl, itmsServicesLink } from "@/lib/manifestPlist";
import { analyzeOtaInput } from "@/lib/otaManifestCheck";
import {
  ANDROID_RES,
  IOS_SET,
  buildAppIcons,
  findProjectTargets,
  writeAll,
  writeIntoProject,
  type ProjectWrite,
} from "../lib/icons/appIcons.js";
import type { ToolHandler, ToolModule } from "./types.js";

const LOCAL_ONLY_PATH = "outputPath writes a file on the computer running this server, so it is available in the local server only (npx -y @betadrop/mcp).";

/** Writes `contents` to a new file at `outputPath`; an existing file is left as it is. */
async function writeNewFile(outputPath: string, contents: string | Uint8Array): Promise<string> {
  const dest = path.resolve(outputPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.writeFile(dest, contents, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${dest} already exists and was left unchanged. outputPath takes the path of a new file.`);
    throw e;
  }
  return dest;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ── betadrop_app_icons ───────────────────────────────────────────────────────────────────────

const mark = (level: string) => (level === "error" ? "✗" : level === "warn" ? "!" : level === "info" ? "·" : "✓");

const appIcons: ToolHandler = async (args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  const imagePath = str(a.imagePath).trim();
  if (!imagePath) throw new Error("imagePath is required: the PNG or JPEG to make the icons from.");
  const platforms = a.platforms === undefined ? undefined : str(a.platforms);
  if (platforms !== undefined && !["ios", "android", "both"].includes(platforms)) throw new Error('platforms is "ios", "android" or "both".');
  const mode = a.mode === undefined ? undefined : str(a.mode);
  if (mode !== undefined && mode !== "logo" && mode !== "full") throw new Error('mode is "logo" or "full".');
  let padding: number | undefined;
  if (a.padding !== undefined) {
    padding = Number(a.padding);
    if (!Number.isFinite(padding) || padding < -50 || padding > 40) throw new Error("padding is a percentage from -50 to 40.");
    padding /= 100;
  }
  const backgroundColor = a.backgroundColor === undefined ? undefined : str(a.backgroundColor).trim();
  if (backgroundColor !== undefined && !/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(backgroundColor)) {
    throw new Error("backgroundColor is a hex colour such as #0B64FC.");
  }
  const projectDir = str(a.projectDir).trim();
  const outputDirArg = str(a.outputDir).trim();
  if (projectDir && outputDirArg) throw new Error("projectDir and outputDir are alternatives: one writes into a project, the other into a folder of its own.");

  const source = path.resolve(imagePath);
  // With a project, an unspecified platform means whichever the project has.
  let want = { ios: platforms !== "android", android: platforms !== "ios" };
  let targets: Awaited<ReturnType<typeof findProjectTargets>> | null = null;
  if (projectDir) {
    const root = path.resolve(projectDir);
    if (platforms === undefined) {
      const found = {
        ios: await findProjectTargets(root, { ios: true, android: false }).then((t) => t.iosSet, () => null),
        android: await findProjectTargets(root, { ios: false, android: true }).then((t) => t.androidRes, () => null),
      };
      if (!found.ios && !found.android) {
        // Neither was found unambiguously; the iOS search's own error says why.
        await findProjectTargets(root, { ios: true, android: true });
      }
      targets = { iosSet: found.ios, androidRes: found.android };
      want = { ios: Boolean(found.ios), android: Boolean(found.android) };
    } else {
      targets = await findProjectTargets(root, want);
    }
  }

  const build = await buildAppIcons({ imagePath: source, ...want, mode: mode as "logo" | "full" | undefined, padding, backgroundColor });

  const lines: string[] = [];
  const { width, height, meta } = build.source;
  lines.push(
    `**App icons from ${path.basename(source)}** (${width} × ${height} ${meta.format.toUpperCase()}): ` +
      `${build.mode === "logo" ? "logo" : "full icon"} on ${build.background}, padding ${Math.round(build.padding * 100)}%.`,
  );
  const extras = [build.made.dark && want.ios ? "dark" : "", build.made.tinted && want.ios ? "tinted" : ""].filter(Boolean);
  const iosLine = `the 1024 px icon (no alpha channel)${extras.length ? `, iOS 18 ${extras.join(" and ")} versions` : ""} and Contents.json`;
  const androidLine = `launcher icons for mdpi–xxxhdpi (legacy square and round, adaptive foreground${build.made.monochrome ? ", themed monochrome layer" : ""}), the adaptive icon XML and the background colour`;

  let project: ProjectWrite | null = null;
  if (targets) {
    project = await writeIntoProject(build, targets);
    lines.push("", `Wrote ${project.written.length} files into ${path.resolve(projectDir)}:`);
    if (targets.iosSet) lines.push(`- ${targets.iosSet} — ${iosLine}`);
    if (targets.androidRes) lines.push(`- ${targets.androidRes} — ${androidLine}`);
    if (project.removed.length) {
      lines.push(`Removed ${project.removed.length} old icon file${project.removed.length === 1 ? "" : "s"} the new ones replace: ${project.removed.map((p) => path.relative(path.resolve(projectDir), p)).join(", ")}.`);
    }
    for (const note of project.notes) lines.push(`! ${note}`);
    lines.push("The App Store and Google Play store icons are not part of a project, so they were not written; outputDir writes them with the rest of the set.");
  } else {
    const dir = path.resolve(outputDirArg || path.join(path.dirname(source), "AppIcons"));
    const written = await writeAll(build, dir);
    lines.push("", `Wrote ${written.length} files to ${dir}:`);
    if (want.ios) lines.push(`- ${IOS_SET}/ — ${iosLine}. In Xcode it replaces the AppIcon set in the target's Assets.xcassets.`);
    if (want.android) lines.push(`- ${ANDROID_RES}/ — ${androidLine}. It goes over the project's res folder once the old ic_launcher images are gone.`);
    lines.push(
      `- store/ — ${[want.ios ? "app-store-1024.png (App Store, no alpha)" : "", want.android ? "play-store-512.png (Play Console store listing)" : ""].filter(Boolean).join(", ")}`,
      "- README.txt — where each folder goes, and the checks below",
    );
  }

  lines.push("", "Checks:", ...build.findings.map((f) => `${mark(f.level)} ${f.title}${f.detail ? ` — ${f.detail}` : ""}`));
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "image", data: Buffer.from(build.preview).toString("base64"), mimeType: "image/png" },
    ],
  } as CallToolResult;
};

// ── betadrop_generate_plist ──────────────────────────────────────────────────────────────────

const METHOD_VALUES = EXPORT_METHODS.map((m) => m.value);

function exportOptions(a: Record<string, unknown>): { plist: string; extra: string[] } {
  const method = (a.method === undefined ? EXPORT_OPTIONS_INITIAL.method : str(a.method)) as ExportMethod;
  if (!METHOD_VALUES.includes(method)) {
    const legacy: Record<string, string> = { "ad-hoc": "release-testing", "app-store": "app-store-connect", development: "debugging" };
    throw new Error(
      `method is one of ${METHOD_VALUES.join(", ")}.` + (legacy[method] ? ` "${method}" is the old name of "${legacy[method]}", which Xcode 15.4 deprecated.` : ""),
    );
  }
  const signingStyle = a.signingStyle === undefined ? EXPORT_OPTIONS_INITIAL.signingStyle : str(a.signingStyle);
  if (signingStyle !== "manual" && signingStyle !== "automatic") throw new Error('signingStyle is "manual" or "automatic".');
  const destination = a.destination === undefined ? EXPORT_OPTIONS_INITIAL.destination : str(a.destination);
  if (destination !== "export" && destination !== "upload") throw new Error('destination is "export" or "upload".');

  // provisioningProfiles: bundleId + provisioningProfile, then any further pairs in the map.
  const pairs: Array<[string, string]> = [];
  const bundleId = str(a.bundleId).trim();
  const profile = str(a.provisioningProfile).trim();
  if (bundleId && profile) pairs.push([bundleId, profile]);
  else if (bundleId || profile) throw new Error("bundleId and provisioningProfile go together: the profile signs that bundle identifier.");
  const map = a.provisioningProfiles;
  if (map !== undefined) {
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("provisioningProfiles maps each bundle identifier to its profile name or UUID.");
    for (const [id, name] of Object.entries(map as Record<string, unknown>)) {
      if (!id.trim() || typeof name !== "string" || !name.trim()) throw new Error("provisioningProfiles maps each bundle identifier to its profile name or UUID.");
      if (!pairs.some(([existing]) => existing === id.trim())) pairs.push([id.trim(), name.trim()]);
    }
  }
  if (signingStyle === "manual" && pairs.length === 0) {
    throw new Error("Manual signing needs a provisioning profile for every bundle identifier in the archive: bundleId with provisioningProfile, or provisioningProfiles.");
  }
  const wildcard = pairs.find(([id]) => id.includes("*"));
  if (wildcard) throw new Error(`${wildcard[0]} is a wildcard App ID. provisioningProfiles is keyed by each target's real bundle identifier.`);

  const form: ExportOptionsForm = {
    ...EXPORT_OPTIONS_INITIAL,
    method,
    teamId: str(a.teamID),
    signingStyle,
    bundleId: pairs[0]?.[0] ?? "",
    profileName: pairs[0]?.[1] ?? "",
    extraProfiles: pairs.slice(1),
    signingCertificate: str(a.signingCertificate),
    destination,
    thinning: a.thinning === undefined ? EXPORT_OPTIONS_INITIAL.thinning : str(a.thinning).trim() || EXPORT_OPTIONS_INITIAL.thinning,
    stripSwiftSymbols: a.stripSwiftSymbols === undefined ? EXPORT_OPTIONS_INITIAL.stripSwiftSymbols : a.stripSwiftSymbols === true,
    uploadSymbols: a.uploadSymbols === undefined ? EXPORT_OPTIONS_INITIAL.uploadSymbols : a.uploadSymbols === true,
    scheme: str(a.scheme),
  };
  const extra: string[] = [];
  const team = form.teamId.trim();
  if (team && !/^[A-Z0-9]{10}$/.test(team)) extra.push(`! teamID "${team}" is not ten capital letters and digits, the form Apple team identifiers take.`);
  if (signingStyle === "automatic" && pairs.length) extra.push("· Automatic signing lets Xcode resolve the profiles, so the provisioning profiles given were left out.");
  extra.push(
    "",
    `Export with xcodebuild${form.scheme.trim() ? "" : " (scheme MyApp, a placeholder)"}:`,
    "```sh",
    buildXcodebuildExport(form),
    "```",
    "",
    "Or archive with fastlane gym and export with xcodebuild (gym 2.240.1 and earlier rejects the current method names):",
    "```ruby",
    buildFastlaneExport(form),
    "```",
  );
  return { plist: `${buildExportOptionsPlist(form)}\n`, extra };
}

function manifest(a: Record<string, unknown>): { plist: string; extra: string[] } {
  const ipaUrl = str(a.ipaUrl).trim();
  const bundleId = str(a.bundleId).trim();
  const bundleVersion = str(a.bundleVersion).trim();
  const title = str(a.title).trim();
  const missing = [!ipaUrl && "ipaUrl", !bundleId && "bundleId", !bundleVersion && "bundleVersion", !title && "title"].filter(Boolean);
  if (missing.length) throw new Error(`A manifest needs ${missing.join(", ")}: the .ipa's https:// URL and its bundle identifier, version and name.`);
  const urls: Array<[string, string]> = [
    ["ipaUrl", ipaUrl],
    ["displayImageUrl", str(a.displayImageUrl).trim()],
    ["fullSizeImageUrl", str(a.fullSizeImageUrl).trim()],
    ["manifestUrl", str(a.manifestUrl).trim()],
  ];
  for (const [name, url] of urls) {
    if (url && !isHttpsUrl(url)) throw new Error(`${name} has to be an https:// URL: iOS installs over the air only over HTTPS.`);
  }
  const plist = buildManifestPlist({ ipaUrl, displayImageUrl: urls[1][1], fullSizeImageUrl: urls[2][1] }, bundleId, bundleVersion, title);
  const extra: string[] = [];
  const link = itmsServicesLink(urls[3][1]);
  const checks = [...analyzeOtaInput(plist).checks, ...(link ? analyzeOtaInput(link).checks : [])].filter((c) => c.status === "warn" || c.status === "fail");
  if (link) extra.push("", `Install link for the manifest at ${urls[3][1]}:`, link);
  for (const c of checks) extra.push(`${c.status === "fail" ? "✗" : "!"} ${c.label} — ${c.detail}`);
  const cannot = analyzeOtaInput(plist).cannotCheck;
  extra.push("", "What the text alone can't confirm:", ...cannot.map((line) => `- ${line}`));
  return { plist, extra };
}

const generatePlist: ToolHandler = async (args, { remote }) => {
  const a = (args ?? {}) as Record<string, unknown>;
  const kind = str(a.kind);
  if (kind !== "exportOptions" && kind !== "manifest") throw new Error('kind is "exportOptions" or "manifest".');
  if (remote && a.outputPath !== undefined) throw new Error(LOCAL_ONLY_PATH);
  const { plist, extra } = kind === "exportOptions" ? exportOptions(a) : manifest(a);
  const name = kind === "exportOptions" ? "ExportOptions.plist" : "manifest.plist";
  const saved = a.outputPath !== undefined ? await writeNewFile(str(a.outputPath), plist) : null;
  return {
    content: [
      {
        type: "text",
        text: [`**${name}**${saved ? ` — saved to ${saved}` : ""}`, "```xml", plist.trimEnd(), "```", ...extra].join("\n"),
      },
    ],
  };
};

// ── betadrop_qr_code ─────────────────────────────────────────────────────────────────────────

/** The web QR generator's settings: error correction H (30% damage tolerance), a 2-module margin, black on white. */
const QR_OPTIONS = { margin: 2, errorCorrectionLevel: "H", color: { dark: "#000000", light: "#ffffff" } } as const;

const qrCode: ToolHandler = async (args, { remote }) => {
  const a = (args ?? {}) as Record<string, unknown>;
  const url = str(a.url).trim();
  if (!url) throw new Error("url is required: the link to encode.");
  if (!URL.canParse(url)) throw new Error(`"${url}" is not a URL. The QR code tool encodes links such as https://betadrop.app/i/… install links.`);
  const size = a.size === undefined ? 512 : Number(a.size);
  if (!Number.isInteger(size) || size < 128 || size > 2048) throw new Error("size is a whole number of pixels from 128 to 2048.");
  if (remote && a.outputPath !== undefined) throw new Error(LOCAL_ONLY_PATH);
  const outputPath = a.outputPath === undefined ? null : str(a.outputPath);
  if (outputPath !== null && !/\.(png|svg)$/i.test(outputPath)) throw new Error("outputPath ends in .png or .svg, the two formats the QR code is saved in.");

  let png: Buffer;
  let svg: string;
  try {
    png = await QRCode.toBuffer(url, { type: "png", width: size, ...QR_OPTIONS });
    svg = await QRCode.toString(url, { type: "svg", ...QR_OPTIONS });
  } catch {
    // The only realistic failure: the payload exceeds QR capacity (~1.2 KB at level H).
    throw new Error("That link is too long for a QR code at error correction H (about 1,200 characters).");
  }
  const saved = outputPath ? await writeNewFile(outputPath, /\.svg$/i.test(outputPath) ? svg : png) : null;
  const pixels = /^\s*<svg[^>]*viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1];
  return {
    content: [
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      {
        type: "text",
        text:
          `QR code for ${url} — ${size} × ${size} px PNG${pixels ? ` (${pixels} modules across, margin included)` : ""}, error correction H (30% damage tolerance), black on white.` +
          (saved ? ` Saved to ${saved}.` : ""),
      },
    ],
  } as CallToolResult;
};

// ── Definitions ──────────────────────────────────────────────────────────────────────────────

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_app_icons",
      description:
        "Make iOS and Android app icon sets from one PNG or JPEG on this computer, the same files BetaDrop's free App Icon Generator makes: " +
        "the 1024 px iOS icon saved with no alpha channel (as App Store Connect requires), iOS 18 dark and tinted versions and Contents.json; " +
        "Android launcher icons for every density with the adaptive icon XML and a themed (monochrome) layer; and the App Store and Google Play store icons. " +
        "Results list the web generator's checks (source too small, transparency, pre-rounded corners, Android safe zone) and show the icon. Nothing is uploaded.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Absolute path to the source image: PNG or JPEG, ideally 1024 px or larger." },
          platforms: {
            type: "string",
            enum: ["ios", "android", "both"],
            description: "Which icon sets to make. Default: both, or with projectDir, whichever the project has.",
          },
          outputDir: {
            type: "string",
            description: "Folder the icon sets, store icons and README.txt are written to. Default: an AppIcons folder beside the image.",
          },
          projectDir: {
            type: "string",
            description:
              "An Xcode, Android Studio, Flutter or React Native project folder. Its AppIcon.appiconset and its src/main/res launcher icons are replaced in place, old icon images included.",
          },
          mode: {
            type: "string",
            enum: ["logo", "full"],
            description: "logo: the art drawn on a background with padding. full: a finished square icon drawn edge to edge. Default: logo for an image with transparent areas, full otherwise.",
          },
          padding: {
            type: "number",
            description: "Empty margin on each side, as a percentage of the icon (-50 to 40). Default 18 for a logo, 0 for a full icon; below 0 zooms in.",
          },
          backgroundColor: {
            type: "string",
            description: "Hex colour behind a logo and of the Android adaptive background. Default: white, or #111827 for a light logo; a full icon's edge colour.",
          },
        },
        required: ["imagePath"],
      },
    },
    {
      name: "betadrop_generate_plist",
      description:
        "Write an iOS ExportOptions.plist (for xcodebuild -exportArchive, with the matching xcodebuild and fastlane commands) or an over-the-air manifest.plist " +
        "(with its itms-services:// install link), as BetaDrop's free plist generators do. Inputs are checked the same way: current Xcode method names, a profile for " +
        "every bundle identifier under manual signing, https:// URLs only. URLs are written into the plist, never fetched.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["exportOptions", "manifest"], description: "exportOptions: ExportOptions.plist. manifest: an OTA install manifest.plist." },
          method: {
            type: "string",
            enum: METHOD_VALUES,
            description: "exportOptions: distribution method. release-testing (was ad-hoc, the default), app-store-connect (was app-store), enterprise, debugging (was development), developer-id.",
          },
          teamID: { type: "string", description: "exportOptions: the ten-character Apple Developer team ID." },
          signingStyle: { type: "string", enum: ["manual", "automatic"], description: "exportOptions: default manual, which needs a profile per bundle identifier." },
          bundleId: { type: "string", description: "exportOptions: the app's bundle identifier, signed by provisioningProfile. manifest: the bundle-identifier the device checks." },
          provisioningProfile: { type: "string", description: "exportOptions: the profile name (as in the Apple Developer portal) or UUID for bundleId." },
          provisioningProfiles: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "exportOptions: more bundle identifier → profile pairs, for app extensions and other targets in the archive.",
          },
          signingCertificate: { type: "string", description: 'exportOptions: e.g. "Apple Distribution". Left out when empty, so Xcode picks one from the keychain.' },
          destination: { type: "string", enum: ["export", "upload"], description: "exportOptions: export writes the build to disk (default); upload sends it to App Store Connect." },
          thinning: { type: "string", description: 'exportOptions: "<none>" (default), "<thin-for-all-variants>", or a device model identifier.' },
          stripSwiftSymbols: { type: "boolean", description: "exportOptions: default true." },
          uploadSymbols: { type: "boolean", description: "exportOptions: default true." },
          scheme: { type: "string", description: "exportOptions: the Xcode scheme, for the commands shown with the plist (not part of the plist)." },
          ipaUrl: { type: "string", description: "manifest: https:// URL of the .ipa." },
          bundleVersion: { type: "string", description: "manifest: the app's version (CFBundleShortVersionString)." },
          title: { type: "string", description: "manifest: the app name shown in the install prompt." },
          displayImageUrl: { type: "string", description: "manifest: optional https:// URL of a 57 px icon shown while installing." },
          fullSizeImageUrl: { type: "string", description: "manifest: optional https:// URL of a 512 px icon." },
          manifestUrl: { type: "string", description: "manifest: where the manifest will be hosted (https://). Adds the itms-services:// install link for it." },
          outputPath: { type: "string", description: "Local server only: path of a new file to save the plist to." },
        },
        required: ["kind"],
      },
    },
    {
      name: "betadrop_qr_code",
      description:
        "Make a QR code PNG for a link, with the settings of BetaDrop's free QR generator: error correction H (scans when up to 30% is damaged or covered), " +
        "a 2-module margin, black on white. For a BetaDrop install link, testers scan it with the phone camera to open the install page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The link to encode: a BetaDrop install link, a standing link, or any https:// URL." },
          size: { type: "integer", minimum: 128, maximum: 2048, description: "Width and height in pixels. Default 512." },
          outputPath: { type: "string", description: "Local server only: path of a new .png or .svg file to save the code to." },
        },
        required: ["url"],
      },
    },
  ],
  handlers: {
    betadrop_app_icons: appIcons,
    betadrop_generate_plist: generatePlist,
    betadrop_qr_code: qrCode,
  },
};
