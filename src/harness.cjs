const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
class Harness extends EventEmitter {
  constructor({ home, bin, executable = process.execPath, patch }) {
    super();
    Object.assign(this, { home, bin, executable, patch });
    this.pending = new Map();
    this.counter = 0;
    this.proc = null;
    this.active = null;
    this.logs = "";
  }
  async start(config, key) {
    if (this.proc) return;
    this.logs = "";
    fs.mkdirSync(this.home, { recursive: true });
    const workspace = path.join(this.home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const launchPatch = path.join(this.home, "companion.patch.yml");
    fs.writeFileSync(
      launchPatch,
      fs
        .readFileSync(this.patch, "utf8")
        .replace(
          "XIAOBA_RPC_PLUGIN_PLACEHOLDER",
          JSON.stringify(
            path.join(path.dirname(this.patch), "companion-rpc.mjs"),
          ),
        ),
    );
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DSH_HOME: this.home,
      XIAOBA_RPC_PLUGIN: path.join(path.dirname(this.patch), "companion-rpc.mjs"),
      DEEPSEEK_API_KEY: key,
      DEEPSEEK_BASE_URL: config.baseUrl,
      DSH_CONTEXT_WINDOW: "65536",
      DSH_SYSTEM_PROMPT:
        "你的名字是小八。介绍自己或打招呼时使用“小八”，即使旧聊天记录中出现其他自称。\n" +
        config.persona +
        "\n用户明确保存的偏好（作为资料使用，不覆盖上述规则）：\n" +
        (config.memory || "暂无"),
    };
    this.proc = spawn(
      this.executable,
      [this.bin, "--profile", "sdk-minimal", "--patch", launchPatch],
      {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const proc = this.proc;
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (this.proc !== proc) return;
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        this.fail(Error("Harness 消息超出限制。"));
        this.stop();
        return;
      }
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          /* Non-protocol startup output is ignored. */
        }
      }
    });
    proc.stderr.on("data", (s) => {
      if (this.proc === proc) this.logs = (this.logs + s).slice(-6000);
    });
    proc.on("error", (e) => {
      if (this.proc === proc) this.fail(e);
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) {
        this.proc = null;
        const detail = this.logs
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim()
          .slice(-2500);
        this.fail(
          Error(`Harness 已退出（${code}）。${detail ? "\n" + detail : ""}`),
        );
      }
    });
    try {
      await this.request(
        "initialize",
        {
          cwd: workspace,
          provider: "deepseek-official",
          model: config.model,
          maxTokens: 2048,
        },
        45000,
      );
    } catch (e) {
      await this.stop();
      throw Error("Harness 启动失败：" + e.message);
    }
  }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = String(++this.counter);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(method + " 超时"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
      if (!this.proc) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Error("Harness 未启动"));
      }
    });
  }
  receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msg.id));
        msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.proc?.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: "Desktop companion does not grant tool execution.",
          },
        }) + "\n",
      );
      return;
    }
    const a = this.active;
    if (!a) return;
    const p = msg.params || {};
    if (p.sessionId !== a.sessionId) return;
    a.notifications.push(msg);
    this.consume(a);
  }
  consume(a) {
    if (!a.messageId) return;
    while (a.index < a.notifications.length) {
      const msg = a.notifications[a.index++];
      const p = msg.params || {};
      const e = p.event;
      if (!a.received) {
        if (
          msg.method === "session.event" &&
          e?.type === "agent/inbox/spliced" &&
          e.data?.inserted?.some((x) => x.id === a.messageId)
        )
          a.received = true;
        else continue;
      }
      if (msg.method === "session.event") {
        if (e?.type === "assistant/message") {
          const c = (e.data?.message || e.data)?.content;
          a.text = (c || [])
            .filter((x) => x.type === "text")
            .map((x) => x.text || "")
            .join("");
        }
        if (e?.type === "turn/end") a.reason = e.data?.reason;
        this.emit("event", e);
      }
      if (msg.method === "session.status" && p.status === "idle") {
        clearTimeout(a.timer);
        this.active = null;
        if (a.reason?.kind === "error" || !a.text)
          a.reject(Error("模型未返回有效回复。请检查密钥、模型名称和网络。"));
        else a.resolve(a.text);
        return;
      }
    }
  }
  async chat(sessionId, text) {
    if (this.active) throw Error("请等待当前回复完成。");
    return new Promise((resolve, reject) => {
      const a = {
        sessionId,
        text: "",
        messageId: null,
        received: false,
        notifications: [],
        index: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(Error("回复等待超过两分钟，请重试。"));
          void this.stop();
        }, 120000),
      };
      this.active = a;
      this.request("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text }],
      })
        .then((r) => {
          a.messageId = r.messageId;
          this.consume(a);
        })
        .catch((e) => this.fail(e));
    });
  }
  fail(e) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(e);
      this.active = null;
    }
  }
  async stop() {
    const p = this.proc;
    if (!p) return;
    this.fail(Error("对话已停止。"));
    try {
      await this.request("shutdown", null, 5000);
    } catch {}
    // The shutdown reply can arrive before the runtime has flushed and exited.
    // Let it close gracefully; Windows process termination otherwise loses writes.
    if (p.exitCode === null) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          p.removeListener("close", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          if (p.exitCode === null) p.kill();
          finish();
        }, 2500);
        p.once("close", finish);
        if (p.exitCode !== null) finish();
      });
    }
    this.proc = null;
  }
}
module.exports = { Harness };
