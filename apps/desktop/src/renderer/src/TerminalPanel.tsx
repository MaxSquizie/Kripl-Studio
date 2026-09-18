import type { TerminalSessionInfo } from "@kripl/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalPanelProps {
  visible: boolean;
  workspaceOpen: boolean;
  workspaceKey: string;
  onClose(): void;
}

export function TerminalPanel({
  visible,
  workspaceOpen,
  workspaceKey,
  onClose
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSessionInfo | null>(null);
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [error, setError] = useState("");

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || !visible) return;

    try {
      fitAddon.fit();
      if (terminal.cols >= 2 && terminal.rows >= 2 && sessionRef.current?.status === "running") {
        void window.kripl.resizeTerminal(terminal.cols, terminal.rows).catch(() => {});
      }
    } catch {
      // The panel may be transitioning through a zero-sized layout.
    }
  }, [visible]);

  const start = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal || !workspaceOpen) return;

    setError("");
    try {
      fitAndResize();
      const next = await window.kripl.startTerminal({
        cols: terminal.cols,
        rows: terminal.rows
      });
      sessionRef.current = next;
      setSession(next);
      terminal.focus();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      terminal.writeln("\r\n[Kripl terminal error] " + message);
    }
  }, [fitAndResize, workspaceOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 10_000,
      allowTransparency: false,
      theme: {
        background: "#0b0e13",
        foreground: "#cbd2dc",
        cursor: "#d7dde6",
        selectionBackground: "#334158",
        black: "#15191f",
        brightBlack: "#687384",
        red: "#d98288",
        brightRed: "#eca0a5",
        green: "#88c99a",
        brightGreen: "#a2ddb0",
        yellow: "#d5bd77",
        brightYellow: "#e6d08e",
        blue: "#83a9dc",
        brightBlue: "#9bbce7",
        magenta: "#b69bd3",
        brightMagenta: "#cab0e3",
        cyan: "#7fc7c9",
        brightCyan: "#9bdadd",
        white: "#cbd2dc",
        brightWhite: "#f0f3f7"
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      void window.kripl.writeTerminal(data).catch(() => {});
    });

    const unsubscribe = window.kripl.onTerminalEvent((event) => {
      if (event.type === "terminal.data") {
        terminal.write(event.data);
        return;
      }

      terminal.writeln("\r\n[process exited: " + event.exitCode + "]");
      const current = sessionRef.current;
      if (current?.id === event.sessionId) {
        const exited: TerminalSessionInfo = {
          ...current,
          status: "exited",
          exitCode: event.exitCode
        };
        sessionRef.current = exited;
        setSession(exited);
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (terminal.cols >= 2 && terminal.rows >= 2 && sessionRef.current?.status === "running") {
          void window.kripl.resizeTerminal(terminal.cols, terminal.rows).catch(() => {});
        }
      } catch {
        // Ignore transient zero-sized measurements.
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    void window.kripl.setTerminalPanelVisible(visible);
    if (!visible) return;

    const terminal = terminalRef.current;
    if (!terminal) return;

    requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    if (!workspaceOpen) return;

    void window.kripl.getTerminalState().then((current) => {
      if (current?.status === "running" && current.cwd === workspaceKey) {
        sessionRef.current = current;
        setSession(current);
        return;
      }

      terminal.reset();
      void start();
    });
  }, [fitAndResize, start, visible, workspaceKey, workspaceOpen]);

  async function restart() {
    const terminal = terminalRef.current;
    if (!terminal || !workspaceOpen) return;

    await window.kripl.killTerminal().catch(() => {});
    sessionRef.current = null;
    setSession(null);
    terminal.reset();
    await start();
  }

  async function kill() {
    await window.kripl.killTerminal().catch(() => {});
    sessionRef.current = null;
    setSession((current) =>
      current
        ? { ...current, status: "exited", exitCode: -1 }
        : null
    );
  }

  return (
    <section className={"terminal-panel" + (visible ? " visible" : "")}>
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <span>Terminal</span>
          <span className={"terminal-status " + (session?.status ?? "idle")}>
            {session?.shell ?? (workspaceOpen ? "ready" : "no workspace")}
          </span>
        </div>
        <div className="terminal-actions">
          {error && <span className="terminal-error" title={error}>error</span>}
          <button type="button" onClick={() => void restart()} disabled={!workspaceOpen}>
            ↻
          </button>
          <button
            type="button"
            onClick={() => void kill()}
            disabled={session?.status !== "running"}
            title="Kill terminal"
          >
            ■
          </button>
          <button type="button" onClick={onClose} title="Hide terminal">
            ×
          </button>
        </div>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}
