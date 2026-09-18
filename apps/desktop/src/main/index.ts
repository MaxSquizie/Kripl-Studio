import type { AgentEvent, AgentInteractionResponse, AgentStatus, BrowserState, WorkspaceChange, WorkspaceDescriptor, WorkspaceDiff, WorkspaceEntry, WorkspaceFilePreview } from "@kripl/core";
import { LocalOpenAIProvider } from "@kripl/local-openai-provider";
import { PiAgentRuntime } from "@kripl/pi-adapter";
import { LocalWorkspaceRuntime } from "@kripl/workspace";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserRuntime } from "./browser-runtime.js";
import { ToolBridgeServer } from "./tool-bridge.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const IPC = {
  appInfo: "kripl:app-info",
  pickWorkspace: "kripl:pick-workspace",
  workspaceList: "kripl:workspace-list",
  workspaceReadFile: "kripl:workspace-read-file",
  workspaceChanges: "kripl:workspace-changes",
  workspaceDiff: "kripl:workspace-diff",
  probeLocalModels: "kripl:probe-local-models",
  agentStart: "kripl:agent-start",
  agentSend: "kripl:agent-send",
  agentAbort: "kripl:agent-abort",
  agentStop: "kripl:agent-stop",
  agentRespondInteraction: "kripl:agent-respond-interaction",
  agentEvent: "kripl:agent-event",
  browserGetState: "kripl:browser-get-state",
  browserSetVisible: "kripl:browser-set-visible",
  browserState: "kripl:browser-state"
} as const;

interface AgentStartRequest {
  endpoint: string;
  modelId: string;
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
const workspaceRuntime = new LocalWorkspaceRuntime();


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

function isAgentStartRequest(value: unknown): value is AgentStartRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.endpoint === "string" &&
    record.endpoint.length > 0 &&
    record.endpoint.length <= 2_048 &&
    typeof record.modelId === "string" &&
    record.modelId.length > 0 &&
    record.modelId.length <= 512
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
  activeAgent = undefined;
  activeAgentUnsubscribe?.();
  activeAgentUnsubscribe = undefined;
  activeAgentStatus = "stopped";

  if (agent) {
    await agent.dispose();
  }
}

function forwardAgentEvent(target: Electron.WebContents, event: AgentEvent): void {
  if (event.type === "agent.status") {
    activeAgentStatus = event.status;
  }

  if (event.type === "agent.raw" || target.isDestroyed()) return;
  target.send(IPC.agentEvent, event);
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
  const bridge = new ToolBridgeServer(runtime);
  await bridge.start();

  browserRuntime = runtime;
  toolBridgeServer = bridge;
  browserUnsubscribe = runtime.subscribe((state) => {
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
  ipcMain.handle(IPC.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    networkMode: "online",
    modelRouting: "local-only"
  }));

  ipcMain.handle(IPC.pickWorkspace, async (): Promise<WorkspaceDescriptor | null> => {
    const result = await dialog.showOpenDialog({
      title: "Open project",
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = result.filePaths[0];
    if (!selected) return null;

    await disposeActiveAgent();
    return workspaceRuntime.open(selected);
  });

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
      return workspaceRuntime.readFile(path);
    }
  );

  ipcMain.handle(IPC.workspaceChanges, async (): Promise<WorkspaceChange[]> => {
    return workspaceRuntime.getChanges();
  });

  ipcMain.handle(IPC.workspaceDiff, async (_event, path: unknown): Promise<WorkspaceDiff> => {
    if (typeof path !== "string" || !path || path.length > 32_768) {
      throw new Error("Invalid workspace diff path.");
    }
    return workspaceRuntime.getDiff(path);
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

      await disposeActiveAgent();

      const toolBridge = toolBridgeServer?.getConnection();
      if (!toolBridge) {
        throw new Error("Kripl browser tool bridge is not ready.");
      }

      const userData = app.getPath("userData");
      const agent = new PiAgentRuntime({
        agentDir: join(userData, "pi-agent"),
        sessionDir: join(userData, "pi-sessions"),
        localModel: {
          baseUrl: localModel.endpoint,
          modelId: localModel.modelId
        },
        networkMode: "online",
        toolBridge
      });

      activeAgent = agent;
      activeAgentStatus = "starting";
      activeAgentUnsubscribe = agent.subscribe((agentEvent) => {
        forwardAgentEvent(event.sender, agentEvent);
      });

      await agent.start({ workspacePath: workspace.path });
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
  registerIpc();
  const window = createWindow();
  await initializeBrowserRuntime(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const nextWindow = createWindow();
      void initializeBrowserRuntime(nextWindow);
    }
  });
});

app.on("before-quit", () => {
  browserUnsubscribe?.();
  browserUnsubscribe = undefined;
  browserRuntime?.dispose();
  browserRuntime = undefined;
  void toolBridgeServer?.dispose();
  toolBridgeServer = undefined;
  void workspaceRuntime.dispose();
  void disposeActiveAgent();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
