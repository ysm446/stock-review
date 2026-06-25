import "./renderer-chat.js";
import "./renderer-settings.js";
import "./renderer-resources.js";
import { setStockReviewContext } from "./renderer-stock-chat.js";
import {
  allocationChart,
  allocationColorScheme,
  allocationGroupToggle,
  allocationLegend,
  cancelHoldingModalButton,
  cancelWatchlistModalButton,
  closeHoldingModalButton,
  closeWatchlistModalButton,
  exportPortfolioButton,
  holdingBuyPriceInput,
  holdingForm,
  holdingModalBackdrop,
  holdingModalTitle,
  holdingRowTemplate,
  holdingSharesInput,
  holdingTickerInput,
  holdingTickerSuggestions,
  holdingsBody,
  holdingsGroupToggle,
  holdingsHead,
  holdingsModeButtons,
  holdingsTable,
  importPortfolioButton,
  loadReviewButton,
  metricHelpPopup,
  metricHelpPopupText,
  metricHelpPopupTitle,
  navButtons,
  performanceChart,
  priceStatus,
  refreshPricesButton,
  reviewAnalystGrid,
  reviewChipRow,
  reviewFinancialBody,
  reviewHistoryButton,
  reviewHistoryDropdown,
  reviewNewsList,
  reviewOverviewGrid,
  reviewProfitabilityGrid,
  reviewSymbol,
  reviewTickerInput,
  reviewTickerSuggestions,
  reviewValuationGrid,
  statsGrid,
  submitHoldingModalButton,
  submitWatchlistModalButton,
  trendChart,
  trendChartWrap,
  trendDailyChange,
  trendPeriodChange,
  trendRangeSelect,
  trendYAxisSelect,
  addAnnotationButton,
  annotationModalBackdrop,
  annotationModalTitle,
  annotationForm,
  annotationDateInput,
  annotationTextInput,
  closeAnnotationModalButton,
  cancelAnnotationModalButton,
  deleteAnnotationButton,
  trendTooltip,
  trendTooltipChange,
  trendTooltipDate,
  trendTooltipValue,
  views,
  watchlistBody,
  watchlistForm,
  watchlistHead,
  watchlistModalBackdrop,
  watchlistModalTitle,
  watchlistModeButtons,
  watchlistRatingInput,
  watchlistRiskInput,
  watchlistRowTemplate,
  watchlistTable,
  watchlistThesisInput,
  watchlistTickerInput,
  watchlistTickerSuggestions
} from "./renderer-dom.js";
import {
  buildMetricHeaderCell,
  buildMetricToneStyle,
  buildPositiveMetricToneStyle,
  buildYieldToneStyle,
  clamp,
  formatCurrency,
  formatMaybeCurrency,
  formatMaybeMultiple,
  formatMaybeNumber,
  formatMaybePercent,
  formatMaybeYieldPercent,
  formatNormalizedPercent,
  formatPercent,
  formatPlainNumber,
  formatPriceWithDate,
  formatSignedCurrency,
  formatSignedPercent,
  formatStatementNumber,
  getMetricToneHelpText,
  normalizeSearchText,
  normalizeYieldPercentValue,
  parseNumericInput,
  parseWholeNumber,
  toFiniteNumber
} from "./renderer-utils.js";

const appState = {
  holdings: [],
  watchlist: [],
  trendHistory: [],
  dividendSummary: null,
  annotations: []
};

const stockMaster = {};

const CHART_COLOR_HUES = [210, 330, 180, 270];
const CHART_LIGHTNESS_LEVELS = [
  { lightness: 35, saturation: 80 },
  { lightness: 45, saturation: 75 },
  { lightness: 55, saturation: 65 },
  { lightness: 65, saturation: 55 }
];

const CHART_COLORS = CHART_COLOR_HUES.flatMap((hue) =>
  CHART_LIGHTNESS_LEVELS.map(
    ({ lightness, saturation }) => `hsl(${hue}, ${saturation}%, ${lightness}%)`
  )
);

// セクター別配色のキーカラー（業種ごとに割り当てる基準の色相）
const SECTOR_COLOR_HUES = [210, 160, 30, 280, 350, 110, 50, 190, 320, 0];
const SECTOR_FALLBACK_HUE = null; // セクター不明はグレースケール

const REVIEW_LABEL_HELP = {
  "PER": "株価が1株利益の何倍まで買われているかを見る指標です。",
  "PBR": "株価が1株純資産の何倍かを示す指標です。",
  "EV/EBITDA": "企業価値を営業キャッシュ創出力に近い利益で割った指標です。",
  "配当利回り": "現在の株価に対して、年間配当がどれくらいあるかを示します。",
  "ROE": "自己資本を使ってどれだけ効率よく利益を出したかを示します。",
  "ROA": "総資産全体を使ってどれだけ利益を出したかを示します。",
  "営業利益率": "売上高に対して本業の利益がどれだけ残るかを示します。",
  "FCFマージン": "売上高に対するフリーキャッシュフローの割合です。",
  "現在値": "直近で取得できた株価です。",
  "時価総額": "現在の株価に発行済株式数を掛けた企業価値の目安です。",
  "52週高値": "過去52週間で付けた最も高い株価です。",
  "52週安値": "過去52週間で付けた最も低い株価です。",
  "目標株価(平均)": "アナリスト予想の平均的な目標株価です。",
  "目標株価(高値)": "アナリスト予想の中で最も強気な目標株価です。",
  "目標株価(安値)": "アナリスト予想の中で最も弱気な目標株価です。",
  "アナリスト数": "目標株価や推奨を出しているアナリスト人数です。",
  "推奨": "アナリストの総合評価です。buy なら買い寄りです。"
};

let statusTimer = null;
let trendRange = "3m";
let trendYAxisMode = "relative";
let editingAnnotationId = null;
let editingHoldingIndex = null;
let autosaveTimer = null;
let stockMasterEntries = [];
let draggingHoldingIndex = null;
let draggingWatchlistIndex = null;
let trendChartModel = null;
let hoveredTrendIndex = null;
let resizeTimer = null;
let activeReviewTicker = "";
let reviewSnapshot = null;
let holdingSectorMap = {};
let holdingsDayChangeMode = "perShare";
let holdingsTableMode = "positions";
let holdingsGrouped = false;
let allocationGrouped = false;
let allocationColorMode = "default";
let watchlistTableMode = "positions";
let editingWatchlistIndex = null;
let activeMetricHelpTrigger = null;
const holdingMetricsByTicker = {};
const holdingMetricsLoading = new Set();

function activateView(view) {
  navButtons.forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
  views.forEach((panel) => panel.classList.toggle("is-visible", panel.id === `view-${view}`));
}

function getDayChangeToggleButton() {
  return document.getElementById("day-change-toggle");
}

function isJapaneseTicker(ticker) {
  return /\.T$/i.test(String(ticker || "").trim());
}

function positionMetricHelpPopup(trigger) {
  if (!metricHelpPopup || !trigger) {
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const popupWidth = Math.min(320, window.innerWidth - 24);
  const left = Math.min(
    window.innerWidth - popupWidth - 12,
    Math.max(12, rect.left + rect.width / 2 - popupWidth / 2)
  );
  const top = Math.min(window.innerHeight - 12, rect.bottom + 12);
  metricHelpPopup.style.left = `${left}px`;
  metricHelpPopup.style.top = `${top}px`;
}

function openMetricHelp(label, metricKey, trigger = null) {
  const helpText = getMetricToneHelpText(metricKey);
  if (!metricHelpPopup || !metricHelpPopupTitle || !metricHelpPopupText || !helpText) {
    return;
  }
  activeMetricHelpTrigger = trigger;
  metricHelpPopupTitle.textContent = `${label} の説明`;
  metricHelpPopupText.textContent = helpText;
  positionMetricHelpPopup(trigger);
  metricHelpPopup.classList.remove("is-hidden");
}

function closeMetricHelp() {
  if (!metricHelpPopup) {
    return;
  }
  metricHelpPopup.classList.add("is-hidden");
  activeMetricHelpTrigger = null;
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateView(button.dataset.view);
  });
});

document.getElementById("add-holding").addEventListener("click", () => {
  openHoldingModal();
});
document.getElementById("add-watchlist").addEventListener("click", () => {
  openWatchlistModal();
});
holdingsModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setHoldingsTableMode(button.dataset.mode || "positions");
  });
});
holdingsGroupToggle?.addEventListener("click", () => {
  holdingsGrouped = !holdingsGrouped;
  renderHoldingsGroupToggle();
  renderHoldingsTable();
});
allocationGroupToggle?.addEventListener("click", () => {
  allocationGrouped = !allocationGrouped;
  renderAllocationGroupToggle();
  drawAllocationChart();
  drawPerformanceChart();
});
allocationColorScheme?.addEventListener("change", () => {
  allocationColorMode = allocationColorScheme.value || "default";
  if (allocationColorMode === "sector") {
    refreshHoldingSectors();
  }
  drawAllocationChart();
});
watchlistModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setWatchlistTableMode(button.dataset.mode || "positions");
  });
});

loadReviewButton.addEventListener("click", () => {
  loadReviewSnapshot(reviewTickerInput.value);
});
exportPortfolioButton?.addEventListener("click", exportPortfolio);
importPortfolioButton?.addEventListener("click", importPortfolio);
reviewTickerInput.addEventListener("input", () => {
  renderReviewTickerSuggestions(reviewTickerInput.value);
});
reviewTickerInput.addEventListener("focus", () => {
  renderReviewTickerSuggestions(reviewTickerInput.value);
});
reviewTickerInput.addEventListener("blur", () => {
  setTimeout(() => {
    hideReviewTickerSuggestions();
  }, 120);
});
reviewTickerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadReviewSnapshot(reviewTickerInput.value);
  }
});

