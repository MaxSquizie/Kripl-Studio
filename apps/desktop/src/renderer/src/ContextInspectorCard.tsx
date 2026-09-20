import type {
  ContextInspectorSnapshot,
  RuntimeEvent,
  RuntimeEventEnvelope
} from "@kripl/core";
import { useMemo, useState } from "react";

function shortText(value: string, limit = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : compact.slice(0, limit) + "…";
}

function eventTitle(event: RuntimeEvent): string {
  switch (event.type) {
    case "user.message":
      return "User message";
    case "workspace.opened":
      return "Workspace opened";
    case "workspace.file.opened":
      return "File opened";
    case "workspace.diff.opened":
      return "Diff opened";
    case "browser.state":
      return "Browser";
    case "terminal.session":
      return "Terminal";
    case "memory.query":
      return "Memory query";
    case "memory.retrieved":
      return "Memory retrieval";
    case "memory.status":
      return "Memory status";
    case "agent.status":
      return "Agent status";
    case "agent.message":
      return "Agent message";
    case "agent.turn":
      return "Agent turn";
    case "agent.stream":
      return event.channel === "thinking" ? "Reasoning stream" : "Assistant stream";
    case "agent.tool":
      return "Tool";
    case "agent.interaction":
      return "Permission interaction";
    case "agent.usage":
      return "Token usage";
    case "agent.notification":
      return "Agent notification";
    case "agent.raw":
      return "Raw agent event";
  }
}

function eventDetail(event: RuntimeEvent): string {
  switch (event.type) {
    case "user.message":
      return shortText(event.text);
    case "workspace.opened":
      return event.path;
    case "workspace.file.opened":
      return event.path + " · " + event.sizeBytes + " B" + (event.binary ? " · binary" : "");
    case "workspace.diff.opened":
      return event.path;
    case "browser.state":
      if (!event.visible) return "hidden";
      return shortText(event.title || event.url || "open");
    case "terminal.session":
      return [event.status, event.shell, event.cwd].filter(Boolean).join(" · ");
    case "memory.query":
      return shortText(event.text);
    case "memory.retrieved":
      return event.itemIds.length + " item(s)";
    case "memory.status":
      return event.runtimeId + " · " + event.status;
    case "agent.status":
      return event.status + (event.message ? " · " + shortText(event.message) : "");
    case "agent.message":
      return event.role + " · " + shortText(event.text);
    case "agent.turn":
      return event.phase;
    case "agent.stream":
      if (event.phase === "completed") return event.phase + " · " + shortText(event.content);
      return event.phase;
    case "agent.tool":
      return event.name + " · " + event.phase;
    case "agent.interaction":
      return event.request.kind + " · " + event.request.title;
    case "agent.usage": {
      const context = (event.input ?? 0) + (event.cacheRead ?? 0);
      return `ctx ≈ ${context} · out ${event.output ?? 0}`;
    }
    case "agent.notification":
      return event.level + " · " + shortText(event.message);
    case "agent.raw":
      return event.source;
  }
}

function eventTime(envelope: RuntimeEventEnvelope): string {
  return new Date(envelope.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function ContextInspectorCard({
  snapshot,
  onRetrieve
}: {
  snapshot: ContextInspectorSnapshot | null;
  onRetrieve(query: string): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [retrieving, setRetrieving] = useState(false);
  const [error, setError] = useState("");

  const recent = useMemo(
    () => snapshot?.recentEvents.slice(-18).reverse() ?? [],
    [snapshot]
  );

  const health = snapshot?.memoryHealth;
  const canRetrieve =
    Boolean(query.trim()) &&
    !retrieving &&
    (health?.status === "ready" || health?.status === "degraded");

  async function retrieve() {
    const text = query.trim();
    if (!text || !canRetrieve) return;

    setRetrieving(true);
    setError("");
    try {
      await onRetrieve(text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRetrieving(false);
    }
  }

  return (
    <div className="status-card context-inspector-card">
      <div className="context-card-heading">
        <span className="eyebrow">Context / Memory</span>
        <span className={"memory-health " + (health?.status ?? "disabled")}>
          {health?.status ?? "loading"}
        </span>
      </div>

      <div className="status-line">
        <span>Runtime</span>
        <strong className={health?.status === "ready" ? "" : "muted"}>
          {snapshot?.memoryRuntimeId ?? "—"}
        </strong>
      </div>

      {health?.message && <p className="settings-hint">{health.message}</p>}

      <label className="context-query">
        <span>Memory query</span>
        <div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void retrieve();
              }
            }}
            disabled={health?.status === "disabled" || health?.status === "error"}
            placeholder={
              health?.status === "disabled"
                ? "Connect a MemoryRuntime first"
                : "Search active memory…"
            }
          />
          <button
            className="secondary-button"
            type="button"
            disabled={!canRetrieve}
            onClick={() => void retrieve()}
          >
            {retrieving ? "…" : "Find"}
          </button>
        </div>
      </label>

      {error && <p className="probe-result error">{error}</p>}

      {snapshot && snapshot.retrievedMemory.length > 0 && (
        <details className="context-section" open>
          <summary>Retrieved memory · {snapshot.retrievedMemory.length}</summary>
          <div className="memory-results">
            {snapshot.retrievedMemory.map((item) => (
              <article className="memory-result" key={item.id}>
                <div>
                  <strong>{item.kind}</strong>
                  <span>{Math.round(item.relevance * 100)}%</span>
                </div>
                <p>{shortText(item.content, 220)}</p>
                {item.source && <small>{item.source}</small>}
              </article>
            ))}
          </div>
        </details>
      )}

      <details className="context-section">
        <summary>Runtime journal · {snapshot?.recentEvents.length ?? 0}</summary>
        <div className="context-event-list">
          {recent.length === 0 && <p className="settings-hint">No runtime events yet.</p>}
          {recent.map((envelope) => (
            <div className="context-event" key={envelope.id}>
              <span className="context-event-time">{eventTime(envelope)}</span>
              <div>
                <strong>{eventTitle(envelope.event)}</strong>
                <p title={eventDetail(envelope.event)}>{eventDetail(envelope.event)}</p>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
