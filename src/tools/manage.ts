// Build and link management tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import { resolveAppUrl } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import type { ToolHandler, ToolModule } from "./types.js";

/** One row of `GET /api/builds/{id}/share-links` (`share_links_index` in builds.rs). */
interface ShareLink {
  id: string;
  link_type: string;
  short_id: string;
  label: string | null;
}

/** The fields this module reads from `GET /api/builds/{id}` (`show` in build_crud.rs). */
interface BuildDetail {
  build: { name?: string | null; version?: string | null; default_short_id?: string | null };
}

const installUrl = (code: string) => `${resolveAppUrl()}/install/?i=${encodeURIComponent(code)}`;

/** "ShopEase 2.4.0", or the bare ID when the build could not be read. */
function buildLabel(detail: BuildDetail["build"] | undefined, buildId: string): string {
  const name = [detail?.name, detail?.version].filter(Boolean).join(" ");
  return name ? `**${name}** (build ${buildId})` : `build ${buildId}`;
}

/** The build's own record, or undefined: it only adds a name and a link to a reply, so a miss is not an error. */
async function readBuild(buildId: string): Promise<BuildDetail["build"] | undefined> {
  try {
    return (await apiFetch<BuildDetail>(`/api/builds/${encodeURIComponent(buildId)}`)).data?.build;
  } catch {
    return undefined;
  }
}

const restoreBuild: ToolHandler = async (args) => {
  const { buildId } = (args ?? {}) as { buildId?: string };
  if (!buildId) throw new Error("A buildId is required.");

  // `POST /api/builds/{id}/restore` (`restore` in build_crud.rs). Its refusals already say what
  // happened — 402 over the plan's storage, 410 file already removed, 403 a teammate's build or a
  // read-only token — so they reach the reply as they are.
  const res = await apiFetch<{ id: string; restored: boolean; expiresAt?: string }>(
    `/api/builds/${encodeURIComponent(buildId)}/restore`,
    { method: "POST" },
  );
  if (!res.data) throw new Error("Unexpected response from BetaDrop.");

  // The API answers a build that is not retired with `restored: false` and changes nothing: a live
  // build, one past its date that the hourly cleanup has not retired yet, or one that reached its
  // download or device limit.
  if (!res.data.restored) {
    return {
      content: [
        {
          type: "text",
          text:
            `Nothing changed: build ${buildId} has not been retired, so there is nothing to restore and it ` +
            "stays as it was. Restoring applies to a build BetaDrop retired after it expired, while its file is still kept.",
        },
      ],
    };
  }

  const detail = await readBuild(buildId);
  const code = detail?.default_short_id;
  const expires = res.data.expiresAt ? new Date(res.data.expiresAt).toISOString().slice(0, 10) : undefined;
  return {
    content: [
      {
        type: "text",
        text:
          `Restored ${buildLabel(detail, buildId)}.` +
          (code ? `\n\n**Install link:** ${installUrl(code)} (works again)` : "\n\nIts install link works again.") +
          (expires
            ? `\n\nIt now expires on ${expires}: a fresh term from the account's current plan, not the one it had before.`
            : "") +
          "\nIts file counts toward the account's storage again.",
      },
    ],
  };
};

/**
 * The link to change: the one whose code is `wanted`, else the build's main (beta tester) link, else
 * its only link. A build normally has exactly one; more come from the dashboard's extra links.
 */
