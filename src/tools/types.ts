import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

/**
 * Reports how far a long call has got: `done` of `total` (total unknown → undefined), with a short
 * line a client can show. A no-op unless the client asked for progress on this call.
 */
export type ProgressReporter = (done: number, total: number | undefined, message: string) => void;

/** What a handler knows about the call beyond its arguments. */
export interface ToolContext {
  /** Serving over HTTP (the remote connector) rather than stdio. */
  remote: boolean;
  /** The tool name, for handlers registered under more than one. */
  name: string;
  /** Present only when the client sent a progress token with this call. */
  progress?: ProgressReporter;
}

export type ToolHandler = (
  args: Record<string, unknown> | undefined,
  ctx: ToolContext,
) => Promise<CallToolResult>;

/** One area's tools: what `tools/list` shows, and what runs on `tools/call`. */
export interface ToolModule {
  definitions: Tool[];
  handlers: Record<string, ToolHandler>;
}
