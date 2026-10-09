const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store.cjs");
const { ChatGPT } = require(process.env.XIAOBA_TEST_GPT_MODULE || "../src/chatgpt.cjs");

const encryption = {
  isEncryptionAvailable: () => true,
  // Reversible test cipher; real app uses Electron safeStorage.
  encryptString: (s) => Buffer.from(Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(b.toString(), "base64").toString(),
};
async function fixture(t, { badNonce = false, badAudience = false, denied = false, badScope = false, exchangeFailure = false, subject = "verified-subject", storage = encryption } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-gpt-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, encryption);
  await store.save({ apiKey: "api-test-secret", memory: "用户叫小明" });
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const state = { authUrl: null, requests: [], refreshes: 0, completed: true, failure: false };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const client = new ChatGPT({ store, encryption: storage,
    openExternal: async (value) => {
      state.authUrl = new URL(value);
      const target = new URL(state.authUrl.searchParams.get("redirect_uri"));
      target.searchParams.set("state", "invalid-state");
      assert.equal((await fetch(target)).status, 400);
      target.searchParams.set("state", state.authUrl.searchParams.get("state"));
      if (denied) target.searchParams.set("error", "access_denied");
      else {
        target.searchParams.set("code", "one-time-code");
        target.searchParams.set("client_id", "oaiapp_xiaoba-test");
      }
      assert.equal((await fetch(target)).status, 200);
    },
    fetchImpl: async (url, options = {}) => {
      url = String(url);
      state.requests.push({ url, options });
      if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
      if (url.endsWith("/oauth/token")) {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("client_id"), "oaiapp_xiaoba-test");
        assert.equal(body.get("resource"), "https://api.openai.com/v1");
        if (body.get("grant_type") === "refresh_token") {
          state.refreshes++;
          assert.equal(body.get("refresh_token"), "refresh-test-secret");
          return json({ access_token: "renewed-test-secret", refresh_token: "rotated-test-secret", expires_in: 3600 });
        }
        assert.equal(body.get("redirect_uri"), state.authUrl.searchParams.get("redirect_uri"));
        assert.equal(require("node:crypto").createHash("sha256").update(body.get("code_verifier")).digest("base64url"), state.authUrl.searchParams.get("code_challenge"));
        if (exchangeFailure) return json({ error: "invalid_grant" }, 400);
        const idToken = await new SignJWT({
          nonce: badNonce ? "wrong-nonce" : state.authUrl.searchParams.get("nonce"), email: "test@example.com",
        }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://auth.openai.com")
          .setAudience(badAudience ? "wrong-client" : "oaiapp_xiaoba-test").setSubject(subject)
          .setIssuedAt().setExpirationTime("1h").sign(privateKey);
        return json({ id_token: idToken, access_token: "access-test-secret", refresh_token: "refresh-test-secret",
          scope: badScope ? "openid email profile" : "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 });
      }
      if (url.endsWith("/models")) return json({ models: [
        { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      ] });
      if (url.endsWith("/responses")) {
        assert.equal(options.redirect, "error");
        const events = [{ type: "response.output_text.delta", delta: "你好，小明。" }];
        if (state.failure) events.push({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } });
        else if (state.completed) events.push({ type: "response.completed", response: { status: "completed" } });
        const raw = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
        return new Response(new ReadableStream({ start(c) {
          // Split UTF-8 and CRLF boundaries to exercise the real streaming parser.
          for (let n = 0; n < raw.length; n += 7) c.enqueue(raw.subarray(n, n + 7));
          c.close();
        } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.endsWith("/.well-known/openid-configuration")) return json({ revocation_endpoint: "https://auth.openai.com/revoke" });
      if (url.endsWith("/revoke")) return new Response("", { status: 200 });
      throw Error("Unexpected endpoint: " + url);
    },
  });
  t.after(() => { client.stop(); client.cancelSignIn(); });
  return { client, store, state, dir };
}
test("ChatGPT OAuth validates state, PKCE and signed identity; saves encrypted credentials and discovers account models", async (t) => {
  const { client, store, state, dir } = await fixture(t);
  const result = await client.signIn();
  assert.equal(result.canChat, true);
  assert.equal(result.email, "test@example.com");
  assert.deepEqual(result.models.map((m) => m.slug), ["gpt-test"]);
  assert.equal(state.authUrl.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(state.authUrl.searchParams.get("agent_name_hint"), "小八");
  assert.match(state.authUrl.searchParams.get("ext_agent_host_id"), /^urn:uuid:/);
  assert.equal(store.key, "api-test-secret");
  const saved = fs.readFileSync(path.join(dir, "chatgpt-account.json"), "utf8");
  assert.ok(!saved.includes("access-test-secret") && !saved.includes("refresh-test-secret"));
  assert.ok(!JSON.stringify(client.public()).includes("secret"));
  const resumed = new ChatGPT({ store, encryption, openExternal: () => {} });
  assert.equal(resumed.public().canChat, true);
  assert.equal(resumed.data.hostId, client.data.hostId);
  await client.signIn();
  assert.equal(state.authUrl.searchParams.get("client_id"), "oaiapp_xiaoba-test");
  assert.equal(state.authUrl.searchParams.has("agent_name_hint"), false);
  assert.equal(state.authUrl.searchParams.has("id_token_hint"), true);
});
test("invalid signed identity nonce or audience never grants chat access", async (t) => {
  for (const options of [{ badNonce: true }, { badAudience: true }]) {
    const { client } = await fixture(t, options);
    await assert.rejects(client.signIn());
    assert.equal(client.public().canChat, false);
    assert.equal(client.credentials(), null);
  }
});
test("denied OAuth and identity-only login cannot invoke inference", async (t) => {
  const denied = await fixture(t, { denied: true });
  await assert.rejects(denied.client.signIn());
  assert.ok(!denied.state.requests.some((r) => r.url.endsWith("/oauth/token")));
  const identityOnly = await fixture(t, { badScope: true });
  const account = await identityOnly.client.signIn();
  assert.equal(account.connected, true);
  assert.equal(account.canChat, false);
  await assert.rejects(identityOnly.client.chat({}, []), /授权/);
});
test("GPT harness forwards persona, memory and session context; requires terminal completion and handles late quota failure", async (t) => {
  const { client, store, state } = await fixture(t);
  await client.signIn();
  await store.save({ ...store.public(), provider: "chatgpt", gptModel: "gpt-test" });
  store.append("user", "我叫小明");
  store.append("assistant", "你好，小明");
  store.append("user", "我叫什么？");
  assert.equal(await client.chat(store.data, store.history()), "你好，小明。");
  const request = JSON.parse(state.requests.find((r) => r.url.endsWith("/responses")).options.body);
  assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.equal(request.input.length, 3);
  assert.match(request.instructions, /用户叫小明/);
  assert.ok(!("previous_response_id" in request) && !("temperature" in request));
  state.completed = false;
  await assert.rejects(client.chat(store.data, store.history()), /中断/);
  state.failure = true;
  await assert.rejects(client.chat(store.data, store.history()), /额度已到上限/);
  store.newChat();
  store.append("user", "你好");
  state.completed = true; state.failure = false;
  await client.chat(store.data, store.history());
  const last = state.requests.filter((r) => r.url.endsWith("/responses")).at(-1);
  assert.equal(JSON.parse(last.options.body).input.length, 1);
});
test("token renewal is serialized and rotated credentials persist; signout revokes and preserves API key", async (t) => {
  const { client, store, state } = await fixture(t);
  await client.signIn();
  await client.saveCredentials({ ...client.credentials(), expiresAt: 0 });
  await Promise.all([client.accessToken(), client.accessToken()]);
  assert.equal(state.refreshes, 1);
  assert.equal(client.credentials().refresh_token, "rotated-test-secret");
  assert.equal(client.credentials().scopes.includes("chatgpt.tokens.use.direct"), true);
  await client.signOut();
  assert.equal(client.public().connected, false);
  assert.equal(store.key, "api-test-secret");
  assert.equal(new URLSearchParams(state.requests.find((r) => r.url.endsWith("/revoke")).options.body).get("token"), "rotated-test-secret");
  assert.equal(client.data.clientId, "oaiapp_xiaoba-test");
});
test("cancelled browser login closes callback listener and saves no tokens", async (t) => {
  const { client, state } = await fixture(t);
  client.openExternal = async (url) => {
    state.authUrl = new URL(url);
    setImmediate(() => client.cancelSignIn());
  };
  await assert.rejects(client.signIn(), /取消/);
  assert.equal(client.signingIn, false);
  assert.equal(client.credentials(), null);
  await assert.rejects(fetch(state.authUrl.searchParams.get("redirect_uri")));
});

const asyncEncryption = {
  isEncryptionAvailable: () => false,
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => { throw Error("Linux-only method must not run on Mac"); },
  encryptStringAsync: async (text) => Buffer.from("async:" + Buffer.from(text).toString("base64")),
  decryptStringAsync: async (bytes) => ({ result: Buffer.from(bytes.toString().slice(6), "base64").toString(), shouldReEncrypt: false }),
  decryptString: () => { throw Error("Legacy synchronous storage unavailable"); },
};
test("Mac async keychain login succeeds while synchronous storage is unavailable and survives restart", { skip: process.platform !== "darwin" }, async (t) => {
  const { client, store, dir } = await fixture(t, { storage: asyncEncryption });
  const result = await client.signIn();
  assert.equal(result.connected, true);
  assert.equal(result.canChat, true);
  const saved = fs.readFileSync(path.join(dir, "chatgpt-account.json"), "utf8");
  assert.ok(!saved.includes("access-test-secret") && !saved.includes("refresh-test-secret"));
  assert.equal(JSON.parse(saved).secretFormat, "async-v1");
  const resumed = new ChatGPT({ store, encryption: asyncEncryption, openExternal: () => {} });
  await resumed.initialize();
  assert.equal(resumed.public().connected, true);
  assert.equal(resumed.public().canChat, true);
});
test("unavailable secure storage stops before opening the authorization browser", async (t) => {
  const { client, state } = await fixture(t, { storage: { ...encryption, isEncryptionAvailable: () => false } });
  await assert.rejects(client.signIn(), /钥匙串|安全存储/);
  assert.equal(state.authUrl, null);
  assert.equal(client.public().connected, false);
});
test("failed async encrypted readback never reports successful login or persists tokens", { skip: process.platform !== "darwin" }, async (t) => {
  const storage = { ...asyncEncryption, decryptStringAsync: async () => { throw Error("Keychain denied"); } };
  const { client, dir } = await fixture(t, { storage });
  await assert.rejects(client.signIn(), /钥匙串/);
  assert.equal(client.public().connected, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "chatgpt-account.json"))).secret, undefined);
});

async function legacyAccount(client) {
  await client.saveCredentials({ access_token: "old-access", refresh_token: "old-refresh", id_token: "old-id-token", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600000 }, {
    clientId: "oaiapp_old-brand", subject: "verified-subject", email: "test@example.com", agentName: undefined,
  });
}
test("legacy app registration upgrades to 小八 once and then reuses the new registration", async (t) => {
  const { client, state, store } = await fixture(t, { subject: "new-registration-subject" });
  await legacyAccount(client);
  const hostId = client.data.hostId;
  assert.equal(client.public().needsNameUpdate, true);
  const result = await client.signIn();
  assert.equal(state.authUrl.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(state.authUrl.searchParams.get("agent_name_hint"), "小八");
  assert.equal(state.authUrl.searchParams.has("id_token_hint"), false);
  assert.equal(client.data.agentName, "小八");
  assert.equal(client.data.subject, "new-registration-subject");
  assert.equal(client.data.clientId, "oaiapp_xiaoba-test");
  assert.equal(client.data.hostId, hostId);
  assert.equal(result.needsNameUpdate, false);
  assert.equal(store.key, "api-test-secret");
  await client.signIn();
  assert.equal(state.authUrl.searchParams.get("client_id"), "oaiapp_xiaoba-test");
  assert.equal(state.authUrl.searchParams.has("agent_name_hint"), false);
  assert.equal(state.authUrl.searchParams.has("id_token_hint"), true);
});
test("cancelled name upgrade preserves the active account and credentials", async (t) => {
  const { client } = await fixture(t, { denied: true });
  await legacyAccount(client);
  await assert.rejects(client.signIn());
  assert.equal(client.data.clientId, "oaiapp_old-brand");
  assert.equal(client.credentials().access_token, "old-access");
  assert.equal(client.public().canChat, true);
});
test("expired code during name upgrade retains a separate registration without mixing active tokens", async (t) => {
  const { client, state } = await fixture(t, { exchangeFailure: true });
  await legacyAccount(client);
  await assert.rejects(client.signIn(), /重新登录/);
  assert.equal(client.data.clientId, "oaiapp_old-brand");
  assert.equal(client.credentials().refresh_token, "old-refresh");
  assert.equal(client.data.pendingRegistration.clientId, "oaiapp_xiaoba-test");
  await assert.rejects(client.signIn(), /重新登录/);
  assert.equal(state.authUrl.searchParams.get("client_id"), "oaiapp_xiaoba-test");
  assert.equal(state.authUrl.searchParams.has("agent_name_hint"), false);
  assert.equal(state.authUrl.searchParams.has("id_token_hint"), false);
  assert.equal(client.credentials().access_token, "old-access");
});

test("returning authorization on the same client still rejects a different signed account identity", async (t) => {
  const { client } = await fixture(t);
  await client.signIn();
  await client.saveCredentials(client.credentials(), { subject: "original-account-subject" });
  const secret = client.data.secret;
  await assert.rejects(client.signIn(), /账号与原账号不一致/);
  assert.equal(client.data.subject, "original-account-subject");
  assert.equal(client.data.secret, secret);
  assert.equal(client.public().canChat, true);
});
test("resumed renamed registration establishes its own identity instead of comparing the legacy subject", async (t) => {
  const { client, state } = await fixture(t, { subject: "new-registration-subject" });
  await legacyAccount(client);
  client.data.pendingRegistration = { clientId: "oaiapp_xiaoba-test", agentName: "小八" };
  const result = await client.signIn();
  assert.equal(state.authUrl.searchParams.get("client_id"), "oaiapp_xiaoba-test");
  assert.equal(state.authUrl.searchParams.has("id_token_hint"), false);
  assert.equal(result.canChat, true);
  assert.equal(result.needsNameUpdate, false);
  assert.equal(client.data.subject, "new-registration-subject");
});
