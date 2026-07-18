// マーケットページ: 指数・為替のローソク足チャート＋市況ニュース＋AIまとめ。
// 日足は個別銘柄と同じ review_price_history へ蓄積し、チャート描画は
// candlestick-chart.js の共通モジュールを使う。ニュースはバックエンドの
// /market/news（ddgs検索・15分キャッシュ）、AIまとめは /market/summary（ローカルLLM）。

import { createCandlestickChart } from "./candlestick-chart.js";
import { api, streamChat } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { setAppStatus } from "./renderer-status.js";

const INSTRUMENTS = [
  { symbol: "^N225", label: "日経平均" },
  { symbol: "^DJI", label: "NYダウ" },
  { symbol: "JPY=X", label: "ドル円" }
];
const INSTRUMENT_KEY = "stock-review.marketInstrument";

const instrumentTabs = document.getElementById("market-instrument-tabs");
const chartTitle = document.getElementById("market-chart-title");
const chartDate = document.getElementById("market-chart-date");
const chartPrice = document.getElementById("market-chart-price");
const chartChange = document.getElementById("market-chart-change");
const chartSummary = document.getElementById("market-chart-summary");
const chartRefresh = document.getElementById("market-chart-refresh");
const candlestickWrap = document.getElementById("market-candlestick-wrap");

let activeSymbol = (() => {
  const saved = localStorage.getItem(INSTRUMENT_KEY);
  return INSTRUMENTS.some((item) => item.symbol === saved) ? saved : INSTRUMENTS[0].symbol;
})();

const historyBySymbol = new Map();
const refreshedSymbols = new Set(); // このセッションで再取得済みの銘柄
let pendingSymbol = null;
let loadRequestId = 0;

function currentInstrument() {
  return INSTRUMENTS.find((item) => item.symbol === activeSymbol) || INSTRUMENTS[0];
}

function isPending() {
  return pendingSymbol === activeSymbol;
}

function formatIndexValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return numeric.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function updateMarketChartHead({ endRows, isPast }) {
  chartTitle.textContent = currentInstrument().label;
  chartDate.classList.toggle("is-past", isPast);
  const endDate = endRows.at(-1)?.date;
  chartDate.textContent = endDate
    ? `${endDate.replaceAll("-", "/")} 時点${isPast ? "（過去表示）" : ""}`
    : "";
  chartChange.classList.remove("is-positive", "is-negative");
  const close = Number(endRows.at(-1)?.close);
  const previousClose = Number(endRows.at(-2)?.close);
  chartPrice.textContent = formatIndexValue(close);
  if (!Number.isFinite(close) || !Number.isFinite(previousClose) || previousClose === 0) {
    chartChange.textContent = "前日比 -";
    return;
  }
  const change = close - previousClose;
  const rate = change / previousClose * 100;
  chartChange.textContent = `前日比 ${change >= 0 ? "+" : ""}${formatIndexValue(change)} (${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%)`;
  chartChange.classList.add(change >= 0 ? "is-positive" : "is-negative");
}

const marketChart = createCandlestickChart({
  canvas: document.getElementById("market-candlestick-chart"),
  wrap: candlestickWrap,
  tooltip: document.getElementById("market-chart-tooltip"),
  crosshair: document.getElementById("market-chart-crosshair"),
  crosshairPrice: document.getElementById("market-chart-crosshair-price"),
  summary: chartSummary,
  rangeSelect: document.getElementById("market-chart-range"),
  maMenuButton: document.getElementById("market-ma-menu-button"),
  maMenu: document.getElementById("market-ma-menu"),
  volumeProfileMenuButton: document.getElementById("market-volume-profile-menu-button"),
  volumeProfileMenu: document.getElementById("market-volume-profile-menu"),
  volumeProfileToggle: document.getElementById("market-volume-profile-toggle"),
  scrub: {
    container: document.getElementById("market-chart-scrub"),
    slider: document.getElementById("market-chart-scrub-slider"),
    stepBack: document.getElementById("market-chart-step-back"),
    stepForward: document.getElementById("market-chart-step-forward"),
    latest: document.getElementById("market-chart-latest")
  },
  resizer: document.getElementById("market-chart-resizer"),
  storagePrefix: "stock-review.market",
  heightDefault: 320,
  getRows: () => historyBySymbol.get(activeSymbol),
  getEmptyState: () => ({
    summary: isPending() ? "最新データを取得中..." : "データを取得できませんでした",
    canvas: isPending() ? "データを取得中..." : "表示できるデータがありません"
  }),
  getSummarySuffix: () => isPending() ? "　最新データを取得中..." : "",
  onAfterDraw: updateMarketChartHead
});

