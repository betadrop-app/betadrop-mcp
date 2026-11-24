import { Server, type CallToolResult } from "@modelcontextprotocol/server";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools/index.js";
import type { ProgressReporter } from "./tools/types.js";
import { LOCAL_ONLY_TOOLS } from "./tools/local.js";
import { errorClass, logToolCall } from "./lib/callLog.js";
import { CliError } from "./lib/errors.js";

export { LOCAL_ONLY_TOOLS };

// Injected at build time by tsup from package.json — single source of truth. Tests run the source
// directly, where it is not defined.
declare const __MCP_VERSION__: string;
export const VERSION = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : "0.0.0-dev";


/**
 * Sent in the `initialize` result; clients such as Claude put it in the model's context, so this
 * is how the assistant knows to open with an overview instead of a bare "Hi! How can I help?".
 */
const SERVER_INSTRUCTIONS = `BetaDrop distributes iOS (.ipa) and Android (.apk) beta builds through over-the-air install links.

betadrop_welcome gives an overview of the user's account, latest builds and what this connector can do, for when they ask what BetaDrop can do or are unsure where to start with it. Its table and grouped suggestions read best shown as they are, ending with one concrete next step based on their builds.

Publishing a build: betadrop_publish (local server only) takes a file path. A file attached in chat does not reach BetaDrop, so betadrop_create_upload_link gives the user a link to drop the file on, and betadrop_publish_from_url takes a build that is already online. betadrop_check_upload reports the install link.

Install links are most useful as full clickable URLs, and build lists as a compact table. Users describe what they want in their own words rather than naming tools.`;

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** A server with every tool registered; `remote` drops the {@link LOCAL_ONLY_TOOLS}. */
export function createServer(remote = false): Server {
  const server = new Server(
    {
      name: "betadrop",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: remote ? TOOL_DEFINITIONS.filter((t) => !LOCAL_ONLY_TOOLS.has(t.name)) : TOOL_DEFINITIONS,
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    // One log line per call on the hosted connector, and none over stdio (see lib/callLog.ts). Who
    // the client is comes from this request's own envelope on 2026-07-28, else from the session.
    const started = performance.now();
    const envelope = (ctx.mcpReq.envelope ?? {}) as {
      "io.modelcontextprotocol/clientInfo"?: { name?: string };
      "io.modelcontextprotocol/protocolVersion"?: string;
    };
    const logged = (tool: string, result: CallToolResult, thrown?: unknown, reason?: string): CallToolResult => {
      logToolCall({
        tool,
        ok: !result.isError,
        ms: performance.now() - started,
        error: reason ?? (thrown === undefined ? undefined : errorClass(thrown)),
        status: thrown instanceof CliError ? thrown.status : undefined,
        // Both only labels; `logToolCall` drops anything that does not look like one.
        client: envelope["io.modelcontextprotocol/clientInfo"]?.name ?? server.getClientVersion()?.name,
        proto: envelope["io.modelcontextprotocol/protocolVersion"] ?? server.getNegotiatedProtocolVersion(),
      });
      return result;
    };
    // Progress goes only to a client that asked for it with a progress token, and only while the
    // call is in flight: `notifications/progress` belongs to its request, and a publish that hands
    // its upload to the background keeps reporting after the call has answered. (Upload progress
    // used to go out as a log message, which a server that never declared logging may not send,
    // so it never arrived.)
    const progressToken = ctx.mcpReq._meta?.progressToken;
    let inFlight = true;
    const progress: ProgressReporter | undefined =
      progressToken === undefined
        ? undefined
        : (done, total, message) => {
            if (!inFlight) return;
            void ctx.mcpReq
              .notify({
                method: "notifications/progress",
                params: { progressToken, progress: done, ...(total ? { total } : {}), message },
              })
              .catch(() => {});
          };
    if (remote && LOCAL_ONLY_TOOLS.has(name)) {
      return logged(
        name,
        errorResult(
          name === "betadrop_publish"
            ? "Files on this computer cannot reach BetaDrop from here. Use betadrop_create_upload_link " +
                "(the user drops the file in a browser) or betadrop_publish_from_url (for a public link)."
            : `${name} needs files on your own machine, so it is only available ` +
                "in the local server: claude mcp add betadrop -- npx -y @betadrop/mcp",
        ),
        undefined,
        "local_only",
      );
    }
    // Own keys only, so a name such as "toString" is unknown rather than Object.prototype's.
    const handler = Object.hasOwn(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : undefined;
    // Logged as "(unknown)": the name is whatever the client sent, so it is not ours to record.
    if (!handler) return logged("(unknown)", errorResult(`Tool not found: ${name}`), undefined, "unknown_tool");
    try {
      return logged(name, await handler(args, { remote, name, progress }));
    } catch (error: unknown) {
      return logged(name, errorResult(error instanceof Error ? error.message : String(error)), error);
    } finally {
      inFlight = false;
    }
  });

  // Handle server-level errors (e.g. malformed JSON-RPC from the client).
  server.onerror = (err) => {
    process.stderr.write(`[betadrop-mcp] Server error: ${err.message}\n`);
  };

  return server;
}
