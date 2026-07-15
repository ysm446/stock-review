const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stockReviewApi", {
  loadPortfolio: () => ipcRenderer.invoke("portfolio:load"),
  savePortfolio: (payload) => ipcRenderer.invoke("portfolio:save", payload),
  refreshPrices: (tickers) => ipcRenderer.invoke("portfolio:refresh-prices", tickers),
  loadTrendHistory: (holdings) => ipcRenderer.invoke("portfolio:trend-history", holdings),
  loadDividendSummary: (holdings) => ipcRenderer.invoke("portfolio:dividend-summary", holdings),
  loadHoldingSectors: (tickers) => ipcRenderer.invoke("portfolio:sectors", tickers),
  loadStockMaster: () => ipcRenderer.invoke("stock-master:load"),
  loadCachedReview: (ticker) => ipcRenderer.invoke("review:load-cache", ticker),
  fetchReview: (ticker) => ipcRenderer.invoke("review:fetch", ticker),
  refreshReviewPriceHistory: (ticker) => ipcRenderer.invoke("review:refresh-price-history", ticker),
  loadAnnotations: () => ipcRenderer.invoke("annotations:load"),
  saveAnnotations: (data) => ipcRenderer.invoke("annotations:save", data),
  getChatApiToken: () => ipcRenderer.invoke("chat:api-token"),
  getDataDir: () => ipcRenderer.invoke("data-dir:get"),
  chooseDataDir: () => ipcRenderer.invoke("data-dir:choose"),
  openDataDir: () => ipcRenderer.invoke("data-dir:open"),
  enterMainApp: () => ipcRenderer.invoke("app:enter-main")
});
