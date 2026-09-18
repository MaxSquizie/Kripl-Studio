import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

const rpcEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

export class PiRpcProcess {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: JsonRecord) => void>();

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start(cwd: string): void {
    if (this.running) {
      throw new Error("Pi RPC process is already running.");
    }

    this.child = spawn(process.execPath, [rpcEntryPath], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1"
      },
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
