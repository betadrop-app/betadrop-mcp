// Reference tools: what `tools/list` shows and what runs on `tools/call`.
//
import { LOCAL_ONLY_TOOLS } from "./local.js";
import type { ToolHandler, ToolModule } from "./types.js";

/**
 * A line of the reference and the tool it is about: when that tool is hidden, so is the line.
 * `null` for a line about no one tool, which always shows.
 */
type Line = [tool: string | null, text: string];

/** The tool reference. `remote` leaves out the tools the hosted connector does not have. */
function reference(remote: boolean): string {
  const shown = (tool: string | null) => tool === null || !(remote && LOCAL_ONLY_TOOLS.has(tool));
  const visible = <L extends Line>(lines: L[]) => lines.filter(([tool]) => shown(tool));

  /** One area: its tools, then notes on them, then example prompts. Gone when no tool is left. */
  const section = (
    title: string,
    tools: Array<[tool: string, what: string]>,
    details: Line[],
    examples: Line[],
  ): string | null => {
    const rows = visible(tools);
    if (rows.length === 0) return null;
    const prompts = visible(examples);
    return [
      `## ${title}`,
      "| Tool | Description |\n|------|-------------|\n" + rows.map(([tool, what]) => `| ${tool} | ${what} |`).join("\n"),
      ...visible(details).map(([, text]) => text),
      prompts.length ? "**Example prompts:**\n" + prompts.map(([, p]) => `- "${p}"`).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  // Which tools take a standing link, in the words of each one's own input.
  const standingLinkInputs = [
    shown("betadrop_publish") ? "`betadrop_publish` takes `standingLink`" : "",
    "`betadrop_create_upload_link` and `betadrop_publish_from_url` take `channel`",
  ].filter(Boolean);

  const sections = [
    section(
      "Start here",
      [
        ["betadrop_welcome", "Your account, latest builds and what to ask next"],
        ["betadrop_whoami", "Which account is signed in, and the token's details"],
        ["betadrop_login", "Check a BetaDrop API token and save it on this computer"],
        ["betadrop_logout", "Revoke the token on BetaDrop and remove it from this computer"],
        ["betadrop_help", "This reference"],
      ],
      [],
      [
        ["betadrop_welcome", "Hi BetaDrop, what can you do?"],
        ["betadrop_whoami", "Am I logged in to BetaDrop?"],
        ["betadrop_login", "Log me in to BetaDrop with token bd_live_xxx"],
        ["betadrop_logout", "Log out of BetaDrop"],
      ],
    ),
    section(
      "Publishing builds",
      [
        ["betadrop_publish", "Upload an .ipa or .apk from this computer"],
        ["betadrop_upload_status", "The result of a betadrop_publish that was still uploading"],
        ["betadrop_create_upload_link", "A one-time link the user opens in a browser to drop an .ipa or .apk on"],
        ["betadrop_publish_from_url", "Publish an .ipa or .apk that is already online"],
        ["betadrop_check_upload", "The result of an upload link or a URL publish, with the install link"],
      ],
      [
        [
          null,
          "BetaDrop takes .ipa (iOS) and .apk (Android) files. App bundles (.aab) can't be installed from a link, so build a universal .apk instead.",
        ],
        [
          "betadrop_publish",
          "**betadrop_publish inputs:**\n" +
            "- `filePath` (required) — absolute path to the .ipa or .apk\n" +
            "- `name` — override the app display name\n" +
            '- `version` — override the version string (e.g. "1.2.3")\n' +
            "- `buildNumber` — override the build number\n" +
            "- `bundleId` — override the bundle / package ID\n" +
            "- `notes` — release notes shown on the install page\n" +
            "- `expiryType` — none | time | downloads | devices | combined\n" +
            "- `expiryTimeDays` — expire after N days\n" +
            "- `expiryDownloadLimit` — expire after N downloads\n" +
            "- `expiryDeviceLimit` — expire after N unique devices\n" +
            "- `standingLink` — slug of a standing link to point at the new build",
        ],
        [
          "betadrop_create_upload_link",
          "**betadrop_create_upload_link and betadrop_publish_from_url inputs:**\n" +
            "- `url` (betadrop_publish_from_url only, required) — public https:// link to the .ipa or .apk\n" +
            "- `name` — override the app display name\n" +
            "- `notes` — release notes shown on the install page\n" +
            "- `expiryDays` — expire the build after N days (1–3650)\n" +
            "- `channel` — slug of a standing link to point at the new build",
        ],
        [
          "betadrop_publish_from_url",
          "betadrop_publish_from_url waits up to 40 seconds. If the build is still downloading then, it returns an upload ID for betadrop_check_upload.",
        ],
        ...(remote
          ? ([
              [
                null,
                "A file on your computer, or one attached in this chat, can't reach BetaDrop from here. Use an upload link, or a URL for a build that is already online.",
              ],
            ] as Line[])
          : []),
      ],
      [
        ["betadrop_publish", "Publish /Users/me/builds/MyApp.ipa to BetaDrop"],
        ["betadrop_publish", "Upload this APK to BetaDrop with release notes 'Bug fixes'"],
        ["betadrop_publish", "Publish MyApp.ipa and make it expire after 7 days"],
        ["betadrop_create_upload_link", "Give me an upload link for my APK"],
        ["betadrop_publish_from_url", "Publish https://github.com/me/app/releases/download/v2/app.apk"],
        ["betadrop_check_upload", "Is my upload done yet?"],
      ],
    ),
    section(
      "Builds",
      [
        ["betadrop_list_builds", "Recent builds, filtered by platform or status"],
        ["betadrop_list_expired_builds", "Expired builds only"],
        ["betadrop_build_analytics", "Installs, devices, countries and failed installs for one build"],
        ["betadrop_get_feedback", "Feedback testers left on a build"],
        ["betadrop_delete_build", "Delete a build (its link stops working)"],
      ],
      [
        [
          "betadrop_list_builds",
          "Each build in a list shows its ID. betadrop_delete_build, betadrop_get_feedback and betadrop_point_standing_link take that ID.",
        ],
        [
          "betadrop_list_builds",
          "**betadrop_list_builds inputs:**\n" +
            "- `platform` — ios | android (optional)\n" +
            "- `status` — active | expired | disabled | deprecated | latest (optional)\n" +
            "- `page` — page number (default 1)\n" +
            "- `perPage` — results per page (default 20, max 100)",
        ],
        [
          "betadrop_list_expired_builds",
          "**betadrop_list_expired_builds inputs:** `platform`, `page` and `perPage`, as above.",
        ],
        [
          "betadrop_build_analytics",
          "**betadrop_build_analytics inputs:**\n" +
            "- `build` — an ID or shortId, or an app name (its newest build). Your newest 500 builds are searched. Omit for the latest build.\n" +
            "- `days` — length of the daily trend, 1–90 (default 14)\n\n" +
            "Installs carry no tester names, so analytics cannot say who installed a build.",
        ],
      ],
      [
        ["betadrop_list_builds", "List my recent BetaDrop builds"],
        ["betadrop_list_builds", "Show my last 10 iOS builds on BetaDrop"],
        ["betadrop_list_expired_builds", "Which of my builds have expired?"],
        ["betadrop_build_analytics", "How is my latest build doing?"],
        ["betadrop_build_analytics", "Which countries and devices installed ShopEase?"],
        ["betadrop_get_feedback", "What did testers say about the last build?"],
      ],
    ),
    section(
      "Release checks",
      [["betadrop_inspect", "Will this .ipa or .apk install from a link? Profile, signing, flags — nothing is published"]],
      [],
      [
        ["betadrop_inspect", "Check build/MyApp.ipa will install before I publish it"],
        ["betadrop_inspect", "Is this APK debuggable or testOnly?"],
      ],
    ),
    section(
      "Standing links",
      [
        ["betadrop_list_standing_links", "Standing links and the build each one serves"],
        ["betadrop_point_standing_link", "Point a standing link at an uploaded build"],
      ],
      [["betadrop_list_standing_links", `${standingLinkInputs.join(", and ")}, to point one at the new build as it goes live.`]],
      [
        ["betadrop_publish", "Publish MyApp.ipa to the acme-beta standing link"],
        ["betadrop_publish_from_url", "Publish this APK URL and point acme-beta at it"],
        ["betadrop_point_standing_link", "Point acme-beta at build 9fdd1bfa-…"],
      ],
    ),
    section(
      "iOS devices",
      [
        ["betadrop_list_devices", "Registered iOS devices (UDIDs)"],
        ["betadrop_export_devices", "Devices as Apple's / fastlane's tab-separated file"],
        ["betadrop_invite_device", "A link a tester opens on their iPhone to register it"],
      ],
      [],
      [
        ["betadrop_export_devices", "Export my BetaDrop devices for the Apple portal"],
        ["betadrop_invite_device", "Send a UDID invite to sam@example.com"],
      ],
    ),
    section(
      "API tokens",
      [
        ["betadrop_token_list", "List all active API tokens"],
        ["betadrop_token_create", "Create a new API token (shown once)"],
        ["betadrop_token_delete", "Revoke a token by ID"],
      ],
      [
        [
          "betadrop_token_create",
          "**betadrop_token_create inputs:**\n" +
            "- `name` (required) — label for the token\n" +
            '- `abilities` — ["publish"] | ["read"] | ["*"] (default: all)\n' +
            "- `expiresInDays` — 1–365, omit for no expiry",
        ],
      ],
      [
        ["betadrop_token_list", "Show all my BetaDrop API tokens"],
        ["betadrop_token_create", "Create a read-only BetaDrop token called 'CI Pipeline'"],
        ["betadrop_token_create", "Create a BetaDrop token that expires in 30 days"],
        ["betadrop_token_delete", "Revoke BetaDrop token abc-123"],
      ],
    ),
    section(
      "Webhooks",
      [
        ["betadrop_list_webhooks", "Webhooks on the account"],
        ["betadrop_create_webhook", "Send events to a URL, Slack or Discord"],
        ["betadrop_test_webhook", "Send a test event now"],
        ["betadrop_delete_webhook", "Delete a webhook"],
      ],
      [
        [
          "betadrop_create_webhook",
          "Events: build.published, standing_link.updated, build.expiring, build.file_missing, tester.installed.",
        ],
      ],
      [
        ["betadrop_create_webhook", "Post new BetaDrop builds to this Slack webhook: https://hooks.slack.com/services/…"],
        ["betadrop_test_webhook", "Test my BetaDrop webhook"],
      ],
    ),
    // Environment variables configure the process this server runs in: the user's own over stdio,
    // ours behind the hosted connector, where nothing here applies to them.
    remote
      ? null
      : "## Configuration\n\n" +
        "Set these environment variables to override defaults:\n\n" +
        "| Variable | Default | Description |\n" +
        "|----------|---------|-------------|\n" +
        "| BETADROP_API_URL | https://api.betadrop.app | API server URL (for self-hosted) |\n" +
        "| BETADROP_APP_URL | https://betadrop.app | Frontend URL for install links |\n" +
        "| BETADROP_TOKEN | (none) | Token for CI — skips the local config file |\n\n" +
        "**CI usage (no login required):**\n" +
        "```\nBETADROP_TOKEN=bd_live_xxx betadrop-mcp\n```",
  ].filter((s): s is string => s !== null);

  const intro = remote
    ? "The BetaDrop connector lets your assistant publish iOS and Android builds, share install links, " +
      "and manage builds, tokens and webhooks from this chat.\n\n" +
      "Publishing a file from your computer, and checking one before you publish it, need the local " +
      "server: `npx -y @betadrop/mcp`."
    : "BetaDrop MCP lets your AI assistant publish iOS and Android builds, share install links, " +
      "and manage builds, tokens and webhooks without leaving your IDE.";

  return `# BetaDrop MCP — Tool Reference\n\n${intro}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

const help: ToolHandler = async (_args, { remote }) => {
  return { content: [{ type: "text", text: reference(remote) }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_help",
      description:
        "Get a quick reference of all available BetaDrop MCP tools, their inputs, and example prompts.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  handlers: {
    betadrop_help: help,
  },
};
