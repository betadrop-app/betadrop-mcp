import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where the website's source is, for the `@/` imports (the file checkers, the AAB converter and
 * the icon and plist logic are the website's own code, imported rather than copied). In the
 * monorepo it is `web/src`, beside this package. The public mirror (github.com/betadrop-app/
 * betadrop-mcp) has no monorepo around it, so `scripts/sync-public-mirrors.sh` copies the files
 * this package uses into `web-src/` there, at the same paths. tsconfig.json lists both.
 */
export function webSrcDir(root: string): string {
  const mirrored = path.resolve(root, "web-src");
  return existsSync(mirrored) ? mirrored : path.resolve(root, "../src");
}
