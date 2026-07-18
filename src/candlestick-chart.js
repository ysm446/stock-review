// 蓄積型日足のローソク足チャート（出来高・移動平均線・価格帯別出来高・
// タイムマシン表示付き）。個別銘柄レビューとマーケットページで共用する。
// createCandlestickChart() がインスタンスを作り、状態（表示期間・MA選択・
// 終端オフセット等）はインスタンスごとに localStorage の storagePrefix 配下へ保存する。

import { clamp } from "./renderer-utils.js";

export const MA_COLORS = { 25: "#f59e0b", 50: "#06b6d4", 75: "#a78bfa", 200: "#ec4899" };
export const MARGIN_COLORS = { buy: "#f97316", sell: "#38bdf8" };
const SCRUB_MIN_VISIBLE = 20;
const CANDLE_UP_COLOR = "#ef4444";
const CANDLE_DOWN_COLOR = "#22c55e";

export function prepareHiDPICanvas(canvas) {
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

// チャート系メニュー（移動平均線・価格帯別出来高）の開閉。
// どれかを開くと他インスタンスも含め全メニューを閉じる。
const chartMenuClosers = [];
let menuDocumentHandlersInstalled = false;

function closeAllChartMenus() {
  chartMenuClosers.forEach((close) => close());
}

function setupChartMenu(button, menu) {
  const close = () => {
    menu.classList.add("is-hidden");
    button.setAttribute("aria-expanded", "false");
  };
  chartMenuClosers.push(close);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.classList.contains("is-hidden");
    closeAllChartMenus();
    if (willOpen) {
      menu.classList.remove("is-hidden");
      button.setAttribute("aria-expanded", "true");
    }
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  if (!menuDocumentHandlersInstalled) {
    menuDocumentHandlersInstalled = true;
    document.addEventListener("click", closeAllChartMenus);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllChartMenus();
    });
  }
}

function getNicePriceStep(range, targetIntervals = 5) {
  const roughStep = Math.max(range / targetIntervals, Number.EPSILON);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceFactor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceFactor * magnitude;
}

function calculateMovingAverage(rows, period) {
  const values = new Map();
  let sum = 0;
  rows.forEach((row, index) => {
    sum += Number(row.close);
    if (index >= period) sum -= Number(rows[index - period].close);
    if (index >= period - 1) values.set(row.date, sum / period);
  });
  return values;
}

function getTurningPoints(rows) {
  if (!rows.length) return [];
  const windowSize = Math.max(2, Math.floor(rows.length / 25));
  const candidates = [];
  for (let index = windowSize; index < rows.length - windowSize; index += 1) {
    const neighbors = rows.slice(index - windowSize, index + windowSize + 1);
    const high = Number(rows[index].high), low = Number(rows[index].low);
    const otherHighs = neighbors.filter((_, offset) => offset !== windowSize).map((row) => Number(row.high));
    const otherLows = neighbors.filter((_, offset) => offset !== windowSize).map((row) => Number(row.low));
    if (high >= Math.max(...otherHighs)) {
      candidates.push({ index, type: "high", value: high, prominence: high - Math.min(...otherLows) });
    }
    if (low <= Math.min(...otherLows)) {
      candidates.push({ index, type: "low", value: low, prominence: Math.max(...otherHighs) - low });
    }
  }
  const highIndex = rows.reduce((best, row, index) => Number(row.high) > Number(rows[best].high) ? index : best, 0);
  const lowIndex = rows.reduce((best, row, index) => Number(row.low) < Number(rows[best].low) ? index : best, 0);
  const selected = [
    { index: highIndex, type: "high", value: Number(rows[highIndex].high), prominence: Infinity },
    { index: lowIndex, type: "low", value: Number(rows[lowIndex].low), prominence: Infinity }
  ].filter((point, index, list) => list.findIndex((other) => other.index === point.index && other.type === point.type) === index);
  const minDistance = Math.max(3, Math.floor(rows.length / 10));
  candidates.sort((a, b) => b.prominence - a.prominence).forEach((candidate) => {
    if (selected.length >= 6) return;
    if (selected.every((point) => Math.abs(point.index - candidate.index) >= minDistance)) selected.push(candidate);
  });
  return selected.sort((a, b) => a.index - b.index);
}

