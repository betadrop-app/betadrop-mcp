import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, VERSION } from "./server.js";

// ─── Process-level error handlers ────────────────────────────────────────────
// MCP stdio servers must NEVER write unexpected output to stdout (it corrupts
// JSON-RPC framing). Route all diagnostics to stderr so clients can display them.

process.on("uncaughtException", (err) => {
  process.stderr.write(`[betadrop-mcp] Uncaught exception: ${err.message}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});

/** `--http`: the remote connector, one process serving every connected user. */
const HTTP_MODE = process.argv.includes("--http");

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[betadrop-mcp] Unhandled rejection: ${msg}\n`);
  if (reason instanceof Error && reason.stack) {
    process.stderr.write(`${reason.stack}\n`);
  }
  // Over stdio the process belongs to one user and exiting is the honest signal. Over HTTP a stray
  // rejection belongs to one request, and exiting would drop every other user's call with it. An
  // uncaught EXCEPTION still exits in both modes: after one, Node's state cannot be trusted.
  if (!HTTP_MODE) process.exit(1);
});

// ─── Transport ───────────────────────────────────────────────────────────────

try {
  if (HTTP_MODE) {
    // Loaded only here, so a stdio start never pulls in the HTTP stack.
    const { startHttp } = await import("./http.js");
    await startHttp(() => createServer(true));
  } else {
    // serveStdio, not server.connect(new StdioServerTransport()): the opening exchange picks the
    // protocol era, so 2026-07-28 clients and 2025-era ones are both served from this one factory.
    serveStdio(() => createServer(), {
      onerror: (err) => process.stderr.write(`[betadrop-mcp] stdio error: ${err.message}\n`),
    });
  }
  process.stderr.write(`[betadrop-mcp] Server started successfully (v${VERSION})\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[betadrop-mcp] Failed to start: ${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}
