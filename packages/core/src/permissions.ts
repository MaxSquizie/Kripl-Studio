export type PermissionEffect = "allow" | "ask" | "deny";

export const PERMISSION_SCOPES = [
  "filesystem.read.workspace",
  "filesystem.read.outside",
  "filesystem.write.workspace",
  "filesystem.write.sensitive",
  "filesystem.write.outside",
  "shell.safe",
  "shell.dangerous",
  "network.search",
  "network.read",
  "network.write",
  "network.auth",
  "tool.unknown"
] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

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
