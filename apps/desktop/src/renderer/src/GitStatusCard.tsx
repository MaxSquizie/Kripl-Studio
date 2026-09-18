import type {
  WorkspaceCommitResult,
  WorkspaceGitStatus
} from "@kripl/core";
import { useEffect, useState } from "react";

function headLabel(status: WorkspaceGitStatus): string {
  if (status.branch) return status.branch;
  if (status.detached) return "detached HEAD";
  return "unborn branch";
}

export function GitStatusCard({
  status,
  repository,
  onCommit
}: {
  status: WorkspaceGitStatus | null;
  repository: boolean;
  onCommit(message: string): Promise<WorkspaceCommitResult>;
}) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [lastCommit, setLastCommit] = useState<WorkspaceCommitResult | null>(null);

  useEffect(() => {
    setError("");
    setLastCommit(null);
  }, [status?.headSha, status?.branch]);

  if (!repository) return null;

  const blockedByConflict = Boolean(status?.conflicted);
  const canCommit =
    Boolean(status) &&
    status!.staged > 0 &&
    !blockedByConflict &&
    Boolean(message.trim()) &&
    !committing;

  async function commit() {
    const text = message.trim();
    if (!canCommit || !text) return;

    setCommitting(true);
    setError("");
    try {
      const result = await onCommit(text);
      setLastCommit(result);
      setMessage("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="status-card git-status-card">
      <div className="git-card-heading">
        <span className="eyebrow">Git</span>
        <span className="git-branch" title={status?.headSha}>
          {status ? headLabel(status) : "loading"}
        </span>
      </div>

      <div className="git-counts">
        <span><strong>{status?.staged ?? 0}</strong> staged</span>
        <span><strong>{status?.unstaged ?? 0}</strong> unstaged</span>
        <span><strong>{status?.untracked ?? 0}</strong> untracked</span>
        {(status?.conflicted ?? 0) > 0 && (
          <span className="conflicted"><strong>{status?.conflicted}</strong> conflicts</span>
        )}
      </div>

      {status?.headSha && (
        <p className="git-head" title={status.headSha}>
          HEAD {status.headSha.slice(0, 12)}
        </p>
      )}

      <label className="settings-field">
        <span>Commit staged changes</span>
        <textarea
          className="git-commit-message"
          value={message}
          maxLength={10_000}
          rows={3}
          spellCheck={false}
          placeholder={
            status?.staged
              ? "Commit message…"
              : "Stage one or more files first…"
          }
          disabled={!status || status.staged === 0 || blockedByConflict}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
        />
      </label>

      {blockedByConflict && (
        <p className="probe-result error">Resolve conflicts before committing.</p>
      )}
      {error && <p className="probe-result error">{error}</p>}
      {lastCommit && (
        <p className="probe-result ready">
          Committed {lastCommit.shortSha}
        </p>
      )}

      <button
        className="primary-button"
        type="button"
        disabled={!canCommit}
        onClick={() => void commit()}
      >
        {committing ? "Committing…" : "Commit staged"}
      </button>

      <p className="settings-hint">
        Local commit only. Hooks and GPG signing are disabled; no network operation is performed.
      </p>
    </div>
  );
}
