/**
 * Google's Android developer verification: every date, number and link BetaDrop states about it,
 * in one place.
 *
 * Read from Google's page and blog on 22 Nov 2026. When Google moves a date or changes a number,
 * edit it here: the checker page and its FAQ, the build badge and the tester notice all read
 * these, so nothing else needs editing to stay true.
 *
 * The date Android starts checking installs from links (BetaDrop's included) is NOT here. Google
 * has not announced it, and when it does the API carries it (`all_sources_from`, `startsOn`) from
 * a server setting, so the pages follow without a rebuild. Until then the copy says
 * `ALL_SOURCES_FALLBACK` and `ALL_SOURCES_UNDATED`.
 *
 * No imports and no `@/` alias: the node tests load this directly.
 */

/** Google's own page. Every surface links here for the details. */
export const GOOGLE_VERIFICATION_URL = "https://developer.android.com/developer-verification";

/** When the facts below were last checked against Google's page. */
export const FACTS_CHECKED_ON = "2026-11-22";

/** The first phase: store installs only, in four countries. Link installs are not checked. */
export const FIRST_PHASE_STARTED = "2026-09-30";
export const FIRST_PHASE_COUNTRIES = ["Brazil", "Indonesia", "Singapore", "Thailand"] as const;

/** The global rollout starts with these stores. */
export const STORE_ROLLOUT = "January 2027";
export const ROLLOUT_STORES = [
  "Google Play",
  "Samsung Galaxy Store",
  "HONOR",
  "OPPO",
  "Xiaomi",
  "Transsion",
  "vivo",
] as const;

/**
 * What the copy says while Google has not dated the step that reaches browser installs. Google
 * says only that it follows the store rollout and reaches every source "over several months", so
 * this names no month or year of its own: just what it comes after, and that it has no date.
 */
export const ALL_SOURCES_FALLBACK = `Once Google extends its check beyond app stores, after the ${STORE_ROLLOUT} store rollout`;
export const ALL_SOURCES_UNDATED = "Google hasn't set that date yet.";

/** The two ways to register. */
export const FREE_ACCOUNT_DEVICES = 50;
export const FULL_ACCOUNT_FEE = "$25";

/** The one-time wait in Android's "advanced flow" for installing an unregistered app. */
export const ADVANCED_FLOW_WAIT = "24 hours";

/** The checker page, where every developer-facing notice sends people. */
export const CHECKER_PATH = "/android-verification-checker/";
