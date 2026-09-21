import type { AgentEvent, AttachedFile, AgentInteractionResponse, AgentSessionSearchHit, AgentSessionSnapshot, AgentSessionSummary, AgentStatus, BrowserHistoryEntry, BrowserState, ContextInspectorSnapshot, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, MemoryItem, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceCommitResult, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceGitStatus, WorkspaceTextSearchResult } from "@kripl/core";
import { JsonDesktopStateStore } from "@kripl/app-state";
import { InspectableContextRuntime } from "@kripl/context-runtime";
import { LocalOpenAIProvider } from "@kripl/local-openai-provider";
import { effectivePermissionPolicy, parsePermissionPolicy } from "@kripl/permissions";
import {
  normalizePiSessionMessages,
  PiAgentRuntime,
  PiSessionCatalog
} from "@kripl/pi-adapter";
import { PtyTerminalRuntime } from "@kripl/terminal";
import { LocalWorkspaceRuntime } from "@kripl/workspace";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "./browser-runtime.js";
import { ToolBridgeServer } from "./tool-bridge.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  desktopBootstrap: "kripl:desktop-bootstrap",
  openRecentProject: "kripl:open-recent-project",
  trayMenuAction: "kripl:tray-menu-action",
  forgetRecentProject: "kripl:forget-recent-project",
  saveDesktopUi: "kripl:save-desktop-ui",
  saveRuntimeSettings: "kripl:save-runtime-settings",
  contextGetSnapshot: "kripl:context-get-snapshot",
  contextRetrieveMemory: "kripl:context-retrieve-memory",
  contextSnapshot: "kripl:context-snapshot",
  workspaceList: "kripl:workspace-list",
  workspaceReadFile: "kripl:workspace-read-file",
  workspaceWriteFile: "kripl:workspace-write-file",
  workspaceSearchFiles: "kripl:workspace-search-files",
  workspaceSearchText: "kripl:workspace-search-text",
  workspaceChanges: "kripl:workspace-changes",
  workspaceDiff: "kripl:workspace-diff",
  workspaceStage: "kripl:workspace-stage",
  workspaceUnstage: "kripl:workspace-unstage",
  workspaceRevert: "kripl:workspace-revert",
  workspaceGitStatus: "kripl:workspace-git-status",
  workspaceCommit: "kripl:workspace-commit",
  probeLocalModels: "kripl:probe-local-models",
  agentSessions: "kripl:agent-sessions",
  agentStart: "kripl:agent-start",
  agentAttach: "kripl:agent-attach",
  agentDeleteSession: "kripl:agent-delete-session",
  agentLiveSessions: "kripl:agent-live-sessions",
  agentLiveChanged: "kripl:agent-live-changed",
  agentSessionSnapshot: "kripl:agent-session-snapshot",
  agentExportSession: "kripl:agent-export-session",
  agentSearchSessions: "kripl:agent-search-sessions",
  agentSend: "kripl:agent-send",
  pickAttachFiles: "kripl:pick-attach-files",
  agentAttachFiles: "kripl:agent-attach-files",
  pasteAgentFiles: "kripl:paste-agent-files",
  attachPreview: "kripl:attach-preview",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentRespondInteraction: "kripl:agent-respond-interaction",
  agentEvent: "kripl:agent-event",
  browserGetState: "kripl:browser-get-state",
  browserSetVisible: "kripl:browser-set-visible",
  browserState: "kripl:browser-state",
  browserGetHistory: "kripl:browser-get-history",
  browserNavigate: "kripl:browser-navigate",
  browserHistory: "kripl:browser-history",
  agentRenameSession: "kripl:agent-rename-session",
  agentSessionsChanged: "kripl:agent-sessions-changed",
  terminalGetState: "kripl:terminal-get-state",
  terminalStart: "kripl:terminal-start",
  terminalWrite: "kripl:terminal-write",
  terminalResize: "kripl:terminal-resize",
  terminalKill: "kripl:terminal-kill",
  terminalPanelVisible: "kripl:terminal-panel-visible",
  terminalEvent: "kripl:terminal-event"
} as const;

interface AgentStartRequest {
  endpoint: string;
  modelId: string;
  sessionPath?: string;
}

interface ActionResult {
  ok: boolean;
  error?: string;
}

let activeAgent: PiAgentRuntime | undefined;
let activeAgentUnsubscribe: (() => void) | undefined;
let activeAgentStatus: AgentStatus = "idle";
let activeAgentModel: { endpoint: string; modelId: string } | undefined;

// Parked agents keep running in the background while the user works with a
// different chat or project. Keyed by runtime id.
interface BackgroundAgentSlot {
  agent: PiAgentRuntime;
  model?: { endpoint: string; modelId: string };
  // Workspace the run belongs to (may differ after a project switch).
  workspacePath?: string;
  status: AgentStatus;
  unsubscribe: () => void;
}
const backgroundAgents = new Map<number, BackgroundAgentSlot>();

// Stable id per runtime so the renderer can ignore events from other agents.
let nextAgentId = 1;
const agentIds = new Map<PiAgentRuntime, number>();
function agentIdOf(agent: PiAgentRuntime): number {
  let id = agentIds.get(agent);
  if (id === undefined) {
    id = nextAgentId++;
    agentIds.set(agent, id);
  }
  return id;
}

async function liveSessionFile(agent: PiAgentRuntime): Promise<string | null> {
  try {
    const snapshot = await agent.getSessionSnapshot();
    return snapshot.sessionFile ?? null;
  } catch {
    return null;
  }
}
let browserRuntime: BrowserRuntime | undefined;
let toolBridgeServer: ToolBridgeServer | undefined;
let browserUnsubscribe: (() => void) | undefined;
let terminalUnsubscribe: (() => void) | undefined;
let contextUnsubscribe: (() => void) | undefined;
let lastBrowserContextKey = "";
const contextRuntime = new InspectableContextRuntime({ maxEvents: 120 });
const workspaceRuntime = new LocalWorkspaceRuntime();
const terminalRuntime = new PtyTerminalRuntime();
let desktopStateStore: JsonDesktopStateStore | undefined;


function emptyBrowserState(): BrowserState {
  return {
    visible: false,
    loading: false,
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false
  };
}

function actionError(error: unknown): ActionResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

function recordWorkspaceOpened(workspace: WorkspaceDescriptor): void {
  void contextRuntime.record({
    type: "workspace.opened",
    path: workspace.path,
    name: workspace.name,
    gitRepository: workspace.gitRepository
  });
}

function recordBrowserState(state: BrowserState): void {
  const key = [state.visible, state.url, state.title].join("|");
  if (key === lastBrowserContextKey) return;
  lastBrowserContextKey = key;
  void contextRuntime.record({
    type: "browser.state",
    visible: state.visible,
    loading: state.loading,
    url: state.url,
    title: state.title
  });
}

function initializeContextForwarding(window: BrowserWindow): void {
  contextUnsubscribe?.();
  contextUnsubscribe = contextRuntime.subscribe((snapshot) => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC.contextSnapshot, snapshot);
    }
  });
}

function requireDesktopStateStore(): JsonDesktopStateStore {
  if (!desktopStateStore) throw new Error("Desktop state store is not initialized.");
  return desktopStateStore;
}

