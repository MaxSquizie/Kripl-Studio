import type { AgentEvent, AgentInteractionRequest, AgentInteractionResponse, AgentSessionSnapshot, AgentSessionSummary, AgentStatus, BrowserState, ContextInspectorSnapshot, DesktopRuntimeSettings, DesktopUiState, RecentProject, WorkspaceChange, WorkspaceDescriptor, WorkspaceEntry } from "@kripl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceContent, activeWorkspacePath, type WorkspaceView } from "./WorkspaceContent";
import { TerminalPanel } from "./TerminalPanel";
import { RecentProjectsCard } from "./RecentProjectsCard";
import { RuntimeSettingsCard } from "./RuntimeSettingsCard";
import { ContextInspectorCard } from "./ContextInspectorCard";
import { AgentSessionCard } from "./AgentSessionCard";

interface AppInfo {
  name: string;
  version: string;
  platform: string;
  networkMode: "online" | "restricted" | "offline";
  modelRouting: "local-only" | "allow-remote";
}

interface LocalModel {
  provider: string;
  id: string;
  name: string;
  local: boolean;
}

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

interface ToolActivity {
  callId: string;
  name: string;
  phase: "started" | "updated" | "completed" | "failed";
  payload?: unknown;
}

interface AgentBinding {
  workspacePath: string;
  endpoint: string;
  modelId: string;
  sessionPath: string;
}

type ProbeState =
  | { status: "idle"; models: LocalModel[] }
  | { status: "checking"; models: LocalModel[] }
  | { status: "ready"; models: LocalModel[] }
  | { status: "error"; models: LocalModel[]; message: string };

const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:1234/v1";

