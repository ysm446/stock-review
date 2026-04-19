const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
const PRICE_FETCHER = path.join(__dirname, "..", "backend", "fetch_prices.py");

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

function runPriceFetcher(tickers) {
  return new Promise((resolve, reject) => {
    const normalizedTickers = tickers
      .map((ticker) => String(ticker || "").trim())
      .filter(Boolean);

    if (!normalizedTickers.length) {
      resolve({ quotes: {}, errors: {} });
      return;
    }

    const child = spawn("python", [PRICE_FETCHER, ...normalizedTickers], {
      cwd: path.join(__dirname, ".."),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Python process failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Price fetcher exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Invalid JSON from price fetcher: ${error.message}`));
      }
    });
  });
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

  win.setMenuBarVisibility(false);
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
ipcMain.handle("portfolio:refresh-prices", async (_event, tickers) => runPriceFetcher(tickers));