function piSessionDir(): string {
  return join(app.getPath("userData"), "pi-sessions");
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function validatedSessionPath(
  workspacePath: string,
  requestedPath: string | undefined
): Promise<string | undefined> {
  if (!requestedPath) return undefined;
  if (requestedPath.length > 32_768) throw new Error("Session path is too long.");

  const requestedKey = pathKey(requestedPath);
  const sessions = await listWorkspaceSessions(workspacePath);
  const matched = sessions.find((session) => pathKey(session.path) === requestedKey);
  if (!matched) {
    throw new Error("Selected Pi session does not belong to the active workspace.");
  }
  return matched.path;
}

/** Which agents are alive right now (active + parked in the background). */
async function listLiveAgents(): Promise<Array<{ sessionPath?: string; running: boolean }>> {
  const entries: Array<{ agent: PiAgentRuntime; status: AgentStatus }> = [];
  if (activeAgent) entries.push({ agent: activeAgent, status: activeAgentStatus });
  for (const slot of backgroundAgents.values()) {
    entries.push({ agent: slot.agent, status: slot.status });
  }

  const live: Array<{ sessionPath?: string; running: boolean }> = [];
  for (const entry of entries) {
    const running = entry.status === "running" || entry.status === "stopping";
    if (!running) continue;
    const file = await liveSessionFile(entry.agent);
    live.push({
      ...(file ? { sessionPath: file } : {}),
      running
    });
  }
  return live;
}

function broadcastLiveAgents(): void {
  void listLiveAgents()
    .then((live) => broadcastToWindow(IPC.agentLiveChanged, live))
    .catch(() => {});
}

function broadcastToWindow(channel: string, payload: unknown): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

// --- Browser usage history (persisted, best-effort) -------------------------

function browserHistoryPath(): string {
  return join(app.getPath("userData"), "browser-history.json");
}

async function loadBrowserHistory(): Promise<BrowserHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(browserHistoryPath(), "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (!Array.isArray(parsed.entries)) return [];
    return (parsed.entries as Array<Record<string, unknown>>)
      .filter(
        (item) =>
          item && typeof item.url === "string" && typeof item.at === "number"
      )
      .map((item) => ({
        url: item.url as string,
        title: typeof item.title === "string" ? item.title : "",
        at: item.at as number
      }))
      .slice(0, 10);
  } catch {
    return [];
  }
}

let lastRecordedBrowserUrl = "";

async function recordBrowserUsage(state: BrowserState): Promise<void> {
  if (!state.url || state.url === "about:blank" || state.url === lastRecordedBrowserUrl) return;
  lastRecordedBrowserUrl = state.url;
  const entries = await loadBrowserHistory();
  const next = [
    { url: state.url, title: state.title, at: Date.now() },
    ...entries.filter((entry) => entry.url !== state.url)
  ].slice(0, 10);
  try {
    await writeFile(browserHistoryPath(), JSON.stringify({ version: 1, entries: next }), "utf8");
  } catch {
    // History is best-effort and must not break the browser.
  }
  broadcastToWindow(IPC.browserHistory, next);
}

// --- Session names (sidecar store; Pi's own name wins when present) --------

function sessionNamesPath(): string {
  return join(app.getPath("userData"), "session-names.json");
}

async function loadSessionNames(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(sessionNamesPath(), "utf8")) as { names?: unknown };
    if (!parsed.names || typeof parsed.names !== "object" || Array.isArray(parsed.names)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.names as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) result[key] = value.trim();
    }
    return result;
  } catch {
    return {};
  }
}

async function saveSessionNames(names: Record<string, string>): Promise<void> {
  await writeFile(sessionNamesPath(), JSON.stringify({ version: 1, names }), "utf8");
}

async function listWorkspaceSessions(workspacePath: string): Promise<AgentSessionSummary[]> {
  const [sessions, names] = await Promise.all([
    new PiSessionCatalog(piSessionDir()).list(workspacePath),
    loadSessionNames()
  ]);
  return sessions.map((session) => {
    const custom = names[pathKey(session.path)];
    return custom ? { ...session, name: custom } : session;
  });
}

