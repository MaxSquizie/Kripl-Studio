import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/main/agent-operation-queue.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false
}).outputFiles[0].text;
const queueModule = { exports: {} };
new Function("require", "module", "exports", compiled)(createRequire(import.meta.url), queueModule, queueModule.exports);
const { AgentOperationQueue } = queueModule.exports;

test("a slow earlier server switch cannot replace the runtime selected by a later attachment", async () => {
  const queue = new AgentOperationQueue();
  const gate = Promise.withResolvers();
  const events = [];
  let active;
  const first = queue.run(async () => {
    events.push("first-started");
    await gate.promise;
    active = "first";
    events.push("first-ready");
  });
  const second = queue.run(async () => {
    active = "second";
    events.push("second-attached");
    return active;
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first-started"]);
  gate.resolve();
  await first;
  assert.equal(await second, "second");
  assert.equal(active, "second");
  assert.deepEqual(events, ["first-started", "first-ready", "second-attached"]);
});

test("a failed connection leaves the queue usable for the next server", async () => {
  const queue = new AgentOperationQueue();
  const failed = queue.run(async () => { throw new Error("Connection rejected"); });
  const next = queue.run(async () => "connected");
  await assert.rejects(failed, /Connection rejected/);
  assert.equal(await next, "connected");
});
