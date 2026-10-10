import { memo } from "react";
import type {
  ContextInspectorSnapshot,
  DesktopRuntimeSettings,
  ModelDescriptor,
  WorkspaceCommitResult,
  WorkspaceDescriptor,
  WorkspaceGitStatus
} from "@kripl/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { AgentPermissionsCard } from "./AgentPermissionsCard";
import { ContextInspectorCard } from "./ContextInspectorCard";
import { GitStatusCard } from "./GitStatusCard";
import { ModelTuningCard } from "./ModelTuningCard";

export type SettingsModelProbe =
  | { status: "idle" | "checking" | "ready"; models: ModelDescriptor[] }
  | { status: "error"; models: ModelDescriptor[]; message: string };

export interface SettingsDialogProps {
  endpoint: string;
  onEndpointChange(value: string): void;
  defaultEndpoint: string;
  probe: SettingsModelProbe;
  onProbe(): Promise<void>;
  selectedModel: string;
  onModelChange(value: string): void;
  contextWindowOverride: number | undefined;
  onContextWindowOverrideChange(value: number | undefined): void;
  defaultContextWindow: number;
  contextSnapshot: ContextInspectorSnapshot | null;
  onRetrieveMemory(query: string): Promise<void>;
  gitStatus: WorkspaceGitStatus | null;
  workspace: WorkspaceDescriptor | null;
  onCommit(message: string): Promise<WorkspaceCommitResult>;
  appInfo: { name: string; version: string; platform: string } | null;
  runtimeSettings: DesktopRuntimeSettings | null;
  onApplyRuntimeSettings(settings: DesktopRuntimeSettings): Promise<void>;
  onClose(): void;
}

const SECTIONS = [
  { id: "model", title: "Model" },
  { id: "context", title: "Context" },
  { id: "project", title: "Project" },
  { id: "about", title: "About" }
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const FOCUSABLE = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[tabindex]"
].join(",");

function isOutsideDialog(event: PointerEvent<HTMLDialogElement>): boolean {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
}

