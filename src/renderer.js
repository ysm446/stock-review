const appState = {
  holdings: [],
  watchlist: []
};

const stockMaster = {};

const CHART_COLORS = [
  "#3b82f6",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#14b8a6"
];

const views = document.querySelectorAll(".view");
const navButtons = document.querySelectorAll(".nav-button");
const statsGrid = document.getElementById("stats-grid");
const holdingsBody = document.getElementById("holdings-body");
const reviewList = document.getElementById("review-list");
const allocationLegend = document.getElementById("allocation-legend");
const allocationChart = document.getElementById("allocation-chart");
const holdingRowTemplate = document.getElementById("holding-row-template");
const reviewCardTemplate = document.getElementById("review-card-template");
const priceStatus = document.getElementById("price-status");
const refreshPricesButton = document.getElementById("refresh-prices");
const trendRangeSelect = document.getElementById("trend-range");
const trendChart = document.getElementById("trend-chart");
const trendDailyChange = document.getElementById("trend-daily-change");
const trendPeriodChange = document.getElementById("trend-period-change");
const holdingModalBackdrop = document.getElementById("holding-modal-backdrop");
const holdingForm = document.getElementById("holding-form");
const holdingModalTitle = document.getElementById("holding-modal-title");
const holdingTickerInput = document.getElementById("holding-ticker-input");
const holdingSharesInput = document.getElementById("holding-shares-input");
const holdingBuyPriceInput = document.getElementById("holding-buy-price-input");
const closeHoldingModalButton = document.getElementById("close-holding-modal");
const cancelHoldingModalButton = document.getElementById("cancel-holding-modal");
const submitHoldingModalButton = document.getElementById("submit-holding-modal");

let statusTimer = null;
let trendRange = "1m";
let editingHoldingIndex = null;
let autosaveTimer = null;

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const { view } = button.dataset;
    navButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    views.forEach((panel) => panel.classList.toggle("is-visible", panel.id === `view-${view}`));
  });
});

document.getElementById("add-holding").addEventListener("click", () => {
  openHoldingModal();
});

document.getElementById("add-review").addEventListener("click", () => {
  appState.watchlist.push({ ticker: "", rating: "B", thesis: "", risk: "" });
  render();
  queueAutosave();
});

refreshPricesButton.addEventListener("click", refreshPrices);
trendRangeSelect.addEventListener("change", (event) => {
  trendRange = event.target.value;
  drawTrendChart();
});
closeHoldingModalButton.addEventListener("click", closeHoldingModal);
cancelHoldingModalButton.addEventListener("click", closeHoldingModal);
holdingModalBackdrop.addEventListener("click", (event) => {
  if (event.target === holdingModalBackdrop) {
    closeHoldingModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !holdingModalBackdrop.classList.contains("is-hidden")) {
    closeHoldingModal();
  }
});
holdingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveHoldingFromModal();
});

function normalizeHolding(raw) {
  const shares = parseWholeNumber(raw.shares);
  const buyPrice = parseWholeNumber(raw.buyPrice);
  const price = parseWholeNumber(raw.price);
  const costBasis = shares * buyPrice;
  const marketValue = shares * price;
  const profitLoss = marketValue - costBasis;
  const profitRate = costBasis > 0 ? (profitLoss / costBasis) * 100 : 0;
  return {
    ticker: raw.ticker || "",
    shares,
    buyPrice,
    price,
    note: raw.note || "",
    costBasis,
    marketValue,
    profitLoss,
    profitRate
  };
}

