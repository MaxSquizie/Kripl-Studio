import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/tool-payload-preview.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent"
}).outputFiles[0].text;
const previewModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), previewModule, previewModule.exports
);
const { toolPayloadPreview } = previewModule.exports;

function previousPreview(value, limit = 1800) {
  const json = JSON.stringify(value, null, 2);
  return json.length > limit ? json.slice(0, limit) + "\n…" : json;
}

test("JSON tool results retain the previous indented format and exact truncated prefix", () => {
  const values = [
    null, true, false, 12.5, -0, NaN, Infinity, "plain text", {}, [],
    { status: "ok", content: [{ type: "text", text: "line\nquote\"\t\\\u0001" }], skipped: undefined },
    [1, null, undefined, NaN, { language: "Русский", emoji: "😀", lone: "\ud800" }],
    { nested: { values: [1, 2, 3], empty: {} }, time: new Date("2026-10-10T12:00:00Z") },
    { content: "output ".repeat(500) }
  ];
  for (const value of values) {
    for (const limit of [0, 1, 2, 9, 39, 150, 1800]) {
      assert.equal(toolPayloadPreview(value, limit), previousPreview(value, limit));
    }
  }
  assert.equal(toolPayloadPreview(undefined), "");
});

test("large strings stop before reading later fields or invoking serialization hooks", () => {
  let laterReads = 0;
  let serializationCalls = 0;
  const target = { content: "x".repeat(5_000_000), later: "not needed" };
  Object.defineProperty(target, "toJSON", { value() { serializationCalls += 1; throw new Error("must not serialize"); } });
  const payload = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      if (key === "later") laterReads += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    }
  });
  const result = toolPayloadPreview(payload);
  assert.equal(result, previousPreview({ content: target.content }));
  assert.equal(result.length, 1802);
  assert.equal(laterReads, 0);
  assert.equal(serializationCalls, 0);
});

test("million-entry arrays are inspected only as far as the display budget", () => {
  let reads = 0;
  const payload = new Proxy(new Array(1_000_000), {
    getOwnPropertyDescriptor(object, key) {
      if (/^\d+$/.test(key)) {
        reads += 1;
        return { value: "result", enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(object, key);
    }
  });
  assert.equal(toolPayloadPreview(payload, 120), previousPreview(new Array(20).fill("result"), 120));
  assert.ok(reads < 20, `unexpectedly inspected ${reads} array values`);
});

test("cycles, accessors and non-JSON values cannot break tool event processing", () => {
  let getterCalls = 0;
  const shared = { name: "shared" };
  const payload = { first: shared, second: shared, big: 1n };
  payload.self = payload;
  Object.defineProperty(payload, "getter", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error("must not execute getter"); }
  });
  const preview = toolPayloadPreview(payload);
  assert.deepEqual(JSON.parse(preview), {
    first: { name: "shared" }, second: { name: "shared" }, big: "[BigInt]",
    self: "[Circular]", getter: "[Getter]"
  });
  assert.equal(getterCalls, 0);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => toolPayloadPreview(revoked.proxy));
});

test("deep structures and objects full of omitted fields remain bounded", () => {
  const root = {};
  let leaf = root;
  for (let depth = 0; depth < 20_000; depth += 1) leaf = leaf.child = {};
  const result = toolPayloadPreview(root);
  assert.equal(result.length, 1802);
  assert.match(result, /\n…$/);

  let reads = 0;
  const omitted = new Proxy(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [index, undefined])), {
    getOwnPropertyDescriptor(object, key) {
      reads += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    }
  });
  assert.match(toolPayloadPreview(omitted, 100), /\n…$/);
  assert.ok(reads < 1000, `unexpectedly inspected ${reads} omitted fields`);
});
