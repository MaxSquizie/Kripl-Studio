import type {
  DesktopRuntimeSettings,
  NetworkMode,
  PermissionEffect,
  PermissionScope
} from "@kripl/core";
import { useEffect, useState } from "react";

const EFFECTS: PermissionEffect[] = ["allow", "ask", "deny"];

const PERMISSION_ROWS: Array<{
  scope: PermissionScope;
  label: string;
  group: string;
}> = [
  { scope: "filesystem.read.workspace", label: "Read workspace", group: "Filesystem" },
  { scope: "filesystem.read.outside", label: "Read outside", group: "Filesystem" },
  { scope: "filesystem.write.workspace", label: "Write workspace", group: "Filesystem" },
  { scope: "filesystem.write.sensitive", label: "Write sensitive", group: "Filesystem" },
  { scope: "filesystem.write.outside", label: "Write outside", group: "Filesystem" },
  { scope: "shell.safe", label: "Shell commands", group: "Shell" },
  { scope: "shell.dangerous", label: "Dangerous shell", group: "Shell" },
  { scope: "network.search", label: "Web search", group: "Network" },
  { scope: "network.read", label: "Web/browser read", group: "Network" },
  { scope: "network.write", label: "Browser write", group: "Network" },
  { scope: "network.auth", label: "Authenticated network", group: "Network" },
  { scope: "tool.unknown", label: "Unknown tools", group: "Other" }
];

function cloneSettings(settings: DesktopRuntimeSettings): DesktopRuntimeSettings {
  return {
    networkMode: settings.networkMode,
    modelRouting: settings.modelRouting,
    permissions: {
      version: 1,
      rules: { ...settings.permissions.rules }
    }
  };
}

function modeDescription(mode: NetworkMode): string {
  if (mode === "online") return "Local model with network tools enabled by permission policy.";
  if (mode === "restricted") return "Network reads and writes require approval unless already denied.";
  return "External network tools and browser HTTP(S) traffic are blocked.";
}

export function RuntimeSettingsCard({
  settings,
  onApply
}: {
  settings: DesktopRuntimeSettings;
  onApply(settings: DesktopRuntimeSettings): Promise<void>;
}) {
  const [draft, setDraft] = useState<DesktopRuntimeSettings>(() => cloneSettings(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(cloneSettings(settings));
    setError("");
  }, [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  function setNetworkMode(networkMode: NetworkMode) {
    setDraft((current) => ({
      ...current,
      networkMode
    }));
  }

  function setPermission(scope: PermissionScope, effect: PermissionEffect) {
    setDraft((current) => ({
      ...current,
      permissions: {
        version: 1,
        rules: {
          ...current.permissions.rules,
          [scope]: effect
        }
      }
    }));
  }

  async function apply() {
    setSaving(true);
    setError("");
    try {
      await onApply(cloneSettings(draft));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  let currentGroup = "";

  return (
    <div className="status-card runtime-settings-card">
      <span className="eyebrow">Runtime policy</span>

      <label className="settings-field">
        <span>Network mode</span>
        <select
          value={draft.networkMode}
          onChange={(event) => setNetworkMode(event.target.value as NetworkMode)}
        >
          <option value="online">Online</option>
          <option value="restricted">Restricted</option>
          <option value="offline">Offline</option>
        </select>
      </label>

      <p className="settings-hint">{modeDescription(draft.networkMode)}</p>
      <div className="status-line">
        <span>Model routing</span>
        <strong>local-only</strong>
      </div>

      <details className="permission-settings">
        <summary>Advanced permissions</summary>
        <div className="permission-settings-body">
          {PERMISSION_ROWS.map((row) => {
            const showGroup = row.group !== currentGroup;
            currentGroup = row.group;
            const selected = draft.permissions.rules[row.scope] ?? "ask";
            const networkOverride =
              row.group === "Network" && draft.networkMode !== "online";

            return (
              <div className="permission-setting-wrap" key={row.scope}>
                {showGroup && <div className="permission-group">{row.group}</div>}
                <label className="permission-setting">
                  <span>
                    {row.label}
                    {networkOverride && (
                      <small>
                        {draft.networkMode === "offline" ? "effective: deny" : "effective: ask"}
                      </small>
                    )}
                  </span>
                  <select
                    value={selected}
                    onChange={(event) =>
                      setPermission(row.scope, event.target.value as PermissionEffect)
                    }
                  >
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
      </details>

      {error && <p className="probe-result error">{error}</p>}

      <div className="settings-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!dirty || saving}
          onClick={() => setDraft(cloneSettings(settings))}
        >
          Reset
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!dirty || saving}
          onClick={() => void apply()}
        >
          {saving ? "Applying…" : "Apply"}
        </button>
      </div>

      {dirty && (
        <p className="settings-hint">
          Applying runtime policy stops the active agent so the next Pi process gets the new policy.
        </p>
      )}
    </div>
  );
}
