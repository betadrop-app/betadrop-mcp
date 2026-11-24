import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build, call, connect, fakeApi, ok, whoami } from "./helpers.js";

let api: Awaited<ReturnType<typeof fakeApi>> | undefined;

/**
 * Run `fn` with HOME and XDG_CONFIG_HOME in a scratch directory, so the upload status file and the
 * shared config file it touches are its own, and never the developer's.
 */
async function withScratchHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betadrop-mcp-test-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A file that passes the publish tool's checks: an .ipa name and the ZIP magic bytes. */
async function fakeIpa(dir: string, bytes = 64): Promise<string> {
  const file = path.join(dir, "ShopEase.ipa");
  const body = Buffer.alloc(bytes);
  body.write("PK\x03\x04", 0, "latin1");
  await fs.writeFile(file, body);
  return file;
}

/** A local HTTP server for the cases the fake API cannot play: a dropped or a stuck request. */
async function rawServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.BETADROP_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const BUILD_ID = build().id;

/** `POST /api/cli/publish`'s answer for an ordinary upload, as `Published::to_json` writes it. */
function published(over: Record<string, unknown> = {}) {
  return {
    id: BUILD_ID,
    platform: "ios",
    fileSize: 64,
    shortId: "aB3xYz",
    url: "https://betadrop.app/install/?i=aB3xYz",
    meta: { name: "ShopEase", version: "2.4.1", package: "com.shop", icon: null, dominantColor: null },
    held_for_review: false,
    repackagedWarning: null,
    repackagedWarningShort: null,
    signingReach: null,
    retentionClamp: null,
    channel: null,
    channelWarning: null,
    appHistory: { priorBuilds: 3 },
    standingLinksMoved: [],
    duplicateOf: null,
    android_registration: null,
    signer_change: null,
    ...over,
  };
}

const NO_DEVICES =
  "This build's provisioning profile lists no devices, so iOS will refuse to install it on any iPhone or iPad.";
const CERT = "AB".repeat(32);

beforeEach(() => {
  process.env.BETADROP_TOKEN = "bd_live_test";
});
afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe("tool registry", () => {
  it("lists every tool over stdio and hides the machine-local ones remotely", async () => {
    const local = await (await connect(false)).listTools();
    const remote = await (await connect(true)).listTools();
    const names = local.tools.map((t) => t.name);

    expect(names).toHaveLength(28);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("betadrop_welcome");
    expect(remote.tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(["betadrop_publish"]));
    expect(remote.tools).toHaveLength(23);
  });

  it("gives every tool the title and hints the connector directory requires", async () => {
    const { tools } = await (await connect(false)).listTools();
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
      expect(t.annotations!.readOnlyHint && t.annotations!.destructiveHint, t.name).toBe(false);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.betadrop_delete_build?.destructiveHint).toBe(true);
    expect(byName.betadrop_list_builds?.readOnlyHint).toBe(true);
    expect(byName.betadrop_publish?.readOnlyHint).toBe(false);
  });

  it("refuses a local-only tool remotely, pointing publish at the tools that work there", async () => {
    const publish = await call(await connect(true), "betadrop_publish", { filePath: "/x.ipa" });
    expect(publish.isError).toBe(true);
    expect(publish.text).toContain("betadrop_create_upload_link");

    const login = await call(await connect(true), "betadrop_login", { token: "x" });
    expect(login.isError).toBe(true);
    expect(login.text).toContain("npx -y @betadrop/mcp");
  });

  it("answers an unknown tool with an error result, not a crash", async () => {
    const { text, isError } = await call(await connect(), "betadrop_nope");
    expect(isError).toBe(true);
    expect(text).toContain("Tool not found");
  });

  it("tells the client to open with the welcome overview", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("call betadrop_welcome first");
  });
});

