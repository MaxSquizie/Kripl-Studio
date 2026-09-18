import type { AgentEvent, AgentInteractionResponse, AgentSessionSnapshot, AgentSessionSummary, AgentStatus, BrowserState, ContextInspectorSnapshot, DesktopBootstrapState, DesktopRuntimeSettings, DesktopUiState, MemoryItem, RecentProject, TerminalEvent, TerminalSessionInfo, WorkspaceChange, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview } from "@kripl/core";
import { JsonDesktopStateStore } from "@kripl/app-state";
import { InspectableContextRuntime } from "@kripl/context-runtime";
import { LocalOpenAIProvider } from "@kripl/local-openai-provider";
import { effectivePermissionPolicy, parsePermissionPolicy } from "@kripl/permissions";
import { PiAgentRuntime, PiSessionCatalog } from "@kripl/pi-adapter";
import { PtyTerminalRuntime } from "@kripl/terminal";
import { LocalWorkspaceRuntime } from "@kripl/workspace";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "./browser-runtime.js";
import { ToolBridgeServer } from "./tool-bridge.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  desktopBootstrap: "kripl:desktop-bootstrap",
  openRecentProject: "kripl:open-recent-project",
  forgetRecentProject: "kripl:forget-recent-project",
  saveDesktopUi: "kripl:save-desktop-ui",
  saveRuntimeSettings: "kripl:save-runtime-settings",
  contextGetSnapshot: "kripl:context-get-snapshot",
  contextRetrieveMemory: "kripl:context-retrieve-memory",
  contextSnapshot: "kripl:context-snapshot",
  workspaceList: "kripl:workspace-list",
  workspaceReadFile: "kripl:workspace-read-file",
  workspaceWriteFile: "kripl:workspace-write-file",
  workspaceChanges: "kripl:workspace-changes",
  workspaceDiff: "kripl:workspace-diff",
  workspaceStage: "kripl:workspace-stage",
  workspaceUnstage: "kripl:workspace-unstage",
  workspaceRevert: "kripl:workspace-revert",
  probeLocalModels: "kripl:probe-local-models",
  agentSessions: "kripl:agent-sessions",
  agentStart: "kripl:agent-start",
  agentSessionSnapshot: "kripl:agent-session-snapshot",
  agentSend: "kripl:agent-send",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentRespondInteraction: "kripl:agent-respond-interaction",
  agentEvent: "kripl:agent-event",
  browserGetState: "kripl:browser-get-state",
  browserSetVisible: "kripl:browser-set-visible",
  browserState: "kripl:browser-state",
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

async function listWorkspaceSessions(workspacePath: string): Promise<AgentSessionSummary[]> {
  return new PiSessionCatalog(piSessionDir()).list(workspacePath);
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

  return {
    networkMode: record.networkMode,
    modelRouting: "local-only",
    permissions: parsePermissionPolicy(record.permissions)
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

  await Promise.all([
    disposeActiveAgent(),
    terminalRuntime.kill()
  ]);

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
  activeAgentUnsubscribe?.();
  activeAgentUnsubscribe = undefined;
  activeAgentStatus = "stopped";

  if (agent) {
    await agent.dispose();
  }
}

function forwardAgentEvent(target: Electron.WebContents, event: AgentEvent): void {
  void contextRuntime.record(event);

  if (event.type === "agent.status") {
    activeAgentStatus = event.status;
    if (event.status === "ready") {
      void rememberActiveAgentSession();
    }
  }

  if (event.type === "agent.raw" || target.isDestroyed()) return;
  target.send(IPC.agentEvent, event);
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
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC.browserState, state);
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#0d1014",
    title: "Kripl Studio",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDir, "../renderer/index.html"));
  }

  return window;
}

function registerIpc(): void {
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

      await disposeActiveAgent();
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

  ipcMain.handle(IPC.agentSessions, async (): Promise<AgentSessionSummary[]> => {
    const workspace = workspaceRuntime.descriptor();
    if (!workspace) return [];
    return listWorkspaceSessions(workspace.path);
  });

  ipcMain.handle(IPC.agentSessionSnapshot, async (): Promise<AgentSessionSnapshot | null> => {
    if (!activeAgent) return null;
    return activeAgent.getSessionSnapshot();
  });

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

  ipcMain.handle(IPC.agentStart, async (event, request: unknown): Promise<ActionResult> => {
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

      await disposeActiveAgent();

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
          modelId: localModel.modelId
        },
        networkMode: runtimeSettings.networkMode,
        permissionPolicy,
        toolBridge
      });

      activeAgent = agent;
      activeAgentStatus = "starting";
      activeAgentUnsubscribe = agent.subscribe((agentEvent) => {
        forwardAgentEvent(event.sender, agentEvent);
      });

      await agent.start({
        workspacePath: workspace.path,
        ...(sessionPath ? { sessionPath } : {})
      });
      await rememberActiveAgentSession();
      return { ok: true };
    } catch (error) {
      await disposeActiveAgent();
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

  ipcMain.handle(IPC.browserGetState, (): BrowserState => {
    return browserRuntime?.getState() ?? emptyBrowserState();
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
  const window = createWindow();
  await initializeBrowserRuntime(window);
  initializeTerminalForwarding(window);
  initializeContextForwarding(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = createWindow();
      void initializeBrowserRuntime(nextWindow);
      initializeTerminalForwarding(nextWindow);
      initializeContextForwarding(nextWindow);
    }
  });
});

app.on("before-quit", () => {
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
  void disposeActiveAgent();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
