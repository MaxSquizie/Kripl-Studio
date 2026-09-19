import type {
  WorkspaceChange,
  WorkspaceChangeStatus,
  WorkspaceCommitResult,
  WorkspaceDescriptor,
  WorkspaceDiff,
  WorkspaceGitStatus,
  WorkspaceEntry,
  WorkspaceFilePreview,
  WorkspaceFileSearchResult,
  WorkspaceRuntime,
  WorkspaceTextSearchResult
} from "@kripl/core";
import { execFile } from "node:child_process";
import {
  lstat,
  open as openFileHandle,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CHARS = 250_000;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_SEARCH_FILES = 25_000;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;

const HIDDEN_HEAVY_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".venv",
  ".vite",
  ".yarn",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
  "target",
  "venv"
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "shell",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml"
};

interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
}

interface SearchFile {
  absolute: string;
  relative: string;
  size: number;
}

function toWorkspacePath(path: string): string {
  return path.split(sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function detectBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;

  let suspicious = 0;
  const sampleLength = Math.min(buffer.length, 8 * 1024);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }

  if (suspicious / sampleLength > 0.1) return true;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, sampleLength),
      { stream: buffer.length > sampleLength }
    );
    return false;
  } catch {
    return true;
  }
}

function languageFor(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

function normalizedSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return 80;
  if (!Number.isFinite(limit)) return 80;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(limit)));
}

function fuzzyFileScore(path: string, query: string): number | null {
  const candidate = path.toLowerCase();
  const name = basename(path).toLowerCase();
  const needle = query.toLowerCase();

  if (!needle) return 0;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 10 + name.length - needle.length;

  const nameIndex = name.indexOf(needle);
  if (nameIndex >= 0) return 30 + nameIndex + Math.max(0, name.length - needle.length) / 100;

  const pathIndex = candidate.indexOf(needle);
  if (pathIndex >= 0) return 60 + pathIndex + Math.max(0, candidate.length - needle.length) / 100;

  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const next = candidate.indexOf(character, cursor);
    if (next < 0) return null;
    gaps += next - cursor;
    cursor = next + 1;
  }

  return 100 + gaps + candidate.length / 100;
}

function searchPreview(line: string, column: number, queryLength: number): string {
  const maxLength = 220;
  if (line.length <= maxLength) return line.trimEnd();

  const matchStart = Math.max(0, column - 1);
  const context = Math.max(24, Math.floor((maxLength - queryLength) / 2));
  const start = Math.max(0, matchStart - context);
  const end = Math.min(line.length, matchStart + queryLength + context);
  return (start > 0 ? "…" : "") + line.slice(start, end).trimEnd() + (end < line.length ? "…" : "");
}

function changeStatus(x: string, y: string): WorkspaceChangeStatus {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflicted";
  }
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

function parsePorcelain(output: string): WorkspaceChange[] {
  const records = output.split("\0");
  const changes: WorkspaceChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;

    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path = record.slice(3);
    if (!path) continue;

    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const previous = records[index + 1];
      if (previous) {
        oldPath = previous;
        index += 1;
      }
    }

    const untracked = x === "?" && y === "?";
    const change: WorkspaceChange = {
      path: toWorkspacePath(path),
      status: changeStatus(x, y),
      staged: !untracked && x !== " ",
      unstaged: untracked || y !== " "
    };
    if (oldPath) change.oldPath = toWorkspacePath(oldPath);
    changes.push(change);
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= MAX_DIFF_CHARS) return { patch, truncated: false };
  return {
    patch: patch.slice(0, MAX_DIFF_CHARS) + "\n\n[Kripl Studio: diff truncated]",
    truncated: true
  };
}

function syntheticUntrackedPatch(path: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const body = lines.map((line) => "+" + line).join("\n");
  return [
    "diff --git a/" + path + " b/" + path,
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/" + path,
    "@@ -0,0 +1," + lines.length + " @@",
    body
  ].join("\n");
}

export class LocalWorkspaceRuntime implements WorkspaceRuntime {
  readonly id = "workspace:local";