refreshPricesButton.addEventListener("click", refreshPrices);
trendRangeSelect.addEventListener("change", (event) => {
  trendRange = event.target.value;
  hoveredTrendIndex = null;
  hideTrendTooltip();
  drawTrendChart();
});
trendYAxisSelect.addEventListener("change", (event) => {
  trendYAxisMode = event.target.value;
  hoveredTrendIndex = null;
  hideTrendTooltip();
  drawTrendChart();
});
addAnnotationButton.addEventListener("click", () => {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  openAnnotationModal(null, `${y}-${m}-${d}`);
});
trendChart.addEventListener("click", (event) => {
  if (!trendChartModel || !trendChartModel.dates || !trendChartModel.dates.length) return;
  const rect = trendChart.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const { dates: chartDates, points: chartPoints } = trendChartModel;
  const firstTime = new Date(`${chartDates[0]}T00:00:00`).getTime();
  const lastTime = new Date(`${chartDates[chartDates.length - 1]}T00:00:00`).getTime();
  for (const ann of appState.annotations) {
    const targetTime = new Date(`${ann.date}T00:00:00`).getTime();
    if (targetTime < firstTime || targetTime > lastTime) continue;
    let nearestIdx = 0;
    let nearestDiff = Infinity;
    chartDates.forEach((d, i) => {
      const diff = Math.abs(new Date(`${d}T00:00:00`).getTime() - targetTime);
      if (diff < nearestDiff) { nearestDiff = diff; nearestIdx = i; }
    });
    if (Math.abs(cssX - chartPoints[nearestIdx].x) <= 10) {
      openAnnotationModal(ann);
      return;
    }
  }
});
closeAnnotationModalButton.addEventListener("click", closeAnnotationModal);
cancelAnnotationModalButton.addEventListener("click", closeAnnotationModal);
annotationModalBackdrop.addEventListener("click", (event) => {
  if (event.target === annotationModalBackdrop) closeAnnotationModal();
});
annotationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const date = annotationDateInput.value.trim();
  const text = annotationTextInput.value.trim();
  if (!date || !text) return;
  if (editingAnnotationId === null) {
    appState.annotations.push({ id: String(Date.now()), date, text });
  } else {
    const idx = appState.annotations.findIndex((a) => a.id === editingAnnotationId);
    if (idx >= 0) appState.annotations[idx] = { id: editingAnnotationId, date, text };
  }
  closeAnnotationModal();
  await window.stockReviewApi.saveAnnotations(appState.annotations);
  drawTrendChart();
});
deleteAnnotationButton.addEventListener("click", async () => {
  if (editingAnnotationId === null) return;
  appState.annotations = appState.annotations.filter((a) => a.id !== editingAnnotationId);
  closeAnnotationModal();
  await window.stockReviewApi.saveAnnotations(appState.annotations);
  drawTrendChart();
});
trendChart.addEventListener("mousemove", handleTrendChartPointerMove);
trendChart.addEventListener("mouseleave", () => {
  hoveredTrendIndex = null;
  hideTrendTooltip();
  drawTrendChart();
});
trendChart.addEventListener("touchstart", handleTrendChartPointerMove, { passive: true });
trendChart.addEventListener("touchmove", handleTrendChartPointerMove, { passive: true });
trendChart.addEventListener("touchend", () => {
  hoveredTrendIndex = null;
  hideTrendTooltip();
  drawTrendChart();
});
window.addEventListener("resize", () => {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    hoveredTrendIndex = null;
    hideTrendTooltip();
    drawTrendChart();
    drawAllocationChart();
  }, 80);
});
closeHoldingModalButton.addEventListener("click", closeHoldingModal);
cancelHoldingModalButton.addEventListener("click", closeHoldingModal);
holdingModalBackdrop.addEventListener("click", (event) => {
  if (event.target === holdingModalBackdrop) {
    closeHoldingModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (!holdingModalBackdrop.classList.contains("is-hidden")) {
    closeHoldingModal();
  }
  if (!watchlistModalBackdrop.classList.contains("is-hidden")) {
    closeWatchlistModal();
  }
  if (metricHelpPopup && !metricHelpPopup.classList.contains("is-hidden")) {
    closeMetricHelp();
  }
});
holdingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveHoldingFromModal();
});
closeWatchlistModalButton.addEventListener("click", closeWatchlistModal);
cancelWatchlistModalButton.addEventListener("click", closeWatchlistModal);
watchlistModalBackdrop.addEventListener("click", (event) => {
  if (event.target === watchlistModalBackdrop) {
    closeWatchlistModal();
  }
});
watchlistForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveWatchlistFromModal();
});
holdingTickerInput.addEventListener("input", () => {
  renderTickerSuggestions(holdingTickerInput.value);
});
holdingTickerInput.addEventListener("focus", () => {
  renderTickerSuggestions(holdingTickerInput.value);
});
holdingTickerInput.addEventListener("blur", () => {
  setTimeout(() => {
    hideTickerSuggestions();
  }, 120);
});
watchlistTickerInput.addEventListener("input", () => {
  renderWatchlistTickerSuggestions(watchlistTickerInput.value);
});
watchlistTickerInput.addEventListener("focus", () => {
  renderWatchlistTickerSuggestions(watchlistTickerInput.value);
});
watchlistTickerInput.addEventListener("blur", () => {
  setTimeout(() => {
    hideWatchlistTickerSuggestions();
  }, 120);
});
function handleMetricHelpMouseEnter(event) {
  const trigger = event.target.closest(".metric-help-label");
  if (!trigger) {
    return;
  }
  openMetricHelp(trigger.textContent.trim(), trigger.dataset.metricKey || "", trigger);
}

function handleMetricHelpMouseLeave(event, container) {
  if (!event.relatedTarget || !container.contains(event.relatedTarget)) {
    closeMetricHelp();
  }
}

function handleMetricHelpFocusIn(event) {
  const trigger = event.target.closest(".metric-help-label");
  if (!trigger) {
    return;
  }
  openMetricHelp(trigger.textContent.trim(), trigger.dataset.metricKey || "", trigger);
}

function handleMetricHelpFocusOut(event, container) {
  if (!event.relatedTarget || !container.contains(event.relatedTarget)) {
    closeMetricHelp();
  }
}

holdingsHead?.addEventListener("mouseenter", handleMetricHelpMouseEnter, true);
holdingsHead?.addEventListener("mouseleave", (event) => handleMetricHelpMouseLeave(event, holdingsHead), true);
holdingsHead?.addEventListener("focusin", handleMetricHelpFocusIn);
holdingsHead?.addEventListener("focusout", (event) => handleMetricHelpFocusOut(event, holdingsHead));
watchlistHead?.addEventListener("mouseenter", handleMetricHelpMouseEnter, true);
watchlistHead?.addEventListener("mouseleave", (event) => handleMetricHelpMouseLeave(event, watchlistHead), true);
watchlistHead?.addEventListener("focusin", handleMetricHelpFocusIn);
watchlistHead?.addEventListener("focusout", (event) => handleMetricHelpFocusOut(event, watchlistHead));

function normalizeHolding(raw) {
  const shares = parseWholeNumber(raw.shares);
  const buyPrice = parseWholeNumber(raw.buyPrice);
  const price = parseWholeNumber(raw.price);
  const previousClose = parseWholeNumber(raw.previousClose);
  const costBasis = shares * buyPrice;
  const marketValue = shares * price;
  const profitLoss = marketValue - costBasis;
  const profitRate = costBasis > 0 ? (profitLoss / costBasis) * 100 : 0;
  const dayChangePerShare = price > 0 && previousClose > 0 ? price - previousClose : 0;
  const dayChangeRate = previousClose > 0 ? (dayChangePerShare / previousClose) * 100 : 0;
  const dayChangeMarketValue = shares * dayChangePerShare;
  return {
    ticker: raw.ticker || "",
    shares,
    buyPrice,
    price,
    previousClose,
    note: raw.note || "",
    costBasis,
    marketValue,
    dayChange: dayChangePerShare,
    dayChangeMarketValue,
    dayChangeRate,
    profitLoss,
    profitRate
  };
}

function getHoldingsTableRows(groupedMode = holdingsGrouped) {
  if (!groupedMode) {
    return appState.holdings.map((holding, index) => ({
      holding,
      index,
      isGrouped: false,
      sourceCount: 1
    }));
  }

  const grouped = new Map();
  appState.holdings.forEach((holding, index) => {
    const ticker = String(holding.ticker || "").trim();
    const key = ticker ? ticker.toUpperCase() : `__empty_${index}`;
    const normalized = normalizeHolding(holding);
    const existing = grouped.get(key) || {
      ticker,
      shares: 0,
      costBasis: 0,
      marketValue: 0,
      previousCloseValue: 0,
      sourceCount: 0
    };
    existing.shares += normalized.shares;
    existing.costBasis += normalized.costBasis;
    existing.marketValue += normalized.marketValue;
    existing.previousCloseValue += normalized.previousClose * normalized.shares;
    existing.sourceCount += 1;
    grouped.set(key, existing);
  });

  return [...grouped.values()].map((item) => {
    const shares = item.shares;
    return {
      holding: {
        ticker: item.ticker,
        shares,
        buyPrice: shares > 0 ? item.costBasis / shares : 0,
        price: shares > 0 ? item.marketValue / shares : 0,
        previousClose: shares > 0 ? item.previousCloseValue / shares : 0
      },
      index: null,
      isGrouped: true,
      sourceCount: item.sourceCount
    };
  });
}

function renderDayChangeToggle() {
  const dayChangeToggleButton = getDayChangeToggleButton();
  if (!dayChangeToggleButton) {
    return;
  }
  const isMarketValue = holdingsDayChangeMode === "marketValue";
  dayChangeToggleButton.textContent = isMarketValue ? "前日比（評価額）" : "前日比";
  dayChangeToggleButton.setAttribute("aria-pressed", isMarketValue ? "true" : "false");
  dayChangeToggleButton.title = isMarketValue
    ? "クリックで1株あたりの前日比に切り替え"
    : "クリックで評価額ベースの前日比に切り替え";
}

