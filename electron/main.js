const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.STOCK_REVIEW_HOST || "127.0.0.1";
const PORT = Number(process.env.STOCK_REVIEW_PORT || 8000);
const PYTHON = process.env.PYTHON_EXECUTABLE || "python";

let mainWindow = null;
let backend = null;
let shuttingDown = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#141414",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Load the local HTML renderer (no HTTP server needed for the UI)
  const indexPath = path.join(__dirname, "renderer", "index.html");
  mainWindow.loadFile(indexPath);
}

function startBackend() {
  const script = path.resolve(__dirname, "..", "server.py");
  const args = [script, "--host", HOST, "--port", String(PORT)];

  backend = spawn(PYTHON, args, {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      STOCK_REVIEW_HOST: HOST,
      STOCK_REVIEW_PORT: String(PORT),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  backend.stdout.on("data", (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });

  backend.stderr.on("data", (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });

  backend.on("exit", (code) => {
    if (shuttingDown) return;
    dialog.showErrorBox(
      "Stock Review",
      `バックエンドが終了しました (exit code: ${code ?? "unknown"})。`
    );
    app.quit();
  });
}

function stopBackend() {
  if (!backend || backend.killed) return;
  try {
    backend.kill();
  } catch (error) {
    console.error("Failed to stop backend:", error);
  }
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
});

app.on("window-all-closed", () => {
  shuttingDown = true;
  stopBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  shuttingDown = true;
  stopBackend();
});
