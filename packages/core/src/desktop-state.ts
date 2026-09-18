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

export interface DesktopRuntimeSettings extends RuntimePolicy {
  permissions: PermissionPolicy;
}

export interface DesktopPersistenceState {
  version: 1;
  recentProjects: RecentProject[];
  lastWorkspacePath?: string;
  ui: DesktopUiState;
  runtime: DesktopRuntimeSettings;
}

export interface DesktopBootstrapState {
  workspace: WorkspaceDescriptor | null;
  recentProjects: RecentProject[];
  ui: DesktopUiState;
  runtime: DesktopRuntimeSettings;
}
