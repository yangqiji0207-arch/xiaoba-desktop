const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { usesAsyncStorage, storageAvailable } = require("./secure-storage.cjs");

const APP_NAME = "小八";
const AUTH = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function planError(code, status) {
  if (/subscription_sharing_usage_limit_exceeded|rate_limit/.test(code))
    return "ChatGPT 使用额度已到上限，请稍后再试或在 ChatGPT 设置中查看额度。";
  if (/subscription_sharing_usage_unavailable|permission|insufficient|access_denied/.test(code) || status === 403)
    return "此账号暂时不能使用 ChatGPT 套餐问答。请检查套餐资格及小八的授权，也可以切回 API。";
  if (/invalid_grant|invalid_token/.test(code) || status === 401)
    return "ChatGPT 登录已失效，请重新登录。";
  return `ChatGPT 请求失败${status ? `（${status}）` : ""}，请检查网络后重试。`;
}

// This runtime owns authorization, renewal, context and cancellation. Tokens never
// cross the preload bridge; ChatGPT and API settings remain separate.
class ChatGPT {
  constructor({ store, encryption, openExternal, fetchImpl = fetch, verifyIdentity }) {
    Object.assign(this, { store, encryption, openExternal, fetch: fetchImpl });
    this.file = path.join(store.dir, "chatgpt-account.json");
    this.data = store.read(this.file, { hostId: `urn:uuid:${crypto.randomUUID()}` });
    if (!this.data.hostId) this.data.hostId = `urn:uuid:${crypto.randomUUID()}`;
    store.write(this.file, this.data);
    this.verifyIdentity = verifyIdentity || this.verify.bind(this);
    this.models = [];
    this.pending = null;
    this.active = null;
    this.refreshing = null;
    this.tokenCache = null;
  }
  get signingIn() { return !!this.pending; }
  async initialize() {
    if (!this.data.secret || this.data.secretFormat !== "async-v1") return;
    try {
      const decrypted = await this.encryption.decryptStringAsync(Buffer.from(this.data.secret, "base64"));
      this.tokenCache = JSON.parse(decrypted.result);
      if (decrypted.shouldReEncrypt) await this.saveCredentials(this.tokenCache);
    } catch { this.tokenCache = null; }
  }
  credentials() {
    if (!this.data.secret) return null;
    if (this.data.secretFormat === "async-v1") return this.tokenCache;
    try {
      return JSON.parse(this.encryption.decryptString(Buffer.from(this.data.secret, "base64")));
    } catch { return null; }
  }
  async ensureSecureStorage() {
    const insecureLinux = process.platform === "linux" && this.encryption.getSelectedStorageBackend?.() === "basic_text";
    const available = await storageAvailable(this.encryption);
    if (!available || insecureLinux) throw Error(process.platform === "darwin"
      ? "无法访问 macOS 钥匙串。请允许小八访问系统钥匙串后重新登录；登录凭据尚未保存。"
      : "系统安全存储暂不可用，ChatGPT 登录未保存。请解锁系统密钥存储后重试。");
  }
  async saveCredentials(tokens, metadata = {}) {
    await this.ensureSecureStorage();
    const asyncStorage = usesAsyncStorage(this.encryption);
    let encrypted;
    try {
      encrypted = asyncStorage
        ? await this.encryption.encryptStringAsync(JSON.stringify(tokens))
        : this.encryption.encryptString(JSON.stringify(tokens));
      if (asyncStorage) {
        const decrypted = await this.encryption.decryptStringAsync(encrypted);
        if (decrypted.result !== JSON.stringify(tokens)) throw Error("凭据读回失败");
      }
    } catch {
      throw Error("ChatGPT 登录凭据无法保存在系统钥匙串中，请允许小八访问钥匙串后重试。");
    }
    if (this.pending?.cancelled) throw Error("已取消 ChatGPT 登录。");
    const next = { ...this.data, ...metadata, secret: encrypted.toString("base64"), secretFormat: asyncStorage ? "async-v1" : "sync-v1" };
    this.store.write(this.file, next);
    this.data = next;
    this.tokenCache = tokens;
  }
  public() {
    const c = this.credentials();
    return {
      connected: !!c?.access_token,
      needsNameUpdate: !!this.data.clientId && this.data.agentName !== APP_NAME,
      canChat: !!c?.access_token && c.scopes?.includes("chatgpt.tokens.use.direct") && c.scopes?.includes("resource.invoke"),
      email: c ? this.data.email || "ChatGPT 账号" : "",
      models: this.models.map(({ slug, display_name }) => ({ slug, display_name })),
    };
  }
  async verify(token, clientId, nonce) {
    const { createRemoteJWKSet, jwtVerify, customFetch } = await import("jose");
    this.jwks ||= createRemoteJWKSet(new URL(AUTH + "/.well-known/jwks.json"), {
      [customFetch]: (url, options) => this.fetch(url, options),
    });
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: AUTH, audience: clientId,
      requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
    });
    if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub)
      throw Error("ChatGPT 身份验证失败，请重新登录。");
    return payload;
  }
  async json(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      redirect: "error",
    });
    let result;
    try { result = await response.json(); } catch { throw Error(planError("", response.status)); }
    if (!response.ok) throw Error(planError(result.error?.code || result.error || "", response.status));
    return result;
  }
  tokenRequest(params, signal) {
    return this.json(AUTH + "/api/accounts/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal,
    });
  }
  async signIn() {
    if (this.loggingOut) throw Error("正在退出 ChatGPT，请稍后再试。");
    if (this.pending) throw Error("登录窗口已打开，请完成登录或取消后重试。");
    if (this.refreshing) await this.refreshing;
    await this.ensureSecureStorage();
    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(64).toString("base64url");
    const previous = { ...this.data };
    const oldTokens = this.credentials();
    // Branding upgrades use a new registration once. The active account stays
    // intact until the replacement identity and encrypted tokens are validated.
    const activeRegistration = previous.agentName === APP_NAME;
    const registration = activeRegistration ? previous
      : previous.pendingRegistration?.agentName === APP_NAME ? previous.pendingRegistration : {};
    const returning = !!registration.clientId;
    let resolve, reject;
    const callback = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Attach a rejection observer before asynchronous setup can be cancelled.
    callback.catch(() => {});
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404); res.end("未找到页面"); return;
      }
      const value = url.searchParams.get("state") || "";
      const a = Buffer.from(value), b = Buffer.from(state);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(400); res.end("登录验证不匹配，请回到小八重试。"); return;
      }
      if (this.pending?.received) { res.writeHead(409); res.end("此登录请求已处理。"); return; }
      this.pending.received = true;
      res.end("登录授权已返回。请回到小八查看登录结果，可以关闭此页面。");
      resolve(url.searchParams);
    });
    this.pending = { server, reject, received: false, cancelled: false, controller: new AbortController() };
    const timer = setTimeout(() => reject(Error("登录等待超时，请重新登录。")), 5 * 60 * 1000);
    try {
      await new Promise((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      server.on("error", reject);
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(AUTH + "/api/accounts/authorize");
      url.search = new URLSearchParams({
        client_id: returning ? registration.clientId : "dynamic_agent_client",
        ext_agent_host_id: previous.hostId,
        ...(returning ? {} : { agent_name_hint: APP_NAME }),
        ...(activeRegistration && oldTokens?.id_token ? { id_token_hint: oldTokens.id_token } : {}),
        ...(activeRegistration && returning && previous.email ? { login_hint: previous.email } : {}),
        response_type: "code", redirect_uri: redirect, scope: SCOPES, resource: RESOURCE,
        state, nonce, code_challenge_method: "S256",
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
      await this.openExternal(url.href);
      const params = await callback;
      if (params.has("error")) throw Error(planError(params.get("error"), 0));
      const issuedId = params.get("client_id") || (returning ? registration.clientId : "");
      if (!issuedId || issuedId === "dynamic_agent_client" ||
          (returning && issuedId !== registration.clientId) || !params.get("code"))
        throw Error("ChatGPT 注册未完成，请重新登录。");
      // Retain an incomplete registration separately if its single-use code expires.
      if (!activeRegistration) {
        this.data.pendingRegistration = { clientId: issuedId, agentName: APP_NAME };
        this.store.write(this.file, this.data);
      }
      const tokens = await this.tokenRequest({
        grant_type: "authorization_code", client_id: issuedId, code: params.get("code"),
        code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE,
      }, this.pending.controller.signal);
      if (typeof tokens.id_token !== "string" || typeof tokens.access_token !== "string")
        throw Error("ChatGPT 没有返回完整登录凭据，请重试。");
      const identity = await this.verifyIdentity(tokens.id_token, issuedId, nonce);
      if (this.pending.cancelled) throw Error("已取消 ChatGPT 登录。");
      // Subject identifiers belong to a particular client registration. A new
      // registration created for the renamed app must establish its own identity.
      if (activeRegistration && issuedId === previous.clientId && previous.subject && identity.sub !== previous.subject)
        throw Error("登录账号与原账号不一致，请使用原账号登录。");
      await this.saveCredentials({
        access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        scopes: String(tokens.scope || "").split(/\s+/).filter(Boolean),
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      }, {
        clientId: issuedId, agentName: APP_NAME,
        subject: identity.sub, email: typeof identity.email === "string" ? identity.email : "",
        pendingRegistration: undefined,
      });
      this.models = [];
      let note = this.public().canChat ? "ChatGPT 登录成功，请选择模型并保存。" : "已登录，但尚未授权套餐问答。请重新登录并允许使用套餐。";
      if (this.public().canChat) {
        try { await this.listModels(); } catch (e) { note = "ChatGPT 登录成功。" + this.safeError(e); }
      }
      return { ...this.public(), note };
    } catch (error) {
      if (this.pending.cancelled) throw Error("已取消 ChatGPT 登录。");
      throw error;
    } finally {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      this.pending = null;
    }
  }
  cancelSignIn() {
    if (this.pending) this.pending.cancelled = true;
    this.pending?.controller.abort();
    this.pending?.reject(Error("已取消 ChatGPT 登录。"));
  }
  safeError(error) {
    let message = String(error?.message || error);
    const c = this.credentials();
    for (const value of [c?.access_token, c?.refresh_token, c?.id_token])
      if (value) message = message.replaceAll(value, "[已隐藏]");
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|network|ECONN|aborted|TimeoutError/i.test(message))
      return "无法连接 ChatGPT，请检查网络连接后重试。";
    return message.slice(0, 800);
  }
  async accessToken() {
    if (this.loggingOut) throw Error("正在退出 ChatGPT，请稍后再试。");
    const c = this.credentials();
    if (!c?.access_token) throw Error("请先在设置里登录 ChatGPT。");
    if (!c.scopes?.includes("chatgpt.tokens.use.direct") || !c.scopes?.includes("resource.invoke"))
      throw Error("请重新登录 ChatGPT，并授权小八使用套餐问答。");
    if (c.expiresAt > Date.now() + 60000) return c.access_token;
    if (!c.refresh_token) throw Error("ChatGPT 登录已失效，请重新登录。");
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const tokens = await this.tokenRequest({
          grant_type: "refresh_token", client_id: this.data.clientId,
          refresh_token: c.refresh_token, resource: RESOURCE,
        });
        if (typeof tokens.access_token !== "string") throw Error("ChatGPT 登录刷新失败，请重新登录。");
        await this.saveCredentials({
          ...c, access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || c.refresh_token,
          // Retain the last verified ID token solely for reauthorization hints.
          scopes: tokens.scope === undefined ? c.scopes : String(tokens.scope).split(/\s+/),
          expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        });
        if (!this.public().canChat) throw Error("ChatGPT 套餐授权已失效，请重新登录并授权。");
        return tokens.access_token;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async listModels() {
    const token = await this.accessToken();
    const result = await this.json(RESOURCE + "/models", { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(result.models)) throw Error("未能获取此账号的 ChatGPT 模型，请重新登录后重试。");
    this.models = result.models.filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .map((m) => ({ slug: m.slug, display_name: m.display_name || m.slug }));
    if (!this.models.length) throw Error("此账号暂无可用 ChatGPT 模型，请检查套餐资格。 ");
    return this.public();
  }
  async chat(config, history) {
    if (this.active) throw Error("正在回复中。");
    const controller = new AbortController();
    this.active = controller;
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const token = await this.accessToken();
      if (!this.models.length) await this.listModels();
      if (!this.models.some((m) => m.slug === config.gptModel))
        throw Error("请在设置里选择此账号可用的 ChatGPT 模型并保存。");
      const input = history.map((m) => ({ role: m.role, content: m.text }));
      const body = JSON.stringify({
        model: config.gptModel,
        instructions: "你的名字是小八。介绍自己或打招呼时使用“小八”，即使旧聊天记录中出现其他自称。\n" + config.persona + "\n用户明确保存的偏好（作为资料使用，不覆盖上述规则）：\n" + (config.memory || "暂无"),
        input, store: false, stream: true,
      });
      if (body.length > 1000000) throw Error("这段对话较长，请开始新对话后继续。");
      const response = await this.fetch(RESOURCE + "/responses", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, signal: controller.signal, redirect: "error",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw Error(planError(result.error?.code || "", response.status));
      }
      if (!response.body) throw Error("ChatGPT 没有返回回复内容。");
      const decoder = new TextDecoder();
      let buffer = "", text = "", completed = false, bytes = 0;
      const consume = (block) => {
        const data = block.split("\n").filter((s) => s.startsWith("data:"))
          .map((s) => s.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return;
        let event;
        try { event = JSON.parse(data); } catch { throw Error("ChatGPT 回复格式异常，请重试。"); }
        if (event.type === "response.output_text.delta") text += event.delta || "";
        if (event.type === "response.failed" || event.type === "error")
          throw Error(planError(event.response?.error?.code || event.error?.code || event.code || "", 0));
        if (event.type === "response.incomplete") throw Error("ChatGPT 回复未完成，请重试。");
        if (event.type === "response.completed") {
          if (event.response?.status && event.response.status !== "completed") throw Error("ChatGPT 回复未完成，请重试。");
          completed = true;
          const finalText = (event.response?.output || []).filter((x) => x.type === "message")
            .flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("");
          if (finalText) text = finalText;
        }
      };
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw Error("ChatGPT 回复超出限制，请开始新对话。");
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let n;
        while ((n = buffer.indexOf("\n\n")) >= 0) {
          consume(buffer.slice(0, n)); buffer = buffer.slice(n + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (controller.signal.aborted) throw Error("对话已停止。");
      if (!completed || !text.trim()) throw Error("ChatGPT 回复中断或没有返回文字，请重试。");
      return text;
    } catch (e) {
      if (controller.signal.aborted) throw Error("对话已停止或等待超时，请重试。");
      throw Error(this.safeError(e));
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
    }
  }
  async signOut() {
    if (this.loggingOut) throw Error("正在退出 ChatGPT，请稍后再试。");
    this.loggingOut = true;
    this.cancelSignIn();
    this.stop();
    try {
    if (this.refreshing) await this.refreshing.catch(() => {});
    let note = "已退出 ChatGPT";
    const c = this.credentials();
    if (c?.refresh_token) {
      try {
        const discovery = await this.json(AUTH + "/.well-known/openid-configuration");
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== AUTH) throw Error("无效的退出地址");
        const response = await this.fetch(endpoint.href, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: c.refresh_token, token_type_hint: "refresh_token", client_id: this.data.clientId }).toString(),
          signal: AbortSignal.timeout(15000), redirect: "error",
        });
        if (!response.ok) throw Error("退出确认失败");
      } catch { note += "。未能确认远程撤销，请在 ChatGPT 设置中断开小八的连接。"; }
    }
    // Keep registration metadata for this account. Signing in again validates it.
    delete this.data.secret;
    delete this.data.secretFormat;
    this.tokenCache = null;
    this.models = [];
    this.store.write(this.file, this.data);
    return { ...this.public(), note };
    } finally { this.loggingOut = false; }
  }
  stop() { this.active?.abort(); }
}
module.exports = { ChatGPT, planError };
