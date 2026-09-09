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

/** Resolve the API base URL: env override > stored config > default. */
export function resolveApiUrl(stored?: string): string {
  return (
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

/** Read the stored config, or null if none exists. Results are cached in memory. */
export async function readConfig(): Promise<Config | null> {
  if (_cache !== undefined) return _cache;
  try {
    const raw = await fs.readFile(configFilePath(), "utf8");
    _cache = JSON.parse(raw) as Config;
  } catch {
    _cache = null;
  }
  return _cache;
}

/**
 * Resolve the active token: BETADROP_TOKEN env wins (CI), else the stored file.
 */
export async function getToken(): Promise<string | null> {
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

/** Delete the stored config (used by logout). */
export async function clearConfig(): Promise<void> {
  _cache = null;
  try {
    await fs.unlink(configFilePath());
  } catch {
    // already gone — fine
  }
}
