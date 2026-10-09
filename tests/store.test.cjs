const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, validateSettings } = require("../src/store.cjs");
test("reject insecure remote endpoint and URL credentials", () => {
  for (const baseUrl of [
    "http://example.com",
    "https://user:secret@example.com",
    "file:///tmp/x",
  ])
    assert.throws(() => validateSettings({ baseUrl }));
  assert.equal(
    validateSettings({ baseUrl: "http://127.0.0.1:1234" }).baseUrl,
    "http://127.0.0.1:1234",
  );
});
test("persist encrypted credential and isolate chat history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-store-"));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from("encrypted:" + s),
    decryptString: (b) => b.toString().slice(10),
  };
  try {
    const s = new Store(dir, encryption);
    await s.save({ apiKey: "secret", memory: "叫小明" });
    s.append("user", "你好");
    assert.equal(s.public().secret, undefined);
    assert.equal(s.public().hasKey, true);
    const t = new Store(dir, encryption);
    assert.equal(t.key, "secret");
    assert.equal(t.history().length, 1);
    t.newChat();
    assert.equal(t.history().length, 0);
    assert.equal(t.data.memory, "叫小明");
    await t.save({ ...t.public(), clearKey: true });
    assert.equal(t.key, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("refuse saving key without secure storage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-store-"));
  try {
    const s = new Store(dir, { isEncryptionAvailable: () => false });
    await assert.rejects(s.save({ apiKey: "secret" }), /未保存/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("API key survives restart with async keychain while sync storage is unavailable", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-store-"));
  const encryption = {
    isEncryptionAvailable: () => false,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from(Buffer.from(s).toString("base64")),
    decryptStringAsync: async (b) => ({ result: Buffer.from(b.toString(), "base64").toString(), shouldReEncrypt: false }),
    encryptString() { throw Error("Must use async keychain"); },
    decryptString() { throw Error("Must use async keychain"); },
  };
  try {
    const first = new Store(dir, encryption);
    await first.initialize();
    await first.save({ apiKey: " async-api-key ", memory: "保留偏好" });
    first.append("user", "保留对话");
    assert.equal(first.key, "async-api-key");
    assert.equal(first.public().hasKey, true);
    assert.equal(first.public().secret, undefined);
    assert.ok(!JSON.stringify(first.public()).includes("async-api-key"));
    assert.ok(!fs.readFileSync(first.file, "utf8").includes("async-api-key"));
    const restarted = new Store(dir, encryption);
    await restarted.initialize();
    assert.equal(restarted.key, "async-api-key");
    assert.equal(restarted.history()[0].text, "保留对话");
    await restarted.save({ ...restarted.public(), provider: "chatgpt" });
    await restarted.save({ ...restarted.public(), provider: "api", apiKey: "   " });
    assert.equal(restarted.key, "async-api-key");
    assert.equal(restarted.data.memory, "保留偏好");
    await restarted.save({ ...restarted.public(), clearKey: true });
    const cleared = new Store(dir, encryption);
    await cleared.initialize();
    assert.equal(cleared.key, "");
    assert.equal(cleared.public().hasKey, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("failed keychain readback preserves the previous key and settings", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-store-"));
  let broken = false;
  const encryption = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from(s),
    decryptStringAsync: async (b) => ({ result: broken ? "wrong-key" : b.toString() }),
  };
  try {
    const store = new Store(dir, encryption);
    await store.save({ apiKey: "original-key", memory: "原偏好" });
    const previous = fs.readFileSync(store.file, "utf8");
    broken = true;
    await assert.rejects(store.save({ apiKey: "replacement-key", memory: "新偏好" }), /未保存/);
    assert.equal(store.key, "original-key");
    assert.equal(store.data.memory, "原偏好");
    assert.equal(fs.readFileSync(store.file, "utf8"), previous);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy assistant name migrates without changing memory, keys or chat history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-store-"));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from("cipher:" + s),
    decryptString: (b) => b.toString().slice(7),
  };
  try {
    const first = new Store(dir, encryption);
    await first.save({ apiKey: "migration-key", memory: "朋友叫小光" });
    first.append("assistant", "我是小光。");
    const legacy = { ...first.data, persona: "你叫小光，是桌面伙伴 Halo。保持简短。" };
    first.write(first.file, legacy);
    const migrated = new Store(dir, encryption);
    assert.equal(migrated.data.persona, "你叫小八，是桌面伙伴 小八。保持简短。");
    assert.equal(migrated.key, "migration-key");
    assert.equal(migrated.data.memory, "朋友叫小光");
    assert.equal(migrated.data.sessionId, first.data.sessionId);
    assert.equal(migrated.history()[0].text, "我是小光。");
    assert.equal(JSON.parse(fs.readFileSync(first.file, "utf8")).persona, migrated.data.persona);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
