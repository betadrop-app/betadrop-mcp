// Install analytics tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import type { BuildListItem, BuildListResponse, BuildAnalyticsSummary, BuildTimeseries } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

/** The list endpoint's page ceiling. */
const PER_PAGE = 100;
/**
 * How many pages a lookup reads: the newest 500 builds. One page used to be the whole search, so
 * a build past the newest 100 was "not found" even by its own id. The cap keeps a miss on a large
 * account to five list calls.
 */
const SEARCH_PAGES = 5;

/**
 * The build `wanted` names, newest first: by id or shortId, else by app name. With nothing wanted,
 * the most recent build. `searched` is how many builds were looked at, `total` how many there are.
 */
async function findBuild(wanted: string | undefined): Promise<{ target?: BuildListItem; searched: number; total: number }> {
  let searched = 0;
  let total = 0;
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const list = await apiFetch<BuildListResponse>(`/api/cli/builds?page=${page}&per_page=${PER_PAGE}`);
    const builds = list.data?.builds ?? [];
    searched += builds.length;
    total = list.data?.total ?? searched;
    if (!wanted) return { target: builds[0], searched, total };
    const target =
      builds.find((b) => b.id.toLowerCase() === wanted || b.shortId?.toLowerCase() === wanted) ??
      builds.find((b) => b.meta.name.toLowerCase() === wanted);
    if (target) return { target, searched, total };
    if (builds.length < PER_PAGE || searched >= total) break;
  }
  return { searched, total };
}

const buildAnalytics: ToolHandler = async (args) => {
  const { build, days = 14 } = (args ?? {}) as { build?: string; days?: number };
  const span = Math.max(1, Math.min(Math.round(days), 90));

  const { target, searched, total } = await findBuild(build?.trim().toLowerCase() || undefined);
  if (!target) {
    throw new Error(
      total === 0
        ? "No builds yet — publish one and its installs will show up here."
        : `No build matches "${build}"` +
            (searched < total ? ` in your newest ${searched} builds` : "") +
            ". Use an id or shortId from betadrop_list_builds, or the app's name.",
    );
  }

  const [summaryRes, seriesRes] = await Promise.all([
    apiFetch<{ summary: BuildAnalyticsSummary }>(`/api/builds/${target.id}/analytics`),
    apiFetch<BuildTimeseries>(`/api/builds/${target.id}/analytics/timeseries?days=${span}`),
  ]);
  const s = summaryRes.data?.summary;
  const ts = seriesRes.data;
  if (!s || !ts) throw new Error("Unexpected response from BetaDrop.");

  const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");
  const counted = (rows: Array<{ label: string; count: number }>) =>
    rows.length === 0 ? "none yet" : rows.map((r) => `${r.label} (${r.count})`).join(" · ");

  // One bar per day, scaled to the busiest day, so the shape reads at a glance in any client.
  const peak = Math.max(1, ...ts.series.map((d) => d.total));
  const trend = ts.series
    .map((d) => {
      const day = new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      const bar = "█".repeat(Math.round((d.total / peak) * 20));
      return `${day.padEnd(6)} ${bar}${bar ? " " : ""}${d.total}`;
    })
    .join("\n");

  // Zero rows are dropped: "Android 0%" on an iOS build says nothing.
  const platformTotal = s.platform_breakdown.ios + s.platform_breakdown.android + s.platform_breakdown.other;
  const platforms = (
    [["iOS", s.platform_breakdown.ios], ["Android", s.platform_breakdown.android], ["other", s.platform_breakdown.other]] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${pct(n, platformTotal)}`)
    .join(" · ");
  const deviceTypes = (
    [["phone", s.device_breakdown.mobile], ["tablet", s.device_breakdown.tablet], ["desktop", s.device_breakdown.desktop]] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join(" · ");
  const failures =
    s.failed_attempts === 0
      ? "none"
      : `${s.failed_attempts}` +
        (s.failure_reasons.length
          ? ` — ${s.failure_reasons.map((r) => `${r.reason} (${r.count})`).join(", ")}`
          : "");

  return {
    content: [
      {
        type: "text",
        text:
          `# 📈 ${target.meta.name} ${target.meta.version} (${target.platform === "ios" ? "iOS" : "Android"})\n` +
          `${target.installUrl ?? ""}\n\n` +
          "| Installs | Unique devices | Failed installs | Status |\n|---|---|---|---|\n" +
          `| **${s.total_downloads}** | **${s.unique_devices}** | ${s.failed_attempts} | ${target.status} |\n\n` +
          `## Last ${ts.days} days — ${ts.totals.total} installs\n` +
          "```\n" + trend + "\n```\n\n" +
          "## Breakdown\n" +
          `- **Platforms:** ${platforms || "none yet"}\n` +
          `- **Device types:** ${deviceTypes || "none yet"}\n` +
          `- **Top devices:** ${counted(s.top_devices.slice(0, 5).map((d) => ({ label: d.model, count: d.count })))}\n` +
          `- **Top countries:** ${counted(s.geographic_distribution.slice(0, 5).map((g) => ({ label: g.country, count: g.count })))}\n` +
          `- **Failed installs:** ${failures}`,
      },
    ],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_build_analytics",
      description:
        "Install analytics for one build: installs, unique devices, failed installs and why, a daily trend, iOS/Android split, top device models and countries. It answers questions like \"how is my latest build doing?\" or \"which countries and devices installed ShopEase?\". Installs carry no tester names, so it cannot say who installed a build.",
      inputSchema: {
        type: "object",
        properties: {
          build: {
            type: "string",
            description:
              "The build: its id or shortId from betadrop_list_builds, or an app name (the newest build with that name is used). Only the newest 500 builds are searched. Omit for the most recent build.",
          },
          days: {
            type: "number",
            description: "Length of the daily trend, 1–90 days. Default 14.",
          },
        },
      },
    },
  ],
  handlers: {
    betadrop_build_analytics: buildAnalytics,
  },
};