async function generateSessionTitle(
  model: { endpoint: string; modelId: string },
  firstMessage: string
): Promise<string | undefined> {
  try {
    const response = await fetch(`${model.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 24,
        temperature: 0,
        messages: [
          {
            role: "user",
            content:
              "Create a very short topic title (maximum 5 words) for a coding chat that starts with this request. Reply with the title only, without quotes or punctuation at the end.\n\nRequest:\n" +
              firstMessage.slice(0, 600)
          }
        ]
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const raw = payload.choices?.[0]?.message?.content;
    const title =
      typeof raw === "string"
        ? raw.replace(/^[\"'\u201c\u201d\s]+|[\"'\u201c\u201d.!?\s]+$/g, "").trim().slice(0, 80)
        : undefined;
    return title || undefined;
  } catch {
    return undefined;
  }
}

async function autoNameActiveSession(): Promise<void> {
  const agent = activeAgent;
  const model = activeAgentModel;
  if (!agent || !model) return;

  try {
    const snapshot = await agent.getSessionSnapshot();
    const sessionFile = snapshot.sessionFile;
    if (!sessionFile) return;

    const names = await loadSessionNames();
    if (names[pathKey(sessionFile)]) return; // already named (custom or auto)

    const firstUser = snapshot.messages.find((message) => message.role === "user");
    const text = firstUser?.text ?? "";
    if (!text.trim()) return;

    const title = await generateSessionTitle(model, text);
    if (!title) return;

    names[pathKey(sessionFile)] = title;
    await saveSessionNames(names).catch(() => {});
    try {
      await agent.setSessionName?.(title);
    } catch {
      // Pi sync is best-effort; the sidecar store already has the name.
    }
    broadcastToWindow(IPC.agentSessionsChanged, undefined);
  } catch {
    // Auto-naming must never break the agent run.
  }
}

async function rememberActiveAgentSession(): Promise<void> {
  const agent = activeAgent;
  const workspace = workspaceRuntime.descriptor();
  if (!agent || !workspace) return;

  try {
    const snapshot = await agent.getSessionSnapshot();
    if (!snapshot.sessionFile) return;
    const info = await stat(snapshot.sessionFile);
    if (!info.isFile()) return;
    await requireDesktopStateStore().rememberSession(workspace.path, snapshot.sessionFile);
  } catch {
    // Session persistence is best-effort and must not break agent execution.
  }
}

function isDesktopUiState(value: unknown): value is DesktopUiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!record.workspaceView || typeof record.workspaceView !== "object" || Array.isArray(record.workspaceView)) {
    return false;
  }
  if (!Array.isArray(record.expandedDirectories)) return false;
  const view = record.workspaceView as Record<string, unknown>;
  if (view.type !== "agent" && view.type !== "file" && view.type !== "diff") return false;
  if ((view.type === "file" || view.type === "diff") && typeof view.path !== "string") return false;
  return record.expandedDirectories.every((item) => typeof item === "string");
}

function parseDesktopRuntimeSettings(value: unknown): DesktopRuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime settings must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (
    record.networkMode !== "online" &&
    record.networkMode !== "restricted" &&
    record.networkMode !== "offline"
  ) {
    throw new Error("Invalid network mode.");
  }
  if (record.modelRouting !== "local-only") {
    throw new Error("Only local model routing is currently supported.");
  }

  const tuning = record.modelTuning as Record<string, unknown> | undefined;
  if (
    tuning &&
    typeof tuning === "object" &&
    !Array.isArray(tuning) &&
    ((tuning.systemPrompt !== undefined && (typeof tuning.systemPrompt !== "string" || tuning.systemPrompt.length > 65_536)) ||
      (tuning.temperature !== undefined &&
        (typeof tuning.temperature !== "number" ||
          !Number.isFinite(tuning.temperature) ||
          tuning.temperature < 0 ||
          tuning.temperature > 2)))
  ) {
    throw new Error("Invalid model tuning settings.");
  }

  const systemPrompt =
    tuning && typeof tuning.systemPrompt === "string" && tuning.systemPrompt.trim()
      ? tuning.systemPrompt
      : undefined;
  const temperature =
    tuning && typeof tuning.temperature === "number" && Number.isFinite(tuning.temperature)
      ? Math.round(tuning.temperature * 100) / 100
      : undefined;

  return {
    networkMode: record.networkMode,
    modelRouting: "local-only",
    permissions: parsePermissionPolicy(record.permissions),
    ...(systemPrompt !== undefined || temperature !== undefined
      ? { modelTuning: { ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(temperature !== undefined ? { temperature } : {}) } }
      : {})
  };
}

async function openWorkspacePath(
  path: string,
  options: { resetUi: boolean; remember: boolean }
): Promise<WorkspaceDescriptor> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error("Workspace path is not a directory.");
  }

  // A running agent keeps working in the background after a project switch.
  parkActiveAgentInBackground();
  await terminalRuntime.kill();

  const descriptor = await workspaceRuntime.open(path);
  const store = requireDesktopStateStore();

  if (options.remember) {
    await store.rememberWorkspace(descriptor);
  }
  if (options.resetUi) {
    await store.setUiState({
      workspaceView: { type: "agent" },
      expandedDirectories: []
    });
  }

  recordWorkspaceOpened(descriptor);
  return descriptor;
}

async function restoreLastWorkspace(): Promise<void> {
  const store = requireDesktopStateStore();
  const state = await store.load();
  if (!state.lastWorkspacePath) return;

  try {
    const descriptor = await workspaceRuntime.open(state.lastWorkspacePath);
    recordWorkspaceOpened(descriptor);
  } catch {
    await store.clearLastWorkspace();
  }
}

function isAgentStartRequest(value: unknown): value is AgentStartRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.endpoint === "string" &&
    record.endpoint.length > 0 &&
    record.endpoint.length <= 2_048 &&
    typeof record.modelId === "string" &&
    record.modelId.length > 0 &&
    record.modelId.length <= 512 &&
    (record.sessionPath === undefined ||
      (typeof record.sessionPath === "string" &&
        record.sessionPath.length > 0 &&
        record.sessionPath.length <= 32_768))
  );
}

async function validateLocalModel(endpoint: string, modelId: string) {
  const provider = new LocalOpenAIProvider({
    baseUrl: endpoint,
    requestTimeoutMs: 2_500
  });
  const models = await provider.listModels();
  const selected = models.find((model) => model.id === modelId);

  if (!selected) {
    throw new Error(`Local model "${modelId}" is no longer available from the selected endpoint.`);
  }

  return {
    endpoint: provider.baseUrl,
    modelId: selected.id
  };
}

async function disposeActiveAgent(): Promise<void> {
  const agent = activeAgent;
  if (agent) {
    await rememberActiveAgentSession();
  }
  activeAgent = undefined;
  activeAgentModel = undefined;
  activeAgentUnsubscribe?.();
  activeAgentUnsubscribe = undefined;
  activeAgentStatus = "stopped";

  if (agent) {
    agentIds.delete(agent);
    await agent.dispose();
  }
  broadcastLiveAgents();
}

function disposeBackgroundAgent(id: number): void {
  const slot = backgroundAgents.get(id);
  if (!slot) return;
  backgroundAgents.delete(id);
  slot.unsubscribe();
  agentIds.delete(slot.agent);
  void slot.agent.dispose().catch(() => {});
  broadcastLiveAgents();
}

function disposeAllAgents(): Promise<void> {
  for (const id of [...backgroundAgents.keys()]) disposeBackgroundAgent(id);
  return disposeActiveAgent();
}

function forwardAgentEvent(
  target: Electron.WebContents | null,
  event: AgentEvent,
  agentId?: number
): void {
  void contextRuntime.record(event);

  if (event.type === "agent.status") {
    const previous = activeAgentStatus;
    activeAgentStatus = event.status;
    if (event.status === "ready") {
      void rememberActiveAgentSession();
    }
    if (previous !== event.status) broadcastLiveAgents();
  }

  if (event.type === "agent.raw" || !target || target.isDestroyed()) return;
  // Tag with the runtime id so the renderer can drop background-agent events.
  target.send(IPC.agentEvent, agentId !== undefined ? { ...event, agentId } : event);
}

/** Park the active agent so it keeps running while another chat is open. */
function parkActiveAgentInBackground(): void {
  const agent = activeAgent;
  if (!agent) return;
  const id = agentIdOf(agent);
  backgroundAgents.delete(id); // re-park replaces a stale slot
  void rememberActiveAgentSession();
  activeAgentUnsubscribe?.();
  activeAgentUnsubscribe = undefined;
  const parkedWorkspace = workspaceRuntime.descriptor();
  const slot: BackgroundAgentSlot = {
    agent,
    ...(activeAgentModel ? { model: activeAgentModel } : {}),
    ...(parkedWorkspace?.path ? { workspacePath: parkedWorkspace.path } : {}),
    status: activeAgentStatus,
    unsubscribe: () => {}
  };
  slot.unsubscribe = agent.subscribe((event) => {
    if (event.type === "agent.status") {
      const previous = slot.status;
      slot.status = event.status;
      if (event.status === "ready" || event.status === "stopped") {
        void rememberBackgroundSession(slot);
        broadcastToWindow(IPC.agentSessionsChanged, undefined);
      }
      if (previous !== event.status) broadcastLiveAgents();
    }
    forwardAgentEvent(eventSender(), event, id);
  });
  backgroundAgents.set(id, slot);

  activeAgent = undefined;
  activeAgentModel = undefined;
  activeAgentStatus = "idle";
}

async function rememberBackgroundSession(slot: BackgroundAgentSlot): Promise<void> {
  const workspacePath = slot.workspacePath ?? workspaceRuntime.descriptor()?.path;
  if (!workspacePath) return;
  try {
    const file = await liveSessionFile(slot.agent);
    if (!file) return;
    const info = await stat(file);
    if (!info.isFile()) return;
    await requireDesktopStateStore().rememberSession(workspacePath, file);
  } catch {
    // Best-effort; must not break the background run.
  }
}

/** Promote a parked agent back to active. Returns false when unknown. */
function promoteBackgroundAgent(id: number): boolean {
  const slot = backgroundAgents.get(id);
  if (!slot) return false;
  if (activeAgent && agentIdOf(activeAgent) !== id) {
    parkActiveAgentInBackground();
  }
  backgroundAgents.delete(id);
  slot.unsubscribe();

  activeAgent = slot.agent;
  if (slot.model) activeAgentModel = slot.model;
  activeAgentStatus = slot.status === "stopped" ? "ready" : slot.status;
  activeAgentUnsubscribe?.();
  activeAgentUnsubscribe = slot.agent.subscribe((event) => {
    forwardAgentEvent(eventSender(), event, id);
    if (event.type === "agent.turn" && event.phase === "completed") {
      void autoNameActiveSession();
    }
  });
  broadcastLiveAgents();
  return true;
}

function eventSender(): Electron.WebContents | null {
  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.webContents.isDestroyed()) return window.webContents;
  return null;
}

function initializeTerminalForwarding(window: BrowserWindow): void {
  terminalUnsubscribe?.();
  terminalUnsubscribe = terminalRuntime.subscribe((event: TerminalEvent) => {
    if (event.type === "terminal.exit") {
      const current = terminalRuntime.state();
      void contextRuntime.record({
        type: "terminal.session",
        status: "exited",
        ...(current?.cwd ? { cwd: current.cwd } : {}),
        ...(current?.shell ? { shell: current.shell } : {}),
        exitCode: event.exitCode
      });
    }

    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC.terminalEvent, event);
    }
  });
}

async function initializeBrowserRuntime(window: BrowserWindow): Promise<void> {
  browserUnsubscribe?.();
  browserUnsubscribe = undefined;

  browserRuntime?.dispose();
  browserRuntime = undefined;

  if (toolBridgeServer) {
    await toolBridgeServer.dispose();
    toolBridgeServer = undefined;
  }

  const runtime = new BrowserRuntime(window);
  runtime.setNetworkMode(requireDesktopStateStore().snapshot().runtime.networkMode);
  const bridge = new ToolBridgeServer(runtime);
  await bridge.start();

  browserRuntime = runtime;
  toolBridgeServer = bridge;
  browserUnsubscribe = runtime.subscribe((state) => {
    recordBrowserState(state);
    void recordBrowserUsage(state);
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC.browserState, state);
    }
  });
}

// GitHub Releases feed for the packaged app (dev builds skip updates).
function initializeAutoUpdates(): void {
  if (!app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (error) => {
      console.warn("[updater]", error);
    });
    autoUpdater.on("update-downloaded", () => {
      const choice = dialog.showMessageBoxSync({
        type: "info",
        title: "Kripl Studio",
        message: "A new version of Kripl Studio is ready to install.",
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1
      });
      if (choice === 0) autoUpdater.quitAndInstall();
    });
    void autoUpdater.checkForUpdates();
  } catch (error) {
    console.warn("[updater] init failed:", error);
  }
}

// Closing the window hides it to the tray; only an explicit quit destroys it.
let isQuitting = false;
let tray: Tray | null = null;

function showMainWindow(): void {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) {
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return;
  }
  const nextWindow = createWindow();
  registerWindowControls(nextWindow);
  void initializeBrowserRuntime(nextWindow);
  initializeTerminalForwarding(nextWindow);
  initializeContextForwarding(nextWindow);
}

// The native Win32 context menu cannot be themed, so the tray action menu
// is a small frameless renderer window styled like the rest of the app.
let trayMenuWindow: BrowserWindow | null = null;

function showTrayMenu(x: number, y: number): void {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.close();
    trayMenuWindow = null;
  }

  const width = 190;
  const height = 100;
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const menuX = Math.min(Math.max(area.x + 4, x - width + 8), area.x + area.width - width - 4);
  const menuY = Math.min(y + 6, area.y + area.height - height - 4);

  const win = new BrowserWindow({
    width,
    height,
    x: menuX,
    y: menuY,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  trayMenuWindow = win;

  if (process.env.ELECTRON_RENDERER_URL) {
    const separator = process.env.ELECTRON_RENDERER_URL.includes("?") ? "&" : "?";
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${separator}tray-menu=1`);
  } else {
    void win.loadFile(join(currentDir, "../renderer/index.html"), {
      query: { "tray-menu": "1" }
    });
  }

  const shownAt = Date.now();
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  // Clicking anywhere else dismisses the menu. Ignore the first blur right
  // after show — Windows can fire one spuriously and eat the whole menu.
  win.on("blur", () => {
    if (win.isDestroyed() || Date.now() - shownAt < 250) return;
    win.close();
  });
  win.on("closed", () => {
    trayMenuWindow = null;
  });
}

