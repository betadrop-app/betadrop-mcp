import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getToken,
  writeConfig,
  clearConfig,
  resolveAppUrl,
} from "./lib/config.js";
import { apiFetch, apiFetchWithToken, apiBaseUrl } from "./lib/api.js";
import { uploadBuild } from "./lib/upload.js";
import type {
  WhoamiResponse,
  BuildListResponse,
  TokenListResponse,
  TokenCreateResponse,
  InspectReport,
  StandingLink,
  Webhook,
} from "./types.js";

// ─── Process-level error handlers ────────────────────────────────────────────
// MCP stdio servers must NEVER write unexpected output to stdout (it corrupts
// JSON-RPC framing). Route all diagnostics to stderr so clients can display them.

process.on("uncaughtException", (err) => {
  process.stderr.write(`[betadrop-mcp] Uncaught exception: ${err.message}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[betadrop-mcp] Unhandled rejection: ${msg}\n`);
  if (reason instanceof Error && reason.stack) {
    process.stderr.write(`${reason.stack}\n`);
  }
  process.exit(1);
});

// Injected at build time by tsup from package.json — single source of truth.
declare const __MCP_VERSION__: string;

// Initialize the MCP Server
const server = new Server(
  {
    name: "betadrop",
    version: __MCP_VERSION__,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ── Auth ──────────────────────────────────────────────────────────────
      {
        name: "betadrop_whoami",
        description:
          "Check authentication status and show the active account and BetaDrop server details.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_login",
        description:
          "Configure API authentication with a BetaDrop token. Validates the token against the server and saves credentials to the shared CLI config.",
        inputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "BetaDrop API token (e.g. bd_live_...)",
            },
            apiUrl: {
              type: "string",
              description: "Optional BetaDrop API base URL override.",
            },
          },
          required: ["token"],
        },
      },
      {
        name: "betadrop_logout",
        description:
          "Revoke the active token on the server and clear local credentials.",
        inputSchema: { type: "object", properties: {} },
      },

      // ── Builds ────────────────────────────────────────────────────────────
      {
        name: "betadrop_publish",
        description: "Publish an iOS (.ipa) or Android (.apk) build to BetaDrop.",
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
                "Slug of a standing link to point at this build once it is live, so the one URL testers already have serves it. The slug must already be claimed on the account. See betadrop_list_standing_links.",
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
          "Get the result of the most recent betadrop_publish upload, including the install link. Call this only when betadrop_publish reported the upload was still running.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_list_builds",
        description:
          "List recent builds published to BetaDrop, optionally filtered by platform and status.",
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
          "List all expired builds on BetaDrop. Shortcut for listing builds with status 'expired'. Shows expiry reason and details.",
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

      // ── Reference ─────────────────────────────────────────────────────────
      {
        name: "betadrop_help",
        description:
          "Get a quick reference of all available BetaDrop MCP tools, their inputs, and example prompts.",
        inputSchema: { type: "object", properties: {} },
      },

      // ── Token management ──────────────────────────────────────────────────
      {
        name: "betadrop_token_list",
        description: "List all active CLI tokens for the current account.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_token_create",
        description:
          "Create a new CLI token. The plaintext token is shown exactly once — copy it immediately.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Human-readable label for the token (max 100 chars).",
            },
            abilities: {
              type: "array",
              items: { type: "string", enum: ["publish", "read", "*"] },
              description: "Permissions granted to the token. Defaults to ['*'] (all).",
            },
            expiresInDays: {
              type: "number",
              description: "Token lifetime in days (1–365). Omit for no expiry.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "betadrop_token_delete",
        description: "Revoke a CLI token by its ID.",
        inputSchema: {
          type: "object",
          properties: {
            tokenId: {
              type: "string",
              description: "ID of the token to revoke (from betadrop_token_list).",
            },
          },
          required: ["tokenId"],
        },
      },

      // ── Release checks ────────────────────────────────────────────────────
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

      // ── Standing links ────────────────────────────────────────────────────
      {
        name: "betadrop_list_standing_links",
        description:
          "List standing links — one permanent install URL each, serving whichever build it was last pointed at — with the build each serves and how many testers follow it.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_point_standing_link",
        description:
          "Point a standing link at an already-uploaded build. Testers who follow the link are emailed about the new build.",
        inputSchema: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The standing link's slug." },
            buildId: { type: "string", description: "Build ID (from betadrop_list_builds)." },
          },
          required: ["slug", "buildId"],
        },
      },

      // ── Builds ────────────────────────────────────────────────────────────
      {
        name: "betadrop_delete_build",
        description: "Delete a build. Its install link stops working immediately. Confirm with the user first.",
        inputSchema: {
          type: "object",
          properties: { buildId: { type: "string", description: "Build ID to delete." } },
          required: ["buildId"],
        },
      },
      {
        name: "betadrop_get_feedback",
        description: "Read the feedback testers left on a build: bug reports, ratings and notes.",
        inputSchema: {
          type: "object",
          properties: { buildId: { type: "string", description: "Build ID." } },
          required: ["buildId"],
        },
      },

      // ── iOS devices ───────────────────────────────────────────────────────
      {
        name: "betadrop_list_devices",
        description: "List the iOS devices (UDIDs) registered on the account for ad-hoc provisioning.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_export_devices",
        description:
          "Export registered iOS devices as the tab-separated file Apple's 'Register Multiple Devices' upload and fastlane register_devices accept. Returns the file contents.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_invite_device",
        description:
          "Create a link a tester opens on their iPhone to register its UDID. With name and email BetaDrop emails a personal invite; with open=true it returns the account's shareable link.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tester's name (for a personal invite)." },
            email: { type: "string", description: "Tester's email (for a personal invite)." },
            open: { type: "boolean", description: "Return the shareable link instead of emailing an invite." },
          },
        },
      },

      // ── Webhooks ──────────────────────────────────────────────────────────
      {
        name: "betadrop_list_webhooks",
        description: "List webhooks that send build events to the user's systems, Slack or Discord.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "betadrop_create_webhook",
        description:
          "Send build events to a URL. Slack and Discord webhook URLs are detected and formatted as chat messages. Events: build.published, standing_link.updated, build.expiring, build.file_missing, tester.installed.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "https URL, or a Slack/Discord incoming webhook URL." },
            events: {
              type: "array",
              items: {
                type: "string",
                enum: ["build.published", "standing_link.updated", "build.expiring", "build.file_missing", "tester.installed"],
              },
              description: "Events to send. Defaults to everything except tester.installed.",
            },
            format: { type: "string", enum: ["json", "slack", "discord"], description: "Omit to detect from the URL." },
          },
          required: ["url"],
        },
      },
      {
        name: "betadrop_test_webhook",
        description: "Send a test event to a webhook now and report the receiver's answer.",
        inputSchema: {
          type: "object",
          properties: { webhookId: { type: "string", description: "Webhook ID." } },
          required: ["webhookId"],
        },
      },
      {
        name: "betadrop_delete_webhook",
        description: "Delete a webhook.",
        inputSchema: {
          type: "object",
          properties: { webhookId: { type: "string", description: "Webhook ID." } },
          required: ["webhookId"],
        },
      },
    ],
  };
});

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