// config:
//   canvas / wrap / tooltip / crosshair / crosshairPrice / summary … 必須要素
//   rangeSelect … 表示期間 <select>（1m/3m/6m/1y/all）
//   maMenuButton / maMenu … 移動平均線メニュー（トグルは maMenu 内の checkbox を自動検出）
//   volumeProfileMenuButton / volumeProfileMenu / volumeProfileToggle … 価格帯別出来高（省略可。本数 radio は menu 内を自動検出）
//   marginMenuButton / marginMenu … 信用残メニュー（省略可。買い残/売り残 checkbox を自動検出）
//   scrub: { container, slider, stepBack, stepForward, latest } … タイムマシン操作（省略可）
//   resizer … 高さ調整ハンドル（省略可）
//   storagePrefix … localStorage キーの前置詞（例 "stock-review.review"）
//   getRows() … 全日足（古い順）。不正な行はチャート側で除外する
//   getMarginRows() … 信用残の週次履歴（古い順、{date, sell, buy}。省略可）
//   getEmptyState() … データ無し時の { summary, canvas } メッセージ
//   getSummarySuffix() … サマリー行の末尾に足す文字列（省略可）
//   onAfterDraw({ endRows, isPast }) … 描画のたびに呼ばれる（見出し・株価表示の更新用）
export function createCandlestickChart(config) {
  const {
    canvas, wrap, tooltip, crosshair, crosshairPrice, summary,
    rangeSelect, maMenuButton, maMenu,
    volumeProfileMenuButton, volumeProfileMenu, volumeProfileToggle,
    marginMenuButton, marginMenu,
    scrub, resizer,
    storagePrefix,
    getRows,
    getMarginRows = () => [],
    getEmptyState = () => ({ summary: "データがありません", canvas: "表示できるデータがありません" }),
    getSummarySuffix = () => "",
    onAfterDraw = () => {},
    maDefault = [25, 50],
    heightDefault = 290, heightMin = 180, heightMax = 640
  } = config;

  const RANGE_KEY = `${storagePrefix}ChartRange`;
  const MA_KEY = `${storagePrefix}MovingAverages`;
  const VOLUME_PROFILE_KEY = `${storagePrefix}VolumeProfile`;
  const VOLUME_PROFILE_BINS_KEY = `${storagePrefix}VolumeProfileBins`;
  const MARGIN_KEY = `${storagePrefix}MarginSeries`;
  const HEIGHT_KEY = `${storagePrefix}ChartHeight`;

  const maToggles = maMenu ? [...maMenu.querySelectorAll('input[type="checkbox"]')] : [];
  const marginToggles = marginMenu ? [...marginMenu.querySelectorAll('input[type="checkbox"]')] : [];
  const volumeProfileBinsInputs = volumeProfileMenu
    ? [...volumeProfileMenu.querySelectorAll('input[type="radio"]')]
    : [];

  let endOffset = 0; // 最新から何営業日戻るか。0 = 最新（セッション内のみ・非永続）
  let model = null;  // 直近描画の座標系（ツールチップ・十字線用）

  function getAllRows() {
    return (getRows() || []).filter((row) => [row.open, row.high, row.low, row.close].every((value) => (
      value !== null && value !== undefined && value !== ""
      && Number.isFinite(Number(value)) && Number(value) > 0
    )));
  }

  function getScrubMaxOffset(allRows) {
    return Math.max(0, allRows.length - SCRUB_MIN_VISIBLE);
  }

  // 全日足を表示終端の日付まで切り詰める。移動平均線・価格帯別出来高・山谷ラベルは
  // この切り詰め後の足から計算されるため、その時点を「今日」とした状態で再計算される。
  function getRowsUpToEnd() {
    const rows = getAllRows();
    if (endOffset <= 0) return rows;
    endOffset = Math.min(endOffset, getScrubMaxOffset(rows));
    return rows.slice(0, rows.length - endOffset);
  }

  function getVisibleRows() {
    const rows = getRowsUpToEnd();
    const range = rangeSelect ? rangeSelect.value : "all";
    if (!rows.length || range === "all") return rows;
    const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 }[range] || 12;
    const start = new Date(`${rows[rows.length - 1].date}T00:00:00`);
    start.setMonth(start.getMonth() - months);
    return rows.filter((row) => new Date(`${row.date}T00:00:00`) >= start);
  }

  function drawMovingAverages(ctx, rows, allRows, padding, step, yFor) {
    const enabled = new Set(maToggles.filter((toggle) => toggle.checked).map((toggle) => Number(toggle.value)));
    enabled.forEach((period) => {
      const averages = calculateMovingAverage(allRows, period);
      ctx.strokeStyle = MA_COLORS[period] || "#94a3b8"; ctx.lineWidth = 1.7; ctx.globalAlpha = 0.95;
      ctx.beginPath(); let started = false;
      rows.forEach((row, index) => {
        const value = averages.get(row.date);
        if (!Number.isFinite(value)) return;
        const x = padding.left + step * (index + 0.5), y = yFor(value);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      if (started) ctx.stroke();
    });
    ctx.lineWidth = 1; ctx.globalAlpha = 1;
  }

  function drawTurningPointLabels(ctx, rows, padding, step, yFor, width, priceDecimals) {
    ctx.font = "600 10px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 3;
    getTurningPoints(rows).forEach((point) => {
      const x = Math.max(padding.left + 24, Math.min(width - padding.right - 24, padding.left + step * (point.index + 0.5)));
      const y = yFor(point.value) + (point.type === "high" ? -7 : 13);
      const label = point.value.toLocaleString(undefined, { maximumFractionDigits: Math.max(2, priceDecimals) });
      ctx.strokeStyle = "rgba(15, 23, 42, 0.9)"; ctx.strokeText(label, x, y);
      ctx.fillStyle = "#e5e7eb"; ctx.fillText(label, x, y);
    });
    ctx.lineWidth = 1;
  }

  function getVolumeProfileBinCount() {
    const checked = volumeProfileBinsInputs.find((input) => input.checked);
    const value = Number(checked && checked.value);
    return Number.isFinite(value) && value > 0 ? value : 24;
  }

  function drawVolumeProfile(ctx, rows, padding, width, minPrice, maxPrice, priceHeight) {
    if (!volumeProfileToggle || !volumeProfileToggle.checked) return;
    const binCount = getVolumeProfileBinCount();
    const binSize = (maxPrice - minPrice) / binCount;
    if (!(binSize > 0)) return;
    const bins = Array.from({ length: binCount }, () => 0);
    rows.forEach((row) => {
      const price = Number(row.close), volume = Number(row.volume);
      if (!Number.isFinite(price) || !Number.isFinite(volume) || volume <= 0) return;
      const index = Math.min(binCount - 1, Math.max(0, Math.floor((price - minPrice) / binSize)));
      bins[index] += volume;
    });
    const maxBinVolume = Math.max(...bins);
    if (!(maxBinVolume > 0)) return;
    const maxBarWidth = Math.min(180, (width - padding.left - padding.right) * 0.22);
    const binHeight = priceHeight / binCount;
    ctx.save();
    bins.forEach((volume, index) => {
      if (volume <= 0) return;
      const ratio = volume / maxBinVolume;
      const barWidth = ratio * maxBarWidth;
      const y = padding.top + priceHeight - (index + 1) * binHeight;
      // 出来高が多い価格帯ほど明るく（不透明に）、少ないほど暗く
      ctx.fillStyle = `rgba(96, 165, 250, ${(0.08 + ratio * 0.4).toFixed(3)})`;
      ctx.fillRect(width - padding.right - barWidth, y + 0.5, barWidth, Math.max(1, binHeight - 1));
    });
    ctx.restore();
  }

  // 各ローソクの日付時点で公表済み（申込日＝週末がその日以前）の最新の信用残を割り当てる
  function getMarginValues(rows) {
    const marginRows = (getMarginRows() || []).filter((row) => row && row.date);
    if (!marginRows.length || !rows.length) return null;
    const values = new Array(rows.length);
    let cursor = -1;
    rows.forEach((row, index) => {
      while (cursor + 1 < marginRows.length && marginRows[cursor + 1].date <= row.date) cursor += 1;
      values[index] = cursor >= 0 ? marginRows[cursor] : null;
    });
    return values;
  }

  function getEnabledMarginSeries() {
    return marginToggles.filter((toggle) => toggle.checked).map((toggle) => toggle.value);
  }

  // 信用残（週次）を出来高エリアに階段状ラインで重ねる。
  // 縦スケールは表示中の買い残・売り残の最大値（出来高バーとは独立）。
  function drawMarginBalances(ctx, rows, marginValues, padding, step, height, volumeHeight) {
    const enabled = getEnabledMarginSeries();
    if (!marginValues || !enabled.length) return;
    const peak = Math.max(0, ...marginValues.flatMap((value) => (
      value ? enabled.map((key) => Number(value[key]) || 0) : []
    )));
    if (!(peak > 0)) return;
    const bottom = height - padding.bottom;
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.9;
    enabled.forEach((key) => {
      ctx.strokeStyle = MARGIN_COLORS[key] || "#94a3b8";
      ctx.beginPath();
      let started = false;
      rows.forEach((row, index) => {
        const value = marginValues[index] ? Number(marginValues[index][key]) : NaN;
        if (!Number.isFinite(value)) return;
        const x = padding.left + step * index;
        const y = bottom - (value / peak) * volumeHeight;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        ctx.lineTo(x + step, y);
      });
      if (started) ctx.stroke();
    });
    ctx.restore();
  }

  function updateScrub(allRows) {
    if (!scrub) return;
    const hasData = allRows.length > 0;
    scrub.container.classList.toggle("is-hidden", !hasData);
    if (!hasData) return;
    const maxOffset = getScrubMaxOffset(allRows);
    endOffset = Math.min(endOffset, maxOffset);
    scrub.slider.max = String(maxOffset);
    scrub.slider.value = String(maxOffset - endOffset);
    scrub.slider.disabled = maxOffset === 0;
    scrub.stepBack.disabled = endOffset >= maxOffset;
    scrub.stepForward.disabled = endOffset <= 0;
    scrub.latest.disabled = endOffset <= 0;
  }

  function setEndOffset(offset) {
    const maxOffset = getScrubMaxOffset(getAllRows());
    const next = Math.min(maxOffset, Math.max(0, Math.round(Number(offset) || 0)));
    if (next === endOffset) return;
    endOffset = next;
    draw();
  }

  function draw() {
    const { ctx, width, height } = prepareHiDPICanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const rows = getVisibleRows();
    const allRows = getAllRows();
    updateScrub(allRows);
    onAfterDraw({ endRows: getRowsUpToEnd(), isPast: endOffset > 0 });
    model = null;
    tooltip.classList.add("is-hidden");
    crosshair.classList.add("is-hidden");
    if (!rows.length) {
      const emptyState = getEmptyState();
      summary.textContent = emptyState.summary;
      ctx.fillStyle = "rgba(148, 163, 184, 0.85)"; ctx.font = "13px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(emptyState.canvas, width / 2, height / 2); return;
    }
    const padding = { left: 62, right: 16, top: 16, bottom: 28 };
    const volumeHeight = Math.max(44, height * 0.18), gap = 14;
    const priceBottom = height - padding.bottom - volumeHeight - gap;
    const plotWidth = width - padding.left - padding.right, priceHeight = priceBottom - padding.top;
    const lows = rows.map((r) => Number(r.low)).filter(Number.isFinite);
    const highs = rows.map((r) => Number(r.high)).filter(Number.isFinite);
    let minPrice = Math.min(...lows), maxPrice = Math.max(...highs);
    const pricePad = Math.max((maxPrice - minPrice) * 0.06, maxPrice * 0.002);
    const priceStep = getNicePriceStep(maxPrice - minPrice + pricePad * 2);
    minPrice = Math.floor((minPrice - pricePad) / priceStep) * priceStep;
    maxPrice = Math.ceil((maxPrice + pricePad) / priceStep) * priceStep;
    const priceRange = Math.max(0.000001, maxPrice - minPrice);
    const maxVolume = Math.max(1, ...rows.map((r) => Number(r.volume) || 0));
    const step = plotWidth / rows.length, bodyWidth = Math.max(1, Math.min(12, step * 0.68));
    const yFor = (value) => padding.top + (maxPrice - value) / priceRange * priceHeight;
    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)"; ctx.fillStyle = "rgba(148, 163, 184, 0.8)";
    ctx.font = "11px sans-serif"; ctx.textAlign = "right";
    const priceDecimals = priceStep < 1 ? Math.min(4, Math.ceil(-Math.log10(priceStep))) : 0;
    for (let value = maxPrice; value >= minPrice - priceStep * 0.001; value -= priceStep) {
      const y = yFor(value);
      ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
      ctx.fillText(value.toLocaleString(undefined, {
        minimumFractionDigits: priceDecimals,
        maximumFractionDigits: priceDecimals
      }), padding.left - 7, y + 4);
    }
    // ローソク足より先に描いて背面に敷く
    drawVolumeProfile(ctx, rows, padding, width, minPrice, maxPrice, priceHeight);
    rows.forEach((row, index) => {
      const x = padding.left + step * (index + 0.5);
      const open = Number(row.open), high = Number(row.high), low = Number(row.low), close = Number(row.close);
      if (![open, high, low, close].every(Number.isFinite)) return;
      const color = close >= open ? CANDLE_UP_COLOR : CANDLE_DOWN_COLOR; ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, yFor(high)); ctx.lineTo(x, yFor(low)); ctx.stroke();
      const top = Math.min(yFor(open), yFor(close)), bodyHeight = Math.max(1, Math.abs(yFor(open) - yFor(close)));
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, bodyHeight);
      const barHeight = (Number(row.volume) || 0) / maxVolume * volumeHeight;
      ctx.globalAlpha = 0.35; ctx.fillRect(x - bodyWidth / 2, height - padding.bottom - barHeight, bodyWidth, barHeight); ctx.globalAlpha = 1;
    });
    const marginValues = getMarginValues(rows);
    drawMarginBalances(ctx, rows, marginValues, padding, step, height, volumeHeight);
    drawMovingAverages(ctx, rows, getRowsUpToEnd(), padding, step, yFor);
    drawTurningPointLabels(ctx, rows, padding, step, yFor, width, priceDecimals);
    ctx.fillStyle = "rgba(148, 163, 184, 0.8)"; ctx.textAlign = "center";
    const labelCount = Math.min(5, rows.length);
    for (let i = 0; i < labelCount; i += 1) {
      const index = Math.round(i * (rows.length - 1) / Math.max(1, labelCount - 1));
      ctx.fillText(rows[index].date.slice(5).replace("-", "/"), padding.left + step * (index + 0.5), height - 7);
    }
    const first = rows[0], last = rows[rows.length - 1], change = Number(last.close) - Number(first.close);
    const percent = Number(first.close) ? change / Number(first.close) * 100 : 0;
    summary.textContent = `${rows.length}日分を表示　${change >= 0 ? "+" : ""}${change.toLocaleString(undefined, { maximumFractionDigits: 2 })}（${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%）${getSummarySuffix()}`;
    model = { rows, padding, step, width, priceBottom, priceHeight, minPrice, maxPrice, priceRange, priceDecimals, marginValues };
  }

  // ---- 設定の復元とイベント配線 ----

  if (rangeSelect) {
    rangeSelect.value = localStorage.getItem(RANGE_KEY) || "1y";
    rangeSelect.addEventListener("change", () => {
      localStorage.setItem(RANGE_KEY, rangeSelect.value); draw();
    });
  }

  if (maToggles.length) {
    try {
      const savedMovingAverages = JSON.parse(localStorage.getItem(MA_KEY) || JSON.stringify(maDefault));
      maToggles.forEach((toggle) => { toggle.checked = savedMovingAverages.includes(Number(toggle.value)); });
    } catch (_error) {
      // 保存値が壊れているときはHTMLの初期状態のまま
    }
    maToggles.forEach((toggle) => toggle.addEventListener("change", () => {
      const enabled = maToggles.filter((item) => item.checked).map((item) => Number(item.value));
      localStorage.setItem(MA_KEY, JSON.stringify(enabled));
      draw();
    }));
  }
  if (maMenuButton && maMenu) setupChartMenu(maMenuButton, maMenu);

  if (volumeProfileToggle) {
    volumeProfileToggle.checked = localStorage.getItem(VOLUME_PROFILE_KEY) !== "false";
    volumeProfileToggle.addEventListener("change", () => {
      localStorage.setItem(VOLUME_PROFILE_KEY, String(volumeProfileToggle.checked));
      draw();
    });
  }
  if (volumeProfileBinsInputs.length) {
    const savedBins = localStorage.getItem(VOLUME_PROFILE_BINS_KEY);
    const binValues = volumeProfileBinsInputs.map((input) => input.value);
    const activeBins = binValues.includes(savedBins) ? savedBins : "24";
    volumeProfileBinsInputs.forEach((input) => { input.checked = input.value === activeBins; });
    volumeProfileBinsInputs.forEach((input) => input.addEventListener("change", () => {
      localStorage.setItem(VOLUME_PROFILE_BINS_KEY, input.value);
      draw();
    }));
  }
  if (volumeProfileMenuButton && volumeProfileMenu) setupChartMenu(volumeProfileMenuButton, volumeProfileMenu);

  if (marginToggles.length) {
    try {
      const savedMarginSeries = JSON.parse(localStorage.getItem(MARGIN_KEY) || '["buy","sell"]');
      marginToggles.forEach((toggle) => { toggle.checked = savedMarginSeries.includes(toggle.value); });
    } catch (_error) {
      // 保存値が壊れているときはHTMLの初期状態のまま
    }
    marginToggles.forEach((toggle) => toggle.addEventListener("change", () => {
      localStorage.setItem(MARGIN_KEY, JSON.stringify(getEnabledMarginSeries()));
      draw();
    }));
  }
  if (marginMenuButton && marginMenu) setupChartMenu(marginMenuButton, marginMenu);

  if (scrub) {
    scrub.slider.addEventListener("input", () => {
      const maxOffset = Number(scrub.slider.max) || 0;
      setEndOffset(maxOffset - Number(scrub.slider.value));
    });
    scrub.stepBack.addEventListener("click", () => setEndOffset(endOffset + 1));
    scrub.stepForward.addEventListener("click", () => setEndOffset(endOffset - 1));
    scrub.latest.addEventListener("click", () => setEndOffset(0));
  }

  function setChartHeight(height, persist = false) {
    const next = Math.min(heightMax, Math.max(heightMin, Math.round(Number(height) || heightDefault)));
    wrap.style.height = `${next}px`;
    if (persist) localStorage.setItem(HEIGHT_KEY, String(next));
  }

  // チャート下端のハンドルをドラッグして高さを調整する。再描画はResizeObserverが追従する。
  if (resizer) {
    setChartHeight(Number(localStorage.getItem(HEIGHT_KEY)) || heightDefault);
    let resizing = false, startY = 0, startHeight = 0;
    const resize = (event) => {
      if (resizing) setChartHeight(startHeight + event.clientY - startY);
    };
    const finish = () => {
      if (!resizing) return;
      resizing = false;
      resizer.classList.remove("is-active");
      setChartHeight(wrap.getBoundingClientRect().height, true);
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    resizer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resizing = true;
      startY = event.clientY;
      startHeight = wrap.getBoundingClientRect().height;
      resizer.classList.add("is-active");
      resizer.setPointerCapture?.(event.pointerId);
      window.addEventListener("pointermove", resize);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
    resizer.addEventListener("dblclick", () => setChartHeight(heightDefault, true));
  }

  wrap.addEventListener("mousemove", (event) => {
    if (!model) return;
    const rect = wrap.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const { rows, padding, step, width, priceBottom, priceHeight, maxPrice, priceRange, priceDecimals } = model;
    const isInPricePlot = x >= padding.left && x <= width - padding.right && y >= padding.top && y <= priceBottom;
    if (isInPricePlot) {
      const price = maxPrice - ((y - padding.top) / priceHeight) * priceRange;
      crosshair.style.left = `${padding.left}px`;
      crosshair.style.right = `${padding.right}px`;
      crosshair.style.top = `${y}px`;
      crosshairPrice.textContent = price.toLocaleString(undefined, {
        minimumFractionDigits: priceDecimals,
        maximumFractionDigits: priceDecimals
      });
      crosshair.classList.remove("is-hidden");
    } else {
      crosshair.classList.add("is-hidden");
    }
    const index = Math.floor((x - padding.left) / step);
    if (index < 0 || index >= rows.length) { tooltip.classList.add("is-hidden"); return; }
    const row = rows[index], fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
    let marginText = "";
    const margin = getEnabledMarginSeries().length ? model.marginValues?.[index] : null;
    if (margin) {
      const ratio = Number(margin.sell) > 0 ? `　倍率 ${(Number(margin.buy) / Number(margin.sell)).toFixed(2)}` : "";
      marginText = `　信用買残 ${(Number(margin.buy) || 0).toLocaleString()}　売残 ${(Number(margin.sell) || 0).toLocaleString()}${ratio}（${margin.date.slice(5).replace("-", "/")}時点）`;
    }
    tooltip.textContent = `${row.date}　始 ${fmt(row.open)}　高 ${fmt(row.high)}　安 ${fmt(row.low)}　終 ${fmt(row.close)}　出来高 ${(Number(row.volume) || 0).toLocaleString()}${marginText}`;
    tooltip.classList.remove("is-hidden");
    const tooltipHalfWidth = tooltip.offsetWidth / 2;
    const tooltipEdgeGap = 8;
    const minCenter = tooltipHalfWidth + tooltipEdgeGap;
    const maxCenter = Math.max(minCenter, rect.width - tooltipHalfWidth - tooltipEdgeGap);
    tooltip.style.left = clamp(x, minCenter, maxCenter) + "px";
  });
  wrap.addEventListener("mouseleave", () => {
    tooltip.classList.add("is-hidden");
    crosshair.classList.add("is-hidden");
  });

  return {
    draw,
    setEndOffset,
    resetEndOffset: () => { endOffset = 0; },
    getEndRows: getRowsUpToEnd,
    isPast: () => endOffset > 0
  };
}
