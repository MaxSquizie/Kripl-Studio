import type {
  NetworkMode,
  PermissionDecision,
  PermissionEffect,
  PermissionPolicy,
  PermissionRequest,
  PermissionScope
} from "@kripl/core";
import { PERMISSION_SCOPES } from "@kripl/core";

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  version: 1,
  rules: {
    "filesystem.read.workspace": "allow",
    "filesystem.read.outside": "ask",
    "filesystem.write.workspace": "allow",
    "filesystem.write.sensitive": "ask",
    "filesystem.write.outside": "ask",
    "shell.safe": "ask",
    "shell.dangerous": "ask",
    "network.search": "allow",
    "network.read": "allow",
    "network.write": "ask",
    "network.auth": "ask",
    "tool.unknown": "ask"
  }
};

const VALID_EFFECTS = new Set<PermissionEffect>(["allow", "ask", "deny"]);
const VALID_SCOPES = new Set<PermissionScope>(PERMISSION_SCOPES);
const NETWORK_SCOPES: PermissionScope[] = [
  "network.search",
  "network.read",
  "network.write",
  "network.auth"
];

export function clonePermissionPolicy(policy: PermissionPolicy): PermissionPolicy {
  return {
    version: 1,
    rules: { ...policy.rules }
  };
}

export function resolvePermissionEffect(
  policy: PermissionPolicy,
  scope: PermissionScope
): PermissionEffect {
  return policy.rules[scope] ?? "ask";
}

export function effectivePermissionPolicy(
  policy: PermissionPolicy,
  networkMode: NetworkMode
): PermissionPolicy {
  const effective = clonePermissionPolicy(policy);

  if (networkMode === "restricted") {
    for (const scope of NETWORK_SCOPES) {
      if (effective.rules[scope] !== "deny") {
        effective.rules[scope] = "ask";
      }
    }
  } else if (networkMode === "offline") {
    for (const scope of NETWORK_SCOPES) {
      effective.rules[scope] = "deny";
    }
  }

  return effective;
}

export function decidePermission(
  policy: PermissionPolicy,
  request: PermissionRequest
): PermissionDecision {
  return {
    effect: resolvePermissionEffect(policy, request.scope),
    request
  };
}

export function parsePermissionPolicy(value: unknown): PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Permission policy must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("Unsupported permission policy version.");
  }

  if (!record.rules || typeof record.rules !== "object" || Array.isArray(record.rules)) {
    throw new Error("Permission policy rules must be an object.");
  }

  const rules: Partial<Record<PermissionScope, PermissionEffect>> = {};
  for (const [scope, effect] of Object.entries(record.rules as Record<string, unknown>)) {
    if (!VALID_SCOPES.has(scope as PermissionScope)) {
      throw new Error(`Unknown permission scope "${scope}".`);
    }
    if (typeof effect !== "string" || !VALID_EFFECTS.has(effect as PermissionEffect)) {
      throw new Error(`Invalid permission effect for "${scope}".`);
    }
    rules[scope as PermissionScope] = effect as PermissionEffect;
  }

  return { version: 1, rules };
}
