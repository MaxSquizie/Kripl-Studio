import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERMISSION_POLICY,
  decidePermission,
  effectivePermissionPolicy,
  parsePermissionPolicy,
  resolvePermissionEffect
} from "../dist/index.js";

test("default policy keeps routine coding actions automatic", () => {
  assert.equal(
    resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "filesystem.read.workspace"),
    "allow"
  );
  assert.equal(
    resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "filesystem.write.workspace"),
    "allow"
  );
  assert.equal(resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "network.read"), "allow");
});

test("default policy asks before risky boundaries", () => {
  assert.equal(
    resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "filesystem.write.outside"),
    "ask"
  );
  assert.equal(resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "shell.safe"), "ask");
  assert.equal(resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "shell.dangerous"), "ask");
  assert.equal(resolvePermissionEffect(DEFAULT_PERMISSION_POLICY, "network.write"), "ask");
});

test("unknown missing rules fail closed to ask", () => {
  const policy = { version: 1, rules: {} };
  assert.equal(resolvePermissionEffect(policy, "tool.unknown"), "ask");
});

test("decision preserves request metadata", () => {
  const request = {
    scope: "shell.dangerous",
    title: "Dangerous shell command",
    detail: "rm -rf build",
    toolName: "bash"
  };

  assert.deepEqual(decidePermission(DEFAULT_PERMISSION_POLICY, request), {
    effect: "ask",
    request
  });
});

test("policy parser rejects invalid effects", () => {
  assert.throws(
    () => parsePermissionPolicy({ version: 1, rules: { "shell.safe": "sometimes" } }),
    /Invalid permission effect/
  );
});


test("restricted mode promotes network allows to ask while preserving deny", () => {
  const policy = {
    version: 1,
    rules: {
      "network.search": "allow",
      "network.read": "allow",
      "network.write": "deny",
      "network.auth": "ask",
      "filesystem.read.workspace": "allow"
    }
  };

  const effective = effectivePermissionPolicy(policy, "restricted");
  assert.equal(effective.rules["network.search"], "ask");
  assert.equal(effective.rules["network.read"], "ask");
  assert.equal(effective.rules["network.write"], "deny");
  assert.equal(effective.rules["network.auth"], "ask");
  assert.equal(effective.rules["filesystem.read.workspace"], "allow");
});

test("offline mode denies every network scope without mutating the base policy", () => {
  const base = {
    version: 1,
    rules: {
      "network.search": "allow",
      "network.read": "ask",
      "network.write": "allow",
      "network.auth": "deny"
    }
  };

  const effective = effectivePermissionPolicy(base, "offline");
  assert.equal(effective.rules["network.search"], "deny");
  assert.equal(effective.rules["network.read"], "deny");
  assert.equal(effective.rules["network.write"], "deny");
  assert.equal(effective.rules["network.auth"], "deny");

  assert.equal(base.rules["network.search"], "allow");
  assert.equal(base.rules["network.read"], "ask");
});

test("policy parser rejects unknown scopes", () => {
  assert.throws(
    () => parsePermissionPolicy({ version: 1, rules: { "network.telepathy": "allow" } }),
    /Unknown permission scope/
  );
});