const EMPTY_BROWSER_STATE: BrowserState = {
  visible: false,
  loading: false,
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function payloadPreview(payload: unknown): string {
  if (payload === undefined) return "";
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (typeof serialized !== "string") return String(payload);
    return serialized.length > 1800 ? `${serialized.slice(0, 1800)}\n…` : serialized;
  } catch {
    return String(payload);
  }
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [workspaceEntries, setWorkspaceEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChange[]>([]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>({ type: "agent" });
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<DesktopRuntimeSettings | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<ContextInspectorSnapshot | null>(null);
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle", models: [] });
  const [selectedModel, setSelectedModel] = useState("");
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [selectedSessionPath, setSelectedSessionPath] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [agentError, setAgentError] = useState("");
  const [binding, setBinding] = useState<AgentBinding | null>(null);
  const [composerText, setComposerText] = useState("");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [thinking, setThinking] = useState("");
  const [interaction, setInteraction] = useState<AgentInteractionRequest | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState>(EMPTY_BROWSER_STATE);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const assistantMessageId = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;

    void window.kripl.getAppInfo().then((info) => {
      if (!disposed) setAppInfo(info);
    });
    void window.kripl.getBrowserState().then((state) => {
      if (!disposed) setBrowserState(state);
    });
    void window.kripl.getContextSnapshot().then((snapshot) => {
      if (!disposed) setContextSnapshot(snapshot);
    });

    void window.kripl.getDesktopBootstrap()
      .then(async (bootstrap) => {
        if (disposed) return;
        setRecentProjects(bootstrap.recentProjects);
        setRuntimeSettings(bootstrap.runtime);
        if (bootstrap.workspace) {
          await hydrateWorkspace(bootstrap.workspace, bootstrap.ui);
          await refreshAgentSessions(bootstrap.lastSessionPath);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setAgentError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribeBrowser = window.kripl.onBrowserState((state) => {
      if (!disposed) setBrowserState(state);
    });
    const unsubscribeContext = window.kripl.onContextSnapshot((snapshot) => {
      if (!disposed) setContextSnapshot(snapshot);
    });

    return () => {
      disposed = true;
      unsubscribeBrowser();
      unsubscribeContext();
    };
  }, []);

  useEffect(() => {
    return window.kripl.onAgentEvent((event: AgentEvent) => {
      if (event.type === "agent.status") {
        setAgentStatus(event.status);
        if (event.status === "stopped" || event.status === "error") {
          setInteraction(null);
        }
        if (event.status === "error") {
          setAgentError(event.message ?? "Pi agent failed.");
        }
        if (event.status === "ready") {
          void syncActiveSessionFromRuntime();
        }
        return;
      }

      if (event.type === "agent.turn" && event.phase === "started") {
        assistantMessageId.current = null;
        return;
      }

      if (event.type === "agent.stream" && event.channel === "thinking") {
        if (event.phase === "started") {
          setThinking("");
        } else if (event.phase === "delta") {
          setThinking((current) => current + event.delta);
        } else {
          setThinking(event.content);
        }
        return;
      }

      if (event.type === "agent.stream" && event.channel === "text") {
        if (event.phase === "started") {
          const id = crypto.randomUUID();
          assistantMessageId.current = id;
          setMessages((current) => [...current, { id, role: "assistant", text: "" }]);
          return;
        }

        const existingId = assistantMessageId.current;
        if (!existingId) {
          const newId = crypto.randomUUID();
          assistantMessageId.current = newId;
          const initialText = event.phase === "delta" ? event.delta : event.content;
          setMessages((current) => [
            ...current,
            { id: newId, role: "assistant", text: initialText }
          ]);
          return;
        }

        const targetId = existingId;
        setMessages((current) =>
          current.map((message) => {
            if (message.id !== targetId) return message;
            if (event.phase === "delta") {
              return { ...message, text: message.text + event.delta };
            }
            if (!message.text) {
              return { ...message, text: event.content };
            }
            return message;
          })
        );
        return;
      }

      if (event.type === "agent.interaction") {
        setInteraction(event.request);
        return;
      }

      if (event.type === "agent.notification") {
        if (event.level === "error" || event.level === "warning") {
          setAgentError(event.message);
        }
        return;
      }

      if (event.type === "agent.tool") {
        if (event.phase === "completed" || event.phase === "failed") {
          void window.kripl.getWorkspaceChanges().then(setWorkspaceChanges).catch(() => {});
        }
        setTools((current) => {
          const existing = current.findIndex((tool) => tool.callId === event.callId);
          const next: ToolActivity = {
            callId: event.callId,
            name: event.name,
            phase: event.phase,
            ...(event.payload === undefined ? {} : { payload: event.payload })
          };

          if (existing < 0) return [...current, next];
          return current.map((tool, index) => (index === existing ? next : tool));
        });
      }
    });
  }, []);

  const workspaceName = useMemo(
    () => workspace?.name ?? "No project opened",
    [workspace]
  );

  const modelReady =
    probe.status === "ready" &&
    probe.models.length > 0 &&
    probe.models.some((model) => model.id === selectedModel);

  const bindingMatchesSelection =
    Boolean(binding) &&
    binding?.workspacePath === workspace?.path &&
    binding?.endpoint === endpoint &&
    binding?.modelId === selectedModel &&
    binding?.sessionPath === selectedSessionPath;

  const canStartAgent = Boolean(workspace && modelReady) && agentStatus !== "starting";
  const canSend = bindingMatchesSelection && agentStatus === "ready";


  async function toggleBrowser() {
    if (runtimeSettings?.networkMode === "offline") return;
    try {
      const next = await window.kripl.setBrowserVisible(!browserState.visible);
      setBrowserState(next);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleTerminal() {
    setTerminalVisible((current) => !current);
  }

  async function disconnectAgent() {
    await window.kripl.stopAgent();
    setAgentStatus("stopped");
    setBinding(null);
    assistantMessageId.current = null;
  }

  function hydrateSessionSnapshot(snapshot: AgentSessionSnapshot) {
    const restored: TranscriptMessage[] = snapshot.messages
      .filter((message) => message.role !== "tool")
      .map((message) => ({
        id: crypto.randomUUID(),
        role:
          message.role === "user"
            ? "user"
            : message.role === "assistant"
              ? "assistant"
              : "system",
        text: message.text
      }));

    setMessages(restored);
    setThinking("");
    assistantMessageId.current = null;
  }

  async function refreshAgentSessions(preferredPath?: string) {
    const sessions = await window.kripl.listAgentSessions();
    setAgentSessions(sessions);
    setSelectedSessionPath((current) => {
      const candidate = preferredPath ?? current;
      return candidate && sessions.some((session) => session.path === candidate)
        ? candidate
        : "";
    });
  }

  async function syncActiveSessionFromRuntime() {
    try {
      const [snapshot, sessions] = await Promise.all([
        window.kripl.getAgentSessionSnapshot(),
        window.kripl.listAgentSessions()
      ]);
      if (snapshot) {
        hydrateSessionSnapshot(snapshot);
        const persistedPath =
          snapshot.sessionFile &&
          sessions.some((session) => session.path === snapshot.sessionFile)
            ? snapshot.sessionFile
            : undefined;

        if (persistedPath) {
          setSelectedSessionPath(persistedPath);
          setBinding((current) =>
            current
              ? {
                  ...current,
                  sessionPath: persistedPath
                }
              : current
          );
        }
      }
      setAgentSessions(sessions);
    } catch {
      // Session metadata refresh must not interrupt the live agent UI.
    }
  }

  function persistedView(view: WorkspaceView): DesktopUiState["workspaceView"] {
    if (view.type === "file") return { type: "file", path: view.file.path };
    if (view.type === "diff") return { type: "diff", path: view.diff.path };
    return { type: "agent" };
  }

  function persistWorkspaceUi(
    view: WorkspaceView = workspaceView,
    expanded: Set<string> = expandedDirectories
  ) {
    void window.kripl.saveDesktopUi({
      workspaceView: persistedView(view),
      expandedDirectories: [...expanded]
    }).catch(() => {});
  }

  async function hydrateWorkspace(
    descriptor: WorkspaceDescriptor,
    ui: DesktopUiState
  ) {
    const [rootEntries, changes] = await Promise.all([
      window.kripl.listWorkspace(),
      window.kripl.getWorkspaceChanges()
    ]);

    const entries: Record<string, WorkspaceEntry[]> = { "": rootEntries };
    const expanded = new Set<string>();
    const orderedPaths = [...ui.expandedDirectories]
      .sort((left, right) => left.split("/").length - right.split("/").length)
      .slice(0, 64);

    for (const path of orderedPaths) {
      try {
        entries[path] = await window.kripl.listWorkspace(path);
        expanded.add(path);
      } catch {
        // Stale/deleted directories are simply omitted from restored UI state.
      }
    }

    let nextView: WorkspaceView = { type: "agent" };
    const savedView = ui.workspaceView;

    if (savedView.type === "file" && savedView.path) {
      try {
        const file = await window.kripl.readWorkspaceFile(savedView.path);
        nextView = { type: "file", file };
      } catch {
        nextView = { type: "agent" };
      }
    } else if (savedView.type === "diff" && savedView.path) {
      try {
        const diff = await window.kripl.getWorkspaceDiff(savedView.path);
        nextView = { type: "diff", diff };
      } catch {
        nextView = { type: "agent" };
      }
    }

    setWorkspace(descriptor);
    setAgentSessions([]);
    setSelectedSessionPath("");
    setWorkspaceEntries(entries);
    setExpandedDirectories(expanded);
    setWorkspaceChanges(changes);
    setWorkspaceView(nextView);
    setBinding(null);
    setAgentStatus("idle");
    setMessages([]);
    setTools([]);
    setThinking("");
    setInteraction(null);
    assistantMessageId.current = null;
  }

  async function syncRecentProjects() {
    const bootstrap = await window.kripl.getDesktopBootstrap();
    setRecentProjects(bootstrap.recentProjects);
    await refreshAgentSessions(bootstrap.lastSessionPath);
  }

  async function openWorkspace() {
    try {
      const selected = await window.kripl.pickWorkspace();
      if (!selected) return;

      await hydrateWorkspace(selected, {
        workspaceView: { type: "agent" },
        expandedDirectories: []
      });
      await syncRecentProjects();
      setAgentError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openRecentProject(path: string) {
    try {
      const selected = await window.kripl.openRecentProject(path);
      await hydrateWorkspace(selected, {
        workspaceView: { type: "agent" },
        expandedDirectories: []
      });
      await syncRecentProjects();
      setAgentError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function forgetRecentProject(path: string) {
    try {
      const projects = await window.kripl.forgetRecentProject(path);
      setRecentProjects(projects);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshWorkspace() {
    if (!workspace) return;
    try {
      const [rootEntries, changes] = await Promise.all([
        window.kripl.listWorkspace(),
        window.kripl.getWorkspaceChanges()
      ]);

      const entries: Record<string, WorkspaceEntry[]> = { "": rootEntries };
      const orderedPaths = [...expandedDirectories]
        .sort((left, right) => left.split("/").length - right.split("/").length)
        .slice(0, 64);

      for (const path of orderedPaths) {
        try {
          entries[path] = await window.kripl.listWorkspace(path);
        } catch {
          // Ignore stale directories during refresh.
        }
      }

      setWorkspaceEntries(entries);
      setWorkspaceChanges(changes);

      if (workspaceView.type === "file") {
        try {
          const file = await window.kripl.readWorkspaceFile(workspaceView.file.path);
          setWorkspaceView({ type: "file", file });
        } catch {
          const view: WorkspaceView = { type: "agent" };
          setWorkspaceView(view);
          persistWorkspaceUi(view);
        }
      } else if (workspaceView.type === "diff") {
        try {
          const diff = await window.kripl.getWorkspaceDiff(workspaceView.diff.path);
          setWorkspaceView({ type: "diff", diff });
        } catch {
          const view: WorkspaceView = { type: "agent" };
          setWorkspaceView(view);
          persistWorkspaceUi(view);
        }
      }
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleDirectory(path: string) {
    if (expandedDirectories.has(path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        persistWorkspaceUi(workspaceView, next);
        return next;
      });
      return;
    }

    try {
      if (!workspaceEntries[path]) {
        const entries = await window.kripl.listWorkspace(path);
        setWorkspaceEntries((current) => ({ ...current, [path]: entries }));
      }
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.add(path);
        persistWorkspaceUi(workspaceView, next);
        return next;
      });
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openWorkspaceFile(path: string) {
    try {
      const file = await window.kripl.readWorkspaceFile(path);
      const view: WorkspaceView = { type: "file", file };
      setWorkspaceView(view);
      persistWorkspaceUi(view);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openWorkspaceDiff(path: string) {
    try {
      const diff = await window.kripl.getWorkspaceDiff(path);
      const view: WorkspaceView = { type: "diff", diff };
      setWorkspaceView(view);
      persistWorkspaceUi(view);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async function retrieveMemory(query: string) {
    await window.kripl.retrieveMemory(query);
  }

  async function probeModels() {
    setProbe((current) => ({ status: "checking", models: current.models }));
    const result = await window.kripl.probeLocalModels(endpoint);

    if (!result.ok) {
      setProbe({ status: "error", models: [], message: result.error ?? "Local model probe failed." });
      setSelectedModel("");
      return;
    }

    setEndpoint(result.endpoint);
    setProbe({ status: "ready", models: result.models });
    setSelectedModel((current) => {
      if (result.models.some((model) => model.id === current)) return current;
      return result.models[0]?.id ?? "";
    });
  }

  async function applyRuntimeSettings(next: DesktopRuntimeSettings) {
    const saved = await window.kripl.saveRuntimeSettings(next);
    setRuntimeSettings(saved);
    setAppInfo((current) =>
      current
        ? {
            ...current,
            networkMode: saved.networkMode,
            modelRouting: saved.modelRouting
          }
        : current
    );
    setBinding(null);
    setAgentStatus("stopped");
    setInteraction(null);
    assistantMessageId.current = null;

    if (saved.networkMode === "offline") {
      setBrowserState((current) => ({
        ...current,
        visible: false,
        loading: false,
        url: current.url === "about:blank" ? "" : current.url
      }));
    }
  }

  async function startAgent() {
    if (!workspace || !modelReady || !selectedModel) return;

    setAgentError("");
    setAgentStatus("starting");
    setMessages([]);
    setTools([]);
    setThinking("");
    assistantMessageId.current = null;

    const requestedSessionPath = selectedSessionPath;
    const result = await window.kripl.startAgent({
      endpoint,
      modelId: selectedModel,
      ...(requestedSessionPath ? { sessionPath: requestedSessionPath } : {})
    });

    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to start Pi agent.");
      setBinding(null);
      return;
    }

    const snapshot = await window.kripl.getAgentSessionSnapshot().catch(() => null);
    if (snapshot) {
      hydrateSessionSnapshot(snapshot);
    }
    await refreshAgentSessions(requestedSessionPath || undefined).catch(() => {});

    setBinding({
      workspacePath: workspace.path,
      endpoint,
      modelId: selectedModel,
      sessionPath: requestedSessionPath
    });
    setAgentStatus("ready");
  }

  async function sendPrompt() {
    const text = composerText.trim();
    if (!text || !canSend) return;

    const userMessage: TranscriptMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text
    };

    setMessages((current) => [...current, userMessage]);
    setComposerText("");
    setAgentError("");
    assistantMessageId.current = null;

    const result = await window.kripl.sendAgentMessage(text);
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Prompt was rejected.");
    }
  }


  async function respondToInteraction(response: AgentInteractionResponse) {
    const result = await window.kripl.respondToAgentInteraction(response);
    if (!result.ok) {
      setAgentError(result.error ?? "Failed to answer agent permission request.");
      return;
    }
    setInteraction(null);
  }

  async function abortAgent() {
    const result = await window.kripl.abortAgent();
    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to stop the current run.");
    }
  }

  return (
    <div className={"app-shell" + (terminalVisible ? " terminal-open" : "")}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>Kripl Studio</span>
        </div>
        <div className="workspace-title">{workspaceName}</div>
        <button
          className={`browser-toggle ${browserState.visible ? "active" : ""}`}
          type="button"
          onClick={() => void toggleBrowser()}
          title={
            runtimeSettings?.networkMode === "offline"
              ? "Browser disabled in Offline mode"
              : browserState.url || "Show interactive browser"
          }
          disabled={runtimeSettings?.networkMode === "offline"}
        >
          {runtimeSettings?.networkMode === "offline"
            ? "Browser · offline"
            : browserState.loading
              ? "Browser · loading"
              : browserState.visible
                ? "Browser · open"
                : "Browser"}
        </button>
        <button
          className={"browser-toggle" + (terminalVisible ? " active" : "")}
          type="button"
          onClick={toggleTerminal}
          title="Toggle terminal"
        >
          Terminal
        </button>
        <div className="runtime-pill">
          <span className="status-dot" />
          local model · network {runtimeSettings?.networkMode ?? "online"}
        </div>
      </header>

      <div className="workspace">
        <WorkspaceSidebar
          workspace={workspace}
          entries={workspaceEntries}
          expanded={expandedDirectories}
          changes={workspaceChanges}
          activePath={activeWorkspacePath(workspaceView)}
          onOpenWorkspace={() => void openWorkspace()}
          onRefresh={() => void refreshWorkspace()}
          onToggleDirectory={(path) => void toggleDirectory(path)}
          onOpenFile={(path) => void openWorkspaceFile(path)}
          onOpenDiff={(path) => void openWorkspaceDiff(path)}
        />

        <main className="agent-column">
          {workspaceView.type === "agent" ? (
            <>

          <div className="agent-header">
            <div>
              <span className="eyebrow">Agent workspace</span>
              <h1>{workspace ? workspaceName : "Start locally"}</h1>
            </div>
            <span className="engine-label">Pi adapter · {agentStatus}</span>
          </div>

          <div className="conversation">
            {messages.length === 0 && tools.length === 0 ? (
              <section className="welcome-card">
                <span className="eyebrow">Kripl Studio</span>
                <h2>Local model → Pi → workspace.</h2>
                <p>
                  Open a project, connect a loopback OpenAI-compatible model server, then start
                  Pi. The selected model is written only to Kripl Studio's isolated Pi config;
                  your normal Pi configuration is not modified.
                </p>
                <div className="capability-row">
                  <span>AgentRuntime</span>
                  <span>Local Model</span>
                  <span>Pi RPC</span>
                  <span>MemoryRuntime</span>
                </div>
              </section>
            ) : (
              <div className="transcript">
                {messages.map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <div className="message-role">
                      {message.role === "user" ? "You" : message.role === "assistant" ? "Kripl" : "System"}
                    </div>
                    <div className="message-text">{message.text || "…"}</div>
                  </article>
                ))}

                {thinking && (
                  <details className="thinking-card">
                    <summary>Reasoning</summary>
                    <div>{thinking}</div>
                  </details>
                )}

                {tools.map((tool) => (
                  <details className={`tool-card ${tool.phase}`} key={tool.callId}>
                    <summary>
                      <span>{tool.name}</span>
                      <span>{tool.phase}</span>
                    </summary>
                    {tool.payload !== undefined && <pre>{payloadPreview(tool.payload)}</pre>}
                  </details>
                ))}
              </div>
            )}

            {agentError && <div className="agent-error">{agentError}</div>}
          </div>

          <div className="composer">
            <textarea
              disabled={!canSend}
              rows={2}
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendPrompt();
                }
              }}
              placeholder={
                canSend
                  ? "Ask Kripl to inspect or change the project…"
                  : agentStatus === "running"
                    ? "Agent is working…"
                    : "Open a project, connect a local model, and start Pi…"
              }
            />
            {agentStatus === "running" || agentStatus === "stopping" ? (
              <button type="button" className="stop-button" onClick={() => void abortAgent()}>
                Stop
              </button>
            ) : (
              <button type="button" disabled={!canSend || !composerText.trim()} onClick={() => void sendPrompt()}>
                Send
              </button>
            )}
          </div>

            </>
          ) : (
            <WorkspaceContent
              view={workspaceView}
              onBackToAgent={() => {
                const view: WorkspaceView = { type: "agent" };
                setWorkspaceView(view);
                persistWorkspaceUi(view);
              }}
            />
          )}
        </main>

        <aside className="inspector">
          <div className="panel-heading">
            <span>Runtime</span>
          </div>

          <div className="status-card">
            <div className="status-line">
              <span>Application</span>
              <strong>ready</strong>
            </div>
            <div className="status-line">
              <span>Model</span>
              <strong className={modelReady ? "" : "muted"}>{modelReady ? "local" : "not connected"}</strong>
            </div>
            <div className="status-line">
              <span>Agent</span>
              <strong className={bindingMatchesSelection && agentStatus === "ready" ? "" : "muted"}>
                {agentStatus}
              </strong>
            </div>
            <div className="status-line">
              <span>Memory</span>
              <strong className={contextSnapshot?.memoryHealth.status === "ready" ? "" : "muted"}>
                {contextSnapshot?.memoryHealth.status ?? "loading"}
              </strong>
            </div>
            <div className="status-line">
              <span>Network</span>
              <strong>{runtimeSettings?.networkMode ?? appInfo?.networkMode ?? "online"}</strong>
            </div>
            <div className="status-line">
              <span>Browser</span>
              <strong className={browserState.visible ? "" : "muted"}>
                {browserState.visible ? (browserState.loading ? "loading" : "open") : "hidden"}
              </strong>
            </div>
            <div className="status-line">
              <span>Cloud model fallback</span>
              <strong>off</strong>
            </div>
          </div>

          <ContextInspectorCard
            snapshot={contextSnapshot}
            onRetrieve={retrieveMemory}
          />

          <div className="status-card">
            <span className="eyebrow">Local model server</span>
            <label className="endpoint-field">
              <span>OpenAI-compatible endpoint</span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                spellCheck={false}
                placeholder={DEFAULT_LOCAL_ENDPOINT}
              />
            </label>
            <button
              className="probe-button"
              type="button"
              disabled={probe.status === "checking"}
              onClick={() => void probeModels()}
            >
              {probe.status === "checking" ? "Checking…" : "Connect local server"}
            </button>

            {probe.status === "idle" && <p className="probe-result">Default: LM Studio on port 1234.</p>}
            {probe.status === "error" && <p className="probe-result error">{probe.message}</p>}
            {probe.status === "ready" && probe.models.length === 0 && (
              <p className="probe-result">Server is reachable, but it reports no loaded models.</p>
            )}
            {probe.status === "ready" && probe.models.length > 0 && (
              <>
                <p className="probe-result ready">{probe.models.length} local model(s) found.</p>
                <select
                  className="model-select"
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                >
                  {probe.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </>
            )}

          </div>

          <AgentSessionCard
            sessions={agentSessions}
            selectedPath={selectedSessionPath}
            active={bindingMatchesSelection}
            disabled={!canStartAgent}
            starting={agentStatus === "starting"}
            onSelect={setSelectedSessionPath}
            onStart={() => void startAgent()}
          />

          {runtimeSettings && (
            <RuntimeSettingsCard
              settings={runtimeSettings}
              onApply={applyRuntimeSettings}
            />
          )}

          {browserState.url && (
            <div className="status-card">
              <span className="eyebrow">Browser</span>
              <p className="detail">{browserState.title || "Untitled page"}</p>
              <p className="detail browser-url">{browserState.url}</p>
              {browserState.error && <p className="probe-result error">{browserState.error}</p>}
            </div>
          )}

          <RecentProjectsCard
            projects={recentProjects}
            currentPath={workspace?.path}
            onOpen={(path) => void openRecentProject(path)}
            onForget={(path) => void forgetRecentProject(path)}
          />

          <div className="status-card">
            <span className="eyebrow">Desktop</span>
            <p className="detail">{appInfo ? `${appInfo.name} ${appInfo.version}` : "Loading…"}</p>
            <p className="detail">{appInfo?.platform ?? "—"}</p>
          </div>

          <div className="status-card">
            <span className="eyebrow">Next</span>
            <ol>
              <li>Connect a real MemoryRuntime / AG Memory adapter.</li>
            </ol>
          </div>
        </aside>
      </div>

      <TerminalPanel
        visible={terminalVisible}
        workspaceOpen={Boolean(workspace)}
        workspaceKey={workspace?.path ?? ""}
        onClose={() => setTerminalVisible(false)}
      />

      {interaction && (
        <div className="interaction-backdrop" role="presentation">
          <section className="interaction-dialog" role="dialog" aria-modal="true">
            <span className="eyebrow">Agent permission</span>
            <h3>{interaction.title}</h3>
            {interaction.message && <pre>{interaction.message}</pre>}

            {interaction.kind === "confirm" && (
              <div className="interaction-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, confirmed: false })}
                >
                  Block
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, confirmed: true })}
                >
                  Allow
                </button>
              </div>
            )}

            {interaction.kind === "select" && (
              <div className="interaction-options">
                {(interaction.options ?? []).map((option) => (
                  <button
                    key={option}
                    className="secondary-button"
                    type="button"
                    onClick={() => void respondToInteraction({ id: interaction.id, value: option })}
                  >
                    {option}
                  </button>
                ))}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void respondToInteraction({ id: interaction.id, cancelled: true })}
                >
                  Cancel
                </button>
              </div>
            )}

            {(interaction.kind === "input" || interaction.kind === "editor") && (
              <>
                <p className="interaction-note">
                  This interaction type is not exposed by Kripl yet. It is cancelled fail-closed.
                </p>
                <div className="interaction-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void respondToInteraction({ id: interaction.id, cancelled: true })}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

    </div>
  );
}
