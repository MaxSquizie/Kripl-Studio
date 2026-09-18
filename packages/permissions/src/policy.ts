import type {
  PermissionDecision,
  PermissionEffect,
  PermissionPolicy,
  PermissionRequest,
  PermissionScope
} from "@kripl/core";

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

export function resolvePermissionEffect(
  policy: PermissionPolicy,
  scope: PermissionScope
): PermissionEffect {
  return policy.rules[scope] ?? "ask";
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
    if (typeof effect !== "string" || !VALID_EFFECTS.has(effect as PermissionEffect)) {
      throw new Error(`Invalid permission effect for "${scope}".`);
    }
    rules[scope as PermissionScope] = effect as PermissionEffect;
  }

  return { version: 1, rules };
}
