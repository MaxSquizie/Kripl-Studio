import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/agent-event-buffer.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false
}).outputFiles[0].text;
const bufferModule = { exports: {} };
new Function("require", "module", "exports", compiled)(createRequire(import.meta.url), bufferModule, bufferModule.exports);
const { createAgentEventBuffer } = bufferModule.exports;

function fixture() {
  const output = [];
  const frames = new Map();
  let id = 0;
  const buffer = createAgentEventBuffer((event) => output.push(event), (flush) => {
    frames.set(++id, flush);
    return id;
  }, (handle) => frames.delete(handle));
  return { buffer, output, frames, frame() {
    for (const flush of [...frames.values()]) flush();
  } };
}

const delta = (text, options = {}) => ({
  type: "agent.stream", channel: "text", phase: "delta", contentIndex: 0, delta: text, agentId: 1, ...options
});

test("thousands of token events produce one frame update without losing Unicode or order", () => {
  const f = fixture();
  const chunks = Array.from({ length: 5000 }, (_, index) => `${index}:Крипл🙂\n`);
  for (const text of chunks) f.buffer.push(delta(text));
  assert.equal(f.frames.size, 1);
  assert.equal(f.output.length, 0);
  f.frame();
  assert.deepEqual(f.output, [delta(chunks.join(""))]);
  assert.equal(f.frames.size, 0);
});

test("completion, interruption and permissions always follow all preceding tokens", () => {
  const controls = [
    { type: "agent.stream", phase: "completed", channel: "text", contentIndex: 0, content: "last tokens" },
    { type: "agent.status", status: "ready" },
    { type: "agent.status", status: "error", message: "Disconnected" },
    { type: "agent.interaction", request: { id: "permission", kind: "confirm", title: "Run command?" } }
  ];
  for (const control of controls) {
    const f = fixture();
    f.buffer.push(delta("last "));
    f.buffer.push(delta("tokens"));
    f.buffer.push(control);
    f.frame();
    assert.deepEqual(f.output, [delta("last tokens"), control]);
    assert.equal(f.frames.size, 0);
  }
});

test("reasoning, content blocks and different agents keep separate boundaries", () => {
  const f = fixture();
  const events = [delta("reason", { channel: "thinking" }), delta("answer"),
    delta("next block", { contentIndex: 1 }), delta("background", { agentId: 2 })];
  for (const event of events) f.buffer.push(event);
  f.frame();
  assert.deepEqual(f.output, events);
});

test("session switch and unmount cancel queued content and permit a clean new session", () => {
  const f = fixture();
  f.buffer.push(delta("old session"));
  f.buffer.clear();
  f.frame();
  assert.deepEqual(f.output, []);
  assert.equal(f.frames.size, 0);
  f.buffer.push(delta("new session", { agentId: 2 }));
  f.frame();
  assert.deepEqual(f.output, [delta("new session", { agentId: 2 })]);
});

test("cumulative tool progress is coalesced but its final result and ordering survive", () => {
  const f = fixture();
  const started = { type: "agent.tool", callId: "tool-1", name: "bash", phase: "started", payload: { command: "build" } };
  f.buffer.push(started);
  let latest;
  for (let index = 0; index < 500; index++) {
    latest = { ...started, phase: "updated", payload: { output: `line ${index}` } };
    f.buffer.push(latest);
  }
  const completed = { ...started, phase: "completed", payload: { output: "done", exitCode: 0 } };
  f.buffer.push(completed);
  f.buffer.push(delta("answer"));
  f.frame();
  assert.deepEqual(f.output, [started, latest, completed, delta("answer")]);
});
