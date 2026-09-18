import { useEffect, useMemo, useState } from "react";

interface AppInfo {
  name: string;
  version: string;
  platform: string;
  offlineFirst: boolean;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.kripl.getAppInfo().then(setAppInfo);
  }, []);

  const workspaceName = useMemo(
    () => (workspace ? basename(workspace) : "No project opened"),
    [workspace]
  );

  async function openWorkspace() {
    const selected = await window.kripl.pickWorkspace();
    if (selected) setWorkspace(selected);
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
                runtimes. Pi will be the first agent backend; AG Memory can be attached later
                without replacing the UI.
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
              placeholder={workspace ? "Agent connection is the next implementation step…" : "Open a project first…"}
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
              <span>Agent</span>
              <strong className="muted">not started</strong>
            </div>
            <div className="status-line">
              <span>Memory</span>
              <strong className="muted">disabled</strong>
            </div>
            <div className="status-line">
              <span>Network fallback</span>
              <strong>off</strong>
            </div>
          </div>

          <div className="status-card">
            <span className="eyebrow">Desktop</span>
            <p className="detail">{appInfo ? `${appInfo.name} ${appInfo.version}` : "Loading…"}</p>
            <p className="detail">{appInfo?.platform ?? "—"}</p>
          </div>

          <div className="status-card">
            <span className="eyebrow">Next</span>
            <ol>
              <li>Connect Pi RPC lifecycle.</li>
              <li>Discover local models.</li>
              <li>Stream agent/tool events.</li>
              <li>Add Explorer and Changes.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