function pickLink(links: ShareLink[], buildId: string, wanted?: string): ShareLink {
  const list = () => links.map((l) => `${l.short_id} (${l.label || l.link_type})`).join(", ");
  if (links.length === 0) throw new Error(`Build ${buildId} has no install link to change.`);
  if (wanted) {
    // A bare code, or any install URL form: `/install/?i=<code>`, `/install/<code>`, `/app/<code>`.
    const w = wanted.trim();
    const code = (/[?&]i=([^&#]+)/.exec(w)?.[1] ?? w.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? w).toLowerCase();
    const match = links.find((l) => l.short_id.toLowerCase() === code);
    if (!match) throw new Error(`Build ${buildId} has no link with the code "${wanted}". Its links: ${list()}.`);
    return match;
  }
  const main = links.filter((l) => l.link_type === "beta_tester");
  if (main.length === 1) return main[0];
  if (links.length === 1) return links[0];
  throw new Error(`Build ${buildId} has ${links.length} links: ${list()}. The link input names the one to change.`);
}

/**
 * Both link routes check that the caller uploaded the build (`custom_link.rs`), more narrowly than
 * the link list does for an organization, so a 404 from them after the list found the link means a
 * teammate's build.
 */
function linkRefusal(err: unknown): Error {
  if (err instanceof CliError && err.status === 404) {
    return new Error("Only the person who uploaded this build can change its link's password or code.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

const updateLink: ToolHandler = async (args) => {
  const { buildId, password, removePassword, code, link } = (args ?? {}) as {
    buildId?: string;
    password?: string;
    removePassword?: boolean;
    code?: string;
    link?: string;
  };
  if (!buildId) throw new Error("A buildId is required.");
  const setPassword = typeof password === "string" && password.length > 0;
  if (setPassword && removePassword) throw new Error("A new password and removePassword cannot both be given.");
  const newCode = code?.trim();
  if (!setPassword && !removePassword && !newCode) {
    throw new Error("Nothing to change: no password, removePassword or code was given.");
  }

  const res = await apiFetch<ShareLink[]>(`/api/builds/${encodeURIComponent(buildId)}/share-links`);
  const target = pickLink(res.data ?? [], buildId, link);
  const linkPath = `/api/share-links/${encodeURIComponent(target.id)}`;
  let current = target.short_id;
  const done: string[] = [];

  // The code first: it is the change most likely to be refused (plan, taken, reserved), and a
  // refusal then leaves the link exactly as it was.
  if (newCode) {
    let claimed: string;
    try {
      const r = await apiFetch<{ short_id: string }>(`${linkPath}/short-id`, {
        method: "PATCH",
        body: { short_id: newCode },
      });
      claimed = r.data?.short_id ?? newCode;
    } catch (err) {
      throw linkRefusal(err);
    }
    if (claimed === current) {
      done.push(`The link already had the code **${claimed}**.`);
    } else {
      done.push(
        `The link's code is now **${claimed}**. The previous link (${installUrl(current)}) no longer opens the build.`,
      );
      current = claimed;
    }
  }

  if (setPassword || removePassword) {
    try {
      await apiFetch(`${linkPath}/password`, {
        method: "PATCH",
        // `null` is the API's "remove protection". The password itself is never echoed back.
        body: { password: removePassword ? null : password },
      });
    } catch (err) {
      const refusal = linkRefusal(err);
      if (done.length === 0) throw refusal;
      // The code already changed; say so beside the refusal rather than losing it.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${done.join("\n")}\n\n**Install link:** ${installUrl(current)}\n\nThe password was not changed: ${refusal.message}`,
          },
        ],
      };
    }
    done.push(
      removePassword
        ? "The link no longer asks for a password: anyone who has it can open the install page."
        : "The link now asks for a password. Anyone who unlocked it with an earlier password has to enter the new one.",
    );
  }

  return {
    content: [{ type: "text", text: `${done.join("\n")}\n\n**Install link:** ${installUrl(current)}` }],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_restore_build",
      description:
        "Restore a build that BetaDrop retired after it expired, while its file is still kept. The build gets a fresh expiry from the account's current plan (not the term it had before), its install link works again, and its file counts toward the account's storage again. BetaDrop refuses when that would pass the plan's storage limit or when the file has already been removed, and a build that has not been retired is left as it is. betadrop_list_expired_builds marks which builds are restorable. The reply gives the install link and the new expiry date.",
      inputSchema: {
        type: "object",
        properties: {
          buildId: {
            type: "string",
            description: "ID of the retired build, as an earlier build list or the BetaDrop dashboard showed it.",
          },
        },
        required: ["buildId"],
      },
    },
    {
      name: "betadrop_update_link",
      description:
        "Change a build's install link: set or change its password, remove the password, or give the link a custom code (Pro and Studio plans). A new code replaces the old one, so the previous install URL stops working; the reply gives the new one. A new password applies to everyone opening the link, including testers who unlocked it before, and removing it lets anyone with the link open the install page. Only the person who uploaded the build can change its link, and a password cannot be read back once set.",
      inputSchema: {
        type: "object",
        properties: {
          buildId: { type: "string", description: "ID of the build whose link changes (from betadrop_list_builds)." },
          password: {
            type: "string",
            description: "New password for the link, at least 4 characters. Testers enter it on the install page.",
          },
          removePassword: {
            type: "boolean",
            description: "true removes the link's password, so anyone with the link can open it.",
          },
          code: {
            type: "string",
            description:
              "Custom code for the link: 6–12 letters and numbers, giving https://betadrop.app/install/?i=<code>. Pro and Studio plans only.",
          },
          link: {
            type: "string",
            description:
              "The current code (or install URL) of the link to change, for a build with more than one link. Without it, the build's main install link changes.",
          },
        },
        required: ["buildId"],
      },
    },
  ],
  handlers: {
    betadrop_restore_build: restoreBuild,
    betadrop_update_link: updateLink,
  },
};
