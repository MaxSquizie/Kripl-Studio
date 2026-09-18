import type {
  DesktopPersistenceState,
  DesktopRuntimeSettings,
  DesktopUiState,
  RecentProject,
  WorkspaceDescriptor
} from "@kripl/core";
import { DEFAULT_RUNTIME_POLICY } from "@kripl/core";
import {
  DEFAULT_PERMISSION_POLICY,
  clonePermissionPolicy,
  parsePermissionPolicy
} from "@kripl/permissions";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_RECENT_PROJECTS = 12;
const MAX_PATH_LENGTH = 32_768;
const MAX_EXPANDED_DIRECTORIES = 256;

function defaultState(): DesktopPersistenceState {
  return {
    version: 1,
    recentProjects: [],
    lastSessionByWorkspace: {},
    ui: {
      workspaceView: { type: "agent" },
      expandedDirectories: []
    },
    runtime: {
      ...DEFAULT_RUNTIME_POLICY,
      permissions: clonePermissionPolicy(DEFAULT_PERMISSION_POLICY)
    }
  };
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH) return undefined;
  try {
    return resolve(value);
  } catch {
    return undefined;
  }
}

function normalizeRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];

  const dedupe = new Set<string>();
  const result: RecentProject[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const path = normalizePath(record.path);
    const name = typeof record.name === "string" && record.name ? record.name.slice(0, 512) : undefined;
    const lastOpenedAt =
      typeof record.lastOpenedAt === "number" && Number.isFinite(record.lastOpenedAt)
        ? record.lastOpenedAt
        : undefined;

    if (!path || !name || lastOpenedAt === undefined) continue;
    if (dedupe.has(path)) continue;
    dedupe.add(path);
    result.push({ path, name, lastOpenedAt });
  }

  return result
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, MAX_RECENT_PROJECTS);
}

function normalizeUi(value: unknown): DesktopUiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultState().ui;
  }

  const record = value as Record<string, unknown>;
  const rawView =
    record.workspaceView && typeof record.workspaceView === "object" && !Array.isArray(record.workspaceView)
      ? (record.workspaceView as Record<string, unknown>)
      : {};

  const type =
    rawView.type === "file" || rawView.type === "diff" || rawView.type === "agent"
      ? rawView.type
      : "agent";
  const path =
    (type === "file" || type === "diff") &&
    typeof rawView.path === "string" &&
    rawView.path.length > 0 &&
    rawView.path.length <= MAX_PATH_LENGTH
      ? rawView.path
      : undefined;

  const expandedDirectories = Array.isArray(record.expandedDirectories)
    ? record.expandedDirectories
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0 && entry.length <= MAX_PATH_LENGTH
        )
        .slice(0, MAX_EXPANDED_DIRECTORIES)
    : [];

  return {
    workspaceView: path ? { type, path } : { type: "agent" },
    expandedDirectories: Array.from(new Set(expandedDirectories))
  };
}

function normalizeLastSessionByWorkspace(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 128);

  for (const [workspacePath, sessionPathValue] of entries) {
    const workspace = normalizePath(workspacePath);
    const session = normalizePath(sessionPathValue);
    if (!workspace || !session) continue;
    result[workspace] = session;
  }

  return result;
}

function normalizeRuntime(value: unknown): DesktopRuntimeSettings {
  const fallback = defaultState().runtime;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;

  const record = value as Record<string, unknown>;
  const networkMode =
    record.networkMode === "online" ||
    record.networkMode === "restricted" ||
    record.networkMode === "offline"
      ? record.networkMode
      : fallback.networkMode;
  const modelRouting =
    record.modelRouting === "local-only"
      ? record.modelRouting
      : fallback.modelRouting;

  let permissions = fallback.permissions;
  try {
    permissions = parsePermissionPolicy(record.permissions);
  } catch {
    permissions = clonePermissionPolicy(DEFAULT_PERMISSION_POLICY);
  }

  return {
    networkMode,
    modelRouting,
    permissions
  };
}

