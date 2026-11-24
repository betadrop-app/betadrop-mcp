import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { clientAddress, createHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";
import { fakeApi, ok, whoami } from "./helpers.js";
import type { Route } from "./helpers.js";

const GOOD = "bd_live_good";
const OTHER = "bd_live_other";
let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
let mcp: http.Server | undefined;

afterEach(async () => {
  await api?.close();
  await new Promise<void>((r) => (mcp ? mcp.close(() => r()) : r()));
  api = undefined;
  mcp = undefined;
});

/** The connector against a fake API that accepts only `GOOD` and `OTHER`, plus any extra `routes`. */
async function start(rateLimitPerMinute = 120, routes: Record<string, Route | object> = {}) {
  delete process.env.BETADROP_TOKEN;
  api = await fakeApi({
    ...routes,
    "/api/cli/whoami": (req) =>
      [`Bearer ${GOOD}`, `Bearer ${OTHER}`].includes(req.headers.authorization ?? "")
        ? { body: whoami }
        : { status: 401, body: { success: false } },
  });
  mcp = createHttpServer(() => createServer(true), { publicUrl: "https://api.example.test", rateLimitPerMinute });
  await new Promise<void>((r) => mcp!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
}

function rpc(base: string, token: string | null, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } };

describe("remote connector over HTTP", () => {
  it("answers no token with a 401 that points at the resource metadata", async () => {
    const base = await start();
    const res = await rpc(base, null, "initialize", INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("refuses a browser origin it does not know, before looking at the token", async () => {
    const base = await start();
    const call = (origin: string) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${GOOD}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }),
      });

    expect((await call("https://evil.example")).status).toBe(403);
    expect((await call("null")).status).toBe(403);
    expect((await call("https://claude.ai")).status).not.toBe(403);
    expect((await call("https://api.example.test")).status).not.toBe(403);
    expect((await call("http://localhost:6274")).status).not.toBe(403);
  });

  it("marks a rejected token invalid_token, so the client signs in again", async () => {
    const base = await start();
    const res = await rpc(base, "bd_live_revoked", "initialize", INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("checks a token once, then trusts it for a while instead of asking on every request", async () => {
    const base = await start();
    await rpc(base, GOOD, "initialize", INIT);
    await rpc(base, GOOD, "tools/list");
    await rpc(base, GOOD, "tools/list");
    expect(api!.seen.filter((r) => r.url === "/api/cli/whoami")).toHaveLength(1);
  });

  it("drops a trusted token the API refuses during a call, so the next request answers 401", async () => {
    delete process.env.BETADROP_TOKEN;
    let revoked = false;
    const refuse = { status: 401, body: { success: false } };
    api = await fakeApi({
      "/api/cli/whoami": () => (revoked ? refuse : { body: whoami }),
      "/api/cli/builds": () => refuse,
    });
    mcp = createHttpServer(() => createServer(true), { publicUrl: "https://api.example.test" });
    await new Promise<void>((r) => mcp!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;

    expect((await rpc(base, GOOD, "tools/list")).status).toBe(200);
    revoked = true;
    // Still trusted, so the request is served, but the tool's own API call is refused at once.
    const call = await rpc(base, GOOD, "tools/call", { name: "betadrop_list_builds", arguments: {} });
    const body = (await call.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
    // That refusal dropped the token: the next request is checked again and gets the 401.
    const next = await rpc(base, GOOD, "tools/list");
    expect(next.status).toBe(401);
    expect(next.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers the API's own 429 on the token check with a 429, not 'unreachable'", async () => {
    delete process.env.BETADROP_TOKEN;
    // An API that throttles everything, the way its per-address limit answers.
    const busy = await (async () => {
      const server = (await import("node:http")).createServer((_req, res) => {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" });
        res.end(JSON.stringify({ success: false, error: "Too many requests" }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return server;
    })();
    try {
      process.env.BETADROP_API_URL = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`;
      mcp = createHttpServer(() => createServer(true), { publicUrl: "https://api.example.test" });
      await new Promise<void>((r) => mcp!.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
      const res = await rpc(base, GOOD, "tools/list");
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("17");
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  it("keeps serving a recently checked token while the API throttles the check", async () => {
    delete process.env.BETADROP_TOKEN;
    let checks = 0;
    api = await fakeApi({
      "/api/cli/whoami": () =>
        ++checks === 1 ? { body: whoami } : { status: 429, body: { success: false, message: "Too Many Attempts." } },
    });
    mcp = createHttpServer(() => createServer(true), { publicUrl: "https://api.example.test", tokenCheckTtlMs: 1 });
    await new Promise<void>((r) => mcp!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;

    expect((await rpc(base, GOOD, "tools/list")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    // The trust window has passed and the check is throttled, but the token passed a moment ago.
    expect((await rpc(base, GOOD, "tools/list")).status).toBe(200);
    expect(checks).toBe(2);
    // A token never seen before gets no such grace.
    expect((await rpc(base, OTHER, "tools/list")).status).toBe(429);
  });

  it("serves a 2026-07-28 client, which skips initialize, as well as a 2025 one", async () => {
    const base = await start();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
      }),
    );
    try {
      expect(client.getProtocolEra()).toBe("modern");
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("betadrop_whoami");
      expect(names).not.toContain("betadrop_publish");
      const who = await client.callTool({ name: "betadrop_whoami", arguments: {} });
      expect(JSON.stringify(who.content)).toContain("dev@example.com");
    } finally {
      await client.close();
    }
  });

  it("serves initialize and the remote tool list with a valid token", async () => {
    const base = await start();
    const init = await rpc(base, GOOD, "initialize", INIT);
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("betadrop");

    const list = (await (await rpc(base, GOOD, "tools/list")).json()) as { result: { tools: unknown[] } };
    expect(list.result.tools).toHaveLength(23);
  });

  it("rate-limits per token with a Retry-After", async () => {
    const base = await start(2);
    expect((await rpc(base, GOOD, "tools/list")).status).toBe(200);
    expect((await rpc(base, GOOD, "tools/list")).status).toBe(200);
    const limited = await rpc(base, GOOD, "tools/list");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different user is unaffected.
    expect((await rpc(base, "bd_live_someone_else", "tools/list")).status).toBe(401);
  });

  it("only serves POST /mcp and a health check", async () => {
    const base = await start();
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });
});

describe("the client address the API is told", () => {
  const CLIENT = "203.0.113.7";
  const FORGED = "1.1.1.1";
  const REFUSAL = `Uploads from your network address (${CLIENT}) are not currently accepted on BetaDrop.`;
  /** `GET /api/cli/remote-uploads/u1`, for a publish the API refused. */
  const refusedUpload = { "/api/cli/remote-uploads/u1": ok({ id: "u1", kind: "url", status: "failed", error: REFUSAL, build: null, expiresAt: "2026-11-05T12:00:00Z" }) };
  const checkUpload = { name: "betadrop_check_upload", arguments: { id: "u1" } };

  /** What each `/mcp` block we ship hands the service for a client also sending forged headers. */
  const THROUGH_NGINX: Array<[string, Record<string, string>]> = [
    [
      "the old server's block, which appends and leaves the rest as sent",
      { "X-Forwarded-For": `${FORGED}, ${CLIENT}`, "CF-Connecting-IP": FORGED, "X-Real-IP": FORGED },
    ],
    ["the new server's block, which overwrites them", { "X-Forwarded-For": CLIENT, "X-Real-IP": CLIENT }],
  ];

  it.each(THROUGH_NGINX)("passes on nginx's address and no forgery, through %s", async (_name, headers) => {
    const base = await start(120, refusedUpload);
    const res = await rpc(base, GOOD, "tools/call", checkUpload, headers);
    expect(res.status).toBe(200);

    // The token check as well as the tool: it is the one API call every request makes.
    expect(api!.seen.map((r) => r.url)).toEqual(["/api/cli/whoami", "/api/cli/remote-uploads/u1"]);
    for (const { headers: sent } of api!.seen) {
      expect(sent["x-forwarded-for"]).toBe(CLIENT);
      // The API ranks this one above X-Forwarded-For, so passing it on would be the whole forgery.
      expect(sent["cf-connecting-ip"]).toBeUndefined();
      expect(sent["x-real-ip"]).toBeUndefined();
    }
  });

  it("carries it on a publish, and reads the API's refusal back", async () => {
    const base = await start(120, { ...refusedUpload, "/api/cli/publish-url": ok({ id: "u1", status: "uploading" }) });
    const res = await rpc(
      base,
      GOOD,
      "tools/call",
      { name: "betadrop_publish_from_url", arguments: { url: "https://example.com/a.apk" } },
      { "X-Forwarded-For": `${FORGED}, ${CLIENT}` },
    );
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0].text).toContain(REFUSAL);

    const publish = api!.seen.find((r) => r.url === "/api/cli/publish-url");
    expect(publish?.headers["x-forwarded-for"]).toBe(CLIENT);
  });

  it("keeps clients apart when their requests overlap", async () => {
    const base = await start(120, refusedUpload);
    const addressOf: Record<string, string> = { [`Bearer ${GOOD}`]: CLIENT, [`Bearer ${OTHER}`]: "198.51.100.4" };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const token = i % 2 ? GOOD : OTHER;
        return rpc(base, token, "tools/call", checkUpload, { "X-Forwarded-For": addressOf[`Bearer ${token}`] });
      }),
    );
    // Every tool call, plus the token checks (fewer than one a request, since a passed check is
    // trusted for a while), each with its own client's address.
    expect(api!.seen.filter((r) => r.url !== "/api/cli/whoami")).toHaveLength(20);
    for (const r of api!.seen) expect(r.headers["x-forwarded-for"]).toBe(addressOf[r.auth ?? ""]);
  });

  it("sends none when nginx gave none, and warns once", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const base = await start();
      await fetch(`${base}/healthz`);
      expect(warn).not.toHaveBeenCalled();
      await rpc(base, GOOD, "tools/list");
      await rpc(base, GOOD, "tools/list");
      expect(warn.mock.calls.filter(([line]) => String(line).includes("no client address"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(api!.seen.length).toBeGreaterThan(0);
    for (const r of api!.seen) expect(r.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("takes the last hop from loopback, and never an earlier one", () => {
    expect(clientAddress("127.0.0.1", `${FORGED}, ${CLIENT}`)).toBe(CLIENT);
    expect(clientAddress("::1", "2001:db8::1")).toBe("2001:db8::1");
    expect(clientAddress("::ffff:127.0.0.1", CLIENT)).toBe(CLIENT);
    expect(clientAddress("127.0.0.1", [FORGED, CLIENT])).toBe(CLIENT);

    expect(clientAddress("127.0.0.1", `${FORGED},`)).toBeUndefined();
    expect(clientAddress("127.0.0.1", `${FORGED}, not-an-address`)).toBeUndefined();
    expect(clientAddress("127.0.0.1", undefined)).toBeUndefined();
    expect(clientAddress(undefined, CLIENT)).toBeUndefined();
  });

  it("does not believe the header from a peer that skipped nginx", () => {
    expect(clientAddress("198.51.100.4", CLIENT)).toBe("198.51.100.4");
    expect(clientAddress("::ffff:198.51.100.4", CLIENT)).toBe("198.51.100.4");
  });

  // Forging depends on nginx writing this header itself. These files are installed by hand, so this
  // catches the repo's copy drifting, not the server's. The new server's is on its own branch for now.
  const NGINX_FILES = [
    "../../../api/deploy/nginx/api.betadrop.app-mcp.conf",
    "../../../api/deploy/new-server/nginx/snippets/betadrop-mcp.conf",
  ].map((file) => fileURLToPath(new URL(file, import.meta.url)));

  it.each(NGINX_FILES.filter((file) => existsSync(file)))("relies on a header nginx writes itself: %s", (file) => {
    const block = /location = \/mcp \{([^}]*)\}/.exec(readFileSync(file, "utf8"))?.[1];
    expect(block).toMatch(/proxy_set_header X-Forwarded-For \$(proxy_add_x_forwarded_for|remote_addr);/);
  });
});
