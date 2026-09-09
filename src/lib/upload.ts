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
}

interface UploadArgs {
  baseUrl: string;
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
  /** How many times to retry on a transient 5xx before giving up (default 2). */
  retries?: number;
}

const CRLF = "\r\n";

/**
 * Stream a multipart/form-data upload to /api/cli/publish, reporting byte
 * progress as the request body is consumed. Uses the raw http/https client so
 * we get reliable upload-progress events.
 */
export async function uploadBuild(args: UploadArgs): Promise<PublishResponse> {
  const {
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

  const url = new URL(`${baseUrl}/api/cli/publish`);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await attemptUpload();
    } catch (err) {
      if (
        err instanceof CliError &&
        !(err instanceof UnauthorizedError) &&
        /HTTP 5\d\d/.test(err.message) &&
        attempt - 1 < retries
      ) {
        process.stderr.write(
          `[betadrop-mcp] Upload attempt ${attempt} failed, retrying...\n`,
        );
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }

  function attemptUpload(): Promise<PublishResponse> {
    return new Promise<PublishResponse>((resolve, reject) => {
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
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 401) {
              reject(new UnauthorizedError());
              return;
            }
            let json: ApiResponse<PublishResponse>;
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
            resolve(json.data as PublishResponse);
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
        socket.on("connect", () => {
          clearTimeout(connectTimer);
          resetStall();
        });
      });

      req.on("error", (err: Error) => {
        if (stallTimer) clearTimeout(stallTimer);
        clearTimeout(connectTimer);
        fileStream.destroy();
        reject(
          err.message.includes("stalled") || err.message.includes("connect")
            ? new CliError(err.message)
            : new CliError(
                `Could not reach BetaDrop at ${baseUrl}. Check your connection or the BETADROP_API_URL environment variable.`,
              ),
        );
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
