// 設定ウィンドウ。現状は llama-cpp（llama-server）のバージョン確認とダウンロード。
// GitHub への通信は CSP の都合でレンダラから直接できないため、すべて
// バックエンド（chat_server, :8001）経由で行う。
import { apiFetch } from "./chat-api.js";
import { setAppStatus } from "./renderer-status.js";

const settingsButton          = document.getElementById("settings-button");
const settingsBackdrop        = document.getElementById("settings-modal-backdrop");
const closeSettingsModal      = document.getElementById("close-settings-modal");
const settingsTabs            = document.getElementById("settings-tabs");
const llamaCurrentBuild       = document.getElementById("llama-current-build");
const llamaCheckUpdate        = document.getElementById("llama-check-update");
const llamaLatestInfo         = document.getElementById("llama-latest-info");
const llamaVariantList        = document.getElementById("llama-variant-list");
const llamaProgress           = document.getElementById("llama-progress");
const llamaProgressFill       = document.getElementById("llama-progress-fill");
const llamaProgressText       = document.getElementById("llama-progress-text");

const embedModelName          = document.getElementById("embed-model-name");
const embedDownloadBtn        = document.getElementById("embed-download");
const embedStatusText         = document.getElementById("embed-status-text");
const embedProgress           = document.getElementById("embed-progress");
const embedProgressFill       = document.getElementById("embed-progress-fill");
const embedProgressText       = document.getElementById("embed-progress-text");

const resourceMonitorToggle   = document.getElementById("resource-monitor-toggle");
const RESOURCE_MONITOR_KEY    = "stock-review.resourceMonitor";

const dataDirCurrent          = document.getElementById("data-dir-current");
const dataDirOpenBtn          = document.getElementById("data-dir-open");
const dataDirChangeBtn        = document.getElementById("data-dir-change");
const dataDirStatus           = document.getElementById("data-dir-status");

const marginAutoIngestToggle  = document.getElementById("margin-auto-ingest-toggle");
const marginAutoIngestStatus  = document.getElementById("margin-auto-ingest-status");

let downloading = false;