function renderHoldingsTableModeToggle() {
  holdingsModeButtons.forEach((button) => {
    const active = button.dataset.mode === holdingsTableMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderHoldingsGroupToggle() {
  if (!holdingsGroupToggle) {
    return;
  }
  const isPositionsMode = holdingsTableMode === "positions";
  holdingsGroupToggle.classList.toggle("is-hidden", !isPositionsMode);
  holdingsGroupToggle.classList.toggle("is-active", holdingsGrouped);
  holdingsTable?.classList.toggle("grouped-mode", isPositionsMode && holdingsGrouped);
  holdingsGroupToggle.setAttribute("aria-pressed", holdingsGrouped ? "true" : "false");
  holdingsGroupToggle.textContent = holdingsGrouped ? "まとめ表示中" : "同一銘柄をまとめる";
}

function renderAllocationGroupToggle() {
  if (!allocationGroupToggle) {
    return;
  }
  allocationGroupToggle.classList.toggle("is-active", allocationGrouped);
  allocationGroupToggle.setAttribute("aria-pressed", allocationGrouped ? "true" : "false");
  allocationGroupToggle.textContent = allocationGrouped ? "まとめ表示中" : "同一銘柄をまとめる";
}

function renderHoldingsTableHead() {
  if (!holdingsHead) {
    return;
  }

  if (holdingsTableMode === "metrics") {
    holdingsHead.innerHTML = `
      <tr>
        <th>銘柄</th>
        <th>時価総額</th>
        <th>現在値</th>
        <th>52週高値</th>
        <th>52週安値</th>
        ${buildMetricHeaderCell("PER", "PER")}
        ${buildMetricHeaderCell("PBR", "PBR")}
        ${buildMetricHeaderCell("ROE", "ROE")}
        ${buildMetricHeaderCell("ROA", "ROA")}
        ${buildMetricHeaderCell("配当利回り", "dividendYield")}
      </tr>
    `;
    holdingsTable?.classList.add("metrics-mode");
    holdingsTable?.classList.remove("positions-mode");
    return;
  }

  holdingsHead.innerHTML = `
    <tr>
      <th class="drag-column"></th>
      <th>銘柄</th>
      <th>株数</th>
      <th>平均取得</th>
      <th>現在値</th>
      <th>
        <button type="button" class="table-toggle" id="day-change-toggle" aria-pressed="false">前日比</button>
      </th>
      <th>前日比%</th>
      <th>損益</th>
      <th>損益%</th>
      <th>評価額</th>
      <th>比率</th>
      <th></th>
    </tr>
  `;
  holdingsTable?.classList.add("positions-mode");
  holdingsTable?.classList.remove("metrics-mode");
  getDayChangeToggleButton()?.addEventListener("click", () => {
    holdingsDayChangeMode = holdingsDayChangeMode === "perShare" ? "marketValue" : "perShare";
    renderDayChangeToggle();
    renderHoldingsTable();
  });
  renderDayChangeToggle();
}

function setHoldingsTableMode(mode) {
  const nextMode = mode === "metrics" ? "metrics" : "positions";
  if (holdingsTableMode === nextMode) {
    return;
  }
  holdingsTableMode = nextMode;
  renderHoldingsTableModeToggle();
  renderHoldingsGroupToggle();
  renderHoldingsTableHead();
  renderHoldingsTable();
  if (holdingsTableMode === "metrics") {
    void ensureHoldingMetricsLoaded();
  }
}

function renderWatchlistTableModeToggle() {
  watchlistModeButtons.forEach((button) => {
    const active = button.dataset.mode === watchlistTableMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderWatchlistTableHead() {
  if (!watchlistHead) {
    return;
  }

  if (watchlistTableMode === "metrics") {
    watchlistHead.innerHTML = `
      <tr>
        <th>銘柄</th>
        <th>時価総額</th>
        <th>現在値</th>
        <th>52週高値</th>
        <th>52週安値</th>
        ${buildMetricHeaderCell("PER", "PER")}
        ${buildMetricHeaderCell("PBR", "PBR")}
        ${buildMetricHeaderCell("ROE", "ROE")}
        ${buildMetricHeaderCell("ROA", "ROA")}
        ${buildMetricHeaderCell("配当利回り", "dividendYield")}
      </tr>
    `;
    watchlistTable?.classList.add("metrics-mode");
    watchlistTable?.classList.remove("positions-mode");
    return;
  }

  watchlistHead.innerHTML = `
    <tr>
      <th class="drag-column"></th>
      <th>銘柄</th>
      <th>現在値</th>
      <th>前日比</th>
      <th>前日比%</th>
      <th></th>
    </tr>
  `;
  watchlistTable?.classList.add("positions-mode");
  watchlistTable?.classList.remove("metrics-mode");
}

function setWatchlistTableMode(mode) {
  const nextMode = mode === "metrics" ? "metrics" : "positions";
  if (watchlistTableMode === nextMode) {
    return;
  }
  watchlistTableMode = nextMode;
  renderWatchlistTableModeToggle();
  renderWatchlistTableHead();
  renderWatchlistTable();
  if (watchlistTableMode === "metrics") {
    void ensureHoldingMetricsLoaded();
  }
}

function getDisplayName(ticker) {
  const normalized = String(ticker || "").trim();
  return stockMaster[normalized] || normalized || "-";
}

function hideTickerSuggestions() {
  holdingTickerSuggestions.innerHTML = "";
  holdingTickerSuggestions.classList.add("is-hidden");
}

function applyTickerSuggestion(ticker) {
  holdingTickerInput.value = ticker;
  hideTickerSuggestions();
}

function hideWatchlistTickerSuggestions() {
  watchlistTickerSuggestions.innerHTML = "";
  watchlistTickerSuggestions.classList.add("is-hidden");
}

function applyWatchlistTickerSuggestion(ticker) {
  watchlistTickerInput.value = ticker;
  hideWatchlistTickerSuggestions();
}

function renderTickerSuggestions(keyword) {
  const normalizedKeyword = normalizeSearchText(keyword);
  if (!normalizedKeyword) {
    hideTickerSuggestions();
    return;
  }

  const matches = stockMasterEntries
    .filter(({ ticker, name }) => {
      const tickerText = normalizeSearchText(ticker);
      const nameText = normalizeSearchText(name);
      return tickerText.includes(normalizedKeyword) || nameText.includes(normalizedKeyword);
    })
    .slice(0, 8);

  if (!matches.length) {
    hideTickerSuggestions();
    return;
  }

  holdingTickerSuggestions.innerHTML = "";
  matches.forEach(({ ticker, name }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-option";
    item.innerHTML = `
      <span class="search-option-name">${name}</span>
      <span class="search-option-code">${ticker}</span>
    `;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyTickerSuggestion(ticker);
    });
    holdingTickerSuggestions.appendChild(item);
  });
  holdingTickerSuggestions.classList.remove("is-hidden");
}

function renderWatchlistTickerSuggestions(keyword) {
  const normalizedKeyword = normalizeSearchText(keyword);
  if (!normalizedKeyword) {
    hideWatchlistTickerSuggestions();
    return;
  }

  const matches = stockMasterEntries
    .filter(({ ticker, name }) => {
      const tickerText = normalizeSearchText(ticker);
      const nameText = normalizeSearchText(name);
      return tickerText.includes(normalizedKeyword) || nameText.includes(normalizedKeyword);
    })
    .slice(0, 8);

  if (!matches.length) {
    hideWatchlistTickerSuggestions();
    return;
  }

  watchlistTickerSuggestions.innerHTML = "";
  matches.forEach(({ ticker, name }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-option";
    item.innerHTML = `
      <span class="search-option-name">${name}</span>
      <span class="search-option-code">${ticker}</span>
    `;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyWatchlistTickerSuggestion(ticker);
    });
    watchlistTickerSuggestions.appendChild(item);
  });
  watchlistTickerSuggestions.classList.remove("is-hidden");
}

function hideReviewTickerSuggestions() {
  reviewTickerSuggestions.innerHTML = "";
  reviewTickerSuggestions.classList.add("is-hidden");
}

function applyReviewTickerSuggestion(ticker) {
  reviewTickerInput.value = ticker;
  hideReviewTickerSuggestions();
  loadReviewSnapshot(ticker);
}

function renderReviewTickerSuggestions(keyword) {
  const normalizedKeyword = normalizeSearchText(keyword);
  if (!normalizedKeyword) {
    hideReviewTickerSuggestions();
    return;
  }

  const matches = stockMasterEntries
    .filter(({ ticker, name }) => {
      const tickerText = normalizeSearchText(ticker);
      const nameText = normalizeSearchText(name);
      return tickerText.includes(normalizedKeyword) || nameText.includes(normalizedKeyword);
    })
    .slice(0, 8);

  if (!matches.length) {
    hideReviewTickerSuggestions();
    return;
  }

  reviewTickerSuggestions.innerHTML = "";
  matches.forEach(({ ticker, name }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-option";
    item.innerHTML = `
      <span class="search-option-name">${name}</span>
      <span class="search-option-code">${ticker}</span>
    `;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyReviewTickerSuggestion(ticker);
    });
    reviewTickerSuggestions.appendChild(item);
  });
  reviewTickerSuggestions.classList.remove("is-hidden");
}


function getDisplayDividendYieldPercent(snapshot) {
  const overview = snapshot?.overview || {};
  const valuation = snapshot?.valuation || {};
  const currentPrice = toFiniteNumber(overview.currentPrice);
  const dividendRate = toFiniteNumber(valuation.dividendRate);
  const trailingDividendRate = toFiniteNumber(valuation.trailingAnnualDividendRate);
  const rawYield = normalizeYieldPercentValue(valuation.dividendYield);

  if (currentPrice && currentPrice > 0) {
    if (dividendRate && dividendRate > 0) {
      return dividendRate / currentPrice;
    }
    if (trailingDividendRate && trailingDividendRate > 0) {
      return trailingDividendRate / currentPrice;
    }
  }

  return rawYield === null ? null : rawYield / 100;
}


function getHoldingMetricSnapshot(ticker) {
  return holdingMetricsByTicker[String(ticker || "").trim().toUpperCase()] || null;
}

function getJapaneseHoldings() {
  return appState.holdings.filter((holding) => isJapaneseTicker(holding.ticker));
}

function getUniqueJapaneseHoldings() {
  const seen = new Set();
  return getJapaneseHoldings().filter((holding) => {
    const ticker = String(holding.ticker || "").trim().toUpperCase();
    if (!ticker || seen.has(ticker)) {
      return false;
    }
    seen.add(ticker);
    return true;
  });
}

function getUniqueJapaneseWatchlist() {
  const seen = new Set();
  return appState.watchlist.filter((item) => {
    const ticker = String(item.ticker || "").trim().toUpperCase();
    if (!ticker || !isJapaneseTicker(ticker) || seen.has(ticker)) {
      return false;
    }
    seen.add(ticker);
    return true;
  });
}

async function ensureHoldingMetricsLoaded() {
  const tickers = [...getUniqueJapaneseHoldings(), ...getUniqueJapaneseWatchlist()]
    .map((item) => String(item.ticker || "").trim().toUpperCase())
    .filter(Boolean);

  const missingTickers = tickers.filter((ticker) => !getHoldingMetricSnapshot(ticker) && !holdingMetricsLoading.has(ticker));
  if (!missingTickers.length) {
    return;
  }

  missingTickers.forEach((ticker) => holdingMetricsLoading.add(ticker));

  try {
    const snapshots = await Promise.all(
      missingTickers.map(async (ticker) => {
        try {
          const snapshot = await window.stockReviewApi.fetchReview(ticker);
          return [ticker, snapshot];
        } catch (_error) {
          return [ticker, null];
        }
      })
    );

    snapshots.forEach(([ticker, snapshot]) => {
      holdingMetricsByTicker[ticker] = snapshot;
    });
  } finally {
    missingTickers.forEach((ticker) => holdingMetricsLoading.delete(ticker));
    if (holdingsTableMode === "metrics") {
      renderHoldingsTable();
    }
    if (watchlistTableMode === "metrics") {
      renderWatchlistTable();
    }
  }
}

function setStatus(message, tone = "neutral") {
  if (tone === "neutral" || !message) {
    priceStatus.textContent = "";
    priceStatus.classList.remove("is-error", "is-success");
    priceStatus.classList.add("is-hidden");
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    return;
  }

  priceStatus.textContent = message;
  priceStatus.classList.remove("is-hidden");
  priceStatus.classList.remove("is-error", "is-success");
  if (tone === "error") {
    priceStatus.classList.add("is-error");
  }
  if (tone === "success") {
    priceStatus.classList.add("is-success");
  }

  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }

  if (tone !== "neutral") {
    statusTimer = setTimeout(() => {
      setStatus("", "neutral");
    }, 4000);
  }
}

async function persistPortfolio({ silent = false } = {}) {
  const result = await window.stockReviewApi.savePortfolio({
    holdings: appState.holdings,
    watchlist: appState.watchlist
  });
  appState.trendHistory = Array.isArray(result?.trendHistory) ? result.trendHistory : [];
  renderPortfolioSummary();
  if (!silent) {
    setStatus("保存しました。", "success");
  }
}

async function applyPortfolioState(data) {
  appState.holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  appState.watchlist = Array.isArray(data?.watchlist) ? data.watchlist : [];
  appState.trendHistory = Array.isArray(data?.trendHistory) ? data.trendHistory : [];
  render();
  if (holdingsTableMode === "metrics") {
    await ensureHoldingMetricsLoaded();
  }
  await refreshDividendSummary();
  await refreshHoldingSectors();
}

async function exportPortfolio() {
  exportPortfolioButton.disabled = true;
  const previousText = exportPortfolioButton.textContent;
  exportPortfolioButton.textContent = "Exporting...";

  try {
    const result = await window.stockReviewApi.exportPortfolio();
    if (result?.canceled) {
      setStatus("エクスポートをキャンセルしました。", "neutral");
      return;
    }
    setStatus(`エクスポートしました: ${result.filePath}`, "success");
  } catch (error) {
    setStatus(`エクスポートエラー: ${error.message}`, "error");
  } finally {
    exportPortfolioButton.disabled = false;
    exportPortfolioButton.textContent = previousText;
  }
}

async function importPortfolio() {
  const confirmed = window.confirm("現在の保有銘柄とウォッチリストを、選択したファイルの内容で置き換えます。続けますか？");
  if (!confirmed) {
    return;
  }

  importPortfolioButton.disabled = true;
  const previousText = importPortfolioButton.textContent;
  importPortfolioButton.textContent = "Importing...";

  try {
    const result = await window.stockReviewApi.importPortfolio();
    if (result?.canceled) {
      setStatus("インポートをキャンセルしました。", "neutral");
      return;
    }
    await applyPortfolioState(result?.portfolio || {});
    setStatus(`インポートしました: ${result.filePath}`, "success");
  } catch (error) {
    setStatus(`インポートエラー: ${error.message}`, "error");
  } finally {
    importPortfolioButton.disabled = false;
    importPortfolioButton.textContent = previousText;
  }
}

function queueAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    persistPortfolio({ silent: true }).catch((error) => {
      setStatus(`保存エラー: ${error.message}`, "error");
    });
  }, 250);
}

