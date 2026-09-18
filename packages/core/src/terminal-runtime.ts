export type TerminalStatus = "idle" | "starting" | "running" | "exited";

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
  status: TerminalStatus;
  exitCode?: number;
}

export type TerminalEvent =
  | {
      type: "terminal.data";
      sessionId: string;
      data: string;
    }
  | {
      type: "terminal.exit";
      sessionId: string;
      exitCode: number;
    };

export interface TerminalStartOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalRuntime {
  readonly id: string;

  start(options: TerminalStartOptions): Promise<TerminalSessionInfo>;
  state(): TerminalSessionInfo | null;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
  dispose(): Promise<void>;
}
