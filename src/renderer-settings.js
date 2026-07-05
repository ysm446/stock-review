// 設定ウィンドウ。現状は llama-cpp（llama-server）のバージョン確認とダウンロード。
// GitHub への通信は CSP の都合でレンダラから直接できないため、すべて
// バックエンド（chat_server, :8001）経由で行う。
import { apiFetch } from "./chat-api.js";

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
}

function closeSettings() {
  if (downloading) return;
  settingsBackdrop.classList.add("is-hidden");
}

async function refreshLlamaStatus() {
  try {
    const status = await settingsApi("GET", "/llama/status");
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
  } catch (err) {
    setProgress(0, `失敗: ${err.message}`);
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
  try {
    await runEmbeddingDownload();
  } catch (err) {
    setEmbedProgress(0, `失敗: ${err.message}`);
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
  } catch (err) {
    setEmbedProgress(0, `失敗: ${err.message}`);
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

// ── リソースモニターの表示切り替え ─────────────────────────
if (resourceMonitorToggle) {
  resourceMonitorToggle.checked = localStorage.getItem(RESOURCE_MONITOR_KEY) === "1";
  resourceMonitorToggle.addEventListener("change", () => {
    const enabled = resourceMonitorToggle.checked;
    localStorage.setItem(RESOURCE_MONITOR_KEY, enabled ? "1" : "0");
    window.dispatchEvent(new CustomEvent("stock-review:resource-monitor", { detail: { enabled } }));
  });
}
