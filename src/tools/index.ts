import type { Tool } from "@modelcontextprotocol/server";
import type { ToolHandler, ToolModule } from "./types.js";
import { TOOL_ANNOTATIONS } from "./annotations.js";
import { tools as start } from "./start.js";
import { tools as auth } from "./auth.js";
import { tools as builds } from "./builds.js";
import { tools as remote } from "./remote.js";
import { tools as analytics } from "./analytics.js";
import { tools as checks } from "./checks.js";
import { tools as tokens } from "./tokens.js";
import { tools as links } from "./links.js";
import { tools as devices } from "./devices.js";
import { tools as webhooks } from "./webhooks.js";
import { tools as help } from "./help.js";

/** Every area, in the order `tools/list` shows them. */
const MODULES: ToolModule[] = [start, auth, builds, remote, analytics, checks, tokens, links, devices, webhooks, help];

export const TOOL_DEFINITIONS: Tool[] = MODULES.flatMap((m) => m.definitions).map((t) => ({
  ...t,
  annotations: { ...TOOL_ANNOTATIONS[t.name], ...t.annotations },
}));

export const TOOL_HANDLERS: Record<string, ToolHandler> = Object.assign({}, ...MODULES.map((m) => m.handlers));
