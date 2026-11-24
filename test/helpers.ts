import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";

export type Route = (req: http.IncomingMessage) => { status?: number; body: unknown } | undefined;

/** A stand-in for the BetaDrop API: answers from `routes`, records every request it saw. */
export async function fakeApi(routes: Record<string, Route | object>) {
  const seen: Array<{ method: string; url: string; auth: string | undefined; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "GET", url: req.url ?? "", auth: req.headers.authorization, headers: req.headers });
    const path = (req.url ?? "").split("?")[0];
    const route = routes[path];
    const answer = typeof route === "function" ? (route as Route)(req) : route === undefined ? undefined : { body: route };
    if (!answer) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, error: "not found" }));
    }
    res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BETADROP_API_URL = url;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A connected MCP client over an in-memory transport. */
export async function connect(remote = false) {
  const server = createServer(remote);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

/** Call a tool and return its text and error flag. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return { text: content.map((c) => c.text).join("\n"), isError: res.isError === true };
}

export const ok = (data: unknown) => ({ success: true, data });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export function build(over: Partial<Record<string, unknown>> & { name?: string; version?: string } = {}) {
  const { name = "ShopEase", version = "2.4.0", ...rest } = over;
  return {
    id: "6f1c2a3e-0000-4000-8000-000000000001",
    platform: "ios",
    fileSize: 10_485_760,
    shortId: "aB3xYz",
    status: "active",
    createdAt: daysAgo(1),
    expiresAt: null,
    installUrl: "https://betadrop.app/install/?i=aB3xYz",
    downloads: 12,
    uniqueDevices: 9,
    meta: { name, version, package: "com.shop" },
    ...rest,
  };
}

export const whoami = ok({ user: { id: "u1", email: "dev@example.com", role: "user" }, token: null });
