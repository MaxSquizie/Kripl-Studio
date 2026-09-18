import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizePiEvent } from "../dist/pi-event-normalizer.js";
import {
  KRIPL_PI_PROVIDER,
  writePiLocalModelConfig
} from "../dist/pi-local-config.js";

test("writes an isolated Pi provider config for the selected local model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await writePiLocalModelConfig(directory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "qwen-local"
    });

    const document = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    const provider = document.providers[KRIPL_PI_PROVIDER];

    assert.equal(provider.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.apiKey, "kripl-local");
    assert.equal(provider.models[0].id, "qwen-local");
    assert.equal(provider.models[0].cost.input, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi adapter refuses a remote model URL even if called directly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-pi-"));

  try {
    await assert.rejects(
      () =>
        writePiLocalModelConfig(directory, {
          baseUrl: "https://example.com/v1",
          modelId: "remote-model"
        }),
      /loopback/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes Pi text deltas without leaking protocol details into the UI", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello"
      }
    }),
    [
      {
        type: "agent.stream",
        channel: "text",
        phase: "delta",
        contentIndex: 0,
        delta: "hello"
      }
    ]
  );
});

test("normalizes tool failures", () => {
  assert.deepEqual(
    normalizePiEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true
    }),
    [
      {
        type: "agent.tool",
        phase: "failed",
        callId: "call-1",
        name: "bash",
        payload: { content: [{ type: "text", text: "failed" }] }
      }
    ]
  );
});

test("uses agent_settled as the ready boundary", () => {
  assert.deepEqual(normalizePiEvent({ type: "agent_start" }), [
    { type: "agent.status", status: "running" }
  ]);
  assert.deepEqual(normalizePiEvent({ type: "agent_settled" }), [
    { type: "agent.status", status: "ready" }
  ]);
});
