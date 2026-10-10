import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionCatalog } from "../dist/index.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionText(id, cwd, prompt) {
  const timestamp = "2026-10-10T12:00:00.000Z";
  return [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "message", id: `${id}-user`, parentId: null, timestamp,
      message: { role: "user", content: prompt, timestamp: Date.parse(timestamp) } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "kripl-catalog-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const file = join(directory, "session.jsonl");
  await writeFile(file, sessionText("session-1", workspace, "alpha"));
  return { directory, workspace, file, catalog: new PiSessionCatalog(directory) };
}

function countReads(t) {
  const original = SessionManager.list.bind(SessionManager);
  let reads = 0;
  t.mock.method(SessionManager, "list", (...args) => { reads += 1; return original(...args); });
  return () => reads;
}

test("unchanged catalogs reuse only lightweight summaries and callers cannot mutate the cache", async (t) => {
  const { workspace, catalog } = await fixture(t);
  const reads = countReads(t);
  const first = await catalog.list(workspace);
  assert.equal(first.length, 1);
  assert.equal(first[0].firstMessage, "alpha");
  assert.equal("allMessagesText" in first[0], false);
  first[0].firstMessage = "caller mutation";
  first.length = 0;

  const second = await catalog.list(workspace);
  assert.equal(second.length, 1);
  assert.equal(second[0].firstMessage, "alpha");
  assert.equal(reads(), 1);
});

test("concurrent requests for the same directory revision share one Pi read", { timeout: 10_000 }, async (t) => {
  const { workspace, catalog } = await fixture(t);
  const original = SessionManager.list.bind(SessionManager);
  const entered = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  let reads = 0;
  t.mock.method(SessionManager, "list", async (...args) => {
    reads += 1;
    entered.resolve();
    await gate.promise;
    return original(...args);
  });

  const requests = Array.from({ length: 8 }, () => catalog.list(workspace));
  await entered.promise;
  gate.resolve();
  const results = await Promise.all(requests);
  assert.equal(reads, 1);
  assert.ok(results.every((result) => result[0].firstMessage === "alpha"));
  assert.notEqual(results[0], results[1]);
  assert.notEqual(results[0][0], results[1][0]);
  await catalog.list(workspace);
  assert.equal(reads, 1);
});

test("creation, deletion, same-size edits and Pi name records invalidate the signature", async (t) => {
  const { directory, workspace, file, catalog } = await fixture(t);
  const reads = countReads(t);
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  await utimes(file, fixedTime, fixedTime);
  await catalog.list(workspace);
  const initial = await stat(file, { bigint: true });

  await writeFile(file, sessionText("session-1", workspace, "bravo"));
  await utimes(file, fixedTime, fixedTime);
  const edited = await stat(file, { bigint: true });
  assert.equal(edited.size, initial.size);
  assert.equal(edited.mtimeNs, initial.mtimeNs);
  assert.equal((await catalog.list(workspace))[0].firstMessage, "bravo");

  await appendFile(file, JSON.stringify({
    type: "session_info", id: "name-1", parentId: "session-1-user",
    timestamp: "2026-10-10T12:01:00.000Z", name: "Renamed session"
  }) + "\n");
  assert.equal((await catalog.list(workspace))[0].name, "Renamed session");

  const second = join(directory, "second.jsonl");
  await writeFile(second, sessionText("session-2", workspace, "second"));
  assert.equal((await catalog.list(workspace)).length, 2);
  await unlink(second);
  assert.equal((await catalog.list(workspace)).length, 1);
  assert.equal(reads(), 5);
});

test("cache keeps one workspace and preserves Pi filtering of a shared session directory", async (t) => {
  const { directory, workspace, catalog } = await fixture(t);
  const otherWorkspace = join(directory, "other-workspace");
  await writeFile(join(directory, "other.jsonl"), sessionText("other", otherWorkspace, "other project"));
  const reads = countReads(t);
  assert.deepEqual((await catalog.list(workspace)).map((session) => session.id), ["session-1"]);
  assert.deepEqual((await catalog.list(otherWorkspace)).map((session) => session.id), ["other"]);
  assert.deepEqual((await catalog.list(workspace)).map((session) => session.id), ["session-1"]);
  assert.equal(reads(), 3);
});

