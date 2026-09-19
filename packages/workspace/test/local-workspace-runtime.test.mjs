import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { LocalWorkspaceRuntime } from "../dist/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function createGitWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), "kripl-workspace-"));
  await git(directory, ["init"]);
  await git(directory, ["config", "user.email", "ci@kripl.local"]);
  await git(directory, ["config", "user.name", "Kripl CI"]);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(directory, "README.md"), "# Workspace\n", "utf8");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "initial"]);
  return directory;
}

test("lists workspace entries lazily and hides heavy generated directories", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    const descriptor = await runtime.open(directory);
    assert.equal(descriptor.gitRepository, true);

    await mkdir(join(directory, "node_modules"), { recursive: true });
    await writeFile(join(directory, "node_modules", "ignored.js"), "ignored", "utf8");

    const root = await runtime.list();
    assert.equal(root.some((entry) => entry.name === "src" && entry.kind === "directory"), true);
    assert.equal(root.some((entry) => entry.name === "README.md" && entry.kind === "file"), true);
    assert.equal(root.some((entry) => entry.name === "node_modules"), false);

    const src = await runtime.list("src");
    assert.deepEqual(src.map((entry) => entry.path), ["src/index.ts"]);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads text previews and blocks path traversal", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await runtime.open(directory);
    const preview = await runtime.readFile("src/index.ts");
    assert.equal(preview.binary, false);
    assert.equal(preview.language, "typescript");
    assert.match(preview.content ?? "", /value = 1/);

    await assert.rejects(() => runtime.readFile("../outside.txt"), /escapes the project root/);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects binary files without decoding them into the renderer", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
    await runtime.open(directory);

    const preview = await runtime.readFile("binary.bin");
    assert.equal(preview.binary, true);
    assert.equal(preview.content, undefined);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports modified and untracked Git changes with textual diffs", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "src", "index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(directory, "new-file.txt"), "hello\nworld\n", "utf8");
    await runtime.open(directory);

    const changes = await runtime.getChanges();
    const modified = changes.find((item) => item.path === "src/index.ts");
    const untracked = changes.find((item) => item.path === "new-file.txt");

    assert.equal(modified?.status, "modified");
    assert.equal(modified?.unstaged, true);
    assert.equal(untracked?.status, "untracked");
    assert.equal(untracked?.unstaged, true);

    const modifiedDiff = await runtime.getDiff("src/index.ts");
    assert.match(modifiedDiff.patch, /value = 1/);
    assert.match(modifiedDiff.patch, /value = 2/);

    const untrackedDiff = await runtime.getDiff("new-file.txt");
    assert.match(untrackedDiff.patch, /new file mode/);
    assert.match(untrackedDiff.patch, /\+hello/);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});


test("combines staged and unstaged patches for the same file", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Staged version\n", "utf8");
    await git(directory, ["add", "README.md"]);
    await writeFile(join(directory, "README.md"), "# Working version\n", "utf8");
    await runtime.open(directory);

    const change = (await runtime.getChanges()).find((item) => item.path === "README.md");
    assert.equal(change?.staged, true);
    assert.equal(change?.unstaged, true);

    const diff = await runtime.getDiff("README.md");
    assert.match(diff.patch, /\[staged\]/);
    assert.match(diff.patch, /\[unstaged\]/);
    assert.match(diff.patch, /Staged version/);
    assert.match(diff.patch, /Working version/);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});


test("edits existing text files and reports the saved preview", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await runtime.open(directory);
    const saved = await runtime.writeFile("src/index.ts", "export const value = 42;\n");

    assert.equal(saved.binary, false);
    assert.equal(saved.truncated, false);
    assert.match(saved.content ?? "", /value = 42/);
    assert.equal(
      await readFile(join(directory, "src", "index.ts"), "utf8"),
      "export const value = 42;\n"
    );

    await assert.rejects(
      () => runtime.writeFile("../outside.ts", "nope"),
      /escapes the project root/
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages and unstages one changed file without touching another", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Changed\n", "utf8");
    await writeFile(join(directory, "src", "index.ts"), "export const value = 3;\n", "utf8");
    await runtime.open(directory);

    await runtime.stage("README.md");
    let changes = await runtime.getChanges();
    const readmeStaged = changes.find((item) => item.path === "README.md");
    const sourceUnstaged = changes.find((item) => item.path === "src/index.ts");

    assert.equal(readmeStaged?.staged, true);
    assert.equal(readmeStaged?.unstaged, false);
    assert.equal(sourceUnstaged?.staged, false);
    assert.equal(sourceUnstaged?.unstaged, true);

    await runtime.unstage("README.md");
    changes = await runtime.getChanges();
    const readmeUnstaged = changes.find((item) => item.path === "README.md");
    assert.equal(readmeUnstaged?.staged, false);
    assert.equal(readmeUnstaged?.unstaged, true);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reverts tracked changes back to HEAD", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Staged\n", "utf8");
    await git(directory, ["add", "README.md"]);
    await writeFile(join(directory, "README.md"), "# Working\n", "utf8");
    await runtime.open(directory);

    await runtime.revert("README.md");

    const restored = await readFile(join(directory, "README.md"), "utf8");
    assert.equal(restored.replace(/\r\n/g, "\n"), "# Workspace\n");
    assert.equal(
      (await runtime.getChanges()).some((item) => item.path === "README.md"),
      false
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revert removes an untracked file only when explicitly requested", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    const path = join(directory, "scratch.txt");
    await writeFile(path, "temporary\n", "utf8");
    await runtime.open(directory);

    const before = (await runtime.getChanges()).find((item) => item.path === "scratch.txt");
    assert.equal(before?.status, "untracked");

    await runtime.revert("scratch.txt");
    await assert.rejects(() => access(path));
    assert.equal(
      (await runtime.getChanges()).some((item) => item.path === "scratch.txt"),
      false
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});


