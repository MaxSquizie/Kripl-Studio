import type {
  WorkspaceChange,
  WorkspaceChangeStatus,
  WorkspaceDescriptor,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFilePreview,
  WorkspaceRuntime
} from "@kripl/core";
import { execFile } from "node:child_process";
import {
  lstat,
  open as openFileHandle,
  readdir,
  realpath,
  stat
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
const MAX_DIFF_CHARS = 250_000;
const MAX_DIRECTORY_ENTRIES = 5_000;

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
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, sampleLength));
    return false;
  } catch {
    return true;
  }
}

function languageFor(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
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

    const change: WorkspaceChange = {
      path: toWorkspacePath(path),
      status: changeStatus(x, y),
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?"
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

  async dispose(): Promise<void> {
    this.rootPath = undefined;
    this.canonicalRoot = undefined;
    this.currentDescriptor = null;
  }

  private requireRoot(): string {
    if (!this.rootPath || !this.canonicalRoot) {
      throw new Error("No workspace is open.");
    }
    return this.rootPath;
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
