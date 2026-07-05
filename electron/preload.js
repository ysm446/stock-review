const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stockReviewApi", {
  loadPortfolio: () => ipcRenderer.invoke("portfolio:load"),
  savePortfolio: (payload) => ipcRenderer.invoke("portfolio:save", payload),
  exportPortfolio: () => ipcRenderer.invoke("portfolio:export"),
  importPortfolio: () => ipcRenderer.invoke("portfolio:import"),
  refreshPrices: (tickers) => ipcRenderer.invoke("portfolio:refresh-prices", tickers),
  loadTrendHistory: (holdings) => ipcRenderer.invoke("portfolio:trend-history", holdings),
  loadDividendSummary: (holdings) => ipcRenderer.invoke("portfolio:dividend-summary", holdings),
  loadHoldingSectors: (tickers) => ipcRenderer.invoke("portfolio:sectors", tickers),
  loadStockMaster: () => ipcRenderer.invoke("stock-master:load"),
  fetchReview: (ticker) => ipcRenderer.invoke("review:fetch", ticker),
  loadAnnotations: () => ipcRenderer.invoke("annotations:load"),
  saveAnnotations: (data) => ipcRenderer.invoke("annotations:save", data),
  getChatApiToken: () => ipcRenderer.invoke("chat:api-token")
});
