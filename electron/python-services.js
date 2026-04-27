const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const ROOT_DIR = path.join(__dirname, "..");
const PORTFOLIO_STORE = path.join(ROOT_DIR, "backend", "portfolio_store.py");
const REVIEW_FETCHER = path.join(ROOT_DIR, "backend", "fetch_review.py");
const DIVIDEND_FETCHER = path.join(ROOT_DIR, "backend", "fetch_dividends.py");
const SECTOR_FETCHER = path.join(ROOT_DIR, "backend", "fetch_sectors.py");

function getPythonCommand() {
  const candidates = [
    process.env.PYTHON,
    process.env.CONDA_DEFAULT_ENV === "main" && process.env.CONDA_PREFIX
      ? path.join(process.env.CONDA_PREFIX, "python.exe")
      : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "miniconda3", "envs", "main", "python.exe") : null,
    "D:\\miniconda3\\conda_envs\\main\\python.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    } catch (_) {}
  }

  const condaExe = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "miniconda3", "Scripts", "conda.exe")
    : null;
  if (condaExe && fs.existsSync(condaExe)) {
    return { command: condaExe, argsPrefix: ["run", "-n", "main", "python"] };
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
  getPythonCommand,
  normalizeTickers,
  runDividendFetcher,
  runPortfolioStore,
  runReviewFetcher,
  runSectorFetcher,
  spawnPython,
  syncPortfolioStore
};
