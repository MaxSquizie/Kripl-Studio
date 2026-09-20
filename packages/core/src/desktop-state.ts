import type { PermissionPolicy } from "./permissions.js";
import type { RuntimePolicy } from "./network-policy.js";
import type { WorkspaceDescriptor } from "./workspace-runtime.js";

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface PersistedWorkspaceView {
  type: "agent" | "file" | "diff";
  path?: string;
}

export interface DesktopUiState {
  workspaceView: PersistedWorkspaceView;
  expandedDirectories: string[];
}

/**
 * Optional per-model generation tuning.
 *
 * - `systemPrompt` is appended to the agent's system prompt on every turn.
 * - `temperature` overrides sampling temperature (0-2); absent = provider default.
 */
export interface ModelTuning {
  systemPrompt?: string;
  temperature?: number;
}

export interface DesktopRuntimeSettings extends RuntimePolicy {
  permissions: PermissionPolicy;
  modelTuning?: ModelTuning;
}

export interface DesktopPersistenceState {
  version: 1;
  recentProjects: RecentProject[];
  lastWorkspacePath?: string;
  lastSessionByWorkspace: Record<string, string>;
  ui: DesktopUiState;
  runtime: DesktopRuntimeSettings;
}

export interface DesktopBootstrapState {
  workspace: WorkspaceDescriptor | null;
  recentProjects: RecentProject[];
  lastSessionPath?: string;
  ui: DesktopUiState;
  runtime: DesktopRuntimeSettings;
}
