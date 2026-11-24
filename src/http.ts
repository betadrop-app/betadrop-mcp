import http from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createMcpHandler, isLegacyRequest, type Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { getClientAddress, withClientAddress, withRequestToken } from "./lib/config.js";
import { apiFetchWithToken } from "./lib/api.js";
import { RateLimitedError, UnauthorizedError } from "./lib/errors.js";
import { watchTokenRejection } from "./lib/tokenState.js";
import { cleanLabel, withCallLog } from "./lib/callLog.js";

/**
 * Remote mode: the MCP Streamable HTTP transport, behind nginx. It answers at the connector's own
 * address (https://mcp.betadrop.app, at `/` and at `/mcp`) and at `/mcp` on the API host, where it
 * first lived and where earlier connections still point.
 *
 * Stateless — every POST gets a fresh server, so any instance can answer any request and there is
 * no session map to leak. Both protocol eras are served from this one endpoint: 2026-07-28
 * requests, which carry their protocol version and need no handshake, go to the v2 entry
 * (`createMcpHandler`); 2025-era ones (initialize, then calls) get exactly what they got before
 * v2, a stateless transport answering with one JSON body. The v1 transport answered every
 * 2026-07-28 request with a 400, which Claude met on most connects and had to retry the old way. Auth is the OAuth bearer token the API's `/api/oauth/token`
 * minted, which is an ordinary CLI token: it is forwarded as-is to the `/api/cli/*` routes the
 * stdio server already calls. Without one the reply is a 401 pointing at the protected-resource
 * metadata, which is how an MCP client finds the authorization server (RFC 9728).
 */

const PORT = Number(process.env.MCP_HTTP_PORT || 8790);
const HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
/**
 * The API host's public origin. Sign-in runs there (it is the authorization server), and the
 * connector still answers at `/mcp` under it.
 */
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "https://api.betadrop.app").replace(/\/$/, "");
/** The connector's own address, the one we publish. It answers at its root and at `/mcp`. */
const CONNECTOR_URL = (process.env.MCP_CONNECTOR_URL || "https://mcp.betadrop.app").replace(/\/$/, "");
const WELL_KNOWN = "/.well-known/oauth-protected-resource";
const MAX_BODY_BYTES = 1024 * 1024;
/** Per-token budget: a burst of this many requests, refilled at the same number per minute. */
const RATE_LIMIT_PER_MINUTE = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE || 120);
/** How long SIGTERM waits for in-flight requests before exiting anyway. */
const SHUTDOWN_GRACE_MS = 10_000;
/**
 * Browser origins allowed to call /mcp, on top of our own. Claude and ChatGPT connect from their
 * servers and send no Origin at all; these cover their web apps and the MCP Inspector on
 * localhost. Extra origins, comma-separated, in MCP_ALLOWED_ORIGINS.
 */
const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"];

export interface HttpOptions {
  publicUrl?: string;
  connectorUrl?: string;
  rateLimitPerMinute?: number;
  allowedOrigins?: string[];
  /** How long a token that passed the check is trusted; see {@link TOKEN_CHECK_TTL_MS}. */
  tokenCheckTtlMs?: number;
}

/**
 * Whether a request's Origin may reach /mcp (the MCP spec's DNS-rebinding guard). No Origin means
 * a server-to-server call, which is how hosted clients connect.
 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:") return true;
  return allowed.has(url.origin);
}

/**
 * The address a request really came from, which the API rate limits, blocklists and records.
 *
 * The rightmost `X-Forwarded-For` hop and nothing else, because that is the one value every `/mcp`
 * block we ship writes itself: `$proxy_add_x_forwarded_for` appends `$remote_addr` to whatever the
 * client sent, and the new server's block overwrites the header with `$remote_addr`. Everything
 * left of it is the client's own. `CF-Connecting-IP` and `X-Real-IP` are not read, because the old
 * server's block does not set them, so what a client sends there arrives here untouched.
 *
 * Headers count only from loopback, as in the API's `throttle_ip`: a peer that is anything else
 * reached this port without going through nginx, so it is the client and its headers are its own.
 * A last hop that is not an address gives none at all; falling back to the hop before it would
 * hand the choice to the client.
 */