test("searches project files with fuzzy path matching and skips heavy directories", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await mkdir(join(directory, "src", "features"), { recursive: true });
    await writeFile(join(directory, "src", "features", "WorkspaceSearch.ts"), "export const search = true;\n", "utf8");
    await mkdir(join(directory, "node_modules", "fake-package"), { recursive: true });
    await writeFile(join(directory, "node_modules", "fake-package", "WorkspaceSearch.ts"), "ignored\n", "utf8");
    await runtime.open(directory);

    const direct = await runtime.searchFiles("workspace");
    assert.equal(direct[0]?.path, "src/features/WorkspaceSearch.ts");
    assert.equal(direct.some((item) => item.path.includes("node_modules")), false);

    const fuzzy = await runtime.searchFiles("wss");
    assert.equal(fuzzy.some((item) => item.path === "src/features/WorkspaceSearch.ts"), true);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("searches text case-insensitively with line and column metadata", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(
      join(directory, "docs", "notes.md"),
      "alpha\nKripl Search Needle here\nomega needle\n",
      "utf8"
    );
    await writeFile(join(directory, "binary.bin"), Buffer.from([0, 78, 69, 69, 68, 76, 69]));
    await runtime.open(directory);

    const matches = await runtime.searchText("needle", 10);
    const notes = matches.filter((item) => item.path === "docs/notes.md");

    assert.equal(notes.length, 2);
    assert.deepEqual(
      notes.map((item) => [item.line, item.column]),
      [[2, 14], [3, 7]]
    );
    assert.match(notes[0]?.preview ?? "", /Kripl Search Needle/);
    assert.equal(matches.some((item) => item.path === "binary.bin"), false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports local Git branch, HEAD and staged/unstaged counters", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Changed\n", "utf8");
    await writeFile(join(directory, "scratch.txt"), "untracked\n", "utf8");
    await runtime.open(directory);
    await runtime.stage("README.md");

    const status = await runtime.getGitStatus();
    assert.equal(typeof status.branch, "string");
    assert.equal(status.detached, false);
    assert.match(status.headSha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(status.staged, 1);
    assert.equal(status.unstaged, 0);
    assert.equal(status.untracked, 1);
    assert.equal(status.conflicted, 0);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("commits only staged changes and leaves other working tree changes intact", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Commit me\n", "utf8");
    await writeFile(join(directory, "src", "index.ts"), "export const value = 99;\n", "utf8");
    await writeFile(join(directory, "scratch.txt"), "leave me\n", "utf8");
    await runtime.open(directory);
    await runtime.stage("README.md");

    const result = await runtime.commit("test: staged only");
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.match(result.shortSha, /^[0-9a-f]{7,12}$/);
    assert.equal(result.message, "test: staged only");

    const { stdout: subject } = await execFileAsync(
      "git",
      ["show", "-s", "--format=%s", "HEAD"],
      { cwd: directory, windowsHide: true, encoding: "utf8" }
    );
    assert.equal(subject.trim(), "test: staged only");

    const changes = await runtime.getChanges();
    assert.equal(changes.some((item) => item.path === "README.md"), false);
    assert.equal(changes.find((item) => item.path === "src/index.ts")?.unstaged, true);
    assert.equal(changes.find((item) => item.path === "scratch.txt")?.status, "untracked");

    const status = await runtime.getGitStatus();
    assert.equal(status.staged, 0);
    assert.equal(status.unstaged, 1);
    assert.equal(status.untracked, 1);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects commits without staged changes", async () => {
  const directory = await createGitWorkspace();
  const runtime = new LocalWorkspaceRuntime();

  try {
    await writeFile(join(directory, "README.md"), "# Unstaged\n", "utf8");
    await runtime.open(directory);

    await assert.rejects(
      () => runtime.commit("should fail"),
      /no staged changes/i
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