function renderInstrumentTabs() {
  [...instrumentTabs.children].forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.symbol === activeSymbol);
    tab.setAttribute("aria-selected", tab.dataset.symbol === activeSymbol ? "true" : "false");
  });
}

// 日足をオンライン再取得して蓄積へ追記する。失敗しても保存済みデータの表示は維持する。
async function refreshInstrument(symbol, { silent = true } = {}) {
  pendingSymbol = symbol;
  if (symbol === activeSymbol) marketChart.draw();
  try {
    const result = await window.stockReviewApi.refreshReviewPriceHistory(symbol);
    historyBySymbol.set(symbol, Array.isArray(result?.priceHistory) ? result.priceHistory : []);
    refreshedSymbols.add(symbol);
    if (!silent) setAppStatus(`${currentInstrument().label} の日足を再取得しました（${Number(result?.fetchedCount) || 0}件）。`, "success");
  } catch (error) {
    if (!silent) setAppStatus(`日足の再取得エラー: ${error.message}`, "error");
  } finally {
    if (pendingSymbol === symbol) pendingSymbol = null;
    if (symbol === activeSymbol) marketChart.draw();
  }
}

async function selectInstrument(symbol) {
  activeSymbol = symbol;
  localStorage.setItem(INSTRUMENT_KEY, symbol);
  renderInstrumentTabs();
  marketChart.resetEndOffset();
  const requestId = ++loadRequestId;

  // 保存済みの日足を即表示してから、セッション初回だけ背景で最新を取得する
  if (!historyBySymbol.has(symbol)) {
    let cached = [];
    try {
      cached = await window.stockReviewApi.loadMarketPriceHistory(symbol);
    } catch (_error) {
      // キャッシュ読込失敗はオンライン取得で回復できるため継続する。
    }
    if (requestId !== loadRequestId) return;
    historyBySymbol.set(symbol, Array.isArray(cached) ? cached : []);
  }
  marketChart.draw();
  if (!refreshedSymbols.has(symbol) && pendingSymbol !== symbol) {
    refreshInstrument(symbol);
  }
}

INSTRUMENTS.forEach((instrument) => {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "market-instrument-tab";
  tab.dataset.symbol = instrument.symbol;
  tab.setAttribute("role", "tab");
  tab.textContent = instrument.label;
  tab.addEventListener("click", () => {
    if (instrument.symbol !== activeSymbol) selectInstrument(instrument.symbol);
  });
  instrumentTabs.appendChild(tab);
});

chartRefresh.addEventListener("click", async () => {
  if (pendingSymbol) return;
  chartRefresh.disabled = true;
  const previousText = chartRefresh.textContent;
  chartRefresh.textContent = "取得中...";
  try {
    await refreshInstrument(activeSymbol, { silent: false });
  } finally {
    chartRefresh.disabled = false;
    chartRefresh.textContent = previousText;
  }
});

// ---- 左右カラムの境界ドラッグ ----
// チャート/まとめ列とニュース列の比率を --market-split（%）で調整し、localStorageへ保存する。
// チャートの再描画は candlestickWrap の ResizeObserver が追従する。
const MARKET_SPLIT_KEY = "stock-review.marketSplitX";
const SPLIT_MIN = 35, SPLIT_MAX = 80;
const marketGrid = document.querySelector("#view-market .market-grid");
const colResizer = document.getElementById("market-col-resizer");

