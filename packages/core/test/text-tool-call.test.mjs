import assert from "node:assert/strict";
import test from "node:test";

import { cleanAssistantToolText, findTextToolCall } from "../dist/index.js";

const TOOLS = new Set(["read", "write", "edit", "bash"]);

test("finds a {\"tool\": ...} call embedded in prose", () => {
  const text = 'Let me read that file.\n{"tool":"read","path":"C:\\\\Users\\\\me\\\\file.txt"}';
  const call = findTextToolCall(text, TOOLS);
  assert.ok(call);
  assert.equal(call.name, "read");
  assert.deepEqual(call.args, { path: "C:\\Users\\me\\file.txt" });
});

test("finds a {\"name\": ..., \"arguments\": ...} call", () => {
  const text = 'Sure!\n```json\n{"name":"bash","arguments":{"command":"ls -la"}}\n```';
  const call = findTextToolCall(text, TOOLS);
  assert.ok(call);
  assert.equal(call.name, "bash");
  assert.deepEqual(call.args, { command: "ls -la" });
});

test("ignores unknown tool names and non-call JSON", () => {
  assert.equal(findTextToolCall('{"tool":"rm_everything","path":"/"}', TOOLS), undefined);
  assert.equal(findTextToolCall('{"name":"read"} without arguments', TOOLS), undefined);
  assert.equal(findTextToolCall("Just some prose with a {\"tool\": typo", TOOLS), undefined);
});

test("tolerates trailing commas", () => {
  const text = '{"tool":"write","path":"/tmp/a.txt","content":"hi",}';
  const call = findTextToolCall(text, TOOLS);
  assert.ok(call);
  assert.equal(call.name, "write");
});

test("cleanAssistantToolText replaces the JSON span with a marker", () => {
  const text = 'Let me read that file.\n{"tool":"read","path":"C:\\\\Users\\\\me\\\\file.txt"}\nDone announcing.';
  const cleaned = cleanAssistantToolText(text, new Set(["read"]));
  assert.ok(!cleaned.includes('"tool"'));
  assert.match(cleaned, /⚙ read\(path=/);
  assert.match(cleaned, /Let me read that file/);
  assert.match(cleaned, /Done announcing/);
});

test("cleanAssistantToolText is a no-op without a matching call", () => {
  const text = "No tool calls here, just an object: {\"tool\":\"unknown_thing\"}";
  assert.equal(cleanAssistantToolText(text, new Set(["read"])), text);
});
