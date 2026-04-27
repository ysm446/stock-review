const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const {
  DATA_DIR,
  buildExportPayload,
  ensurePortfolioFile,
  ensureStockMasterFile,
  formatExportDate,
  readPortfolio,
  readStockMaster,
  sanitizePortfolioPayload,
  writePortfolio
} = require("./data-files");
const {
  normalizeTickers,
  runDividendFetcher,
  runPortfolioStore,
  runReviewFetcher,
  runSectorFetcher,
  syncPortfolioStore
} = require("./python-services");

// ── Chat SQLite database ─────────────────────────────────
let chatDb = null;

function initChatDb() {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(__dirname, "..", "data", "chat.db");
  chatDb = new DatabaseSync(dbPath);
  chatDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id  INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      title      TEXT    NOT NULL DEFAULT '新しい会話',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conv_parent ON conversations(parent_id);
  `);
}

let llamaServerProcess = null;
const LLAMA_PORT = 8080;
let loadedModelPath = null;

function findLatestLlamaServer() {
  const serverDir = path.join(__dirname, "..", "bin", "llama-server");
  const builds = fs.readdirSync(serverDir).filter(d =>
    fs.statSync(path.join(serverDir, d)).isDirectory()
  );
  builds.sort((a, b) => {
    const numA = parseInt(a.match(/b(\d+)/)?.[1] ?? "0");
    const numB = parseInt(b.match(/b(\d+)/)?.[1] ?? "0");
    return numB - numA;
  });
  if (!builds.length) throw new Error("No llama-server builds found");
  return path.join(serverDir, builds[0], "llama-server.exe");
}

function findGgufFiles() {
  const modelsDir = path.join(__dirname, "..", "models");
  if (!fs.existsSync(modelsDir)) return [];
  const results = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (entry.name.toLowerCase().endsWith(".gguf") && !entry.name.toLowerCase().startsWith("mmproj")) {
        results.push({ name: entry.name, path: full, relativePath: path.relative(modelsDir, full) });
      }
    }
  }
  scan(modelsDir);
  return results;
}

function killLlamaServer() {
  return new Promise(resolve => {
    if (!llamaServerProcess) { resolve(); return; }
    const proc = llamaServerProcess;
    llamaServerProcess = null;
    loadedModelPath = null;
    proc.once("exit", resolve);
    proc.kill("SIGTERM");
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} resolve(); }, 3000);
  });
}

function waitForServer(proc, port, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let done = false;
    proc.once("exit", code => {
      if (!done) { done = true; reject(new Error(`llama-server exited (code ${code})`)); }
    });
    function check() {
      if (done) return;
      http.get(`http://localhost:${port}/health`, res => {
        res.resume();
        if (res.statusCode === 200) { done = true; resolve(); }
        else retry();
      }).on("error", retry);
    }
    function retry() {
      if (done) return;
      if (Date.now() > deadline) { done = true; reject(new Error("llama-server startup timed out")); return; }
      setTimeout(check, 1500);
    }
    setTimeout(check, 3000);
  });
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
    portfolio: {
      ...payload,
      trendHistory
    }
  };
}

app.whenReady().then(() => {
  ensurePortfolioFile();
  ensureStockMasterFile();
  initChatDb();
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

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

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

  if (result.canceled || !result.filePaths?.length) {
    return { canceled: true };
  }

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

// ── Conversation & message handlers ─────────────────────
ipcMain.handle("chat:conversations-load", () =>
  chatDb.prepare("SELECT id, parent_id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC").all()
);

ipcMain.handle("chat:conversation-create", (_event, { parentId = null, title = "新しい会話" } = {}) => {
  const now = Date.now();
  const r = chatDb.prepare("INSERT INTO conversations (parent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(parentId, title, now, now);
  return { id: Number(r.lastInsertRowid), parent_id: parentId, title, created_at: now, updated_at: now };
});

ipcMain.handle("chat:conversation-rename", (_event, { id, title }) => {
  chatDb.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
  return { ok: true };
});

ipcMain.handle("chat:conversation-delete", (_event, id) => {
  chatDb.prepare("PRAGMA foreign_keys = ON").run();
  chatDb.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return { ok: true };
});

ipcMain.handle("chat:messages-load", (_event, conversationId) =>
  chatDb.prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId)
);

ipcMain.handle("chat:message-append", (_event, { conversationId, role, content }) => {
  const now = Date.now();
  const r = chatDb.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(conversationId, role, content, now);
  chatDb.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
  return { id: Number(r.lastInsertRowid) };
});

ipcMain.handle("chat:list-models", async () => findGgufFiles());

ipcMain.handle("chat:load-model", async (_event, modelPath) => {
  await killLlamaServer();
  const serverExe = findLatestLlamaServer();
  const proc = spawn(serverExe, ["-m", modelPath, "--port", String(LLAMA_PORT), "-ngl", "99", "-c", "4096"], {
    cwd: path.dirname(serverExe)
  });
  llamaServerProcess = proc;
  loadedModelPath = modelPath;
  await waitForServer(proc, LLAMA_PORT);
  return { ok: true };
});

ipcMain.handle("chat:unload-model", async () => {
  await killLlamaServer();
  return { ok: true };
});

ipcMain.handle("chat:server-status", async () => ({
  loaded: !!llamaServerProcess,
  modelPath: loadedModelPath
}));

ipcMain.handle("chat:stream", async (event, messages) => {
  if (!llamaServerProcess) throw new Error("モデルが読み込まれていません");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "local", messages, stream: true });
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) {
        event.sender.send("chat:stream-error", err.message ?? String(err));
        reject(err);
      } else {
        event.sender.send("chat:stream-done");
        resolve();
      }
    }
    const req = http.request({
      hostname: "localhost",
      port: LLAMA_PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let buf = "";
      res.on("data", raw => {
        buf += raw.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { finish(null); return; }
          try {
            const json = JSON.parse(payload);
            const chunk = json.choices?.[0]?.delta?.content;
            if (chunk) event.sender.send("chat:stream-chunk", chunk);
          } catch (_) {}
        }
      });
      res.on("end", () => finish(null));
      res.on("error", finish);
    });
    req.setTimeout(120000, () => { req.destroy(); finish(new Error("リクエストがタイムアウトしました")); });
    req.on("error", finish);
    req.write(body);
    req.end();
  });
});

app.on("will-quit", () => {
  if (llamaServerProcess) { try { llamaServerProcess.kill("SIGTERM"); } catch (_) {} }
});