describe("betadrop_welcome", () => {
  it("shows account-wide totals, the latest builds and their installs", async () => {
    api = await fakeApi({
      "/api/cli/whoami": whoami,
      "/api/cli/builds": ok({ builds: [build({ version: "2.4.1", downloads: 0, status: "latest" }), build()], total: 42, page: 1, perPage: 20 }),
      "/api/cli/stats": ok({
        builds: { total: 42, live: 30, expired: 12, ios: 25, android: 17 },
        installs: 1234,
        uniqueDevices: 456,
        expiringSoon: 0,
        mostInstalled: { id: "x", name: "ShopEase", version: "2.0.0", downloads: 300 },
      }),
    });
    const { text, isError } = await call(await connect(), "betadrop_welcome");

    expect(isError).toBe(false);
    expect(text).toContain("Hi, dev@example.com");
    expect(text).toContain("| Installs | Devices |");
    expect(text).toContain("1234 installs** on **456 devices** across all 42 builds");
    expect(text).toContain("Most installed ever: **ShopEase 2.0.0** — 300 installs");
    expect(text).toContain("ShopEase 2.4.1** hasn't been installed yet");
    expect(text).toContain("https://betadrop.app/install/?i=aB3xYz");
    // The id the build tools take, in its own column.
    expect(text).toContain("| Install link | Build ID |");
    expect(text).toContain(`| https://betadrop.app/install/?i=aB3xYz | ${BUILD_ID} |`);
  });

  it("falls back to the recent page on an API without /stats", async () => {
    api = await fakeApi({
      "/api/cli/whoami": whoami,
      "/api/cli/builds": ok({ builds: [build({ downloads: 5, uniqueDevices: 4 }), build({ downloads: 7, uniqueDevices: 6 })], total: 2, page: 1, perPage: 20 }),
    });
    const { text } = await call(await connect(), "betadrop_welcome");
    expect(text).toContain("12 installs** on **10 devices** across your last 2 builds");
  });

  it("offers remote users an upload link or a URL for publishing", async () => {
    api = await fakeApi({ "/api/cli/whoami": whoami, "/api/cli/builds": ok({ builds: [], total: 0, page: 1, perPage: 20 }) });
    const { text } = await call(await connect(true), "betadrop_welcome");
    expect(text).toContain("haven't published anything yet");
    expect(text).toContain("Give me an upload link for my APK");
    expect(text).not.toContain("~/Downloads/MyApp.ipa");
  });

  it("explains how to sign in when the token is rejected", async () => {
    api = await fakeApi({ "/api/cli/whoami": () => ({ status: 401, body: { success: false } }) });
    const { text, isError } = await call(await connect(), "betadrop_welcome");
    expect(isError).toBe(false);
    expect(text).toContain("not signed in yet");
  });

  it("on the hosted connector, sends a refused user back to the connector, never to pasting a token", async () => {
    api = await fakeApi({ "/api/cli/whoami": () => ({ status: 401, body: { success: false } }) });
    const { text, isError } = await call(await connect(true), "betadrop_welcome");
    expect(isError).toBe(false);
    expect(text).toContain("Reconnect the BetaDrop connector");
    expect(text).not.toContain("bd_live");
    expect(text).not.toContain("Log me in");
  });
});

describe("betadrop_help", () => {
  /** Whole words, so `betadrop_publish` does not match inside `betadrop_publish_from_url`. */
  const mentions = (text: string, tool: string) => new RegExp(`\\b${tool}\\b`).test(text);

  it("covers every tool the local server lists, and how to configure it", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    const { text } = await call(client, "betadrop_help");
    for (const t of tools) expect(mentions(text, t.name), t.name).toBe(true);
    expect(text).toContain("BETADROP_TOKEN");
    // What the publish API accepts: .ipa and .apk only.
    expect(text).toContain("App bundles (.aab) can't be installed from a link");
  });

  it("shows the hosted connector only the tools it has, and no environment variables", async () => {
    const local = (await (await connect(false)).listTools()).tools.map((t) => t.name);
    const client = await connect(true);
    const remote = (await client.listTools()).tools.map((t) => t.name);
    const { text } = await call(client, "betadrop_help");

    for (const name of remote) expect(mentions(text, name), name).toBe(true);
    const hidden = local.filter((name) => !remote.includes(name));
    expect(hidden).toEqual(expect.arrayContaining(["betadrop_login", "betadrop_publish", "betadrop_inspect"]));
    for (const name of hidden) expect(mentions(text, name), name).toBe(false);
    expect(text).not.toContain("## Configuration");
    expect(text).not.toContain("BETADROP_TOKEN");
  });
});

describe("betadrop_whoami", () => {
  it("names the API server over stdio", async () => {
    api = await fakeApi({ "/api/cli/whoami": whoami });
    const { text } = await call(await connect(false), "betadrop_whoami");
    expect(text).toContain(`API URL: ${api.url}`);
  });

  it("keeps the hosted connector's internal API address to itself", async () => {
    api = await fakeApi({ "/api/cli/whoami": whoami });
    const { text, isError } = await call(await connect(true), "betadrop_whoami");
    expect(isError).toBe(false);
    expect(text).toContain("dev@example.com");
    expect(text).not.toContain("API URL");
    expect(text).not.toContain("127.0.0.1");
  });
});

