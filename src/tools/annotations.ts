import type { ToolAnnotations } from "@modelcontextprotocol/server";

const read = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** A write that adds or changes something without removing or overwriting what was there. */
const write = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...extra,
});

/** A write that deletes, revokes or replaces something the user had. */
const destructive = (title: string, extra: Partial<ToolAnnotations> = {}): ToolAnnotations =>
  write(title, { destructiveHint: true, ...extra });

/**
 * The title and behaviour hints every tool declares. The connector directory requires a title and
 * readOnlyHint/destructiveHint on each one, and clients use them to decide what needs a
 * confirmation. openWorldHint marks tools that reach outside BetaDrop: a URL the user supplied,
 * or an email to a tester.
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  betadrop_welcome: read("Account overview"),
  betadrop_whoami: read("Check sign-in"),
  betadrop_login: write("Sign in with a token", { idempotentHint: true }),
  betadrop_logout: destructive("Sign out and revoke token", { idempotentHint: true }),

  betadrop_publish: write("Publish a build file"),
  betadrop_upload_status: read("Check publish status"),
  betadrop_list_builds: read("List builds"),
  betadrop_list_expired_builds: read("List expired builds"),
  betadrop_delete_build: destructive("Delete a build", { idempotentHint: true }),
  betadrop_get_feedback: read("Read tester feedback"),
  // Brings a build back rather than removing anything, so not destructive; a second call on a
  // restored build changes nothing, so idempotent. Its link only works again: nothing outside
  // BetaDrop is contacted.
  betadrop_restore_build: write("Restore an expired build", { idempotentHint: true }),
  // Destructive: a new code replaces the old one, so the install URL testers already hold stops
  // working, and a new password signs out everyone who unlocked the link. Not idempotent: setting
  // the same password again signs them out again. Open-world: the change lands on a public URL in
  // testers' hands, and removing a password opens the build to anyone who has the link.
  betadrop_update_link: destructive("Change a build's install link", { openWorldHint: true }),

  betadrop_create_upload_link: write("Create an upload link"),
  betadrop_publish_from_url: write("Publish a build from a URL", { openWorldHint: true }),
  betadrop_check_upload: read("Check an upload"),

  betadrop_build_analytics: read("Build install analytics"),
  betadrop_inspect: read("Inspect a build file"),
  betadrop_android_registration: { ...read("Check Android developer registration"), openWorldHint: true },
  betadrop_convert_aab: write("Convert an .aab to a test-signed .apk"),

  betadrop_token_list: read("List API tokens"),
  betadrop_token_create: write("Create an API token"),
  betadrop_token_delete: destructive("Revoke an API token", { idempotentHint: true }),

  betadrop_list_standing_links: read("List standing links"),
  betadrop_point_standing_link: destructive("Point a standing link at a build", {
    idempotentHint: true,
    openWorldHint: true,
  }),

  betadrop_list_devices: read("List registered devices"),
  betadrop_export_devices: read("Export devices for Apple"),
  betadrop_invite_device: write("Invite a tester's device", { openWorldHint: true }),

  betadrop_list_webhooks: read("List webhooks"),
  betadrop_create_webhook: write("Create a webhook", { openWorldHint: true }),
  betadrop_test_webhook: write("Send a test webhook event", { openWorldHint: true }),
  betadrop_delete_webhook: destructive("Delete a webhook", { idempotentHint: true }),

  // Generators: they make files from their inputs and never call the BetaDrop API.
  betadrop_app_icons: destructive("Make app icon sets", { idempotentHint: true }),
  betadrop_generate_plist: write("Generate a plist"),
  betadrop_qr_code: write("Make a QR code"),

  betadrop_help: read("BetaDrop tool reference"),
};