  private rootPath: string | undefined;
  private canonicalRoot: string | undefined;
  private currentDescriptor: WorkspaceDescriptor | null = null;

  async open(path: string): Promise<WorkspaceDescriptor> {
    const absolute = resolve(path);
    const info = await stat(absolute);
    if (!info.isDirectory()) throw new Error("Workspace path is not a directory.");

    const canonical = await realpath(absolute);
    const gitRepository = await this.isGitRepository(canonical);

    this.rootPath = canonical;
    this.canonicalRoot = canonical;
    this.currentDescriptor = {
      path: canonical,
      name: basename(canonical) || canonical,
      gitRepository
    };

    return { ...this.currentDescriptor };
  }

  descriptor(): WorkspaceDescriptor | null {
    return this.currentDescriptor ? { ...this.currentDescriptor } : null;
  }

  async list(path = ""): Promise<WorkspaceEntry[]> {
    const target = await this.resolveExistingPath(path);
    const info = await stat(target.absolute);
    if (!info.isDirectory()) throw new Error("Workspace path is not a directory.");

    const entries = await readdir(target.absolute, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(
        "Directory contains " +
          entries.length +
          " entries; Kripl Studio limit is " +
          MAX_DIRECTORY_ENTRIES +
          "."
      );
    }

    const result: WorkspaceEntry[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && HIDDEN_HEAVY_DIRECTORIES.has(entry.name)) continue;

      const absolute = resolve(target.absolute, entry.name);
      const workspacePath = target.relative
        ? target.relative + "/" + entry.name
        : entry.name;

      const symlink = entry.isSymbolicLink();
      let targetInfo;

      try {
        if (symlink) {
          const canonical = await realpath(absolute);
          if (!this.isCanonicalInside(canonical)) continue;
          targetInfo = await stat(canonical);
        } else {
          targetInfo = await stat(absolute);
        }
      } catch {
        continue;
      }

      if (!targetInfo.isDirectory() && !targetInfo.isFile()) continue;
      if (targetInfo.isDirectory() && HIDDEN_HEAVY_DIRECTORIES.has(entry.name)) continue;

      const item: WorkspaceEntry = {
        path: toWorkspacePath(workspacePath),
        name: entry.name,
        kind: targetInfo.isDirectory() ? "directory" : "file"
      };

      if (targetInfo.isFile()) item.size = targetInfo.size;
      if (symlink) item.symlink = true;
      result.push(item);
    }

    return result.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  async readFile(path: string): Promise<WorkspaceFilePreview> {
    const target = await this.resolveExistingPath(path);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new Error("Workspace path is not a file.");

    const bytesToRead = Math.min(info.size, MAX_PREVIEW_BYTES);
    const handle = await openFileHandle(target.absolute, "r");
    let buffer: Buffer;

    try {
      buffer = Buffer.alloc(bytesToRead);
      if (bytesToRead > 0) {
        const result = await handle.read(buffer, 0, bytesToRead, 0);
        buffer = buffer.subarray(0, result.bytesRead);
      }
    } finally {
      await handle.close();
    }

    const binary = detectBinary(buffer);
    const preview: WorkspaceFilePreview = {
      path: target.relative,
      name: basename(target.absolute),
      size: info.size,
      binary,
      truncated: info.size > MAX_PREVIEW_BYTES
    };

    const language = languageFor(target.absolute);
    if (language) preview.language = language;
    if (!binary) preview.content = buffer.toString("utf8");

    return preview;
  }

  async writeFile(path: string, content: string): Promise<WorkspaceFilePreview> {
    if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
      throw new Error("Edited file exceeds the 2 MB Kripl Studio limit.");
    }

    const current = await this.readFile(path);
    if (current.binary) {
      throw new Error("Binary files cannot be edited as text.");
    }
    if (current.truncated) {
      throw new Error("Truncated previews cannot be saved.");
    }

    const target = await this.resolveExistingPath(path);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new Error("Workspace path is not a file.");