function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(
    join(app.getAppPath(), "resources", "tray-icon.png")
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Kripl Studio");

  // Left click restores the window; right click opens the themed action menu.
  // Windows delivers a right press as "right-click" (and sometimes also as
  // "click" with button=right), so both events are handled.
  const openMenuAtCursor = (): void => {
    const point = screen.getCursorScreenPoint();
    showTrayMenu(point.x, point.y);
  };
  tray.on("click", (event) => {
    // Electron types this as KeyboardEvent; the real payload carries
    // button ("left" | "right") and a screen position.
    const click = event as unknown as {
      button?: number | string;
      position?: { x: number; y: number };
    };
    if (click.button === "right" || click.button === 1) openMenuAtCursor();
    else showMainWindow();
  });
  tray.on("right-click", openMenuAtCursor);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#0d1014",
    title: "Kripl Studio",
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Close hides to the tray; a real quit (tray menu / OS) still works.
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDir, "../renderer/index.html"));
  }

  return window;
}

// --- Window controls (frameless titlebar) -----------------------------------

const IPC_WINDOW = {
  minimize: "kripl:window-minimize",
  toggleMaximize: "kripl:window-toggle-maximize",
  close: "kripl:window-close",
  maximized: "kripl:window-maximized"
} as const;

function registerWindowControls(window: BrowserWindow): void {
  ipcMain.handle(IPC_WINDOW.minimize, () => window.minimize());
  ipcMain.handle(IPC_WINDOW.toggleMaximize, () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC_WINDOW.close, () => window.close());

  const sendState = (maximized: boolean): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC_WINDOW.maximized, maximized);
  };
  window.on("maximize", () => sendState(true));
  window.on("unmaximize", () => sendState(false));
}

