// Token management tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { TokenListResponse, TokenCreateResponse } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

const tokenList: ToolHandler = async () => {
  const res = await apiFetch<TokenListResponse>("/api/cli/tokens");
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  const { tokens } = res.data;
  if (tokens.length === 0) {
    return { content: [{ type: "text", text: "No active tokens found." }] };
  }

  const lines = tokens.map((t) => {
    const expires = t.expires_at
      ? new Date(t.expires_at).toLocaleDateString()
      : "Never";
    const lastUsed = t.last_used_at
      ? new Date(t.last_used_at).toLocaleDateString()
      : "Never";
    const abilities = t.abilities.join(", ");
    return (
      `• ${t.name} [${t.id}]\n` +
      `  Abilities: ${abilities} | Expires: ${expires} | Last used: ${lastUsed}`
    );
  });

  return {
    content: [
      {
        type: "text",
        text: `${tokens.length} active token(s):\n\n${lines.join("\n\n")}`,
      },
    ],
  };
};

const tokenCreate: ToolHandler = async (args) => {
  const { name: tokenName, abilities, expiresInDays } = args as {
    name: string;
    abilities?: string[];
    expiresInDays?: number;
  };

  const res = await apiFetch<TokenCreateResponse>("/api/cli/tokens", {
    method: "POST",
    body: {
      name: tokenName,
      abilities: abilities ?? ["*"],
      expires_in_days: expiresInDays ?? null,
    },
  });
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  const t = res.data;
  const expires = t.expires_at
    ? new Date(t.expires_at).toLocaleDateString()
    : "Never";

  return {
    content: [
      {
        type: "text",
        text:
          `Token created! Copy it now — it will not be shown again.\n\n` +
          `Name: ${t.name}\n` +
          `ID: ${t.id}\n` +
          `Abilities: ${t.abilities.join(", ")}\n` +
          `Expires: ${expires}\n\n` +
          `Token: ${t.token}`,
      },
    ],
  };
};

const tokenDelete: ToolHandler = async (args) => {
  const { tokenId } = args as { tokenId: string };

  await apiFetch(`/api/cli/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });

  return {
    content: [
      {
        type: "text",
        text: `Token ${tokenId} has been revoked.`,
      },
    ],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_token_list",
      description: "List all active CLI tokens for the current account.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_token_create",
      description:
        "Create an API token for CI jobs, scripts and other API clients, in the same workspace (personal or team) as the token making the call, which needs the publish ability. An account can hold 20 unrevoked tokens per workspace. The reply gives the new token's ID, abilities, expiry date and plaintext value, which is not stored and can't be shown again.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Human-readable label for the token (max 100 chars).",
          },
          abilities: {
            type: "array",
            items: { type: "string", enum: ["publish", "read", "*"] },
            description: "Permissions granted to the token. Defaults to ['*'] (all).",
          },
          expiresInDays: {
            type: "number",
            description: "Token lifetime in days (1–365). Omit for no expiry.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "betadrop_token_delete",
      description:
        "Revoke an API token. It stops working at once and can't be restored: every CI job, script, CLI or MCP server signed in with it is refused the next time it calls the BetaDrop API. A revoked connector token, named like \"Claude (connector)\", can't be refreshed either, so that connector has to sign in again.",
      inputSchema: {
        type: "object",
        properties: {
          tokenId: {
            type: "string",
            description: "ID of the token to revoke (from betadrop_token_list).",
          },
        },
        required: ["tokenId"],
      },
    },
  ],
  handlers: {
    betadrop_token_list: tokenList,
    betadrop_token_create: tokenCreate,
    betadrop_token_delete: tokenDelete,
  },
};
