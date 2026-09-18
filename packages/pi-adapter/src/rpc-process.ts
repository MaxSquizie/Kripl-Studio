import type { NetworkMode, ToolBridgeConnection } from "@kripl/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

export interface PiRpcStartOptions {
  agentDir: string;
  sessionDir?: string;
  networkMode?: NetworkMode;
  toolBridge?: ToolBridgeConnection;
}

const rpcEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

const CLOUD_MODEL_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "OPENCODE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
] as const;

export function createPiEnvironment(options: PiRpcStartOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  for (const key of CLOUD_MODEL_PROVIDER_ENV_KEYS) {
    delete environment[key];
  }

  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PI_TELEMETRY = "0";
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.PI_CODING_AGENT_DIR = options.agentDir;
  environment.KRIPL_NETWORK_MODE = options.networkMode ?? "online";

  if (options.toolBridge) {
    environment.KRIPL_TOOL_BRIDGE_URL = options.toolBridge.baseUrl;
    environment.KRIPL_TOOL_BRIDGE_TOKEN = options.toolBridge.token;
  } else {
    delete environment.KRIPL_TOOL_BRIDGE_URL;
    delete environment.KRIPL_TOOL_BRIDGE_TOKEN;
  }

  if (options.networkMode === "offline") {
    environment.PI_OFFLINE = "1";
  } else {
    delete environment.PI_OFFLINE;
  }

  if (options.sessionDir) {
    environment.PI_CODING_AGENT_SESSION_DIR = options.sessionDir;
  } else {
    delete environment.PI_CODING_AGENT_SESSION_DIR;
  }

  return environment;
}

export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: JsonRecord) => void>();

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start(cwd: string, options: PiRpcStartOptions): void {
    if (this.running) {
      throw new Error("Pi RPC process is already running.");
    }

    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    this.child = spawn(process.execPath, [rpcEntryPath], {
      cwd,
      env: createPiEnvironment(options),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-64 * 1024);
    });

    this.child.once("error", (error) => this.handleExit(error));
    this.child.once("exit", (code, signal) => {
      this.handleExit(
        new Error(
          `Pi RPC process exited (code=${String(code)}, signal=${String(signal)}). ${this.stderrBuffer}`.trim()
        )
      );
    });
  }

  subscribe(listener: (event: JsonRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: JsonRecord): Promise<JsonRecord> {
    const child = this.child;
    if (!child || !this.running) {
      return Promise.reject(new Error("Pi RPC process is not running."));
    }

    const id = typeof command.id === "string" ? command.id : `kripl_${randomUUID()}`;

    return new Promise<JsonRecord>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  sendOneWay(message: JsonRecord): Promise<void> {
    const child = this.child;
    if (!child || !this.running) {
      return Promise.reject(new Error("Pi RPC process is not running."));
    }

    return new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;

    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      request.reject(new Error("Pi RPC process was disposed."));
    }

    if (!child || child.exitCode !== null || child.killed) return;

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");

    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3_000);
    force.unref();

    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;

      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);

      if (!line.trim()) continue;

      let parsed: JsonRecord;
      try {
        parsed = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (parsed.type === "response" && typeof parsed.id === "string") {
        const request = this.pending.get(parsed.id);
        if (request) {
          this.pending.delete(parsed.id);
          request.resolve(parsed);
        }
        continue;
      }

      for (const listener of this.listeners) listener(parsed);
    }
  }

  private handleExit(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      request.reject(error);
    }
  }
}
