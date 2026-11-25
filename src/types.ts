/**
 * Shape of the locally-stored credentials file, which the CLI (`betadrop-cli`) shares.
 *
 * This server owns `token` and `user`. Every other key in the file is kept as it is on login and
 * logout, whether or not it is listed here (see `saveCredentials` and `clearConfig`).
 */
export interface Config {
  apiUrl: string;
  /** Absent after a logout that kept the file for a key this server does not own. */
  token?: string;
  /**
   * The CLI's guest device id: it counts this machine's guest uploads. Not a credential, and not
   * ours, so it survives login and logout here as it does in the CLI.
   */
  guestDeviceId?: string;
  user?: {
    id: string;
    email: string;
    role?: string;
  };
}

/** Standard Laravel API envelope. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface WhoamiResponse {
  user: { id: string; email: string; role: string };
  /** null when authenticated via browser cookie session rather than a CLI token */
  token: { id: string; name: string; last_used_at: string | null; expires_at: string | null } | null;
}

/**
 * Present only when the account's plan shortened the retention that was asked for.
 *
 * `message` is composed server-side (`RetentionClamp::message`) so the web form, the CLI and this
 * server cannot describe the same limit three different ways — relay it rather than rewording it.
 */
export interface RetentionClamp {
  requestedDays: number;
  appliedDays: number;
  maxDays: number;
  permanentDenied: boolean;
  message: string;
}

/** Why an iOS build cannot install on any device, when the file itself says so. */
export interface SigningReach {
  /** `no_provisioned_devices` or `no_provisioning_profile`. */
  code: string;
  /** Composed server-side (`SigningReach::message`); relay it verbatim. */
  message: string;
}

/**
 * `android_registration` on an Android build: what Google's Android developer verification said
 * about its package name and signing key. Null for iOS, and while it does not apply.
 */
export interface AndroidRegistration {
  /** `unchecked` until Google has answered; publish asks in the background, so it often is. */
  status: "registered" | "not_registered" | "registered_other_key" | "unchecked";
  package: string;
  /** SHA-256 of the signing certificate: 64 uppercase hex digits. */
  cert_sha256: string;
  checked_at: string | null;
  /** "YYYY-MM-DD": the day Android starts checking installs from links. Null while Google has not set it. */
  all_sources_from: string | null;
}

/** `signer_change` on an Android build: signed with a different key from the app's previous build. */
export interface SignerChange {
  previous_build_id: string;
  previous_version: string;
  previous_cert_sha256: string;
  cert_sha256: string;
}

/** A standing link that follows this app and moved to the new build on its own. */
export interface MovedStandingLink {
  id: string;
  slug: string;
  label: string | null;
  url: string;
  /** The build it served before, set only while that build can still be installed. */
  previousBuildId: string | null;
}

/**
 * What a publish response says beyond the build itself. `POST /api/cli/publish` returns these, and
 * a finished remote upload's `build` is the same stored response with `held_for_review` re-read.
 *
 * Every field is optional: older API servers, and results stored before a field existed, lack some.
 * Null or absent means there is nothing to tell the user.
 */
export interface PublishNotices {
  /** True when a review holds the build: the link refuses testers until it is cleared. */
  held_for_review?: boolean;
  signingReach?: SigningReach | null;
  /** The build looks like a re-signed copy of someone else's app. Composed server-side. */
  repackagedWarning?: string | null;
  android_registration?: AndroidRegistration | null;
  signer_change?: SignerChange | null;
  /** Null/absent on an ordinary upload — presence means there is something to tell the user. */
  retentionClamp?: RetentionClamp | null;
  /** Same contract: set only when this account already has a live build with these exact bytes. */
  duplicateOf?: DuplicateOf | null;
  /** Set when a standing link was requested and now serves this build. */
  channel?: { id: string; slug: string; label: string | null; url: string } | null;
  /** Set when a standing link was requested, the build was stored, and the link did NOT move. */
  channelWarning?: string | null;
  /** Standing links that follow this app and now serve this build. Empty on an ordinary upload. */
  standingLinksMoved?: MovedStandingLink[] | null;
}

export interface PublishResponse extends PublishNotices {
  id: string;
  platform: string;
  fileSize: number;
  shortId: string;
  url: string;
  meta: {
    name: string;
    version: string;
    package: string;
    icon: string | null;
    dominantColor: string | null;
  };
}

/**
 * A build the account already had, byte-identical to the one just published.
 *
 * Worth relaying to an assistant rather than dropping: an agent publishing on someone's behalf has
 * no memory of the earlier upload and no way to notice it produced a second link to the same file.
 * `message` is rendered server-side so this server does not invent its own wording for it.
 */
