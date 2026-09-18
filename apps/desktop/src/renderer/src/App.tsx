import { useEffect, useMemo, useState } from "react";

interface AppInfo {
  name: string;
  version: string;
  platform: string;
  offlineFirst: boolean;
}

interface LocalModel {
  provider: string;
  id: string;
  name: string;
  local: boolean;
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

export function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle", models: [] });
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    void window.kripl.getAppInfo().then(setAppInfo);
  }, []);

  const workspaceName = useMemo(
    () => (workspace ? basename(workspace) : "No project opened"),
    [workspace]
  );

  const modelReady = probe.status === "ready" && probe.models.length > 0;

  async function openWorkspace() {
    const selected = await window.kripl.pickWorkspace();
    if (selected) setWorkspace(selected);
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
          offline-first
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
            <span className="engine-label">Pi adapter · disconnected</span>
          </div>

          <div className="conversation">
            <section className="welcome-card">
              <span className="eyebrow">Kripl Studio bootstrap</span>
              <h2>Local coding without a cloud dependency.</h2>
              <p>
                The desktop shell is separated from the agent, model, memory, and workspace
                runtimes. The local-model gate now accepts only loopback OpenAI-compatible
                endpoints; Pi will be connected after a local model is selected.
              </p>
              <div className="capability-row">
                <span>AgentRuntime</span>
                <span>ModelProvider</span>
                <span>MemoryRuntime</span>
                <span>WorkspaceRuntime</span>
              </div>
            </section>
          </div>

          <div className="composer">
            <textarea
              disabled
              rows={2}
              placeholder={
                modelReady && workspace
                  ? "Local model selected. Pi session wiring is the next step…"
                  : "Open a project and connect a local model first…"
              }
            />
            <button type="button" disabled>
              Send
            </button>
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
              <strong className="muted">not started</strong>
            </div>
            <div className="status-line">
              <span>Memory</span>
              <strong className="muted">disabled</strong>
            </div>
            <div className="status-line">
              <span>Cloud fallback</span>
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
          </div>

          <div className="status-card">
            <span className="eyebrow">Desktop</span>
            <p className="detail">{appInfo ? `${appInfo.name} ${appInfo.version}` : "Loading…"}</p>
            <p className="detail">{appInfo?.platform ?? "—"}</p>
          </div>

          <div className="status-card">
            <span className="eyebrow">Next</span>
            <ol>
              <li>Bind selected local model to Pi.</li>
              <li>Start/stop Pi RPC per workspace.</li>
              <li>Normalize streaming agent/tool events.</li>
              <li>Enable the composer.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
