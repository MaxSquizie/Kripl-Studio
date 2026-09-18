import type {
  TerminalEvent,
  TerminalRuntime,
  TerminalSessionInfo,
  TerminalStartOptions
} from "@kripl/core";
import type { IPty } from "node-pty";
import { randomUUID } from "node:crypto";

export interface TerminalShellSpec {
  command: string;
  args: string[];
  label: string;
}

export function resolveDefaultTerminalShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): TerminalShellSpec {
  const override = env.KRIPL_TERMINAL_SHELL?.trim();
  if (override) {
    return {
      command: override,
      args: [],
      label: override
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo"],
      label: "Windows PowerShell"
    };
  }

  const shell = env.SHELL?.trim() || "bash";
  return {
    command: shell,
    args: [],
    label: shell
  };
}

export function normalizeTerminalSize(
  cols: number | undefined,
  rows: number | undefined
): { cols: number; rows: number } {
  const normalizedCols = Number.isFinite(cols)
    ? Math.min(500, Math.max(2, Math.floor(cols ?? 100)))
    : 100;
  const normalizedRows = Number.isFinite(rows)
    ? Math.min(300, Math.max(2, Math.floor(rows ?? 30)))
    : 30;
  return { cols: normalizedCols, rows: normalizedRows };
}

function terminalEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  return environment;
}

export class PtyTerminalRuntime implements TerminalRuntime {
  readonly id = "terminal:pty";

  private pty: IPty | undefined;
  private currentState: TerminalSessionInfo | null = null;
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  async start(options: TerminalStartOptions): Promise<TerminalSessionInfo> {
    await this.kill();

    const shell = resolveDefaultTerminalShell(process.platform, process.env);
    const size = normalizeTerminalSize(options.cols, options.rows);
    const sessionId = randomUUID();

    this.currentState = {
      id: sessionId,
      cwd: options.cwd,
      shell: shell.label,
      status: "starting"
    };

    const nodePty = await import("node-pty");
    const processHandle = nodePty.spawn(shell.command, shell.args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: options.cwd,
      env: terminalEnvironment()
    });

    this.pty = processHandle;
    this.currentState = {
      id: sessionId,
      cwd: options.cwd,
      shell: shell.label,
      status: "running"
    };

    processHandle.onData((data) => {
      if (this.currentState?.id !== sessionId) return;
      this.emit({
        type: "terminal.data",
        sessionId,
        data
      });
    });

    processHandle.onExit((event) => {
      if (this.currentState?.id !== sessionId) return;
      this.pty = undefined;
      this.currentState = {
        id: sessionId,
        cwd: options.cwd,
        shell: shell.label,
        status: "exited",
        exitCode: event.exitCode
      };
      this.emit({
        type: "terminal.exit",
        sessionId,
        exitCode: event.exitCode
      });
    });

    return { ...this.currentState };
  }

  state(): TerminalSessionInfo | null {
    return this.currentState ? { ...this.currentState } : null;
  }

  async write(data: string): Promise<void> {
    if (!this.pty || this.currentState?.status !== "running") {
      throw new Error("Terminal is not running.");
    }
    this.pty.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.pty || this.currentState?.status !== "running") return;
    const size = normalizeTerminalSize(cols, rows);
    this.pty.resize(size.cols, size.rows);
  }

  async kill(): Promise<void> {
    const processHandle = this.pty;
    this.pty = undefined;

    if (processHandle) {
      try {
        processHandle.kill();
      } catch {
        // Process may already have exited.
      }
    }

    if (this.currentState?.status === "running" || this.currentState?.status === "starting") {
      this.currentState = {
        ...this.currentState,
        status: "exited",
        exitCode: -1
      };
    }
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.kill();
    this.listeners.clear();
    this.currentState = null;
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
