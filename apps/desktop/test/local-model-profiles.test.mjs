import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/local-model-profiles.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false
}).outputFiles[0].text;
const profilesModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), profilesModule, profilesModule.exports
);
const { loadLocalModelProfiles, saveLocalModelProfiles, sameLocalModelConnection } = profilesModule.exports;

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value)
  };
}

test("existing endpoint and model migrate to LM Studio without filling the Unsloth profile", () => {
  const state = loadLocalModelProfiles(storage({
    "kripl.localEndpoint": "http://127.0.0.1:4321/v1",
    "kripl.selectedModel": "custom-qwen"
  }));
  assert.equal(state.server, "lm-studio");
  assert.deepEqual(state.profiles["lm-studio"], {
    endpoint: "http://127.0.0.1:4321/v1", modelId: "custom-qwen"
  });
  assert.deepEqual(state.profiles.unsloth, { endpoint: "http://127.0.0.1:8888/v1", modelId: "" });
});

test("both profiles and the selected server survive restart independently", () => {
  const persisted = storage();
  const state = loadLocalModelProfiles(persisted);
  state.profiles["lm-studio"] = { endpoint: "http://127.0.0.1:1235/v1", modelId: "lm-model" };
  state.profiles.unsloth = { endpoint: "http://127.0.0.1:8000/v1", modelId: "unsloth-model" };
  state.server = "unsloth";
  saveLocalModelProfiles(persisted, state);
  assert.deepEqual(loadLocalModelProfiles(persisted), state);
  state.server = "lm-studio";
  saveLocalModelProfiles(persisted, state);
  assert.deepEqual(loadLocalModelProfiles(persisted), state);
});

test("clearing a migrated model does not resurrect the legacy selection on restart", () => {
  const persisted = storage({ "kripl.selectedModel": "old-model" });
  const state = loadLocalModelProfiles(persisted);
  state.profiles["lm-studio"].modelId = "";
  saveLocalModelProfiles(persisted, state);
  assert.equal(loadLocalModelProfiles(persisted).profiles["lm-studio"].modelId, "");
});

test("corrupt or unavailable storage preserves usable connection defaults", () => {
  for (const raw of ["{", "null", "[]", '{"version":2,"profiles":{}}']) {
    const state = loadLocalModelProfiles(storage({ "kripl.localModelProfiles": raw }));
    assert.equal(state.server, "lm-studio");
    assert.equal(state.profiles["lm-studio"].endpoint, "http://127.0.0.1:1234/v1");
  }
  const unavailable = {
    getItem() { throw new Error("Unavailable"); },
    setItem() { throw new Error("Unavailable"); }
  };
  const state = loadLocalModelProfiles(unavailable);
  assert.equal(state.profiles.unsloth.endpoint, "http://127.0.0.1:8888/v1");
  assert.doesNotThrow(() => saveLocalModelProfiles(unavailable, state));
});

test("profile persistence retains only the public endpoint and model selection", () => {
  const persisted = storage();
  const state = loadLocalModelProfiles(persisted);
  state.profiles.unsloth.extra = "discarded";
  saveLocalModelProfiles(persisted, state);
  const saved = JSON.parse(persisted.data.get("kripl.localModelProfiles"));
  assert.deepEqual(Object.keys(saved.profiles.unsloth).sort(), ["endpoint", "modelId"]);
  assert.equal(loadLocalModelProfiles(persisted).profiles.unsloth.extra, undefined);
});

test("connection matching handles legacy LM bindings without mixing servers, ports or paths", () => {
  const lm = { endpoint: "http://127.0.0.1:1234/v1" };
  assert.equal(sameLocalModelConnection(lm, { server: "lm-studio", endpoint: "http://localhost:1234/" }), true);
  assert.equal(sameLocalModelConnection(lm, { server: "lm-studio", endpoint: "http://127.0.0.1:1234/v1/" }), true);
  assert.equal(sameLocalModelConnection(lm, { server: "unsloth", endpoint: lm.endpoint }), false);
  assert.equal(sameLocalModelConnection(lm, { endpoint: "http://127.0.0.1:8888/v1" }), false);
  assert.equal(sameLocalModelConnection(lm, { endpoint: "http://127.0.0.1:1234/custom/v1" }), false);
});
