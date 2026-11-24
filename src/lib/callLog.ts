import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One line per `tools/call` on the hosted connector, for knowing which tools are used, by how many
 * accounts and from which clients, and which ones fail. Written to stderr, where journald keeps it:
 *
 *   journalctl -u betadrop-mcp.service --since today | grep mcp_tool_call
 *   journalctl -u betadrop-mcp.service -o cat | grep '"evt":"mcp_tool_call"' | jq -r .tool | sort | uniq -c
 *
 * {"evt":"mcp_tool_call","tool":"betadrop_list_builds","ok":true,"ms":123,"user":"<account id>","client":"claude-ai","proto":"2025-06-18"}
 *
 * A failure adds `"error"` (the error's class, such as `CliError`, or `tool_error` for a reply the
 * tool marked as an error, `unknown_tool`, `local_only`) and `"status"` (the API's HTTP status) when
 * there is one. Never the arguments, the token, file names, URLs, results or error text: an error
 * message can quote what the user typed.
 *
 * HTTP only. The context below is set by `http.ts` around each request and by nothing else, so the
 * npm package over stdio writes no such line: it runs on the user's own machine and does not report
 * on them.
 */
export interface CallLogContext {
  /** The account the bearer token belongs to, from the token check (`/api/cli/whoami`). */
  user?: string;
  /** `clientInfo.name`, when this request or the client's `initialize` named it. */
  client?: string;
  /** The protocol version this request was sent for, when known. */
  proto?: string;
}

const store = new AsyncLocalStorage<CallLogContext>();

/** Run `fn` with tool calls inside it logged against `ctx`. */
export function withCallLog<T>(ctx: CallLogContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * A client-supplied label, kept only while it looks like an app name or a version: short, plain
 * characters, and no `@`, so an email address sent as a client name is dropped rather than logged.
 */
export function cleanLabel(value: unknown, max = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && v.length <= max && /^[\w.\-/:+ ()]+$/.test(v) ? v : undefined;
}

export interface ToolCallOutcome {
  /** The tool's name, or `(unknown)` for a name that is not one of ours. */
  tool: string;
  ok: boolean;
  ms: number;
  /** The failure's class; see the module note. */
  error?: string;
  /** The API's HTTP status behind the failure, when there was one. */
  status?: number;
  /** From this request's own envelope, which wins over what the HTTP layer knew. */
  client?: string;
  proto?: string;
}

/** Write the line for one call. Outside an HTTP request (stdio, tests of the server alone) it does nothing. */
export function logToolCall(outcome: ToolCallOutcome): void {
  const ctx = store.getStore();
  if (!ctx) return;
  const line: Record<string, unknown> = {
    evt: "mcp_tool_call",
    tool: outcome.tool,
    ok: outcome.ok,
    ms: Math.round(outcome.ms),
    user: ctx.user ?? null,
    client: cleanLabel(outcome.client) ?? ctx.client ?? null,
    proto: cleanLabel(outcome.proto, 32) ?? ctx.proto ?? null,
  };
  if (!outcome.ok) {
    line.error = outcome.error ?? "tool_error";
    if (outcome.status !== undefined) line.status = outcome.status;
  }
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/** The class of a thrown error, never its message. */
export function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z][\w]{0,39}$/.test(name) ? name : "Error";
}
