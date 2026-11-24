// What a publish result says beyond the install link: holds, signing problems, Android developer
// verification, standing links. One wording for betadrop_publish, betadrop_upload_status,
// betadrop_check_upload and betadrop_publish_from_url.
//
// Without it the four results read every build as ready, so an assistant handed out links to builds
// a review held or that no device can install. The words follow the dashboard's upload screen.
import { resolveAppUrl } from "./config.js";
import type { AndroidRegistration, PublishNotices } from "../types.js";

const NOTICE_KEYS = [
  "held_for_review",
  "signingReach",
  "repackagedWarning",
  "android_registration",
  "signer_change",
  "retentionClamp",
  "duplicateOf",
  "channel",
  "channelWarning",
  "standingLinksMoved",
] as const satisfies ReadonlyArray<keyof PublishNotices>;

/** The notice fields of a publish response, for storing next to an upload's status. */
export function pickNotices(r: PublishNotices): PublishNotices {
  const picked: Record<string, unknown> = {};
  for (const key of NOTICE_KEYS) {
    if (r[key] !== undefined) picked[key] = r[key];
  }
  return picked as PublishNotices;
}

/** Whether testers can install from the link at all: not held for review, and signed to install. */
export function installable(r: PublishNotices): boolean {
  return r.held_for_review !== true && !r.signingReach;
}

/** Whether the link can go out as it is: installable, and not flagged as a copy of someone else's app. */
export function readyToShare(r: PublishNotices): boolean {
  return installable(r) && !r.repackagedWarning;
}

/**
 * The warnings for the top of a result, most serious first. Empty on an ordinary publish. Server
 * messages are relayed verbatim, as everywhere else in this server.
 */
export function publishWarnings(r: PublishNotices): string[] {
  const lines: string[] = [];
  if (r.held_for_review === true) {
    lines.push("⚠️ Held for review. Testers can't install this build until the review clears it.");
  }
  if (r.signingReach?.message) {
    lines.push(`⚠️ This build will not install on any device. ${r.signingReach.message}`);
  }
  if (r.repackagedWarning) lines.push(`⚠️ ${r.repackagedWarning}`);
  const android = androidVerification(r.android_registration);
  if (android) lines.push(android);
  if (r.signer_change) {
    lines.push(
      `⚠️ Signed with a different key from ${versionLabel(r.signer_change.previous_version)}. ` +
        'Testers who installed an earlier build will see "App not installed" until they uninstall it first.',
    );
  }
  if (r.channelWarning) lines.push(`⚠️ ${r.channelWarning}`);
  return lines;
}

/** What else the publish did, for after the install link. */
export function publishNotes(r: PublishNotices): string[] {
  const lines: string[] = [];
  // Relayed verbatim, and only when the plan actually shortened something. This is the one plan
  // limit that fires on an ordinary upload, so it is the only moment an assistant can tell a free
  // user what the paid tier buys.
  if (r.retentionClamp?.message) lines.push(`⚠️ ${r.retentionClamp.message}`);
  // With the other link spelled out: an assistant told only "this is a duplicate" would have to
  // guess which of the two URLs to hand back.
  if (r.duplicateOf?.message) {
    lines.push(`ℹ️ ${r.duplicateOf.message}` + (r.duplicateOf.url ? `\nOriginal link: ${r.duplicateOf.url}` : ""));
  }
  // The standing link is the URL worth handing out: it keeps serving the latest build.
  if (r.channel) lines.push(`**Standing link ${r.channel.slug}** now serves this build: ${r.channel.url}`);
  for (const moved of r.standingLinksMoved ?? []) {
    lines.push(
      `**Standing link ${moved.slug}** follows this app, so it now serves this build: ${moved.url}` +
        (moved.previousBuildId ? `\nTo undo, point it back at build ${moved.previousBuildId}.` : ""),
    );
  }
  return lines;
}

/**
 * The two states that change whether testers can install. Nothing for `registered`, for `unchecked`
 * (Google has not answered yet, which is usual at publish time) or for a status this version does
 * not know: a warning we cannot word is worse than none.
 */
function androidVerification(reg: AndroidRegistration | null | undefined): string | null {
  if (!reg) return null;
  const fix = `What to do: ${checkerUrl(reg)}`;
  if (reg.status === "not_registered") {
    const day = formatDay(reg.all_sources_from);
    const when = day
      ? `From ${day}, Android will block installs of unregistered apps, including from links like this one.`
      : "Android will block installs of unregistered apps, including from links like this one, once Google " +
        "extends its check beyond app stores. Google hasn't set that date yet.";
    return `⚠️ This app isn't registered with Google's Android developer verification. ${when}\n${fix}`;
  }
  if (reg.status === "registered_other_key") {
    return (
      "⚠️ This app is registered with Google's Android developer verification under a different signing key. " +
      "Testers won't be able to install this build once Google enforces it. " +
      "Sign with the registered key, or add this key in the Android Developer Console.\n" +
      fix
    );
  }
  return null;
}

/** BetaDrop's checker page, filled in for this build, as the dashboard's notice links it. */
function checkerUrl(reg: AndroidRegistration): string {
  const query = `package=${encodeURIComponent(reg.package)}&sha256=${encodeURIComponent(reg.cert_sha256)}`;
  return `${resolveAppUrl()}/android-verification-checker/?${query}`;
}

/** "2027-03-15" → "15 March 2027"; null for anything else. */
function formatDay(iso: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(iso ?? "");
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls "2027-02-30" over into March; a date that moved was not a real one.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "1.2 (5)" → "v1.2 (5)"; an empty version → "the previous build". */
function versionLabel(version: string | null | undefined): string {
  const trimmed = (version ?? "").trim();
  if (!trimmed) return "the previous build";
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}