/** Mounted only while settings are open. Native modality also makes the app inert. */
export const SettingsDialog = memo(function SettingsDialog(props: SettingsDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tabRefs = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});
  const backdropPointerDown = useRef(false);
  const [section, setSection] = useState<SectionId>("model");
  const [visited, setVisited] = useState<Partial<Record<SectionId, boolean>>>({ model: true });
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 640px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialog.showModal();
    tabRefs.current.model?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  function selectSection(next: SectionId) {
    setSection(next);
    setVisited((current) => current[next] ? current : { ...current, [next]: true });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: SectionId) {
    const index = SECTIONS.findIndex((item) => item.id === current);
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % SECTIONS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + SECTIONS.length - 1) % SECTIONS.length;
    else return;
    event.preventDefault();
    const target = SECTIONS[next];
    if (!target) return;
    selectSection(target.id);
    tabRefs.current[target.id]?.focus({ preventScroll: true });
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    // Workspace shortcuts should not open other dialogs behind this modal.
    event.stopPropagation();
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") &&
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const selectedModel = props.probe.models.find((model) => model.id === props.selectedModel);
  const modelListReady = props.probe.status === "ready" && props.probe.models.length > 0;
  const detectedContextWindow = selectedModel?.contextWindow;

  return (
    <dialog
      className="settings-window"
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onKeyDown={onDialogKeyDown}
      onPointerDown={(event) => {
        backdropPointerDown.current = event.target === event.currentTarget && isOutsideDialog(event);
      }}
      onPointerUp={(event) => {
        if (backdropPointerDown.current && event.target === event.currentTarget && isOutsideDialog(event)) {
          props.onClose();
        }
        backdropPointerDown.current = false;
      }}
    >
      <header className="settings-window-header">
        <h2 id={`${id}-title`}>Settings</h2>
        <button
          type="button"
          className="icon-button settings-window-close"
          aria-label="Close settings"
          title="Close settings (Esc)"
          onClick={props.onClose}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="m3 3 8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="settings-window-body">
        <aside className="settings-navigation">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation={compact ? "horizontal" : "vertical"}>
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                ref={(element) => { tabRefs.current[item.id] = element; }}
                type="button"
                role="tab"
                id={`${id}-tab-${item.id}`}
                aria-controls={`${id}-panel-${item.id}`}
                aria-selected={section === item.id}
                tabIndex={section === item.id ? 0 : -1}
                className="settings-tab"
                onClick={() => selectSection(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, item.id)}
              >
                {item.title}
              </button>
            ))}
          </div>
          <span className="settings-navigation-version">{props.appInfo ? `v${props.appInfo.version}` : "Kripl Studio"}</span>
        </aside>

        <div className="settings-panels">
          {/* Keep visited forms mounted so switching sections preserves unsaved edits. */}
          <div role="tabpanel" id={`${id}-panel-model`} aria-labelledby={`${id}-tab-model`} hidden={section !== "model"} tabIndex={0} className="settings-panel">
            <div className="settings-panel-heading">
              <h3>Model</h3>
              <p>Connect a local server and adjust the agent’s responses.</p>
            </div>

            <section className="settings-section" aria-labelledby={`${id}-server-heading`}>
              <h4 id={`${id}-server-heading`}>Local server</h4>
              <form className="settings-connection" onSubmit={(event) => { event.preventDefault(); void props.onProbe(); }}>
                <label className="settings-control" htmlFor={`${id}-endpoint`}>
                  <span>OpenAI-compatible endpoint</span>
                  <input id={`${id}-endpoint`} value={props.endpoint} onChange={(event) => props.onEndpointChange(event.target.value)} spellCheck={false} autoComplete="off" placeholder={props.defaultEndpoint} />
                </label>
                <button className="primary-button" type="submit" disabled={props.probe.status === "checking"}>
                  {props.probe.status === "checking" ? "Connecting…" : "Connect"}
                </button>
              </form>

              <div className="settings-connection-status" role={props.probe.status === "error" ? "alert" : "status"}>
                {props.probe.status === "idle" && <p>Default: LM Studio on port 1234.</p>}
                {props.probe.status === "checking" && <p>Checking the local server…</p>}
                {props.probe.status === "error" && <p className="error">{props.probe.message}</p>}
                {props.probe.status === "ready" && <p className={modelListReady ? "ready" : ""}>{modelListReady
                  ? `${props.probe.models.length} local model${props.probe.models.length === 1 ? "" : "s"} available.`
                  : "Server connected. Load a model on the server, then connect again."}</p>}
              </div>

              <label className="settings-control" htmlFor={`${id}-model`}>
                <span>Model</span>
                <select id={`${id}-model`} value={selectedModel ? props.selectedModel : ""} onChange={(event) => props.onModelChange(event.target.value)} disabled={!modelListReady}>
                  {!selectedModel && <option value="">{modelListReady ? "Choose a model" : "Connect to load models"}</option>}
                  {props.probe.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
            </section>

            <section className="settings-section" aria-labelledby={`${id}-responses-heading`}>
              <h4 id={`${id}-responses-heading`}>Responses</h4>
              {props.runtimeSettings
                ? <ModelTuningCard settings={props.runtimeSettings} onApply={props.onApplyRuntimeSettings} embedded />
                : <p className="settings-empty">Loading model settings…</p>}
            </section>
          </div>

          <div role="tabpanel" id={`${id}-panel-context`} aria-labelledby={`${id}-tab-context`} hidden={section !== "context"} tabIndex={0} className="settings-panel">
            {visited.context && <>
              <div className="settings-panel-heading">
                <h3>Context</h3>
                <p>Set the token limit and inspect the active memory.</p>
              </div>
              <section className="settings-section" aria-labelledby={`${id}-window-heading`}>
                <h4 id={`${id}-window-heading`}>Context window</h4>
                <label className="settings-control settings-token-limit" htmlFor={`${id}-context-window`}>
                  <span>Override (tokens)</span>
                  <input
                    id={`${id}-context-window`}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={props.contextWindowOverride ?? ""}
                    placeholder={`Auto${detectedContextWindow ? ` · ${detectedContextWindow}` : ""}`}
                    aria-describedby={`${id}-context-hint`}
                    onChange={(event) => {
                      if (!event.target.value) props.onContextWindowOverrideChange(undefined);
                      else {
                        const value = Number(event.target.value);
                        if (Number.isSafeInteger(value) && value > 0) props.onContextWindowOverrideChange(value);
                      }
                    }}
                  />
                </label>
                <p className="settings-description" id={`${id}-context-hint`}>
                  Leave empty to use the limit reported by the model. {detectedContextWindow
                    ? `Reported: ${detectedContextWindow.toLocaleString()} tokens.`
                    : `No limit reported. Enter the server’s configured context size, for example ${props.defaultContextWindow.toLocaleString()} tokens.`}
                </p>
              </section>
              <section className="settings-section" aria-label="Context and memory inspector">
                <ContextInspectorCard snapshot={props.contextSnapshot} onRetrieve={props.onRetrieveMemory} />
              </section>
            </>}
          </div>

          <div role="tabpanel" id={`${id}-panel-project`} aria-labelledby={`${id}-tab-project`} hidden={section !== "project"} tabIndex={0} className="settings-panel">
            {visited.project && <>
              <div className="settings-panel-heading">
                <h3>Project</h3>
                <p>Review repository changes and the agent’s permissions.</p>
              </div>
              <section className="settings-section" aria-labelledby={`${id}-workspace-heading`}>
                <h4 id={`${id}-workspace-heading`}>{props.workspace?.name ?? "Workspace"}</h4>
                {props.workspace
                  ? <p className="settings-workspace-path" title={props.workspace.path}>{props.workspace.path}</p>
                  : <p className="settings-empty">Open a project to see its repository status.</p>}
                {props.workspace?.gitRepository
                  ? <GitStatusCard status={props.gitStatus} repository onCommit={props.onCommit} />
                  : props.workspace && <p className="settings-empty">This project is not a Git repository.</p>}
              </section>
              <section className="settings-section" aria-labelledby={`${id}-permissions-heading`}>
                <h4 id={`${id}-permissions-heading`}>Agent permissions</h4>
                <p className="settings-description">Permissions apply to all projects.</p>
                {props.runtimeSettings
                  ? <AgentPermissionsCard settings={props.runtimeSettings} onApply={props.onApplyRuntimeSettings} embedded />
                  : <p className="settings-empty">Loading permissions…</p>}
              </section>
            </>}
          </div>

          <div role="tabpanel" id={`${id}-panel-about`} aria-labelledby={`${id}-tab-about`} hidden={section !== "about"} tabIndex={0} className="settings-panel">
            {visited.about && <>
              <div className="settings-panel-heading">
                <h3>{props.appInfo?.name ?? "Kripl Studio"}</h3>
                <p>A workspace for coding with your local model.</p>
              </div>
              <dl className="settings-about">
                <div><dt>Version</dt><dd>{props.appInfo?.version ?? "Loading…"}</dd></div>
                <div><dt>Platform</dt><dd>{props.appInfo?.platform ?? "—"}</dd></div>
                <div><dt>Model routing</dt><dd>{props.runtimeSettings?.modelRouting ?? "—"}</dd></div>
                <div><dt>Network mode</dt><dd>{props.runtimeSettings?.networkMode ?? "—"}</dd></div>
              </dl>
            </>}
          </div>
        </div>
      </div>
    </dialog>
  );
});
