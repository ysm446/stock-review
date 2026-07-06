const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const crypto = require("crypto");
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
// 外部サイトのブラウザ経由アクセスを防ぐ API トークン（起動ごとに生成）
const CHAT_API_TOKEN = crypto.randomBytes(24).toString("hex");

function killStaleChatServer() {
  // 以前の異常終了で残った chat_server がポート 8001 を握っていると、
  // 新しいサーバーが起動できず、古いトークンの孤児と会話して全リクエストが
  // 401 になる。起動前に 8001 の LISTEN プロセスを掃除する（8001 は本アプリ専用）。
  if (process.platform !== "win32") return;
  try {
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      windowsHide: true
    }).stdout || "";
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts[1] && parts[1].endsWith(":8001")) {
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          console.warn(`Killing stale process on :8001 (pid ${pid})`);
          spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
            windowsHide: true,
            stdio: "ignore"
          });
        }
      }
    }
  } catch (error) {
    console.warn("Stale chat server cleanup failed:", error);
  }
}

function startChatServer() {
  killStaleChatServer();
  const script = path.join(__dirname, "..", "backend", "chat_server.py");
  chatServerProcess = spawnPython(script, [], {
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      STOCK_REVIEW_API_TOKEN: CHAT_API_TOKEN
    }
  });
  chatServerProcess.on("error", err => console.error("Chat server error:", err));
  chatServerProcess.stdin.on("error", () => {});
  chatServerProcess.stdout.on("data", chunk => console.log("Chat server:", chunk.toString().trimEnd()));
  chatServerProcess.stderr.on("data", chunk => console.error("Chat server:", chunk.toString().trimEnd()));
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

  // 役割ベース（roles.standard / roles.deep）と旧形式（llama_server_pid）の両方の PID を止める
  const pids = [];
  if (paths.roles && typeof paths.roles === "object") {
    for (const role of Object.values(paths.roles)) {
      const pid = Number(role?.pid);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      if (role && typeof role === "object") role.pid = null;
    }
  }
  const legacyPid = Number(paths.llama_server_pid);
  if (Number.isInteger(legacyPid) && legacyPid > 0) pids.push(legacyPid);

  for (const pid of pids) {
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
    delete paths.llama_server_pid;
    delete paths.active_model_path;
    fs.mkdirSync(path.dirname(LLAMA_PATHS_FILE), { recursive: true });
    fs.writeFileSync(LLAMA_PATHS_FILE, JSON.stringify(paths, null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to clear llama server state:", error);
  }
}

function getMainWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function captureScreenshot(win, suffix = "") {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.capturePage().then(image => {
    const dir = path.join(DATA_DIR, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filePath = path.join(dir, `${stamp}${suffix}.png`);
    fs.writeFileSync(filePath, image.toPNG());
    console.log(`Screenshot saved: ${filePath}`);
  }).catch(error => console.error("Screenshot failed:", error));
}

function createWindow() {
  const win = new BrowserWindow({
    // コンテンツ領域を 1920x1080 に固定基準とする（スクリーンショットも同サイズになる）。
    // useContentSize でウィンドウ枠を除いた内側のサイズを指定する。
    width: 1920,
    height: 1080,
    useContentSize: true,
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

  // F12 → コンテンツ領域のスクリーンショットを data/screenshots/ に保存
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      event.preventDefault();
      captureScreenshot(win);
    }
  });

  // 外部ページへの遷移・新規ウィンドウを禁止し、リンクは既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
    }
  });

  // 開発用: STOCK_REVIEW_AUTOSHOT=1 で起動すると、各ビューのスクリーンショットを
  // data/screenshots/ に保存して自動終了する（レイアウト検証用）
  if (process.env.STOCK_REVIEW_AUTOSHOT) {
    win.webContents.once("did-finish-load", () => {
      const clickNav = view => win.webContents.executeJavaScript(
        `document.querySelector('.nav-button[data-view="${view}"]')?.click()`
      );
      setTimeout(async () => {
        await captureScreenshot(win, "-portfolio");
        await clickNav("review");
        // 先頭の銘柄チップをクリックしてデータ入りの状態で撮影する
        await win.webContents.executeJavaScript(
          `document.querySelector('.review-chip')?.click()`
        );
        setTimeout(async () => {
          await captureScreenshot(win, "-review");
          setTimeout(() => app.quit(), 500);
        }, 9000);
      }, 6000);
    });
  }

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

// ── Chat API token IPC ──────────────────────────────────
ipcMain.handle("chat:api-token", () => CHAT_API_TOKEN);

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
