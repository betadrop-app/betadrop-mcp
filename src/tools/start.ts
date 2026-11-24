// Start here tools: what `tools/list` shows and what runs on `tools/call`.
import { apiFetch } from "../lib/api.js";
import { UnauthorizedError } from "../lib/errors.js";
import type { WhoamiResponse, BuildListResponse, CliStats } from "../types.js";
import type { ToolHandler, ToolModule } from "./types.js";

const welcome: ToolHandler = async (_args, { remote }) => {
  let who: WhoamiResponse;
  try {
    const res = await apiFetch<WhoamiResponse>("/api/cli/whoami");
    if (!res.data) throw new Error("Unexpected response from BetaDrop.");
    who = res.data;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    // Over HTTP a request reaches here only when its token was revoked moments after it was last
    // checked. Signing in again is the connector's job there; pasting a token into chat is not.
    if (remote) {
      return {
        content: [
          {
            type: "text",
            text:
              "# 👋 Welcome to BetaDrop\n\n" +
              "**Your BetaDrop connection has expired or was revoked.** Reconnect the BetaDrop connector in your assistant's settings to sign in again.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            "# 👋 Welcome to BetaDrop\n\n" +
            "BetaDrop turns an iOS `.ipa` or Android `.apk` into an install link testers open on their phone — no TestFlight review, no Play track, no tester accounts.\n\n" +
            "**You're not signed in yet.** Create a token at https://betadrop.app → Settings → Developer → API tokens, then say:\n" +
            "> Log me in to BetaDrop with token bd_live_…",
        },
      ],
    };
  }

  // Twenty recent builds feed the insights; the table shows the newest three.
  const res = await apiFetch<BuildListResponse>("/api/cli/builds?page=1&per_page=20");
  const recent = res.data?.builds ?? [];
  const builds = recent.slice(0, 3);
  const total = res.data?.total ?? 0;
  const hasCounts = recent.some((b) => b.downloads !== undefined);

  // Account-wide totals; older API servers have no /stats, and then the recent page stands in.
  const stats = await apiFetch<CliStats>("/api/cli/stats").then((r) => r.data ?? null, () => null);

  const insights: string[] = [];
  if (stats) {
    insights.push(
      `📊 **${stats.installs} installs** on **${stats.uniqueDevices} devices** across all ${stats.builds.total} builds · ` +
        `${stats.builds.live} live · ${stats.builds.ios} iOS / ${stats.builds.android} Android`,
    );
    if (stats.mostInstalled) {
      const m = stats.mostInstalled;
      insights.push(`🔥 Most installed ever: **${m.name}${m.version ? ` ${m.version}` : ""}** — ${m.downloads} installs`);
    }
  } else if (hasCounts && recent.length > 0) {
    const installs = recent.reduce((n, b) => n + (b.downloads ?? 0), 0);
    const devices = recent.reduce((n, b) => n + (b.uniqueDevices ?? 0), 0);
    const live = recent.filter((b) => b.status === "active" || b.status === "latest").length;
    insights.push(
      `📊 **${installs} installs** on **${devices} devices** across your last ${recent.length} builds · ${live} live`,
    );
    const top = [...recent].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))[0];
    if ((top.downloads ?? 0) > 0) {
      insights.push(`🔥 Most installed: **${top.meta.name} ${top.meta.version}** — ${top.downloads} installs`);
    }
  }
  if (hasCounts) {
    const untouched = builds.find((b) => b.downloads === 0 && (b.status === "active" || b.status === "latest"));
    if (untouched) {
      insights.push(`💤 **${untouched.meta.name} ${untouched.meta.version}** hasn't been installed yet — share its link?`);
    }
  }
  const weekAhead = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const expiring = recent.filter(
    (b) => b.expiresAt && b.status !== "expired" && new Date(b.expiresAt).getTime() < weekAhead,
  );
  // The account-wide count can exceed what the recent page can name; say so rather than undercount.
  const expiringCount = Math.max(expiring.length, stats?.expiringSoon ?? 0);
  if (expiringCount > 0) {
    const more = expiringCount - expiring.length;
    insights.push(
      `⏳ ${expiringCount} build${expiringCount === 1 ? " expires" : "s expire"} within 7 days` +
        (expiring.length ? `: ${expiring.map((b) => `${b.meta.name} ${b.meta.version}`).join(", ")}` : "") +
        (more > 0 && expiring.length ? ` and ${more} more` : ""),
    );
  }

  const shortDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const buildSection =
    builds.length === 0
      ? "You haven't published anything yet — your first install link is one build file away."
      : `**${total} build${total === 1 ? "" : "s"}** on your account. Latest:\n\n` +
        // Build ID last: the column the user reads least, and the one the build tools take.
        (hasCounts
          ? "| App | Version | Platform | Published | Status | Installs | Devices | Install link | Build ID |\n" +
            "|---|---|---|---|---|---|---|---|---|\n"
          : "| App | Version | Platform | Published | Status | Install link | Build ID |\n" +
            "|---|---|---|---|---|---|---|\n") +
        builds
          .map(
            (b) =>
              `| ${b.meta.name} | ${b.meta.version} | ${b.platform === "ios" ? "iOS" : "Android"} | ` +
              `${shortDate(b.createdAt)} | ${b.status} | ` +
              (hasCounts ? `${b.downloads ?? 0} | ${b.uniqueDevices ?? 0} | ` : "") +
              `${b.installUrl ?? "—"} | ${b.id} |`,
          )
          .join("\n") +
        (insights.length ? `\n\n${insights.join("\n")}` : "");

  // Over HTTP there is no local file to upload, so publishing is pointed at the local server.
  const publishIdeas = remote
    ? '- 📦 **Publish a build** — "Give me an upload link for my APK" · "Publish https://github.com/me/app/releases/download/v2/app.apk"'
    : '- 📦 **Publish a build** — "Publish ~/Downloads/MyApp.ipa with notes \'Login fix\' and expire it in 7 days"\n' +
      '- 🔍 **Check a build before sending it** — "Will this IPA install on my testers\' phones?"';

  return {
    content: [
      {
        type: "text",
        text:
          `# 👋 Hi, ${who.user.email}\n\n` +
          `${buildSection}\n\n` +
          "## What you can ask me\n\n" +
          `${publishIdeas}\n` +
          '- 📋 **Your builds** — "Show my latest Android builds" · "Which builds have expired?"\n' +
          '- 📈 **Install analytics** — "How is my latest build doing?" · "Which countries and devices installed ShopEase?"\n' +
          '- 🔗 **Standing links** — "Point my beta link at yesterday\'s build" (testers keep one URL that always installs the newest build)\n' +
          '- 📱 **iOS devices** — "Invite Priya to register her iPhone" · "Export my UDIDs for the Apple portal"\n' +
          '- 💬 **Tester feedback** — "What did testers say about the last build?"\n' +
          '- 🪝 **Webhooks** — "Post to my Slack webhook whenever a build is published"\n' +
          '- 🔑 **API tokens** — "Create a publish-only token for GitHub Actions"\n\n' +
          "Just ask in your own words — no tool names needed.",
      },
    ],
  };
};

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_welcome",
      description:
        "Personalized BetaDrop overview: the signed-in account, the latest builds with their install links, and what you can ask for next. For when the user asks what BetaDrop can do or is unsure where to start.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  handlers: {
    betadrop_welcome: welcome,
  },
};