describe("betadrop_build_analytics", () => {
  const summary = {
    total_downloads: 118,
    unique_devices: 64,
    failed_attempts: 2,
    failure_reasons: [{ reason: "Device not in provisioning profile", count: 2 }],
    device_breakdown: { mobile: 58, tablet: 6, desktop: 0 },
    platform_breakdown: { ios: 118, android: 0, other: 0 },
    top_devices: [{ model: "iPhone 15 Pro", count: 31 }],
    geographic_distribution: [{ country: "India", count: 71 }],
  };
  const series = {
    days: 3,
    from: "2026-11-01",
    to: "2026-11-03",
    totals: { total: 6, success: 6, failure: 0 },
    series: [
      { date: "2026-11-01", total: 0, success: 0, failure: 0, unique_devices: 0 },
      { date: "2026-11-02", total: 4, success: 4, failure: 0, unique_devices: 3 },
      { date: "2026-11-03", total: 2, success: 2, failure: 0, unique_devices: 2 },
    ],
  };
  const id = build().id;

  it("reports totals, trend and breakdowns for a build found by shortId — and never tester IPs", async () => {
    api = await fakeApi({
      "/api/cli/builds": ok({ builds: [build()], total: 1, page: 1, perPage: 100 }),
      [`/api/builds/${id}/analytics`]: ok({ summary, recent_installs: [{ ip_address: "203.0.113.9" }] }),
      [`/api/builds/${id}/analytics/timeseries`]: ok(series),
    });
    const { text, isError } = await call(await connect(), "betadrop_build_analytics", { build: "aB3xYz", days: 3 });

    expect(isError).toBe(false);
    expect(text).toContain("| **118** | **64** | 2 |");
    expect(text).toContain("Nov 2  ████████████████████ 4");
    expect(text).toContain("iOS 100%");
    expect(text).not.toContain("Android 0%");
    expect(text).toContain("Device not in provisioning profile (2)");
    expect(text).not.toContain("203.0.113.9");
    expect(api.seen.some((r) => r.url.includes("timeseries?days=3"))).toBe(true);
  });

  it("says so when nothing matches", async () => {
    api = await fakeApi({ "/api/cli/builds": ok({ builds: [build()], total: 1, page: 1, perPage: 100 }) });
    const { text, isError } = await call(await connect(), "betadrop_build_analytics", { build: "Nope" });
    expect(isError).toBe(true);
    expect(text).toContain('No build matches "Nope"');
  });

  it("finds a build older than the newest 100", async () => {
    const older = build({ id: "6f1c2a3e-0000-4000-8000-0000000000aa", shortId: "zZ9yX8", name: "OldApp", version: "1.0.0" });
    const newest = Array.from({ length: 100 }, () => build());
    api = await fakeApi({
      "/api/cli/builds": (req) => {
        const page = new URL(req.url ?? "", "http://x").searchParams.get("page");
        return { body: ok({ builds: page === "1" ? newest : [older], total: 101, page: Number(page), perPage: 100 }) };
      },
      [`/api/builds/${older.id}/analytics`]: ok({ summary }),
      [`/api/builds/${older.id}/analytics/timeseries`]: ok(series),
    });
    const { text, isError } = await call(await connect(), "betadrop_build_analytics", { build: "oldapp" });
    expect(isError).toBe(false);
    expect(text).toContain("OldApp 1.0.0");
    expect(api.seen.filter((r) => r.url.startsWith("/api/cli/builds"))).toHaveLength(2);
  });
});

describe("betadrop_list_builds", () => {
  it("shows install counts when the API sends them", async () => {
    api = await fakeApi({ "/api/cli/builds": ok({ builds: [build()], total: 1, page: 1, perPage: 20 }) });
    const { text } = await call(await connect(), "betadrop_list_builds");
    expect(text).toContain("12 installs on 9 devices");
  });

  it("prints each build's full id once, beside its link", async () => {
    const second = "6f1c2a3e-0000-4000-8000-000000000002";
    api = await fakeApi({
      "/api/cli/builds": ok({ builds: [build(), build({ id: second, version: "2.3.0" })], total: 2, page: 1, perPage: 20 }),
    });
    const { text } = await call(await connect(), "betadrop_list_builds");
    expect(text).toContain(`https://betadrop.app/install/?i=aB3xYz · ID ${BUILD_ID}`);
    expect(text.split(second)).toHaveLength(2);
  });

  it("prints it for expired builds too", async () => {
    api = await fakeApi({
      "/api/cli/builds": ok({ builds: [build({ status: "expired", expiresAt: "2026-11-01T00:00:00Z" })], total: 1, page: 1, perPage: 20 }),
    });
    const { text } = await call(await connect(), "betadrop_list_expired_builds");
    expect(text).toContain(`· ID ${BUILD_ID}`);
    expect(api.seen[0].url).toContain("status=expired");
  });
});

