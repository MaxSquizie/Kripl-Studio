import type { AgentSessionSummary } from "@kripl/core";

function sessionLabel(session: AgentSessionSummary): string {
  const title = session.name?.trim() || session.firstMessage.trim() || "Untitled session";
  return title.length <= 72 ? title : title.slice(0, 72) + "…";
}

function modifiedLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function AgentSessionCard({
  sessions,
  selectedPath,
  active,
  disabled,
  starting,
  onSelect,
  onStart
}: {
  sessions: AgentSessionSummary[];
  selectedPath: string;
  active: boolean;
  disabled: boolean;
  starting: boolean;
  onSelect(path: string): void;
  onStart(): void;
}) {
  const selected = sessions.find((session) => session.path === selectedPath);

  return (
    <div className="status-card agent-session-card">
      <div className="session-card-heading">
        <span className="eyebrow">Pi session</span>
        <span className={"session-mode " + (selected ? "resume" : "new")}>
          {selected ? "resume" : "new"}
        </span>
      </div>

      <label className="settings-field">
        <span>Conversation</span>
        <select
          value={selectedPath}
          onChange={(event) => onSelect(event.target.value)}
          disabled={starting}
        >
          <option value="">New session</option>
          {sessions.map((session) => (
            <option key={session.path} value={session.path}>
              {sessionLabel(session)}
            </option>
          ))}
        </select>
      </label>

      {selected ? (
        <div className="session-detail">
          <strong>{sessionLabel(selected)}</strong>
          <span>
            {selected.messageCount} messages · {modifiedLabel(selected.modifiedAt)}
          </span>
          <small title={selected.path}>{selected.path}</small>
        </div>
      ) : (
        <p className="settings-hint">
          Start a clean Pi conversation for this workspace.
        </p>
      )}

      <button
        className="agent-start-button"
        type="button"
        disabled={disabled}
        onClick={onStart}
      >
        {starting
          ? "Starting Pi…"
          : active
            ? selected
              ? "Restart / resume Pi"
              : "Restart Pi agent"
            : selected
              ? "Resume Pi session"
              : "Start new Pi session"}
      </button>
    </div>
  );
}
