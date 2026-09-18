import type { AgentEvent, AgentInteractionRequest, AgentInteractionResponse, AgentStatus } from "@kripl/core";
import { useEffect, useMemo, useRef, useState } from "react";

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
}

type ProbeState =
  | { status: "idle"; models: LocalModel[] }
  | { status: "checking"; models: LocalModel[] }
  | { status: "ready"; models: LocalModel[] }
  | { status: "error"; models: LocalModel[]; message: string };

const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:1234/v1";

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
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle", models: [] });
  const [selectedModel, setSelectedModel] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [agentError, setAgentError] = useState("");
  const [binding, setBinding] = useState<AgentBinding | null>(null);
  const [composerText, setComposerText] = useState("");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [thinking, setThinking] = useState("");
  const [interaction, setInteraction] = useState<AgentInteractionRequest | null>(null);
  const assistantMessageId = useRef<string | null>(null);

  useEffect(() => {
    void window.kripl.getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    return window.kripl.onAgentEvent((event: AgentEvent) => {
      if (event.type === "agent.status") {
        setAgentStatus(event.status);
        if (event.status === "error") {
          setAgentError(event.message ?? "Pi agent failed.");
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

        let id = assistantMessageId.current;
        if (!id) {
          id = crypto.randomUUID();
          assistantMessageId.current = id;
          const initialText = event.phase === "delta" ? event.delta : event.content;
          setMessages((current) => [...current, { id, role: "assistant", text: initialText }]);
          return;
        }

        const targetId = id;
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
    () => (workspace ? basename(workspace) : "No project opened"),
    [workspace]
  );

  const modelReady =
    probe.status === "ready" &&
    probe.models.length > 0 &&
    probe.models.some((model) => model.id === selectedModel);

  const bindingMatchesSelection =
    Boolean(binding) &&
    binding?.workspacePath === workspace &&
    binding?.endpoint === endpoint &&
    binding?.modelId === selectedModel;

  const canStartAgent = Boolean(workspace && modelReady) && agentStatus !== "starting";
  const canSend = bindingMatchesSelection && agentStatus === "ready";

  async function disconnectAgent() {
    await window.kripl.stopAgent();
    setAgentStatus("stopped");
    setBinding(null);
    assistantMessageId.current = null;
  }

  async function openWorkspace() {
    const selected = await window.kripl.pickWorkspace();
    if (!selected) return;

    if (binding) await disconnectAgent();
    setWorkspace(selected);
    setMessages([]);
    setTools([]);
    setThinking("");
    setAgentError("");
    setInteraction(null);
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

  async function startAgent() {
    if (!workspace || !modelReady || !selectedModel) return;

    setAgentError("");
    setAgentStatus("starting");
    setMessages([]);
    setTools([]);
    setThinking("");
    assistantMessageId.current = null;

    const result = await window.kripl.startAgent({
      workspacePath: workspace,
      endpoint,
      modelId: selectedModel
    });

    if (!result.ok) {
      setAgentStatus("error");
      setAgentError(result.error ?? "Failed to start Pi agent.");
      setBinding(null);
      return;
    }

    setBinding({ workspacePath: workspace, endpoint, modelId: selectedModel });
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
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>Kripl Studio</span>
        </div>
        <div className="workspace-title">{workspaceName}</div>
        <div className="runtime-pill">
          <span className="status-dot" />
          local model · network online
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="panel-heading">
            <span>Explorer</span>
            <button className="icon-button" type="button" onClick={openWorkspace} title="Open project">
              +
            </button>
          </div>

          {workspace ? (
            <div className="project-card">
              <strong>{workspaceName}</strong>
              <span>{workspace}</span>
              <div className="tree-placeholder">
                <span>▸ .git</span>
                <span>▸ src</span>
                <span>▸ tests</span>
                <span>  README.md</span>
              </div>
            </div>
          ) : (
            <div className="empty-panel">
              <p>Open a project folder to create a local coding workspace.</p>
              <button className="primary-button" type="button" onClick={openWorkspace}>
                Open project
              </button>
            </div>
          )}
        </aside>

        <main className="agent-column">
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
              <strong className="muted">disabled</strong>
            </div>
            <div className="status-line">
              <span>Network</span>
              <strong>{appInfo?.networkMode ?? "online"}</strong>
            </div>
            <div className="status-line">
              <span>Cloud model fallback</span>
              <strong>off</strong>
            </div>
          </div>

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

            <button
              className="agent-start-button"
              type="button"
              disabled={!canStartAgent}
              onClick={() => void startAgent()}
            >
              {agentStatus === "starting"
                ? "Starting Pi…"
                : bindingMatchesSelection
                  ? "Restart Pi agent"
                  : "Start Pi agent"}
            </button>
          </div>

          <div className="status-card">
            <span className="eyebrow">Desktop</span>
            <p className="detail">{appInfo ? `${appInfo.name} ${appInfo.version}` : "Loading…"}</p>
            <p className="detail">{appInfo?.platform ?? "—"}</p>
          </div>

          <div className="status-card">
            <span className="eyebrow">Next</span>
            <ol>
              <li>Replace placeholder Explorer with real workspace files.</li>
              <li>Add project-wide Changes/Diff review.</li>
              <li>Add permission policy for shell, edits, and network.</li>
              <li>Add browser/search network tools.</li>
              <li>Add terminal and session persistence UI.</li>
            </ol>
          </div>
        </aside>
      </div>

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
