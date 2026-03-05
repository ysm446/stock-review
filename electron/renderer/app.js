/* ── API base URL (injected by preload.js) ─────────────────────── */
const API = (window.electronAPI && window.electronAPI.apiBase)
  ? window.electronAPI.apiBase
  : "http://127.0.0.1:8000";

/* ── API helpers ───────────────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Stream SSE from path, calling onChunk(accumulatedText) for each token.
 * options: fetch init (method, headers, body)
 * Returns a Promise that resolves when [DONE] is received.
 */
async function apiStream(path, options, onChunk, onError) {
  const res = await fetch(API + path, options);
  if (!res.ok) {
    const err = `HTTP ${res.status}: ${res.statusText}`;
    if (onError) onError(err); else console.error(err);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { if (onError) onError(parsed.error); return; }
        if (parsed.chunk !== undefined) onChunk(parsed.chunk);
      } catch { /* ignore malformed */ }
    }
  }
}

/* ── Shared config (loaded once) ──────────────────────────────── */
let _config = null;
async function getConfig() {
  if (!_config) _config = await apiFetch("/api/config");
  return _config;
}

/* ── Utility ───────────────────────────────────────────────────── */
function fmt(v, decimals = 2) {
  if (v == null) return "-";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("ja-JP", { maximumFractionDigits: decimals });
}
function fmtPct(v) { return v == null ? "-" : `${fmt(v, 1)}%`; }
function fmtPrice(v, cur) { return v == null ? "-" : `${cur || ""} ${fmt(v)}`; }

function scoreBadge(score) {
  if (score == null) return "-";
  const n = Number(score);
  let cls = n >= 70 ? "good" : n >= 50 ? "" : n >= 30 ? "warn" : "bad";
  const label = n >= 70 ? "優秀" : n >= 50 ? "良好" : n >= 30 ? "普通" : "要注意";
  return `<span class="score-pill ${cls}" style="background:${n>=70?"#064e3b":n>=50?"#1e3a5f":n>=30?"#451a03":"#3f0a10"}">${Math.round(n)} ${label}</span>`;
}

function buildTable(columns, rows, onRowClick) {
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = table.createTHead();
  const hr = thead.insertRow();
  columns.forEach(c => {
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  });
  const tbody = table.createTBody();
  rows.forEach((row, i) => {
    const tr = tbody.insertRow();
    if (onRowClick) {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => onRowClick(row, i));
    }
    row.forEach(cell => {
      const td = tr.insertCell();
      if (typeof cell === "object" && cell !== null && cell.__html) {
        td.innerHTML = cell.__html;
      } else {
        td.textContent = cell == null ? "-" : String(cell);
      }
    });
  });
  return table;
}

/* ── Tab routing ───────────────────────────────────────────────── */
const tabInited = {};

function activateTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tabId}`));
  if (!tabInited[tabId]) {
    tabInited[tabId] = true;
    const initFn = window[`init_${tabId}`];
    if (typeof initFn === "function") initFn();
  }
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

/* Sub-tab routing */
document.querySelectorAll(".sub-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".tab-panel");
    parent.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    parent.querySelectorAll(".sub-tab-panel").forEach(p => p.classList.toggle("active", p.id === btn.dataset.subtab));
  });
});

/* Navigate to report tab with a ticker */
function gotoReport(ticker) {
  document.getElementById("r-ticker").value = ticker;
  activateTab("report");
  if (!tabInited["report"]) { tabInited["report"] = true; if (typeof init_report === "function") init_report(); }
  document.getElementById("r-run-btn").click();
}

/* ── Bootstrap: init first tab ─────────────────────────────────── */
window.addEventListener("DOMContentLoaded", () => {
  activateTab("screening");
});
