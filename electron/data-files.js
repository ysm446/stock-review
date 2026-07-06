const fs = require("fs");
const path = require("path");

const { getDataDir } = require("./paths");

// データルートは実行中に設定変更されうるため、パスは都度 getDataDir() から解決する。
function dataDir() {
  return getDataDir();
}
function portfolioFile() {
  return path.join(dataDir(), "portfolio.json");
}
function portfolioExampleFile() {
  return path.join(dataDir(), "portfolio.example.json");
}
function stockMasterFile() {
  return path.join(dataDir(), "stock_master.json");
}
function annotationsFile() {
  return path.join(dataDir(), "annotations.json");
}

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
  fs.mkdirSync(dataDir(), { recursive: true });
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
  const file = portfolioFile();
  if (!fs.existsSync(file)) {
    const seed = readJsonFile(portfolioExampleFile(), FALLBACK_PORTFOLIO);
    writeJsonFile(file, seed);
  }
}

function ensureStockMasterFile() {
  ensureDataDirectory();
  const file = stockMasterFile();
  if (!fs.existsSync(file)) {
    writeJsonFile(file, FALLBACK_STOCK_MASTER);
  }
}

function readPortfolio() {
  ensurePortfolioFile();
  return readJsonFile(portfolioFile(), FALLBACK_PORTFOLIO);
}

function writePortfolio(payload) {
  ensurePortfolioFile();
  writeJsonFile(portfolioFile(), payload);
}

function readStockMaster() {
  ensureStockMasterFile();
  return readJsonFile(stockMasterFile(), FALLBACK_STOCK_MASTER);
}

function readAnnotations() {
  ensureDataDirectory();
  return readJsonFile(annotationsFile(), []);
}

function writeAnnotations(annotations) {
  ensureDataDirectory();
  writeJsonFile(annotationsFile(), Array.isArray(annotations) ? annotations : []);
}

module.exports = {
  ensurePortfolioFile,
  ensureStockMasterFile,
  readAnnotations,
  readPortfolio,
  readStockMaster,
  writeAnnotations,
  writePortfolio
};
