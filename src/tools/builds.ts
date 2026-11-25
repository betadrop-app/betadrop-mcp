// Builds tools: what `tools/list` shows and what runs on `tools/call`.
import { promises as fs } from "node:fs";
import path from "node:path";
import { apiFetch, apiBaseUrl } from "../lib/api.js";
import { getToken, resolveAppUrl } from "../lib/config.js";
import { uploadBuild } from "../lib/upload.js";
import { pickNotices, publishNotes, publishWarnings, readyToShare } from "../lib/publish-notices.js";
import type { BuildListResponse, PublishNotices } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

/**
 * Where an in-flight upload records its progress, and how long `betadrop_publish` will hold a
 * tool call open before handing off to `betadrop_upload_status`.
 *
 * 90s sits under the tool-call timeout of every IDE host we know of (Claude Desktop, Cursor and
 * Copilot are all at or above 120s) while still covering the overwhelming majority of builds —
 * a 50 MB IPA on a normal connection lands in a fraction of it. Anything slower keeps uploading
 * in the background; it is not cancelled, only stopped from blocking the reply.
 */
const PUBLISH_WAIT_MS = 90_000;

function statusFilePath(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return path.join(homeDir, ".betadrop", "upload_status.json");
}

const publish: ToolHandler = async (args, { progress }) => {
  const {
    filePath,
    name: nameOverride,
    version,
    buildNumber,
    bundleId,
    notes,
    expiryType,
    expiryTimeDays,
    expiryDownloadLimit,
    expiryDeviceLimit,
    standingLink,
  } = args as {
    filePath: string;
    name?: string;
    version?: string;
    buildNumber?: string;
    bundleId?: string;
    notes?: string;
    expiryType?: string;
    expiryTimeDays?: number;
    expiryDownloadLimit?: number;
    expiryDeviceLimit?: number;
    standingLink?: string;
  };

  const resolvedPath = path.resolve(filePath);
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== ".ipa" && ext !== ".apk") {
    throw new Error(`Unsupported file type "${ext}". Expected .ipa or .apk.`);
  }

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`File not found: ${resolvedPath}`);
  }
  if (!stat.isFile()) throw new Error(`Path is not a file: ${resolvedPath}`);

  // Validate ZIP magic bytes (IPA and APK are both ZIP archives).
  let fh;
  try {
    fh = await fs.open(resolvedPath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (
      bytesRead < 4 ||
      buf[0] !== 0x50 ||
      buf[1] !== 0x4b ||
      buf[2] !== 0x03 ||
      buf[3] !== 0x04
    ) {
      throw new Error(
        "This file does not appear to be a valid ZIP archive (IPA/APK magic bytes check failed).",
      );
    }
  } finally {
    await fh?.close();
  }

  const token = await getToken();
  if (!token) throw new Error("You are not logged in. Please run betadrop_login first.");
  const baseUrl = await apiBaseUrl();

  const statusPath = statusFilePath();
  const startedTime = new Date().toISOString();

  const updateStatus = async (data: any) => {
    try {
      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(statusPath, JSON.stringify({
        startedAt: startedTime,
        updatedAt: new Date().toISOString(),
        ...data
      }, null, 2), "utf8");
    } catch (e: any) {
      process.stderr.write(`[betadrop-mcp] Failed to write status file: ${e.message}\n`);
    }
  };

  // Initialize status
  await updateStatus({
    status: "uploading",
    progress: 0,
    sentBytes: 0,
    totalBytes: 0,
  });

  let lastPct = -1;
  const uploadPromise = uploadBuild({
    baseUrl,
    token,
    filePath: resolvedPath,
    fields: {
      name: nameOverride,
      version,
      build_number: buildNumber,
      bundle_id: bundleId,
      notes,
      expiry_type: expiryType,
      expiry_time_days: expiryTimeDays,
      expiry_download_limit: expiryDownloadLimit,
      expiry_device_limit: expiryDeviceLimit,
      channel: standingLink?.trim() || undefined,
    },
    onProgress: (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct >= lastPct + 5 || pct === 100) {
        lastPct = pct;
        updateStatus({
          status: "uploading",
          progress: pct,
          sentBytes: sent,
          totalBytes: total,
        }).catch(() => {});

        progress?.(sent, total, `Uploading… ${pct}% (${(sent / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
      }
    },
  }).then(async (result) => {
    const appUrl = resolveAppUrl();
    const installUrl = `${appUrl}/install/?i=${result.shortId}`;
    await updateStatus({
      status: "success",
      progress: 100,
      result: {
        id: result.id,
        name: result.meta.name,
        version: result.meta.version,
        platform: result.platform,
        fileSize: result.fileSize,
        installUrl,
        // Carried into the stored status, not just the immediate reply: the polling path
        // below is the one an agent actually reads when an upload outlives the tool call,
        // and dropping them here would make the warnings appear only on fast uploads.
        ...pickNotices(result),
      }
    });
    return { ok: true as const, result, installUrl };
  }).catch(async (err) => {
    await updateStatus({
      status: "error",
      error: err.message || String(err),
    });
    return { ok: false as const, error: err?.message || String(err) };
  });

  // Wait for the upload, but not forever.
  //
  // The install link IS the product — it is the whole reason someone runs this tool — and
  // it was never returned to the assistant. The upload was fired into the background and
  // the tool replied with a `file:///…/upload_status.json` path, so the assistant's closing
  // line to the developer was an apology about tool timeouts plus a local file path they
  // then had to open by hand. Nothing in the MCP surface could ever speak the link, because
  // no tool returned it and there was no status tool to poll.
  //
  // Racing a deadline gets the good outcome in the common case without reintroducing the
  // timeout risk the background upload was avoiding: a typical build finishes well inside
  // the budget and the assistant can say the link out loud, while a genuinely slow upload
  // still returns cleanly and keeps running, with `betadrop_upload_status` to finish the job.
  const TIMED_OUT = Symbol("timeout");
  let deadline: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    uploadPromise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      deadline = setTimeout(() => resolve(TIMED_OUT), PUBLISH_WAIT_MS);
      // `unref` so a still-running timer never holds the MCP process open.
      deadline.unref?.();
    }),
  ]);
  if (deadline) clearTimeout(deadline);

  if (settled !== TIMED_OUT && settled.ok) {
    const { result, installUrl } = settled;
    return {
      content: [
        {
          type: "text",
          text:
            // First, so a held or uninstallable build is never read as ready to share.
            publishWarnings(result).map((w) => `${w}\n\n`).join("") +
            `Published **${result.meta.name}${result.meta.version ? ` ${result.meta.version}` : ""}** to BetaDrop.\n\n` +
            `**Install link:** ${installUrl}\n` +
            `Build ID: ${result.id}` +
            (readyToShare(result)
              ? `\n\nOpen it on an ${result.platform === "ios" ? "iPhone or iPad" : "Android device"} to install over the air — ` +
                `no TestFlight, no store, no tester account. Share the link with anyone who needs the build.`
              : "") +
            publishNotes(result).map((n) => `\n\n${n}`).join(""),
        },
      ],
    };
  }

  if (settled !== TIMED_OUT && !settled.ok) {
    return {
      content: [{ type: "text", text: `BetaDrop upload failed: ${settled.error}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Still uploading "${path.basename(resolvedPath)}" to BetaDrop — it is a large build, so it is ` +
          `running in the background rather than holding the tool call open.\n\n` +
          `Call \`betadrop_upload_status\` in a few seconds to get the install link.`,
      },
    ],
  };
};

const uploadStatus: ToolHandler = async () => {
  // The companion to the deadline in `betadrop_publish`: when an upload outlives the wait,
  // this is how the assistant finishes the sentence. Without it a slow upload had no path
  // back to the install link except asking the developer to open a JSON file themselves.
  let raw: string;
  try {
    raw = await fs.readFile(statusFilePath(), "utf8");
  } catch {
    return {
      content: [{ type: "text", text: "No BetaDrop upload has been started from this workspace yet." }],
    };
  }

  // A file written by an older version of this server lacks `id` and most notices; each is optional.
  const status = JSON.parse(raw) as {
    status: string;
    progress?: number;
    error?: string;
    result?: PublishNotices & {
      id?: string;
      name?: string;
      version?: string;
      platform?: string;
      installUrl?: string;
    };
  };

  if (status.status === "success" && status.result?.installUrl) {
    const r = status.result;
    return {
      content: [
        {
          type: "text",
          text:
            publishWarnings(r).map((w) => `${w}\n\n`).join("") +
            `Published **${r.name ?? "build"}${r.version ? ` ${r.version}` : ""}** to BetaDrop.\n\n` +
            `**Install link:** ${r.installUrl}` +
            (r.id ? `\nBuild ID: ${r.id}` : "") +
            (readyToShare(r)
              ? `\n\nOpen it on an ${r.platform === "ios" ? "iPhone or iPad" : "Android device"} to install over the air.`
              : "") +
            publishNotes(r).map((n) => `\n\n${n}`).join(""),
        },
      ],
    };
  }

  if (status.status === "error") {
    return {
      content: [{ type: "text", text: `BetaDrop upload failed: ${status.error ?? "unknown error"}` }],
      isError: true,
    };
  }

  return {
    content: [
      { type: "text", text: `BetaDrop upload in progress — ${status.progress ?? 0}% complete. Call this again shortly.` },
    ],
  };
};

const listBuilds: ToolHandler = async (args) => {
  const { platform, status, page = 1, perPage = 20 } = (args ?? {}) as {
    platform?: "ios" | "android";
    status?: "active" | "expired" | "disabled" | "deprecated" | "latest";
    page?: number;
    perPage?: number;
  };

  const params = new URLSearchParams({
    page: String(page),
    per_page: String(Math.min(perPage, 100)),
  });
  if (platform) params.set("platform", platform);
  if (status) params.set("status", status);

  const res = await apiFetch<BuildListResponse>(`/api/cli/builds?${params}`);
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  const { builds, total, page: currentPage, perPage: pp } = res.data;

  if (builds.length === 0) {
    return { content: [{ type: "text", text: "No builds found." }] };
  }

  const lines = builds.map((b) => {
    const date = new Date(b.createdAt).toLocaleDateString();
    const size = (b.fileSize / 1024 / 1024).toFixed(2);
    const url = b.installUrl ?? "no install link";
    const installs =
      b.downloads === undefined ? "" : ` — ${b.downloads} installs on ${b.uniqueDevices ?? 0} devices`;
    // The full id, once per build: betadrop_delete_build, betadrop_get_feedback and
    // betadrop_point_standing_link take nothing else.
    return (
      `• [${b.platform.toUpperCase()}] ${b.meta.name} v${b.meta.version} — ${size} MB — ${date} — ${b.status}${installs}\n` +
      `  ${url} · ID ${b.id}`
    );
  });

  const filterInfo = status ? ` (filtered by status: ${status})` : "";

  return {
    content: [
      {
        type: "text",
        text:
          `Showing ${builds.length} of ${total} builds${filterInfo} (page ${currentPage}, ${pp} per page)\n\n` +
          lines.join("\n\n"),
      },
    ],
  };
};

const listExpiredBuilds: ToolHandler = async (args) => {
  const { platform, page = 1, perPage = 20 } = (args ?? {}) as {
    platform?: "ios" | "android";
    page?: number;
    perPage?: number;
  };

  const params = new URLSearchParams({
    page: String(page),
    per_page: String(Math.min(perPage, 100)),
    status: "expired",
  });
  if (platform) params.set("platform", platform);

  const res = await apiFetch<BuildListResponse>(`/api/cli/builds?${params}`);
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  const { builds, total, page: currentPage, perPage: pp } = res.data;

  if (builds.length === 0) {
    return { content: [{ type: "text", text: "No expired builds found." }] };
  }

  const lines = builds.map((b) => {
    const date = new Date(b.createdAt).toLocaleDateString();
    const size = (b.fileSize / 1024 / 1024).toFixed(2);
    const expiredAt = b.expiresAt
      ? new Date(b.expiresAt).toLocaleDateString()
      : "N/A";
    const url = b.installUrl ?? "no install link";
    // Only a retired build with its file kept can be restored; one the hourly sweep has not
    // retired yet, or a download/device limit stopped, is left unchanged by a restore.
    const restore = b.restorable
      ? "\n  Restorable: retired with its file still kept (betadrop_restore_build)."
      : b.payloadPurged
        ? "\n  File removed: it can no longer be restored."
        : "";
    return (
      `• [${b.platform.toUpperCase()}] ${b.meta.name} v${b.meta.version} — ${size} MB\n` +
      `  Published: ${date} | Expired: ${expiredAt}\n` +
      `  ${url} · ID ${b.id}` +
      restore
    );
  });

  return {
    content: [
      {
        type: "text",
        text:
          `${total} expired build(s) found (page ${currentPage}, ${pp} per page)\n\n` +
          lines.join("\n\n"),
      },
    ],
  };
};

const deleteBuild: ToolHandler = async (args) => {
  const { buildId } = args as { buildId: string };
  await apiFetch(`/api/builds/${encodeURIComponent(buildId)}`, { method: "DELETE" });
  return { content: [{ type: "text", text: `Build ${buildId} deleted. Its install link no longer works.` }] };
};

const getFeedback: ToolHandler = async (args) => {
  const { buildId } = args as { buildId: string };
  const res = await apiFetch<Array<Record<string, string | number | null>>>(
    `/api/builds/${encodeURIComponent(buildId)}/feedback`,
  );
  const items = res.data ?? [];
  if (items.length === 0) return { content: [{ type: "text", text: "No feedback on this build yet." }] };
  const text = items
    .map(
      (f) =>
        `• [${f.id}] ${f.title || f.feedback_type} — ${f.reporter_name || f.reporter_email || "anonymous"}${f.rating ? ` · ${f.rating}/5` : ""}${f.status && f.status !== "new" ? ` · ${String(f.status).replace("_", " ")}` : ""} · ${f.created_at ?? ""}\n  ${String(f.description ?? "").replace(/\n/g, "\n  ")}`,
    )
    .join("\n\n");
  return { content: [{ type: "text", text: `${items.length} report(s):\n\n${text}` }] };
};

const FEEDBACK_STATUSES = ["new", "in_progress", "resolved", "closed"];

const setFeedbackStatus: ToolHandler = async (args) => {
  const { buildId, feedbackId, status } = args as { buildId: string; feedbackId: string; status: string };
  const res = await apiFetch<Record<string, string | null>>(
    `/api/builds/${encodeURIComponent(buildId)}/feedback/${encodeURIComponent(feedbackId)}`,
    { method: "PATCH", body: { status } },
  );
  return {
    content: [
      {
        type: "text",
        text: `Report ${feedbackId} is now ${String(res.data?.status ?? status).replace("_", " ")}. Any linked Linear or Jira issue is updated to match.`,
      },
    ],
  };
};

const sendFeedbackToTracker: ToolHandler = async (args) => {
  const { buildId, feedbackId, provider } = args as { buildId: string; feedbackId: string; provider?: string };
  const res = await apiFetch<{ issue?: { provider: string; key: string; url: string }; created?: boolean; queued?: boolean; message?: string }>(
    `/api/builds/${encodeURIComponent(buildId)}/feedback/${encodeURIComponent(feedbackId)}/issue`,
    { method: "POST", body: provider ? { provider } : {} },
  );
  const d = res.data ?? {};
  const text = d.issue
    ? `${d.created === false ? "Already linked to" : "Created"} ${d.issue.key}: ${d.issue.url}`
    : d.queued
      ? `Queued — ${d.message ?? "it will be retried shortly"}.`
      : "Sent.";
  return { content: [{ type: "text", text }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_publish",
      description:
        "Publish an iOS (.ipa) or Android (.apk) file from this computer as a new build with its own install link; earlier builds keep theirs. The standing link named in standingLink moves to the new build even when it is held for review. Without one, standing links set to follow this app move to it, unless the file is identical to a build still live on the account or the new build is held for review or otherwise can't be installed. Confirmed followers of a moved link get one email about 30 minutes after its last move, if the build it serves then can be installed. The reply gives the install link and build ID; an upload still running after 90 seconds continues in the background, and betadrop_upload_status reports its result.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the build file (.ipa or .apk).",
          },
          name: {
            type: "string",
            description: "Override the app display name.",
          },
          version: {
            type: "string",
            description: "Override the version string (e.g. 1.2.3).",
          },
          buildNumber: {
            type: "string",
            description: "Override the build number.",
          },
          bundleId: {
            type: "string",
            description: "Override the bundle / package ID.",
          },
          notes: {
            type: "string",
            description: "Release notes shown on the install page.",
          },
          expiryType: {
            type: "string",
            enum: ["none", "time", "downloads", "devices", "combined"],
            description: "Expiry strategy for this build.",
          },
          expiryTimeDays: {
            type: "number",
            description: "Expire after N days (requires expiryType 'time' or 'combined').",
          },
          expiryDownloadLimit: {
            type: "number",
            description: "Expire after N downloads (requires expiryType 'downloads' or 'combined').",
          },
          expiryDeviceLimit: {
            type: "number",
            description: "Expire after N unique devices (requires expiryType 'devices' or 'combined').",
          },
          standingLink: {
            type: "string",
            description:
              "Slug of a standing link to point at this build once it is stored, so the one URL testers already have serves it. The slug must already be claimed on the account; betadrop_list_standing_links lists them.",
          },
        },
        required: ["filePath"],
      },
    },
    {
      // Only needed when a build outruns PUBLISH_WAIT_MS — `betadrop_publish` returns the
      // install link directly whenever it can, and says to call this when it cannot.
      name: "betadrop_upload_status",
      description:
        "Get the result of the most recent betadrop_publish upload, including the install link, for an upload that betadrop_publish reported as still running.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_list_builds",
      description:
        "List recent builds published to BetaDrop, optionally filtered by platform and status. Each build shows its install link and its ID.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["ios", "android"],
            description: "Filter by platform. Omit to list all.",
          },
          status: {
            type: "string",
            enum: ["active", "expired", "disabled", "deprecated", "latest"],
            description: "Filter by status. Omit to list all.",
          },
          page: {
            type: "number",
            description: "Page number (default 1).",
          },
          perPage: {
            type: "number",
            description: "Results per page (default 20, max 100).",
          },
        },
      },
    },
    {
      name: "betadrop_list_expired_builds",
      description:
        "List expired builds on BetaDrop, with the date each was published and its expiry date. Shortcut for betadrop_list_builds with status 'expired'. Builds BetaDrop has retired while keeping their file are marked restorable; those are the ones betadrop_restore_build brings back. It does not say why a build expired.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["ios", "android"],
            description: "Filter by platform. Omit to list all.",
          },
          page: {
            type: "number",
            description: "Page number (default 1).",
          },
          perPage: {
            type: "number",
            description: "Results per page (default 20, max 100).",
          },
        },
      },
    },
    {
      name: "betadrop_delete_build",
      description: "Delete a build. Its install link stops working immediately.",
      inputSchema: {
        type: "object",
        properties: { buildId: { type: "string", description: "ID of the build to delete (from betadrop_list_builds)." } },
        required: ["buildId"],
      },
    },
    {
      name: "betadrop_get_feedback",
      description: "Read the feedback testers left on a build: bug reports, ratings and notes.",
      inputSchema: {
        type: "object",
        properties: { buildId: { type: "string", description: "Build ID (from betadrop_list_builds)." } },
        required: ["buildId"],
      },
    },
    {
      name: "betadrop_set_feedback_status",
      description:
        "Move a tester's feedback report to another status (new, in_progress, resolved, closed). A linked Linear or Jira issue is moved to match. Report ids come from betadrop_get_feedback.",
      inputSchema: {
        type: "object",
        properties: {
          buildId: { type: "string", description: "Build ID." },
          feedbackId: { type: "string", description: "Feedback report ID." },
          status: { type: "string", enum: FEEDBACK_STATUSES, description: "The new status." },
        },
        required: ["buildId", "feedbackId", "status"],
      },
    },
    {
      name: "betadrop_send_feedback_to_tracker",
      description:
        "Create a Linear or Jira issue from a tester's feedback report, using the integration connected in BetaDrop (Settings → Integrations). Sending a report twice links the same issue.",
      inputSchema: {
        type: "object",
        properties: {
          buildId: { type: "string", description: "Build ID." },
          feedbackId: { type: "string", description: "Feedback report ID." },
          provider: { type: "string", enum: ["linear", "jira"], description: "Omit to use whichever tracker is connected." },
        },
        required: ["buildId", "feedbackId"],
      },
    },
  ],
  handlers: {
    betadrop_publish: publish,
    betadrop_upload_status: uploadStatus,
    betadrop_list_builds: listBuilds,
    betadrop_list_expired_builds: listExpiredBuilds,
    betadrop_delete_build: deleteBuild,
    betadrop_get_feedback: getFeedback,
    betadrop_set_feedback_status: setFeedbackStatus,
    betadrop_send_feedback_to_tracker: sendFeedbackToTracker,
  },
};
