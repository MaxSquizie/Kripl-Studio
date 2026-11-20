import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/main/local-model-credentials.ts", import.meta.url))],
  alias: {
    "@kripl/local-openai-provider": fileURLToPath(new URL(
      "../../../packages/local-openai-provider/src/endpoint-policy.ts", import.meta.url
    ))
  },
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false
}).outputFiles[0].text;
const credentialModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), credentialModule, credentialModule.exports
);
const { LocalModelCredentialStore, localModelConnectionKey, parseLocalModelConnection } = credentialModule.exports;

const connection = { server: "unsloth", endpoint: "http://127.0.0.1:8888/v1" };
const fixtureEncryptionKey = createHash("sha256").update("Kripl Studio credential test fixture").digest();

function encryption() {
  return {
    async available() { return true; },
    async encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", fixtureEncryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(value) {
      const cipher = createDecipheriv("aes-256-gcm", fixtureEncryptionKey, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, crypto = encryption()) {
  const directory = await mkdtemp(join(tmpdir(), "kripl-credentials-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "private", "credentials.json");
  return { directory, filePath, crypto, store: new LocalModelCredentialStore(filePath, crypto) };
}

test("credentials persist only as ciphertext and restore in a fresh store", async (t) => {
  const f = await fixture(t);
  const key = "fixture-unsloth-private-value";
  assert.deepEqual(await f.store.set(connection, key), { ok: true, hasApiKey: true, persistent: true });
  const raw = await readFile(f.filePath, "utf8");
  assert.equal(raw.includes(key), false);
  assert.equal(raw.includes(Buffer.from(key).toString("base64")), false);
  const document = JSON.parse(raw);
  assert.equal(document.version, 1);
  assert.equal(Object.keys(document.entries).length, 1);
  assert.equal(await f.crypto.decrypt(Buffer.from(Object.values(document.entries)[0], "base64")), key);
  if (process.platform !== "win32") assert.equal((await stat(f.filePath)).mode & 0o077, 0);
  const restored = new LocalModelCredentialStore(f.filePath, encryption());
  assert.equal(await restored.get(connection), key);
  assert.deepEqual(await restored.status(connection), { ok: true, hasApiKey: true, persistent: true });
});

test("equivalent local endpoints share a credential and legacy strings default to LM Studio", async (t) => {
  const f = await fixture(t);
  const equivalent = { server: "unsloth", endpoint: "http://LOCALHOST.:8888/v1/?ignored=1#fragment" };
  assert.equal(localModelConnectionKey(equivalent), localModelConnectionKey(connection));
  assert.deepEqual(parseLocalModelConnection("http://localhost:1234/"), {
    server: "lm-studio", endpoint: "http://127.0.0.1:1234/v1"
  });
  await f.store.set(equivalent, "fixture-canonical-key");
  assert.equal(await f.store.get(connection), "fixture-canonical-key");
  assert.equal(await new LocalModelCredentialStore(f.filePath, encryption()).get(connection), "fixture-canonical-key");
});

test("credentials are isolated by server and canonical endpoint", async (t) => {
  const f = await fixture(t);
  const otherServer = { ...connection, server: "lm-studio" };
  const otherEndpoint = { ...connection, endpoint: "http://127.0.0.1:8889/v1" };
  const otherPath = { ...connection, endpoint: "http://127.0.0.1:8888/other/v1" };
  await f.store.set(connection, "fixture-unsloth");
  assert.equal(await f.store.get(otherServer), undefined);
  assert.equal(await f.store.get(otherEndpoint), undefined);
  assert.equal(await f.store.get(otherPath), undefined);
  await f.store.set(otherServer, "fixture-lm-studio");
  await f.store.set(otherEndpoint, "fixture-other-port");
  const restored = new LocalModelCredentialStore(f.filePath, encryption());
  assert.equal(await restored.get(connection), "fixture-unsloth");
  assert.equal(await restored.get(otherServer), "fixture-lm-studio");
  assert.equal(await restored.get(otherEndpoint), "fixture-other-port");
  assert.equal(await restored.get(otherPath), undefined);
});

test("concurrent saves and rotations preserve every connection after restart", async (t) => {
  const f = await fixture(t);
  const connections = Array.from({ length: 12 }, (_, index) => ({
    server: index % 2 ? "lm-studio" : "unsloth", endpoint: `http://127.0.0.1:${9000 + index}/v1`
  }));
  await Promise.all(connections.map((entry, index) => f.store.set(entry, `fixture-initial-${index}`)));
  await Promise.all(connections.flatMap((entry, index) => [
    f.store.set(entry, `fixture-intermediate-${index}`), f.store.set(entry, `fixture-final-${index}`)
  ]));
  const restored = new LocalModelCredentialStore(f.filePath, encryption());
  for (const [index, entry] of connections.entries()) assert.equal(await restored.get(entry), `fixture-final-${index}`);
  assert.equal(Object.keys(JSON.parse(await readFile(f.filePath, "utf8")).entries).length, connections.length);
  assert.deepEqual(await readdir(dirname(f.filePath)), ["credentials.json"]);
});

test("unavailable encryption keeps a new key in memory without writing any file", async (t) => {
  const f = await fixture(t, {
    async available() { return false; },
    async encrypt() { assert.fail("Encryption must not run without a secure backend"); },
    async decrypt() { assert.fail("Decryption must not run without a secure backend"); }
  });
  assert.deepEqual(await f.store.set(connection, "fixture-session-only"), {
    ok: true, hasApiKey: true, persistent: false
  });
  assert.equal(await f.store.get(connection), "fixture-session-only");
  assert.deepEqual(await f.store.status(connection), { ok: true, hasApiKey: true, persistent: false });
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(await new LocalModelCredentialStore(f.filePath, f.crypto).get(connection), undefined);
});

test("rotation and deletion update disk without changing another server's key", async (t) => {
  const f = await fixture(t);
  const other = { ...connection, server: "lm-studio" };
  await f.store.set(connection, "fixture-before-rotation");
  await f.store.set(other, "fixture-unrelated");
  const before = await readFile(f.filePath, "utf8");
  await f.store.set(connection, "fixture-after-rotation");
  assert.notEqual(await readFile(f.filePath, "utf8"), before);
  assert.equal(await new LocalModelCredentialStore(f.filePath, encryption()).get(connection), "fixture-after-rotation");
  assert.deepEqual(await f.store.set(connection, "  "), { ok: true, hasApiKey: false, persistent: false });
  assert.equal(await f.store.get(connection), undefined);
  const restored = new LocalModelCredentialStore(f.filePath, encryption());
  assert.equal(await restored.get(connection), undefined);
  assert.equal(await restored.get(other), "fixture-unrelated");
});

test("replacing a persisted key in session-only mode removes its old disk credential", async (t) => {
  const crypto = encryption();
  let available = true;
  crypto.available = async () => available;
  const f = await fixture(t, crypto);
  await f.store.set(connection, "fixture-persisted");
  available = false;
  assert.deepEqual(await f.store.set(connection, "fixture-memory-replacement"), {
    ok: true, hasApiKey: true, persistent: false
  });
  assert.equal(await f.store.get(connection), "fixture-memory-replacement");
  const raw = await readFile(f.filePath, "utf8");
  assert.equal(raw.includes("fixture-memory-replacement"), false);
  assert.deepEqual(JSON.parse(raw).entries, {});
  assert.equal(await new LocalModelCredentialStore(f.filePath, encryption()).get(connection), undefined);
});

test("failed persistence preserves the old credential and the mutation queue recovers", async (t) => {
  const f = await fixture(t);
  await f.store.set(connection, "fixture-original");
  const original = await readFile(f.filePath, "utf8");
  const backup = `${f.filePath}.backup`;
  await rename(f.filePath, backup);
  await mkdir(f.filePath);
  for (const value of ["fixture-failed-rotation", ""]) {
    await assert.rejects(f.store.set(connection, value), { message: "The API key could not be saved." });
    assert.equal(await f.store.get(connection), "fixture-original");
    assert.deepEqual(await f.store.status(connection), { ok: true, hasApiKey: true, persistent: true });
  }
  assert.equal(await readFile(backup, "utf8"), original);
  assert.equal((await readdir(dirname(f.filePath))).some((name) => name.endsWith(".tmp")), false);
  await rm(f.filePath, { recursive: true });
  await rename(backup, f.filePath);
  await f.store.set(connection, "fixture-recovered");
  assert.equal(await new LocalModelCredentialStore(f.filePath, encryption()).get(connection), "fixture-recovered");
});

test("invalid connections and multiline or invalid API keys fail without exposing the key", async (t) => {
  const f = await fixture(t);
  const key = "fixture-value-never-in-errors";
  const invalidConnections = [
    null, [], {}, "file:///tmp/models", "ftp://localhost:8888/v1",
    { endpoint: "http://example.com/v1", server: "unsloth" },
    { endpoint: "http://localhost:8888/v1", server: "unknown" },
    { endpoint: "http://username:password@localhost:8888/v1", server: "unsloth" }
  ];
  for (const invalid of invalidConnections) {
    assert.throws(() => f.store.set(invalid, key), (error) => !error.message.includes(key));
    await assert.rejects(f.store.get(invalid), (error) => !error.message.includes(key));
  }
  for (const value of [null, undefined, 42, {}, "fixture\nkey", "fixture-key\n", "\r\nfixture-key", "fixture\rkey", "fixture key", "ключ", "x".repeat(8193)]) {
    assert.throws(() => f.store.set(connection, value), { message: "Invalid API key." });
  }
  assert.deepEqual(await readdir(f.directory), []);
});

test("encryption and decryption failures never expose provider errors or replace a working key", async (t) => {
  const f = await fixture(t);
  await f.store.set(connection, "fixture-working");
  const original = await readFile(f.filePath, "utf8");
  f.crypto.encrypt = async (value) => { throw new Error(`Failure handling ${value}`); };
  await assert.rejects(f.store.set(connection, "fixture-sensitive-failure"), {
    message: "The API key could not be encrypted."
  });
  assert.equal(await f.store.get(connection), "fixture-working");
  assert.equal(await readFile(f.filePath, "utf8"), original);
  const unreadable = new LocalModelCredentialStore(f.filePath, {
    ...encryption(), async decrypt() { throw new Error("fixture-private-decryption-error"); }
  });
  await assert.rejects(unreadable.get(connection), {
    message: "The saved API key could not be opened. Re-enter it in Settings → Model."
  });
});

test("a corrupt credential document fails explicitly without exposing its contents", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.filePath), { recursive: true });
  await writeFile(f.filePath, '{"version":1,"entries":fixture-private-corrupt-data');
  await assert.rejects(f.store.status(connection), { message: "Saved server credentials could not be read." });
  await assert.rejects(f.store.set(connection, "fixture-new-value"), { message: "Saved server credentials could not be read." });
});

for (const action of ["rotate", "delete"]) {
  test(`a delayed decryption cannot restore an old key after ${action}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await f.store.set(connection, "fixture-old-decryption");
    const entered = deferred();
    const release = deferred();
    const crypto = encryption();
    const reader = new LocalModelCredentialStore(f.filePath, {
      ...crypto,
      async decrypt(value) {
        entered.resolve();
        await release.promise;
        return crypto.decrypt(value);
      }
    });
    const pending = reader.get(connection);
    await entered.promise;
    try {
      await reader.set(connection, action === "rotate" ? "fixture-current-key" : "");
    } finally {
      release.resolve();
    }
    const expected = action === "rotate" ? "fixture-current-key" : undefined;
    assert.equal(await pending, expected);
    assert.equal(await reader.get(connection), expected);
    assert.deepEqual(await reader.status(connection), {
      ok: true, hasApiKey: action === "rotate", persistent: action === "rotate"
    });
  });
}
