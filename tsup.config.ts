import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import path from "node:path";
import { webSrcDir } from "./webSrc.config";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

/** The website's source: the file checkers and the AAB converter are imported from it, not copied. */
const webSrc = webSrcDir(process.cwd());

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  minify: true,
  // Bake the package version in at build time so the server reports a single
  // source of truth (package.json) and never needs a runtime file read.
  define: { __MCP_VERSION__: JSON.stringify(version) },
  // `require` for the CommonJS packages bundled below (pngjs, jpeg-js, qrcode), which load
  // Node built-ins such as zlib; an ES module has none of its own.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __bdCreateRequire } from "node:module";\nconst require = __bdCreateRequire(import.meta.url);',
  },
  shims: true,
  // Bundle the SDK, and the pure-JS package the web checkers use (jszip) and the generators' (pngjs, jpeg-js, qrcode), so there's no
  // node_modules lookup at startup and `npx @betadrop/mcp` installs nothing else.
  noExternal: [/@modelcontextprotocol\/.*/, "jszip", "pngjs", "jpeg-js", "qrcode"],
  esbuildOptions(options) {
    // The web libs import each other as `@/lib/...` (web/tsconfig.json's paths).
    options.alias = { ...options.alias, "@": webSrc };
    // A package a web lib imports resolves from this package's own node_modules too, so the build
    // does not depend on the website's install.
    options.nodePaths = [...(options.nodePaths ?? []), path.resolve("node_modules")];
  },
});
