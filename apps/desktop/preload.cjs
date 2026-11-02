const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  notify: (title, body) => ipcRenderer.send("notify", { title: String(title), body: String(body) }),
  openExternal: (url) => ipcRenderer.send("open-external", String(url)),
  onMenu: (callback) => ipcRenderer.on("menu", (_event, action) => callback(action)),
});
