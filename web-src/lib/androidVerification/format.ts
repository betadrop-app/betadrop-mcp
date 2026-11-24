/**
 * Formatting and input normalisation for the Android verification surfaces: dates, certificate
 * fingerprints and package names. Pure functions with no imports, so the node tests load them
 * directly.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * "2027-03-15" → "15 March 2027", or null for anything that is not a real calendar date.
 *
 * Parsed by hand, never through `new Date("2027-03-15")`: that reads a bare date as UTC midnight
 * and renders the day BEFORE in any timezone west of UTC, Brazil among them, which is one of the
 * countries Google started with. The tester notice this replaced (44afd287) did the same, for the
 * same reason. A timestamp ("2027-03-15T10:00:00Z") is read by its date part, as the server wrote
 * it.
 */
export function formatIsoDate(iso: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(iso ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * A SHA-256 certificate fingerprint as people paste it, normalised to 64 uppercase hex digits
 * with no separators, or null when it is not one.
 *
 * Accepts the forms the tools print: keytool's `SHA256: AB:CD:…`, apksigner's
 * `Signer #1 certificate SHA-256 digest: abcd…`, Play Console's colon form, and bare hex in any
 * case, with spaces or colons between bytes.
 */
export function normalizeCertSha256(input: string | null | undefined): string | null {
  const hex = stripFingerprint(input);
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

/** Drops a leading "SHA256:"-style label, then every colon and space, and uppercases. */
function stripFingerprint(input: string | null | undefined): string {
  return (input ?? "")
    .trim()
    .replace(/^[^:]*sha-?256[^:]*:\s*/i, "")
    .replace(/[\s:]/g, "")
    .toUpperCase();
}

/**
 * Why a fingerprint field is not a SHA-256, so the message can say what to fix. `sha1` gets its
 * own answer because it is the common mistake: Firebase and Google Sign-In ask for the SHA-1, so
 * it is the one people have to hand.
 */
export function certInputProblem(input: string | null | undefined): "empty" | "sha1" | "invalid" | null {
  const hex = stripFingerprint(input);
  if (!hex) return "empty";
  if (/^[0-9A-F]{64}$/.test(hex)) return null;
  if (/^[0-9A-F]{40}$/.test(hex)) return "sha1";
  return "invalid";
}

/** 64 hex digits → "AB:CD:…", the form keytool and the Google consoles show. */
export function colonHex(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
}

/**
 * Whether a string is a valid Android package name: two or more dot-separated parts, each
 * starting with a letter and holding only letters, digits and underscores.
 */
export function isValidPackageName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed.length <= 255 && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(trimmed);
}

/**
 * A version as the notices print it: "1.4.0" → "v1.4.0", "v2" stays "v2", and an empty one
 * reads as "the previous build" so the sentence still makes sense.
 */
export function versionLabel(version: string | null | undefined): string {
  const trimmed = (version ?? "").trim();
  if (!trimmed) return "the previous build";
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}
