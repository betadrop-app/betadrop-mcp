// Standing links tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { StandingLink } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

const listStandingLinks: ToolHandler = async () => {
  const res = await apiFetch<{ channels: StandingLink[] }>("/api/channels");
  const links = res.data?.channels ?? [];
  if (links.length === 0) {
    return { content: [{ type: "text", text: "No standing links. Create one at https://betadrop.app/channels/" }] };
  }
  const lines = links.map(
    (l) =>
      `• ${l.slug} — ${l.url}\n  Serving: ${l.currentBuild ? `${l.currentBuild.name ?? "build"} ${l.currentBuild.version ?? ""} [${l.currentBuild.id}]` : "nothing yet"} · ${l.followerCount ?? 0} follower(s)`,
  );
  return { content: [{ type: "text", text: lines.join("\n\n") }] };
};

const pointStandingLink: ToolHandler = async (args) => {
  const { slug, buildId } = args as { slug: string; buildId: string };
  const res = await apiFetch<{ channels: StandingLink[] }>("/api/channels");
  const link = (res.data?.channels ?? []).find((l) => l.slug.toLowerCase() === slug.toLowerCase());
  if (!link) throw new Error(`No standing link "${slug}" on this account. Call betadrop_list_standing_links.`);
  await apiFetch(`/api/channels/${link.id}/build`, { method: "PUT", body: { buildId } });
  return {
    content: [
      {
        type: "text",
        text:
          `Standing link **${link.slug}** now serves build ${buildId}: ${link.url}` +
          ((link.followerCount ?? 0) > 0 ? `\n${link.followerCount} follower(s) will be emailed.` : ""),
      },
    ],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_list_standing_links",
      description:
        "List standing links — one permanent install URL each, serving whichever build it was last pointed at — with the build each serves and how many testers follow it.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_point_standing_link",
      description:
        "Point a standing link at an already-uploaded build. Testers who follow the link are emailed about the new build.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The standing link's slug." },
          buildId: { type: "string", description: "Build ID (from betadrop_list_builds)." },
        },
        required: ["slug", "buildId"],
      },
    },
  ],
  handlers: {
    betadrop_list_standing_links: listStandingLinks,
    betadrop_point_standing_link: pointStandingLink,
  },
};
