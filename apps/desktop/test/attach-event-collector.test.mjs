import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/attach-event-collector.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false
}).outputFiles[0].text;
const collectorModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), collectorModule, collectorModule.exports
);
const { createAttachEventCollector } = collectorModule.exports;

const request = (id = "permission-1", extra = {}) => ({
  id, kind: "confirm", title: "Run command?", message: "npm test", ...extra
});
const interaction = (agentId, value = request()) => ({
  type: "agent.interaction", agentId, request: value
});
const status = (agentId, value, message) => ({
  type: "agent.status", agentId, status: value,
  ...(message !== undefined ? { message } : {})
});
const notification = (agentId, level, message) => ({
  type: "agent.notification", agentId, level, message
});

test("permission collected during attach survives repeated snapshot reads and stopping", () => {
  const collector = createAttachEventCollector();
  const permission = request();
  collector.push(status(1, "running"));
  collector.push(interaction(1, permission));
  assert.deepEqual(collector.forAgent(1), {
    status: { type: "agent.status", status: "running" }, interaction: permission
  });
  collector.push(status(1, "stopping"));
  assert.deepEqual(collector.forAgent(1), {
    status: { type: "agent.status", status: "stopping" }, interaction: permission
  });
  assert.equal(collector.forAgent(1).interaction, permission);
});

test("each agent keeps its own control state and untagged events cannot leak into a chat", () => {
  const collector = createAttachEventCollector();
  const first = request("first");
  const second = request("second", { kind: "select", options: ["Allow", "Cancel"] });
  collector.push(interaction(1, first));
  collector.push(interaction(2, second));
  collector.push(notification(2, "warning", "Background warning"));
  collector.push(status(2, "ready"));
  collector.push({ type: "agent.interaction", request: request("untagged") });
  collector.push({ type: "agent.status", status: "error", message: "Untagged error" });
  assert.deepEqual(collector.forAgent(1), { interaction: first });
  assert.deepEqual(collector.forAgent(2), {
    status: { type: "agent.status", status: "ready" }, errorText: "Background warning"
  });
  assert.deepEqual(collector.forAgent(3), {});
});

test("later terminal states remove old requests without resurrecting them on a new run", () => {
  for (const terminal of ["ready", "stopped", "error", "idle", "starting"]) {
    const collector = createAttachEventCollector();
    collector.push(interaction(1, request("old")));
    collector.push(status(1, terminal));
    assert.equal(collector.forAgent(1).interaction, undefined, terminal);
    collector.push(status(1, "running"));
    assert.equal(collector.forAgent(1).interaction, undefined, terminal);
    const fresh = request("new");
    collector.push(interaction(1, fresh));
    assert.equal(collector.forAgent(1).interaction, fresh, terminal);
  }
});

test("newer requests replace older ones in arrival order", () => {
  const collector = createAttachEventCollector();
  collector.push(interaction(1, request("first")));
  collector.push(interaction(1, request("second")));
  assert.equal(collector.forAgent(1).interaction.id, "second");
  collector.push(status(1, "ready"));
  assert.equal(collector.forAgent(1).interaction, undefined);
});

test("request timeout uses its original deadline and repeated reads preserve other state", () => {
  let time = 1000;
  const collector = createAttachEventCollector(() => time);
  const permission = request("timed", { timeoutMs: 50 });
  collector.push(status(1, "running"));
  collector.push(notification(1, "warning", "Please confirm"));
  collector.push(interaction(1, permission));
  time = 1049;
  assert.equal(collector.forAgent(1).interaction, permission);
  time = 1050;
  assert.deepEqual(collector.forAgent(1), {
    status: { type: "agent.status", status: "running" }, errorText: "Please confirm"
  });
  assert.deepEqual(collector.forAgent(1), {
    status: { type: "agent.status", status: "running" }, errorText: "Please confirm"
  });
  collector.push(interaction(1, request("no-timeout", { timeoutMs: 0 })));
  time += 1_000_000;
  assert.equal(collector.forAgent(1).interaction.id, "no-timeout");
});

test("timer delays outside the RPC timer range expire instead of reviving cancelled requests", () => {
  for (const timeoutMs of [-10, 0.5, 2_147_483_648]) {
    let time = 100;
    const collector = createAttachEventCollector(() => time);
    collector.push(interaction(1, request("timed", { timeoutMs })));
    time += 1;
    assert.equal(collector.forAgent(1).interaction, undefined);
  }
});

test("large stream, tool and raw events and usage do not enter collected state", () => {
  const collector = createAttachEventCollector();
  const permission = request();
  collector.push(interaction(1, permission));
  const content = "x".repeat(5_000_000);
  const ignored = [
    { type: "agent.stream", channel: "text", phase: "delta", contentIndex: 0, delta: content },
    { type: "agent.tool", phase: "updated", callId: "tool", name: "bash", payload: { content } },
    { type: "agent.raw", source: "pi", payload: { content } },
    { type: "agent.usage", input: 100, output: 100 },
    { type: "agent.message", role: "assistant", text: content }
  ];
  for (let index = 0; index < 1000; index += 1) {
    for (const event of ignored) {
      collector.push({ ...event, agentId: 1 });
      collector.push({ ...event, agentId: 2 });
    }
  }
  assert.deepEqual(collector.forAgent(1), { interaction: permission });
  assert.deepEqual(collector.forAgent(2), {});
  assert.ok(JSON.stringify(collector.forAgent(1)).length < 200);
});

test("warnings and status errors preserve the last visible message in event order", () => {
  const collector = createAttachEventCollector();
  collector.push(notification(1, "warning", "First warning"));
  collector.push(notification(1, "info", "Informational"));
  assert.equal(collector.forAgent(1).errorText, "First warning");
  collector.push(status(1, "error", "Agent failed"));
  assert.equal(collector.forAgent(1).errorText, "Agent failed");
  collector.push(notification(1, "error", "More specific failure"));
  collector.push(status(1, "ready"));
  assert.equal(collector.forAgent(1).errorText, "More specific failure");
  collector.push(notification(1, "warning", "Latest warning"));
  assert.equal(collector.forAgent(1).errorText, "Latest warning");
  collector.push(status(1, "error"));
  assert.equal(collector.forAgent(1).errorText, "Pi agent failed.");
});
