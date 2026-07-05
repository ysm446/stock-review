const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
const PORTFOLIO_EXAMPLE_FILE = path.join(DATA_DIR, "portfolio.example.json");
const STOCK_MASTER_FILE = path.join(DATA_DIR, "stock_master.json");
const ANNOTATIONS_FILE = path.join(DATA_DIR, "annotations.json");

const FALLBACK_PORTFOLIO = {
  holdings: [],
  watchlist: []
};

const FALLBACK_STOCK_MASTER = {
  AAPL: "Apple",
  MSFT: "Microsoft",
  NVDA: "NVIDIA",
  "7203.T": "Toyota Motor"
};

function ensureDataDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const backupPath = `${filePath}.bak`;
    if (fs.existsSync(backupPath)) {
      console.warn(`Corrupted JSON at ${filePath}; restoring from backup.`);
      return JSON.parse(fs.readFileSync(backupPath, "utf8"));
    }
    throw error;
  }
}

function writeJsonFile(filePath, payload) {
  // クラッシュ時に途中書きで JSON が壊れないよう、一時ファイル + rename で置き換える。
  // 置き換え前の内容は .bak として1世代残す。
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch (error) {
      console.warn(`Failed to write backup for ${filePath}:`, error);
    }
  }
  fs.renameSync(tempPath, filePath);
}

function ensurePortfolioFile() {
  ensureDataDirectory();
  if (!fs.existsSync(PORTFOLIO_FILE)) {
    const seed = readJsonFile(PORTFOLIO_EXAMPLE_FILE, FALLBACK_PORTFOLIO);
    writeJsonFile(PORTFOLIO_FILE, seed);
  }
}

function ensureStockMasterFile() {
  ensureDataDirectory();
  if (!fs.existsSync(STOCK_MASTER_FILE)) {
    writeJsonFile(STOCK_MASTER_FILE, FALLBACK_STOCK_MASTER);
  }
}

function readPortfolio() {
  ensurePortfolioFile();
  return readJsonFile(PORTFOLIO_FILE, FALLBACK_PORTFOLIO);
}

function writePortfolio(payload) {
  ensurePortfolioFile();
  writeJsonFile(PORTFOLIO_FILE, payload);
}

function readStockMaster() {
  ensureStockMasterFile();
  return readJsonFile(STOCK_MASTER_FILE, FALLBACK_STOCK_MASTER);
}

function buildExportPayload(portfolio) {
  return {
    version: 1,
    source: "stock-review",
    exportedAt: new Date().toISOString(),
    holdings: Array.isArray(portfolio?.holdings) ? portfolio.holdings : [],
    watchlist: Array.isArray(portfolio?.watchlist) ? portfolio.watchlist : []
  };
}

function sanitizePortfolioPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Import file must be a JSON object.");
  }

  const holdings = Array.isArray(payload.holdings) ? payload.holdings : null;
  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : null;

  if (!holdings || !watchlist) {
    throw new Error("Import file must include holdings and watchlist arrays.");
  }

  return { holdings, watchlist };
}

function readAnnotations() {
  ensureDataDirectory();
  return readJsonFile(ANNOTATIONS_FILE, []);
}

function writeAnnotations(annotations) {
  ensureDataDirectory();
  writeJsonFile(ANNOTATIONS_FILE, Array.isArray(annotations) ? annotations : []);
}

function formatExportDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  DATA_DIR,
  PORTFOLIO_FILE,
  STOCK_MASTER_FILE,
  buildExportPayload,
  ensurePortfolioFile,
  ensureStockMasterFile,
  formatExportDate,
  readAnnotations,
  readPortfolio,
  readStockMaster,
  sanitizePortfolioPayload,
  writeAnnotations,
  writePortfolio
};
