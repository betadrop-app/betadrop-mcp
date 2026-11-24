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
        ["betadrop_publish", "Upload an .ipa or .apk from this computer as a new build with its own install link"],
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
        ["betadrop_restore_build", "Bring back a build retired after it expired, while its file is kept (uses storage again)"],
        ["betadrop_update_link", "Set or remove a build link's password, or give it a custom code (Pro and Studio)"],
      ],
      [
        [
          "betadrop_update_link",
          "**betadrop_update_link inputs:**\n" +
            "- `buildId` (required) — the build whose install link changes\n" +
            "- `password` — a new password (at least 4 characters); testers enter it on the install page\n" +
            "- `removePassword` — true to make the link open to anyone who has it\n" +
            "- `code` — a custom code, 6–12 letters and numbers; the old install URL stops working\n" +
            "- `link` — the current code of the link to change, for a build with more than one",
        ],
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
        ["betadrop_restore_build", "Restore my expired ShopEase build"],
        ["betadrop_update_link", "Put a password on the link for my latest build"],
        ["betadrop_update_link", "Change my latest build's link to /install/?i=acmebeta"],
      ],
    ),
    section(
      "Release checks",
      [
        [
          "betadrop_inspect",
          "Check an .ipa, .apk, .aab or .mobileprovision: profile, signing, 16 KB page size, Google registration, install-link verdict — nothing is published",
        ],
        ["betadrop_android_registration", "Is a package name and signing key registered with Google's developer verification?"],
        ["betadrop_convert_aab", "Turn an .aab into one universal .apk, signed with a test key kept on this computer"],
      ],
      [
        [
          "betadrop_inspect",
          "betadrop_inspect reads the file on this computer. The install-link verdict for an .ipa or .apk comes from BetaDrop and needs sign-in; the other checks don't.",
        ],
        [
          "betadrop_convert_aab",
          "**betadrop_convert_aab inputs:**\n" +
            "- `filePath` (required) — absolute path to the .aab\n" +
            "- `outputPath` — where to write the .apk (default: next to the .aab)\n" +
            "- `overwrite` — replace an existing file at `outputPath`\n" +
            "- `newTestKey` — sign with a new test key (testers then uninstall earlier converted APKs)\n\n" +
            "The APK is signed with a test key, not the upload or release key: for testers, not for Google Play.",
        ],
      ],
      [
        ["betadrop_inspect", "Check build/MyApp.ipa will install before I publish it"],
        ["betadrop_inspect", "Is this APK debuggable or testOnly?"],
        ["betadrop_inspect", "Does app-release.aab support 16 KB page sizes?"],
        ["betadrop_inspect", "What's in this .mobileprovision?"],
        ["betadrop_android_registration", "Is com.example.app registered with Google for this SHA-256?"],
        ["betadrop_convert_aab", "Convert app-release.aab to an APK I can share"],
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
        ["betadrop_token_create", "Create an API token in the calling token's workspace (value shown once)"],
        ["betadrop_token_delete", "Revoke a token by ID, at once and for good"],
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
        ["betadrop_delete_webhook", "Delete a webhook for good; its URL gets no more events"],
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
    section(
      "Developer tools",
      [
        ["betadrop_app_icons", "iOS and Android app icon sets from one image, with the App Store and Play icons"],
        ["betadrop_generate_plist", "An ExportOptions.plist or an OTA manifest.plist"],
        ["betadrop_qr_code", "A QR code for an install link or any URL"],
      ],
      [
        [null, "These make files from their inputs alone: no sign-in, and nothing is sent to BetaDrop."],
        [
          "betadrop_app_icons",
          "**betadrop_app_icons inputs:** `imagePath` (required, PNG or JPEG), `platforms` (ios | android | both), " +
            "`outputDir`, or `projectDir` to replace a project's own AppIcon.appiconset and launcher icons, `mode` (logo | full), `padding` (%), `backgroundColor`.",
        ],
        [
          "betadrop_generate_plist",
          "**betadrop_generate_plist inputs:** `kind` (exportOptions | manifest). exportOptions: `method`, `teamID`, `signingStyle`, `bundleId` + `provisioningProfile`, " +
            "`provisioningProfiles`, `signingCertificate`, `destination`, `thinning`, `scheme`. manifest: `ipaUrl`, `bundleId`, `bundleVersion`, `title`, `manifestUrl`, image URLs." +
            (remote ? "" : " `outputPath` saves the file."),
        ],
        ["betadrop_qr_code", `**betadrop_qr_code inputs:** \`url\` (required), \`size\` (px, default 512)${remote ? "" : ", `outputPath` (.png or .svg)"}.`],
      ],
      [
        ["betadrop_app_icons", "Make app icons for iOS and Android from design/icon.png"],
        ["betadrop_app_icons", "Put new app icons from logo.png into this Flutter project"],
        ["betadrop_generate_plist", "Write an ExportOptions.plist for app-store-connect with team ABCDE12345"],
        ["betadrop_generate_plist", "Make a manifest.plist for https://example.com/MyApp.ipa"],
        ["betadrop_qr_code", "QR code for my latest install link"],
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
