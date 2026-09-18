import type {
  AgentSessionCatalog,
  AgentSessionSummary
} from "@kripl/core";
import {
  SessionManager,
  type SessionInfo
} from "@earendil-works/pi-coding-agent";

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
  constructor(private readonly sessionDir: string) {}

  async list(workspacePath: string): Promise<AgentSessionSummary[]> {
    const sessions = await SessionManager.list(workspacePath, this.sessionDir);
    return sessions.map(mapPiSessionInfo);
  }
}
