import { createReadStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { CliError, UnauthorizedError } from "./errors.js";
import { httpAgent, httpsAgent } from "./api.js";
import type { ApiResponse, PublishResponse } from "../types.js";

export interface UploadFields {
  name?: string;
  version?: string;
  build_number?: string;
  bundle_id?: string;
  notes?: string;
  expiry_type?: string;
  expiry_time_days?: number;
  expiry_download_limit?: number;
  expiry_device_limit?: number;
  /** A standing-link slug for the API to point at the new build (the API field is still `channel`). */
  channel?: string;
}

interface UploadArgs {
  baseUrl: string;
  /** Defaults to `/api/cli/publish`; `betadrop_inspect` sends the same body to `/api/inspect`. */
  endpoint?: string;
  token: string;
  filePath: string;
  fields: UploadFields;
  onProgress?: (sent: number, total: number) => void;
  /**
   * How long the connection may be completely idle (no bytes sent or received)
   * before the upload is aborted (default 60 000 ms = 60s).
   */
  stallTimeoutMs?: number;
  /**
   * How long to wait for the TCP connection to be established before failing
   * (default 30 000 ms = 30s).
   */
  connectTimeoutMs?: number;
  /**
   * How many times to retry an upload the API cannot have received in full (default 2). Never
   * after an HTTP response, a 5xx included: see the retry loop in {@link uploadBuild}.
   */
  retries?: number;
}

/**
 * The upload failed before the API could have accepted it: no response came back, and the request
 * body had not all been handed to the network. The only failure {@link uploadBuild} retries.
 */
class NotDelivered extends CliError {}

const CRLF = "\r\n";

/**
 * Stream a multipart/form-data upload to /api/cli/publish, reporting byte
 * progress as the request body is consumed. Uses the raw http/https client so
 * we get reliable upload-progress events.
 */
export async function uploadBuild<T = PublishResponse>(args: UploadArgs): Promise<T> {
  const {
    endpoint = "/api/cli/publish",
    baseUrl,
    token,
    filePath,
    fields,
    onProgress,
    stallTimeoutMs = 120_000,
    connectTimeoutMs = 60_000,
    retries = 2,
  } = args;

  const stat = await fs.stat(filePath);
  if (stat.size === 0) {
    throw new CliError("The file is empty.");
  }
  const fileName = path.basename(filePath);
  // Strip chars that could break MIME headers or be used for injection.
  const safeFileName = fileName.replace(/["\\\r\n;,]/g, "_");

  const boundary = `----betadropcli${randomBytes(16).toString("hex")}`;
  const textParts: string[] = [];
  const addField = (key: string, value: string) => {
    textParts.push(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
        `${value}${CRLF}`,
    );
  };
  if (fields.name) addField("name", fields.name);
  if (fields.version) addField("version", fields.version);
  if (fields.build_number) addField("buildNumber", fields.build_number);
  if (fields.bundle_id) addField("bundleId", fields.bundle_id);
  if (fields.notes) addField("notes", fields.notes);
  if (fields.expiry_type) addField("expiry_type", fields.expiry_type);
  if (fields.expiry_time_days != null) addField("expiry_time_days", String(fields.expiry_time_days));
  if (fields.expiry_download_limit != null) addField("expiry_download_limit", String(fields.expiry_download_limit));
  if (fields.expiry_device_limit != null) addField("expiry_device_limit", String(fields.expiry_device_limit));
  if (fields.channel) addField("channel", fields.channel);
  // Identify this publish as coming from the MCP server so the API counts it
  // against the `mcp` tool-usage key (see resolvePublishSource on the server).
  // Without this the request falls through to the `cli` default.
  addField("source", "mcp");

  const fileHeader =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${safeFileName}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`;

  const preamble = Buffer.from(textParts.join("") + fileHeader, "utf8");
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");
  const totalBytes = preamble.length + stat.size + epilogue.length;
  process.stderr.write(
    `[betadrop-mcp] Uploading ${fileName} (${(totalBytes / 1024 / 1024).toFixed(1)} MB) to ${baseUrl}\n`,
  );

  const url = new URL(`${baseUrl}${endpoint}`);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  // Retry only an upload the API cannot have accepted.
  //
  // A publish is not idempotent. Once the API has the whole body it stores the build, and a 502 or
  // 504 from the proxy in front of it can still arrive after that, so re-sending on a 5xx published
  // the same build twice, with two install links. Any HTTP response is therefore final, and so is a
  // connection that fails after the last byte left: the API may be storing the build right then.
  //
  // What is retried is a failure before the body finished sending, with no response: a refused or
  // reset connection, a stale keep-alive socket, our own connect timeout, a stall mid-body. The API
  // publishes only a complete multipart body, so it cannot have stored one of those.
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpload();
    } catch (err) {
      if (err instanceof NotDelivered && attempt - 1 < retries) {
        process.stderr.write(
          `[betadrop-mcp] Upload attempt ${attempt} failed, retrying...\n`,
        );
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }

  function attemptUpload(): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // What the retry rule above reads: whether the API answered, and whether every byte of the
      // body was handed to the network ('finish'). Before 'finish' the API cannot have it all.
      let responded = false;
      let bodySent = false;
      const req = client.request(
        url,
        {
          method: "POST",
          agent,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": totalBytes,
            // Secondary signal for source detection: the server also treats a
            // `betadrop-mcp` User-Agent as an MCP publish (see resolvePublishSource).
            "User-Agent": "betadrop-mcp",
          },
        },
        (res: http.IncomingMessage) => {
          responded = true;
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 401) {
              reject(new UnauthorizedError());
              return;
            }
            let json: ApiResponse<T>;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new CliError(`Unexpected response from BetaDrop (HTTP ${status}).`));
              return;
            }
            if (status < 200 || status >= 300 || json.success === false) {
              reject(
                new CliError(
                  json.error || json.message || `Upload failed (HTTP ${status}).`,
                ),
              );
              return;
            }
            resolve(json.data as T);
          });
        },
      );

      let sent = 0;
      const bump = (n: number) => {
        sent += n;
        onProgress?.(Math.min(sent, totalBytes), totalBytes);
      };

      const fileStream = createReadStream(filePath);

      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        // An answer can come before the file finishes streaming (an early refusal); the stall
        // timer stopped then, and the last chunks must not start it again.
        if (responded) return;
        stallTimer = setTimeout(() => {
          fileStream.destroy();
          req.destroy(
            new Error(
              `Upload stalled — no data for ${stallTimeoutMs / 1000}s. Check your connection.`,
            ),
          );
        }, stallTimeoutMs);
      };

      const connectTimer = setTimeout(() => {
        fileStream.destroy();
        req.destroy(
          new Error(
            `Could not connect to BetaDrop after ${connectTimeoutMs / 1000}s. Check your connection.`,
          ),
        );
      }, connectTimeoutMs);

      req.on("socket", (socket: import("node:net").Socket) => {
        const connected = () => {
          clearTimeout(connectTimer);
          resetStall();
        };
        // A keep-alive socket from the agent's pool (say, after betadrop_inspect) is connected
        // already and never emits 'connect'; waiting for it let the connect timer cut the upload
        // off at connectTimeoutMs.
        if (socket.connecting) socket.once("connect", connected);
        else connected();
      });

      req.on("finish", () => {
        bodySent = true;
      });

      req.on("error", (err: Error) => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
        fileStream.destroy();
        const message =
          err.message.includes("stalled") || err.message.includes("connect")
            ? err.message
            : `Could not reach BetaDrop at ${baseUrl}. Check your connection or the BETADROP_API_URL environment variable.`;
        reject(!responded && !bodySent ? new NotDelivered(message) : new CliError(message));
      });

      req.write(preamble);
      bump(preamble.length);

      fileStream.on("data", (chunk: Buffer | string) => {
        resetStall();
        bump(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
      });
      fileStream.on("error", (err: Error) => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
        req.destroy();
        reject(new CliError(`Failed to read ${fileName}: ${err.message}`));
      });
      fileStream.on("end", () => {
        resetStall();
        if (!req.destroyed) {
          try {
            req.write(epilogue);
            bump(epilogue.length);
            req.end();
          } catch (err) {
            process.stderr.write(`[betadrop-mcp] Error writing epilogue: ${err}\n`);
          }
        }
      });
      fileStream.pipe(req, { end: false });

      req.on("response", () => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
