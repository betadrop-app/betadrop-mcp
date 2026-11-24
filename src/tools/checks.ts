// Release checks tools: what `tools/list` shows and what runs on `tools/call`.
import path from "node:path";
import { apiBaseUrl } from "../lib/api.js";
import { getToken } from "../lib/config.js";
import { uploadBuild } from "../lib/upload.js";
import type { InspectReport } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

const inspect: ToolHandler = async (args) => {
  const { filePath } = args as { filePath: string };
  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== ".ipa" && ext !== ".apk") {
    throw new Error(`Unsupported file type "${ext}". Expected .ipa or .apk.`);
  }
  const token = await getToken();
  if (!token) throw new Error("You are not logged in. Please run betadrop_login first.");
  const r = await uploadBuild<InspectReport>({
    baseUrl: await apiBaseUrl(),
    token,
    filePath: resolvedPath,
    endpoint: "/api/inspect",
    fields: {},
  });
  const mark = (l: string) => (l === "error" ? "✗" : l === "warning" ? "!" : "✓");
  const p = r.ios?.profile;
  const detail = p
    ? `Profile: ${p.kind}, team ${p.teamName ?? "?"} (${p.teamId ?? "?"}), ${p.provisionsAllDevices ? "all devices" : `${p.provisionedDeviceCount} device(s)`}, expires ${p.expiresAt ?? "?"}\n`
    : r.android
      ? `versionCode ${r.android.versionCode ?? "?"}, targetSdk ${r.android.targetSdk ?? "?"}, debuggable ${r.android.debuggable}\n`
      : "";
  return {
    content: [
      {
        type: "text",
        text:
          `**${r.app.name ?? r.fileName}** ${r.app.version ?? ""}${r.app.buildNumber ? ` (${r.app.buildNumber})` : ""} · ${r.platform} · ${r.app.bundleId ?? ""}\n` +
          detail +
          `\n${r.checks.map((c) => `${mark(c.level)} ${c.message}`).join("\n")}\n\n` +
          (r.installableFromLink
            ? "Verdict: installable from an install link."
            : "Verdict: this build will NOT install from an install link. Fix the ✗ items before publishing."),
      },
    ],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_inspect",
      description:
        "Check whether an .ipa or .apk will install from an install link — provisioning profile type and expiry, signing, testOnly/debuggable flags — without publishing it. Use before betadrop_publish when a build might be signed wrong.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the .ipa or .apk." },
        },
        required: ["filePath"],
      },
    },
  ],
  handlers: {
    betadrop_inspect: inspect,
  },
};
