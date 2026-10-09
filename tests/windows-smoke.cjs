// Run with the installed Windows Electron executable in ELECTRON_RUN_AS_NODE mode.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executable = process.argv[2];
const output = process.argv[3];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-win-check-"));
let app, socket;
const pending = new Map();
let id = 0;
const requests = [];
const service = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    requests.push(JSON.parse(raw));
    const text = requests.length === 1 ? "你好，小明。我是小八。" : "我记得你叫小明。";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "test-message", role: "assistant", content: [], model: requests.at(-1).model, usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
      { type: "message_stop" },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
function command(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Timed out: ${method}`)); }, 90000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await delay(250);
  }
  const detail = await evaluate('document.getElementById("error").textContent');
  throw Error(`UI condition timed out: ${expression}; ${detail}`);
}
async function launch() {
  const env = { ...process.env, XIAOBA_TEST_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(executable, ["--remote-debugging-port=19226", "--remote-debugging-address=127.0.0.1"], { env, stdio: "ignore" });
  const end = Date.now() + 45000;
  let target;
  while (Date.now() < end) {
    try {
      const pages = await (await fetch("http://127.0.0.1:19226/json/list")).json();
      target = pages.find((page) => page.type === "page" && page.url.includes("index.html"));
      if (target) break;
    } catch { /* Wait for the installed app to start. */ }
    await delay(250);
  }
  if (!target) throw Error("Installed app did not create its chat window");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data), waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    message.error ? waiter.reject(Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  };
  await until('!!window.xiaoba && document.getElementById("provider")?.value === "api"');
}
async function closeApp() {
  socket?.close();
  if (app?.pid) {
    try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  await delay(500);
}
(async () => {
  assert.equal(process.platform, "win32");
  fs.mkdirSync(output, { recursive: true });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${service.address().port}`;
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ provider: "api", sessionId: crypto.randomUUID(), persona: "你叫小光，是桌面伙伴。", memory: "我叫小明。" }));
  await launch();
  const migrated = await evaluate("window.xiaoba.init()");
  assert.equal(migrated.settings.persona, "你叫小八，是桌面伙伴。");
  assert.equal(await evaluate('document.querySelector(".brand strong").textContent'), "小八");
  assert.equal(await evaluate('document.getElementById("panel").clientHeight'), 481);
  assert.equal(await evaluate('document.querySelectorAll(".header-actions button").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("#api-settings input").length'), 1);
  assert.equal(await evaluate('!!document.getElementById("read") || !!document.getElementById("collapse")'), false);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("stop")).color'), "rgb(92, 155, 213)");
  assert.equal(await evaluate('getComputedStyle(document.getElementById("save-note")).color'), "rgb(92, 155, 213)");
  await evaluate('document.getElementById("pet-toggle").focus()');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("pet-toggle")).outlineStyle'), "none");
  await evaluate('document.getElementById("pet-toggle").click()');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("compact")'), true);
  await evaluate('document.getElementById("pet-toggle").click()');
  const settings = await evaluate(`window.xiaoba.saveSettings(${JSON.stringify({ provider: "api", apiKey: "smoke-test-key", baseUrl, model: "deepseek-v4-flash", persona: "你叫小八，用中文回答。", memory: "我叫小明。" })})`);
  assert.equal(settings.hasKey, true);
  assert.equal(settings.secret, undefined);
  assert.ok(!fs.readFileSync(path.join(home, "settings.json"), "utf8").includes("smoke-test-key"));
  await command("Page.reload");
  await until('(document.getElementById("connection")?.textContent || "").includes("已配置")');
  await evaluate('document.getElementById("settings").click(); document.getElementById("settings-view").requestSubmit()');
  await until('document.getElementById("settings-view").hidden');
  await evaluate('document.getElementById("message").value="你好"; document.getElementById("composer").requestSubmit()');
  await until('[...document.querySelectorAll(".bubble.assistant")].some(n => n.textContent.includes("你好，小明。我是小八。"))');
  assert.equal(await evaluate('document.querySelector(".bubble.user .speaker")'), null);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".bubble.user")).textAlign'), "center");
  assert.ok(requests.length >= 1);
  assert.ok(JSON.stringify(requests[0]).includes("我叫小明"));
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(output, "windows-chat.png"), Buffer.from(screenshot.data, "base64"));
  await closeApp();
  await launch();
  const resumed = await evaluate("window.xiaoba.init()");
  assert.equal(resumed.settings.hasKey, true);
  assert.ok(resumed.history.some((message) => message.text.includes("你好，小明")));
  await until('(document.getElementById("connection")?.textContent || "").includes("已配置")');
  await evaluate('document.getElementById("message").value="我叫什么？"; document.getElementById("composer").requestSubmit()');
  await until('[...document.querySelectorAll(".bubble.assistant")].some(n => n.textContent.includes("我记得你叫小明。"))');
  assert.ok(requests.length >= 2);
  assert.ok(JSON.stringify(requests.at(-1)).includes("你好"));
  const report = { version: "0.1.6", platform: process.platform, runtimeArch: process.arch, checks: ["installed app startup", "legacy persona automatically renamed to 小八", "small blue character UI", "only API key field", "blue stop and save messages", "character click without outline", "DPAPI encrypted save and restart restore", "packaged Windows Harness mock API reply", "user bubble without speaker label", "conversation and Harness context restored after restart"] };
  fs.writeFileSync(path.join(output, "windows-check.json"), JSON.stringify(report, null, 2));
  console.log("PASS: " + report.checks.join(", "));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await closeApp();
  await new Promise((resolve) => service.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});
