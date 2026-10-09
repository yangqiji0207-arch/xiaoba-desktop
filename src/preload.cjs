const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("xiaoba", {
  move: (value) => ipcRenderer.send("xiaoba:move", value),
  regions: (value) => ipcRenderer.send("xiaoba:regions", value),
  init: () => ipcRenderer.invoke("xiaoba:init"),
  saveSettings: (v) => ipcRenderer.invoke("xiaoba:settings", v),
  gptSignIn: () => ipcRenderer.invoke("xiaoba:gpt-signin"),
  gptCancel: () => ipcRenderer.invoke("xiaoba:gpt-cancel"),
  gptModels: () => ipcRenderer.invoke("xiaoba:gpt-models"),
  gptSignOut: () => ipcRenderer.invoke("xiaoba:gpt-signout"),
  gptUsage: () => ipcRenderer.invoke("xiaoba:gpt-usage"),
  send: (text) => ipcRenderer.invoke("xiaoba:send", text),
  cancel: () => ipcRenderer.invoke("xiaoba:cancel"),
  newChat: () => ipcRenderer.invoke("xiaoba:new"),
  panel: (open) => ipcRenderer.send("xiaoba:panel", open),
  hide: () => ipcRenderer.send("xiaoba:hide"),
  quit: () => ipcRenderer.send("xiaoba:quit"),
  state: (fn) => {
    const handler = (_, value) => fn(value);
    ipcRenderer.on("xiaoba:state", handler);
    return () => ipcRenderer.removeListener("xiaoba:state", handler);
  },
});
