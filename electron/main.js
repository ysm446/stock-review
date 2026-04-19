const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
const STOCK_MASTER_FILE = path.join(DATA_DIR, "stock_master.json");
const PRICE_FETCHER = path.join(__dirname, "..", "backend", "fetch_prices.py");
const PORTFOLIO_STORE = path.join(__dirname, "..", "backend", "portfolio_store.py");
const REVIEW_FETCHER = path.join(__dirname, "..", "backend", "fetch_review.py");
const DIVIDEND_FETCHER = path.join(__dirname, "..", "backend", "fetch_dividends.py");
const SECTOR_FETCHER = path.join(__dirname, "..", "backend", "fetch_sectors.py");

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

function ensureStockMasterFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STOCK_MASTER_FILE)) {
    const seed = {
      "285A.T": "キオクシアホールディングス",
      "4062.T": "イビデン",
      "5803.T": "フジクラ",
      "6857.T": "アドバンテスト",
      "7203.T": "トヨタ自動車",
      "8058.T": "三菱商事",
      "AAPL": "Apple",
      "MSFT": "Microsoft",
      "NVDA": "NVIDIA"
    };
    fs.writeFileSync(STOCK_MASTER_FILE, JSON.stringify(seed, null, 2), "utf8");
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

function readStockMaster() {
  ensureStockMasterFile();
  return JSON.parse(fs.readFileSync(STOCK_MASTER_FILE, "utf8"));
}

function runPortfolioStore(command, payload = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [PORTFOLIO_STORE, command], {
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
        reject(new Error(stderr.trim() || `Portfolio store exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON from portfolio store: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
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

function runReviewFetcher(ticker) {
  return new Promise((resolve, reject) => {
    const normalizedTicker = String(ticker || "").trim();
    if (!normalizedTicker) {
      reject(new Error("Ticker is required"));
      return;
    }

    const child = spawn("python", [REVIEW_FETCHER, normalizedTicker], {
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
        reject(new Error(stderr.trim() || `Review fetcher exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON from review fetcher: ${error.message}`));
      }
    });
  });
}

function runDividendFetcher(holdings) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [DIVIDEND_FETCHER], {
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
        reject(new Error(stderr.trim() || `Dividend fetcher exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON from dividend fetcher: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify({ holdings }));
    child.stdin.end();
  });
}

function runSectorFetcher(tickers) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [SECTOR_FETCHER], {
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
        reject(new Error(stderr.trim() || `Sector fetcher exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON from sector fetcher: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify({ tickers }));
    child.stdin.end();
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
  ensureStockMasterFile();
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

ipcMain.handle("portfolio:load", async () => {
  const portfolio = readPortfolio();
  const history = await runPortfolioStore("history", { holdings: portfolio.holdings || [] });
  return {
    ...portfolio,
    trendHistory: Array.isArray(history?.trendHistory) ? history.trendHistory : []
  };
});
ipcMain.handle("portfolio:save", async (_event, payload) => {
  writePortfolio(payload);
  return { ok: true };
});
ipcMain.handle("portfolio:refresh-prices", async (_event, tickers) => runPortfolioStore("refresh", { tickers }));
ipcMain.handle("portfolio:trend-history", async (_event, holdings) => runPortfolioStore("history", { holdings }));
ipcMain.handle("portfolio:dividend-summary", async (_event, holdings) => runDividendFetcher(holdings));
ipcMain.handle("portfolio:sectors", async (_event, tickers) => runSectorFetcher(tickers));
ipcMain.handle("stock-master:load", async () => readStockMaster());
ipcMain.handle("review:fetch", async (_event, ticker) => runReviewFetcher(ticker));
