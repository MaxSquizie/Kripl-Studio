export interface WorkspaceDescriptor {
  path: string;
  name: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface WorkspaceRuntime {
  readonly id: string;

  open(path: string): Promise<WorkspaceDescriptor>;
  list(path?: string): Promise<WorkspaceEntry[]>;
  readText(path: string): Promise<string>;
  dispose(): Promise<void>;
}
