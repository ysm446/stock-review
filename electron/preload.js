const { contextBridge } = require("electron");

const HOST = process.env.STOCK_REVIEW_HOST || "127.0.0.1";
const PORT = process.env.STOCK_REVIEW_PORT || "8000";

contextBridge.exposeInMainWorld("electronAPI", {
  apiBase: `http://${HOST}:${PORT}`,
});
