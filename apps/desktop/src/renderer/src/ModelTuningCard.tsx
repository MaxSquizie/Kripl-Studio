import type { DesktopRuntimeSettings } from "@kripl/core";
import { useEffect, useState } from "react";
import { CollapsibleDetails } from "./CollapsibleDetails";

interface TuningDraft {
  systemPrompt: string;
  customTemperature: boolean;
  temperature: number;
}

function toDraft(settings: DesktopRuntimeSettings): TuningDraft {
  const tuning = settings.modelTuning;
  return {
    systemPrompt: tuning?.systemPrompt ?? "",
    customTemperature: tuning?.temperature !== undefined,
    temperature: tuning?.temperature ?? 0.7
  };
}

export function ModelTuningCard({
  settings,
  onApply
}: {
  settings: DesktopRuntimeSettings;
  onApply(next: DesktopRuntimeSettings): Promise<void>;
}) {
  const [draft, setDraft] = useState<TuningDraft>(() => toDraft(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(toDraft(settings));
    setError("");
  }, [settings]);

  const current = settings.modelTuning;
  const dirty =
    (draft.systemPrompt.trim() || undefined) !== (current?.systemPrompt?.trim() || undefined) ||
    draft.customTemperature !== (current?.temperature !== undefined) ||
    (draft.customTemperature && draft.temperature !== current?.temperature);

  async function apply() {
    setSaving(true);
    setError("");
    try {
      const modelTuning: Record<string, unknown> = {};
      if (draft.systemPrompt.trim()) modelTuning.systemPrompt = draft.systemPrompt.trim();
      if (draft.customTemperature) modelTuning.temperature = draft.temperature;

      await onApply({
        networkMode: settings.networkMode,
        modelRouting: settings.modelRouting,
        permissions: { ...settings.permissions, rules: { ...settings.permissions.rules } },
        ...(Object.keys(modelTuning).length > 0 ? { modelTuning } : {})
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleDetails
      className="status-card permissions-card model-tuning-card"
      bodyClassName="permissions-body"
      summary={
        <>
          <span>Model settings</span>
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
      <div className="permission-settings-body model-tuning-body">
        <label className="model-tuning-field">
          <span>System prompt</span>
          <textarea
            rows={4}
            placeholder="Extra instructions for the agent, e.g. “Always answer in Russian. Prefer small edits.”"
            value={draft.systemPrompt}
            onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
          />
        </label>

        <div className="model-tuning-field">
          <span>Temperature</span>
          <div className="temperature-row">
            <input
              type="checkbox"
              id="kripl-custom-temperature"
              checked={draft.customTemperature}
              onChange={(event) => setDraft((current) => ({ ...current, customTemperature: event.target.checked }))}
            />
            <label htmlFor="kripl-custom-temperature">custom</label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              disabled={!draft.customTemperature}
              value={draft.temperature}
              onChange={(event) => setDraft((current) => ({ ...current, temperature: Number(event.target.value) }))}
            />
            <span className="temperature-value">{draft.customTemperature ? draft.temperature.toFixed(1) : "default"}</span>
          </div>
        </div>
      </div>

      {error && <p className="probe-result error">{error}</p>}

      <div className="settings-actions">
        <button
          type="button"
          className={"apply-check" + (dirty && !saving ? " ready" : "")}
          title={dirty ? "Apply model settings" : "No pending changes"}
          disabled={!dirty || saving}
          onClick={() => void apply()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {dirty && (
        <p className="settings-hint">
          Applying stops the active agent; temperature takes effect on the next start, system prompt from the next message.
        </p>
      )}
    </CollapsibleDetails>
  );
}
