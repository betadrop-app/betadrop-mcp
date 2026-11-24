/**
 * Which Android verification notice to show, and what it says.
 *
 * The components render; this decides and words. Keeping the decisions and the sentences here,
 * as plain functions, is what lets the tests check every state without a DOM, and keeps the
 * wording of the build badge, the tester notice and the checker page in one file.
 *
 * Relative imports only (type imports are erased), so the node tests load this directly.
 */

import type {
  AndroidRegistration,
  AndroidVerification,
  SignerChange,
} from "../../types/androidRegistration";
import { ALL_SOURCES_FALLBACK, ALL_SOURCES_UNDATED, GOOGLE_VERIFICATION_URL } from "./facts";
import { formatIsoDate, versionLabel } from "./format";

export type BadgeState = "registered" | "not_registered" | "registered_other_key";

/** The fields of a build the notices read. Structural, so a publish response fits as well. */
export interface AndroidBuildLike {
  platform?: string | null;
  is_deleted?: boolean;
  is_expired?: boolean;
  history_status?: "active" | "expired" | "deleted";
  android_registration?: AndroidRegistration | null;
  signer_change?: SignerChange | null;
}

/** A build whose link no longer installs anything: no notice about installing it is useful. */
function isRetired(build: AndroidBuildLike): boolean {
  return (
    build.is_deleted === true ||
    build.is_expired === true ||
    build.history_status === "expired" ||
    build.history_status === "deleted"
  );
}

/**
 * The badge to show on a build, or null for none.
 *
 * Nothing for iOS, for a retired build, for `unchecked`, for a missing field (an older API) and
 * for any status this version does not know: a badge we cannot word is worse than no badge.
 */
export function badgeState(build: AndroidBuildLike): BadgeState | null {
  if (build.platform && build.platform !== "android") return null;
  if (isRetired(build)) return null;
  const status = build.android_registration?.status;
  return status === "registered" || status === "not_registered" || status === "registered_other_key"
    ? status
    : null;
}

/** The signer change to warn about on a build, or null. Same exclusions as the badge. */
export function signerChangeToShow(build: AndroidBuildLike): SignerChange | null {
  if (build.platform && build.platform !== "android") return null;
  if (isRetired(build)) return null;
  return build.signer_change ?? null;
}

/**
 * "From 15 March 2027, Android will block installs of unregistered apps, including from links
 * like this one." While Google has not dated that step it says what the step follows instead,
 * and that there is no date yet, rather than guessing one.
 */
export function blockingSentence(allSourcesFrom: string | null | undefined): string {
  const date = formatIsoDate(allSourcesFrom);
  const what = "Android will block installs of unregistered apps, including from links like this one.";
  return date ? `From ${date}, ${what}` : `${ALL_SOURCES_FALLBACK}, ${what} ${ALL_SOURCES_UNDATED}`;
}

/**
 * The checker page's version of the same sentence, which has no link of its own to point at.
 */
export function checkerBlockingSentence(allSourcesFrom: string | null | undefined): string {
  const date = formatIsoDate(allSourcesFrom);
  const what =
    "Android will block installs of apps that aren't registered, including APKs installed from a link.";
  return date ? `From ${date}, ${what}` : `${ALL_SOURCES_FALLBACK}, ${what} ${ALL_SOURCES_UNDATED}`;
}

/** The developer-facing badge copy for each state: a headline and the sentences after it. */
export function badgeCopy(
  state: BadgeState,
  allSourcesFrom: string | null | undefined,
): { headline: string; body: string } {
  switch (state) {
    case "registered":
      return { headline: "Registered with Google", body: "" };
    case "not_registered":
      return { headline: "Not registered with Google.", body: blockingSentence(allSourcesFrom) };
    case "registered_other_key":
      return {
        headline: "Registered with Google under a different signing key.",
        body: "Testers won't be able to install this build once Google enforces it. Sign with the registered key, or add this key in the Android Developer Console.",
      };
  }
}

