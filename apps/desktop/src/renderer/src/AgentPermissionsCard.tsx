import type { DesktopRuntimeSettings, PermissionEffect, PermissionScope } from "@kripl/core";
import { memo, useEffect, useState } from "react";
import { CollapsibleDetails } from "./CollapsibleDetails";

const EFFECTS: PermissionEffect[] = ["allow", "ask", "deny"];

const PERMISSION_ROWS: Array<{ scope: PermissionScope; label: string; group: string }> = [
  { scope: "filesystem.read.workspace", label: "Read workspace", group: "Filesystem" },
  { scope: "filesystem.read.outside", label: "Read outside project", group: "Filesystem" },
  { scope: "filesystem.write.workspace", label: "Write in project", group: "Filesystem" },
  { scope: "filesystem.write.sensitive", label: "Write sensitive files", group: "Filesystem" },
  { scope: "filesystem.write.outside", label: "Write outside project", group: "Filesystem" },
  { scope: "shell.safe", label: "Shell commands", group: "Shell" },
  { scope: "shell.dangerous", label: "Dangerous shell", group: "Shell" },
  { scope: "network.search", label: "Web search", group: "Network" },
  { scope: "network.read", label: "Web / browser read", group: "Network" },
  { scope: "network.write", label: "Browser write", group: "Network" },
  { scope: "network.auth", label: "Authenticated network", group: "Network" },
  { scope: "tool.unknown", label: "Unknown tools", group: "Other" }
];

function cloneRules(settings: DesktopRuntimeSettings) {
  return { ...settings.permissions.rules };
}

export const AgentPermissionsCard = memo(function AgentPermissionsCard({
  settings,
  onApply,
  embedded = false
}: {
  settings: DesktopRuntimeSettings;
  onApply(next: DesktopRuntimeSettings): Promise<void>;
  embedded?: boolean;
}) {
  const [draft, setDraft] = useState<Partial<Record<PermissionScope, PermissionEffect>>>(
    () => cloneRules(settings)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rulesVersion = JSON.stringify(settings.permissions.rules);

  useEffect(() => {
    setDraft(cloneRules(settings));
    setError("");
  }, [rulesVersion]);

  const dirty = PERMISSION_ROWS.some(
    (row) => (draft[row.scope] ?? "ask") !== (settings.permissions.rules[row.scope] ?? "ask")
  );

  function setEffect(scope: PermissionScope, effect: PermissionEffect) {
    setDraft((current) => ({ ...current, [scope]: effect }));
  }

  async function apply() {
    setSaving(true);
    setError("");
    try {
      await onApply({
        ...settings,
        permissions: { version: 1, rules: draft }
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  let currentGroup = "";

  const contents = (
    <>
      {settings.networkMode !== "online" && (
        <p className="permissions-mode-hint">
          Network mode is {settings.networkMode}: network rules are{" "}
          {settings.networkMode === "offline" ? "forced to deny" : "upgraded to ask"}.
        </p>
      )}

      <div className="permission-settings-body permissions-list">
        {PERMISSION_ROWS.map((row) => {
          const showGroup = row.group !== currentGroup;
          currentGroup = row.group;
          const selected: PermissionEffect = draft[row.scope] ?? "ask";
          return (
            <div key={row.scope}>
              {showGroup && <div className="permission-group">{row.group}</div>}
              <label className="permission-setting">
                <span>{row.label}</span>
                <select value={selected} disabled={saving} onChange={(event) => setEffect(row.scope, event.target.value as PermissionEffect)}>
                  {EFFECTS.map((effect) => (
                    <option key={effect} value={effect}>
                      {effect}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>

      {error && <p className="probe-result error" role="alert">{error}</p>}

      <div className="settings-actions">
        {embedded && (
          <button
            type="button"
            className="secondary-button"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(cloneRules(settings));
              setError("");
            }}
          >
            Reset
          </button>
        )}
        <button
          type="button"
          className={embedded ? "primary-button" : "apply-check" + (dirty && !saving ? " ready" : "")}
          title={dirty ? "Apply permission changes" : "No pending changes"}
          aria-label="Apply permissions"
          disabled={!dirty || saving}
          onClick={() => void apply()}
        >
          {embedded ? (saving ? "Applying…" : "Apply permissions") : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>}
        </button>
      </div>

      {dirty && (
        <p className="settings-hint">Applying stops the active agent; the next run uses the new policy.</p>
      )}
    </>
  );

  if (embedded) {
    return <div className="settings-embedded">{contents}</div>;
  }

  return (
    <CollapsibleDetails
      className="status-card permissions-card"
      bodyClassName="permissions-body"
      summary={
        <>
          <span>Agent permissions</span>
          <span className="chevrons" aria-hidden="true">
            <svg className="chevron-down" width="14" height="9" viewBox="0 0 14 9" fill="none">
              <path d="M2 2.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="chevron-up" width="14" height="9" viewBox="0 0 14 9" fill="none">
              <path d="M2 6.5l5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </>
      }
    >
      {contents}
    </CollapsibleDetails>
  );
});
