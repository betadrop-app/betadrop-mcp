import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build, call, connect, fakeApi, ok } from "./helpers.js";
import type { Route } from "./helpers.js";

let api: Awaited<ReturnType<typeof fakeApi>> | undefined;

beforeEach(() => {
  process.env.BETADROP_TOKEN = "bd_live_test";
});
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const BUILD_ID = build().id;
const refuse = (status: number, error: string, reason?: string) => ({ status, body: { success: false, error, reason } });

/** A route that also records each JSON body it was sent, keyed by method. */
function recording(bodies: Array<{ method: string; body: unknown }>, answer: Route): Route {
  return (req: http.IncomingMessage) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => bodies.push({ method: req.method ?? "", body: raw ? JSON.parse(raw) : undefined }));
    return answer(req);
  };
}

describe("betadrop_restore_build", () => {
  it("restores a retired build and gives its link and new expiry", async () => {
    api = await fakeApi({
      [`/api/builds/${BUILD_ID}/restore`]: (req) =>
        req.method === "POST"
          ? { body: ok({ id: BUILD_ID, restored: true, expiresAt: "2026-12-25T10:00:00Z" }) }
          : { status: 405, body: { success: false } },
      [`/api/builds/${BUILD_ID}`]: ok({ build: { name: "ShopEase", version: "2.4.0", default_short_id: "aB3xYz" } }),
    });
    const { text, isError } = await call(await connect(true), "betadrop_restore_build", { buildId: BUILD_ID });

    expect(isError).toBe(false);
    expect(text).toContain(`Restored **ShopEase 2.4.0** (build ${BUILD_ID}).`);
    expect(text).toContain("https://betadrop.app/install/?i=aB3xYz");
    expect(text).toContain("expires on 2026-12-25");
    expect(text).toContain("counts toward the account's storage again");
    expect(api.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST /api/builds/${BUILD_ID}/restore`,
      `GET /api/builds/${BUILD_ID}`,
    ]);
  });

  it("still reports the restore when the build can't be read back", async () => {
    api = await fakeApi({ [`/api/builds/${BUILD_ID}/restore`]: ok({ id: BUILD_ID, restored: true, expiresAt: "2026-12-25T10:00:00Z" }) });
    const { text, isError } = await call(await connect(), "betadrop_restore_build", { buildId: BUILD_ID });
    expect(isError).toBe(false);
    expect(text).toContain(`Restored build ${BUILD_ID}.`);
    expect(text).toContain("Its install link works again.");
  });

  it("says nothing changed for a build that was not retired", async () => {
    api = await fakeApi({ [`/api/builds/${BUILD_ID}/restore`]: ok({ id: BUILD_ID, restored: false }) });
    const { text, isError } = await call(await connect(), "betadrop_restore_build", { buildId: BUILD_ID });
    expect(isError).toBe(false);
    expect(text).toContain("Nothing changed");
    expect(text).not.toContain("Restored");
  });

  it("passes the API's refusals through: over the plan's storage, file gone, read-only token", async () => {
    for (const [status, error] of [
      [402, "Restoring this build needs 120 MB and your plan includes 5 GB. Free up space or upgrade to restore it."],
      [410, "This build's file has been removed and can no longer be restored."],
      [403, "This token is not allowed to make changes. It needs the 'publish' ability."],
    ] as const) {
      api = await fakeApi({ [`/api/builds/${BUILD_ID}/restore`]: () => refuse(status, error) });
      const { text, isError } = await call(await connect(), "betadrop_restore_build", { buildId: BUILD_ID });
      expect(isError, String(status)).toBe(true);
      expect(text).toBe(error);
      await api.close();
      api = undefined;
    }
  });
});

describe("betadrop_update_link", () => {
  const links = [
    { id: "link-main", link_type: "beta_tester", short_id: "aB3xYz", label: null },
    { id: "link-qa", link_type: "qa", short_id: "qaLink12", label: "QA team" },
  ];
  const linksRoute = { [`/api/builds/${BUILD_ID}/share-links`]: ok(links) };

  it("gives the main link a custom code and reports the new and the old URL", async () => {
    const bodies: Array<{ method: string; body: unknown }> = [];
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/short-id": recording(bodies, () => ({ body: ok({ id: "link-main", short_id: "acmebeta" }) })),
    });
    const { text, isError } = await call(await connect(true), "betadrop_update_link", { buildId: BUILD_ID, code: "acmebeta" });

    expect(isError).toBe(false);
    expect(text).toContain("The link's code is now **acmebeta**.");
    expect(text).toContain("**Install link:** https://betadrop.app/install/?i=acmebeta");
    expect(text).toContain("The previous link (https://betadrop.app/install/?i=aB3xYz) no longer opens the build.");
    await vi.waitFor(() => expect(bodies).toEqual([{ method: "PATCH", body: { short_id: "acmebeta" } }]));
  });

  it("returns the plan gate as the API words it, and leaves the password alone", async () => {
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/short-id": () =>
        refuse(403, "Custom links are available on the Pro and Studio plans.", "upgrade_required"),
    });
    const { text, isError } = await call(await connect(), "betadrop_update_link", {
      buildId: BUILD_ID,
      code: "acmebeta",
      password: "hunter22",
    });
    expect(isError).toBe(true);
    expect(text).toBe("Custom links are available on the Pro and Studio plans.");
    expect(api.seen.some((r) => r.url.endsWith("/password"))).toBe(false);
  });

  it("sets a password without ever repeating it", async () => {
    const bodies: Array<{ method: string; body: unknown }> = [];
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/password": recording(bodies, () => ({
        body: ok({ has_password: true, password_set_at: "2026-11-25T00:00:00Z", sessions_revoked: true }),
      })),
    });
    const { text, isError } = await call(await connect(), "betadrop_update_link", { buildId: BUILD_ID, password: "hunter22" });

    expect(isError).toBe(false);
    expect(text).toContain("The link now asks for a password.");
    expect(text).toContain("https://betadrop.app/install/?i=aB3xYz");
    expect(text).not.toContain("hunter22");
    await vi.waitFor(() => expect(bodies).toEqual([{ method: "PATCH", body: { password: "hunter22" } }]));
  });

  it("removes a password by sending null, and says the link is now open", async () => {
    const bodies: Array<{ method: string; body: unknown }> = [];
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/password": recording(bodies, () => ({ body: ok({ has_password: false, password_set_at: null }) })),
    });
    const { text } = await call(await connect(), "betadrop_update_link", { buildId: BUILD_ID, removePassword: true });
    expect(text).toContain("anyone who has it can open the install page");
    await vi.waitFor(() => expect(bodies).toEqual([{ method: "PATCH", body: { password: null } }]));
  });

  it("picks another link by its code or install URL, and names the links when none matches", async () => {
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-qa/password": ok({ has_password: false }),
    });
    const client = await connect();
    const picked = await call(client, "betadrop_update_link", {
      buildId: BUILD_ID,
      removePassword: true,
      link: "https://betadrop.app/install/?i=QALINK12",
    });
    expect(picked.isError).toBe(false);
    expect(picked.text).toContain("https://betadrop.app/install/?i=qaLink12");

    const missing = await call(client, "betadrop_update_link", { buildId: BUILD_ID, removePassword: true, link: "nope99" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("aB3xYz (beta_tester), qaLink12 (QA team)");
  });

  it("says a teammate's build link can only be changed by its uploader", async () => {
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/password": () => refuse(404, "Share link not found"),
    });
    const { text, isError } = await call(await connect(), "betadrop_update_link", { buildId: BUILD_ID, password: "hunter22" });
    expect(isError).toBe(true);
    expect(text).toContain("Only the person who uploaded this build");
  });

  it("keeps a code change in the reply when the password after it is refused", async () => {
    api = await fakeApi({
      ...linksRoute,
      "/api/share-links/link-main/short-id": ok({ short_id: "acmebeta" }),
      "/api/share-links/link-main/password": () => refuse(422, "Password must be at least 4 characters."),
    });
    const { text, isError } = await call(await connect(), "betadrop_update_link", {
      buildId: BUILD_ID,
      code: "acmebeta",
      password: "abc",
    });
    expect(isError).toBe(true);
    expect(text).toContain("The link's code is now **acmebeta**.");
    expect(text).toContain("https://betadrop.app/install/?i=acmebeta");
    expect(text).toContain("The password was not changed: Password must be at least 4 characters.");
  });

  it("refuses a call that changes nothing, or asks to set and remove a password at once", async () => {
    api = await fakeApi(linksRoute);
    const client = await connect();
    expect((await call(client, "betadrop_update_link", { buildId: BUILD_ID })).text).toContain("Nothing to change");
    const both = await call(client, "betadrop_update_link", { buildId: BUILD_ID, password: "hunter22", removePassword: true });
    expect(both.isError).toBe(true);
    expect(api.seen).toHaveLength(0);
  });
});

describe("restore and link annotations", () => {
  it("marks restore as a safe repeatable write and a link change as destructive and public", async () => {
    const { tools } = await (await connect(true)).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.betadrop_restore_build).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.betadrop_update_link).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