/** The signer-change warning, in one sentence pair. */
export function signerChangeCopy(change: SignerChange): { headline: string; body: string } {
  return {
    headline: `Signed with a different key from ${versionLabel(change.previous_version)}.`,
    body: "Testers who installed an earlier build will see “App not installed” until they uninstall it first.",
  };
}

/**
 * The tester notice to show, or null.
 *
 * Only the two statuses this version can word. The check matters during a deploy: the API before
 * this contract sent `{country, startsOn, active}` with no `status` for every Android build in
 * Brazil, Indonesia, Singapore and Thailand, and reading that as "not registered" would tell those
 * testers, falsely, that their phone may refuse the app.
 */
export function testerNoticeToShow(
  verification: AndroidVerification | null | undefined,
): AndroidVerification | null {
  if (!verification) return null;
  const { status, startsOn, active } = verification as Partial<AndroidVerification>;
  if (status !== "not_registered" && status !== "registered_other_key") return null;
  if (typeof startsOn !== "string" || typeof active !== "boolean") return null;
  return verification;
}

/**
 * The tester's notice, in the tester's voice. They cannot register anything, so it says what is
 * happening, that the link is fine, and who can fix it.
 */
export function testerNoticeCopy(verification: AndroidVerification): string {
  const reason =
    verification.status === "registered_other_key"
      ? "it isn't signed with the key its developer registered with Google"
      : "its developer hasn't registered it with Google";
  if (verification.active) {
    return `Android may refuse to install this app because ${reason}. This link isn't broken.`;
  }
  const date = formatIsoDate(verification.startsOn);
  return date
    ? `Heads up: from ${date}, Android may block installing this app, because ${reason}. Let them know.`
    : `Heads up: Android may soon block installing this app, because ${reason}. Let them know.`;
}

/** What "Tell the developer" shares: what happened, and the page that says how to fix it. */
export function developerMessage(verification: AndroidVerification, appName?: string | null): string {
  const app = appName?.trim() ? appName.trim() : "the app";
  const problem =
    verification.status === "registered_other_key"
      ? `this build isn't signed with the key registered with Google. Sign it with the registered key, or add this key to the app's registration`
      : `the app isn't registered with Google. Registering its package name and signing key fixes it`;
  return `Android may block installing ${app} from its install link: ${problem}. ${GOOGLE_VERIFICATION_URL}`;
}

// ── The public checker endpoint ──────────────────────────────────────────────────────────

export type CheckOutcome =
  | {
      kind: "result";
      status: BadgeState;
      checkedAt: string | null;
      allSourcesFrom: string | null;
    }
  | { kind: "invalid_package" }
  | { kind: "invalid_cert" }
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | { kind: "not_available" }
  | { kind: "error" };

const RESULT_STATUSES = new Set(["registered", "not_registered", "registered_other_key"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads a response from `POST /api/tools/android-registration`.
 *
 * Branches on the HTTP status first and reads the body only for detail, so an unexpected body
 * still lands on the right message. The body is read with or without the API's usual
 * `{success, data}` envelope, and an error code is taken from `error` or `reason`, so the screen
 * does not depend on which of the two the handler uses.
 */
export function parseCheckResponse(httpStatus: number, body: unknown): CheckOutcome {
  const record = asRecord(body);
  if (httpStatus >= 200 && httpStatus < 300) {
    const data = asRecord(record?.data) ?? record;
    const status = data?.status;
    if (typeof status !== "string" || !RESULT_STATUSES.has(status)) return { kind: "error" };
    return {
      kind: "result",
      status: status as BadgeState,
      checkedAt: typeof data?.checked_at === "string" ? data.checked_at : null,
      allSourcesFrom: typeof data?.all_sources_from === "string" ? data.all_sources_from : null,
    };
  }
  if (httpStatus === 400 || httpStatus === 422) {
    const codes = [record?.error, record?.reason];
    if (codes.includes("invalid_package")) return { kind: "invalid_package" };
    if (codes.includes("invalid_cert")) return { kind: "invalid_cert" };
    return { kind: "invalid" };
  }
  if (httpStatus === 429) return { kind: "rate_limited" };
  if (httpStatus === 503) return { kind: "not_available" };
  return { kind: "error" };
}
