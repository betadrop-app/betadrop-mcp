// Release checks tools: what `tools/list` shows and what runs on `tools/call`.
import { promises as fs } from "node:fs";
import path from "node:path";
import { apiBaseUrl } from "../lib/api.js";
import { getToken } from "../lib/config.js";
import { uploadBuild } from "../lib/upload.js";
import { INSPECT_EXTENSIONS, localChecks, mark, renderSections } from "../lib/fileChecks.js";
import type { LocalReport } from "../lib/fileChecks.js";
import { lookupRegistration, registrationLine } from "../lib/androidRegistration.js";
import { ConvertError, convertAab } from "../lib/aabConvert.js";
import { CERT_SUBJECT } from "@/lib/aab2apk/testKey";
import {
  certInputProblem,
  colonHex,
  isValidPackageName,
  normalizeCertSha256,
} from "@/lib/androidVerification/format";
import type { InspectReport } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

function human(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function requireFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) throw new Error(`File not found: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
}

/** BetaDrop's install-link verdict for an .ipa or .apk, as before: the server's own checks. */
function serverSection(r: InspectReport): string {
  const p = r.ios?.profile;
  const detail = p
    ? `Profile: ${p.kind}, team ${p.teamName ?? "?"} (${p.teamId ?? "?"}), ${p.provisionsAllDevices ? "all devices" : `${p.provisionedDeviceCount} device(s)`}, expires ${p.expiresAt ?? "?"}\n`
    : r.android
      ? `versionCode ${r.android.versionCode ?? "?"}, targetSdk ${r.android.targetSdk ?? "?"}, debuggable ${r.android.debuggable}\n`
      : "";
  return (
    `**Install link (BetaDrop)** — ${r.app.name ?? r.fileName} ${r.app.version ?? ""}${r.app.buildNumber ? ` (${r.app.buildNumber})` : ""} · ${r.app.bundleId ?? ""}\n` +
    detail +
    r.checks.map((c) => `${mark(c.level)} ${c.message}`).join("\n")
  );
}

const inspect: ToolHandler = async (args) => {
  const { filePath } = args as { filePath: string };
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("filePath is required.");
  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!(INSPECT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`Unsupported file type "${ext}". Expected .ipa, .apk, .aab or .mobileprovision.`);
  }
  await requireFile(resolvedPath);

  const local: LocalReport = await localChecks(resolvedPath);
  const parts = [local.heading, local.details.join("\n"), renderSections(local.sections)];

  let verdict = local.verdict;
  if (ext === ".ipa" || ext === ".apk") {
    const token = await getToken();
    if (!token) {
      verdict =
        `${local.verdict}\nThe install-link verdict (profile, signing and flags as BetaDrop's install page judges them) comes from BetaDrop's server and needs a signed-in account (betadrop_login).`;
    } else {
      try {
        const r = await uploadBuild<InspectReport>({
          baseUrl: await apiBaseUrl(),
          token,
          filePath: resolvedPath,
          endpoint: "/api/inspect",
          fields: {},
        });
        parts.push(serverSection(r));
        verdict = r.installableFromLink
          ? "Verdict: installable from an install link."
          : "Verdict: this build will NOT install from an install link. Fix the ✗ items before publishing.";
        const localErrors = local.sections.flatMap((s) => s.lines).filter((l) => l.level === "error").length;
        if (r.installableFromLink && localErrors) verdict += ` The local checks above still list ${localErrors} ✗ item${localErrors === 1 ? "" : "s"}.`;
      } catch (error) {
        verdict = `${local.verdict}\nBetaDrop's install-link verdict isn't included: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  parts.push(verdict);
  return { content: [{ type: "text", text: parts.filter((s) => s.trim()).join("\n\n") }] };
};

const androidRegistration: ToolHandler = async (args) => {
  const { packageName, certSha256 } = (args ?? {}) as { packageName?: string; certSha256?: string };
  if (!isValidPackageName(packageName)) {
    throw new Error(`"${packageName ?? ""}" isn't a package name; one looks like com.example.app.`);
  }
  const problem = certInputProblem(certSha256);
  if (problem === "sha1") {
    throw new Error("That's a SHA-1 fingerprint (40 hex digits). Google keys on the SHA-256 one, which is 64.");
  }
  if (problem) throw new Error("certSha256 isn't a SHA-256 fingerprint: 64 hex digits, with or without colons.");
  const cert = normalizeCertSha256(certSha256)!;
  const line = registrationLine(await lookupRegistration(packageName!.trim(), cert));
  return {
    content: [
      {
        type: "text",
        text: `**${packageName!.trim()}** · signing certificate SHA-256 ${colonHex(cert)}\n\n${mark(line.level)} ${line.message}`,
      },
    ],
  };
};

const convertAabTool: ToolHandler = async (args, ctx) => {
  const { filePath, outputPath, overwrite, newTestKey } = (args ?? {}) as {
    filePath?: string;
    outputPath?: string;
    overwrite?: boolean;
    newTestKey?: boolean;
  };
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("filePath is required.");
  const input = path.resolve(filePath);
  if (path.extname(input).toLowerCase() !== ".aab") {
    throw new Error(`Unsupported file type "${path.extname(input)}". Expected an .aab.`);
  }
  await requireFile(input);
  const output = path.resolve(
    outputPath?.trim() ? outputPath : path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.apk`),
  );
  if (output === input) throw new Error("outputPath is the bundle itself.");
  if (path.extname(output).toLowerCase() !== ".apk") throw new Error("outputPath has to end in .apk.");
  const existing = await fs.stat(output).catch(() => null);
  if (existing && !overwrite) {
    throw new Error(`${output} already exists, and is left as it is unless overwrite is true. outputPath sets another name.`);
  }
  if (existing && !existing.isFile()) throw new Error(`${output} exists and isn't a file.`);

  let done;
  try {
    done = await convertAab(input, output, {
      freshKey: newTestKey === true,
      onProgress: (fraction, step) => ctx.progress?.(Math.round(fraction * 100), 100, step),
    });
  } catch (error) {
    if (error instanceof ConvertError) throw new Error(`${path.basename(input)} wasn't converted. ${error.message}`);
    throw error;
  }
  const { plan, result, key } = done;
  const m = plan.manifest;
  const keyNote = key.replaced
    ? "A new test key was made for this conversion. APKs converted earlier were signed with the old one, so a tester has to uninstall those before this one installs."
    : key.created
      ? "This is the first conversion on this computer, so the test key was made now."
      : "It is the same test key as earlier conversions on this computer, so testers can update from an APK converted before.";
  const keyFile = key.stored
    ? `The key is kept in ${key.file}, readable by this user only, and never leaves this computer.`
    : "The key couldn't be saved, so the next conversion gets a new one.";

  const text = [
    `Converted **${path.basename(input)}** to **${output}** (${human(result.size)}).`,
    `${m.packageName} · version ${m.versionName || "none"} (${m.versionCode}) · minSdk ${m.minSdk} (installs on Android ${plan.minAndroid} and newer) · targetSdk ${m.targetSdk ?? "not set"}`,
    `One universal APK with every CPU type${plan.abis.length ? ` (${plan.abis.join(", ")})` : ""}, screen density and language. Modules: ${plan.modules.join(", ")}.`,
    [
      "**How it is signed**",
      `Signed with a test key made on this computer (${CERT_SUBJECT}), not the developer's upload or release key. APK Signature Scheme v2${plan.signV1 ? " and v1" : ""}.`,
      `- Certificate SHA-1: ${key.key.sha1}`,
      `- Certificate SHA-256: ${key.key.sha256}`,
      "- It won't install over a copy from Google Play, which is signed with a different key; that copy has to be uninstalled first.",
      "- Google Sign-In, Maps and other SHA-1-restricted APIs need the SHA-1 above added in their console.",
      "- It is for testing only: Google Play takes the .aab, not this APK.",
      `- ${keyNote} ${keyFile}`,
    ].join("\n"),
    `APK SHA-256: ${result.sha256}`,
    `The APK can be published as a build with an install link through betadrop_publish (filePath ${output}).`,
  ].join("\n\n");
  return { content: [{ type: "text", text }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_inspect",
      description:
        "Check an .ipa, .apk, .aab or .mobileprovision on this computer without publishing it. Read locally: the iOS " +
        "provisioning profile (type, team, expiry, devices, bundle ID match; for an .ipa, the embedded one), Android " +
        "signing schemes and certificate SHA-256, Google developer registration for that package and key, 16 KB page " +
        "size support (.apk and .aab), and App Bundle details (SDK levels, modules, estimated download size). For an " +
        ".ipa or .apk on a signed-in account, the file also goes to BetaDrop (not published) for the install-link " +
        "verdict: profile, signing, testOnly/debuggable flags. Useful before betadrop_publish when a build might be signed wrong.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the .ipa, .apk, .aab or .mobileprovision." },
        },
        required: ["filePath"],
      },
    },
    {
      name: "betadrop_android_registration",
      description:
        "Whether an Android app is registered with Google's developer verification for a package name and signing " +
        "certificate: registered, not registered, or registered under a different key, with when Android starts " +
        "blocking unregistered apps installed from links. Only the two values are sent (to BetaDrop, which asks " +
        "Google); no file is needed.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "The app's package name, e.g. com.example.app." },
          certSha256: {
            type: "string",
            description:
              "SHA-256 fingerprint of the signing certificate: 64 hex digits, with or without colons, as keytool, apksigner or Play Console print it.",
          },
        },
        required: ["packageName", "certSha256"],
      },
    },
    {
      name: "betadrop_convert_aab",
      description:
        "Convert an Android App Bundle (.aab) on this computer into one universal .apk that installs from a link. " +
        "The APK is signed with a test key kept on this computer, not the developer's upload or release key, so it is " +
        "for testing, not for Google Play. The result states the key's SHA-1 and SHA-256. The APK can be published with betadrop_publish.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the .aab." },
          outputPath: {
            type: "string",
            description: "Where to write the .apk. Default: next to the .aab, same name with .apk.",
          },
          overwrite: { type: "boolean", description: "Replace an existing file at the output path (default false)." },
          newTestKey: {
            type: "boolean",
            description:
              "Sign with a newly made test key instead of this computer's existing one (default false). Testers then have to uninstall earlier converted APKs.",
          },
        },
        required: ["filePath"],
      },
    },
  ],
  handlers: {
    betadrop_inspect: inspect,
    betadrop_android_registration: androidRegistration,
    betadrop_convert_aab: convertAabTool,
  },
};
