const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { usesAsyncStorage, storageAvailable } = require("./secure-storage.cjs");
function normalizePersona(value) {
  return String(value).replaceAll("小光", "小八").replace(/\bHalo\b/gi, "小八");
}
const DEFAULTS = {
  provider: "api",
  gptModel: "",
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com/anthropic",
  persona:
    "你叫小八，是住在用户桌面上的数字伙伴。用自然、简洁、温暖的中文交流。保持诚实，不假装真人，不编造已经执行的操作。没有工具时直接说明能力边界。",
  memory: "",
};
function validateSettings(input) {
  const url = new URL(String(input.baseUrl || DEFAULTS.baseUrl));
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("模型地址需要 HTTPS，本机测试地址可以用 HTTP。");
  if (url.username || url.password || url.search || url.hash)
    throw Error("模型地址不能包含账号、查询参数或锚点。");
  const model = String(input.model || DEFAULTS.model).trim();
  if (!model || model.length > 150) throw Error("请填写有效的模型名称。");
  return {
    provider: input.provider === "chatgpt" ? "chatgpt" : "api",
    gptModel: String(input.gptModel || "").trim().slice(0, 150),
    baseUrl: url.href.replace(/\/$/, ""),
    model,
    persona: normalizePersona(input.persona || DEFAULTS.persona).slice(0, 5000),
    memory: String(input.memory || "").slice(0, 5000),
  };
}
class Store {
  constructor(dir, encryption) {
    this.dir = dir;
    this.encryption = encryption;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "settings.json");
    this.data = this.read(this.file, {
      ...DEFAULTS,
      sessionId: crypto.randomUUID(),
    });
    // Drop obsolete preferences while retaining credentials and the active session.
    const keys = [...Object.keys(DEFAULTS), "sessionId", "secret", "secretFormat"];
    this.data = { ...DEFAULTS, ...Object.fromEntries(keys.filter((key) => Object.hasOwn(this.data, key)).map((key) => [key, this.data[key]])) };
    const savedPersona = String(this.data.persona || DEFAULTS.persona);
    this.data.persona = normalizePersona(savedPersona);
    if (this.data.persona !== savedPersona) this.write(this.file, this.data);
    this.keyCache = "";
  }
  async initialize() {
    if (!this.data.secret || this.data.secretFormat !== "async-v1") return;
    try {
      const decrypted = await this.encryption.decryptStringAsync(
        Buffer.from(this.data.secret, "base64"),
      );
      this.keyCache = decrypted.result;
    } catch {
      this.keyCache = "";
    }
  }
  read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return fallback;
      throw Error("本地记录读取失败，请先备份数据再检查 JSON 文件。");
    }
  }
  write(file, value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  get key() {
    if (!this.data.secret) return "";
    if (this.data.secretFormat === "async-v1") return this.keyCache;
    try {
      return this.encryption.decryptString(
        Buffer.from(this.data.secret, "base64"),
      );
    } catch {
      return "";
    }
  }
  public() {
    const { secret, secretFormat, ...rest } = this.data;
    return { ...rest, hasKey: !!this.key };
  }
  async save(input) {
    const validated = validateSettings(input);
    let secret = this.data.secret;
    let secretFormat = this.data.secretFormat;
    let keyCache = this.keyCache;
    if (input.clearKey) {
      secret = undefined;
      secretFormat = undefined;
      keyCache = "";
    } else if (String(input.apiKey || "").trim()) {
      const insecureLinux = process.platform === "linux" && this.encryption.getSelectedStorageBackend?.() === "basic_text";
      const available = await storageAvailable(this.encryption);
      if (!available || insecureLinux)
        throw Error("系统安全存储暂不可用，密钥未保存。");
      const key = String(input.apiKey).trim();
      const asyncStorage = usesAsyncStorage(this.encryption);
      try {
        const encrypted = asyncStorage
          ? await this.encryption.encryptStringAsync(key)
          : this.encryption.encryptString(key);
        const decrypted = asyncStorage
          ? (await this.encryption.decryptStringAsync(encrypted)).result
          : this.encryption.decryptString(encrypted);
        if (decrypted !== key) throw Error("密钥读回失败");
        secret = encrypted.toString("base64");
        secretFormat = asyncStorage ? "async-v1" : "sync-v1";
        keyCache = key;
      } catch {
        throw Error("密钥未保存，请允许小八访问系统钥匙串后重试。");
      }
    }
    const next = { ...this.data, ...validated, secret, secretFormat };
    this.write(this.file, next);
    this.data = next;
    this.keyCache = keyCache;
    return this.public();
  }
  history() {
    return this.read(
      path.join(this.dir, `chat-${this.data.sessionId}.json`),
      [],
    );
  }
  append(role, text) {
    const h = this.history();
    h.push({ role, text, at: new Date().toISOString() });
    this.write(path.join(this.dir, `chat-${this.data.sessionId}.json`), h);
  }
  newChat() {
    this.data.sessionId = crypto.randomUUID();
    this.write(this.file, this.data);
    return this.data.sessionId;
  }
}
module.exports = { Store, validateSettings, DEFAULTS };