async function refreshDividendSummary() {
  const hasHoldings = appState.holdings.some((holding) => String(holding.ticker || "").trim());
  if (!hasHoldings) {
    appState.dividendSummary = null;
    renderStats();
    return;
  }

  try {
    const summary = await window.stockReviewApi.loadDividendSummary(appState.holdings);
    appState.dividendSummary = summary || null;
  } catch (_error) {
    appState.dividendSummary = null;
  }
  renderStats();
}

async function refreshHoldingSectors() {
  const tickers = [...appState.holdings, ...appState.watchlist]
    .map((item) => String(item.ticker || "").trim())
    .filter(Boolean);

  if (!tickers.length) {
    holdingSectorMap = {};
    drawAllocationChart();
    return;
  }

  try {
    const result = await window.stockReviewApi.loadHoldingSectors(tickers);
    holdingSectorMap = result?.sectors || {};
  } catch (_error) {
    holdingSectorMap = {};
  }

  drawAllocationChart();
}

function getHoldingSector(ticker) {
  const info = holdingSectorMap[String(ticker || "").trim()];
  const sector = info && typeof info === "object" ? info.sector : info;
  return String(sector || "").trim();
}

// 保有銘柄リスト（描画順）に対応した色の配列を、現在の配色モードに従って生成する。
function buildAllocationColors(holdings) {
  if (allocationColorMode === "sector") {
    return buildSectorColors(holdings);
  }
  return holdings.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]);
}

// セクターごとにキーとなる色相を割り当て、同一セクター内は明度・彩度のグラデーションで区別する。
function buildSectorColors(holdings) {
  const sectorHue = new Map();
  const sectorTotal = new Map();
  let hueCursor = 0;

  holdings.forEach((holding) => {
    const sector = getHoldingSector(holding.ticker);
    const key = sector || "__unknown";
    if (!sectorHue.has(key)) {
      sectorHue.set(key, sector ? SECTOR_COLOR_HUES[hueCursor++ % SECTOR_COLOR_HUES.length] : SECTOR_FALLBACK_HUE);
    }
    sectorTotal.set(key, (sectorTotal.get(key) || 0) + 1);
  });

  const sectorSeen = new Map();
  return holdings.map((holding) => {
    const sector = getHoldingSector(holding.ticker);
    const key = sector || "__unknown";
    const hue = sectorHue.get(key);
    const count = sectorTotal.get(key) || 1;
    const pos = sectorSeen.get(key) || 0;
    sectorSeen.set(key, pos + 1);
    const t = count > 1 ? pos / (count - 1) : 0;

    if (hue === null) {
      // セクター不明: グレーのグラデーション
      const lightness = 58 - t * 26;
      return `hsl(220, 8%, ${lightness}%)`;
    }
    const lightness = 62 - t * 30;
    const saturation = 58 + t * 22;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  });
}

function prepareHiDPICanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const logicalWidth = Math.max(1, Math.round(rect.width || canvas.clientWidth || canvas.width));
  const logicalHeight = Math.max(1, Math.round(rect.height || canvas.clientHeight || canvas.height));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(logicalWidth * dpr);
  const pixelHeight = Math.round(logicalHeight * dpr);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, logicalWidth, logicalHeight);

  return { ctx, width: logicalWidth, height: logicalHeight };
}

function hideTrendTooltip() {
  trendTooltip.classList.add("is-hidden");
  trendTooltipChange.classList.remove("is-positive", "is-negative");
}

function openAnnotationModal(ann, defaultDate) {
  editingAnnotationId = ann ? ann.id : null;
  annotationModalTitle.textContent = ann ? "注記を編集" : "注記を追加";
  annotationDateInput.value = ann ? ann.date : (defaultDate || "");
  annotationTextInput.value = ann ? ann.text : "";
  deleteAnnotationButton.classList.toggle("is-hidden", !ann);
  annotationModalBackdrop.classList.remove("is-hidden");
  annotationTextInput.focus();
}

function closeAnnotationModal() {
  editingAnnotationId = null;
  annotationModalBackdrop.classList.add("is-hidden");
}

function updateTrendTooltip(index) {
  if (!trendChartModel || index < 0 || index >= trendChartModel.points.length) {
    hideTrendTooltip();
    return;
  }

  const { labels, values, points, padding, width, height } = trendChartModel;
  const point = points[index];
  const previousValue = index > 0 ? values[index - 1] : values[index];
  const delta = values[index] - previousValue;
  const rate = previousValue > 0 ? (delta / previousValue) * 100 : 0;
  const wrapWidth = trendChartWrap.clientWidth;
  const wrapHeight = trendChartWrap.clientHeight;
  const chartLeft = (point.x / width) * wrapWidth;
  const chartTop = (point.y / height) * wrapHeight;
  const tooltipWidth = 236;
  const tooltipLeft = Math.min(
    wrapWidth - tooltipWidth - 14,
    Math.max(padding.left + 8, chartLeft + 18)
  );
  const tooltipTop = Math.max(14, chartTop - 62);

  trendTooltipDate.textContent = labels[index];
  trendTooltipValue.textContent = formatCurrency(values[index]);
  trendTooltipChange.textContent =
    index === 0 ? "前日比 -"
    : `前日比 ${formatSignedCurrency(delta)} (${formatSignedPercent(rate)})`;
  trendTooltipChange.classList.toggle("is-positive", delta >= 0 || index === 0);
  trendTooltipChange.classList.toggle("is-negative", delta < 0 && index !== 0);
  trendTooltip.style.left = `${tooltipLeft}px`;
  trendTooltip.style.top = `${tooltipTop}px`;
  trendTooltip.classList.remove("is-hidden");
}

function handleTrendChartPointerMove(event) {
  if (!trendChartModel || !trendChartModel.points.length) {
    return;
  }

  const rect = trendChart.getBoundingClientRect();
  const clientX = "touches" in event ? event.touches[0]?.clientX : event.clientX;
  const clientY = "touches" in event ? event.touches[0]?.clientY : event.clientY;
  if (typeof clientX !== "number" || typeof clientY !== "number") {
    return;
  }

  const scaleX = trendChartModel.width / rect.width;
  const scaleY = trendChartModel.height / rect.height;
  const pointerX = (clientX - rect.left) * scaleX;
  const pointerY = (clientY - rect.top) * scaleY;
  const { padding, points } = trendChartModel;

  if (
    pointerX < padding.left - 12 ||
    pointerX > trendChartModel.width - padding.right + 12 ||
    pointerY < padding.top - 12 ||
    pointerY > trendChartModel.height - padding.bottom + 12
  ) {
    hoveredTrendIndex = null;
    hideTrendTooltip();
    drawTrendChart();
    return;
  }

  let nearestIndex = 0;
  let minDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const distance = Math.abs(point.x - pointerX);
    if (distance < minDistance) {
      minDistance = distance;
      nearestIndex = index;
    }
  });

  if (hoveredTrendIndex !== nearestIndex) {
    hoveredTrendIndex = nearestIndex;
    updateTrendTooltip(nearestIndex);
    drawTrendChart();
    return;
  }

  updateTrendTooltip(nearestIndex);
}

function moveHolding(fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex === null ||
    toIndex === null ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= appState.holdings.length ||
    toIndex >= appState.holdings.length
  ) {
    return false;
  }

  const [movedHolding] = appState.holdings.splice(fromIndex, 1);
  appState.holdings.splice(toIndex, 0, movedHolding);
  return true;
}

function moveWatchlist(fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= appState.watchlist.length ||
    toIndex >= appState.watchlist.length
  ) {
    return false;
  }

  const [movedItem] = appState.watchlist.splice(fromIndex, 1);
  appState.watchlist.splice(toIndex, 0, movedItem);
  return true;
}

function clearHoldingDragState() {
  holdingsBody.querySelectorAll("tr").forEach((row) => {
    row.classList.remove("is-dragging", "is-drag-target");
  });
}

function attachHoldingDragEvents(row, index) {
  const handle = row.querySelector('[data-action="drag-handle"]');
  handle.draggable = true;

  handle.addEventListener("dragstart", (event) => {
    draggingHoldingIndex = index;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
  });

  row.addEventListener("dragover", (event) => {
    if (draggingHoldingIndex === null || draggingHoldingIndex === index) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    holdingsBody.querySelectorAll("tr.is-drag-target").forEach((item) => {
      if (item !== row) {
        item.classList.remove("is-drag-target");
      }
    });
    row.classList.add("is-drag-target");
  });

  row.addEventListener("dragleave", (event) => {
    if (!row.contains(event.relatedTarget)) {
      row.classList.remove("is-drag-target");
    }
  });

  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("is-drag-target");

    if (moveHolding(draggingHoldingIndex, index)) {
      render();
      queueAutosave();
    }
  });

  handle.addEventListener("dragend", () => {
    draggingHoldingIndex = null;
    clearHoldingDragState();
  });
}

function attachWatchlistDragEvents(row, index) {
  row.dataset.index = String(index);
  const handle = row.querySelector('[data-action="drag-handle"]');
  if (!handle) {
    return;
  }

  handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    draggingWatchlistIndex = index;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
  });

  row.addEventListener("dragover", (event) => {
    if (draggingWatchlistIndex === null || draggingWatchlistIndex === index) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    watchlistBody.querySelectorAll("tr.is-drag-target").forEach((item) => {
      if (item !== row) {
        item.classList.remove("is-drag-target");
      }
    });
    row.classList.add("is-drag-target");
  });

  row.addEventListener("dragleave", (event) => {
    const related = event.relatedTarget;
    if (!related || !row.contains(related)) {
      row.classList.remove("is-drag-target");
    }
  });

  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("is-drag-target");
    if (draggingWatchlistIndex === null || draggingWatchlistIndex === index) {
      return;
    }
    if (moveWatchlist(draggingWatchlistIndex, index)) {
      renderWatchlistTable();
      queueAutosave();
    }
  });

  handle.addEventListener("dragend", () => {
    draggingWatchlistIndex = null;
    row.classList.remove("is-dragging", "is-drag-target");
    watchlistBody.querySelectorAll("tr").forEach((item) => {
      item.classList.remove("is-dragging", "is-drag-target");
    });
  });
}

function countUniqueTickers(holdings) {
  const tickers = new Set();
  holdings.forEach((item) => {
    const ticker = String(item.ticker || "").trim().toUpperCase();
    if (ticker) {
      tickers.add(ticker);
    }
  });
  return tickers.size;
}

function calculateStats() {
  const holdings = appState.holdings.map(normalizeHolding);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  const totalPositions = countUniqueTickers(holdings);

  return [
    {
      label: "総評価額",
      value: formatCurrency(totalValue),
      sub: "保有銘柄の合計"
    },
    {
      label: "保有銘柄数",
      value: `${totalPositions}`,
      sub: "入力済みポジション"
    }
  ];
}

