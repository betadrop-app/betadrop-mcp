import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";
import { build, call, connect, fakeApi, ok } from "./helpers.js";
import type { Route } from "./helpers.js";

const GOOD = "bd_live_good_secret";
const BUILD_ID = build().id;
const ACCOUNT = "9b2f0c44-0000-4000-8000-0000000000ab";
let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
let mcp: http.Server | undefined;
let written: string[] = [];

beforeEach(() => {
  written = [];
  // Everything either stream gets, so a line sent to the wrong one is still caught.
  for (const stream of [process.stderr, process.stdout]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api?.close();
  await new Promise<void>((r) => (mcp ? mcp.close(() => r()) : r()));
  api = undefined;
  mcp = undefined;
});

/** The `mcp_tool_call` lines written so far, parsed, with the raw text beside each. */
function callLines() {
  return written
    .flatMap((w) => w.split("\n"))
    .filter((l) => l.includes("mcp_tool_call"))
    .map((raw) => ({ raw, line: JSON.parse(raw) as Record<string, unknown> }));
}

async function start(routes: Record<string, Route | object> = {}) {
  delete process.env.BETADROP_TOKEN;
  api = await fakeApi({
    ...routes,
    "/api/cli/whoami": (req) =>
      req.headers.authorization === `Bearer ${GOOD}`
        ? { body: ok({ user: { id: ACCOUNT, email: "dev@example.com", role: "user" }, token: null }) }
        : { status: 401, body: { success: false } },
  });
  mcp = createHttpServer(() => createServer(true), { publicUrl: "https://api.example.test" });
  await new Promise<void>((r) => mcp!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
}

function rpc(base: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${GOOD}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } };
const PROTO = { "MCP-Protocol-Version": "2025-06-18" };

describe("tool-call log on the hosted connector", () => {
  it("writes one line per call with the tool, outcome, time, account, client and protocol, and nothing else", async () => {
    const base = await start({
      [`/api/builds/${BUILD_ID}/share-links`]: ok([{ id: "link-main", link_type: "beta_tester", short_id: "aB3xYz", label: null }]),
      "/api/share-links/link-main/password": ok({ has_password: true }),
    });
    await rpc(base, "initialize", INIT);
    await rpc(
      base,
      "tools/call",
      { name: "betadrop_update_link", arguments: { buildId: BUILD_ID, password: "hunter22-secret" } },
      PROTO,
    );

    const lines = callLines();
    expect(lines).toHaveLength(1);
    const [{ raw, line }] = lines;
    expect(Object.keys(line)).toEqual(["evt", "tool", "ok", "ms", "user", "client", "proto"]);
    expect(line).toMatchObject({
      evt: "mcp_tool_call",
      tool: "betadrop_update_link",
      ok: true,
      user: ACCOUNT,
      client: "claude-ai",
      proto: "2025-06-18",
    });
    expect(typeof line.ms).toBe("number");
    // No argument, token, link or result reaches the line.
    for (const secret of ["hunter22-secret", BUILD_ID, GOOD, "aB3xYz", "install", "password", "dev@example.com"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("logs a failed call with the error's class and the API's status, never its message", async () => {
    const base = await start({
      [`/api/builds/${BUILD_ID}/restore`]: () => ({
        status: 402,
        body: { success: false, error: "Restoring ShopEase-private-name needs 120 MB" },
      }),
    });
    const res = (await rpc(base, "tools/call", { name: "betadrop_restore_build", arguments: { buildId: BUILD_ID } }, PROTO)) as {
      result: { isError?: boolean };
    };
    expect(res.result.isError).toBe(true);

    const [{ raw, line }] = callLines();
    expect(line).toMatchObject({ tool: "betadrop_restore_build", ok: false, error: "CliError", status: 402, user: ACCOUNT });
    expect(raw).not.toContain("ShopEase-private-name");
    expect(raw).not.toContain(BUILD_ID);
  });

  it("logs an unknown tool without the name the client sent, and a local-only tool by name", async () => {
    const base = await start();
    await rpc(base, "tools/call", { name: "betadrop_leak_user@example.com", arguments: {} }, PROTO);
    await rpc(base, "tools/call", { name: "betadrop_inspect", arguments: { filePath: "/Users/me/Secret.ipa" } }, PROTO);

    const lines = callLines();
    expect(lines.map((l) => l.line)).toMatchObject([
      { tool: "(unknown)", ok: false, error: "unknown_tool" },
      { tool: "betadrop_inspect", ok: false, error: "local_only" },
    ]);
    expect(lines.map((l) => l.raw).join("")).not.toMatch(/example\.com|Secret\.ipa/);
  });

  it("drops a client name that looks like an email address", async () => {
    const base = await start({ "/api/cli/builds": ok({ builds: [], total: 0, page: 1, perPage: 20 }) });
    await rpc(base, "initialize", { ...INIT, clientInfo: { name: "sam@example.com", version: "1" } });
    await rpc(base, "tools/call", { name: "betadrop_list_builds", arguments: {} }, PROTO);
    const [{ raw, line }] = callLines();
    expect(line.client).toBeNull();
    expect(raw).not.toContain("example.com");
  });

  it("names a 2026-07-28 client from the request's own envelope", async () => {
    const base = await start({ "/api/cli/builds": ok({ builds: [], total: 0, page: 1, perPage: 20 }) });
    const client = new Client({ name: "cursor-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
      }),
    );
    try {
      await client.callTool({ name: "betadrop_list_builds", arguments: {} });
    } finally {
      await client.close();
    }
    const [{ line }] = callLines();
    expect(line).toMatchObject({ tool: "betadrop_list_builds", ok: true, user: ACCOUNT, client: "cursor-test", proto: "2026-07-28" });
  });
});

describe("tool-call log over stdio", () => {
  it("writes nothing, for local or remote tool sets", async () => {
    process.env.BETADROP_TOKEN = "bd_live_test";
    api = await fakeApi({ "/api/cli/builds": ok({ builds: [build()], total: 1, page: 1, perPage: 20 }) });
    for (const remote of [false, true]) {
      const client = await connect(remote);
      await call(client, "betadrop_list_builds");
      await call(client, "betadrop_nope");
      await client.close();
    }
    expect(written.join("")).not.toContain("mcp_tool_call");
  });
});
