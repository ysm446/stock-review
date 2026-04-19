const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stockReviewApi", {
  loadPortfolio: () => ipcRenderer.invoke("portfolio:load"),
  savePortfolio: (payload) => ipcRenderer.invoke("portfolio:save", payload),
  refreshPrices: (tickers) => ipcRenderer.invoke("portfolio:refresh-prices", tickers),
  loadTrendHistory: (holdings) => ipcRenderer.invoke("portfolio:trend-history", holdings),
  loadDividendSummary: (holdings) => ipcRenderer.invoke("portfolio:dividend-summary", holdings),
  loadHoldingSectors: (tickers) => ipcRenderer.invoke("portfolio:sectors", tickers),
  loadStockMaster: () => ipcRenderer.invoke("stock-master:load"),
  fetchReview: (ticker) => ipcRenderer.invoke("review:fetch", ticker)
});
