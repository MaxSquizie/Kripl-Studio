import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERMISSION_POLICY,
  decidePermission,
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
