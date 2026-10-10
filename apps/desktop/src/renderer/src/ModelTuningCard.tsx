import type { DesktopRuntimeSettings, ModelTuning } from "@kripl/core";
import { memo, useEffect, useId, useState } from "react";
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

export const ModelTuningCard = memo(function ModelTuningCard({
  settings,
  onApply,
  embedded = false
}: {
  settings: DesktopRuntimeSettings;
  onApply(next: DesktopRuntimeSettings): Promise<void>;
  embedded?: boolean;
}) {
  const [draft, setDraft] = useState<TuningDraft>(() => toDraft(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const temperatureId = useId();
  const currentSystemPrompt = settings.modelTuning?.systemPrompt ?? "";
  const currentTemperature = settings.modelTuning?.temperature;

  useEffect(() => {
    setDraft({
      systemPrompt: currentSystemPrompt,
      customTemperature: currentTemperature !== undefined,
      temperature: currentTemperature ?? 0.7
    });
    setError("");
  }, [currentSystemPrompt, currentTemperature]);

  const current = settings.modelTuning;
  const dirty =
    (draft.systemPrompt.trim() || undefined) !== (current?.systemPrompt?.trim() || undefined) ||
    draft.customTemperature !== (current?.temperature !== undefined) ||
    (draft.customTemperature && draft.temperature !== current?.temperature);

  async function apply() {
    setSaving(true);
    setError("");
    try {
      const modelTuning: ModelTuning = {};
      if (draft.systemPrompt.trim()) modelTuning.systemPrompt = draft.systemPrompt.trim();
      if (draft.customTemperature) modelTuning.temperature = draft.temperature;

      const next = { ...settings };
      if (Object.keys(modelTuning).length > 0) next.modelTuning = modelTuning;
      else delete next.modelTuning;
      await onApply(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const contents = (
    <>
      <div className="permission-settings-body model-tuning-body">
        <label className="model-tuning-field">
          <span>System prompt</span>
          <textarea
            rows={4}
            placeholder="Extra instructions for the agent, e.g. “Always answer in Russian. Prefer small edits.”"
            value={draft.systemPrompt}
            disabled={saving}
            onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
          />
        </label>

        <div className="model-tuning-field">
          <span>Temperature</span>
          <div className="temperature-row">
            <input
              type="checkbox"
              id={temperatureId}
              checked={draft.customTemperature}
              disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, customTemperature: event.target.checked }))}
            />
            <label htmlFor={temperatureId}>Custom</label>
            <input
              type="range"
              aria-label="Temperature"
              min={0}
              max={2}
              step={0.1}
              disabled={!draft.customTemperature || saving}
              value={draft.temperature}
              onChange={(event) => setDraft((current) => ({ ...current, temperature: Number(event.target.value) }))}
            />
            <span className="temperature-value">{draft.customTemperature ? draft.temperature.toFixed(1) : "default"}</span>
          </div>
        </div>
      </div>

      {error && <p className="probe-result error" role="alert">{error}</p>}

      <div className="settings-actions">
        {embedded && (
          <button
            type="button"
            className="secondary-button"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(toDraft(settings));
              setError("");
            }}
          >
            Reset
          </button>
        )}
        <button
          type="button"
          className={embedded ? "primary-button" : "apply-check" + (dirty && !saving ? " ready" : "")}
          title={dirty ? "Apply model settings" : "No pending changes"}
          aria-label="Apply model settings"
          disabled={!dirty || saving}
          onClick={() => void apply()}
        >
          {embedded ? (saving ? "Applying…" : "Apply model settings") : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>}
        </button>
      </div>

      {dirty && (
        <p className="settings-hint">
          Applying stops the active agent; temperature takes effect on the next start, system prompt from the next message.
        </p>
      )}
    </>
  );

  if (embedded) {
    return <div className="settings-embedded model-tuning-card">{contents}</div>;
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
      {contents}
    </CollapsibleDetails>
  );
});
