// マーケットページ: 指数・為替のローソク足チャート。
// 日足は個別銘柄と同じ review_price_history へ蓄積し、チャート描画は
// candlestick-chart.js の共通モジュールを使う。ニュース・AIまとめは後続フェーズ。

import { createCandlestickChart } from "./candlestick-chart.js";
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
  storagePrefix: "stock-review.market",
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

selectInstrument(activeSymbol);
