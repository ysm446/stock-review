const appState = {
  holdings: [],
  watchlist: []
};

const CHART_COLORS = ["#7df9c9", "#ffb86b", "#7aa6ff", "#ff7e7e", "#a78bfa", "#4dd0e1"];

const views = document.querySelectorAll(".view");
const navButtons = document.querySelectorAll(".nav-button");
const statsGrid = document.getElementById("stats-grid");
const holdingsBody = document.getElementById("holdings-body");
const reviewList = document.getElementById("review-list");
const allocationLegend = document.getElementById("allocation-legend");
const allocationChart = document.getElementById("allocation-chart");
const holdingRowTemplate = document.getElementById("holding-row-template");
const reviewCardTemplate = document.getElementById("review-card-template");

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const { view } = button.dataset;
    navButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    views.forEach((panel) => panel.classList.toggle("is-visible", panel.id === `view-${view}`));
  });
});

document.getElementById("add-holding").addEventListener("click", () => {
  appState.holdings.push({ ticker: "", shares: 0, price: 0, note: "" });
  render();
});

document.getElementById("add-review").addEventListener("click", () => {
  appState.watchlist.push({ ticker: "", rating: "B", thesis: "", risk: "" });
  render();
});

document.getElementById("save-portfolio").addEventListener("click", async () => {
  await window.stockReviewApi.savePortfolio(appState);
  const button = document.getElementById("save-portfolio");
  const previousText = button.textContent;
  button.textContent = "保存済み";
  setTimeout(() => {
    button.textContent = previousText;
  }, 1200);
});

function normalizeHolding(raw) {
  const shares = Number(raw.shares) || 0;
  const price = Number(raw.price) || 0;
  return {
    ticker: raw.ticker || "",
    shares,
    price,
    note: raw.note || "",
    marketValue: shares * price
  };
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

function calculateStats() {
  const holdings = appState.holdings.map(normalizeHolding);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  const totalPositions = holdings.filter((item) => item.ticker).length;
  const topHolding = holdings
    .filter((item) => item.marketValue > 0)
    .sort((a, b) => b.marketValue - a.marketValue)[0];
  const concentration = totalValue > 0 && topHolding ? (topHolding.marketValue / totalValue) * 100 : 0;

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
    },
    {
      label: "最大保有",
      value: topHolding?.ticker || "-",
      sub: topHolding ? formatCurrency(topHolding.marketValue) : "未入力"
    },
    {
      label: "集中度",
      value: formatPercent(concentration),
      sub: "最大保有の比率"
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

function attachHoldingRowEvents(row, index) {
  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", (event) => {
      const { field } = event.target.dataset;
      appState.holdings[index][field] = event.target.value;
      render();
    });
  });

  row.querySelector('[data-action="remove-holding"]').addEventListener("click", () => {
    appState.holdings.splice(index, 1);
    render();
  });
}

function renderHoldingsTable() {
  holdingsBody.innerHTML = "";

  appState.holdings.forEach((holding, index) => {
    const normalized = normalizeHolding(holding);
    const fragment = holdingRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");

    row.querySelector('[data-field="ticker"]').value = holding.ticker || "";
    row.querySelector('[data-field="shares"]').value = holding.shares || "";
    row.querySelector('[data-field="price"]').value = holding.price || "";
    row.querySelector('[data-field="note"]').value = holding.note || "";
    row.querySelector('[data-field="marketValue"]').textContent = formatCurrency(normalized.marketValue);

    attachHoldingRowEvents(row, index);
    holdingsBody.appendChild(fragment);
  });
}

function attachReviewEvents(card, index) {
  card.querySelectorAll("input, textarea, select").forEach((field) => {
    field.addEventListener("input", (event) => {
      appState.watchlist[index][event.target.dataset.field] = event.target.value;
    });
  });

  card.querySelector('[data-action="remove-review"]').addEventListener("click", () => {
    appState.watchlist.splice(index, 1);
    render();
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
  const centerY = height / 2;
  const radius = 128;
  const innerRadius = 72;
  const holdings = appState.holdings.map(normalizeHolding).filter((item) => item.ticker && item.marketValue > 0);
  const totalValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);

  ctx.clearRect(0, 0, width, height);
  allocationLegend.innerHTML = "";

  if (!holdings.length || totalValue === 0) {
    ctx.fillStyle = "rgba(158, 179, 206, 0.16)";
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.fillStyle = "#9eb3ce";
    ctx.font = "16px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText("データを入力すると表示", centerX, centerY + 4);
    return;
  }

  let angle = -Math.PI / 2;
  holdings.forEach((holding, index) => {
    const ratio = holding.marketValue / totalValue;
    const slice = ratio * Math.PI * 2;
    const color = CHART_COLORS[index % CHART_COLORS.length];

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.fillStyle = color;
    ctx.arc(centerX, centerY, radius, angle, angle + slice);
    ctx.arc(centerX, centerY, innerRadius, angle + slice, angle, true);
    ctx.closePath();
    ctx.fill();

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <div class="legend-text">
        <span>${holding.ticker}</span>
        <span>${formatPercent(ratio * 100)}</span>
      </div>
    `;
    allocationLegend.appendChild(item);

    angle += slice;
  });

  ctx.fillStyle = "#ecf4ff";
  ctx.font = "700 26px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(formatCurrency(totalValue), centerX, centerY + 8);
  ctx.fillStyle = "#9eb3ce";
  ctx.font = "14px Segoe UI";
  ctx.fillText("Total Value", centerX, centerY + 34);
}

function render() {
  renderStats();
  renderHoldingsTable();
  renderReviews();
  drawAllocationChart();
}

async function init() {
  const data = await window.stockReviewApi.loadPortfolio();
  appState.holdings = Array.isArray(data.holdings) ? data.holdings : [];
  appState.watchlist = Array.isArray(data.watchlist) ? data.watchlist : [];
  render();
}

init();