test("cache selectors do not add path case normalization beyond Pi's public API", async (t) => {
  const { catalog } = await fixture(t);
  let reads = 0;
  t.mock.method(SessionManager, "list", async (cwd) => {
    reads += 1;
    return [{
      path: "/session.jsonl", id: cwd, cwd, created: new Date(0), modified: new Date(0),
      messageCount: 1, firstMessage: cwd, allMessagesText: cwd
    }];
  });
  assert.equal((await catalog.list("C:/Project"))[0].id, "C:/Project");
  assert.equal((await catalog.list("c:/project"))[0].id, "c:/project");
  assert.equal(reads, 2);
});

test("a missing directory and an unsuccessful read never become persistent empty cache hits", async (t) => {
  const { directory, workspace } = await fixture(t);
  const missing = join(directory, "new-sessions");
  const catalog = new PiSessionCatalog(missing);
  assert.deepEqual(await catalog.list(workspace), []);
  await mkdir(missing);
  await writeFile(join(missing, "new.jsonl"), sessionText("new", workspace, "created later"));

  const original = SessionManager.list.bind(SessionManager);
  let attempts = 0;
  t.mock.method(SessionManager, "list", (...args) => {
    if (++attempts === 1) throw new Error("temporary list failure");
    return original(...args);
  });
  await assert.rejects(catalog.list(workspace), /temporary list failure/);
  assert.equal((await catalog.list(workspace))[0].id, "new");
  assert.equal(attempts, 2);
});

test("Pi's empty-on-I/O-error result is retried even when file metadata stays unchanged", async (t) => {
  const { workspace, catalog } = await fixture(t);
  const original = SessionManager.list.bind(SessionManager);
  let attempts = 0;
  t.mock.method(SessionManager, "list", (...args) => {
    if (++attempts === 1) return Promise.resolve([]);
    return original(...args);
  });
  assert.deepEqual(await catalog.list(workspace), []);
  assert.equal((await catalog.list(workspace))[0].id, "session-1");
  assert.equal(attempts, 2);
});

test("a newer directory revision does not join an older read or get replaced by its completion", { timeout: 10_000 }, async (t) => {
  const { workspace, file, catalog } = await fixture(t);
  const original = SessionManager.list.bind(SessionManager);
  const captured = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  let reads = 0;
  t.mock.method(SessionManager, "list", async (...args) => {
    const number = ++reads;
    const result = await original(...args);
    if (number === 1) {
      captured.resolve();
      await gate.promise;
    }
    return result;
  });

  const before = catalog.list(workspace);
  await captured.promise;
  await writeFile(file, sessionText("session-1", workspace, "newer content"));
  const after = await catalog.list(workspace);
  assert.equal(after[0].firstMessage, "newer content");
  assert.equal(reads, 2);
  gate.resolve();
  assert.equal((await before)[0].firstMessage, "alpha");
  assert.equal((await catalog.list(workspace))[0].firstMessage, "newer content");
  assert.equal(reads, 2);
});

test("oversized summary lists are returned without retaining an unbounded cache", async (t) => {
  const { workspace, catalog } = await fixture(t);
  let reads = 0;
  t.mock.method(SessionManager, "list", async () => {
    reads += 1;
    return [{
      path: "/session.jsonl", id: "large", cwd: workspace,
      created: new Date(0), modified: new Date(0), messageCount: 1,
      firstMessage: "x".repeat(1_000_001), allMessagesText: "not cached"
    }];
  });
  assert.equal((await catalog.list(workspace))[0].firstMessage.length, 1_000_001);
  assert.equal((await catalog.list(workspace))[0].firstMessage.length, 1_000_001);
  assert.equal(reads, 2);
});
