// Apps, tester groups and testers (COMPETITOR-GAPS-PLAN gap 2). Tester groups are on Pro and
// Studio; on Free the API answers 403 upgrade_required, which the shared error path reports.
import { apiFetch } from "../lib/api.js";
import type { ToolHandler, ToolModule } from "./types.js";

interface PlatformBuild {
  version: string | null;
  buildNumber: string | null;
}

interface AppSummary {
  id: string;
  bundleId: string;
  name: string;
  isPrivate: boolean;
  platforms: string[];
  buildCount: number;
  latest: { ios: PlatformBuild | null; android: PlatformBuild | null };
}

interface Group {
  id: string;
  name: string;
  appId: string | null;
  appBundleId: string | null;
  members: number;
  active: number;
}

interface Tester {
  id: string;
  email: string;
  install: { status: string; lastInstalled: PlatformBuild | null };
}

const STATUS: Record<string, string> = {
  invited: "invited, not confirmed yet",
  not_opened: "has not opened their link",
  opened: "opened, not installed",
  behind: "on an older build",
  up_to_date: "up to date",
};

const ver = (b: PlatformBuild | null) => (b ? `${b.version ?? "?"}${b.buildNumber ? ` (${b.buildNumber})` : ""}` : "nothing installable");
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const listApps: ToolHandler = async () => {
  const res = await apiFetch<{ apps: AppSummary[] }>("/api/apps");
  const apps = res.data?.apps ?? [];
  if (apps.length === 0) return text("No apps yet. Publish a build and its app appears here.");
  return text(
    apps
      .map(
        (a) =>
          `• [${a.id}] ${a.name} (${a.bundleId})${a.isPrivate ? " — testers only" : ""}\n` +
          `  ${a.buildCount} builds · iOS ${ver(a.latest.ios)} · Android ${ver(a.latest.android)}`,
      )
      .join("\n\n"),
  );
};

const setAppPrivate: ToolHandler = async (args) => {
  const { appId, isPrivate } = args as { appId: string; isPrivate: boolean };
  await apiFetch(`/api/apps/${encodeURIComponent(appId)}`, { method: "PATCH", body: { isPrivate } });
  return text(
    isPrivate
      ? "The app is now testers only: it installs only from invited testers' personal links. Its share links and standing links stop working until privacy is turned off."
      : "The app installs from its share links and standing links again.",
  );
};

const listGroups: ToolHandler = async () => {
  const res = await apiFetch<{ groups: Group[] }>("/api/tester-groups");
  const groups = res.data?.groups ?? [];
  if (groups.length === 0) return text("No tester groups. Create one with betadrop_create_tester_group.");
  return text(
    groups
      .map(
        (g) =>
          `• [${g.id}] ${g.name} — ${g.appBundleId ? `sends new builds of ${g.appBundleId}` : "no app"}\n` +
          `  ${g.active} confirmed, ${g.members - g.active} invited`,
      )
      .join("\n\n"),
  );
};

const createGroup: ToolHandler = async (args) => {
  const { name, appId } = args as { name: string; appId?: string };
  const res = await apiFetch<{ group: Group }>("/api/tester-groups", {
    method: "POST",
    body: { name, appId: appId ?? null },
  });
  const g = res.data!.group;
  return text(`Group "${g.name}" created [${g.id}]. Invite people with betadrop_invite_testers.`);
};

const listTesters: ToolHandler = async (args) => {
  const { groupId } = args as { groupId: string };
  const res = await apiFetch<{ group: Group; testers: Tester[] }>(`/api/tester-groups/${encodeURIComponent(groupId)}`);
  const { group, testers } = res.data!;
  if (testers.length === 0) return text(`Nobody in "${group.name}" yet.`);
  const behind = testers.filter((t) => t.install.status !== "up_to_date" && t.install.status !== "invited").length;
  return text(
    `${group.name}: ${testers.length} testers, ${behind} not on the newest build.\n\n` +
      testers
        .map(
          (t) =>
            `• [${t.id}] ${t.email} — ${STATUS[t.install.status] ?? t.install.status}` +
            (t.install.lastInstalled ? `, has ${ver(t.install.lastInstalled)}` : ""),
        )
        .join("\n"),
  );
};

