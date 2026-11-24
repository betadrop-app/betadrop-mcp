// iOS devices tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { ToolHandler, ToolModule } from "./types.js";

const listDevices: ToolHandler = async (_args, { name }) => {
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
};

const inviteDevice: ToolHandler = async (args) => {
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
};

export const tools: ToolModule = {
  definitions: [
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
  ],
  handlers: {
    betadrop_list_devices: listDevices,
    betadrop_export_devices: listDevices,
    betadrop_invite_device: inviteDevice,
  },
};
