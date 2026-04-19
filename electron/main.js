const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PORTFOLIO_FILE)) {
    const seed = {
      holdings: [
        { ticker: "AAPL", shares: 20, price: 212.35, note: "長期保有" },
        { ticker: "NVDA", shares: 8, price: 903.2, note: "AI関連の主力" },
        { ticker: "7203.T", shares: 100, price: 2841, note: "配当狙い" }
      ],
      watchlist: [
        {
          ticker: "MSFT",
          rating: "A",
          thesis: "クラウドとAIの両軸で安定成長",
          risk: "高バリュエーション"
        }
      ]
    };
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(seed, null, 2), "utf8");
  }
}

function readPortfolio() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
}

function writePortfolio(payload) {
  ensureDataFile();
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#07111f",
    title: "Stock Review",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "..", "src", "index.html"));
}

app.whenReady().then(() => {
  ensureDataFile();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("portfolio:load", async () => readPortfolio());
ipcMain.handle("portfolio:save", async (_event, payload) => {
  writePortfolio(payload);
  return { ok: true };
});
