/**
 * Google's Android developer verification, as the API reports it (growth/37, track 1).
 *
 * The API checks each APK's package name and signing certificate against Google's Android
 * Developer ID Status API at upload, and sends what it found on the build. These are the shapes
 * of that contract, kept apart from `types/index.ts` so the dashboard, the tester page and
 * `lib/androidVerification` share one definition. No imports, so the node tests can use it.
 */

/** What Google said about a build's package name and signing key. */
export type AndroidRegistrationStatus =
  | "registered"
  | "not_registered"
  | "registered_other_key"
  /** Not checked yet, or the check was not possible. The UI shows nothing for it. */
  | "unchecked";

/** `android_registration` on a build (dashboard list, build detail, publish response). */
export interface AndroidRegistration {
  status: AndroidRegistrationStatus;
  package: string;
  /** SHA-256 of the signing certificate: 64 uppercase hex digits, no colons. */
  cert_sha256: string;
  checked_at: string | null;
  /**
   * The day Google starts checking installs from every source, links like BetaDrop's included,
   * as "YYYY-MM-DD". Null while Google has not announced it.
   */
  all_sources_from: string | null;
}

/** `signer_change` on a build: set when it is signed with a different key from the build before. */
export interface SignerChange {
  previous_build_id: string;
  previous_version: string;
  previous_cert_sha256: string;
  cert_sha256: string;
}

/**
 * `androidVerification` on the install payload (`GET /api/install/:id`, both the build and the
 * guest branch).
 *
 * The API sends it only when Google has announced a date for browser installs (a server setting)
 * and this build is not registered, so its presence alone means "tell the tester". Whether it
 * shows is never this frontend's decision.
 */
export interface AndroidVerification {
  status: "not_registered" | "registered_other_key";
  /** "YYYY-MM-DD": the day Android starts checking installs like this one. */
  startsOn: string;
  /** Whether that day has come. Before it the install still works; after it, it may be refused. */
  active: boolean;
}