function parseNumericInput(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll(",", "");
  if (!normalized) {
    return 0;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseWholeNumber(value) {
  return Math.round(parseNumericInput(value));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0
  }).format(value);
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatSignedCurrency(value) {
  const abs = formatCurrency(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${abs}`;
}

function formatSignedPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPlainNumber(value) {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: 0
  }).format(value);
}

function getDisplayName(ticker) {
  const normalized = String(ticker || "").trim();
  return stockMaster[normalized] || normalized || "-";
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
  await window.stockReviewApi.savePortfolio(appState);
  if (!silent) {
    setStatus("保存しました。", "success");
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

function calculateStats() {
  const holdings = appState.holdings.map(normalizeHolding);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  const totalPositions = holdings.filter((item) => item.ticker).length;

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

function renderStats() {
  statsGrid.innerHTML = "";
  for (const stat of calculateStats()) {
    const card = document.createElement("article");
    card.className = "stat-card";
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
  holdingTickerInput.focus();
}

function closeHoldingModal() {
  editingHoldingIndex = null;
  holdingForm.reset();
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
  queueAutosave();
}

function getRangeConfig(range) {
  switch (range) {
    case "3m":
      return { points: 14, stepDays: 7, volatility: 0.028, drift: 0.1 };
    case "6m":
      return { points: 18, stepDays: 14, volatility: 0.036, drift: 0.16 };
    case "1y":
      return { points: 16, stepDays: 28, volatility: 0.05, drift: 0.24 };
    case "1m":
    default:
      return { points: 20, stepDays: 2, volatility: 0.022, drift: 0.06 };
  }
}

function buildTrendSeries(totalValue, holdingsCount, range) {
  const safeTotal = totalValue > 0 ? totalValue : 12000000;
  const { points, stepDays, volatility, drift } = getRangeConfig(range);
  const anchorDate = new Date("2026-04-17T00:00:00");
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

    const date = new Date(anchorDate);
    date.setDate(anchorDate.getDate() - stepDays * (points - 1 - index));
    labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
  }

  if (values.length >= 2) {
    values[values.length - 2] = values[values.length - 1] * (0.965 + ((strength % 5) * 0.007));
  }

  return { labels, values };
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
  const ctx = trendChart.getContext("2d");
  const width = trendChart.width;
  const height = trendChart.height;
  const padding = { top: 34, right: 18, bottom: 42, left: 74 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const totalValue = appState.holdings.map(normalizeHolding).reduce((sum, item) => sum + item.marketValue, 0);
  const holdingsCount = appState.holdings.filter((item) => String(item.ticker || "").trim()).length;
  const { labels, values } = buildTrendSeries(totalValue, holdingsCount, trendRange);

  ctx.clearRect(0, 0, width, height);

  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const valuePadding = Math.max((maxValue - minValue) * 0.18, maxValue * 0.03, 100000);
  const topValue = maxValue + valuePadding;
  const bottomValue = Math.max(0, minValue - valuePadding * 0.8);
  const yTicks = 4;
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

  for (let i = 0; i < labels.length; i += 1) {
    const x = padding.left + xStep * i;
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

  const areaGradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  areaGradient.addColorStop(0, "rgba(74, 222, 128, 0.30)");
  areaGradient.addColorStop(1, "rgba(74, 222, 128, 0.04)");

  drawSmoothPath(ctx, points);
  ctx.lineTo(points[points.length - 1].x, height - padding.bottom);
  ctx.lineTo(points[0].x, height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = areaGradient;
  ctx.fill();

  drawSmoothPath(ctx, points);
  ctx.strokeStyle = "#4ade80";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#4ade80";
  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.font = "500 12px Segoe UI";
  ctx.fillStyle = "#9ca3af";
  ctx.textAlign = "right";
  for (let i = 0; i < yTicks; i += 1) {
    const value = topValue - ((topValue - bottomValue) / (yTicks - 1)) * i;
    const y = padding.top + (chartHeight / (yTicks - 1)) * i + 4;
    ctx.fillText(`${Math.round(value / 10000)}万`, padding.left - 12, y);
  }

  ctx.textAlign = "center";
  labels.forEach((label, index) => {
    ctx.fillText(label, padding.left + xStep * index, height - 16);
  });

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
  const totalValue = appState.holdings
    .map(normalizeHolding)
    .reduce((sum, item) => sum + item.marketValue, 0);

  appState.holdings.forEach((holding, index) => {
    const normalized = normalizeHolding(holding);
    const fragment = holdingRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    const profitCell = row.querySelector('[data-field="profitLoss"]');
    const profitRateCell = row.querySelector('[data-field="profitRate"]');
    const weightCell = row.querySelector('[data-field="weight"]');
    const weight = totalValue > 0 ? (normalized.marketValue / totalValue) * 100 : 0;

    row.querySelector('[data-field="displayName"]').textContent = getDisplayName(holding.ticker);
    row.querySelector('[data-field="ticker"]').textContent = holding.ticker || "-";
    row.querySelector('[data-field="shares"]').textContent = formatPlainNumber(normalized.shares);
    row.querySelector('[data-field="buyPrice"]').textContent = normalized.buyPrice > 0 ? formatCurrency(normalized.buyPrice) : "-";
    row.querySelector('[data-field="price"]').textContent = normalized.price > 0 ? formatCurrency(normalized.price) : "-";
    profitCell.textContent = formatSignedCurrency(normalized.profitLoss);
    profitRateCell.textContent = formatSignedPercent(normalized.profitRate);
    weightCell.textContent = formatPercent(weight);
    row.querySelector('[data-field="marketValue"]').textContent = formatCurrency(normalized.marketValue);
    profitCell.classList.toggle("is-positive", normalized.profitLoss >= 0);
    profitCell.classList.toggle("is-negative", normalized.profitLoss < 0);
    profitRateCell.classList.toggle("is-positive", normalized.profitRate >= 0);
    profitRateCell.classList.toggle("is-negative", normalized.profitRate < 0);
    row.querySelector('[data-action="edit-holding"]').addEventListener("click", () => openHoldingModal(index));
    row.querySelector('[data-action="remove-holding"]').addEventListener("click", () => {
      appState.holdings.splice(index, 1);
      render();
      queueAutosave();
    });
    holdingsBody.appendChild(fragment);
  });
}

function attachReviewEvents(card, index) {
  card.querySelectorAll("input, textarea, select").forEach((field) => {
    field.addEventListener("input", (event) => {
      appState.watchlist[index][event.target.dataset.field] = event.target.value;
      queueAutosave();
    });
  });

  card.querySelector('[data-action="remove-review"]').addEventListener("click", () => {
    appState.watchlist.splice(index, 1);
    render();
    queueAutosave();
  });
}

function renderReviews() {
  reviewList.innerHTML = "";

  appState.watchlist.forEach((item, index) => {
    const fragment = reviewCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".review-card");

    card.querySelector('[data-field="ticker"]').value = item.ticker || "";
    card.querySelector('[data-field="rating"]').value = item.rating || "B";
    card.querySelector('[data-field="thesis"]').value = item.thesis || "";
    card.querySelector('[data-field="risk"]').value = item.risk || "";

    attachReviewEvents(card, index);
    reviewList.appendChild(fragment);
  });
}

function drawAllocationChart() {
  const ctx = allocationChart.getContext("2d");
  const width = allocationChart.width;
  const height = allocationChart.height;
  const centerX = width / 2;
  const centerY = Math.max(180, height / 2 - 34);
  const radius = 138;
  const innerRadius = 98;
  const holdings = appState.holdings
    .map(normalizeHolding)
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

  let angle = -Math.PI / 2;
  holdings.forEach((holding, index) => {
    const ratio = holding.marketValue / totalValue;
    const slice = ratio * Math.PI * 2;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    const endAngle = angle + slice;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.fillStyle = color;
    ctx.arc(centerX, centerY, radius, angle, endAngle);
    ctx.arc(centerX, centerY, innerRadius, endAngle, angle, true);
    ctx.closePath();
    ctx.fill();

    const labelAngle = angle + slice / 2;
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
    ctx.fillText(labelText, endX + 6 * lineDirection, bendY - 2);

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

function render() {
  renderPortfolioSummary();
  renderHoldingsTable();
  renderReviews();
}

async function refreshPrices() {
  const tickers = appState.holdings
    .map((holding) => String(holding.ticker || "").trim())
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
        currency: quote.currency
      };
    });

    render();
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
  const data = await window.stockReviewApi.loadPortfolio();
  appState.holdings = Array.isArray(data.holdings) ? data.holdings : [];
  appState.watchlist = Array.isArray(data.watchlist) ? data.watchlist : [];
  render();
}

init();