async function settingsApi(method, path) {
  const res = await apiFetch(path, { method });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}${text ? ": " + text : ""}`);
  }
  return res.json();
}

// SSE 形式の進捗ストリームを読み取り、各イベントを onEvent に渡す。
async function streamPost(path, body, onEvent) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find(l => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function openSettings() {
  settingsBackdrop.classList.remove("is-hidden");
  refreshLlamaStatus();
  refreshEmbeddingStatus();
  refreshDataDir();
  refreshMarginSettings();
}

function closeSettings() {
  if (downloading) return;
  settingsBackdrop.classList.add("is-hidden");
}

async function refreshLlamaStatus() {
  try {
    const status = await settingsApi("GET", "/llama/local-status");
    llamaCurrentBuild.textContent = status.installed
      ? `${status.build}${status.count > 1 ? `（他 ${status.count - 1} 件）` : ""}`
      : "未インストール";
  } catch (err) {
    llamaCurrentBuild.textContent = "バックエンドに接続できません";
  }
}

async function checkLatestRelease() {
  llamaCheckUpdate.disabled = true;
  llamaLatestInfo.textContent = "最新リリースを確認中…";
  llamaVariantList.innerHTML = "";
  try {
    const release = await settingsApi("GET", "/llama/releases/latest");
    const local = release.local || {};
    llamaLatestInfo.textContent = release.update_available
      ? `最新: ${release.tag}（更新あり / 現在 ${local.build || "未インストール"}）`
      : `最新: ${release.tag}（最新の状態です）`;
    renderVariants(release.variants || []);
  } catch (err) {
    llamaLatestInfo.textContent = `取得失敗: ${err.message}`;
  } finally {
    llamaCheckUpdate.disabled = false;
  }
}

function renderVariants(variants) {
  llamaVariantList.innerHTML = "";
  if (!variants.length) {
    llamaVariantList.innerHTML = '<p class="settings-hint">ダウンロード可能なビルドが見つかりません。</p>';
    return;
  }
  for (const variant of variants) {
    const btn = document.createElement("button");
    btn.className = "llama-variant-item";
    btn.type = "button";
    btn.innerHTML = `
      <span class="llama-variant-label">${variant.label}</span>
      <span class="llama-variant-size">${formatBytes(variant.size)}</span>
    `;
    btn.addEventListener("click", () => downloadVariant(variant));
    llamaVariantList.appendChild(btn);
  }
}

function setProgress(percent, text) {
  llamaProgress.classList.remove("is-hidden");
  llamaProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  llamaProgressText.textContent = text;
}

async function downloadVariant(variant) {
  if (downloading) return;
  downloading = true;
  llamaCheckUpdate.disabled = true;
  llamaVariantList.querySelectorAll("button").forEach(b => (b.disabled = true));
  setProgress(0, `${variant.label} をダウンロード中…`);
  setAppStatus(`${variant.label} をダウンロードしています...`, "active");

  try {
    let finished = false;
    await streamPost("/llama/download", { asset_name: variant.asset_name }, evt => {
      if (evt.type === "progress") {
        const stageLabel = evt.stage === "cudart" ? "CUDA ランタイム" : evt.stage === "extract" ? "展開中" : variant.label;
        const detail = evt.total ? ` (${formatBytes(evt.received)} / ${formatBytes(evt.total)})` : "";
        setProgress(evt.percent || 0, `${stageLabel}${detail}`);
      } else if (evt.type === "done") {
        finished = true;
        setProgress(100, `完了: ${evt.build} をインストールしました`);
      } else if (evt.type === "error") {
        throw new Error(evt.message);
      }
    });

    if (!finished) setProgress(100, "完了");
    await refreshLlamaStatus();
    setAppStatus(`${variant.label} をインストールしました。`, "success");
  } catch (err) {
    setProgress(0, `失敗: ${err.message}`);
    setAppStatus(`llama-server の更新に失敗しました: ${err.message}`, "error");
  } finally {
    downloading = false;
    llamaCheckUpdate.disabled = false;
    llamaVariantList.querySelectorAll("button").forEach(b => (b.disabled = false));
  }
}

// ── Embedding model ───────────────────────────────────────
let embedAvailable = false; // sentence-transformers が導入済みか

async function refreshEmbeddingStatus() {
  try {
    const status = await settingsApi("GET", "/embedding/status");
    embedModelName.textContent = status.model_name;
    embedAvailable = Boolean(status.available);

    const parts = [];
    if (!status.available) parts.push("sentence-transformers 未インストール");
    parts.push(status.cached ? "モデル取得済み" : "モデル未取得");
    if (!status.sqlite_vec) parts.push("sqlite-vec 未導入（ベクトル検索は無効）");
    embedStatusText.textContent = parts.join(" / ");

    if (!status.available) {
      embedDownloadBtn.textContent = "依存をインストール";
      embedDownloadBtn.disabled = downloading;
    } else if (status.cached) {
      embedDownloadBtn.textContent = "取得済み";
      embedDownloadBtn.disabled = true;
    } else {
      embedDownloadBtn.textContent = "ダウンロード";
      embedDownloadBtn.disabled = downloading;
    }
  } catch (err) {
    embedStatusText.textContent = "バックエンドに接続できません";
    embedDownloadBtn.disabled = true;
  }
}

function setEmbedProgress(percent, text, indeterminate = false) {
  embedProgress.classList.remove("is-hidden");
  embedProgress.classList.toggle("is-indeterminate", indeterminate);
  embedProgressFill.style.width = indeterminate ? "100%" : `${Math.max(0, Math.min(100, percent))}%`;
  embedProgressText.textContent = text;
}

async function runEmbeddingDownload() {
  let finished = false;
  await streamPost("/embedding/download", {}, evt => {
    if (evt.type === "progress") {
      const detail = evt.total ? ` (${formatBytes(evt.received)} / ${formatBytes(evt.total)})` : "";
      setEmbedProgress(evt.percent || 0, `モデルをダウンロード中…${detail}`);
    } else if (evt.type === "done") {
      finished = true;
      setEmbedProgress(100, "完了: モデルを取得しました");
    } else if (evt.type === "error") {
      throw new Error(evt.message);
    }
  });
  if (!finished) setEmbedProgress(100, "完了");
}

async function downloadEmbedding() {
  if (downloading) return;
  downloading = true;
  embedDownloadBtn.disabled = true;
  setEmbedProgress(0, "モデルをダウンロード中…（初回は数百MB）");
  setAppStatus("埋め込みモデルをダウンロードしています...", "active");
  try {
    await runEmbeddingDownload();
    setAppStatus("埋め込みモデルを取得しました。", "success");
  } catch (err) {
    setEmbedProgress(0, `失敗: ${err.message}`);
    setAppStatus(`埋め込みモデルの取得に失敗しました: ${err.message}`, "error");
  } finally {
    downloading = false;
    await refreshEmbeddingStatus();
  }
}

async function installEmbeddingDeps() {
  if (downloading) return;
  downloading = true;
  embedDownloadBtn.disabled = true;
  setEmbedProgress(0, "依存をインストール中…（PyTorch を含む大容量。数分かかります）", true);
  setAppStatus("埋め込み機能の依存関係をインストールしています...", "active");
  try {
    await streamPost("/embedding/install-deps", {}, evt => {
      if (evt.type === "log") {
        if (evt.line) setEmbedProgress(0, evt.line.slice(0, 120), true);
      } else if (evt.type === "error") {
        throw new Error(evt.message);
      }
    });
    // 依存導入に成功したら、続けてモデルを取得する。
    setEmbedProgress(0, "依存のインストール完了。モデルを取得します…", true);
    await runEmbeddingDownload();
    setAppStatus("埋め込み機能の準備が完了しました。", "success");
  } catch (err) {
    setEmbedProgress(0, `失敗: ${err.message}`);
    setAppStatus(`埋め込み機能の準備に失敗しました: ${err.message}`, "error");
  } finally {
    downloading = false;
    await refreshEmbeddingStatus();
  }
}

function onEmbedButtonClick() {
  if (embedAvailable) {
    downloadEmbedding();
  } else {
    installEmbeddingDeps();
  }
}

// ── Tabs (将来の項目追加に備えた切り替え) ──────────────────
settingsTabs?.addEventListener("click", e => {
  const tab = e.target.closest(".settings-tab");
  if (!tab) return;
  const target = tab.dataset.tab;
  settingsTabs.querySelectorAll(".settings-tab").forEach(t => t.classList.toggle("is-active", t === tab));
  document.querySelectorAll(".settings-panel").forEach(panel => {
    panel.classList.toggle("is-active", panel.dataset.tab === target);
  });
});

settingsButton?.addEventListener("click", openSettings);
closeSettingsModal?.addEventListener("click", closeSettings);
settingsBackdrop?.addEventListener("click", e => {
  if (e.target === settingsBackdrop) closeSettings();
});
llamaCheckUpdate?.addEventListener("click", checkLatestRelease);
embedDownloadBtn?.addEventListener("click", onEmbedButtonClick);

// ── データフォルダ（保存先ルート） ─────────────────────────
async function refreshDataDir() {
  if (!dataDirCurrent) return;
  try {
    const info = await window.stockReviewApi.getDataDir();
    dataDirCurrent.textContent = info?.dataDir || "(不明)";
  } catch (err) {
    dataDirCurrent.textContent = "取得できません";
  }
}

async function changeDataDir() {
  if (!window.confirm("データフォルダを変更すると、選択したフォルダのデータに切り替わります。アプリを再読み込みします。続けますか？")) {
    return;
  }
  dataDirChangeBtn.disabled = true;
  setAppStatus("データフォルダを切り替えています...", "active");
  try {
    const result = await window.stockReviewApi.chooseDataDir();
    if (result?.canceled) {
      if (dataDirStatus) dataDirStatus.textContent = "変更をキャンセルしました。";
      setAppStatus("データフォルダの変更をキャンセルしました。", "neutral", 3000);
      return;
    }
    dataDirCurrent.textContent = result.dataDir;
    if (dataDirStatus) dataDirStatus.textContent = "切り替えました。再読み込みします…";
    setAppStatus("データフォルダを切り替えました。", "success");
    // 新しいデータルートで全体を読み込み直す（backend は main 側で再起動済み）。
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    if (dataDirStatus) dataDirStatus.textContent = `変更に失敗しました: ${err.message}`;
    setAppStatus(`データフォルダの変更に失敗しました: ${err.message}`, "error");
  } finally {
    dataDirChangeBtn.disabled = false;
  }
}

dataDirChangeBtn?.addEventListener("click", changeDataDir);
dataDirOpenBtn?.addEventListener("click", () => window.stockReviewApi.openDataDir());

// ── 信用残の自動取り込み設定（DB側 margin_meta に保存） ─────────
async function refreshMarginSettings() {
  if (!marginAutoIngestToggle) return;
  try {
    const res = await apiFetch("/margin/settings", { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    marginAutoIngestToggle.checked = data.autoIngest !== false;
  } catch (_err) {
    // バックエンド起動前は現状表示のまま（変更時にエラーとして通知される）
  }
}

marginAutoIngestToggle?.addEventListener("change", async () => {
  const next = marginAutoIngestToggle.checked;
  try {
    const res = await apiFetch("/margin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoIngest: next })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (marginAutoIngestStatus) {
      marginAutoIngestStatus.textContent = next
        ? "自動取り込み: オン"
        : "自動取り込み: オフ（チャートには蓄積済みの分だけ表示されます）";
    }
  } catch (err) {
    marginAutoIngestToggle.checked = !next;
    if (marginAutoIngestStatus) marginAutoIngestStatus.textContent = `設定の保存に失敗しました: ${err.message}`;
    setAppStatus(`信用残の設定保存に失敗しました: ${err.message}`, "error");
  }
});

// ── テーマ（配色）の切り替え ───────────────────────────────
// 実際のテーマ適用・永続化は theme.js（window.StockReviewTheme）が担う。
const themePicker = document.getElementById("theme-picker");
if (themePicker) {
  const themeApi = window.StockReviewTheme;

  function markActiveTheme(value) {
    themePicker.querySelectorAll(".theme-swatch").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.themeValue === value);
    });
  }

  // 初期状態を現在のテーマに合わせる。
  markActiveTheme(themeApi ? themeApi.get() : "dark");

  themePicker.addEventListener("click", e => {
    const btn = e.target.closest(".theme-swatch");
    if (!btn) return;
    const value = btn.dataset.themeValue;
    if (themeApi) themeApi.set(value);
    markActiveTheme(value);
  });

  // 他経路（将来）で変わったときも追従。
  window.addEventListener("stock-review:theme", e => {
    markActiveTheme(e.detail?.theme);
  });
}

// ── リソースモニターの表示切り替え ─────────────────────────
if (resourceMonitorToggle) {
  resourceMonitorToggle.checked = localStorage.getItem(RESOURCE_MONITOR_KEY) === "1";
  resourceMonitorToggle.addEventListener("change", () => {
    const enabled = resourceMonitorToggle.checked;
    localStorage.setItem(RESOURCE_MONITOR_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent("stock-review:resource-monitor", { detail: { enabled } }));
    setAppStatus(enabled ? "リソースモニターを表示します。" : "リソースモニターを非表示にしました。", enabled ? "active" : "success", enabled ? 0 : 3000);
  });
}
