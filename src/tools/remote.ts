// Remote publishing tools: what `tools/list` shows and what runs on `tools/call`.
//
// For hosts that cannot hand a file to a tool — Claude and ChatGPT through the remote connector,
// where a chat attachment never reaches the server. Two ways round it, one status to poll: an
// upload link the user opens in a browser, or a URL the API downloads itself.
import { apiFetch } from "../lib/api.js";
import { installable, publishNotes, publishWarnings, readyToShare } from "../lib/publish-notices.js";
import type { RemoteUpload, UploadLink } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

/**
 * How long `betadrop_publish_from_url` may hold the call, from its start, before handing off to
 * `betadrop_check_upload`.
 *
 * nginx gives the remote connector 60s to answer (`proxy_read_timeout`), and the bearer-token check
 * runs before the tool. At 60s plus one more status check, a slow download got a 504 and the
 * upload ID never reached the assistant. 40s leaves room for both, and no check outlives it.
 */
const URL_WAIT_MS = 40_000;
const POLL_MS = 2_000;

/** The publish options both tools accept, passed through as the API reads them. */
const OPTION_PROPERTIES = {
  name: { type: "string", description: "Override the app's display name." },
  notes: { type: "string", description: "Release notes shown on the install page." },
  expiryDays: { type: "number", description: "Expire the build after this many days (1–3650)." },
  channel: { type: "string", description: "Point this standing link (by slug) at the new build." },
} as const;

function options(args: Record<string, unknown> | undefined) {
  const { name, notes, expiryDays, channel } = (args ?? {}) as Record<string, unknown>;
  return { name, notes, expiryDays, channel };
}

/** What the assistant tells the user once a remote upload has an outcome. */
function describe(r: RemoteUpload): string {
  if (r.status === "done" && r.build) {
    const b = r.build;
    const platform = b.platform === "ios" ? "iOS" : "Android";
    const version = b.meta?.version ? ` ${b.meta.version}` : "";
    return (
      // First, so a held or uninstallable build is never read as ready to share.
      publishWarnings(b).map((w) => `${w}\n\n`).join("") +
      `${installable(b) ? "✅ " : ""}Published **${b.meta?.name ?? "build"}${version}** (${platform})\n\n` +
      `Install link: ${b.url}\n` +
      `Build ID: ${b.id}` +
      publishNotes(b).map((n) => `\n\n${n}`).join("") +
      (readyToShare(b) ? "\n\nTesters open the link on their phone to install." : "")
    );
  }
  if (r.status === "failed") {
    return (
      `❌ The build was not published: ${r.error ?? "unknown error"}` +
      (r.kind === "link" ? "\n\nThe same upload link still works until it expires — try another file." : "")
    );
  }
  if (r.status === "pending") {
    return `⏳ Waiting for the upload — the link has not been used yet (expires ${new Date(r.expiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}).`;
  }
  return r.kind === "url"
    ? "⏳ Still downloading and checking the build. Ask me to check again in a minute."
    : "⏳ The upload is in progress. Ask me to check again once the page says it is done.";
}

const createUploadLink: ToolHandler = async (args) => {
  const res = await apiFetch<UploadLink>("/api/cli/upload-links", { method: "POST", body: options(args) });
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");
  const { id, url, expiresInMinutes } = res.data;
  return {
    content: [
      {
        type: "text",
        text:
          `Here is a secure upload link (works once, expires in ${expiresInMinutes} minutes):\n\n${url}\n\n` +
          "Open it, drop the .apk or .ipa onto the page, and the build publishes to your BetaDrop account. " +
          "No sign-in needed — the link is the permission, so do not share it.\n\n" +
          `Upload ID: ${id} — once the page says it is published, ask me to check it and I will share the install link.`,
      },
    ],
  };
};

const publishFromUrl: ToolHandler = async (args) => {
  // From the start of the call, so the request that starts the publish counts against it too.
  const deadline = Date.now() + URL_WAIT_MS;
  const { url } = (args ?? {}) as { url?: string };
  if (!url) throw new Error("A url is required.");
  const res = await apiFetch<{ id: string }>("/api/cli/publish-url", {
    method: "POST",
    body: { url, ...options(args) },
  });
  const id = res.data?.id;
  if (!id) throw new Error("Unexpected response from BetaDrop.");

  // Most builds download and publish well inside the wait: wait for them here, so the common case
  // is one reply instead of a "check again" round trip. From here on nothing may throw: the publish
  // is running, and the upload ID is the assistant's only way back to it.
  let latest: RemoteUpload | undefined;
  while (Date.now() + POLL_MS < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const polled = await beforeDeadline(
      apiFetch<RemoteUpload>(`/api/cli/remote-uploads/${encodeURIComponent(id)}`),
      deadline,
    );
    if (polled?.data) latest = polled.data;
    if (latest && latest.status !== "uploading") break;
  }
  const text =
    latest && latest.status !== "uploading"
      ? `${describe(latest)}\n\nUpload ID: ${id}`
      : `⏳ Still downloading and checking the build. Call betadrop_check_upload with id ${id} in a minute to get the install link.`;
  return { content: [{ type: "text", text }] };
};

/**
 * `request`'s answer, or `undefined` when it fails or is still running at `deadline`. A status check
 * that hangs is left behind rather than awaited: `apiFetch` gives up only after 30s, which would
 * run the call past nginx's timeout.
 */
async function beforeDeadline<T>(request: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
  });
  try {
    // The catch is attached before the race, so a check abandoned here cannot reject unhandled.
    return await Promise.race([request.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

const checkUpload: ToolHandler = async (args) => {
  const { id } = (args ?? {}) as { id?: string };
  if (!id) throw new Error("An upload id is required.");
  const res = await apiFetch<RemoteUpload>(`/api/cli/remote-uploads/${encodeURIComponent(id)}`);
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");
  return { content: [{ type: "text", text: describe(res.data) }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_create_upload_link",
      description:
        "Create a one-time, 30-minute upload link the user opens in a browser to drop an .apk or .ipa, which then publishes to their BetaDrop account. It works for any build whose file can't be passed along directly, including one attached in chat, since chat attachments do not reach BetaDrop. Returns an upload ID; betadrop_check_upload reports its status and install link.",
      inputSchema: { type: "object", properties: OPTION_PROPERTIES },
    },
    {
      name: "betadrop_publish_from_url",
      description:
        "Publish an .apk or .ipa that is already online — a CI artifact, a GitHub release asset, or any public https:// download link. BetaDrop downloads and publishes it, and this waits up to 40 seconds for the result. If it is still running then, the reply has an upload ID for betadrop_check_upload.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public https:// URL of the .apk or .ipa." },
          ...OPTION_PROPERTIES,
        },
        required: ["url"],
      },
    },
    {
      name: "betadrop_check_upload",
      description:
        "Check an upload started with betadrop_create_upload_link or betadrop_publish_from_url, and get the install link once it is published.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The upload ID those tools returned." } },
        required: ["id"],
      },
    },
  ],
  handlers: {
    betadrop_create_upload_link: createUploadLink,
    betadrop_publish_from_url: publishFromUrl,
    betadrop_check_upload: checkUpload,
  },
};
