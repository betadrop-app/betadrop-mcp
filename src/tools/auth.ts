// Auth tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch, apiFetchWithToken, apiBaseUrl } from "../lib/api.js";
import {
  clearConfig,
  getToken,
  isEnvToken,
  readConfig,
  resolveApiUrl,
  saveCredentials,
  withApiUrl,
} from "../lib/config.js";
import { UnauthorizedError } from "../lib/errors.js";
import type { WhoamiResponse } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

/** Where a user revokes a token by hand, as the welcome overview names it. */
const TOKENS_PAGE = "https://betadrop.app → Settings → Developer → API tokens";

const whoami: ToolHandler = async (_args, { remote }) => {
  const res = await apiFetch<WhoamiResponse>("/api/cli/whoami");
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  const { user, token } = res.data;
  // Behind the hosted connector the API is reached over loopback (`http://127.0.0.1:8395`), an
  // address that means nothing to the user and that they cannot change.
  const serverLine = remote ? "" : `API URL: ${await apiBaseUrl()}\n`;

  const tokenLines = token
    ? `Token Name: ${token.name}\n` +
      `Expires: ${token.expires_at ? new Date(token.expires_at).toLocaleDateString() : "Never"}\n` +
      `Last Used: ${token.last_used_at ? new Date(token.last_used_at).toLocaleDateString() : "Never"}`
    : "Authenticated via browser session (no CLI token)";

  return {
    content: [
      {
        type: "text",
        text: `Logged in to BetaDrop as: ${user.email} (${user.role})\n` + serverLine + tokenLines,
      },
    ],
  };
};

/** A user-supplied API base URL, without its trailing slash; throws unless it is http(s). */
function parseApiUrl(raw: string): string {
  const trimmed = raw.trim();
  let protocol = "";
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    // reported below
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`apiUrl must be a full URL, like https://api.betadrop.app (got "${trimmed}").`);
  }
  return trimmed.replace(/\/+$/, "");
}

const login: ToolHandler = async (args) => {
  const { token, apiUrl } = args as { token: string; apiUrl?: string };
  const requested = apiUrl?.trim() ? parseApiUrl(apiUrl) : undefined;

  // Check the token against the server every later call will use: the one being saved, unless
  // BETADROP_API_URL overrides it. Without the override the check went to the server the old
  // config pointed at, so a token for the new server was refused, and one for the old server was
  // saved as if it worked on the new one.
  const target = resolveApiUrl(requested ?? (await readConfig())?.apiUrl);
  const res = await withApiUrl(target, () =>
    apiFetchWithToken<WhoamiResponse>("/api/cli/whoami", token),
  ).catch((err: unknown) => {
    if (err instanceof UnauthorizedError) throw new Error(`${target} did not accept that token.`);
    throw err;
  });
  if (!res.data) throw new Error("Invalid API token.");

  await saveCredentials({
    token,
    apiUrl: requested ?? target,
    user: {
      id: res.data.user.id,
      email: res.data.user.email,
      role: res.data.user.role,
    },
  });

  const overridden = requested !== undefined && requested !== target;
  return {
    content: [
      {
        type: "text",
        text:
          `Successfully logged in as ${res.data.user.email} (${res.data.user.role})` +
          (requested ? ` on ${target}` : "") +
          ". Credentials saved." +
          (overridden ? `\nBETADROP_API_URL is set, so this server keeps calling ${target} until it is unset.` : ""),
      },
    ],
  };
};

const logout: ToolHandler = async () => {
  // Revoke the token on the server first, then clear the local credentials either way, and say
  // which of those actually happened: a failed revoke leaves a token that still works.
  const fromEnv = isEnvToken();
  let revoke: "revoked" | "already_invalid" | "failed" | "none" = "none";
  let failure = "";
  if (await getToken()) {
    try {
      await apiFetch("/api/cli/logout", { method: "POST" });
      revoke = "revoked";
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        revoke = "already_invalid";
      } else {
        revoke = "failed";
        failure = (err instanceof Error ? err.message : String(err)).trim();
        if (!/[.!?]$/.test(failure)) failure += ".";
      }
    }
  }
  await clearConfig();

  let text: string;
  if (revoke === "none") {
    text = "You were not logged in, so there was nothing to revoke.";
  } else if (revoke === "failed") {
    text =
      `Could not revoke the token on BetaDrop. ${failure} ` +
      `If it still works, revoke it at ${TOKENS_PAGE}.`;
  } else {
    text = `Logged out. ${revoke === "revoked" ? "BetaDrop revoked the token." : "The token had already expired or been revoked."}`;
  }
  if (fromEnv) {
    text += " The token came from BETADROP_TOKEN, which is still set in this server's environment. Remove it there too.";
  } else if (revoke !== "none") {
    text += " Local credentials are cleared.";
  }
  return { content: [{ type: "text", text }] };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_whoami",
      description:
        "Check authentication status and show the active account and its token details.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_login",
      description:
        "Configure API authentication with a BetaDrop token. Validates the token against the server and saves credentials to the shared CLI config.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "BetaDrop API token (e.g. bd_live_...)",
          },
          apiUrl: {
            type: "string",
            description: "Optional BetaDrop API base URL override.",
          },
        },
        required: ["token"],
      },
    },
    {
      name: "betadrop_logout",
      description:
        "Revoke the active token on the server and clear local credentials.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  handlers: {
    betadrop_whoami: whoami,
    betadrop_login: login,
    betadrop_logout: logout,
  },
};
