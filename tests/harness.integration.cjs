const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Harness } = require("../src/harness.cjs");
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-harness-test-"));
  const bodies = [];
  const notifications = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (x) => (raw += x));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        bodies.push(body);
        const text =
          bodies.length === 1 ? "你好，小明。我是小八。" : "我记得你叫小明。";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const events = [
          {
            type: "message_start",
            message: {
              id: "test-message",
              role: "assistant",
              content: [],
              model: body.model,
              usage: { input_tokens: 30, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 15 },
          },
          { type: "message_stop" },
        ];
        for (const event of events)
          res.write(
            "event: " +
              event.type +
              "\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          );
        res.end();
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const opts = {
    home,
    bin:
      process.env.XIAOBA_TEST_BIN ||
      require.resolve("@deepseek-ai/dsh/lib/bin.js"),
    executable: process.env.XIAOBA_TEST_EXECUTABLE || process.execPath,
    patch:
      process.env.XIAOBA_TEST_PATCH ||
      path.resolve(__dirname, "../harness/companion.patch.yml"),
  };
  const config = {
    model: "deepseek-v4-flash",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    persona: "你是小八，温暖的桌面伙伴。",
    memory: "用户喜欢简短回复。",
  };
  let h = new Harness(opts);
  h.on("event", (e) => notifications.push(e));
  try {
    await h.start(config, "test-key");
    assert.match(await h.chat("test-conversation", "我叫小明。"), /小明/);
    await h.stop();
    h = new Harness(opts);
    await h.start(config, "test-key");
    assert.match(await h.chat("test-conversation", "我叫什么？"), /小明/);
    assert.equal(bodies.length, 2);
    assert.ok(JSON.stringify(bodies[1].messages).includes("我叫小明"));
    assert.ok(JSON.stringify(bodies[1]).includes("用户喜欢简短回复"));
    assert.ok(JSON.stringify(bodies[1]).includes("温暖的桌面伙伴"));
    assert.ok(
      !bodies[0].tools?.length,
      "No shell or other tools must reach the model",
    );
    assert.ok(notifications.some((e) => e.type === "assistant/message"));
    await h.chat("separate-conversation", "这是新对话。");
    assert.ok(
      !JSON.stringify(bodies[2].messages).includes("我叫小明"),
      "New sessions must isolate previous conversation",
    );
    console.log(
      "PASS: real Harness, restart context, persona/memory, isolated new session, zero tools.",
    );
  } catch (e) {
    console.error(e);
    console.error(h.logs);
    console.error(JSON.stringify({ bodies, notifications }, null, 2));
    process.exitCode = 1;
  } finally {
    await h.stop();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})();
