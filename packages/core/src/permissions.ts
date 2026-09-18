export type PermissionEffect = "allow" | "ask" | "deny";

export type PermissionScope =
  | "filesystem.read.workspace"
  | "filesystem.read.outside"
  | "filesystem.write.workspace"
  | "filesystem.write.sensitive"
  | "filesystem.write.outside"
  | "shell.safe"
  | "shell.dangerous"
  | "network.search"
  | "network.read"
  | "network.write"
  | "network.auth"
  | "tool.unknown";

export interface PermissionPolicy {
  version: 1;
  rules: Partial<Record<PermissionScope, PermissionEffect>>;
}

export interface PermissionRequest {
  scope: PermissionScope;
  title: string;
  detail: string;
  toolName?: string;
  resource?: string;
}

export interface PermissionDecision {
  effect: PermissionEffect;
  request: PermissionRequest;
}