export function clientAddress(peer: string | undefined, forwarded: string | string[] | undefined): string | undefined {
  const socket = peer?.replace(/^::ffff:/i, "");
  if (socket !== "::1" && !socket?.startsWith("127.")) return socket;
  const chain = Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "");
  const hop = chain.slice(chain.lastIndexOf(",") + 1).trim();
  return isIP(hop) ? hop : undefined;
}

/**
 * The resources (RFC 9728) the connector serves, one for each address it answers at. A client
 * checks that the metadata it is sent to names exactly the URL it connected to, so each address
 * needs its own. The API host's comes first.
 */
export function connectorResources(publicUrl: string, connectorUrl: string): string[] {
  return [`${publicUrl}/mcp`, connectorUrl, `${connectorUrl}/mcp`];
}

/**
 * The resource a request is for, from the Host it was sent to (nginx passes the client's own) and
 * its path, or undefined when that address is not one of `resources`.
 */
export function resourceFor(resources: readonly string[], host: string | undefined, path: string): string | undefined {
  if (!host) return undefined;
  const want = `${host.toLowerCase().replace(/:(443|80)$/, "")}${path}`;
  return resources.find((r) => {
    const url = new URL(r);
    return `${url.host}${url.pathname}` === want;
  });
}

/** Where a resource's metadata lives: the well-known path goes between its host and its path (RFC 9728, section 3.1). */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}${WELL_KNOWN}${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * The protected-resource metadata for one of the connector's addresses. The API serves the same
 * document for its own host (`protected_resource_metadata` in api/crates/api/src/handlers/oauth.rs);
 * this one names the connector's address instead, so keep the two in step.
 */
export function resourceMetadata(resource: string, authorizationServer: string) {
  return {
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: ["read", "publish"],
    bearer_methods_supported: ["header"],
    resource_name: "BetaDrop",
  };
}

/** sha256(token) — the only form a token is ever kept in, here. */
function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Token bucket per token key. Sized for a person in a chat, not a script: a conversation makes a
 * handful of calls a minute, and a client looping on one token should be slowed before it costs
 * every other user the API's own throttles.
 */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly perMinute: number) {}

  /** Seconds to wait, or 0 when the request may go ahead. */
  take(key: string, now = Date.now()): number {
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (this.buckets.size > 10_000) this.sweep(now);
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return Math.ceil((1 - b.tokens) / rate / 1000);
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return 0;
  }

  /** Drop buckets that have been full long enough to be indistinguishable from new ones. */
  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.at > 60_000) this.buckets.delete(k);
  }
}

/**
 * How long a token that passed the check is trusted before the API is asked again.
 *
 * Checking on every request cost a `/api/cli/whoami` call each time, and the API throttles that
 * route per address (60 a minute). Claude and ChatGPT users all reach us from their provider's few
 * addresses, so they would have shared that one budget, and the overflow surfaced as errors.
 *
 * A revoke still takes effect at once where it matters: every tool call carries the token to the
 * API, which refuses a revoked one, and that refusal drops the token from the cache (see
 * `lib/tokenState.ts`) so the next request answers the 401 that sends the client back to sign in.
 * Only a call that reads nothing from the API, such as listing the tools, can still succeed in
 * the window.
 */
const TOKEN_CHECK_TTL_MS = 30_000;

/**
 * How long a token that passed may still be served when the API can't answer the check: its own
 * 429 (the shared per-address budget ran out) or an outage. Serving it costs nothing a check would
 * have protected, since every tool call still takes the token to the API, which refuses a revoked
 * one there; failing it would turn the API's throttle into an outage for everyone on that address.
 */
const TOKEN_CHECK_GRACE_MS = 5 * 60_000;

/** Tokens that passed the check recently, by token key. */
class TokenChecks {
  private passed = new Map<string, { until: number; at: number; user?: string }>();

  constructor(private readonly ttlMs: number) {}

