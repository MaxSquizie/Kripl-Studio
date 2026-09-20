import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  JsonDesktopStateStore,
  normalizeDesktopPersistenceState
} from "../dist/index.js";

test("corrupt state files fail closed to defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");

  try {
    await writeFile(file, "{not-json", "utf8");
    const store = new JsonDesktopStateStore(file);
    const state = await store.load();

    assert.equal(state.version, 1);
    assert.deepEqual(state.recentProjects, []);
    assert.equal(state.lastWorkspacePath, undefined);
    assert.deepEqual(state.lastSessionByWorkspace, {});
    assert.deepEqual(state.ui, {
      workspaceView: { type: "agent" },
      expandedDirectories: []
    });
    assert.equal(state.runtime.networkMode, "online");
    assert.equal(state.runtime.modelRouting, "local-only");
    assert.equal(state.runtime.permissions.rules["network.read"], "allow");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remembered workspaces persist in MRU order without duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");
  const store = new JsonDesktopStateStore(file);

  try {
    await store.rememberWorkspace({
      path: join(directory, "one"),
      name: "one",
      gitRepository: true
    }, 100);
    await store.rememberWorkspace({
      path: join(directory, "two"),
      name: "two",
      gitRepository: false
    }, 200);
    await store.rememberWorkspace({
      path: join(directory, "one"),
      name: "one-renamed",
      gitRepository: true
    }, 300);

    const state = store.snapshot();
    assert.equal(state.recentProjects.length, 2);
    assert.deepEqual(
      state.recentProjects.map((item) => item.name),
      ["one-renamed", "two"]
    );
    assert.equal(state.lastWorkspacePath, resolve(join(directory, "one")));

    const reloaded = await new JsonDesktopStateStore(file).load();
    assert.deepEqual(reloaded, state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace view and expanded directories survive reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");
  const store = new JsonDesktopStateStore(file);

  try {
    await store.setUiState({
      workspaceView: { type: "file", path: "src/index.ts" },
      expandedDirectories: ["src", "src/components", "src"]
    });

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.ui.workspaceView.path, "src/index.ts");

    const reloaded = await new JsonDesktopStateStore(file).load();
    assert.deepEqual(reloaded.ui, {
      workspaceView: { type: "file", path: "src/index.ts" },
      expandedDirectories: ["src", "src/components"]
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forgetting the active recent workspace clears last-workspace UI state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");
  const project = join(directory, "project");
  const store = new JsonDesktopStateStore(file);

  try {
    await store.rememberWorkspace({
      path: project,
      name: "project",
      gitRepository: true
    }, 100);
    await store.setUiState({
      workspaceView: { type: "diff", path: "src/a.ts" },
      expandedDirectories: ["src"]
    });
    await store.rememberSession(project, join(directory, "sessions", "active.jsonl"));

    await store.forgetRecentProject(project);
    const state = store.snapshot();

    assert.equal(state.lastWorkspacePath, undefined);
    assert.deepEqual(state.recentProjects, []);
    assert.equal(state.lastSessionByWorkspace[resolve(project)], undefined);
    assert.deepEqual(state.ui, {
      workspaceView: { type: "agent" },
      expandedDirectories: []
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime settings persist independently from workspace UI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");
  const store = new JsonDesktopStateStore(file);

  try {
    await store.setRuntimeSettings({
      networkMode: "restricted",
      modelRouting: "local-only",
      permissions: {
        version: 1,
        rules: {
          "filesystem.read.workspace": "allow",
          "network.read": "deny"
        }
      }
    });

    await store.clearLastWorkspace();

    const reloaded = await new JsonDesktopStateStore(file).load();
    assert.equal(reloaded.runtime.networkMode, "restricted");
    assert.equal(reloaded.runtime.modelRouting, "local-only");
    assert.equal(reloaded.runtime.permissions.rules["network.read"], "deny");
    assert.equal(reloaded.runtime.permissions.rules["filesystem.read.workspace"], "allow");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed runtime settings fall back to safe defaults", () => {
  const state = normalizeDesktopPersistenceState({
    version: 1,
    recentProjects: [],
    ui: {
      workspaceView: { type: "agent" },
      expandedDirectories: []
    },
    runtime: {
      networkMode: "warp-speed",
      modelRouting: "mystery",
      permissions: {
        version: 1,
        rules: {
          "unknown.scope": "allow"
        }
      }
    }
  });

  assert.equal(state.runtime.networkMode, "online");
  assert.equal(state.runtime.modelRouting, "local-only");
  assert.equal(state.runtime.permissions.rules["network.search"], "allow");
  assert.equal(state.runtime.permissions.rules["tool.unknown"], "ask");
});

test("model tuning settings are normalized and clamped", () => {
  const valid = normalizeDesktopPersistenceState({
    runtime: {
      networkMode: "online",
      modelRouting: "local-only",
      permissions: { version: 1, rules: {} },
      modelTuning: { systemPrompt: "Answer in Russian.", temperature: 0.427 }
    }
  });

  assert.equal(valid.runtime.modelTuning?.systemPrompt, "Answer in Russian.");
  assert.equal(valid.runtime.modelTuning?.temperature, 0.43);

  const invalid = normalizeDesktopPersistenceState({
    runtime: {
      networkMode: "online",
      modelRouting: "local-only",
      permissions: { version: 1, rules: {} },
      modelTuning: { systemPrompt: 42, temperature: 7 }
    }
  });

  assert.equal(invalid.runtime.modelTuning, undefined);
});

test("last Pi session is remembered independently per workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kripl-state-"));
  const file = join(directory, "desktop-state.json");
  const workspaceA = join(directory, "workspace-a");
  const workspaceB = join(directory, "workspace-b");
  const sessionA = join(directory, "sessions", "a.jsonl");
  const sessionB = join(directory, "sessions", "b.jsonl");
  const store = new JsonDesktopStateStore(file);

  try {
    await store.rememberSession(workspaceA, sessionA);
    await store.rememberSession(workspaceB, sessionB);

    assert.equal(store.lastSessionFor(workspaceA), resolve(sessionA));
    assert.equal(store.lastSessionFor(workspaceB), resolve(sessionB));

    const reloaded = new JsonDesktopStateStore(file);
    await reloaded.load();
    assert.equal(reloaded.lastSessionFor(workspaceA), resolve(sessionA));
    assert.equal(reloaded.lastSessionFor(workspaceB), resolve(sessionB));

    await reloaded.forgetSession(workspaceA);
    assert.equal(reloaded.lastSessionFor(workspaceA), undefined);
    assert.equal(reloaded.lastSessionFor(workspaceB), resolve(sessionB));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalization limits recent projects and rejects malformed UI data", () => {
  const recentProjects = Array.from({ length: 20 }, (_, index) => ({
    path: "C:/project-" + index,
    name: "project-" + index,
    lastOpenedAt: index
  }));

  const state = normalizeDesktopPersistenceState({
    version: 999,
    recentProjects,
    lastWorkspacePath: 42,
    ui: {
      workspaceView: { type: "file", path: "" },
      expandedDirectories: ["src", 7, "tests"]
    }
  });

  assert.equal(state.version, 1);
  assert.equal(state.recentProjects.length, 12);
  assert.equal(state.lastWorkspacePath, undefined);
  assert.deepEqual(state.ui.workspaceView, { type: "agent" });
  assert.deepEqual(state.ui.expandedDirectories, ["src", "tests"]);
});
