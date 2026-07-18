const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const ROOT_DIR = path.join(__dirname, "..");
const PORTFOLIO_STORE = path.join(ROOT_DIR, "backend", "portfolio_store.py");
const REVIEW_FETCHER = path.join(ROOT_DIR, "backend", "fetch_review.py");
const REVIEW_CACHE = path.join(ROOT_DIR, "backend", "review_cache.py");
const DIVIDEND_FETCHER = path.join(ROOT_DIR, "backend", "fetch_dividends.py");
const SECTOR_FETCHER = path.join(ROOT_DIR, "backend", "fetch_sectors.py");

function getPythonCommand() {
  const candidates = [
    process.env.PYTHON,
    process.platform === "win32"
      ? path.join(ROOT_DIR, ".venv", "Scripts", "python.exe")
      : path.join(ROOT_DIR, ".venv", "bin", "python"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    } catch (_) {}
  }

  return { command: "python", argsPrefix: [] };
}

function spawnPython(scriptPath, args = [], options = {}) {
  const python = getPythonCommand();
  return spawn(python.command, [...python.argsPrefix, scriptPath, ...args], {
    cwd: ROOT_DIR,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    ...options
  });
}

function runPythonJson(scriptPath, args = [], payload = null, errorLabel = "Python script") {
  return new Promise((resolve, reject) => {
    const child = spawnPython(scriptPath, args);

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

    // spawn 失敗や早期終了時、stdin への書き込みが EPIPE を投げて
    // メインプロセスごと落ちるのを防ぐ。
    child.stdin.on("error", () => {});

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${errorLabel} exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON from ${errorLabel}: ${error.message}`));
      }
    });

    if (payload !== null) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();
  });
}

function normalizeTickers(tickers) {
  return tickers
    .map((ticker) => String(ticker || "").trim())
    .filter(Boolean);
}

function runPortfolioStore(command, payload = {}) {
  return runPythonJson(PORTFOLIO_STORE, [command], payload, "portfolio store");
}

async function syncPortfolioStore(payload) {
  try {
    return await runPortfolioStore("save", payload);
  } catch (error) {
    console.warn("Failed to sync portfolio store:", error);
    return null;
  }
}

function runReviewFetcher(ticker) {
  const normalizedTicker = String(ticker || "").trim();
  if (!normalizedTicker) {
    return Promise.reject(new Error("Ticker is required"));
  }
  return runPythonJson(REVIEW_FETCHER, [normalizedTicker], null, "review fetcher");
}

function refreshReviewPriceHistory(ticker) {
  const normalizedTicker = String(ticker || "").trim();
  if (!normalizedTicker) {
    return Promise.reject(new Error("Ticker is required"));
  }
  return runPythonJson(
    REVIEW_FETCHER,
    [normalizedTicker, "--price-history"],
    null,
    "review price history fetcher"
  );
}

function loadCachedReview(ticker) {
  const normalizedTicker = String(ticker || "").trim();
  if (!normalizedTicker) return Promise.reject(new Error("Ticker is required"));
  return runPythonJson(REVIEW_CACHE, [normalizedTicker], null, "review cache");
}

// スナップショットを持たない指数・為替向けに、蓄積済みの日足だけを読み出す
function loadCachedPriceHistory(ticker) {
  const normalizedTicker = String(ticker || "").trim();
  if (!normalizedTicker) return Promise.reject(new Error("Ticker is required"));
  return runPythonJson(
    REVIEW_CACHE,
    [normalizedTicker, "--history-only"],
    null,
    "price history cache"
  );
}

function runDividendFetcher(holdings) {
  return runPythonJson(DIVIDEND_FETCHER, [], { holdings }, "dividend fetcher");
}

function runSectorFetcher(tickers) {
  return runPythonJson(SECTOR_FETCHER, [], { tickers }, "sector fetcher");
}

module.exports = {
  getPythonCommand,
  loadCachedPriceHistory,
  loadCachedReview,
  normalizeTickers,
  refreshReviewPriceHistory,
  runDividendFetcher,
  runPortfolioStore,
  runReviewFetcher,
  runSectorFetcher,
  spawnPython,
  syncPortfolioStore
};