  /** The token's account (`user` undefined when the check named none), or undefined when it was refused. */
  async valid(token: string, key: string, now = Date.now()): Promise<{ user?: string } | undefined> {
    const seen = this.passed.get(key);
    if (seen && seen.until > now) return { user: seen.user };
    let result: { user?: string } | undefined;
    try {
      result = await tokenOwner(token);
    } catch (err) {
      if (seen && now - seen.at < TOKEN_CHECK_GRACE_MS) return { user: seen.user };
      throw err;
    }
    if (!result) {
      this.passed.delete(key);
    } else if (this.ttlMs > 0) {
      if (this.passed.size > 10_000) this.sweep(now);
      this.passed.set(key, { until: now + this.ttlMs, at: now, user: result.user });
    }
    return result;
  }

  forget(key: string) {
    this.passed.delete(key);
  }

  /** Drop entries past both the trust window and the grace window. */
  private sweep(now: number) {
    for (const [k, { until, at }] of this.passed) if (until <= now && now - at >= TOKEN_CHECK_GRACE_MS) this.passed.delete(k);
  }
}

/**
 * One loopback request to the API, beside the tool's own: the account the token belongs to (kept
 * for the tool-call log), or undefined when the API refuses the token.
 */
async function tokenOwner(token: string): Promise<{ user?: string } | undefined> {
  try {
    const res = await apiFetchWithToken<{ user?: { id?: unknown } }>("/api/cli/whoami", token);
    const id = res.data?.user?.id;
    return { user: typeof id === "string" || typeof id === "number" ? String(id) : undefined };
  } catch (err) {
    if (err instanceof UnauthorizedError) return undefined;
    throw err;
  }
}

/**
 * What a 2025-era client said about itself in `initialize`, by token key. Stateless serving gives
 * every request a fresh server, so a later `tools/call` cannot read it back from the session; the
 * call log looks it up here. Bounded: cleared wholesale past 10,000 tokens.
 */
class ClientNames {
  private byKey = new Map<string, { client?: string; proto?: string }>();

  note(key: string, body: unknown) {
    const msg = body as { method?: unknown; params?: { clientInfo?: { name?: unknown }; protocolVersion?: unknown } } | null;
    if (!msg || typeof msg !== "object" || msg.method !== "initialize") return;
    if (this.byKey.size > 10_000) this.byKey.clear();
    this.byKey.set(key, { client: cleanLabel(msg.params?.clientInfo?.name), proto: cleanLabel(msg.params?.protocolVersion, 32) });
  }

