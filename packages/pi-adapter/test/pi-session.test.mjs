import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  mapPiSessionInfo,
  normalizePiSessionMessages,
  PiSessionCatalog
} from "../dist/index.js";

test("normalizes Pi user, assistant, tool and summary messages without image payloads", () => {
  const messages = normalizePiSessionMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect parser" },
        { type: "image", data: "very-large-base64", mimeType: "image/png" }
      ],
      timestamp: 100
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private-ish persisted reasoning" },
        { type: "text", text: "I found the issue." },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }
      ],
      timestamp: 200
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 300
    },
    {
      role: "compactionSummary",
      summary: "Earlier work summary",
      timestamp: 400
    }
  ]);

  assert.deepEqual(messages, [
    { role: "user", text: "Inspect parser", timestamp: 100 },
    { role: "assistant", text: "I found the issue.", timestamp: 200 },
    { role: "tool", text: "file contents", toolName: "read", timestamp: 300 },
    { role: "system", text: "Earlier work summary", timestamp: 400 }
  ]);
});

test("normalizes persisted bash execution without exposing unrelated fields", () => {
  const messages = normalizePiSessionMessages([
    {
      role: "bashExecution",
      command: "npm test",
      output: "ok",
      exitCode: 0,
      cancelled: false,
      fullOutputPath: "C:/secret/full-output.log",
      timestamp: 500
    },
    {
      role: "bashExecution",
      command: "npm run fail",
      output: "failed",
      exitCode: 1,
      timestamp: 600
    }
  ]);

  assert.deepEqual(messages, [
    {
      role: "tool",
      text: "$ npm test\nok",
      toolName: "bash",
      timestamp: 500
    },
    {
      role: "tool",
      text: "$ npm run fail\nfailed",
      toolName: "bash",
      isError: true,
      timestamp: 600
    }
  ]);
});

test("maps Pi SessionInfo to generic session summary", () => {
  const summary = mapPiSessionInfo({
    path: "C:/state/pi-sessions/session.jsonl",
    id: "abc",
    cwd: "C:/repo",
    name: "Parser work",
    parentSessionPath: "C:/state/pi-sessions/parent.jsonl",
    created: new Date("2026-09-18T10:00:00Z"),
    modified: new Date("2026-09-18T11:00:00Z"),
    messageCount: 12,
    firstMessage: "Fix the parser",
    allMessagesText: "not exposed"
  });

  assert.deepEqual(summary, {
    path: "C:/state/pi-sessions/session.jsonl",
    id: "abc",
    workspacePath: "C:/repo",
    name: "Parser work",
    parentSessionPath: "C:/state/pi-sessions/parent.jsonl",
    createdAt: Date.parse("2026-09-18T10:00:00Z"),
    modifiedAt: Date.parse("2026-09-18T11:00:00Z"),
    messageCount: 12,
    firstMessage: "Fix the parser"
  });
});


test("PiSessionCatalog filters a custom session root by workspace cwd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-sessions-"));
  const workspaceA = resolve(join(directory, "workspace-a"));
  const workspaceB = resolve(join(directory, "workspace-b"));

  const session = (id, cwd, prompt, timestamp) => [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd
    }),
    JSON.stringify({
      type: "message",
      id: id + "u",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: prompt,
        timestamp: Date.parse(timestamp)
      }
    }),
    JSON.stringify({
      type: "message",
      id: id + "a",
      parentId: id + "u",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "kripl-local",
        model: "test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp)
      }
    })
  ].join("\n") + "\n";

  try {
    await writeFile(
      join(directory, "a.jsonl"),
      session("session-a", workspaceA, "Work on A", "2026-09-18T10:00:00.000Z"),
      "utf8"
    );
    await writeFile(
      join(directory, "b.jsonl"),
      session("session-b", workspaceB, "Work on B", "2026-09-18T11:00:00.000Z"),
      "utf8"
    );

    const sessions = await new PiSessionCatalog(directory).list(workspaceA);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "session-a");
    assert.equal(sessions[0].workspacePath, workspaceA);
    assert.equal(sessions[0].firstMessage, "Work on A");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumed transcript is bounded and truncates oversized text", () => {
  const input = Array.from({ length: 520 }, (_, index) => ({
    role: "user",
    content: index === 519 ? "x".repeat(25_000) : "message-" + index
  }));

  const messages = normalizePiSessionMessages(input);
  assert.equal(messages.length, 500);
  assert.equal(messages[0].text, "message-20");
  assert.ok(messages.at(-1).text.length < 21_000);
  assert.match(messages.at(-1).text, /…$/);
});
