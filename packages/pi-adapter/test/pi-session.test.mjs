import assert from "node:assert/strict";
import test from "node:test";

import {
  mapPiSessionInfo,
  normalizePiSessionMessages
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