  get(key: string) {
    return this.byKey.get(key);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The HTTP server, not yet listening. Exported for tests. */
export function createHttpServer(createServer: () => Server, options: HttpOptions = {}): http.Server {
  const publicUrl = (options.publicUrl ?? PUBLIC_URL).replace(/\/$/, "");
  const connectorUrl = (options.connectorUrl ?? CONNECTOR_URL).replace(/\/$/, "");
  const resources = connectorResources(publicUrl, connectorUrl);
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? RATE_LIMIT_PER_MINUTE);
  const checks = new TokenChecks(options.tokenCheckTtlMs ?? TOKEN_CHECK_TTL_MS);
  const clientNames = new ClientNames();
  const logError = (err: Error) => process.stderr.write(`[betadrop-mcp] Server error: ${err.message}\n`);
  // Both legs answer with a single JSON body: nothing here streams (no progress over HTTP), and
  // one JSON body passes nginx unchanged. Each runs per request, inside its token and address.
  const modern = toNodeHandler(
    createMcpHandler(() => createServer(), { legacy: "reject", responseMode: "json", onerror: logError }),
    { onerror: logError },
  );
  const legacy = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => {
    const server = createServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  const serve = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) =>
    (await isLegacyRequest(await toWebRequest(req, body), body)) ? legacy(req, res, body) : modern(req, res, body);
  const extraOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const allowedOrigins = new Set(
    [
      new URL(publicUrl).origin,
      new URL(connectorUrl).origin,
      ...(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS),
      ...extraOrigins,
    ].map((o) => o.replace(/\/$/, "")),
  );

  let warnedNoAddress = false;

  const unauthorized = (res: http.ServerResponse, resource: string, error?: "invalid_token") => {
    const params = [`resource_metadata="${resourceMetadataUrl(resource)}"`];
    if (error) params.push(`error="${error}"`);
    sendJson(
      res,
      401,
      { error: error ?? "unauthorized", error_description: "Connect your BetaDrop account to use this server." },
      { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
    );
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    // The metadata for the connector's own address. nginx sends the API host's to the API, which
    // serves its own; an address this server doesn't answer at has none.
    if (path === WELL_KNOWN || path === `${WELL_KNOWN}/mcp`) {
      const resource = resourceFor(resources, req.headers.host, path.slice(WELL_KNOWN.length) || "/");
      if (!resource) return sendJson(res, 404, { error: "not_found" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      }
      return sendJson(res, 200, resourceMetadata(resource, publicUrl), { "Access-Control-Allow-Origin": "*" });
    }
    // `/mcp` answers on any host, as it always has: one that matches none of ours (a local run)
    // gets the API host's resource. `/` answers only at an address whose root is ours.
    const resource =
      path === "/mcp"
        ? (resourceFor(resources, req.headers.host, path) ?? resources[0])
        : path === "/"
          ? resourceFor(resources, req.headers.host, path)
          : undefined;
    if (!resource) {
      return sendJson(res, 404, { error: "not_found" });
    }
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      return sendJson(res, 403, { error: "origin_not_allowed" });
    }
    // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
    }
    // Normal for a local client such as the MCP Inspector. In production it means nginx stopped
    // sending the header, which puts every user back on one address and past the IP blocklist.
    if (!getClientAddress() && !warnedNoAddress) {
      warnedNoAddress = true;
      process.stderr.write("[betadrop-mcp] /mcp request with no client address: is X-Forwarded-For set in nginx?\n");
    }

    const auth = req.headers.authorization ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    if (!token) return unauthorized(res, resource);

    // Before the token check, so a flood of junk tokens cannot turn into a flood of API calls.
    const key = tokenKey(token);
    const wait = limiter.take(key);
    if (wait > 0) {
      return sendJson(
        res,
        429,
        { jsonrpc: "2.0", error: { code: -32000, message: `Too many requests. Try again in ${wait}s.` }, id: null },
        { "Retry-After": String(wait) },
      );
    }
    const passed = await checks.valid(token, key);
    if (!passed) return unauthorized(res, resource, "invalid_token");

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid body";
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message }, id: null });
    }

    // What the tool-call log knows about this caller (lib/callLog.ts). A 2025-era client sends
    // MCP-Protocol-Version on every request after initialize, and named itself in initialize.
    clientNames.note(key, body);
    const known = clientNames.get(key);
    const logContext = {
      user: passed.user,
      client: known?.client,
      proto: cleanLabel(req.headers["mcp-protocol-version"], 32) ?? known?.proto,
    };
    const rejected = await watchTokenRejection(() =>
      withCallLog(logContext, () => withRequestToken(token, () => serve(req, res, body))),
    );
    if (rejected) checks.forget(key);
  };

  return http.createServer((req, res) => {
    // Around everything, not just the tool call: the token check is an API call too, and it is the
    // one every request makes.
    const address = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
    withClientAddress(address, () => handle(req, res)).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[betadrop-mcp] HTTP request failed: ${msg}\n`);
      if (!res.headersSent && err instanceof RateLimitedError) {
        // The API's own throttle, met by the token check: say so, rather than "unreachable".
        sendJson(
          res,
          429,
          { jsonrpc: "2.0", error: { code: -32000, message: err.message }, id: null },
          { "Retry-After": String(err.retryAfter) },
        );
      } else if (!res.headersSent) {
        sendJson(res, 502, { jsonrpc: "2.0", error: { code: -32603, message: "BetaDrop is unreachable." }, id: null });
      } else {
        res.end();
      }
    });
  });
}

export async function startHttp(createServer: () => Server): Promise<void> {
  const httpServer = createHttpServer(createServer);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(PORT, HOST, resolve);
  });
  process.stderr.write(`[betadrop-mcp] Listening on http://${HOST}:${PORT} (public ${CONNECTOR_URL} and ${PUBLIC_URL}/mcp)\n`);

  // A restart (deploy, systemd) stops taking new requests and lets the in-flight ones finish, so a
  // tool call that was mid-answer is not cut off.
  const shutdown = (signal: string) => {
    process.stderr.write(`[betadrop-mcp] ${signal}: draining\n`);
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
