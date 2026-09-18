import assert from "node:assert/strict";
import test from "node:test";

import { InspectableContextRuntime } from "../dist/index.js";

class FakeMemory {
  id = "memory:test";
  observed = [];
  queries = [];
  status = { status: "ready" };

  async health() {
    return this.status;
  }

  async retrieve(query) {
    this.queries.push(query);
    return [
      {
        id: "m1",
        kind: "semantic",
        content: "Remembered architecture decision",
        relevance: 0.91,
        confidence: 0.88,
        source: "test"
      }
    ];
  }

  async observe(event) {
    this.observed.push(event);
  }

  async dispose() {}
}

test("journal is bounded and ignores raw and stream delta noise", async () => {
  const memory = new FakeMemory();
  const runtime = new InspectableContextRuntime({ memory, maxEvents: 10 });
  await runtime.initialize();

  await runtime.record({ type: "agent.raw", source: "pi", payload: { x: 1 } });
  await runtime.record({
    type: "agent.stream",
    channel: "text",
    phase: "delta",
    contentIndex: 0,
    delta: "token"
  });

  for (let index = 0; index < 15; index += 1) {
    await runtime.record({
      type: "agent.notification",
      level: "info",
      message: "event-" + index
    });
  }

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.recentEvents.length, 10);
  assert.equal(snapshot.recentEvents[0].event.message, "event-5");
  assert.equal(snapshot.recentEvents.at(-1).event.message, "event-14");
});

test("memory observes semantic events but not token deltas or status noise", async () => {
  const memory = new FakeMemory();
  const runtime = new InspectableContextRuntime({ memory });
  await runtime.initialize();

  await runtime.record({
    type: "user.message",
    text: "Inspect the parser",
    workspacePath: "C:/repo"
  });
  await runtime.record({
    type: "agent.status",
    status: "running"
  });
  await runtime.record({
    type: "agent.stream",
    channel: "text",
    phase: "delta",
    contentIndex: 0,
    delta: "partial"
  });
  await runtime.record({
    type: "agent.stream",
    channel: "text",
    phase: "completed",
    contentIndex: 0,
    content: "Done"
  });
  await runtime.record({
    type: "agent.tool",
    phase: "completed",
    callId: "t1",
    name: "read",
    payload: { path: "src/a.ts" }
  });

  assert.deepEqual(
    memory.observed.map((entry) => entry.event.type),
    ["user.message", "agent.stream", "agent.tool"]
  );
});

test("retrieval updates inspector memory state and records query/result events", async () => {
  const memory = new FakeMemory();
  const runtime = new InspectableContextRuntime({ memory });
  await runtime.initialize();

  const items = await runtime.retrieveMemory("quantifier architecture", "C:/repo", 4);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "m1");
  assert.equal(memory.queries.length, 1);
  assert.equal(memory.queries[0].limit, 4);
  assert.equal(memory.queries[0].workspacePath, "C:/repo");

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.memoryRuntimeId, "memory:test");
  assert.equal(snapshot.memoryHealth.status, "ready");
  assert.equal(snapshot.retrievedMemory[0].content, "Remembered architecture decision");

  const tail = snapshot.recentEvents.slice(-2).map((entry) => entry.event.type);
  assert.deepEqual(tail, ["memory.query", "memory.retrieved"]);
});

test("memory observation failure degrades inspector without losing the event", async () => {
  const memory = new FakeMemory();
  memory.observe = async () => {
    throw new Error("memory unavailable");
  };

  const runtime = new InspectableContextRuntime({ memory });
  await runtime.initialize();
  await runtime.record({ type: "user.message", text: "hello" });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.memoryHealth.status, "degraded");
  assert.match(snapshot.memoryHealth.message, /memory unavailable/);
  assert.equal(snapshot.recentEvents.at(-1).event.type, "user.message");
});
