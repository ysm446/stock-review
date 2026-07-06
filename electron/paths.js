// アプリとデータの分離（docs/plan/plan.md フェーズ6）。
//
//   ① ユーザーデータルート（可搬・設定で変更可）  → getDataDir()
//   ② 環境設定ディレクトリ（マシン固有・固定）     → CONFIG_DIR
//
// ② はアプリ更新で消えない `app.getPath("userData")` に固定し、
//   - config.json（①の保存先ポインタ自身。①の中に置くと自己参照になるためここ）
//   - llama_paths.json（マシン固有のモデルパス等）
//   を置く。① の場所は config.json の dataDir で指定する（既定はリポジトリ直下 data/）。
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const LEGACY_DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_DIR = app.getPath("userData");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LLAMA_PATHS_FILE = path.join(CONFIG_DIR, "llama_paths.json");
const LEGACY_LLAMA_PATHS_FILE = path.join(LEGACY_DATA_DIR, "llama_paths.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
    }
  } catch (error) {
    console.warn("Failed to read config.json:", error);
  }
  return {};
}

function writeConfig(config) {
  ensureDir(CONFIG_DIR);
  const tempPath = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tempPath, CONFIG_FILE);
}

// ① ユーザーデータルートを解決。設定済みで実在すればそのパス、未設定/不正なら null。
// フォールバック（既定フォルダ）は設けない方針: 未設定のときは初回セットアップで
// 保存先を決めてもらう（それまでメイン機能は動かさない）。
function getDataDir() {
  const configured = readConfig().dataDir;
  if (configured && typeof configured === "string") {
    try {
      if (fs.existsSync(configured) && fs.statSync(configured).isDirectory()) {
        return path.resolve(configured);
      }
      console.warn(`Configured dataDir not found: ${configured}`);
    } catch (error) {
      console.warn("Invalid configured dataDir:", error);
    }
  }
  return null;
}

// データルートが設定済みかつ実在するか。
function isConfigured() {
  return getDataDir() !== null;
}

// ① を設定して config.json に保存。存在しないフォルダは作成する。
function setDataDir(dir) {
  const resolved = path.resolve(dir);
  ensureDir(resolved);
  const config = readConfig();
  config.dataDir = resolved;
  writeConfig(config);
  return resolved;
}

// ② llama_paths.json のパス。旧レイアウト（リポジトリ data/）にしかなければ一度だけ移行コピー。
function getLlamaPathsFile() {
  try {
    if (!fs.existsSync(LLAMA_PATHS_FILE) && fs.existsSync(LEGACY_LLAMA_PATHS_FILE)) {
      ensureDir(CONFIG_DIR);
      fs.copyFileSync(LEGACY_LLAMA_PATHS_FILE, LLAMA_PATHS_FILE);
      console.log(`Migrated llama_paths.json to config dir: ${LLAMA_PATHS_FILE}`);
    }
  } catch (error) {
    console.warn("Failed to migrate llama_paths.json:", error);
  }
  return LLAMA_PATHS_FILE;
}

// バックエンド（Python 子プロセス）へルートを渡すため process.env に反映する。
// 未設定のときは呼ばない前提（メイン機能を起動しない）。
function applyEnv() {
  const dataDir = getDataDir();
  if (dataDir) process.env.STOCK_REVIEW_DATA_DIR = dataDir;
  process.env.STOCK_REVIEW_CONFIG_DIR = CONFIG_DIR;
}

module.exports = {
  CONFIG_DIR,
  LEGACY_DATA_DIR,
  applyEnv,
  getDataDir,
  getLlamaPathsFile,
  isConfigured,
  readConfig,
  setDataDir,
  writeConfig
};