export function normalizeDesktopPersistenceState(value: unknown): DesktopPersistenceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultState();

  const record = value as Record<string, unknown>;
  const recentProjects = normalizeRecentProjects(record.recentProjects);
  const lastWorkspacePath = normalizePath(record.lastWorkspacePath);
  const ui = normalizeUi(record.ui);
  const runtime = normalizeRuntime(record.runtime);
  const lastSessionByWorkspace = normalizeLastSessionByWorkspace(record.lastSessionByWorkspace);

  return {
    version: 1,
    recentProjects,
    ...(lastWorkspacePath ? { lastWorkspacePath } : {}),
    lastSessionByWorkspace,
    ui,
    runtime
  };
}

export class JsonDesktopStateStore {
  private state: DesktopPersistenceState = defaultState();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<DesktopPersistenceState> {
    if (this.loaded) return this.snapshot();

    try {
      const text = await readFile(this.filePath, "utf8");
      this.state = normalizeDesktopPersistenceState(JSON.parse(text));
    } catch {
      this.state = defaultState();
    }

    this.loaded = true;
    return this.snapshot();
  }

  snapshot(): DesktopPersistenceState {
    return {
      version: 1,
      recentProjects: this.state.recentProjects.map((item) => ({ ...item })),
      ...(this.state.lastWorkspacePath ? { lastWorkspacePath: this.state.lastWorkspacePath } : {}),
      lastSessionByWorkspace: { ...this.state.lastSessionByWorkspace },
      ui: {
        workspaceView: { ...this.state.ui.workspaceView },
        expandedDirectories: [...this.state.ui.expandedDirectories]
      },
      runtime: {
        networkMode: this.state.runtime.networkMode,
        modelRouting: this.state.runtime.modelRouting,
        permissions: clonePermissionPolicy(this.state.runtime.permissions)
      }
    };
  }

  async rememberWorkspace(workspace: WorkspaceDescriptor, openedAt = Date.now()): Promise<void> {
    await this.ensureLoaded();

    const canonicalPath = resolve(workspace.path);
    const remaining = this.state.recentProjects.filter((item) => item.path !== canonicalPath);
    this.state.recentProjects = [
      {
        path: canonicalPath,
        name: workspace.name,
        lastOpenedAt: openedAt
      },
      ...remaining
    ].slice(0, MAX_RECENT_PROJECTS);
    this.state.lastWorkspacePath = canonicalPath;
    await this.persist();
  }

  async forgetRecentProject(path: string): Promise<void> {
    await this.ensureLoaded();
    const canonicalPath = resolve(path);
    this.state.recentProjects = this.state.recentProjects.filter(
      (item) => item.path !== canonicalPath
    );
    if (this.state.lastWorkspacePath === canonicalPath) {
      delete this.state.lastWorkspacePath;
      this.state.ui = defaultState().ui;
    }
    await this.persist();
  }

  async clearLastWorkspace(): Promise<void> {
    await this.ensureLoaded();
    delete this.state.lastWorkspacePath;
    this.state.ui = defaultState().ui;
    await this.persist();
  }

  async setUiState(ui: DesktopUiState): Promise<void> {
    await this.ensureLoaded();
    this.state.ui = normalizeUi(ui);
    await this.persist();
  }

  async setRuntimeSettings(runtime: DesktopRuntimeSettings): Promise<void> {
    await this.ensureLoaded();
    this.state.runtime = normalizeRuntime(runtime);
    await this.persist();
  }

  async rememberSession(workspacePath: string, sessionPath: string): Promise<void> {
    await this.ensureLoaded();
    const workspace = resolve(workspacePath);
    const session = resolve(sessionPath);
    this.state.lastSessionByWorkspace = {
      ...this.state.lastSessionByWorkspace,
      [workspace]: session
    };
    await this.persist();
  }

  async forgetSession(workspacePath: string): Promise<void> {
    await this.ensureLoaded();
    const workspace = resolve(workspacePath);
    if (!(workspace in this.state.lastSessionByWorkspace)) return;
    const next = { ...this.state.lastSessionByWorkspace };
    delete next[workspace];
    this.state.lastSessionByWorkspace = next;
    await this.persist();
  }

  lastSessionFor(workspacePath: string): string | undefined {
    return this.state.lastSessionByWorkspace[resolve(workspacePath)];
  }

  hasRecentProject(path: string): boolean {
    const canonicalPath = resolve(path);
    return this.state.recentProjects.some((item) => item.path === canonicalPath);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    const snapshot = this.snapshot();
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = this.filePath + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, this.filePath);
    });
    await this.writeChain;
  }
}