if (marketGrid && colResizer) {
  const applySplit = (percent) => {
    const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(percent)));
    if (!Number.isFinite(next)) return;
    marketGrid.style.setProperty("--market-split", `${next}%`);
  };
  const savedSplit = Number(localStorage.getItem(MARKET_SPLIT_KEY));
  if (Number.isFinite(savedSplit) && savedSplit > 0) applySplit(savedSplit);

  let draggingSplit = false;
  const moveSplit = (event) => {
    if (!draggingSplit) return;
    const rect = marketGrid.getBoundingClientRect();
    if (rect.width > 0) applySplit((event.clientX - rect.left) / rect.width * 100);
  };
  const finishSplit = () => {
    if (!draggingSplit) return;
    draggingSplit = false;
    colResizer.classList.remove("is-active");
    const value = parseFloat(marketGrid.style.getPropertyValue("--market-split"));
    if (Number.isFinite(value)) localStorage.setItem(MARKET_SPLIT_KEY, String(Math.round(value * 10) / 10));
    window.removeEventListener("pointermove", moveSplit);
    window.removeEventListener("pointerup", finishSplit);
    window.removeEventListener("pointercancel", finishSplit);
  };
  colResizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    draggingSplit = true;
    colResizer.classList.add("is-active");
    colResizer.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", moveSplit);
    window.addEventListener("pointerup", finishSplit);
    window.addEventListener("pointercancel", finishSplit);
  });
  colResizer.addEventListener("dblclick", () => {
    marketGrid.style.removeProperty("--market-split");
    localStorage.removeItem(MARKET_SPLIT_KEY);
  });
}

// 表示領域の変化（画面切替・リサイズ）に追従して再描画する
if (typeof ResizeObserver === "function") {
  let pendingFrame = 0;
  const observer = new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => marketChart.draw());
    });
  });
  observer.observe(candlestickWrap);
}

// ---- ニュースパネル ----

const NEWS_RELOAD_INTERVAL_MS = 15 * 60 * 1000;
const NEWS_STARTUP_RETRY_MS = 8000;
const NEWS_STARTUP_MAX_RETRIES = 3;

const newsList = document.getElementById("market-news-list");
const newsStatus = document.getElementById("market-news-status");
const newsRefresh = document.getElementById("market-news-refresh");

let newsLoading = false;

