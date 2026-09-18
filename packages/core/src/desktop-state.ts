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

export interface DesktopPersistenceState {
  version: 1;
  recentProjects: RecentProject[];
  lastWorkspacePath?: string;
  ui: DesktopUiState;
}

export interface DesktopBootstrapState {
  workspace: WorkspaceDescriptor | null;
  recentProjects: RecentProject[];
  ui: DesktopUiState;
}