describe("betadrop_publish", () => {
  it("leads with a hold and a signing problem, and gives the build ID under the link", async () => {
    await withScratchHome(async (dir) => {
      api = await fakeApi({
        "/api/cli/publish": ok(
          published({
            held_for_review: true,
            signingReach: { code: "no_provisioned_devices", message: NO_DEVICES },
          }),
        ),
      });
      const { text, isError } = await call(await connect(), "betadrop_publish", { filePath: await fakeIpa(dir) });

      expect(isError).toBe(false);
      expect(text.startsWith("⚠️ Held for review. Testers can't install this build until the review clears it.")).toBe(true);
      expect(text.indexOf(`This build will not install on any device. ${NO_DEVICES}`)).toBeLessThan(text.indexOf("Published **"));
      expect(text).toContain("**Install link:** https://betadrop.app/install/?i=aB3xYz");
      expect(text).toContain(`Build ID: ${BUILD_ID}`);
      // Not to be handed out while nobody can install it.
      expect(text).not.toContain("Share the link");
    });
  });

  it("says which standing link followed the build, and how to undo it", async () => {
    await withScratchHome(async (dir) => {
      api = await fakeApi({
        "/api/cli/publish": ok(
          published({
            standingLinksMoved: [
              { id: "c1", slug: "acme-beta", label: null, url: "https://betadrop.app/install/?i=acme-beta", previousBuildId: "prev-1" },
            ],
          }),
        ),
      });
      const { text } = await call(await connect(), "betadrop_publish", { filePath: await fakeIpa(dir) });
      expect(text).not.toContain("⚠️");
      expect(text).toContain("Share the link with anyone who needs the build.");
      expect(text).toContain("**Standing link acme-beta** follows this app, so it now serves this build: https://betadrop.app/install/?i=acme-beta");
      expect(text).toContain("To undo, point it back at build prev-1.");
    });
  });

  it("reads the same warnings back from an upload that outlived the call", async () => {
    await withScratchHome(async (dir) => {
      await fs.mkdir(path.join(dir, ".betadrop"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".betadrop", "upload_status.json"),
        JSON.stringify({
          status: "success",
          progress: 100,
          result: {
            id: BUILD_ID,
            name: "ShopEase",
            version: "2.4.1",
            platform: "android",
            installUrl: "https://betadrop.app/install/?i=aB3xYz",
            held_for_review: false,
            signer_change: { previous_build_id: "p-1", previous_version: "2.4.0", previous_cert_sha256: "CD".repeat(32), cert_sha256: CERT },
          },
        }),
      );
      const { text } = await call(await connect(), "betadrop_upload_status");
      expect(text.startsWith("⚠️ Signed with a different key from v2.4.0.")).toBe(true);
      expect(text).toContain(`Build ID: ${BUILD_ID}`);
    });
  });

  it("does not send a build again after a 5xx: the API may have stored it", async () => {
    await withScratchHome(async (dir) => {
      api = await fakeApi({ "/api/cli/publish": () => ({ status: 502, body: { success: false } }) });
      const { text, isError } = await call(await connect(), "betadrop_publish", { filePath: await fakeIpa(dir) });
      expect(isError).toBe(true);
      expect(text).toContain("HTTP 502");
      expect(api.seen.filter((r) => r.url === "/api/cli/publish")).toHaveLength(1);
    });
  });

  it("sends it again when the connection dropped before the whole file went out", async () => {
    await withScratchHome(async (dir) => {
      let attempts = 0;
      const server = await rawServer((req, res) => {
        attempts++;
        // The first upload is cut off as soon as it starts, so the API cannot have all of it.
        if (attempts === 1) return void req.socket.destroy();
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(ok(published())));
        });
      });
      try {
        const { text, isError } = await call(await connect(), "betadrop_publish", {
          filePath: await fakeIpa(dir, 16 * 1024 * 1024),
        });
        expect(isError).toBe(false);
        expect(text).toContain("Published **ShopEase 2.4.1**");
        expect(attempts).toBe(2);
      } finally {
        await server.close();
      }
    });
  }, 15_000);
});

