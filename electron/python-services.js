const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const PORTFOLIO_STORE = path.join(ROOT_DIR, "backend", "portfolio_store.py");
const REVIEW_FETCHER = path.join(ROOT_DIR, "backend", "fetch_review.py");
const DIVIDEND_FETCHER = path.join(ROOT_DIR, "backend", "fetch_dividends.py");
const SECTOR_FETCHER = path.join(ROOT_DIR, "backend", "fetch_sectors.py");

function runPythonJson(scriptPath, args = [], payload = null, errorLabel = "Python script") {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [scriptPath, ...args], {
      cwd: ROOT_DIR,
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

function runDividendFetcher(holdings) {
  return runPythonJson(DIVIDEND_FETCHER, [], { holdings }, "dividend fetcher");
}

function runSectorFetcher(tickers) {
  return runPythonJson(SECTOR_FETCHER, [], { tickers }, "sector fetcher");
}

module.exports = {
  normalizeTickers,
  runDividendFetcher,
  runPortfolioStore,
  runReviewFetcher,
  runSectorFetcher,
  syncPortfolioStore
};
