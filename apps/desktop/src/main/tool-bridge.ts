import type { BrowserSnapshot, BrowserState, ToolBridgeConnection } from "@kripl/core";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserRuntime } from "./browser-runtime.js";

const MAX_BODY_BYTES = 128 * 1024;

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Tool bridge request body is too large.");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool bridge request must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

export class ToolBridgeServer {
  private readonly token = randomBytes(32).toString("base64url");
  private server: Server | undefined;
  private connection: ToolBridgeConnection | undefined;

  constructor(private readonly browser: BrowserRuntime) {}

  async start(): Promise<ToolBridgeConnection> {
    if (this.server && this.connection) return this.connection;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Unable to determine Kripl tool bridge address.");
    }

    this.server = server;
    this.connection = {
      baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
      token: this.token
    };
    return this.connection;
  }

  getConnection(): ToolBridgeConnection | undefined {
    return this.connection;
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.connection = undefined;
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!authorized(request, this.token)) {
        sendJson(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }

      const body = await readJson(request);
      const path = request.url ?? "";

      if (path === "/browser/navigate") {
        if (typeof body.url !== "string" || !body.url) {
          throw new Error("Browser URL is required.");
        }
        const state = await this.browser.navigate(body.url);
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (path === "/browser/snapshot") {
        const snapshot = await this.browser.snapshot();
        sendJson(response, 200, { ok: true, snapshot });
        return;
      }

      if (path === "/browser/click") {
        if (typeof body.ref !== "string" || !body.ref) {
          throw new Error("Browser element ref is required.");
        }
        const state = await this.browser.click(body.ref);
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (path === "/browser/type") {
        if (typeof body.ref !== "string" || !body.ref || typeof body.text !== "string") {
          throw new Error("Browser element ref and text are required.");
        }
        const state = await this.browser.type(body.ref, body.text, body.submit === true);
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (path === "/browser/back") {
        sendJson(response, 200, { ok: true, state: this.browser.back() });
        return;
      }

      if (path === "/browser/forward") {
        sendJson(response, 200, { ok: true, state: this.browser.forward() });
        return;
      }

      sendJson(response, 404, { ok: false, error: "Unknown tool bridge route." });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
