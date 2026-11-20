import type { LocalModelConnection, LocalModelCredentialStatus } from "@kripl/core";
import { normalizeLocalOpenAIBaseUrl } from "@kripl/local-openai-provider";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CredentialEncryption {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

interface SessionCredential {
  value: string;
  persistent: boolean;
}

export function parseLocalModelConnection(value: unknown): Required<LocalModelConnection> {
  const record = typeof value === "string" ? { endpoint: value } : value;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid local model connection.");
  }
  const fields = record as Record<string, unknown>;
  if (typeof fields.endpoint !== "string" || fields.endpoint.length > 2048) {
    throw new Error("Invalid local model endpoint.");
  }
  if (fields.server !== undefined && fields.server !== "lm-studio" && fields.server !== "unsloth") {
    throw new Error("Unknown local model server.");
  }
  return {
    server: fields.server === "unsloth" ? "unsloth" : "lm-studio",
    endpoint: normalizeLocalOpenAIBaseUrl(fields.endpoint)
  };
}

export function localModelConnectionKey(connection: LocalModelConnection): string {
  const normalized = parseLocalModelConnection(connection);
  return JSON.stringify([normalized.server, normalized.endpoint]);
}

function normalizeApiKey(value: string): string {
  if (typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new Error("Invalid API key.");
  }
  const trimmed = value.trim();
  if (/[^\x21-\x7e]/.test(trimmed)) throw new Error("Invalid API key.");
  return trimmed;
}

export class LocalModelCredentialStore {
  private document: Promise<Record<string, string>> | undefined;
  private readonly sessionKeys = new Map<string, SessionCredential>();
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly encryption: CredentialEncryption) {}

  async get(connection: LocalModelConnection): Promise<string | undefined> {
    return (await this.read(localModelConnectionKey(connection)))?.value;
  }

  async status(connection: LocalModelConnection): Promise<LocalModelCredentialStatus> {
    const credential = await this.read(localModelConnectionKey(connection));
    return { ok: true, hasApiKey: Boolean(credential), persistent: credential?.persistent ?? false };
  }

  set(connection: LocalModelConnection, apiKey: string): Promise<LocalModelCredentialStatus> {
    const id = localModelConnectionKey(connection);
    const value = normalizeApiKey(apiKey);
    const operation = this.mutations.then(async () => {
      const saved = await this.load();
      const next = { ...saved };
      const persistent = Boolean(value) && await this.encryption.available();
      if (persistent) {
        try {
          next[id] = (await this.encryption.encrypt(value)).toString("base64");
        } catch {
          throw new Error("The API key could not be encrypted.");
        }
      } else {
        delete next[id];
      }
      if (persistent || Object.hasOwn(saved, id)) await this.write(next);
      this.document = Promise.resolve(next);
      if (value) this.sessionKeys.set(id, { value, persistent });
      else this.sessionKeys.delete(id);
      return { ok: true, hasApiKey: Boolean(value), persistent };
    });
    this.mutations = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async read(id: string): Promise<SessionCredential | undefined> {
    for (;;) {
      const mutations = this.mutations;
      await mutations;
      if (mutations !== this.mutations) continue;
      const cached = this.sessionKeys.get(id);
      if (cached) return cached;
      const saved = await this.load();
      if (mutations !== this.mutations) continue;
      const encrypted = saved[id];
      if (!encrypted) return undefined;
      const available = await this.encryption.available();
      if (mutations !== this.mutations) continue;
      if (!available) {
        throw new Error("The saved API key is unavailable. Re-enter it in Settings → Model.");
      }
      let credential: SessionCredential;
      try {
        const value = normalizeApiKey(await this.encryption.decrypt(Buffer.from(encrypted, "base64")));
        if (!value) throw new Error("Empty API key.");
        credential = { value, persistent: true };
      } catch {
        if (mutations !== this.mutations) continue;
        throw new Error("The saved API key could not be opened. Re-enter it in Settings → Model.");
      }
      if (mutations !== this.mutations) continue;
      this.sessionKeys.set(id, credential);
      return credential;
    }
  }

  private load(): Promise<Record<string, string>> {
    if (!this.document) {
      this.document = readFile(this.filePath, "utf8").then((text) => {
        const data = JSON.parse(text) as { version?: unknown; entries?: unknown };
        if (data?.version !== 1 || !data.entries || typeof data.entries !== "object" ||
            Array.isArray(data.entries) || Object.values(data.entries).some((item) =>
              typeof item !== "string" || item.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item))) {
          throw new Error("Invalid credential file.");
        }
        return data.entries as Record<string, string>;
      }).catch((error: unknown) => {
        this.document = undefined;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error("Saved server credentials could not be read.");
      });
    }
    return this.document;
  }

  private async write(entries: Record<string, string>): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, entries }), {
        encoding: "utf8", mode: 0o600, flag: "wx"
      });
      await rename(temporary, this.filePath);
    } catch {
      throw new Error("The API key could not be saved.");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