describe("betadrop_login and betadrop_logout", () => {
  it("checks the token on the new server, and keeps the CLI's guest device id", async () => {
    await withScratchHome(async (dir) => {
      const file = path.join(dir, ".config", "betadrop", "config.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      // The old server is a closed port: a check sent there fails.
      await fs.writeFile(file, JSON.stringify({ apiUrl: "http://127.0.0.1:9", token: "bd_live_old", guestDeviceId: "g-1" }));
      api = await fakeApi({
        "/api/cli/whoami": whoami,
        "/api/cli/logout": () => ({ status: 500, body: { success: false, error: "Server error" } }),
      });
      // The stored and the given URL decide here, and the token is the stored one.
      delete process.env.BETADROP_API_URL;
      delete process.env.BETADROP_TOKEN;
      const client = await connect();

      const login = await call(client, "betadrop_login", { token: "bd_live_new", apiUrl: `${api.url}/` });
      expect(login.isError).toBe(false);
      expect(api.seen[0]).toMatchObject({ url: "/api/cli/whoami", auth: "Bearer bd_live_new" });
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
        apiUrl: api.url,
        token: "bd_live_new",
        guestDeviceId: "g-1",
      });

      const logout = await call(client, "betadrop_logout");
      expect(logout.text).toContain("Could not revoke the token on BetaDrop. Server error.");
      expect(logout.text).not.toContain("BetaDrop revoked");
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ apiUrl: api.url, guestDeviceId: "g-1" });
    });
  });
});

describe("betadrop_token_delete", () => {
  it("encodes the token id into the path", async () => {
    api = await fakeApi({ "/api/cli/tokens/a%2Fb": ok(null) });
    const { isError } = await call(await connect(), "betadrop_token_delete", { tokenId: "a/b" });
    expect(isError).toBe(false);
    expect(api.seen[0]).toMatchObject({ method: "DELETE", url: "/api/cli/tokens/a%2Fb" });
  });
});

