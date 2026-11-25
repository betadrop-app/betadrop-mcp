// Webhooks tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { Webhook } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

/** Every event a webhook can listen to; the catalogue in api/crates/api/src/webhooks.rs is the source. */
const EVENTS = [
  "build.published",
  "standing_link.updated",
  "build.expiring",
  "build.file_missing",
  "tester.installed",
  "feedback.received",
  "feedback.status_changed",
];

const listWebhooks: ToolHandler = async () => {
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
};

const createWebhook: ToolHandler = async (args) => {
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
};

const updateWebhook: ToolHandler = async (args) => {
  const { webhookId, events, bundleIds, description, active } = args as {
    webhookId: string;
    events?: string[];
    bundleIds?: string[];
    description?: string;
    active?: boolean;
  };
  // Only the fields the assistant passed are sent, because the PATCH keeps everything else as
  // stored. An empty bundleIds list goes as null, which is how the API spells "every app".
  const body: Record<string, unknown> = {
    ...(events ? { events } : {}),
    ...(bundleIds ? { bundleIds: bundleIds.length ? bundleIds : null } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(active !== undefined ? { active } : {}),
  };
  if (Object.keys(body).length === 0) {
    return {
      content: [{ type: "text", text: "Nothing to change: pass events, bundleIds, description or active." }],
      isError: true,
    };
  }
  const res = await apiFetch<Webhook>(`/api/webhooks/${encodeURIComponent(webhookId)}`, { method: "PATCH", body });
  const w = res.data!;
  return {
    content: [
      {
        type: "text",
        text:
          `Webhook updated [${w.id}] — ${w.active ? "on" : "off"}.\n  Events: ${w.events.join(", ")}` +
          `\n  Apps: ${w.bundleIds?.length ? w.bundleIds.join(", ") : "every app"}`,
      },
    ],
  };
};

const testWebhook: ToolHandler = async (args) => {
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
};

const deleteWebhook: ToolHandler = async (args) => {
  const { webhookId } = args as { webhookId: string };
  await apiFetch(`/api/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
  return { content: [{ type: "text", text: `Webhook ${webhookId} deleted.` }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_list_webhooks",
      description:
        "List webhooks that send build and feedback events to the user's systems, Slack, Discord or Microsoft Teams.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_create_webhook",
      description:
        "Send build and feedback events to a URL. Slack and Discord webhook URLs are detected and formatted as chat messages; so are Microsoft Teams (Workflows) URLs once the Teams format is switched on for the server, and until then a Teams URL is refused with format_unavailable. Events: build.published, standing_link.updated, build.expiring, build.file_missing, tester.installed, feedback.received, feedback.status_changed.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "https URL, or a Slack, Discord or Microsoft Teams (Workflows) webhook URL. Teams needs the format switched on for the server.",
          },
          events: {
            type: "array",
            items: {
              type: "string",
              enum: EVENTS,
            },
            description: "Events to send. Defaults to everything except tester.installed and feedback.status_changed.",
          },
          format: { type: "string", enum: ["json", "slack", "discord", "teams"], description: "Omit to detect from the URL." },
        },
        required: ["url"],
      },
    },
    {
      name: "betadrop_update_webhook",
      description:
        "Change which events and apps a webhook covers, its description, or switch it on or off. Fields left out keep their stored value. The events list given replaces the endpoint's stored list.",
      inputSchema: {
        type: "object",
        properties: {
          webhookId: { type: "string", description: "Webhook ID." },
          events: {
            type: "array",
            items: { type: "string", enum: EVENTS },
            description: "The full list of events to send.",
          },
          bundleIds: {
            type: "array",
            items: { type: "string" },
            description: "Only send events about these apps (bundle ids or package names). An empty list means every app.",
          },
          description: { type: "string", description: "A note on what receives the events. Empty clears it." },
          active: { type: "boolean", description: "Switch the webhook on (true) or off (false)." },
        },
        required: ["webhookId"],
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
      description:
        "Delete a webhook permanently. BetaDrop stops sending events to its URL at once, and its queued deliveries and delivery log are deleted with it; a webhook re-created for the same URL gets a new ID and signing secret. In a team workspace only owners and admins can delete one.",
      inputSchema: {
        type: "object",
        properties: { webhookId: { type: "string", description: "ID of the webhook to delete (from betadrop_list_webhooks)." } },
        required: ["webhookId"],
      },
    },
  ],
  handlers: {
    betadrop_list_webhooks: listWebhooks,
    betadrop_create_webhook: createWebhook,
    betadrop_update_webhook: updateWebhook,
    betadrop_test_webhook: testWebhook,
    betadrop_delete_webhook: deleteWebhook,
  },
};
