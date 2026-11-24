import { Server, type CallToolResult } from "@modelcontextprotocol/server";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools/index.js";
import type { ProgressReporter } from "./tools/types.js";
import { LOCAL_ONLY_TOOLS } from "./tools/local.js";

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
      return errorResult(
        name === "betadrop_publish"
          ? "Files on this computer cannot reach BetaDrop from here. Use betadrop_create_upload_link " +
              "(the user drops the file in a browser) or betadrop_publish_from_url (for a public link)."
          : `${name} needs files on your own machine, so it is only available ` +
              "in the local server: claude mcp add betadrop -- npx -y @betadrop/mcp",
      );
    }
    const handler = TOOL_HANDLERS[name];
    if (!handler) return errorResult(`Tool not found: ${name}`);
    try {
      return await handler(args, { remote, name, progress });
    } catch (error: unknown) {
      return errorResult(error instanceof Error ? error.message : String(error));
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
