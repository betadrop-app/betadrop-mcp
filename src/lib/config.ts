import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../types.js";

/** Default production API host. Override with BETADROP_API_URL. */
const DEFAULT_API_URL = "https://api.betadrop.app";

/** Default frontend host for building install links. Override with BETADROP_APP_URL. */
export const DEFAULT_APP_URL = "https://betadrop.app";

/**
 * Resolve the credentials file path, honoring XDG on Linux/macOS and falling
 * back to ~/.betadrop on all platforms (works on Windows too).
 */
function configFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "betadrop", "config.json");
  }
  return path.join(os.homedir(), ".betadrop", "config.json");
}

/**
 * An API base URL that wins over every other source, for the calls made inside
 * {@link withApiUrl}. Login uses it to check a token against the server it is about to save,
 * which the stored config does not point at yet.
 */
const apiUrlOverride = new AsyncLocalStorage<string>();

/** Run `fn` with every API call it makes going to `url`. */
export function withApiUrl<T>(url: string, fn: () => T): T {
  return apiUrlOverride.run(url.replace(/\/$/, ""), fn);
}

/** Resolve the API base URL: {@link withApiUrl} > env override > stored config > default. */
export function resolveApiUrl(stored?: string): string {
  return (
    apiUrlOverride.getStore() ||
    process.env.BETADROP_API_URL?.replace(/\/$/, "") ||
    stored?.replace(/\/$/, "") ||
    DEFAULT_API_URL
  );
}

/** Resolve the frontend app URL for install links. */
export function resolveAppUrl(): string {
  return (process.env.BETADROP_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
}

/**
 * Whether the active token comes from the BETADROP_TOKEN env var (CI mode).
 * In that case we never read or write the local config file.
 */
export function isEnvToken(): boolean {
  return !!process.env.BETADROP_TOKEN;
}

// undefined = not yet loaded; null = loaded but absent
let _cache: Config | null | undefined = undefined;

/** The config file as it is on disk now, or null if there is none. */
async function readConfigFile(): Promise<Config | null> {
  try {
    const raw = await fs.readFile(configFilePath(), "utf8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

/** Read the stored config, or null if none exists. Results are cached in memory. */
export async function readConfig(): Promise<Config | null> {
  if (_cache !== undefined) return _cache;
  _cache = await readConfigFile();
  return _cache;
}

/**
 * The bearer token of the HTTP request being served, in remote mode. One process serves many
 * users there, so the token has to travel with the request rather than live in env or a file.
 */
const requestToken = new AsyncLocalStorage<string>();

/** Run `fn` with `token` as the active token for every API call it makes. */
export function withRequestToken<T>(token: string, fn: () => T): T {
  return requestToken.run(token, fn);
}

/**
 * The client address of the HTTP request being served, in remote mode: what the API rate limits,
 * blocklists and records it under. Never set over stdio, where the API sees the user's own
 * connection and needs no telling.
 */
const requestClientAddress = new AsyncLocalStorage<string | undefined>();

/** Run `fn` with `address` as the client address every API call it makes reports. */
export function withClientAddress<T>(address: string | undefined, fn: () => T): T {
  return requestClientAddress.run(address, fn);
}

export function getClientAddress(): string | undefined {
  return requestClientAddress.getStore();
}

/**
 * Resolve the active token: the HTTP request's (remote mode), else BETADROP_TOKEN env (CI), else
 * the stored file.
 */
export async function getToken(): Promise<string | null> {
  const fromRequest = requestToken.getStore();
  if (fromRequest) {
    return fromRequest;
  }
  if (process.env.BETADROP_TOKEN) {
    return process.env.BETADROP_TOKEN;
  }
  const config = await readConfig();
  return config?.token ?? null;
}

/** Persist the config with owner-only permissions. */
export async function writeConfig(config: Config): Promise<void> {
  _cache = config;
  const file = configFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  // chmod is a soft no-op on Windows but harmless; enforces 600 on POSIX.
  await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * Store a login, keeping every other key in the file.
 *
 * The file is the CLI's too, and the CLI keeps its guest device id there; writing only our own
 * keys reset that machine's guest allowance. It is read from disk here rather than from the cache,
 * because this process can run for days while the CLI writes to the file.
 */
export async function saveCredentials(credentials: Pick<Config, "apiUrl" | "token" | "user">): Promise<void> {
  const current = await readConfigFile();
  await writeConfig({ ...(current ?? {}), ...credentials });
}

/**
 * Remove the stored credentials (used by logout): `token` and `user`, the keys this server owns.
 * The file stays while it holds a key another tool owns, such as the CLI's guest device id, and is
 * deleted when nothing but `apiUrl` would be left.
 */
export async function clearConfig(): Promise<void> {
  const current = await readConfigFile();
  const { token: _token, user: _user, ...kept } = current ?? ({} as Partial<Config>);
  if (current && Object.keys(kept).some((key) => key !== "apiUrl")) {
    await writeConfig(kept as Config);
    return;
  }
  _cache = null;
  try {
    await fs.unlink(configFilePath());
  } catch {
    // already gone — fine
  }
}
