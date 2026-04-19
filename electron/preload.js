const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stockReviewApi", {
  loadPortfolio: () => ipcRenderer.invoke("portfolio:load"),
  savePortfolio: (payload) => ipcRenderer.invoke("portfolio:save", payload)
});