export interface DuplicateOf {
  id: string;
  shortId: string;
  url: string;
  name: string;
  version: string | null;
  buildNumber: string | null;
  label: string;
  message: string;
  createdAt: string | null;
  downloadCount: number;
}

export interface BuildListItem {
  id: string;
  platform: string;
  fileSize: number;
  shortId: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  installUrl: string | null;
  /** Install counters. Absent from API servers older than the field. */
  downloads?: number;
  uniqueDevices?: number;
  /** The file behind an expired entry is gone (purged). */
  payloadPurged?: boolean;
  /** A retired build whose file is still kept: `POST /api/builds/{id}/restore` brings it back.
   *  Absent from API servers older than the field. */
  restorable?: boolean;
  meta: {
    name: string;
    version: string;
    package: string;
  };
}

/** `GET /api/builds/{id}/analytics` → `data.summary`. `recent_installs` is ignored on purpose: it
 *  carries testers' IP addresses, which an assistant has no reason to repeat. */
export interface BuildAnalyticsSummary {
  total_downloads: number;
  unique_devices: number;
  failed_attempts: number;
  failure_reasons: Array<{ reason: string; count: number }>;
  device_breakdown: { mobile: number; tablet: number; desktop: number };
  platform_breakdown: { ios: number; android: number; other: number };
  top_devices: Array<{ model: string; count: number }>;
  geographic_distribution: Array<{ country: string; count: number }>;
}

/** `GET /api/builds/{id}/analytics/timeseries?days=N`. */
export interface BuildTimeseries {
  days: number;
  from: string;
  to: string;
  totals: { total: number; success: number; failure: number };
  series: Array<{ date: string; total: number; success: number; failure: number; unique_devices: number }>;
}

export interface BuildListResponse {
  builds: BuildListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface TokenListItem {
  id: string;
  name: string;
  abilities: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface TokenListResponse {
  tokens: TokenListItem[];
}

export interface TokenCreateResponse {
  id: string;
  name: string;
  token: string;
  abilities: string[];
  expires_at: string | null;
}

export interface InspectReport {
  fileName: string;
  platform: "ios" | "android";
  installableFromLink: boolean;
  checks: Array<{ id: string; level: "error" | "warning" | "ok"; message: string }>;
  /** Store readiness and security findings (gap 4). Absent on older servers. */
  findings?: Array<{ id: string; category: string; level: "error" | "warning" | "info"; masvs: string | null; message: string }>;
  app: { name: string | null; bundleId: string | null; version: string | null; buildNumber: string | null };
  ios: {
    profile: {
      kind: string;
      teamName: string | null;
      teamId: string | null;
      expiresAt: string | null;
      provisionedDeviceCount: number;
      provisionsAllDevices: boolean;
    } | null;
  } | null;
  android: { versionCode: number | null; targetSdk: number | null; debuggable: boolean } | null;
}

export interface StandingLink {
  id: string;
  slug: string;
  label: string | null;
  url: string;
  followerCount?: number;
  currentBuild: { id: string; name: string | null; version: string | null; createdAt: string | null } | null;
}

export interface Webhook {
  id: string;
  url: string;
  format: string;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  lastSuccessAt: string | null;
  /** Only these apps (bundle ids); `null` = every app. */
  bundleIds?: string[] | null;
}

/** `GET /api/cli/stats` — account-wide totals for the welcome overview. */
export interface CliStats {
  builds: { total: number; live: number; expired: number; ios: number; android: number };
  installs: number;
  uniqueDevices: number;
  expiringSoon: number;
  mostInstalled: { id: string; name: string; version: string | null; downloads: number } | null;
}

/** `POST /api/cli/upload-links`. */
export interface UploadLink {
  id: string;
  url: string;
  expiresAt: string;
  expiresInMinutes: number;
}

/** `GET /api/cli/remote-uploads/{id}` — an upload link or a publish-from-URL, and its outcome. */
export interface RemoteUpload {
  id: string;
  kind: "link" | "url";
  status: "pending" | "uploading" | "done" | "failed";
  error: string | null;
  expiresAt: string;
  /**
   * The published build, as `POST /api/cli/publish` returned it; set once `status` is `done`.
   * Stored when the publish finished, so only `held_for_review` is current: the API re-reads it on
   * every check. `android_registration` stays as it was at publish time.
   */
  build: (PublishNotices & {
    id: string;
    shortId: string;
    url: string;
    platform: string;
    meta?: { name?: string; version?: string; package?: string };
  }) | null;
}
