import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