// ─── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── Auth ───────────────────────────────────────────────────────────────

      case "betadrop_whoami": {
        const res = await apiFetch<WhoamiResponse>("/api/cli/whoami");
        if (!res.data) throw new Error("Unexpected response from BetaDrop.");

        const { user, token } = res.data;
        const apiBase = await apiBaseUrl();

        const tokenLines = token
          ? `Token Name: ${token.name}\n` +
            `Expires: ${token.expires_at ? new Date(token.expires_at).toLocaleDateString() : "Never"}\n` +
            `Last Used: ${token.last_used_at ? new Date(token.last_used_at).toLocaleDateString() : "Never"}`
          : "Authenticated via browser session (no CLI token)";

        return {
          content: [
            {
              type: "text",
              text:
                `Logged in to BetaDrop as: ${user.email} (${user.role})\n` +
                `API URL: ${apiBase}\n` +
                tokenLines,
            },
          ],
        };
      }

      case "betadrop_login": {
        const { token, apiUrl } = args as { token: string; apiUrl?: string };

        const res = await apiFetchWithToken<WhoamiResponse>("/api/cli/whoami", token);
        if (!res.data) throw new Error("Invalid API token.");

        await writeConfig({
          token,
          apiUrl: apiUrl || (await apiBaseUrl()),
          user: {
            id: res.data.user.id,
            email: res.data.user.email,
            role: res.data.user.role,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully logged in as ${res.data.user.email} (${res.data.user.role}). Credentials saved.`,
            },
          ],
        };
      }

      case "betadrop_logout": {
        // Revoke the token on the server first, then clear local config.
        // We make a best-effort call — if the user is already logged out or
        // the token is already expired, we still clear local state.
        try {
          await apiFetch("/api/cli/logout", { method: "POST" });
        } catch {
          // Swallow — token may already be revoked or expired.
        }
        await clearConfig();
        return {
          content: [
            {
              type: "text",
              text: "Successfully logged out. Token revoked on server and local credentials cleared.",
            },
          ],
        };
      }

      // ── Builds ─────────────────────────────────────────────────────────────

      case "betadrop_publish": {
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

              server.notification({
                method: "notifications/message",
                params: {
                  level: "info",
                  logger: "betadrop",
                  data: `Uploading… ${pct}% (${(sent / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`,
                },
              }).catch(() => {});
            }
          },
        }).then(async (result) => {
          const appUrl = resolveAppUrl();
          const installUrl = `${appUrl}/install/?i=${result.shortId}`;
          await updateStatus({
            status: "success",
            progress: 100,
            result: {
              name: result.meta.name,
              version: result.meta.version,
              platform: result.platform,
              fileSize: result.fileSize,
              installUrl,
              retentionClamp: result.retentionClamp ?? null,
              // Carried into the stored status, not just the immediate reply: the polling path
              // below is the one an agent actually reads when an upload outlives the tool call,
              // and dropping it here would make the notice appear only on fast uploads.
              duplicateOf: result.duplicateOf ?? null,
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
                  `Published **${result.meta.name}${result.meta.version ? ` ${result.meta.version}` : ""}** to BetaDrop.\n\n` +
                  `**Install link:** ${installUrl}\n\n` +
                  `Open it on an ${result.platform === "ios" ? "iPhone or iPad" : "Android device"} to install over the air — ` +
                  `no TestFlight, no store, no tester account. Share the link with anyone who needs the build.` +
                  // Relayed verbatim, and only when the plan actually shortened something. This is
                  // the one plan limit that fires on an ordinary upload, so it is the only moment
                  // an assistant can tell a free user what the paid tier buys — and before this the
                  // API's answer was rewritten in silence.
                  (result.retentionClamp ? `\n\n⚠️ ${result.retentionClamp.message}` : "") +
                  // Relayed with the other link spelled out. An assistant told only "this is a
                  // duplicate" would have to guess which of the two URLs to hand back.
                  (result.duplicateOf
                    ? `\n\nℹ️ ${result.duplicateOf.message}\nOriginal link: ${result.duplicateOf.url}`
                    : "") +
                  // The standing link is the URL worth handing out: it keeps serving the latest build.
                  (result.channel
                    ? `\n\n**Standing link ${result.channel.slug}** now serves this build: ${result.channel.url}`
                    : "") +
                  (result.channelWarning ? `\n\n⚠️ ${result.channelWarning}` : ""),
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
      }

      case "betadrop_upload_status": {
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

        const status = JSON.parse(raw) as {
          status: string;
          progress?: number;
          error?: string;
          result?: {
            name?: string;
            version?: string;
            platform?: string;
            installUrl?: string;
            retentionClamp?: { message: string } | null;
            duplicateOf?: { message: string; url: string } | null;
          };
        };

        if (status.status === "success" && status.result?.installUrl) {
          const r = status.result;
          return {
            content: [
              {
                type: "text",
                text:
                  `Published **${r.name ?? "build"}${r.version ? ` ${r.version}` : ""}** to BetaDrop.\n\n` +
                  `**Install link:** ${r.installUrl}\n\n` +
                  `Open it on an ${r.platform === "ios" ? "iPhone or iPad" : "Android device"} to install over the air.` +
                  (r.retentionClamp ? `\n\n⚠️ ${r.retentionClamp.message}` : "") +
                  (r.duplicateOf
                    ? `\n\nℹ️ ${r.duplicateOf.message}\nOriginal link: ${r.duplicateOf.url}`
                    : ""),
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
      }

      case "betadrop_list_builds": {
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
          return (
            `• [${b.platform.toUpperCase()}] ${b.meta.name} v${b.meta.version} — ${size} MB — ${date} — ${b.status}\n` +
            `  ${url}`
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
      }

      case "betadrop_list_expired_builds": {
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
          return (
            `• [${b.platform.toUpperCase()}] ${b.meta.name} v${b.meta.version} — ${size} MB\n` +
            `  Published: ${date} | Expired: ${expiredAt}\n` +
            `  ${url}`
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
      }

      // ── Token management ───────────────────────────────────────────────────

      case "betadrop_token_list": {
        const res = await apiFetch<TokenListResponse>("/api/cli/tokens");
        if (!res.data) throw new Error("Unexpected response from BetaDrop.");

        const { tokens } = res.data;
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No active tokens found." }] };
        }

        const lines = tokens.map((t) => {
          const expires = t.expires_at
            ? new Date(t.expires_at).toLocaleDateString()
            : "Never";
          const lastUsed = t.last_used_at
            ? new Date(t.last_used_at).toLocaleDateString()
            : "Never";
          const abilities = t.abilities.join(", ");
          return (
            `• ${t.name} [${t.id}]\n` +
            `  Abilities: ${abilities} | Expires: ${expires} | Last used: ${lastUsed}`
          );
        });

        return {
          content: [
            {
              type: "text",
              text: `${tokens.length} active token(s):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      }

      case "betadrop_token_create": {
        const { name: tokenName, abilities, expiresInDays } = args as {
          name: string;
          abilities?: string[];
          expiresInDays?: number;
        };

        const res = await apiFetch<TokenCreateResponse>("/api/cli/tokens", {
          method: "POST",
          body: {
            name: tokenName,
            abilities: abilities ?? ["*"],
            expires_in_days: expiresInDays ?? null,
          },
        });
        if (!res.data) throw new Error("Unexpected response from BetaDrop.");

        const t = res.data;
        const expires = t.expires_at
          ? new Date(t.expires_at).toLocaleDateString()
          : "Never";

        return {
          content: [
            {
              type: "text",
              text:
                `Token created! Copy it now — it will not be shown again.\n\n` +
                `Name: ${t.name}\n` +
                `ID: ${t.id}\n` +
                `Abilities: ${t.abilities.join(", ")}\n` +
                `Expires: ${expires}\n\n` +
                `Token: ${t.token}`,
            },
          ],
        };
      }

      case "betadrop_token_delete": {
        const { tokenId } = args as { tokenId: string };

        await apiFetch(`/api/cli/tokens/${tokenId}`, { method: "DELETE" });

        return {
          content: [
            {
              type: "text",
              text: `Token ${tokenId} has been revoked.`,
            },
          ],
        };
      }

      // ── Release checks ────────────────────────────────────────────────────

      case "betadrop_inspect": {
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
      }

      // ── Standing links ────────────────────────────────────────────────────

      case "betadrop_list_standing_links": {
        const res = await apiFetch<{ channels: StandingLink[] }>("/api/channels");
        const links = res.data?.channels ?? [];
        if (links.length === 0) {
          return { content: [{ type: "text", text: "No standing links. Create one at https://betadrop.app/channels/" }] };
        }
        const lines = links.map(
          (l) =>
            `• ${l.slug} — ${l.url}\n  Serving: ${l.currentBuild ? `${l.currentBuild.name ?? "build"} ${l.currentBuild.version ?? ""} [${l.currentBuild.id}]` : "nothing yet"} · ${l.followerCount ?? 0} follower(s)`,
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      case "betadrop_point_standing_link": {
        const { slug, buildId } = args as { slug: string; buildId: string };
        const res = await apiFetch<{ channels: StandingLink[] }>("/api/channels");
        const link = (res.data?.channels ?? []).find((l) => l.slug.toLowerCase() === slug.toLowerCase());
        if (!link) throw new Error(`No standing link "${slug}" on this account. Call betadrop_list_standing_links.`);
        await apiFetch(`/api/channels/${link.id}/build`, { method: "PUT", body: { buildId } });
        return {
          content: [
            {
              type: "text",
              text:
                `Standing link **${link.slug}** now serves build ${buildId}: ${link.url}` +
                ((link.followerCount ?? 0) > 0 ? `\n${link.followerCount} follower(s) will be emailed.` : ""),
            },
          ],
        };
      }

      // ── Builds ────────────────────────────────────────────────────────────

      case "betadrop_delete_build": {
        const { buildId } = args as { buildId: string };
        await apiFetch(`/api/builds/${encodeURIComponent(buildId)}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Build ${buildId} deleted. Its install link no longer works.` }] };
      }

      case "betadrop_get_feedback": {
        const { buildId } = args as { buildId: string };
        const res = await apiFetch<Array<Record<string, string | number | null>>>(
          `/api/builds/${encodeURIComponent(buildId)}/feedback`,
        );
        const items = res.data ?? [];
        if (items.length === 0) return { content: [{ type: "text", text: "No feedback on this build yet." }] };
        const text = items
          .map(
            (f) =>
              `• ${f.title || f.feedback_type} — ${f.reporter_name || f.reporter_email || "anonymous"}${f.rating ? ` · ${f.rating}/5` : ""} · ${f.created_at ?? ""}\n  ${String(f.description ?? "").replace(/\n/g, "\n  ")}`,
          )
          .join("\n\n");
        return { content: [{ type: "text", text: `${items.length} report(s):\n\n${text}` }] };
      }

      // ── iOS devices ───────────────────────────────────────────────────────

      case "betadrop_list_devices":
      case "betadrop_export_devices": {
        const res = await apiFetch<{ devices: Array<{ udid: string; label: string | null; product: string | null; tester_name: string | null; tester_email: string | null }> }>(
          "/api/devices",
        );
        const devices = res.data?.devices ?? [];
        if (name === "betadrop_export_devices") {
          const clean = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim();
          const rows = devices.map((d) => `${d.udid}\t${clean(d.label ?? d.tester_name ?? d.product ?? "Device") || "Device"}\tios`);
          const file = ["Device ID\tDevice Name\tDevice Platform", ...rows].join("\n") + "\n";
          return {
            content: [
              {
                type: "text",
                text: `${devices.length} device(s). Save this as devices.txt for Apple's portal or fastlane register_devices:\n\n\`\`\`\n${file}\`\`\``,
              },
            ],
          };
        }
        if (devices.length === 0) return { content: [{ type: "text", text: "No registered devices. Use betadrop_invite_device to collect some." }] };
        return {
          content: [
            {
              type: "text",
              text: devices
                .map((d) => `• ${d.udid} — ${d.label ?? d.product ?? "Device"}${d.tester_email ? ` (${d.tester_email})` : ""}`)
                .join("\n"),
            },
          ],
        };
      }

      case "betadrop_invite_device": {
        const { name: testerName, email, open } = (args ?? {}) as { name?: string; email?: string; open?: boolean };
        const body = open
          ? { kind: "open" }
          : { kind: "invite", tester_name: testerName, tester_email: email };
        if (!open && (!testerName || !email)) {
          throw new Error("Pass name and email for a personal invite, or open=true for the shareable link.");
        }
        const res = await apiFetch<{ link: { url: string; kind: string } }>("/api/devices/links", { method: "POST", body });
        const url = res.data?.link.url;
        return {
          content: [
            {
              type: "text",
              text: open
                ? `Shareable UDID registration link: ${url}\nTesters open it on their iPhone.`
                : `Invite emailed to ${email}. Their registration link: ${url}`,
            },
          ],
        };
      }

      // ── Webhooks ──────────────────────────────────────────────────────────

      case "betadrop_list_webhooks": {
        const res = await apiFetch<{ webhooks: Webhook[] }>("/api/webhooks");
        const hooks = res.data?.webhooks ?? [];
        if (hooks.length === 0) return { content: [{ type: "text", text: "No webhooks." }] };
        return {
          content: [
            {
              type: "text",
              text: hooks
                .map(
                  (w) =>
                    `• [${w.id}] ${w.url} (${w.format}) — ${w.active ? "on" : `off${w.disabledReason ? `: ${w.disabledReason}` : ""}`}\n  Events: ${w.events.join(", ")}`,
                )
                .join("\n\n"),
            },
          ],
        };
      }

      case "betadrop_create_webhook": {
        const { url, events, format } = args as { url: string; events?: string[]; format?: string };
        const res = await apiFetch<Webhook & { secret: string }>("/api/webhooks", {
          method: "POST",
          body: { url, ...(events ? { events } : {}), ...(format ? { format } : {}) },
        });
        const w = res.data!;
        return {
          content: [
            {
              type: "text",
              text:
                `Webhook created [${w.id}] (${w.format}) for: ${w.events.join(", ")}.` +
                (w.format === "json"
                  ? `\n\nSigning secret (shown once — store it where the receiver can read it): ${w.secret}\nVerify the BetaDrop-Signature header: HMAC-SHA256 of "<t>.<raw body>".`
                  : "") +
                `\n\nCall betadrop_test_webhook to send a test event.`,
            },
          ],
        };
      }

      case "betadrop_test_webhook": {
        const { webhookId } = args as { webhookId: string };
        const res = await apiFetch<{ ok: boolean; statusCode: number | null; error: string | null; durationMs: number }>(
          `/api/webhooks/${encodeURIComponent(webhookId)}/test`,
          { method: "POST" },
        );
        const r = res.data!;
        return {
          content: [
            {
              type: "text",
              text: r.ok
                ? `Delivered — the receiver answered HTTP ${r.statusCode} in ${r.durationMs} ms.`
                : `Not delivered: ${r.error ?? `HTTP ${r.statusCode}`}`,
            },
          ],
          ...(r.ok ? {} : { isError: true }),
        };
      }

      case "betadrop_delete_webhook": {
        const { webhookId } = args as { webhookId: string };
        await apiFetch(`/api/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Webhook ${webhookId} deleted.` }] };
      }

      // ── Reference ─────────────────────────────────────────────────────────

      case "betadrop_help": {
        return {
          content: [
            {
              type: "text",
              text: `# BetaDrop MCP — Tool Reference

BetaDrop MCP lets your AI assistant publish iOS/Android builds, manage API tokens,
and query build history — all without leaving your IDE.

---

## Authentication

| Tool | Description |
|------|-------------|
| betadrop_login | Validate and save a BetaDrop API token |
| betadrop_logout | Revoke token on server + clear local credentials |
| betadrop_whoami | Show current account and token details |

**Example prompts:**
- "Log me in to BetaDrop with token bd_live_xxx"
- "Am I logged in to BetaDrop?"
- "Log out of BetaDrop"

---

## Publishing Builds

| Tool | Description |
|------|-------------|
| betadrop_publish | Upload an .ipa or .apk to BetaDrop |

**Inputs:**
- \`filePath\` (required) — absolute path to .ipa or .apk
- \`name\` — override the app display name
- \`version\` — override the version string (e.g. "1.2.3")
- \`buildNumber\` — override the build number
- \`bundleId\` — override the bundle / package ID
- \`notes\` — release notes shown on the install page
- \`expiryType\` — none | time | downloads | devices | combined
- \`expiryTimeDays\` — expire after N days
- \`expiryDownloadLimit\` — expire after N downloads
- \`expiryDeviceLimit\` — expire after N unique devices

**Example prompts:**
- "Publish /Users/me/builds/MyApp.ipa to BetaDrop"
- "Upload this APK to BetaDrop with release notes 'Bug fixes'"
- "Publish MyApp.ipa and make it expire after 7 days"
- "Upload the build and expire it after 100 downloads"

---

## Build History

| Tool | Description |
|------|-------------|
| betadrop_list_builds | List recent builds, optionally filtered by platform and status |
| betadrop_list_expired_builds | List only expired builds (convenience shortcut) |

**betadrop_list_builds inputs:**
- \`platform\` — ios | android (optional)
- \`status\` — active | expired | disabled | deprecated | latest (optional)
- \`page\` — page number (default 1)
- \`perPage\` — results per page (default 20, max 100)

**betadrop_list_expired_builds inputs:**
- \`platform\` — ios | android (optional)
- \`page\` — page number (default 1)
- \`perPage\` — results per page (default 20, max 100)

**Example prompts:**
- "List my recent BetaDrop builds"
- "Show my last 10 iOS builds on BetaDrop"
- "What Android builds do I have on BetaDrop?"
- "Show all expired builds on BetaDrop"
- "List my expired iOS builds"

---

## Token Management

| Tool | Description |
|------|-------------|
| betadrop_token_list | List all active API tokens |
| betadrop_token_create | Create a new API token (shown once) |
| betadrop_token_delete | Revoke a token by ID |

**betadrop_token_create inputs:**
- \`name\` (required) — label for the token
- \`abilities\` — ["publish"] | ["read"] | ["*"] (default: all)
- \`expiresInDays\` — 1–365, omit for no expiry

**Example prompts:**
- "Show all my BetaDrop API tokens"
- "Create a read-only BetaDrop token called 'CI Pipeline'"
- "Create a BetaDrop token that expires in 30 days"
- "Revoke BetaDrop token abc-123"

---

## Release Checks

| Tool | Description |
|------|-------------|
| betadrop_inspect | Will this .ipa/.apk install from a link? Profile, signing, flags — nothing is published |

**Example prompts:**
- "Check build/MyApp.ipa will install before I publish it"
- "Is this APK debuggable or testOnly?"

---

## Standing Links

| Tool | Description |
|------|-------------|
| betadrop_list_standing_links | Standing links and the build each one serves |
| betadrop_point_standing_link | Point a standing link at an uploaded build |

\`betadrop_publish\` also takes \`standingLink\` to point one at the new build as it goes live.

**Example prompts:**
- "Publish MyApp.ipa to the acme-beta standing link"
- "Point acme-beta at build 9fdd1bfa-…"

---

## Builds, Feedback and Devices

| Tool | Description |
|------|-------------|
| betadrop_delete_build | Delete a build (its link stops working) |
| betadrop_get_feedback | Feedback testers left on a build |
| betadrop_list_devices | Registered iOS devices (UDIDs) |
| betadrop_export_devices | Devices as Apple's / fastlane's tab-separated file |
| betadrop_invite_device | A link a tester opens on their iPhone to register it |

**Example prompts:**
- "What did testers say about the last build?"
- "Export my BetaDrop devices for the Apple portal"
- "Send a UDID invite to sam@example.com"

---

## Webhooks

| Tool | Description |
|------|-------------|
| betadrop_list_webhooks | Webhooks on the account |
| betadrop_create_webhook | Send events to a URL, Slack or Discord |
| betadrop_test_webhook | Send a test event now |
| betadrop_delete_webhook | Delete a webhook |

Events: build.published, standing_link.updated, build.expiring, build.file_missing, tester.installed.

**Example prompts:**
- "Post new BetaDrop builds to this Slack webhook: https://hooks.slack.com/services/…"
- "Test my BetaDrop webhook"

---

## Configuration

Set these environment variables to override defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| BETADROP_API_URL | https://api.betadrop.app | API server URL (for self-hosted) |
| BETADROP_APP_URL | https://betadrop.app | Frontend URL for install links |
| BETADROP_TOKEN | (none) | Token for CI — skips the local config file |

**CI usage (no login required):**
\`\`\`
BETADROP_TOKEN=bd_live_xxx betadrop-mcp
\`\`\`
`,
            },
          ],
        };
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

// ─── Transport ───────────────────────────────────────────────────────────────

// Handle server-level errors (e.g. malformed JSON-RPC from the client).
server.onerror = (err) => {
  process.stderr.write(`[betadrop-mcp] Server error: ${err.message}\n`);
};

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[betadrop-mcp] Server started successfully (v${__MCP_VERSION__})\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[betadrop-mcp] Failed to start: ${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}