function registerIpc(): void {
  // Actions from the themed tray menu window.
  ipcMain.handle(IPC.trayMenuAction, (_event, action: unknown): void => {
    if (action === "show") showMainWindow();
    else if (action === "quit") {
      isQuitting = true;
      app.quit();
    }
    const win = trayMenuWindow;
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle(IPC.appInfo, () => {
    const runtime = requireDesktopStateStore().snapshot().runtime;
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      networkMode: runtime.networkMode,
      modelRouting: runtime.modelRouting
    };
  });

  ipcMain.handle(IPC.desktopBootstrap, (): DesktopBootstrapState => {
    const store = requireDesktopStateStore();
    const state = store.snapshot();
    const workspace = workspaceRuntime.descriptor();
    const lastSessionPath = workspace ? store.lastSessionFor(workspace.path) : undefined;
    return {
      workspace,
      recentProjects: state.recentProjects,
      ...(lastSessionPath ? { lastSessionPath } : {}),
      ui: state.ui,
      runtime: state.runtime
    };
  });

  ipcMain.handle(IPC.pickWorkspace, async (): Promise<WorkspaceDescriptor | null> => {
    const result = await dialog.showOpenDialog({
      title: "Open project",
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = result.filePaths[0];
    if (!selected) return null;

    return openWorkspacePath(selected, { resetUi: true, remember: true });
  });

  ipcMain.handle(
    IPC.openRecentProject,
    async (_event, path: unknown): Promise<WorkspaceDescriptor> => {
      if (typeof path !== "string" || !path || path.length > 32_768) {
        throw new Error("Invalid recent project path.");
      }

      const store = requireDesktopStateStore();
      if (!store.hasRecentProject(path)) {
        throw new Error("Project is not present in Kripl Studio recent projects.");
      }

      return openWorkspacePath(path, { resetUi: true, remember: true });
    }
  );

  ipcMain.handle(
    IPC.forgetRecentProject,
    async (_event, path: unknown): Promise<RecentProject[]> => {
      if (typeof path !== "string" || !path || path.length > 32_768) {
        throw new Error("Invalid recent project path.");
      }

      const store = requireDesktopStateStore();
      if (!store.hasRecentProject(path)) {
        return store.snapshot().recentProjects;
      }

      await store.forgetRecentProject(path);
      return store.snapshot().recentProjects;
    }
  );

  ipcMain.handle(IPC.saveDesktopUi, async (_event, ui: unknown): Promise<void> => {
    if (!isDesktopUiState(ui)) {
      throw new Error("Invalid desktop UI state.");
    }
    await requireDesktopStateStore().setUiState(ui);
  });

  ipcMain.handle(IPC.contextGetSnapshot, (): ContextInspectorSnapshot => {
    return contextRuntime.snapshot();
  });

  ipcMain.handle(
    IPC.contextRetrieveMemory,
    async (_event, query: unknown): Promise<MemoryItem[]> => {
      if (typeof query !== "string" || query.length > 100_000) {
        throw new Error("Invalid memory query.");
      }
      const workspace = workspaceRuntime.descriptor();
      return contextRuntime.retrieveMemory(
        query,
        workspace?.path,
        8
      );
    }
  );

  ipcMain.handle(
    IPC.saveRuntimeSettings,
    async (_event, value: unknown): Promise<DesktopRuntimeSettings> => {
      const runtime = parseDesktopRuntimeSettings(value);

      // Runtime settings affect every agent, including background ones.
      await disposeAllAgents();
      await requireDesktopStateStore().setRuntimeSettings(runtime);
      browserRuntime?.setNetworkMode(runtime.networkMode);

      return requireDesktopStateStore().snapshot().runtime;
    }
  );

  ipcMain.handle(IPC.workspaceList, async (_event, path: unknown): Promise<WorkspaceEntry[]> => {
    if (path !== undefined && typeof path !== "string") {
      throw new Error("Workspace directory path must be a string.");
    }
    if (typeof path === "string" && path.length > 32_768) {
      throw new Error("Workspace directory path is too long.");
    }
    return workspaceRuntime.list(typeof path === "string" ? path : "");
  });

  ipcMain.handle(
    IPC.workspaceReadFile,
    async (_event, path: unknown): Promise<WorkspaceFilePreview> => {
      if (typeof path !== "string" || !path || path.length > 32_768) {
        throw new Error("Invalid workspace file path.");
      }
      const preview = await workspaceRuntime.readFile(path);
      void contextRuntime.record({
        type: "workspace.file.opened",
        path: preview.path,
        sizeBytes: preview.size,
        binary: preview.binary
      });
      return preview;
    }
  );

  ipcMain.handle(
    IPC.workspaceWriteFile,
    async (_event, path: unknown, content: unknown): Promise<WorkspaceFilePreview> => {
      if (typeof path !== "string" || !path || path.length > 32_768) {
        throw new Error("Invalid workspace file path.");
      }
      if (typeof content !== "string" || content.length > 2_500_000) {
        throw new Error("Invalid workspace file content.");
      }

      const preview = await workspaceRuntime.writeFile(path, content);
      void contextRuntime.record({
        type: "workspace.file.opened",
        path: preview.path,
        sizeBytes: preview.size,
        binary: preview.binary
      });
      return preview;
    }
  );

  ipcMain.handle(
    IPC.workspaceSearchFiles,
    async (_event, query: unknown, limit: unknown): Promise<WorkspaceFileSearchResult[]> => {
      if (typeof query !== "string" || query.length > 512) {
        throw new Error("Invalid workspace file search query.");
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error("Invalid workspace file search limit.");
      }
      return workspaceRuntime.searchFiles(query, typeof limit === "number" ? limit : undefined);
    }
  );

  ipcMain.handle(
    IPC.workspaceSearchText,
    async (_event, query: unknown, limit: unknown): Promise<WorkspaceTextSearchResult[]> => {
      if (typeof query !== "string" || query.length > 512) {
        throw new Error("Invalid workspace text search query.");
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error("Invalid workspace text search limit.");
      }
      return workspaceRuntime.searchText(query, typeof limit === "number" ? limit : undefined);
    }
  );

  ipcMain.handle(IPC.workspaceChanges, async (): Promise<WorkspaceChange[]> => {
    return workspaceRuntime.getChanges();
  });

  ipcMain.handle(IPC.workspaceDiff, async (_event, path: unknown): Promise<WorkspaceDiff> => {
    if (typeof path !== "string" || !path || path.length > 32_768) {
      throw new Error("Invalid workspace diff path.");
    }
    const diff = await workspaceRuntime.getDiff(path);
    void contextRuntime.record({
      type: "workspace.diff.opened",
      path: diff.path
    });
    return diff;
  });

  ipcMain.handle(IPC.workspaceStage, async (_event, path: unknown): Promise<void> => {
    if (typeof path !== "string" || !path || path.length > 32_768) {
      throw new Error("Invalid workspace change path.");
    }
    await workspaceRuntime.stage(path);
  });

  ipcMain.handle(IPC.workspaceUnstage, async (_event, path: unknown): Promise<void> => {
    if (typeof path !== "string" || !path || path.length > 32_768) {
      throw new Error("Invalid workspace change path.");
    }
    await workspaceRuntime.unstage(path);
  });

  ipcMain.handle(IPC.workspaceRevert, async (_event, path: unknown): Promise<void> => {
    if (typeof path !== "string" || !path || path.length > 32_768) {
      throw new Error("Invalid workspace change path.");
    }
    await workspaceRuntime.revert(path);
  });

  ipcMain.handle(IPC.workspaceGitStatus, async (): Promise<WorkspaceGitStatus | null> => {
    const workspace = workspaceRuntime.descriptor();
    if (!workspace?.gitRepository) return null;
    return workspaceRuntime.getGitStatus();
  });

  ipcMain.handle(
    IPC.workspaceCommit,
    async (_event, message: unknown): Promise<WorkspaceCommitResult> => {
      if (typeof message !== "string" || !message.trim() || message.length > 10_000) {
        throw new Error("Invalid Git commit message.");
      }
      return workspaceRuntime.commit(message);
    }
  );

  ipcMain.handle(IPC.agentSessions, async (): Promise<AgentSessionSummary[]> => {
    const workspace = workspaceRuntime.descriptor();
    if (!workspace) return [];
    return listWorkspaceSessions(workspace.path);
  });

  ipcMain.handle(IPC.agentSessionSnapshot, async (): Promise<AgentSessionSnapshot | null> => {
    if (!activeAgent) return null;
    return activeAgent.getSessionSnapshot();
  });

  // Export any session file (JSONL) as normalized messages for Markdown export.
  ipcMain.handle(
    IPC.agentExportSession,
    async (_event, sessionPath: unknown): Promise<AgentSessionSnapshot | null> => {
      if (
        typeof sessionPath !== "string" ||
        !sessionPath.endsWith(".jsonl") ||
        sessionPath.length > 4096
      ) {
        return null;
      }
      try {
        const raw = await readFile(sessionPath, "utf8");
        const records: unknown[] = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          const record = entry as { type?: unknown; message?: unknown } | null;
          if (
            record &&
            typeof record === "object" &&
            record.type === "message" &&
            record.message &&
            typeof record.message === "object"
          ) {
            records.push(record.message);
          }
        }
        const messages = normalizePiSessionMessages(records).slice(0, 500);
        return {
          sessionId: basename(sessionPath, ".jsonl"),
          messageCount: messages.length,
          messages
        };
      } catch {
        return null;
      }
    }
  );

  // Full-text search across the workspace's saved chats.
  ipcMain.handle(
    IPC.agentSearchSessions,
    async (_event, query: unknown): Promise<AgentSessionSearchHit[]> => {
      const workspace = workspaceRuntime.descriptor();
      if (!workspace || typeof query !== "string") return [];
      const needle = query.trim().toLowerCase();
      if (needle.length < 2) return [];

      const sessions = await listWorkspaceSessions(workspace.path);
      const hits: AgentSessionSearchHit[] = [];
      for (const session of sessions.slice(0, 50)) {
        let raw: string;
        try {
          raw = await readFile(session.path, "utf8");
        } catch {
          continue;
        }
        const records: unknown[] = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          const record = entry as { type?: unknown; message?: unknown } | null;
          if (
            record &&
            typeof record === "object" &&
            record.type === "message" &&
            record.message &&
            typeof record.message === "object"
          ) {
            records.push(record.message);
          }
        }

        let matches = 0;
        for (const message of normalizePiSessionMessages(records)) {
          const index = message.text.toLowerCase().indexOf(needle);
          if (index < 0) continue;
          matches += 1;
          const start = Math.max(0, index - 60);
          const end = Math.min(message.text.length, index + needle.length + 120);
          hits.push({
            sessionPath: session.path,
            ...(session.name ? { sessionName: session.name } : {}),
            role: message.role,
            snippet:
              (start > 0 ? "…" : "") +
              message.text.slice(start, end).replace(/\s+/g, " ") +
              (end < message.text.length ? "…" : "")
          });
          if (matches >= 3) break;
        }
        if (hits.length >= 24) break;
      }
      return hits;
    }
  );

  ipcMain.handle(IPC.probeLocalModels, async (_event, endpoint: unknown) => {
    if (typeof endpoint !== "string" || endpoint.length > 2048) {
      return { ok: false, endpoint: "", models: [], error: "Invalid local model endpoint." };
    }

    try {
      const provider = new LocalOpenAIProvider({ baseUrl: endpoint, requestTimeoutMs: 2_500 });
      const models = await provider.listModels();
      return { ok: true, endpoint: provider.baseUrl, models };
    } catch (error) {
      return {
        ok: false,
        endpoint,
        models: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle(
    IPC.agentStart,
    async (
      event,
      request: unknown
    ): Promise<ActionResult & { agentId?: number; status?: AgentStatus }> => {
    if (!isAgentStartRequest(request)) {
      return { ok: false, error: "Invalid agent start request." };
    }

    try {
      const workspace = workspaceRuntime.descriptor();
      if (!workspace) {
        throw new Error("Open a workspace before starting the agent.");
      }
      const localModel = await validateLocalModel(request.endpoint, request.modelId);
      const sessionPath = await validatedSessionPath(workspace.path, request.sessionPath);

      // A running agent keeps working in the background unless we are
      // restarting its own session (clean restart is expected then).
      if (activeAgent) {
        const currentFile = await liveSessionFile(activeAgent);
        const sameSession =
          Boolean(currentFile && request.sessionPath) &&
          currentFile === request.sessionPath;
        if (sameSession) {
          await disposeActiveAgent();
        } else {
          parkActiveAgentInBackground();
        }
      }

      const toolBridge = toolBridgeServer?.getConnection();
      if (!toolBridge) {
        throw new Error("Kripl browser tool bridge is not ready.");
      }

      const runtimeSettings = requireDesktopStateStore().snapshot().runtime;
      const permissionPolicy = effectivePermissionPolicy(
        runtimeSettings.permissions,
        runtimeSettings.networkMode
      );

      const userData = app.getPath("userData");
      const agent = new PiAgentRuntime({
        agentDir: join(userData, "pi-agent"),
        sessionDir: piSessionDir(),
        localModel: {
          baseUrl: localModel.endpoint,
          modelId: localModel.modelId,
          ...(runtimeSettings.modelTuning?.temperature !== undefined
            ? { temperature: runtimeSettings.modelTuning.temperature }
            : {})
        },
        ...(runtimeSettings.modelTuning?.systemPrompt
          ? { modelSystemPrompt: runtimeSettings.modelTuning.systemPrompt }
          : {}),
        networkMode: runtimeSettings.networkMode,
        permissionPolicy,
        toolBridge
      });

      activeAgent = agent;
      activeAgentModel = { endpoint: localModel.endpoint, modelId: localModel.modelId };
      activeAgentStatus = "starting";
      const agentId = agentIdOf(agent);
      activeAgentUnsubscribe = agent.subscribe((agentEvent) => {
        forwardAgentEvent(event.sender, agentEvent, agentId);
        if (agentEvent.type === "agent.turn" && agentEvent.phase === "completed") {
          void autoNameActiveSession();
        }
      });

      await agent.start({
        workspacePath: workspace.path,
        ...(sessionPath ? { sessionPath } : {})
      });
      await rememberActiveAgentSession();
      return { ok: true, agentId };
    } catch (error) {
      await disposeActiveAgent();
      return actionError(error);
    }
  });

  // Rebind the UI to an agent that is still running in the background.
  ipcMain.handle(
    IPC.agentAttach,
    async (
      _event,
      sessionPath: unknown
    ): Promise<ActionResult & { agentId?: number; status?: AgentStatus }> => {
      if (typeof sessionPath !== "string" || !sessionPath) {
        return { ok: false, error: "Invalid session path." };
      }
      const activeFile = activeAgent ? await liveSessionFile(activeAgent) : null;
      if (activeAgent && activeFile === sessionPath) {
        return { ok: true, agentId: agentIdOf(activeAgent), status: activeAgentStatus };
      }
      for (const [id, slot] of [...backgroundAgents.entries()]) {
        const file = await liveSessionFile(slot.agent);
        if (file !== sessionPath) continue;
        promoteBackgroundAgent(id);
        return { ok: true, agentId: id, status: activeAgentStatus };
      }
      return { ok: false, error: "No running agent for this chat." };
    }
  );

  ipcMain.handle(IPC.agentLiveSessions, async (): Promise<
    Array<{ sessionPath?: string; running: boolean }>
  > => {
    try {
      return await listLiveAgents();
    } catch {
      return [];
    }
  });

  // Delete a saved chat file (and its name entry), stopping any live runtime.
  ipcMain.handle(IPC.agentDeleteSession, async (_event, sessionPath: unknown): Promise<ActionResult> => {
    if (typeof sessionPath !== "string" || !sessionPath) {
      return { ok: false, error: "Invalid session path." };
    }
    try {
      if (activeAgent && (await liveSessionFile(activeAgent)) === sessionPath) {
        await disposeActiveAgent();
      }
      for (const [id, slot] of [...backgroundAgents.entries()]) {
        if ((await liveSessionFile(slot.agent)) === sessionPath) disposeBackgroundAgent(id);
      }
      await unlink(sessionPath).catch(() => {});
      const names = await loadSessionNames();
      const key = pathKey(sessionPath);
      if (names[key]) {
        delete names[key];
        await saveSessionNames(names);
      }
      broadcastToWindow(IPC.agentSessionsChanged, undefined);
      return { ok: true };
    } catch (error) {
      return actionError(error);
    }
  });

  ipcMain.handle(IPC.agentSend, async (_event, message: unknown): Promise<ActionResult> => {
    if (typeof message !== "string" || !message.trim() || message.length > 1_000_000) {
      return { ok: false, error: "Invalid agent message." };
    }
    if (!activeAgent) {
      return { ok: false, error: "Pi agent is not started." };
    }
    if (activeAgentStatus !== "ready") {
      return { ok: false, error: `Pi agent is not ready (status: ${activeAgentStatus}).` };
    }

    try {
      const workspace = workspaceRuntime.descriptor();
      await contextRuntime.record({
        type: "user.message",
        text: message,
        ...(workspace?.path ? { workspacePath: workspace.path } : {})
      });
      await activeAgent.send({ text: message });
      return { ok: true };
    } catch (error) {
      return actionError(error);
    }
  });

  const ATTACH_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
  const ATTACH_ARCHIVE_EXTS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz"]);
  const ATTACH_TEXT_EXTS = new Set([
    ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".log",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".",
    ".py", ".kt", ".kts", ".java", ".c", ".h", ".cpp", ".hpp", ".cs",
    ".rs", ".go", ".rb", ".php", ".sh", ".bat", ".ps1", ".yml", ".yaml",
    ".toml", ".ini", ".xml", ".html", ".css", ".scss", ".sql", ".tex"
  ]);

  function classifyAttachment(name: string): "image" | "archive" | "text" | "binary" {
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (ATTACH_IMAGE_EXTS.has(ext)) return "image";
    if (ATTACH_ARCHIVE_EXTS.has(ext)) return "archive";
    if (ATTACH_TEXT_EXTS.has(ext)) return "text";
    return "binary";
  }

  ipcMain.handle(IPC.pickAttachFiles, async (event): Promise<string[]> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window!, {
      title: "Attach files to the chat",
      properties: ["openFile", "multiSelections"]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(
    IPC.agentAttachFiles,
    async (_event, paths: unknown): Promise<ActionResult & { files?: AttachedFile[] }> => {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10) {
        return { ok: false, error: "Select between 1 and 10 files." };
      }

      const workspace = workspaceRuntime.descriptor();
      const destDir = workspace
        ? join(workspace.path, ".kripl", "attachments")
        : join(app.getPath("userData"), "attachments");
      await mkdir(destDir, { recursive: true });

      const files: AttachedFile[] = [];
      for (const value of paths) {
        if (typeof value !== "string" || !value.trim()) continue;
        const source = resolve(value);
        try {
          const info = await stat(source);
          if (!info.isFile() || info.size > 50 * 1024 * 1024) {
            files.push({
              name: source.slice(source.lastIndexOf("\\") + 1),
              path: source,
              sizeBytes: info.size,
              kind: classifyAttachment(source),
              error: "File is not a regular file or exceeds 50 MB."
            });
            continue;
          }

          const baseName = source.slice(source.lastIndexOf("\\") + 1);
          const destPath = join(destDir, `${Date.now()}-${files.length}-${baseName}`);
          await copyFile(source, destPath);

          const file: AttachedFile = {
            name: baseName,
            path: destPath,
            sizeBytes: info.size,
            kind: classifyAttachment(baseName)
          };
          if (file.kind === "text" && info.size <= 200_000) {
            const content = await readFile(destPath, "utf8");
            file.preview =
              content.length > 100_000 ? content.slice(0, 100_000) + "\n…[truncated]" : content;
          }
          files.push(file);
        } catch (error) {
          files.push({
            name: source,
            path: source,
            sizeBytes: 0,
            kind: "binary",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return { ok: true, files };
    }
  );

  ipcMain.handle(
    IPC.pasteAgentFiles,
    async (_event, items: unknown): Promise<ActionResult & { files?: AttachedFile[] }> => {
      if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
        return { ok: false, error: "Paste between 1 and 10 files." };
      }

      const workspace = workspaceRuntime.descriptor();
      const destDir = workspace
        ? join(workspace.path, ".kripl", "attachments")
        : join(app.getPath("userData"), "attachments");
      await mkdir(destDir, { recursive: true });

      const files: AttachedFile[] = [];
      for (const value of items) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        const rawName = typeof record.name === "string" && record.name.trim()
          ? record.name
          : `pasted-${Date.now()}`;
        const safeName = rawName.replace(/^[^\\\/]*[\\\//]/, "").replace(/[\\/:*?"<>|]/g, "_");

        try {
          if (typeof record.dataBase64 !== "string") throw new Error("No clipboard payload.");
          const data = Buffer.from(record.dataBase64, "base64");
          if (data.byteLength === 0 || data.byteLength > 50 * 1024 * 1024) {
            throw new Error("Clipboard payload is empty or exceeds 50 MB.");
          }

          const destPath = join(destDir, `${Date.now()}-${files.length}-${safeName}`);
          await writeFile(destPath, data);

          const file: AttachedFile = {
            name: safeName,
            path: destPath,
            sizeBytes: data.byteLength,
            kind: classifyAttachment(safeName)
          };
          if (file.kind === "text" && data.byteLength <= 200_000) {
            const content = await readFile(destPath, "utf8");
            file.preview =
              content.length > 100_000 ? content.slice(0, 100_000) + "\n…[truncated]" : content;
          }
          files.push(file);
        } catch (error) {
          files.push({
            name: safeName,
            path: "",
            sizeBytes: 0,
            kind: "binary",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return { ok: true, files };
    }
  );

  const ATTACH_PREVIEW_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf"
  };

  ipcMain.handle(
    IPC.attachPreview,
    async (_event, path: unknown): Promise<ActionResult & { mime?: string; dataUrl?: string }> => {
      if (typeof path !== "string" || !path.trim()) {
        return { ok: false, error: "Invalid attachment path." };
      }

      // Previews are only served for files inside the Kripl attachment store.
      const allowedDirs = [join(app.getPath("userData"), "attachments")];
      const workspace = workspaceRuntime.descriptor();
      if (workspace) allowedDirs.push(join(workspace.path, ".kripl", "attachments"));

      const resolved = resolve(path);
      const insideStore = allowedDirs.some((dir) => {
        const rel = relative(dir, resolved);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (!insideStore) {
        return { ok: false, error: "Path is outside the attachment store." };
      }

      const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
      const mime = ATTACH_PREVIEW_MIME[ext];
      if (!mime) {
        return { ok: false, error: "No preview available for this file type." };
      }

      try {
        const info = await stat(resolved);
        if (info.size > 10 * 1024 * 1024) {
          return { ok: false, error: "File exceeds the 10 MB preview limit." };
        }
        const data = await readFile(resolved);
        return { ok: true, mime, dataUrl: `data:${mime};base64,${data.toString("base64")}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(IPC.agentAbort, async (): Promise<ActionResult> => {
    if (!activeAgent) return { ok: true };

    try {
      await activeAgent.stop();
      return { ok: true };
    } catch (error) {
      return actionError(error);
    }
  });


  ipcMain.handle(
    IPC.agentRespondInteraction,
    async (_event, response: unknown): Promise<ActionResult> => {
      if (!activeAgent) return { ok: false, error: "Pi agent is not started." };
      if (!response || typeof response !== "object") {
        return { ok: false, error: "Invalid agent interaction response." };
      }

      const record = response as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id) {
        return { ok: false, error: "Agent interaction response id is required." };
      }

      const normalized: AgentInteractionResponse = {
        id: record.id,
        ...(typeof record.confirmed === "boolean" ? { confirmed: record.confirmed } : {}),
        ...(typeof record.value === "string" ? { value: record.value } : {}),
        ...(record.cancelled === true ? { cancelled: true } : {})
      };

      try {
        await activeAgent.respondToInteraction(normalized);
        return { ok: true };
      } catch (error) {
        return actionError(error);
      }
    }
  );



  ipcMain.handle(IPC.terminalGetState, (): TerminalSessionInfo | null => {
    return terminalRuntime.state();
  });

  ipcMain.handle(
    IPC.terminalStart,
    async (_event, request: unknown): Promise<TerminalSessionInfo> => {
      const workspace = workspaceRuntime.descriptor();
      if (!workspace) throw new Error("Open a workspace before starting the terminal.");

      let cols: number | undefined;
      let rows: number | undefined;

      if (request !== undefined) {
        if (!request || typeof request !== "object") {
          throw new Error("Invalid terminal start request.");
        }
        const record = request as Record<string, unknown>;
        if (record.cols !== undefined) {
          if (typeof record.cols !== "number" || !Number.isFinite(record.cols)) {
            throw new Error("Terminal cols must be a finite number.");
          }
          cols = record.cols;
        }
        if (record.rows !== undefined) {
          if (typeof record.rows !== "number" || !Number.isFinite(record.rows)) {
            throw new Error("Terminal rows must be a finite number.");
          }
          rows = record.rows;
        }
      }

      const session = await terminalRuntime.start({
        cwd: workspace.path,
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows })
      });
      void contextRuntime.record({
        type: "terminal.session",
        status: session.status,
        cwd: session.cwd,
        shell: session.shell
      });
      return session;
    }
  );

  ipcMain.handle(IPC.terminalWrite, async (_event, data: unknown): Promise<void> => {
    if (typeof data !== "string" || data.length > 64 * 1024) {
      throw new Error("Invalid terminal input.");
    }
    await terminalRuntime.write(data);
  });

  ipcMain.handle(
    IPC.terminalResize,
    async (_event, cols: unknown, rows: unknown): Promise<void> => {
      if (
        typeof cols !== "number" ||
        !Number.isFinite(cols) ||
        typeof rows !== "number" ||
        !Number.isFinite(rows)
      ) {
        throw new Error("Terminal dimensions must be finite numbers.");
      }
      await terminalRuntime.resize(cols, rows);
    }
  );

  ipcMain.handle(IPC.terminalKill, async (): Promise<void> => {
    await terminalRuntime.kill();
  });

  ipcMain.handle(IPC.terminalPanelVisible, (_event, visible: unknown): void => {
    if (typeof visible !== "boolean") {
      throw new Error("Terminal panel visibility must be a boolean.");
    }
    browserRuntime?.setBottomInset(visible ? 260 : 0);
  });

  ipcMain.handle(IPC.browserGetHistory, async (): Promise<BrowserHistoryEntry[]> => {
    return loadBrowserHistory();
  });

  ipcMain.handle(
    IPC.agentRenameSession,
    async (_event, request: unknown): Promise<ActionResult> => {
      if (
        !request ||
        typeof request !== "object" ||
        typeof (request as Record<string, unknown>).sessionPath !== "string"
      ) {
        return { ok: false, error: "Invalid rename request." };
      }

      const sessionPath = (request as Record<string, unknown>).sessionPath as string;
      const name =
        typeof (request as Record<string, unknown>).name === "string"
          ? ((request as Record<string, unknown>).name as string).trim()
          : "";

      if (sessionPath.length > 32_768 || name.length > 120) {
        return { ok: false, error: "Session path or name is too long." };
      }

      try {
        const workspace = workspaceRuntime.descriptor();
        if (!workspace) throw new Error("Open a workspace first.");

        const sessions = await listWorkspaceSessions(workspace.path);
        const matched = sessions.find((session) => pathKey(session.path) === pathKey(sessionPath));
        if (!matched) {
          throw new Error("Selected Pi session does not belong to the active workspace.");
        }

        const names = await loadSessionNames();
        const key = pathKey(matched.path);
        if (name) names[key] = name;
        else delete names[key];
        await saveSessionNames(names);

        // Keep Pi's own session selector in sync for the live session.
        try {
          const agent = activeAgent;
          if (agent?.setSessionName) {
            const snapshot = await agent.getSessionSnapshot();
            if (snapshot.sessionFile && pathKey(snapshot.sessionFile) === key) {
              if (name) await agent.setSessionName(name);
            }
          }
        } catch {
          // Pi sync is best-effort; the sidecar store already has the name.
        }

        broadcastToWindow(IPC.agentSessionsChanged, undefined);
        return { ok: true };
      } catch (error) {
        return actionError(error);
      }
    }
  );

  ipcMain.handle(IPC.browserGetState, (): BrowserState => {
    return browserRuntime?.getState() ?? emptyBrowserState();
  });

  ipcMain.handle(IPC.browserNavigate, async (_event, url: unknown): Promise<BrowserState> => {
    const runtime = browserRuntime;
    if (!runtime) throw new Error("Browser is not initialized.");
    return runtime.navigate(typeof url === "string" ? url : "");
  });

  ipcMain.handle(IPC.browserSetVisible, (_event, visible: unknown): BrowserState => {
    if (typeof visible !== "boolean") {
      throw new Error("Browser visibility must be a boolean.");
    }
    return browserRuntime?.setVisible(visible) ?? emptyBrowserState();
  });

  ipcMain.handle(IPC.agentStop, async (): Promise<ActionResult> => {
    try {
      await disposeActiveAgent();
      return { ok: true };
    } catch (error) {
      return actionError(error);
    }
  });
}

void app.whenReady().then(async () => {
  desktopStateStore = new JsonDesktopStateStore(
    join(app.getPath("userData"), "desktop-state.json")
  );
  await contextRuntime.initialize();
  await restoreLastWorkspace();

  registerIpc();
  createTray();
  initializeAutoUpdates();
  const window = createWindow();
  registerWindowControls(window);
  await initializeBrowserRuntime(window);
  initializeTerminalForwarding(window);
  initializeContextForwarding(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = createWindow();
      registerWindowControls(nextWindow);
      void initializeBrowserRuntime(nextWindow);
      initializeTerminalForwarding(nextWindow);
      initializeContextForwarding(nextWindow);
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  browserUnsubscribe?.();
  browserUnsubscribe = undefined;
  terminalUnsubscribe?.();
  terminalUnsubscribe = undefined;
  contextUnsubscribe?.();
  contextUnsubscribe = undefined;
  browserRuntime?.dispose();
  browserRuntime = undefined;
  void toolBridgeServer?.dispose();
  toolBridgeServer = undefined;
  void contextRuntime.dispose();
  void terminalRuntime.dispose();
  void workspaceRuntime.dispose();
  void disposeAllAgents();
});

// With the tray, closing the last window keeps the agent alive in the
// background; only an explicit quit terminates the process.
app.on("window-all-closed", () => {
  if (isQuitting || process.platform === "darwin") app.quit();
});