describe("remote publishing", () => {
  const done = {
    id: "u-1",
    kind: "url",
    status: "done",
    error: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    build: {
      id: "b-1",
      shortId: "aB3xYz",
      url: "https://betadrop.app/install/?i=aB3xYz",
      platform: "android",
      meta: { name: "ShopEase", version: "2.4.1" },
    },
  };

  it("creates an upload link and passes the options through", async () => {
    let sent: unknown;
    api = await fakeApi({
      "/api/cli/upload-links": (req) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => (sent = JSON.parse(raw)));
        return {
          status: 201,
          body: ok({ id: "u-9", url: "https://betadrop.app/u/#bdu_secret", expiresAt: "x", expiresInMinutes: 30 }),
        };
      },
    });
    const { text, isError } = await call(await connect(true), "betadrop_create_upload_link", { notes: "From chat", expiryDays: 7 });
    expect(isError).toBe(false);
    expect(text).toContain("https://betadrop.app/u/#bdu_secret");
    expect(text).toContain("expires in 30 minutes");
    expect(text).toContain("Upload ID: u-9");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toMatchObject({ notes: "From chat", expiryDays: 7 });
  });

  it("publishes from a URL and waits for the install link", async () => {
    let polls = 0;
    api = await fakeApi({
      "/api/cli/publish-url": { success: true, data: { id: "u-1", status: "uploading" } },
      "/api/cli/remote-uploads/u-1": () => {
        polls++;
        return { body: ok(polls < 2 ? { ...done, status: "uploading", build: null } : done) };
      },
    });
    const { text, isError } = await call(await connect(true), "betadrop_publish_from_url", {
      url: "https://github.com/me/app/releases/download/v2/app.apk",
    });
    expect(isError).toBe(false);
    expect(text).toContain("✅ Published **ShopEase 2.4.1** (Android)");
    expect(text).toContain("https://betadrop.app/install/?i=aB3xYz");
    expect(text).toContain("Build ID: b-1");
    expect(text).toContain("Upload ID: u-1");
    expect(text).toContain("Testers open the link on their phone to install.");
    expect(text).not.toContain("⚠️");
    expect(polls).toBe(2);
  }, 15_000);

  it("puts a hold and Android's warnings above the link, and drops the ✅", async () => {
    api = await fakeApi({
      "/api/cli/remote-uploads/u-4": ok({
        ...done,
        id: "u-4",
        build: {
          ...done.build,
          // Re-read by the API on every check, so a hold placed after the publish shows here.
          held_for_review: true,
          android_registration: {
            status: "not_registered",
            package: "com.shop",
            cert_sha256: CERT,
            checked_at: "2026-11-23T10:00:00Z",
            all_sources_from: "2027-03-15",
          },
          signer_change: { previous_build_id: "p-1", previous_version: "2.4.0 (40)", previous_cert_sha256: "CD".repeat(32), cert_sha256: CERT },
        },
      }),
    });
    const { text } = await call(await connect(true), "betadrop_check_upload", { id: "u-4" });
    const link = text.indexOf("Published **ShopEase 2.4.1**");

    expect(text.startsWith("⚠️ Held for review.")).toBe(true);
    for (const warning of [
      "From 15 March 2027, Android will block installs of unregistered apps, including from links like this one.",
      `What to do: https://betadrop.app/android-verification-checker/?package=com.shop&sha256=${CERT}`,
      'Signed with a different key from v2.4.0 (40). Testers who installed an earlier build will see "App not installed"',
    ]) {
      expect(text, warning).toContain(warning);
      expect(text.indexOf(warning), warning).toBeLessThan(link);
    }
    expect(text).not.toContain("✅");
    expect(text).not.toContain("Testers open the link");
    expect(text).toContain("Build ID: b-1");
  });

  it("warns when an iOS build from a URL cannot install anywhere", async () => {
    api = await fakeApi({
      "/api/cli/publish-url": ok({ id: "u-5", status: "uploading" }),
      "/api/cli/remote-uploads/u-5": ok({
        ...done,
        id: "u-5",
        build: { ...done.build, platform: "ios", signingReach: { code: "no_provisioned_devices", message: NO_DEVICES } },
      }),
    });
    const { text } = await call(await connect(true), "betadrop_publish_from_url", { url: "https://example.com/app.ipa" });
    expect(text.startsWith(`⚠️ This build will not install on any device. ${NO_DEVICES}`)).toBe(true);
    expect(text).toContain("Published **ShopEase 2.4.1** (iOS)");
    expect(text).not.toContain("✅");
    expect(text).toContain("Upload ID: u-5");
  }, 15_000);

  it("hands back the upload ID once its 40 seconds are spent", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() });
    try {
      let polls = 0;
      api = await fakeApi({
        "/api/cli/publish-url": ok({ id: "u-7", status: "uploading" }),
        "/api/cli/remote-uploads/u-7": () => {
          polls++;
          // A slow download: 20 seconds go by between checks.
          vi.setSystemTime(Date.now() + 20_000);
          return { body: ok({ ...done, id: "u-7", status: "uploading", build: null }) };
        },
      });
      const { text, isError } = await call(await connect(true), "betadrop_publish_from_url", { url: "https://example.com/big.apk" });
      expect(isError).toBe(false);
      expect(text).toContain("Call betadrop_check_upload with id u-7");
      // Checks at about 2s and 24s; one more would end past 40s. The old 60s wait made a third.
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("does not wait on a status check that hangs past the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() });
    const server = await rawServer((req, res) => {
      // The status check never answers, like an API stuck behind nginx.
      if (req.url !== "/api/cli/publish-url") return;
      // Starting the publish took most of the budget.
      vi.setSystemTime(Date.now() + 35_000);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok({ id: "u-8", status: "uploading" })));
    });
    try {
      const started = performance.now();
      const { text, isError } = await call(await connect(true), "betadrop_publish_from_url", { url: "https://example.com/big.apk" });
      expect(isError).toBe(false);
      expect(text).toContain("Call betadrop_check_upload with id u-8");
      // Well inside apiFetch's own 30s timeout, which the call used to sit out.
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  }, 20_000);

  it("reports why an upload failed, and that a link can be retried", async () => {
    api = await fakeApi({
      "/api/cli/remote-uploads/u-2": ok({ ...done, id: "u-2", kind: "link", status: "failed", error: "Not an APK or IPA.", build: null }),
    });
    const { text } = await call(await connect(true), "betadrop_check_upload", { id: "u-2" });
    expect(text).toContain("not published: Not an APK or IPA.");
    expect(text).toContain("same upload link still works");
  });

  it("says a link is still waiting for its file", async () => {
    api = await fakeApi({
      "/api/cli/remote-uploads/u-3": ok({ ...done, id: "u-3", kind: "link", status: "pending", build: null }),
    });
    const { text } = await call(await connect(true), "betadrop_check_upload", { id: "u-3" });
    expect(text).toContain("has not been used yet");
  });
});
