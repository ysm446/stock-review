/* ── Stress test tab ───────────────────────────────────────────── */
async function init_stress() {
  const cfg = await getConfig();
  const sel = document.getElementById("st-scenario");
  Object.entries(cfg.scenarios).forEach(([k, v]) => {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = v.name;
    sel.appendChild(opt);
  });

  document.getElementById("st-run-btn").addEventListener("click", runStress);
  document.getElementById("st-load-portfolio-btn").addEventListener("click", loadPortfolioTickers);
}

async function loadPortfolioTickers() {
  try {
    const data = await apiFetch("/api/portfolio/tickers");
    document.getElementById("st-tickers").value = (data.tickers || []).join(", ");
  } catch (e) {
    document.getElementById("st-status").textContent = "エラー: " + e.message;
  }
}

async function runStress() {
  const btn     = document.getElementById("st-run-btn");
  const status  = document.getElementById("st-status");
  const wrap    = document.getElementById("st-result-wrap");
  const tickers = document.getElementById("st-tickers").value.trim();
  const scenario = document.getElementById("st-scenario").value;

  if (!tickers) { status.textContent = "ティッカーを入力してください。"; return; }
  if (!scenario) { status.textContent = "シナリオを選択してください。"; return; }

  btn.disabled = true;
  status.textContent = "分析中...";
  wrap.innerHTML = "<p class='hint'>分析中...</p>";

  const params = new URLSearchParams({ tickers, scenario });
  try {
    const data = await apiFetch("/api/stress?" + params.toString());
    btn.disabled = false;
    if (data.error) { status.textContent = "エラー: " + data.error; wrap.innerHTML = ""; return; }
    status.textContent = "完了";
    wrap.innerHTML = renderStressResult(data);
  } catch (e) {
    btn.disabled = false;
    status.textContent = "エラー: " + e.message;
    wrap.innerHTML = "";
  }
}

function renderStressResult(r) {
  const hhi = r.hhi != null ? fmt(r.hhi, 3) : "-";
  const impact = r.portfolio_impact != null ? fmtPct(r.portfolio_impact * 100) : "-";
  const var95  = r.var_95 != null ? fmtPct(r.var_95 * 100) : "-";
  const impactCls = (r.portfolio_impact || 0) < -0.1 ? "bad" : (r.portfolio_impact || 0) < -0.05 ? "warn" : "good";

  let tickerRows = "";
  if (r.tickers) {
    Object.entries(r.tickers).forEach(([t, d]) => {
      const impact = d.impact != null ? fmtPct(d.impact * 100) : "-";
      const cls = (d.impact || 0) < -0.1 ? "bad" : (d.impact || 0) < 0 ? "warn" : "good";
      tickerRows += `<tr><td>${t}</td><td>${d.etf_class || "-"}</td><td class="${cls}">${impact}</td></tr>`;
    });
  }

  let recsHtml = "";
  if (r.recommendations && r.recommendations.length) {
    recsHtml = "<ul style='margin:8px 0 0 16px;line-height:1.8'>" +
      r.recommendations.map(s => `<li>${s}</li>`).join("") + "</ul>";
  }

  return `
    <h3>${r.scenario_name || "シナリオ分析"}</h3>
    ${r.scenario_description ? `<p style="color:var(--text-sub);margin-bottom:14px">${r.scenario_description}</p>` : ""}
    <div class="cards-grid">
      <div class="card">
        <h4>ポートフォリオ影響</h4>
        <table>
          <tr><td>推定影響</td><td class="${impactCls}">${impact}</td></tr>
          <tr><td>VaR (95%)</td><td>${var95}</td></tr>
          <tr><td>HHI 集中度</td><td>${hhi}</td></tr>
        </table>
      </div>
      ${tickerRows ? `
      <div class="card wide">
        <h4>銘柄別影響</h4>
        <table class="data-table">
          <thead><tr><th>ティッカー</th><th>分類</th><th>影響</th></tr></thead>
          <tbody>${tickerRows}</tbody>
        </table>
      </div>` : ""}
      ${recsHtml ? `
      <div class="card wide">
        <h4>推奨アクション</h4>
        ${recsHtml}
      </div>` : ""}
    </div>`;
}