function buildTopStats() {
  const holdings = appState.holdings.map(normalizeHolding);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  const totalCost = holdings.reduce((sum, item) => sum + item.costBasis, 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitRate = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  const totalPositions = countUniqueTickers(holdings);
  const totalAnnualDividend = parseNumericInput(appState.dividendSummary?.totalAnnualDividendJpy);

  return [
    { label: "総評価額", value: formatCurrency(totalValue), sub: "" },
    { label: "総取得金額", value: formatCurrency(totalCost), sub: "" },
    {
      label: "総損益",
      value: formatSignedCurrency(totalProfit),
      sub: totalCost > 0 ? formatSignedPercent(totalProfitRate) : "-",
      tone: totalProfit >= 0 ? "positive" : "negative"
    },
    {
      label: "年間配当金",
      value: totalAnnualDividend > 0 ? formatCurrency(totalAnnualDividend) : "-",
      sub: "",
      tone: "accent"
    },
    { label: "保有銘柄数", value: `${totalPositions}`, sub: "" }
  ];
}

function renderStats() {
  statsGrid.innerHTML = "";
  for (const stat of buildTopStats()) {
    const card = document.createElement("article");
    card.className = "stat-card";
    if (stat.tone) {
      card.classList.add(`stat-card-${stat.tone}`);
    }
    card.innerHTML = `
      <div class="stat-label">${stat.label}</div>
      <div class="stat-value">${stat.value}</div>
      <div class="stat-sub">${stat.sub}</div>
    `;
    statsGrid.appendChild(card);
  }
}

function renderPortfolioSummary() {
  renderStats();
  drawTrendChart();
  drawAllocationChart();
}

function openHoldingModal(index = null) {
  editingHoldingIndex = index;
  const holding = index === null ? { ticker: "", shares: "", buyPrice: "" } : appState.holdings[index];
  holdingModalTitle.textContent = index === null ? "銘柄を追加" : "銘柄を編集";
  submitHoldingModalButton.textContent = index === null ? "追加" : "更新";
  holdingTickerInput.value = holding.ticker || "";
  holdingSharesInput.value = holding.shares || "";
  holdingBuyPriceInput.value = holding.buyPrice || "";
  holdingModalBackdrop.classList.remove("is-hidden");
  hideTickerSuggestions();
  holdingTickerInput.focus();
}

function closeHoldingModal() {
  editingHoldingIndex = null;
  holdingForm.reset();
  hideTickerSuggestions();
  holdingModalBackdrop.classList.add("is-hidden");
}

function saveHoldingFromModal() {
  const ticker = holdingTickerInput.value.trim();
  const shares = parseWholeNumber(holdingSharesInput.value);
  const buyPrice = parseWholeNumber(holdingBuyPriceInput.value);

  if (!ticker || shares <= 0 || buyPrice <= 0) {
    setStatus("銘柄コード、株数、買値を正しく入力してください。", "error");
    return;
  }

  const nextHolding = {
    ...(editingHoldingIndex === null ? {} : appState.holdings[editingHoldingIndex]),
    ticker,
    shares: String(shares),
    buyPrice: String(buyPrice)
  };

  if (editingHoldingIndex === null) {
    appState.holdings.push({ ...nextHolding, price: "", note: nextHolding.note || "" });
  } else {
    appState.holdings[editingHoldingIndex] = nextHolding;
  }

  closeHoldingModal();
  render();
  refreshDividendSummary();
  refreshHoldingSectors();
  queueAutosave();
}

function openWatchlistModal(index = null) {
  editingWatchlistIndex = index;
  const item = index === null
    ? { ticker: "", rating: "B", thesis: "", risk: "" }
    : appState.watchlist[index];
  watchlistModalTitle.textContent = index === null ? "ウォッチリストに追加" : "ウォッチリストを編集";
  submitWatchlistModalButton.textContent = index === null ? "追加" : "更新";
  watchlistTickerInput.value = item.ticker || "";
  watchlistRatingInput.value = item.rating || "B";
  watchlistThesisInput.value = item.thesis || "";
  watchlistRiskInput.value = item.risk || "";
  watchlistModalBackdrop.classList.remove("is-hidden");
  hideWatchlistTickerSuggestions();
  watchlistTickerInput.focus();
}

function closeWatchlistModal() {
  editingWatchlistIndex = null;
  watchlistForm.reset();
  hideWatchlistTickerSuggestions();
  watchlistModalBackdrop.classList.add("is-hidden");
}

function saveWatchlistFromModal() {
  const ticker = watchlistTickerInput.value.trim();
  if (!ticker) {
    setStatus("ウォッチする銘柄コードを入力してください。", "error");
    return;
  }

  const nextItem = {
    ...(editingWatchlistIndex === null ? {} : appState.watchlist[editingWatchlistIndex]),
    ticker,
    rating: watchlistRatingInput.value.trim() || "B",
    thesis: watchlistThesisInput.value.trim(),
    risk: watchlistRiskInput.value.trim()
  };

  if (editingWatchlistIndex === null) {
    appState.watchlist.push(nextItem);
  } else {
    appState.watchlist[editingWatchlistIndex] = nextItem;
  }

  closeWatchlistModal();
  render();
  refreshHoldingSectors();
  queueAutosave();
}

function getRangeConfig(range) {
  switch (range) {
    case "3m":
      return { days: 92, labelEvery: 14, volatility: 0.028, drift: 0.1 };
    case "6m":
      return { days: 184, labelEvery: 28, volatility: 0.036, drift: 0.16 };
    case "1y":
      return { days: 366, labelEvery: 56, volatility: 0.05, drift: 0.24 };
    case "1m":
    default:
      return { days: 32, labelEvery: 4, volatility: 0.022, drift: 0.06 };
  }
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function shiftToPreviousBusinessDay(date) {
  const current = new Date(date);
  while (isWeekend(current)) {
    current.setDate(current.getDate() - 1);
  }
  return current;
}

function getRecentBusinessDates(count, anchorDate = new Date()) {
  const dates = [];
  const cursor = shiftToPreviousBusinessDay(anchorDate);
  while (dates.length < count) {
    if (!isWeekend(cursor)) {
      dates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates.reverse();
}

function buildXAxisTickIndexes(length, targetTicks = 8) {
  if (length <= 1) {
    return [0];
  }

  const tickCount = Math.min(length, Math.max(2, targetTicks));
  const lastIndex = length - 1;
  const indexes = [];
  for (let step = 0; step < tickCount; step += 1) {
    const ratio = tickCount === 1 ? 1 : step / (tickCount - 1);
    indexes.push(Math.round(lastIndex * ratio));
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function buildTrendSeriesFromHistory(range) {
  const source = Array.isArray(appState.trendHistory) ? appState.trendHistory : [];
  if (!source.length) {
    return null;
  }

  const sorted = source
    .map((item) => ({
      date: String(item.date || "").trim(),
      value: parseNumericInput(item.value)
    }))
    .filter((item) => {
      if (!item.date || item.value <= 0) {
        return false;
      }
      return !isWeekend(new Date(`${item.date}T00:00:00`));
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < 2) {
    return null;
  }

  const { days, labelEvery } = getRangeConfig(range);
  const lastDate = new Date(`${sorted[sorted.length - 1].date}T00:00:00`);
  const startDate = new Date(lastDate);
  startDate.setDate(lastDate.getDate() - (days - 1));
  const filtered = sorted.filter((item) => new Date(`${item.date}T00:00:00`) >= startDate);
  const target = filtered.length >= 2 ? filtered : sorted.slice(-days);
  if (target.length < 2) {
    return null;
  }

  return {
    labels: target.map((item) => {
      const date = new Date(`${item.date}T00:00:00`);
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }),
    values: target.map((item) => item.value),
    dates: target.map((item) => item.date),
    labelEvery
  };
}

function buildTrendSeries(totalValue, holdingsCount, range) {
  const historicalSeries = buildTrendSeriesFromHistory(range);
  if (historicalSeries) {
    return historicalSeries;
  }

  const safeTotal = totalValue > 0 ? totalValue : 12000000;
  const { days, labelEvery, volatility, drift } = getRangeConfig(range);
  const points = days;
  const businessDates = getRecentBusinessDates(points);
  const labels = [];
  const values = [];
  const base = safeTotal * (1 - drift);
  const strength = Math.max(1, holdingsCount);

  for (let index = 0; index < points; index += 1) {
    const progress = points === 1 ? 1 : index / (points - 1);
    const waveA = Math.sin(progress * Math.PI * 2.4 + strength * 0.33) * volatility * 0.7;
    const waveB = Math.cos(progress * Math.PI * 5.3 + strength * 0.18) * volatility * 0.42;
    const bias = (progress - 0.5) * drift * 0.65;
    const value = index === points - 1 ? safeTotal : base * (1 + bias + waveA + waveB);
    values.push(Math.max(value, safeTotal * 0.55));

    const date = businessDates[index];
    labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
  }

  if (values.length >= 2) {
    values[values.length - 2] = values[values.length - 1] * (0.965 + ((strength % 5) * 0.007));
  }

  const dates = businessDates.map((d) => {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dy = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${dy}`;
  });

  return { labels, values, dates, labelEvery };
}

function drawSmoothPath(ctx, points) {
  if (!points.length) {
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  if (points.length === 1) {
    return;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const prev = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const nextNext = points[index + 2] || next;

    const cp1x = current.x + (next.x - prev.x) / 6;
    const cp1y = current.y + (next.y - prev.y) / 6;
    const cp2x = next.x - (nextNext.x - current.x) / 6;
    const cp2y = next.y - (nextNext.y - current.y) / 6;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, next.x, next.y);
  }
}

function drawTrendChart() {
  const { ctx, width, height } = prepareHiDPICanvas(trendChart);
  const padding = { top: 24, right: 18, bottom: 34, left: 66 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const totalValue = appState.holdings.map(normalizeHolding).reduce((sum, item) => sum + item.marketValue, 0);
  const holdingsCount = appState.holdings.filter((item) => String(item.ticker || "").trim()).length;
  const { labels, values, dates } = buildTrendSeries(totalValue, holdingsCount, trendRange);

  ctx.clearRect(0, 0, width, height);

  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const valuePadding = Math.max((maxValue - minValue) * 0.18, maxValue * 0.03, 100000);
  const topValue = maxValue + valuePadding;
  const bottomValue = trendYAxisMode === "absolute" ? 0 : Math.max(0, minValue - valuePadding * 0.8);
  const yTicks = 5;
  const xStep = labels.length > 1 ? chartWidth / (labels.length - 1) : 0;

  ctx.strokeStyle = "rgba(55, 65, 81, 0.7)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  for (let i = 0; i < yTicks; i += 1) {
    const y = padding.top + (chartHeight / (yTicks - 1)) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  const xTickIndexes = buildXAxisTickIndexes(labels.length, 8);

  for (const index of xTickIndexes) {
    const x = padding.left + xStep * index;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const points = values.map((value, index) => {
    const ratio = (value - bottomValue) / Math.max(topValue - bottomValue, 1);
    return {
      x: padding.left + xStep * index,
      y: padding.top + chartHeight - ratio * chartHeight
    };
  });

  trendChartModel = {
    labels,
    values,
    dates,
    points,
    padding,
    chartWidth,
    width,
    height
  };

  const areaGradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  areaGradient.addColorStop(0, "rgba(74, 222, 128, 0.22)");
  areaGradient.addColorStop(0.82, "rgba(74, 222, 128, 0.06)");
  areaGradient.addColorStop(1, "rgba(74, 222, 128, 0.01)");

  drawSmoothPath(ctx, points);
  ctx.lineTo(points[points.length - 1].x, height - padding.bottom);
  ctx.lineTo(points[0].x, height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = areaGradient;
  ctx.fill();

  drawSmoothPath(ctx, points);
  ctx.strokeStyle = "#4ade80";
  ctx.lineWidth = 1.75;
  ctx.stroke();

  ctx.fillStyle = "#4ade80";
  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.font = "500 13px Segoe UI";
  ctx.fillStyle = "#9ca3af";
  ctx.textAlign = "right";
  for (let i = 0; i < yTicks; i += 1) {
    const value = topValue - ((topValue - bottomValue) / (yTicks - 1)) * i;
    const y = padding.top + (chartHeight / (yTicks - 1)) * i + 4;
    ctx.fillText(`${Math.round(value / 10000)}万`, padding.left - 12, y);
  }

  ctx.textAlign = "center";
  xTickIndexes.forEach((index) => {
    const label = labels[index];
    ctx.fillText(label, padding.left + xStep * index, height - 16);
  });

  if (Array.isArray(dates) && dates.length && appState.annotations.length) {
    const firstTime = new Date(`${dates[0]}T00:00:00`).getTime();
    const lastTime = new Date(`${dates[dates.length - 1]}T00:00:00`).getTime();
    appState.annotations.forEach((ann) => {
      const targetTime = new Date(`${ann.date}T00:00:00`).getTime();
      if (targetTime < firstTime || targetTime > lastTime) return;
      let nearestIdx = 0;
      let nearestDiff = Infinity;
      dates.forEach((d, i) => {
        const diff = Math.abs(new Date(`${d}T00:00:00`).getTime() - targetTime);
        if (diff < nearestDiff) { nearestDiff = diff; nearestIdx = i; }
      });
      const ax = points[nearestIdx].x;
      const topY = padding.top;
      const bottomY = height - padding.bottom;

      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, topY);
      ctx.lineTo(ax, bottomY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#f59e0b";
      ctx.save();
      ctx.translate(ax, topY + 5);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-4, -4, 8, 8);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = "#fbbf24";
      ctx.font = "500 11px Segoe UI";
      ctx.translate(ax + 8, topY + 14);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(ann.text, 0, 0);
      ctx.restore();
    });
  }

  if (hoveredTrendIndex !== null && points[hoveredTrendIndex]) {
    const activePoint = points[hoveredTrendIndex];
    ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(activePoint.x, padding.top);
    ctx.lineTo(activePoint.x, height - padding.bottom);
    ctx.stroke();

    ctx.fillStyle = "#4ade80";
    ctx.beginPath();
    ctx.arc(activePoint.x, activePoint.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  const dailyDelta = values[values.length - 1] - values[values.length - 2];
  const dailyRate = (dailyDelta / values[values.length - 2]) * 100;
  const periodDelta = values[values.length - 1] - values[0];
  const periodRate = (periodDelta / values[0]) * 100;

  trendDailyChange.textContent = `${formatSignedCurrency(dailyDelta)} (${formatSignedPercent(dailyRate)})`;
  trendPeriodChange.textContent = `${formatSignedCurrency(periodDelta)} (${formatSignedPercent(periodRate)})`;
  trendDailyChange.classList.toggle("is-negative", dailyDelta < 0);
  trendDailyChange.classList.toggle("is-positive", dailyDelta >= 0);
  trendPeriodChange.classList.toggle("is-negative", periodDelta < 0);
  trendPeriodChange.classList.toggle("is-positive", periodDelta >= 0);
}

function renderHoldingsTable() {
  holdingsBody.innerHTML = "";
  if (holdingsTableMode === "metrics") {
    renderHoldingsMetricsTable();
    return;
  }
  const rows = getHoldingsTableRows();
  const totalValue = rows
    .map(({ holding }) => normalizeHolding(holding))
    .reduce((sum, item) => sum + item.marketValue, 0);

  rows.forEach(({ holding, index, isGrouped, sourceCount }) => {
    const normalized = normalizeHolding(holding);
    const fragment = holdingRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    const dayChangeCell = row.querySelector('[data-field="dayChange"]');
    const dayChangeRateCell = row.querySelector('[data-field="dayChangeRate"]');
    const profitCell = row.querySelector('[data-field="profitLoss"]');
    const profitRateCell = row.querySelector('[data-field="profitRate"]');
    const weightCell = row.querySelector('[data-field="weight"]');
    const openReviewButton = row.querySelector('[data-action="open-review"]');
    const weight = totalValue > 0 ? (normalized.marketValue / totalValue) * 100 : 0;
    const ticker = String(holding.ticker || "").trim();

    row.querySelector('[data-field="displayName"]').textContent = getDisplayName(holding.ticker);
    row.querySelector('[data-field="ticker"]').textContent = isGrouped && sourceCount > 1
      ? `${holding.ticker || "-"} · ${sourceCount}件`
      : holding.ticker || "-";
    row.querySelector('[data-field="shares"]').textContent = formatPlainNumber(normalized.shares);
    row.querySelector('[data-field="buyPrice"]').textContent = normalized.buyPrice > 0 ? formatCurrency(normalized.buyPrice) : "-";
    row.querySelector('[data-field="price"]').textContent = normalized.price > 0 ? formatCurrency(normalized.price) : "-";
    const dayChangeValue = holdingsDayChangeMode === "marketValue"
      ? normalized.dayChangeMarketValue
      : normalized.dayChange;
    dayChangeCell.textContent = normalized.previousClose > 0 ? formatSignedCurrency(dayChangeValue) : "-";
    dayChangeRateCell.textContent = normalized.previousClose > 0 ? formatSignedPercent(normalized.dayChangeRate) : "-";
    profitCell.textContent = formatSignedCurrency(normalized.profitLoss);
    profitRateCell.textContent = formatSignedPercent(normalized.profitRate);
    weightCell.textContent = formatPercent(weight);
    row.querySelector('[data-field="marketValue"]').textContent = formatCurrency(normalized.marketValue);
    dayChangeCell.classList.toggle("is-positive", normalized.previousClose > 0 && normalized.dayChange >= 0);
    dayChangeCell.classList.toggle("is-negative", normalized.previousClose > 0 && normalized.dayChange < 0);
    dayChangeRateCell.classList.toggle("is-positive", normalized.previousClose > 0 && normalized.dayChangeRate >= 0);
    dayChangeRateCell.classList.toggle("is-negative", normalized.previousClose > 0 && normalized.dayChangeRate < 0);
    profitCell.classList.toggle("is-positive", normalized.profitLoss >= 0);
    profitCell.classList.toggle("is-negative", normalized.profitLoss < 0);
    profitRateCell.classList.toggle("is-positive", normalized.profitRate >= 0);
    profitRateCell.classList.toggle("is-negative", normalized.profitRate < 0);
    openReviewButton.addEventListener("click", () => {
      if (!ticker) {
        return;
      }
      activateView("review");
      reviewTickerInput.value = ticker;
      loadReviewSnapshot(ticker);
    });
    if (isGrouped) {
      row.classList.add("is-grouped-row");
      row.querySelector(".drag-cell").textContent = "";
      row.querySelector(".row-actions").textContent = "";
    } else {
      attachHoldingDragEvents(row, index);
      row.querySelector('[data-action="edit-holding"]').addEventListener("click", () => openHoldingModal(index));
      row.querySelector('[data-action="remove-holding"]').addEventListener("click", () => {
        appState.holdings.splice(index, 1);
        render();
        refreshDividendSummary();
        refreshHoldingSectors();
        queueAutosave();
      });
    }
    holdingsBody.appendChild(fragment);
  });
}

function renderHoldingsMetricsTable() {
  const holdings = getUniqueJapaneseHoldings();
  const hasMissingSnapshot = holdings.some((holding) => {
    const ticker = String(holding.ticker || "").trim().toUpperCase();
    return ticker && !getHoldingMetricSnapshot(ticker) && !holdingMetricsLoading.has(ticker);
  });

  if (hasMissingSnapshot) {
    void ensureHoldingMetricsLoaded();
  }

  if (!holdings.length) {
    const empty = document.createElement("tr");
    empty.className = "table-empty-row";
    empty.innerHTML = '<td colspan="10">企業指標は日本株の保有銘柄があると表示されます</td>';
    holdingsBody.appendChild(empty);
    return;
  }

  holdings.forEach((holding) => {
    const ticker = String(holding.ticker || "").trim().toUpperCase();
    const snapshot = getHoldingMetricSnapshot(ticker);
    const loading = holdingMetricsLoading.has(ticker);
    const overview = snapshot?.overview || {};
    const valuation = snapshot?.valuation || {};
    const profitability = snapshot?.profitability || {};
    const perStyle = loading ? "" : buildMetricToneStyle(valuation.trailingPE, [8, 15, 40]);
    const pbrStyle = loading ? "" : buildMetricToneStyle(valuation.priceToBook, [0.8, 1.5, 5]);
    const roeStyle = loading ? "" : buildPositiveMetricToneStyle(profitability.returnOnEquity, [5, 10, 15]);
    const roaStyle = loading ? "" : buildPositiveMetricToneStyle(profitability.returnOnAssets, [2, 5, 8]);
    const dividendYieldStyle = loading ? "" : buildYieldToneStyle(normalizeYieldPercentValue(getDisplayDividendYieldPercent(snapshot)));
    const row = document.createElement("tr");

    row.innerHTML = `
      <td class="cell-ticker">
        <button class="ticker-link" data-action="open-review" type="button">
          <span class="ticker-name">${getDisplayName(ticker)}</span>
        </button>
        <div class="ticker-code">${ticker || "-"}</div>
      </td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatMaybeCurrency(overview.marketCap, "JPY", true)}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatMaybeCurrency(overview.currentPrice, "JPY")}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatPriceWithDate(overview.fiftyTwoWeekHigh, "JPY", overview.fiftyTwoWeekHighDate)}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatPriceWithDate(overview.fiftyTwoWeekLow, "JPY", overview.fiftyTwoWeekLowDate)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${perStyle}">${loading ? "読込中..." : formatMaybeMultiple(valuation.trailingPE)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${pbrStyle}">${loading ? "読込中..." : formatMaybeMultiple(valuation.priceToBook)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${roeStyle}">${loading ? "読込中..." : formatMaybePercent(profitability.returnOnEquity, 1)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${roaStyle}">${loading ? "読込中..." : formatMaybePercent(profitability.returnOnAssets, 1)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${dividendYieldStyle}">${loading ? "読込中..." : formatMaybeYieldPercent(getDisplayDividendYieldPercent(snapshot), 1)}</td>
    `;

    row.querySelector('[data-action="open-review"]').addEventListener("click", () => {
      activateView("review");
      reviewTickerInput.value = ticker;
      loadReviewSnapshot(ticker);
    });
    holdingsBody.appendChild(row);
  });
}

function renderWatchlistTable() {
  watchlistBody.innerHTML = "";
  if (watchlistTableMode === "metrics") {
    renderWatchlistMetricsTable();
    return;
  }

  if (!appState.watchlist.length) {
    const empty = document.createElement("tr");
    empty.className = "table-empty-row";
    empty.innerHTML = '<td colspan="6">ウォッチリストはまだありません</td>';
    watchlistBody.appendChild(empty);
    return;
  }

  appState.watchlist.forEach((item, index) => {
    const normalized = normalizeHolding(item);
    const fragment = watchlistRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    const dayChangeCell = row.querySelector('[data-field="dayChange"]');
    const dayChangeRateCell = row.querySelector('[data-field="dayChangeRate"]');
    const openReviewButton = row.querySelector('[data-action="open-review"]');
    const ticker = String(item.ticker || "").trim();

    row.querySelector('[data-field="displayName"]').textContent = getDisplayName(item.ticker);
    row.querySelector('[data-field="ticker"]').textContent = item.ticker || "-";
    row.querySelector('[data-field="price"]').textContent = normalized.price > 0 ? formatCurrency(normalized.price) : "-";
    dayChangeCell.textContent = normalized.previousClose > 0 ? formatSignedCurrency(normalized.dayChange) : "-";
    dayChangeRateCell.textContent = normalized.previousClose > 0 ? formatSignedPercent(normalized.dayChangeRate) : "-";
    dayChangeCell.classList.toggle("is-positive", normalized.previousClose > 0 && normalized.dayChange >= 0);
    dayChangeCell.classList.toggle("is-negative", normalized.previousClose > 0 && normalized.dayChange < 0);
    dayChangeRateCell.classList.toggle("is-positive", normalized.previousClose > 0 && normalized.dayChangeRate >= 0);
    dayChangeRateCell.classList.toggle("is-negative", normalized.previousClose > 0 && normalized.dayChangeRate < 0);

    openReviewButton.addEventListener("click", () => {
      if (!ticker) {
        return;
      }
      activateView("review");
      reviewTickerInput.value = ticker;
      loadReviewSnapshot(ticker);
    });
    attachWatchlistDragEvents(row, index);
    row.querySelector('[data-action="edit-watchlist"]').addEventListener("click", () => openWatchlistModal(index));
    row.querySelector('[data-action="remove-watchlist"]').addEventListener("click", () => {
      appState.watchlist.splice(index, 1);
      render();
      refreshHoldingSectors();
      queueAutosave();
    });

    watchlistBody.appendChild(fragment);
  });
}

function renderWatchlistMetricsTable() {
  const watchlist = getUniqueJapaneseWatchlist();
  const hasMissingSnapshot = watchlist.some((item) => {
    const ticker = String(item.ticker || "").trim().toUpperCase();
    return ticker && !getHoldingMetricSnapshot(ticker) && !holdingMetricsLoading.has(ticker);
  });

  if (hasMissingSnapshot) {
    void ensureHoldingMetricsLoaded();
  }

  if (!watchlist.length) {
    const empty = document.createElement("tr");
    empty.className = "table-empty-row";
    empty.innerHTML = '<td colspan="10">企業指標は日本株のウォッチリスト銘柄があると表示されます</td>';
    watchlistBody.appendChild(empty);
    return;
  }

  watchlist.forEach((item) => {
    const ticker = String(item.ticker || "").trim().toUpperCase();
    const snapshot = getHoldingMetricSnapshot(ticker);
    const loading = holdingMetricsLoading.has(ticker);
    const overview = snapshot?.overview || {};
    const valuation = snapshot?.valuation || {};
    const profitability = snapshot?.profitability || {};
    const perStyle = loading ? "" : buildMetricToneStyle(valuation.trailingPE, [8, 15, 40]);
    const pbrStyle = loading ? "" : buildMetricToneStyle(valuation.priceToBook, [0.8, 1.5, 5]);
    const roeStyle = loading ? "" : buildPositiveMetricToneStyle(profitability.returnOnEquity, [5, 10, 15]);
    const roaStyle = loading ? "" : buildPositiveMetricToneStyle(profitability.returnOnAssets, [2, 5, 8]);
    const dividendYieldStyle = loading ? "" : buildYieldToneStyle(normalizeYieldPercentValue(getDisplayDividendYieldPercent(snapshot)));
    const row = document.createElement("tr");

    row.innerHTML = `
      <td class="cell-ticker">
        <button class="ticker-link" data-action="open-review" type="button">
          <span class="ticker-name">${getDisplayName(ticker)}</span>
        </button>
        <div class="ticker-code">${ticker || "-"}</div>
      </td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatMaybeCurrency(overview.marketCap, "JPY", true)}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatMaybeCurrency(overview.currentPrice, "JPY")}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatPriceWithDate(overview.fiftyTwoWeekHigh, "JPY", overview.fiftyTwoWeekHighDate)}</td>
      <td class="computed-cell cell-number">${loading ? "読込中..." : formatPriceWithDate(overview.fiftyTwoWeekLow, "JPY", overview.fiftyTwoWeekLowDate)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${perStyle}">${loading ? "読込中..." : formatMaybeMultiple(valuation.trailingPE)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${pbrStyle}">${loading ? "読込中..." : formatMaybeMultiple(valuation.priceToBook)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${roeStyle}">${loading ? "読込中..." : formatMaybePercent(profitability.returnOnEquity, 1)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${roaStyle}">${loading ? "読込中..." : formatMaybePercent(profitability.returnOnAssets, 1)}</td>
      <td class="computed-cell cell-number metric-tone-cell" style="${dividendYieldStyle}">${loading ? "読込中..." : formatMaybeYieldPercent(getDisplayDividendYieldPercent(snapshot), 1)}</td>
    `;

    row.querySelector('[data-action="open-review"]').addEventListener("click", () => {
      activateView("review");
      reviewTickerInput.value = ticker;
      loadReviewSnapshot(ticker);
    });
    watchlistBody.appendChild(row);
  });
}

function getReviewQuickTickers() {
  const tickers = new Set();
  appState.holdings.forEach((item) => {
    const ticker = String(item.ticker || "").trim();
    if (ticker) {
      tickers.add(ticker);
    }
  });
  appState.watchlist.forEach((item) => {
    const ticker = String(item.ticker || "").trim();
    if (ticker) {
      tickers.add(ticker);
    }
  });
  return Array.from(tickers).slice(0, 12);
}

function renderReviewChips() {
  reviewChipRow.innerHTML = "";
  getReviewQuickTickers().forEach((ticker) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-chip";
    if (ticker === activeReviewTicker) {
      button.classList.add("is-active");
    }
    button.textContent = getDisplayName(ticker);
    button.addEventListener("click", () => {
      reviewTickerInput.value = ticker;
      loadReviewSnapshot(ticker);
    });
    reviewChipRow.appendChild(button);
  });
}

function renderReviewKeyValueGrid(container, rows) {
  container.innerHTML = "";
  rows.forEach((row) => {
    const helpText = row.help || REVIEW_LABEL_HELP[row.label] || "";
    const item = document.createElement("div");
    item.className = "review-kv-row";
    item.innerHTML = `
      <span class="review-kv-label${helpText ? " review-kv-label-help" : ""}"${helpText ? ` data-tooltip="${helpText}" tabindex="0"` : ""}>${row.label}</span>
      <strong class="review-kv-value${row.tone ? ` is-${row.tone}` : ""}"${row.style ? ` style="${row.style}"` : ""}>${row.value}</strong>
    `;
    container.appendChild(item);
  });
}

function renderReviewFinancials(rows) {
  reviewFinancialBody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4">-</td>';
    reviewFinancialBody.appendChild(tr);
    return;
  }

  const getFinancialTone = (currentValue, previousValue) => {
    if (typeof currentValue !== "number" || typeof previousValue !== "number") {
      return "";
    }
    if (currentValue > previousValue) {
      return "is-positive";
    }
    if (currentValue < previousValue) {
      return "is-negative";
    }
    return "";
  };

  rows.forEach((row, index) => {
    const previousRow = rows[index + 1] || null;
    const tr = document.createElement("tr");
    const revenueTone = getFinancialTone(row.revenue, previousRow?.revenue);
    const operatingIncomeTone = getFinancialTone(row.operatingIncome, previousRow?.operatingIncome);
    const netIncomeTone = getFinancialTone(row.netIncome, previousRow?.netIncome);
    tr.innerHTML = `
      <td>${row.period || "-"}</td>
      <td class="review-financial-value ${revenueTone}">${formatStatementNumber(row.revenue)}</td>
      <td class="review-financial-value ${operatingIncomeTone}">${formatStatementNumber(row.operatingIncome)}</td>
      <td class="review-financial-value ${netIncomeTone}">${formatStatementNumber(row.netIncome)}</td>
    `;
    reviewFinancialBody.appendChild(tr);
  });
}

function renderReviewNews(newsItems) {
  reviewNewsList.innerHTML = "";
  if (!newsItems.length) {
    const item = document.createElement("li");
    item.className = "review-news-empty";
    item.textContent = "ニュースは取得できませんでした。";
    reviewNewsList.appendChild(item);
    return;
  }

  newsItems.forEach((item) => {
    const li = document.createElement("li");
    const publisher = item.publisher ? `<span class="review-news-meta">${item.publisher}</span>` : "";
    li.innerHTML = `<a href="${item.link}" target="_blank" rel="noreferrer">${item.title}</a>${publisher}`;
    reviewNewsList.appendChild(li);
  });
}

function renderReviewSnapshot() {
  renderReviewChips();

  if (!reviewSnapshot) {
    reviewSymbol.textContent = "銘柄を選択してください";
    renderReviewKeyValueGrid(reviewOverviewGrid, []);
    renderReviewKeyValueGrid(reviewValuationGrid, []);
    renderReviewKeyValueGrid(reviewProfitabilityGrid, []);
    renderReviewKeyValueGrid(reviewAnalystGrid, []);
    renderReviewFinancials([]);
    renderReviewNews([]);
    return;
  }

  const { ticker, name, currency, overview, valuation, profitability, analyst, financialSummary, news } = reviewSnapshot;
  reviewSymbol.textContent = `${stockMaster[ticker] || name || ticker} (${ticker})`;

  renderReviewKeyValueGrid(reviewOverviewGrid, [
    { label: "セクター", value: overview.sector || "-" },
    { label: "業種", value: overview.industry || "-" },
    { label: "現在値", value: formatMaybeCurrency(overview.currentPrice, currency) },
    { label: "時価総額", value: formatMaybeCurrency(overview.marketCap, currency, true) },
    { label: "52週高値", value: formatPriceWithDate(overview.fiftyTwoWeekHigh, currency, overview.fiftyTwoWeekHighDate) },
    { label: "52週安値", value: formatPriceWithDate(overview.fiftyTwoWeekLow, currency, overview.fiftyTwoWeekLowDate) }
  ]);

  renderReviewKeyValueGrid(reviewValuationGrid, [
    { label: "PER", value: formatMaybeMultiple(valuation.trailingPE), style: buildMetricToneStyle(valuation.trailingPE, [8, 15, 40]) },
    { label: "PBR", value: formatMaybeMultiple(valuation.priceToBook), style: buildMetricToneStyle(valuation.priceToBook, [0.8, 1.5, 5]) },
    { label: "EV/EBITDA", value: formatMaybeMultiple(valuation.enterpriseToEbitda) },
    { label: "配当利回り", value: formatMaybeYieldPercent(getDisplayDividendYieldPercent(reviewSnapshot), 1) }
  ]);

  renderReviewKeyValueGrid(reviewProfitabilityGrid, [
    { label: "ROE", value: formatMaybePercent(profitability.returnOnEquity, 1), style: buildPositiveMetricToneStyle(profitability.returnOnEquity, [5, 10, 15]) },
    { label: "ROA", value: formatMaybePercent(profitability.returnOnAssets, 1), style: buildPositiveMetricToneStyle(profitability.returnOnAssets, [2, 5, 8]) },
    { label: "営業利益率", value: formatMaybePercent(profitability.operatingMargins, 1) },
    { label: "FCFマージン", value: formatMaybePercent(profitability.fcfMargin, 1) }
  ]);

  renderReviewKeyValueGrid(reviewAnalystGrid, [
    { label: "アナリスト数", value: formatMaybeNumber(analyst.numberOfAnalystOpinions, 0) },
    { label: "目標株価(平均)", value: formatMaybeCurrency(analyst.targetMeanPrice, currency) },
    { label: "目標株価(高値)", value: formatMaybeCurrency(analyst.targetHighPrice, currency) },
    { label: "目標株価(安値)", value: formatMaybeCurrency(analyst.targetLowPrice, currency) },
    { label: "推奨", value: analyst.recommendationKey || "-" }
  ]);

  renderReviewFinancials(financialSummary || []);
  renderReviewNews(news || []);
}

const REVIEW_HISTORY_KEY = "review-history";
const REVIEW_HISTORY_MAX = 20;

function getReviewHistory() {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function addToReviewHistory(ticker, name) {
  const history = getReviewHistory().filter((item) => item.ticker !== ticker);
  history.unshift({ ticker, name, viewedAt: Date.now() });
  localStorage.setItem(REVIEW_HISTORY_KEY, JSON.stringify(history.slice(0, REVIEW_HISTORY_MAX)));
}

function renderReviewHistoryDropdown() {
  const history = getReviewHistory();
  reviewHistoryDropdown.innerHTML = "";

  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "review-history-empty";
    empty.textContent = "履歴はありません";
    reviewHistoryDropdown.appendChild(empty);
    return;
  }

  history.forEach(({ ticker, name }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-option";
    const displayName = getDisplayName(ticker) || name || ticker;
    btn.innerHTML = `<span class="search-option-name">${displayName}</span><span class="search-option-code">${ticker}</span>`;
    btn.addEventListener("click", () => {
      hideReviewHistoryDropdown();
      loadReviewSnapshot(ticker);
    });
    reviewHistoryDropdown.appendChild(btn);
  });
}

function showReviewHistoryDropdown() {
  renderReviewHistoryDropdown();
  reviewHistoryDropdown.classList.remove("is-hidden");
}

function hideReviewHistoryDropdown() {
  reviewHistoryDropdown.classList.add("is-hidden");
}

reviewHistoryButton.addEventListener("click", (e) => {
  e.stopPropagation();
  if (reviewHistoryDropdown.classList.contains("is-hidden")) {
    showReviewHistoryDropdown();
  } else {
    hideReviewHistoryDropdown();
  }
});

document.addEventListener("click", (e) => {
  if (!reviewHistoryDropdown.contains(e.target) && e.target !== reviewHistoryButton) {
    hideReviewHistoryDropdown();
  }
});

async function loadReviewSnapshot(rawTicker) {
  const ticker = String(rawTicker || "").trim().toUpperCase();
  if (!ticker) {
    return;
  }

  activeReviewTicker = ticker;
  reviewTickerInput.value = ticker;
  hideReviewTickerSuggestions();
  renderReviewChips();

  try {
    const snapshot = await window.stockReviewApi.fetchReview(ticker);
    reviewSnapshot = snapshot;
    addToReviewHistory(ticker, snapshot.name || "");
    renderReviewSnapshot();
    setStockReviewContext(ticker, snapshot);
  } catch (error) {
    reviewSnapshot = null;
    renderReviewSnapshot();
    setStockReviewContext(ticker, null);
    setStatus(`レビュー取得エラー: ${error.message}`, "error");
  }
}

function drawAllocationChart() {
  const { ctx, width, height } = prepareHiDPICanvas(allocationChart);
  const centerX = width / 2;
  const centerY = Math.max(154, height / 2 - 24);
  const radius = 122;
  const innerRadius = 86;
  const holdings = getHoldingsTableRows(allocationGrouped)
    .map(({ holding }) => normalizeHolding(holding))
    .filter((item) => item.ticker && item.marketValue > 0)
    .sort((a, b) => b.marketValue - a.marketValue);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);

  ctx.clearRect(0, 0, width, height);
  allocationLegend.innerHTML = "";

  if (!holdings.length || totalValue === 0) {
    ctx.fillStyle = "rgba(55, 65, 81, 0.9)";
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.fillStyle = "#9ca3af";
    ctx.font = "500 13px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("データを入力すると表示", centerX, centerY + 4);
    return;
  }

  const colors = buildAllocationColors(holdings);
  let angle = 0;
  holdings.forEach((holding, index) => {
    const ratio = holding.marketValue / totalValue;
    const slice = ratio * Math.PI * 2;
    const color = colors[index];
    const endAngle = angle - slice;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.fillStyle = color;
    ctx.arc(centerX, centerY, radius, angle, endAngle, true);
    ctx.arc(centerX, centerY, innerRadius, endAngle, angle);
    ctx.closePath();
    ctx.fill();

    const labelAngle = angle - slice / 2;
    const lineStartRadius = radius + 2;
    const startX = centerX + Math.cos(labelAngle) * lineStartRadius;
    const startY = centerY + Math.sin(labelAngle) * lineStartRadius;
    const bendX = centerX + Math.cos(labelAngle) * (radius + 18);
    const bendY = centerY + Math.sin(labelAngle) * (radius + 18);
    const lineDirection = Math.cos(labelAngle) >= 0 ? 1 : -1;
    const endX = bendX + 18 * lineDirection;

    ctx.beginPath();
    ctx.strokeStyle = "rgba(107, 114, 128, 0.75)";
    ctx.lineWidth = 1;
    ctx.moveTo(startX, startY);
    ctx.lineTo(bendX, bendY);
    ctx.lineTo(endX, bendY);
    ctx.stroke();

    ctx.fillStyle = "#f3f4f6";
    ctx.font = "600 11px Segoe UI";
    ctx.textAlign = lineDirection > 0 ? "left" : "right";
    const labelName = getDisplayName(holding.ticker);
    const labelText = ratio < 0.045 ? formatPercent(ratio * 100) : `${labelName} ${formatPercent(ratio * 100)}`;
    const labelMargin = 6;
    const textWidth = ctx.measureText(labelText).width;
    let labelX = endX + labelMargin * lineDirection;
    if (lineDirection > 0) {
      // 左揃え（右側ラベル）: 右端からはみ出さないようにクランプ
      labelX = Math.min(labelX, width - labelMargin - textWidth);
    } else {
      // 右揃え（左側ラベル）: 左端からはみ出さないようにクランプ
      labelX = Math.max(labelX, labelMargin + textWidth);
    }
    ctx.fillText(labelText, labelX, bendY - 2);

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <span class="legend-name">${getDisplayName(holding.ticker)}</span>
    `;
    allocationLegend.appendChild(item);

    angle = endAngle;
  });

  ctx.fillStyle = "#f9fafb";
  ctx.font = "700 18px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText("保有割合", centerX, centerY + 6);
}

function drawPerformanceChart() {
  const holdings = getHoldingsTableRows(allocationGrouped)
    .map(({ holding }) => normalizeHolding(holding))
    .filter((item) => item.ticker && item.marketValue > 0)
    .sort((a, b) => b.marketValue - a.marketValue);

  performanceChart.innerHTML = "";

  if (!holdings.length) {
    const empty = document.createElement("div");
    empty.className = "performance-empty";
    empty.textContent = "データを入力すると表示";
    performanceChart.appendChild(empty);
    return;
  }

  const maxReferenceValue = Math.max(
    ...holdings.map((holding) => Math.max(holding.marketValue, holding.costBasis)),
    1
  );

  holdings.forEach((holding) => {
    const row = document.createElement("div");
    row.className = "performance-row";

    const label = document.createElement("div");
    label.className = "performance-name";
    label.textContent = getDisplayName(holding.ticker);

    const track = document.createElement("div");
    track.className = "performance-bar-track";

    const marketWidth = Math.max(2, (holding.marketValue / maxReferenceValue) * 100);
    const costWidth = Math.max(2, (holding.costBasis / maxReferenceValue) * 100);
    const fill = document.createElement("div");
    fill.className = "performance-bar-fill";

    if (holding.profitLoss >= 0) {
      fill.style.width = `${costWidth}%`;
      track.appendChild(fill);

      const gainWidth = marketWidth - costWidth;
      if (gainWidth > 0.4) {
        const gain = document.createElement("div");
        gain.className = "performance-bar-gain";
        gain.style.left = `${costWidth}%`;
        gain.style.width = `${Math.max(2, gainWidth)}%`;
        track.appendChild(gain);
      }
    } else {
      fill.style.width = `${marketWidth}%`;
      track.appendChild(fill);

      const gapWidth = costWidth - marketWidth;
      if (gapWidth > 0.4) {
        const gap = document.createElement("div");
        gap.className = "performance-bar-loss-gap";
        gap.style.left = `${marketWidth}%`;
        gap.style.width = `${Math.max(2, gapWidth)}%`;
        track.appendChild(gap);
      }
    }

    const value = document.createElement("div");
    value.className = "performance-value";
    value.textContent = formatSignedPercent(holding.profitRate);
    value.classList.toggle("is-positive", holding.profitRate >= 0);
    value.classList.toggle("is-negative", holding.profitRate < 0);

    row.append(label, track, value);
    performanceChart.appendChild(row);
  });
}

function render() {
  renderPortfolioSummary();
  renderHoldingsTableModeToggle();
  renderHoldingsGroupToggle();
  renderAllocationGroupToggle();
  renderHoldingsTableHead();
  renderWatchlistTableModeToggle();
  renderWatchlistTableHead();
  renderDayChangeToggle();
  renderHoldingsTable();
  renderWatchlistTable();
  renderReviewSnapshot();
  drawPerformanceChart();
}

async function refreshPrices() {
  const tickers = [...appState.holdings, ...appState.watchlist]
    .map((item) => String(item.ticker || "").trim())
    .filter(Boolean);

  if (!tickers.length) {
    setStatus("先に銘柄コードを入力してください。", "error");
    return;
  }

  refreshPricesButton.disabled = true;
  const previousText = refreshPricesButton.textContent;
  refreshPricesButton.textContent = "取得中...";
  setStatus("", "neutral");

  try {
    const result = await window.stockReviewApi.refreshPrices(tickers);
    const quotes = result?.quotes || {};
    const errors = result?.errors || {};
    let updatedCount = 0;

    appState.holdings = appState.holdings.map((holding) => {
      const ticker = String(holding.ticker || "").trim();
      const quote = quotes[ticker];
      if (!quote || typeof quote.price !== "number") {
        return holding;
      }

      updatedCount += 1;
      return {
        ...holding,
        price: String(parseWholeNumber(quote.price_jpy ?? quote.price)),
        sourcePrice: quote.price,
        currency: quote.currency,
        previousClose: quote.previous_close_jpy ? String(parseWholeNumber(quote.previous_close_jpy)) : "",
        sourcePreviousClose: quote.previous_close
      };
    });

    appState.watchlist = appState.watchlist.map((item) => {
      const ticker = String(item.ticker || "").trim();
      const quote = quotes[ticker];
      if (!quote || typeof quote.price !== "number") {
        return item;
      }

      updatedCount += 1;
      return {
        ...item,
        price: String(parseWholeNumber(quote.price_jpy ?? quote.price)),
        sourcePrice: quote.price,
        currency: quote.currency,
        previousClose: quote.previous_close_jpy ? String(parseWholeNumber(quote.previous_close_jpy)) : "",
        sourcePreviousClose: quote.previous_close
      };
    });

    render();
    await refreshDividendSummary();
    await refreshHoldingSectors();
    await persistPortfolio({ silent: true });

    const errorTickers = Object.keys(errors);
    if (updatedCount === 0) {
      setStatus("価格を取得できませんでした。銘柄コードや通信状態を確認してください。", "error");
      return;
    }

    if (errorTickers.length) {
      setStatus(`価格更新: ${updatedCount}件成功、${errorTickers.length}件失敗。外貨は円換算で反映しました。`, "success");
    } else {
      setStatus(`価格を ${updatedCount} 件更新しました。外貨は円換算で反映しました。`, "success");
    }
  } catch (error) {
    setStatus(`価格取得エラー: ${error.message}`, "error");
  } finally {
    refreshPricesButton.disabled = false;
    refreshPricesButton.textContent = previousText;
  }
}

async function init() {
  const master = await window.stockReviewApi.loadStockMaster();
  Object.assign(stockMaster, master || {});
  stockMasterEntries = Object.entries(stockMaster)
    .map(([ticker, name]) => ({ ticker, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const [data, annotations] = await Promise.all([
    window.stockReviewApi.loadPortfolio(),
    window.stockReviewApi.loadAnnotations()
  ]);
  appState.annotations = Array.isArray(annotations) ? annotations : [];
  await applyPortfolioState(data);
  const initialTicker = getReviewQuickTickers()[0];
  if (initialTicker) {
    reviewTickerInput.value = initialTicker;
    loadReviewSnapshot(initialTicker);
  }
}

init();