function setPlaceholder(container, message) {
  container.textContent = "";
  const paragraph = document.createElement("p");
  paragraph.className = "market-placeholder";
  paragraph.textContent = message;
  container.appendChild(paragraph);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

// ニュース本文は外部サイト由来のため、必ず textContent（エスケープ）で描画する
function renderNewsList(items) {
  if (!items.length) {
    setPlaceholder(newsList, "ニュースを取得できませんでした。「更新」で再試行できます。");
    return;
  }
  newsList.textContent = "";
  items.forEach((item) => {
    const card = document.createElement("a");
    card.className = "market-news-item";
    card.href = item.url;
    card.title = item.url;

    // サムネイル（https のみ許可。読み込み失敗時はカードから外す）
    if (typeof item.image === "string" && item.image.startsWith("https://")) {
      const thumb = document.createElement("img");
      thumb.className = "market-news-thumb";
      thumb.src = item.image;
      thumb.loading = "lazy";
      thumb.alt = "";
      thumb.addEventListener("error", () => thumb.remove());
      card.appendChild(thumb);
    }

    const title = document.createElement("div");
    title.className = "market-news-title";
    title.textContent = item.title;
    card.appendChild(title);

    if (item.snippet) {
      const snippet = document.createElement("div");
      snippet.className = "market-news-snippet";
      snippet.textContent = item.snippet;
      card.appendChild(snippet);
    }
    // メタ（ソース・時刻）はカード下端に固定する（.market-news-meta の margin-top: auto）
    const metaText = [item.source, formatDateTime(item.date)].filter(Boolean).join("　");
    if (metaText) {
      const meta = document.createElement("div");
      meta.className = "market-news-meta";
      meta.textContent = metaText;
      card.appendChild(meta);
    }
    newsList.appendChild(card);
  });
}

async function loadNews({ refresh = false } = {}) {
  if (newsLoading) return false;
  newsLoading = true;
  newsRefresh.disabled = true;
  newsStatus.textContent = "取得中...";
  try {
    const data = await api("GET", `/market/news${refresh ? "?refresh=true" : ""}`);
    const items = Array.isArray(data.items) ? data.items : [];
    renderNewsList(items);
    newsStatus.textContent = data.fetchedAt
      ? `${formatDateTime(data.fetchedAt)} 更新　${items.length}件`
      : "";
    return true;
  } catch (_error) {
    // バックエンド起動前・通信断。表示中の一覧はそのまま残す。
    newsStatus.textContent = "取得できませんでした";
    if (!newsList.querySelector(".market-news-item")) {
      setPlaceholder(newsList, "ニュースを取得できませんでした。「更新」で再試行できます。");
    }
    return false;
  } finally {
    newsLoading = false;
    newsRefresh.disabled = false;
  }
}

newsRefresh.addEventListener("click", () => loadNews({ refresh: true }));

// 起動直後はバックエンドの立ち上がりを待つ必要があるため、失敗したら少し置いて再試行する
async function loadNewsWithStartupRetry(attempt = 0) {
  const ok = await loadNews();
  if (!ok && attempt < NEWS_STARTUP_MAX_RETRIES) {
    setTimeout(() => loadNewsWithStartupRetry(attempt + 1), NEWS_STARTUP_RETRY_MS);
  }
}

setInterval(() => loadNews(), NEWS_RELOAD_INTERVAL_MS);

// ---- AIまとめパネル ----

const SUMMARY_CACHE_KEY = "stock-review.marketSummary";

const summaryBody = document.getElementById("market-summary-body");
const summaryStatus = document.getElementById("market-summary-status");
const summaryDate = document.getElementById("market-summary-date");
const summaryGenerate = document.getElementById("market-summary-generate");

let summaryStreaming = false;

function formatFullDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function setSummaryDate(generatedAt) {
  const formatted = generatedAt ? formatFullDateTime(generatedAt) : "";
  summaryDate.textContent = formatted ? `${formatted} 生成` : "";
}

// まとめのMarkdownを見出し（# / ## / ###）単位のセクションに分割する。
// 見出しが無い場合は全体を1セクションとして返す。
function splitSummarySections(markdown) {
  const lines = String(markdown || "").split("\n");
  const sections = [];
  let current = { heading: "", body: [] };
  const push = () => {
    if (current.heading || current.body.some((line) => line.trim())) {
      sections.push({ heading: current.heading, body: current.body.join("\n") });
    }
  };
  lines.forEach((line) => {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      push();
      current = { heading: match[1].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  });
  push();
  return sections.length ? sections : [{ heading: "", body: String(markdown || "") }];
}

// セクションごとのブロックを横並びで描画する
function renderSummaryBlocks(markdown) {
  summaryBody.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "market-summary-blocks";
  splitSummarySections(markdown).forEach(({ heading, body }) => {
    const block = document.createElement("section");
    block.className = "market-summary-block";
    if (heading) {
      const headingEl = document.createElement("h3");
      headingEl.textContent = heading;
      block.appendChild(headingEl);
    }
    const content = document.createElement("div");
    content.className = "market-summary-block-body";
    content.innerHTML = renderMarkdown(body);
    block.appendChild(content);
    wrap.appendChild(block);
  });
  summaryBody.appendChild(wrap);
}

function restoreSummaryCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || "null");
    if (!cached?.markdown) return;
    renderSummaryBlocks(cached.markdown);
    setSummaryDate(cached.generatedAt);
  } catch (_error) {
    // 壊れたキャッシュは無視（次回生成で上書き）
  }
}

async function generateSummary() {
  if (summaryStreaming) return;
  summaryStreaming = true;
  summaryGenerate.disabled = true;
  summaryStatus.textContent = "生成中...";
  let accumulated = "";
  await streamChat(0, [], {
    endpoint: "/market/summary",
    persistUser: false,
    persistAssistant: false,
    onToken: (token) => {
      accumulated += token;
      renderSummaryBlocks(accumulated);
    },
    onDone: () => {
      const generatedAt = new Date().toISOString();
      localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify({ markdown: accumulated, generatedAt }));
      setSummaryDate(generatedAt);
      summaryStatus.textContent = "";
    },
    onError: (message) => {
      const friendly = String(message).includes("503")
        ? "モデルが読み込まれていません。上部のモデル選択から起動してください。"
        : String(message).includes("404")
          ? "ニュースを取得できていません。先にニュースを更新してください。"
          : `生成に失敗しました: ${message}`;
      summaryStatus.textContent = "生成に失敗しました";
      if (!accumulated) setPlaceholder(summaryBody, friendly);
    }
  });
  summaryStreaming = false;
  summaryGenerate.disabled = false;
}

summaryGenerate.addEventListener("click", generateSummary);

restoreSummaryCache();
loadNewsWithStartupRetry();
selectInstrument(activeSymbol);
