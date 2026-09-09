/** Shape of the locally-stored credentials file. */
export interface Config {
  apiUrl: string;
  token: string;
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

export interface PublishResponse {
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
  /** Null/absent on an ordinary upload — presence means there is something to tell the user. */
  retentionClamp?: RetentionClamp | null;
  /** Same contract: set only when this account already has a live build with these exact bytes. */
  duplicateOf?: DuplicateOf | null;
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
  meta: {
    name: string;
    version: string;
    package: string;
  };
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
