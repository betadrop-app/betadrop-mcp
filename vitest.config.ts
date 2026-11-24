import path from "node:path";
import { defineConfig } from "vitest/config";
import { webSrcDir } from "./webSrc.config";

/** Same resolution as tsup.config.ts: `@/` is the website's src, and jszip comes from this package. */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${webSrcDir(__dirname)}/` },
      { find: /^jszip$/, replacement: path.resolve(__dirname, "node_modules/jszip") },
    ],
  },
});
