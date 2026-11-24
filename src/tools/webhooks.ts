// Webhooks tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { Webhook } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

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
  handlers: {
    betadrop_list_webhooks: listWebhooks,
    betadrop_create_webhook: createWebhook,
    betadrop_test_webhook: testWebhook,
    betadrop_delete_webhook: deleteWebhook,
  },
};
