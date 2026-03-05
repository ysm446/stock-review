/* ── Portfolio tab ─────────────────────────────────────────────── */
function init_portfolio() {
  // Set today as default date
  document.getElementById("p-date").value = new Date().toISOString().slice(0, 10);

  document.getElementById("p-add-btn").addEventListener("click", addTrade);
  loadPortfolio();

  // Sub-tab switch → refresh positions when switching to positions tab
  document.querySelectorAll("#tab-portfolio .sub-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.subtab === "p-positions") loadPortfolio();
    });
  });
}

async function loadPortfolio() {
  const tradesWrap    = document.getElementById("p-trades-wrap");
  const positionsWrap = document.getElementById("p-positions-wrap");

  try {
    const data = await apiFetch("/api/portfolio");
    renderTrades(data.trades || [], tradesWrap);
    renderPositions(data.positions || {}, positionsWrap);
  } catch (e) {
    tradesWrap.innerHTML = `<p class="hint">エラー: ${e.message}</p>`;
  }
}

function renderTrades(trades, wrap) {
  if (!trades.length) {
    wrap.innerHTML = "<p class='hint'>売買記録がありません。</p>"; return;
  }
  const cols = ["日付", "売買", "ティッカー", "数量", "価格", "通貨", "メモ", "操作"];
  const rows = trades.map((t, i) => [
    t.date, t.action === "buy" ? "買い" : "売り",
    t.ticker, fmt(t.quantity, 0), fmt(t.price), t.currency || "-", t.notes || "-",
    { __html: `<button class="btn-secondary" style="padding:2px 8px;font-size:11px" onclick="deleteTrade(${i})">削除</button>` },
  ]);
  const table = buildTable(cols, rows);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function renderPositions(positions, wrap) {
  const entries = Object.entries(positions);
  if (!entries.length) {
    wrap.innerHTML = "<p class='hint'>保有銘柄がありません。</p>"; return;
  }
  const cols = ["ティッカー", "銘柄名", "数量", "平均取得価格", "通貨"];
  const rows = entries.map(([ticker, p]) => [
    { __html: `<span class="ticker-link" onclick="gotoReport('${ticker}')">${ticker}</span>` },
    p.name || "-",
    fmt(p.quantity, 0), fmt(p.avg_price), p.currency || "-",
  ]);
  const table = buildTable(cols, rows);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

async function addTrade() {
  const status = document.getElementById("p-status");
  const qty    = parseFloat(document.getElementById("p-qty").value);
  const price  = parseFloat(document.getElementById("p-price").value);
  if (!qty || !price) { status.textContent = "数量と価格を入力してください。"; return; }

  const body = {
    date:     document.getElementById("p-date").value,
    action:   document.getElementById("p-action").value,
    ticker:   document.getElementById("p-ticker").value.trim().toUpperCase(),
    quantity: qty,
    price:    price,
    currency: document.getElementById("p-currency").value.trim().toUpperCase() || "JPY",
    notes:    document.getElementById("p-notes").value.trim(),
  };
  if (!body.ticker) { status.textContent = "ティッカーを入力してください。"; return; }

  try {
    const res = await apiFetch("/api/portfolio/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.error) { status.textContent = "エラー: " + res.error; return; }
    status.textContent = "記録を追加しました。";
    loadPortfolio();
  } catch (e) {
    status.textContent = "エラー: " + e.message;
  }
}

async function deleteTrade(index) {
  if (!confirm(`記録 ${index} を削除しますか？`)) return;
  try {
    const res = await apiFetch(`/api/portfolio/trade/${index}`, { method: "DELETE" });
    if (res.error) { alert("エラー: " + res.error); return; }
    loadPortfolio();
  } catch (e) {
    alert("エラー: " + e.message);
  }
}
