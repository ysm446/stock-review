const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stockReviewApi", {
  loadPortfolio: () => ipcRenderer.invoke("portfolio:load"),
  savePortfolio: (payload) => ipcRenderer.invoke("portfolio:save", payload),
  refreshPrices: (tickers) => ipcRenderer.invoke("portfolio:refresh-prices", tickers),
  loadTrendHistory: (holdings) => ipcRenderer.invoke("portfolio:trend-history", holdings),
  loadStockMaster: () => ipcRenderer.invoke("stock-master:load")
});