    await writeFile(target.absolute, content, "utf8");
    return this.readFile(target.relative);
  }

  async searchFiles(query: string, limit?: number): Promise<WorkspaceFileSearchResult[]> {
    const normalized = query.trim();
    if (normalized.length > 512) throw new Error("Workspace file search query is too long.");
    if (!normalized) return [];

    const maxResults = normalizedSearchLimit(limit);
    const files = await this.collectSearchFiles();
    return files
      .map((file) => ({
        file,
        score: fuzzyFileScore(file.relative, normalized)
      }))
      .filter((item): item is { file: SearchFile; score: number } => item.score !== null)
      .sort((left, right) =>
        left.score === right.score
          ? left.file.relative.localeCompare(right.file.relative)
          : left.score - right.score
      )
      .slice(0, maxResults)
      .map(({ file, score }) => ({
        path: file.relative,
        name: basename(file.relative),
        score
      }));
  }

  async searchText(query: string, limit?: number): Promise<WorkspaceTextSearchResult[]> {
    const normalized = query.trim();
    if (normalized.length > 512) throw new Error("Workspace text search query is too long.");
    if (!normalized) return [];

    const maxResults = normalizedSearchLimit(limit);
    const needle = normalized.toLowerCase();
    const files = await this.collectSearchFiles();
    const matches: WorkspaceTextSearchResult[] = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;
      if (file.size > MAX_SEARCH_BYTES) continue;

      let buffer: Buffer;
      try {
        buffer = await readFile(file.absolute);
      } catch {
        continue;
      }
      if (detectBinary(buffer)) continue;

      const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (matches.length >= maxResults) break;
        const line = lines[lineIndex] ?? "";
        const lower = line.toLowerCase();
        let searchFrom = 0;

        while (searchFrom <= lower.length - needle.length) {
          const found = lower.indexOf(needle, searchFrom);
          if (found < 0) break;
          matches.push({
            path: file.relative,
            line: lineIndex + 1,
            column: found + 1,
            preview: searchPreview(line, found + 1, normalized.length)
          });
          if (matches.length >= maxResults) break;
          searchFrom = found + Math.max(1, needle.length);
        }
      }
    }

    return matches;
  }

  async getChanges(): Promise<WorkspaceChange[]> {
    const root = this.requireRoot();
    if (!this.currentDescriptor?.gitRepository) return [];

    const output = await this.runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      root
    );
    return parsePorcelain(output);
  }

  async getDiff(path: string): Promise<WorkspaceDiff> {
    const root = this.requireRoot();
    if (!this.currentDescriptor?.gitRepository) {
      throw new Error("Workspace is not a Git repository.");
    }

    const relativePath = this.validateRelativePath(path);
    const changes = await this.getChanges();
    const change = changes.find((item) => item.path === relativePath);
    if (!change) throw new Error("File has no Git changes.");

    if (change.status === "untracked") {
      const preview = await this.readFile(relativePath);
      const rawPatch = preview.binary
        ? "[binary untracked file]\n" + relativePath
        : syntheticUntrackedPatch(relativePath, preview.content ?? "");
      const truncated = truncatePatch(rawPatch);
      return {
        path: relativePath,
        status: change.status,
        staged: false,
        unstaged: true,
        patch: truncated.patch,
        truncated: truncated.truncated
      };
    }

    const patches: string[] = [];

    if (change.staged) {
      const staged = await this.runGit(
        ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3", "--", relativePath],
        root
      );
      if (staged.trim()) patches.push("[staged]\n" + staged.trimEnd());
    }

    if (change.unstaged) {
      const unstaged = await this.runGit(
        ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--", relativePath],
        root
      );
      if (unstaged.trim()) patches.push("[unstaged]\n" + unstaged.trimEnd());
    }

    const truncated = truncatePatch(patches.join("\n\n") || "[no textual diff]");
    return {
      path: relativePath,
      status: change.status,
      staged: change.staged,
      unstaged: change.unstaged,
      patch: truncated.patch,
      truncated: truncated.truncated
    };
  }

  async getGitStatus(): Promise<WorkspaceGitStatus> {
    const root = this.requireGitRoot();
    const changes = await this.getChanges();

    let branch: string | undefined;
    let headSha: string | undefined;

    const branchOutput = await this.runGit(["branch", "--show-current"], root);
    const branchName = branchOutput.trim();
    if (branchName) branch = branchName;

    try {
      const sha = (await this.runGit(["rev-parse", "HEAD"], root)).trim();
      if (sha) headSha = sha;
    } catch {
      // Repositories without an initial commit have no HEAD object yet.
    }

    return {
      ...(branch ? { branch } : {}),
      detached: !branch && Boolean(headSha),
      ...(headSha ? { headSha } : {}),
      staged: changes.filter((change) => change.staged).length,
      unstaged: changes.filter((change) => change.unstaged && change.status !== "untracked").length,
      untracked: changes.filter((change) => change.status === "untracked").length,
      conflicted: changes.filter((change) => change.status === "conflicted").length
    };
  }

  async commit(message: string): Promise<WorkspaceCommitResult> {
    const root = this.requireGitRoot();
    const normalized = message.trim();

    if (!normalized) throw new Error("Commit message cannot be empty.");
    if (normalized.length > 10_000) {
      throw new Error("Commit message exceeds the 10,000 character limit.");
    }
    if (normalized.includes("\0")) {
      throw new Error("Commit message contains an invalid null character.");
    }

    const changes = await this.getChanges();
    if (changes.some((change) => change.status === "conflicted")) {
      throw new Error("Resolve Git conflicts before committing.");
    }
    if (!changes.some((change) => change.staged)) {
      throw new Error("There are no staged changes to commit.");
    }

    await this.runGit(
      ["commit", "--no-verify", "--no-gpg-sign", "-m", normalized],
      root
    );

    const sha = (await this.runGit(["rev-parse", "HEAD"], root)).trim();
    const shortSha = (await this.runGit(["rev-parse", "--short=12", "HEAD"], root)).trim();

    if (!sha || !shortSha) {
      throw new Error("Git commit completed but the new HEAD could not be resolved.");
    }

    return {
      sha,
      shortSha,
      message: normalized
    };
  }

  async stage(path: string): Promise<void> {
    const root = this.requireGitRoot();
    const change = await this.requireChange(path);
    const paths = this.changePaths(change);
    await this.runGit(["add", "-A", "--", ...paths], root);
  }

  async unstage(path: string): Promise<void> {
    const root = this.requireGitRoot();
    const change = await this.requireChange(path);
    if (!change.staged) return;

    const paths = this.changePaths(change);
    await this.runGit(["reset", "-q", "HEAD", "--", ...paths], root);
  }

  async revert(path: string): Promise<void> {
    const root = this.requireGitRoot();
    const change = await this.requireChange(path);
    const relativePath = change.path;

    if (change.status === "untracked") {
      const target = await this.resolveExistingPath(relativePath);
      const info = await stat(target.absolute);
      if (!info.isFile()) throw new Error("Only untracked files can be removed from review.");
      await unlink(target.absolute);
      return;
    }

    if (change.status === "added") {
      if (change.staged) {
        await this.runGit(["reset", "-q", "HEAD", "--", relativePath], root);
      }
      try {
        const target = await this.resolveExistingPath(relativePath);
        const info = await stat(target.absolute);
        if (info.isFile()) await unlink(target.absolute);
      } catch {
        // The added path may already be absent from the working tree.
      }
      return;
    }

    if (change.status === "renamed" && change.oldPath) {
      if (change.staged) {
        await this.runGit(
          ["reset", "-q", "HEAD", "--", change.oldPath, relativePath],
          root
        );
      }
      await this.runGit(
        ["restore", "--worktree", "--source=HEAD", "--", change.oldPath],
        root
      );
      if (relativePath !== change.oldPath) {
        try {
          const target = await this.resolveExistingPath(relativePath);
          const info = await stat(target.absolute);
          if (info.isFile()) await unlink(target.absolute);
        } catch {
          // Destination may already have been removed by Git restore/reset.
        }
      }
      return;
    }

    await this.runGit(
      ["restore", "--staged", "--worktree", "--source=HEAD", "--", relativePath],
      root
    );
  }

  async dispose(): Promise<void> {
    this.rootPath = undefined;
    this.canonicalRoot = undefined;
    this.currentDescriptor = null;
  }

  private async collectSearchFiles(): Promise<SearchFile[]> {
    const root = this.requireRoot();
    const queue: Array<{ absolute: string; relative: string }> = [
      { absolute: root, relative: "" }
    ];
    const visitedDirectories = new Set<string>([root]);
    const files: SearchFile[] = [];

    while (queue.length > 0 && files.length < MAX_SEARCH_FILES) {
      const current = queue.shift();
      if (!current) break;

      let entries;
      try {
        entries = await readdir(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.length > MAX_DIRECTORY_ENTRIES) continue;

      entries.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      );

      for (const entry of entries) {
        if (files.length >= MAX_SEARCH_FILES) break;
        if (entry.isDirectory() && HIDDEN_HEAVY_DIRECTORIES.has(entry.name)) continue;

        const lexical = resolve(current.absolute, entry.name);
        const workspacePath = current.relative
          ? current.relative + "/" + entry.name
          : entry.name;

        let canonical: string;
        let info;
        try {
          canonical = await realpath(lexical);
          if (!this.isCanonicalInside(canonical)) continue;
          info = await stat(canonical);
        } catch {
          continue;
        }

        if (info.isDirectory()) {
          if (HIDDEN_HEAVY_DIRECTORIES.has(entry.name)) continue;
          if (visitedDirectories.has(canonical)) continue;
          visitedDirectories.add(canonical);
          queue.push({ absolute: canonical, relative: toWorkspacePath(workspacePath) });
          continue;
        }

        if (!info.isFile()) continue;
        files.push({
          absolute: canonical,
          relative: toWorkspacePath(workspacePath),
          size: info.size
        });
      }
    }

    return files;
  }

  private requireRoot(): string {
    if (!this.rootPath || !this.canonicalRoot) {
      throw new Error("No workspace is open.");
    }
    return this.rootPath;
  }

  private requireGitRoot(): string {
    const root = this.requireRoot();
    if (!this.currentDescriptor?.gitRepository) {
      throw new Error("Workspace is not a Git repository.");
    }
    return root;
  }

  private async requireChange(path: string): Promise<WorkspaceChange> {
    const relativePath = this.validateRelativePath(path);
    const changes = await this.getChanges();
    const change = changes.find((item) => item.path === relativePath);
    if (!change) throw new Error("File has no Git changes.");
    return change;
  }

  private changePaths(change: WorkspaceChange): string[] {
    return change.oldPath && change.oldPath !== change.path
      ? [change.oldPath, change.path]
      : [change.path];
  }

  private validateRelativePath(path: string): string {
    const root = this.requireRoot();
    const raw = path.trim();
    if (isAbsolute(raw)) throw new Error("Workspace paths must be relative.");

    const absolute = resolve(root, raw.split("/").join(sep));
    if (!isWithin(root, absolute)) {
      throw new Error("Workspace path escapes the project root.");
    }

    return toWorkspacePath(relative(root, absolute));
  }

  private async resolveExistingPath(path: string): Promise<ResolvedWorkspacePath> {
    const root = this.requireRoot();
    const workspacePath = this.validateRelativePath(path);
    const lexical = resolve(root, workspacePath.split("/").join(sep));

    await lstat(lexical);
    const canonical = await realpath(lexical);
    if (!this.isCanonicalInside(canonical)) {
      throw new Error("Workspace path resolves outside the project root.");
    }

    return {
      absolute: canonical,
      relative: workspacePath
    };
  }

  private isCanonicalInside(path: string): boolean {
    if (!this.canonicalRoot) return false;
    return isWithin(this.canonicalRoot, path);
  }

  private async isGitRepository(root: string): Promise<boolean> {
    try {
      const output = await this.runGit(["rev-parse", "--is-inside-work-tree"], root);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private async runGit(args: string[], cwd: string): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        LC_ALL: "C",
        TERM: "dumb"
      }
    });

    return result.stdout;
  }
}
