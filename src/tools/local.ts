/**
 * Tools that read or write the machine the server runs on: the local build file, the shared CLI
 * config, the upload status file. Over stdio that machine is the user's; over HTTP it is ours, so
 * the remote connector neither lists nor runs them. Its own module, so `server.ts` and `help.ts`
 * can both read it without importing each other.
 */
export const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "betadrop_login",
  "betadrop_logout",
  "betadrop_publish",
  "betadrop_upload_status",
  "betadrop_inspect",
  "betadrop_convert_aab",
  "betadrop_app_icons",
]);
