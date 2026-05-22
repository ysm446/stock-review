const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  DATA_DIR,
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
} = require("./data-files");
const {
  normalizeTickers,
  runDividendFetcher,
  runPortfolioStore,
  runReviewFetcher,
  runSectorFetcher,
  spawnPython,
  syncPortfolioStore
} = require("./python-services");

// ── Chat server (Python FastAPI) ─────────────────────────
let chatServerProcess = null;
const LLAMA_PATHS_FILE = path.join(__dirname, "..", "data", "llama_paths.json");

function startChatServer() {
  const script = path.join(__dirname, "..", "backend", "chat_server.py");
  chatServerProcess = spawnPython(script);
  chatServerProcess.on("error", err => console.error("Chat server error:", err));
  chatServerProcess.stderr.on("data", chunk => console.error("Chat server:", chunk.toString()));
  chatServerProcess.on("exit", code => {
    if (code !== null && code !== 0) console.error(`Chat server exited with code ${code}`);
  });
}

function stopLlamaServer() {
  let paths = {};
  try {
    if (fs.existsSync(LLAMA_PATHS_FILE)) {
      paths = JSON.parse(fs.readFileSync(LLAMA_PATHS_FILE, "utf8"));
    }
  } catch (error) {
    console.warn("Failed to read llama server state:", error);
  }

  const pid = Number(paths.llama_server_pid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore"
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (error) {
      console.warn("Failed to stop llama-server:", error);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LLAMA_PATHS_FILE), { recursive: true });
    fs.writeFileSync(
      LLAMA_PATHS_FILE,
      JSON.stringify({ active_model_path: "", llama_server_pid: null }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn("Failed to clear llama server state:", error);
  }
}

function getMainWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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

async function loadPortfolioWithHistory() {
  const portfolio = readPortfolio();
  const history = await runPortfolioStore("history", { holdings: portfolio.holdings || [] });
  return {
    ...portfolio,
    trendHistory: Array.isArray(history?.trendHistory) ? history.trendHistory : []
  };
}

async function importPortfolioFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON file: ${error.message}`);
  }

  const payload = sanitizePortfolioPayload(parsed);
  writePortfolio(payload);

  const synced = await syncPortfolioStore(payload);
  const fallbackHistory = await runPortfolioStore("history", { holdings: payload.holdings || [] });
  const trendHistory = Array.isArray(synced?.trendHistory)
    ? synced.trendHistory
    : Array.isArray(fallbackHistory?.trendHistory)
      ? fallbackHistory.trendHistory
      : [];

  return {
    canceled: false,
    filePath,
    portfolio: { ...payload, trendHistory }
  };
}

app.whenReady().then(() => {
  ensurePortfolioFile();
  ensureStockMasterFile();
  startChatServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  stopLlamaServer();
  if (chatServerProcess) { try { chatServerProcess.kill("SIGTERM"); } catch (_) {} }
});

// ── Annotations IPC ─────────────────────────────────────
ipcMain.handle("annotations:load", () => readAnnotations());
ipcMain.handle("annotations:save", (_event, data) => {
  writeAnnotations(data);
  return { ok: true };
});

// ── Portfolio IPC ────────────────────────────────────────
ipcMain.handle("portfolio:load", async () => loadPortfolioWithHistory());

ipcMain.handle("portfolio:save", async (_event, payload) => {
  writePortfolio(payload);
  const synced = await syncPortfolioStore(payload);
  return {
    ok: true,
    trendHistory: Array.isArray(synced?.trendHistory) ? synced.trendHistory : []
  };
});

ipcMain.handle("portfolio:refresh-prices", async (_event, tickers) =>
  runPortfolioStore("refresh", { tickers: normalizeTickers(tickers || []) })
);

ipcMain.handle("portfolio:trend-history", async (_event, holdings) =>
  runPortfolioStore("history", { holdings })
);

ipcMain.handle("portfolio:export", async () => {
  const portfolio = readPortfolio();
  const result = await dialog.showSaveDialog(getMainWindow(), {
    title: "Export Portfolio Data",
    defaultPath: path.join(DATA_DIR, `stock-review-export-${formatExportDate()}.json`),
    filters: [{ name: "JSON Files", extensions: ["json"] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const exportPayload = buildExportPayload(portfolio);
  fs.writeFileSync(result.filePath, JSON.stringify(exportPayload, null, 2), "utf8");
  return {
    canceled: false,
    filePath: result.filePath,
    holdingCount: exportPayload.holdings.length,
    watchlistCount: exportPayload.watchlist.length
  };
});

ipcMain.handle("portfolio:import", async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: "Import Portfolio Data",
    properties: ["openFile"],
    filters: [{ name: "JSON Files", extensions: ["json"] }]
  });

  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  return importPortfolioFromFile(result.filePaths[0]);
});

ipcMain.handle("portfolio:dividend-summary", async (_event, holdings) =>
  runDividendFetcher(holdings)
);

ipcMain.handle("portfolio:sectors", async (_event, tickers) =>
  runSectorFetcher(normalizeTickers(tickers || []))
);

ipcMain.handle("stock-master:load", async () => readStockMaster());
ipcMain.handle("review:fetch", async (_event, ticker) => runReviewFetcher(ticker));