const inviteTesters: ToolHandler = async (args) => {
  const { groupId, emails } = args as { groupId: string; emails: string[] };
  const res = await apiFetch<{
    invited: number;
    alreadyInvited: number;
    alreadyActive: number;
    invalid: string[];
    unsubscribed?: string[];
  }>(
    `/api/tester-groups/${encodeURIComponent(groupId)}/testers`,
    { method: "POST", body: { emails } },
  );
  const r = res.data!;
  return text(
    `${r.invited} invited (one email each; nothing more until they confirm).` +
      (r.alreadyInvited ? ` ${r.alreadyInvited} were already invited and were not emailed again.` : "") +
      (r.alreadyActive ? ` ${r.alreadyActive} are already testers.` : "") +
      (r.invalid.length ? ` Not valid addresses: ${r.invalid.join(", ")}.` : "") +
      (r.unsubscribed?.length
        ? ` Not invited, because they unsubscribed: ${r.unsubscribed.join(", ")}. They can rejoin from a join link.`
        : ""),
  );
};

const remindTesters: ToolHandler = async (args) => {
  const { groupId } = args as { groupId: string };
  const res = await apiFetch<{ reminded: number; upToDate: number; remindedRecently: number }>(
    `/api/tester-groups/${encodeURIComponent(groupId)}/remind`,
    { method: "POST" },
  );
  const r = res.data!;
  return text(
    `${r.reminded} reminded.` +
      (r.remindedRecently ? ` ${r.remindedRecently} were already reminded in the last day.` : "") +
      (r.upToDate ? ` ${r.upToDate} are up to date.` : ""),
  );
};

const removeTester: ToolHandler = async (args) => {
  const { groupId, testerId } = args as { groupId: string; testerId: string };
  await apiFetch(`/api/tester-groups/${encodeURIComponent(groupId)}/testers/${encodeURIComponent(testerId)}`, {
    method: "DELETE",
  });
  return text("Removed from the group.");
};

const groupId = { type: "string", description: "Tester group ID (from betadrop_list_tester_groups)." } as const;

export const tools: ToolModule = {
  definitions: [
    {
      name: "betadrop_list_apps",
      description:
        "List the user's apps: builds grouped by bundle ID (iOS and Android together), with the build each platform serves now and whether the app is testers only.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_set_app_private",
      description:
        "Make an app testers only (isPrivate true): it then installs only from invited testers' personal links, and its share links and standing links stop working. isPrivate false undoes it. Turning it on needs a Pro or Studio plan.",
      inputSchema: {
        type: "object",
        properties: {
          appId: { type: "string", description: "App ID (from betadrop_list_apps)." },
          isPrivate: { type: "boolean" },
        },
        required: ["appId", "isPrivate"],
      },
    },
    {
      name: "betadrop_list_tester_groups",
      description: "List tester groups, the app each sends new builds of, and how many testers have confirmed. Pro and Studio.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "betadrop_create_tester_group",
      description:
        "Create a tester group. With appId, every confirmed tester in it is emailed a personal link to each new build of that app (at most one email per tester every 6 hours).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Group name, e.g. Beta testers." },
          appId: { type: "string", description: "App ID (from betadrop_list_apps). Omit for a list with no app." },
        },
        required: ["name"],
      },
    },
    {
      name: "betadrop_list_testers",
      description:
        "Who is in a tester group and where each person is: invited, not opened, opened but not installed, on an older build, or up to date.",
      inputSchema: { type: "object", properties: { groupId }, required: ["groupId"] },
    },
    {
      name: "betadrop_invite_testers",
      description:
        "Invite people to a tester group by email. Each new address gets one invitation and nothing else until they confirm. Already-invited addresses are not emailed again, and addresses that unsubscribed are not emailed at all.",
      inputSchema: {
        type: "object",
        properties: {
          groupId,
          emails: { type: "array", items: { type: "string" }, description: "Email addresses (up to 200)." },
        },
        required: ["groupId", "emails"],
      },
    },
    {
      name: "betadrop_remind_testers",
      description:
        "Email every confirmed tester in the group who is not on the app's newest build a personal link to it. At most one reminder per tester a day. The group must follow an app.",
      inputSchema: { type: "object", properties: { groupId }, required: ["groupId"] },
    },
    {
      name: "betadrop_remove_tester",
      description: "Take a tester out of a group. They stop getting that group's new builds.",
      inputSchema: {
        type: "object",
        properties: { groupId, testerId: { type: "string", description: "Tester ID (from betadrop_list_testers)." } },
        required: ["groupId", "testerId"],
      },
    },
  ],
  handlers: {
    betadrop_list_apps: listApps,
    betadrop_set_app_private: setAppPrivate,
    betadrop_list_tester_groups: listGroups,
    betadrop_create_tester_group: createGroup,
    betadrop_list_testers: listTesters,
    betadrop_invite_testers: inviteTesters,
    betadrop_remind_testers: remindTesters,
    betadrop_remove_tester: removeTester,
  },
};
