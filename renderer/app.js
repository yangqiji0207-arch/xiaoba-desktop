const $ = (id) => document.getElementById(id);
const api = window.xiaoba;
let config = {},
  busy = false,
  compact = false,
  gptBusy = false,
  talkTimer;
function reportRegions() {
  api?.regions?.(
    ["#panel", ".pet-drag"].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}
new ResizeObserver(reportRegions).observe($("app"));
window.addEventListener("resize", reportRegions);
function state(value) {
  $("app").dataset.state = value;
  clearTimeout(talkTimer);
  if (value === "talking") talkTimer = setTimeout(() => state("idle"), 5000);
}
function bubble(role, text) {
  const welcome = document.querySelector(".welcome");
  if (welcome) welcome.remove();
  const node = document.createElement("div");
  node.className = "bubble " + role;
  if (role !== "user") {
    const label = document.createElement("span");
    label.className = "speaker";
    label.textContent = "小八";
    node.append(label);
  }
  node.append(document.createTextNode(text));
  $("messages").append(node);
  $("messages").scrollTop = $("messages").scrollHeight;
  return node;
}
function error(e) {
  $("error").hidden = false;
  $("error").textContent = String(e.message || e).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}
function setBusy(value) {
  busy = value;
  $("send").hidden = value;
  $("stop").hidden = !value;
  $("message").disabled = value;
  $("new").disabled = value;
  $("settings").disabled = value;
}
function fillSettings() {
  for (const k of ["persona", "memory"])
    $(k).value = config[k] || "";
  $("apiKey").value = "";
  $("apiKey").placeholder = config.hasKey
    ? "密钥已保存；留空保持不变"
    : "输入你的 API Key";
  $("provider").value = config.provider || "api";
  fillAccount();
  providerFields();
  updateConnection();
}
function updateConnection() {
  const provider = $("provider").value || config.provider;
  const account = config.chatgpt || {};
  const ready = provider === "chatgpt" ? account.canChat && config.gptModel : config.hasKey;
  $("connection").textContent = provider === "chatgpt"
    ? (ready ? "ChatGPT · 已连接" : account.connected ? "ChatGPT · 已登录，请选择模型并保存" : "ChatGPT · 请先登录并选择模型")
    : (ready ? "本机 Harness · 已配置" : "还差一步，就能聊天");
  $("dot").classList.toggle("connected", !!ready || provider === "chatgpt" && account.connected);
}
function providerFields() {
  const gpt = $("provider").value === "chatgpt";
  $("gpt-settings").hidden = !gpt;
  $("api-settings").hidden = gpt;
  updateConnection();
}
function fillAccount() {
  const account = config.chatgpt || {};
  $("gpt-account-name").textContent = account.connected
    ? `${account.email} · ${account.canChat ? "套餐问答已授权" : "套餐问答未授权"}`
    : "尚未登录 ChatGPT";
  $("gpt-signin").hidden = account.canChat && !account.needsNameUpdate;
  $("gpt-signin").textContent = "登录授权";
  for (const id of ["gpt-refresh", "gpt-usage", "gpt-signout"])
    $(id).hidden = !account.connected;
  const selected = $("gptModel").value || config.gptModel;
  $("gptModel").replaceChildren();
  for (const m of account.models || []) {
    const option = document.createElement("option");
    option.value = m.slug; option.textContent = m.display_name;
    $("gptModel").append(option);
  }
  if (!$("gptModel").options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = account.connected ? "点击刷新模型" : "登录后选择模型";
    $("gptModel").append(option);
  }
  if ([...$("gptModel").options].some((o) => o.value === selected)) $("gptModel").value = selected;
  updateConnection();
}
function resetChat() {
  $("messages").replaceChildren();
  bubble("assistant", "新的一页。我是小八，我们从哪里聊起？");
}
function setGptBusy(value, signing = false) {
  gptBusy = value;
  for (const id of ["gpt-signin", "gpt-signout", "gpt-refresh", "provider", "save-settings", "clear-key"])
    $(id).disabled = value;
  $("gpt-cancel").hidden = !(value && signing);
  $("new").disabled = value || busy;
}
function settingsError(e) {
  return String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, "");
}
$("provider").onchange = providerFields;
$("gpt-signin").onclick = async () => {
  if (gptBusy) return;
  setGptBusy(true, true);
  $("gpt-note").textContent = "请在浏览器中登录并授权，完成后回到小八。";
  try {
    config.chatgpt = await api.gptSignIn();
    fillAccount();
    $("gpt-note").textContent = config.chatgpt.note;
  } catch (e) { $("gpt-note").textContent = settingsError(e); }
  finally { setGptBusy(false); }
};
$("gpt-cancel").onclick = () => api.gptCancel().catch((e) => { $("gpt-note").textContent = settingsError(e); });
$("gpt-refresh").onclick = async () => {
  if (gptBusy) return;
  setGptBusy(true);
  $("gpt-note").textContent = "正在获取此账号的模型…";
  try {
    config.chatgpt = await api.gptModels();
    fillAccount();
    $("gpt-note").textContent = "模型已更新";
  } catch (e) { $("gpt-note").textContent = settingsError(e); }
  finally { setGptBusy(false); }
};
$("gpt-signout").onclick = async () => {
  if (gptBusy) return;
  setGptBusy(true);
  try {
    config.chatgpt = await api.gptSignOut();
    fillAccount();
    $("connection").textContent = config.provider === "chatgpt" ? "ChatGPT · 已退出" : $("connection").textContent;
    if (config.provider === "chatgpt") $("dot").classList.remove("connected");
    $("gpt-note").textContent = config.chatgpt.note;
  } catch (e) { $("gpt-note").textContent = settingsError(e); }
  finally { setGptBusy(false); }
};
$("gpt-usage").onclick = () => api.gptUsage().catch((e) => { $("gpt-note").textContent = settingsError(e); });
function showSettings(on) {
  $("settings-view").hidden = !on;
  $("chat-view").hidden = on;
  $("save-note").textContent = "";
  if (on) fillSettings();
}
function panel(on) {
  compact = !on;
  $("app").classList.toggle("compact", compact);
  $("pet-toggle").setAttribute("aria-expanded", String(on));
  $("pet-toggle").setAttribute("aria-label", on ? "收起聊天" : "打开聊天");
  api?.panel(on);
  requestAnimationFrame(reportRegions);
}
async function send(text) {
  if (busy || !text.trim()) return;
  if (config.provider === "chatgpt" ? !config.chatgpt?.canChat || !config.gptModel : !config.hasKey) {
    showSettings(true);
    return;
  }
  $("error").hidden = true;
  $("message").value = "";
  bubble("user", text);
  setBusy(true);
  state("thinking");
  const pending = document.createElement("div");
  pending.className = "pending";
  pending.textContent = "···";
  $("messages").append(pending);
  $("messages").scrollTop = $("messages").scrollHeight;
  try {
    const reply = await api.send(text);
    bubble("assistant", reply);
    state("talking");
  } catch (e) {
    error(e);
    state("error");
  } finally {
    pending.remove();
    setBusy(false);
    $("message").focus();
  }
}
$("composer").onsubmit = (e) => {
  e.preventDefault();
  send($("message").value);
};
$("message").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send($("message").value);
  }
};
$("settings").onclick = () => showSettings($("settings-view").hidden);
const petToggle = $("pet-toggle");
let dragStart = null, suppressClick = false;
petToggle.onpointerdown = (event) => {
  if (event.button !== 0) return;
  dragStart = { x: event.screenX, y: event.screenY, moved: false, id: event.pointerId };
  suppressClick = false;
  petToggle.setPointerCapture(event.pointerId);
  api?.move?.({ phase: "start", x: event.screenX, y: event.screenY });
};
petToggle.onpointermove = (event) => {
  if (!dragStart || event.pointerId !== dragStart.id) return;
  if (Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) > 5) dragStart.moved = true;
  if (dragStart.moved) api?.move?.({ phase: "update", x: event.screenX, y: event.screenY });
};
function endDrag(event) {
  if (!dragStart || event.pointerId !== dragStart.id) return;
  suppressClick = dragStart.moved || event.type === "pointercancel";
  dragStart = null;
  api?.move?.({ phase: "end" });
  if (petToggle.hasPointerCapture(event.pointerId)) petToggle.releasePointerCapture(event.pointerId);
}
petToggle.onpointerup = endDrag;
petToggle.onpointercancel = endDrag;
petToggle.onlostpointercapture = endDrag;
petToggle.onclick = () => {
  if (suppressClick) { suppressClick = false; return; }
  panel(compact);
};
$("new").onclick = async () => {
  try {
    await api.newChat();
    resetChat();
    $("error").hidden = true;
    state("idle");
  } catch (e) {
    error(e);
  }
};
$("stop").onclick = () => {
  api.cancel().catch(error);
};
$("settings-view").onsubmit = async (e) => {
  e.preventDefault();
  if (gptBusy) return;
  try {
    const value = {};
    for (const k of ["persona", "memory", "apiKey"])
      value[k] = $(k).value;
    value.model = config.model;
    value.baseUrl = config.baseUrl;
    value.provider = $("provider").value;
    value.gptModel = $("gptModel").value;
    if (value.provider === "chatgpt" && (!config.chatgpt?.canChat || !value.gptModel))
      throw Error("请先登录 ChatGPT 并选择可用模型。");
    config = await api.saveSettings(value);
    if (config.chatReset) resetChat();
    fillSettings();
    showSettings(false);
    $("error").hidden = true;
    state("idle");
  } catch (e) {
    $("save-note").textContent = String(e.message).replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
  }
};
$("clear-key").onclick = async () => {
  try {
    config = await api.saveSettings({ ...config, clearKey: true });
    fillSettings();
    $("save-note").textContent = "密钥已清除";
  } catch (e) {
    $("save-note").textContent = e.message;
  }
};
document
  .querySelectorAll("[data-prompt]")
  .forEach((b) => (b.onclick = () => send(b.dataset.prompt)));
if (api) {
  api.state(state);
  api
    .init()
    .then(({ settings, history }) => {
      config = settings;
      fillSettings();
      if (history.length) {
        $("messages").replaceChildren();
        history.forEach((m) => {
          bubble(m.role, m.text);
        });
      }
      if (config.chatgpt?.canChat) {
        api.gptModels().then((account) => {
          config.chatgpt = account;
          fillAccount();
        }).catch((e) => { $("gpt-note").textContent = settingsError(e); });
      }
    })
    .catch(error);
} else {
  config = {
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/anthropic",
    persona: "你叫小八，是住在桌面上的数字伙伴。",
    memory: "",
  };
  fillSettings();
}
