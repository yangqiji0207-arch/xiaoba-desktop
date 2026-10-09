const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  dialog,
  shell,
  net,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Store } = require("./store.cjs");
const { Harness } = require("./harness.cjs");
const { ChatGPT } = require("./chatgpt.cjs");
const { unpackedPath } = require("./paths.cjs");
let win,
  tray,
  store,
  harness,
  chatgpt,
  busy = false,
  quitting = false,
  regions = [],
  ignoring = false,
  hitTimer,
  dragging = null;
app.setName("小八");
app.setPath(
  "userData",
  process.env.XIAOBA_TEST_HOME || path.join(app.getPath("appData"), "Ha" + "lo"),
);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      store = new Store(app.getPath("userData"), safeStorage);
      await store.initialize();
      chatgpt = new ChatGPT({
        store, encryption: safeStorage,
        openExternal: (url) => shell.openExternal(url),
        fetchImpl: (url, options) => net.fetch(url, options),
      });
      await chatgpt.initialize();
      const publicSettings = () => ({ ...store.public(), chatgpt: chatgpt.public() });
      const assertIdle = () => {
        if (busy) throw Error("请先停止当前对话。");
        if (chatgpt.signingIn) throw Error("请先完成或取消 ChatGPT 登录。");
      };
      let bin = require.resolve("@deepseek-ai/dsh/lib/bin.js");
      if (app.isPackaged) bin = unpackedPath(bin);
      let patch = path.join(__dirname, "../harness/companion.patch.yml");
      if (app.isPackaged)
        patch = unpackedPath(patch);
      harness = new Harness({
        home: path.join(app.getPath("userData"), "harness"),
        bin,
        patch,
      });
      const area = screen.getPrimaryDisplay().workArea;
      const width = 390,
        height = 611;
      win = new BrowserWindow({
        width,
        height,
        x: area.x + area.width - width - 28,
        y: area.y + Math.max(0, area.height - height - 24),
        transparent: true,
        frame: false,
        resizable: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: "#00000000",
        icon: path.join(__dirname, "../renderer/xiaoba-icon.png"),
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: false,
        },
      });
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.loadFile(path.join(__dirname, "../renderer/index.html"));
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      win.webContents.session.setPermissionRequestHandler((_, __, cb) =>
        cb(false),
      );
      win.on("close", (e) => {
        if (!quitting) {
          e.preventDefault();
          win.hide();
        }
      });
      const icon = nativeImage.createFromPath(
        path.join(__dirname, "../renderer/tray.png"),
      );
      const trayIcon = icon.resize({ width: 18, height: 18 });
      trayIcon.setTemplateImage(false);
      tray = new Tray(trayIcon);
      tray.setToolTip("小八");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "显示小八", click: () => win.show() },
          { label: "隐藏", click: () => win.hide() },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
        ]),
      );
      tray.on("click", () => (win.isVisible() ? win.hide() : win.show()));
      app.dock?.hide();
      const trusted = (e) => {
        if (e.sender !== win.webContents) throw Error("无效的窗口请求");
      };
      // Only the visible panel and character controls intercept desktop clicks.
      ipcMain.on("xiaoba:regions", (e, value) => {
        trusted(e);
        if (Array.isArray(value))
          regions = value
            .slice(0, 8)
            .filter(
              (r) =>
                r &&
                ["x", "y", "width", "height"].every((k) =>
                  Number.isFinite(r[k]),
                ) &&
                r.width > 0 &&
                r.height > 0,
            );
      });
      hitTimer = setInterval(() => {
        if (!win || win.isDestroyed() || !win.isVisible() || !regions.length || dragging)
          return;
        const p = screen.getCursorScreenPoint(),
          b = win.getBounds();
        const outside = !regions.some(
          (r) =>
            p.x >= b.x + r.x &&
            p.x <= b.x + r.x + r.width &&
            p.y >= b.y + r.y &&
            p.y <= b.y + r.y + r.height,
        );
        if (outside !== ignoring) {
          ignoring = outside;
          win.setIgnoreMouseEvents(outside, { forward: true });
        }
      }, 120);
      ipcMain.handle("xiaoba:init", (e) => {
        trusted(e);
        return {
          settings: publicSettings(),
          history: store.history(),
          version: app.getVersion(),
        };
      });
      ipcMain.handle("xiaoba:settings", async (e, value) => {
        trusted(e);
        assertIdle();
        const oldProvider = store.data.provider;
        await store.save(value);
        await harness.stop();
        const chatReset = oldProvider !== store.data.provider;
        if (chatReset) store.newChat();
        return { ...publicSettings(), chatReset };
      });
      ipcMain.handle("xiaoba:gpt-signin", async (e) => {
        trusted(e);
        assertIdle();
        try {
          const account = await chatgpt.signIn();
          win.show(); win.focus();
          return account;
        } catch (error) { throw Error(chatgpt.safeError(error)); }
      });
      ipcMain.handle("xiaoba:gpt-cancel", (e) => {
        trusted(e);
        chatgpt.cancelSignIn();
        return true;
      });
      ipcMain.handle("xiaoba:gpt-models", async (e) => {
        trusted(e); assertIdle();
        try { return await chatgpt.listModels(); }
        catch (error) { throw Error(chatgpt.safeError(error)); }
      });
      ipcMain.handle("xiaoba:gpt-signout", async (e) => {
        trusted(e); assertIdle();
        return chatgpt.signOut();
      });
      ipcMain.handle("xiaoba:gpt-usage", (e) => {
        trusted(e);
        return shell.openExternal("https://chatgpt.com/#settings/Usage");
      });
      ipcMain.handle("xiaoba:new", async (e) => {
        trusted(e);
        assertIdle();
        await harness.stop();
        store.newChat();
        return true;
      });
      ipcMain.handle("xiaoba:send", async (e, text) => {
        trusted(e);
        if (busy) throw Error("正在回复中。");
        if (typeof text !== "string" || !text.trim() || text.length > 12000)
          throw Error("请输入 1–12000 字的消息。");
        if (store.data.provider === "chatgpt") {
          if (!chatgpt.public().canChat) throw Error("请先在设置里登录 ChatGPT 并授权套餐问答。");
          if (!store.data.gptModel) throw Error("请先在设置里选择 ChatGPT 模型并保存。");
        } else if (!store.key) throw Error("请先在设置里保存你的模型密钥。");
        busy = true;
        state("thinking");
        store.append("user", text.trim());
        try {
          let reply;
          if (store.data.provider === "chatgpt") {
            reply = await chatgpt.chat(store.data, store.history());
          } else {
            await harness.start(store.data, store.key);
            reply = await harness.chat(store.data.sessionId, text.trim());
          }
          store.append("assistant", reply);
          state("talking");
          return reply;
        } catch (error) {
          state("error");
          const message = chatgpt.safeError(error);
          throw Error(store.key ? message.replaceAll(store.key, "[已隐藏]") : message);
        } finally {
          busy = false;
        }
      });
      ipcMain.handle("xiaoba:cancel", async (e) => {
        trusted(e);
        chatgpt.stop();
        await harness.stop();
        state("idle");
        return true;
      });
      ipcMain.on("xiaoba:panel", (e, open) => {
        trusted(e);
        const b = win.getBounds();
        const h = open ? 611 : 128;
        const a = screen.getDisplayMatching(b).workArea;
        win.setBounds({
          x: b.x,
          y: Math.max(a.y, Math.min(b.y + b.height - h, a.y + a.height - h)),
          width: 390,
          height: h,
        });
      });
      ipcMain.on("xiaoba:move", (e, value) => {
        trusted(e);
        if (value?.phase === "end") { dragging = null; return; }
        if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
        if (value.phase === "start") {
          dragging = { x: value.x, y: value.y, bounds: win.getBounds() };
          ignoring = false;
          win.setIgnoreMouseEvents(false);
        } else if (value.phase === "update" && dragging) {
          const b = dragging.bounds;
          const next = { x: Math.round(b.x + value.x - dragging.x), y: Math.round(b.y + value.y - dragging.y), width: b.width, height: b.height };
          const area = screen.getDisplayMatching(next).workArea;
          win.setPosition(Math.max(area.x, Math.min(next.x, area.x + area.width - b.width)), Math.max(area.y, Math.min(next.y, area.y + area.height - b.height)));
        }
      });
      ipcMain.on("xiaoba:hide", (e) => {
        trusted(e);
        win.hide();
      });
      ipcMain.on("xiaoba:quit", (e) => {
        trusted(e);
        app.quit();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("小八启动失败", String(error.message));
      app.quit();
    });
  app.on("before-quit", (e) => {
    if (!quitting) {
      e.preventDefault();
      quitting = true;
      clearInterval(hitTimer);
      chatgpt?.cancelSignIn();
      chatgpt?.stop();
      Promise.resolve(harness?.stop()).finally(() => app.quit());
    }
  });
  app.on("window-all-closed", () => {});
}
function state(value) {
  if (win && !win.isDestroyed()) win.webContents.send("xiaoba:state", value);
}
