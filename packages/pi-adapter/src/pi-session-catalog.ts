import type {
  AgentSessionCatalog,
  AgentSessionSummary
} from "@kripl/core";
import {
  SessionManager,
  type SessionInfo
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

interface CatalogRead {
  sessions: AgentSessionSummary[];
  signature: string | undefined;
}

interface PendingCatalogRead {
  workspace: string;
  signature: string;
  promise: Promise<CatalogRead>;
}

// Keep only one workspace's lightweight summaries, with a hard size bound.
const MAX_CACHED_SESSIONS = 2000;
const MAX_CACHED_TEXT_LENGTH = 1_000_000;

function cacheable(sessions: AgentSessionSummary[]): boolean {
  // Pi returns an empty list for some I/O failures as well as empty projects.
  // Do not let a transient failure hide sessions until the files change.
  if (sessions.length === 0 || sessions.length > MAX_CACHED_SESSIONS) return false;
  let textLength = 0;
  for (const session of sessions) {
    textLength += session.path.length + session.id.length + session.workspacePath.length +
      session.firstMessage.length + (session.name?.length ?? 0) + (session.parentSessionPath?.length ?? 0);
    if (textLength > MAX_CACHED_TEXT_LENGTH) return false;
  }
  return true;
}

export function mapPiSessionInfo(info: SessionInfo): AgentSessionSummary {
  return {
    path: info.path,
    id: info.id,
    workspacePath: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
    createdAt: info.created.getTime(),
    modifiedAt: info.modified.getTime(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage
  };
}

export class PiSessionCatalog implements AgentSessionCatalog {
  private cached: { workspace: string; signature: string; sessions: AgentSessionSummary[] } | undefined;
  private pending: PendingCatalogRead | undefined;
  private requestVersion = 0;

  constructor(private readonly sessionDir: string) {}

  async list(workspacePath: string): Promise<AgentSessionSummary[]> {
    const version = ++this.requestVersion;
    // Pi owns path normalization/filtering; do not merge selectors that its
    // public API might treat differently (including path case on Windows).
    const workspace = workspacePath;
    if (this.cached?.workspace !== workspace) this.cached = undefined;

    const signature = await this.directorySignature();
    if (signature !== undefined && this.cached?.workspace === workspace && this.cached.signature === signature) {
      return this.cached.sessions.map((session) => ({ ...session }));
    }

    let request = signature !== undefined && this.pending?.workspace === workspace &&
      this.pending.signature === signature ? this.pending : undefined;
    if (!request) {
      const promise = this.read(workspacePath);
      if (signature === undefined) {
        // An inaccessible/changing directory is handled by Pi as before and
        // must not produce a durable cache hit for an empty result.
        const result = await promise;
        if (version === this.requestVersion) this.cached = undefined;
        return result.sessions.map((session) => ({ ...session }));
      }
      request = { workspace, signature, promise };
      this.pending = request;
    }

    try {
      const result = await request.promise;
      if (version === this.requestVersion) {
        // Do not cache a list if a session changed while Pi was reading it.
        this.cached = result.signature === signature && cacheable(result.sessions)
          ? { workspace, signature: request.signature, sessions: result.sessions }
          : undefined;
      }
      return result.sessions.map((session) => ({ ...session }));
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  private async read(workspacePath: string): Promise<CatalogRead> {
    // The public Pi API owns parsing, migration, filtering and session names.
    // Map immediately so the cache never retains Pi's allMessagesText field.
    const sessions = (await SessionManager.list(workspacePath, this.sessionDir)).map(mapPiSessionInfo);
    return { sessions, signature: await this.directorySignature() };
  }

  private async directorySignature(): Promise<string | undefined> {
    try {
      const files = (await readdir(this.sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
      const hash = createHash("sha256");
      // Bound concurrent stat requests in a large saved-chat directory.
      for (let offset = 0; offset < files.length; offset += 16) {
        const batch = files.slice(offset, offset + 16);
        const stats = await Promise.all(batch.map((name) => stat(join(this.sessionDir, name), { bigint: true })));
        for (let index = 0; index < batch.length; index += 1) {
          const info = stats[index]!;
          hash.update(batch[index]!).update("\0")
            .update(`${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.dev}:${info.ino}:${info.mode}\0`);
        }
      }
      return hash.digest("hex");
    } catch {
      return undefined;
    }
  }
}
