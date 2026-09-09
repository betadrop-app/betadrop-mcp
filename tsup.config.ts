import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node18",
  clean: true,
  minify: true,
  // Bake the package version in at build time so the server reports a single
  // source of truth (package.json) and never needs a runtime file read.
  define: { __MCP_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node" },
  shims: true,
  // Bundle the SDK so there's no node_modules lookup at startup.
  noExternal: [/@modelcontextprotocol\/.*/],
});
