export interface WorkspaceDescriptor {
  path: string;
  name: string;
  gitRepository: boolean;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size?: number;
  symlink?: boolean;
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  language?: string;
  content?: string;
}

export type WorkspaceChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface WorkspaceChange {
  path: string;
  status: WorkspaceChangeStatus;
  staged: boolean;
  unstaged: boolean;
  oldPath?: string;
}

export interface WorkspaceDiff {
  path: string;
  status: WorkspaceChangeStatus;
  staged: boolean;
  unstaged: boolean;
  patch: string;
  truncated: boolean;
}

export interface WorkspaceGitStatus {
  branch?: string;
  detached: boolean;
  headSha?: string;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface WorkspaceCommitResult {
  sha: string;
  shortSha: string;
  message: string;
}

export interface WorkspaceRuntime {
  readonly id: string;

  open(path: string): Promise<WorkspaceDescriptor>;
  descriptor(): WorkspaceDescriptor | null;
  list(path?: string): Promise<WorkspaceEntry[]>;
  readFile(path: string): Promise<WorkspaceFilePreview>;
  writeFile(path: string, content: string): Promise<WorkspaceFilePreview>;
  getChanges(): Promise<WorkspaceChange[]>;
  getDiff(path: string): Promise<WorkspaceDiff>;
  getGitStatus(): Promise<WorkspaceGitStatus>;
  commit(message: string): Promise<WorkspaceCommitResult>;
  stage(path: string): Promise<void>;
  unstage(path: string): Promise<void>;
  revert(path: string): Promise<void>;
  dispose(): Promise<void>;
}
