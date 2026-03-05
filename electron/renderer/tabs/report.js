/* ── Report tab ────────────────────────────────────────────────── */
function init_report() {
  document.getElementById("r-run-btn").addEventListener("click", runReport);
  document.getElementById("r-ai-btn").addEventListener("click", runAIStream);
  document.getElementById("r-ticker").addEventListener("keydown", e => {
    if (e.key === "Enter") runReport();
  });
}

async function runReport() {
  const ticker = document.getElementById("r-ticker").value.trim().toUpperCase();
  if (!ticker) return;
  const btn    = document.getElementById("r-run-btn");
  const status = document.getElementById("r-status");
  const wrap   = document.getElementById("r-report-wrap");

  btn.disabled = true;
  status.textContent = "レポート生成中...";
  wrap.innerHTML = "<p class='hint'>読み込み中...</p>";
  document.getElementById("r-ai-wrap").style.display = "none";

  try {
    const data = await apiFetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    btn.disabled = false;
    if (data.error) { status.textContent = "エラー: " + data.error; wrap.innerHTML = ""; return; }
    status.textContent = `${data.name || ticker} のレポートを生成しました。`;
    wrap.innerHTML = buildReportHTML(data);
  } catch (e) {
    btn.disabled = false;
    status.textContent = "エラー: " + e.message;
    wrap.innerHTML = "";
  }
}

async function runAIStream() {
  const ticker = document.getElementById("r-ticker").value.trim().toUpperCase();
  if (!ticker) return;
  const btn    = document.getElementById("r-ai-btn");
  const aiWrap = document.getElementById("r-ai-wrap");
  const aiBox  = document.getElementById("r-ai-content");

  btn.disabled = true;
  aiWrap.style.display = "";
  aiBox.textContent = "AI 分析中...";

  try {
    await apiStream(
      `/api/report/stream?ticker=${encodeURIComponent(ticker)}`,
      {},
      (chunk) => { aiBox.textContent = chunk; },
      (err)   => { aiBox.textContent = "エラー: " + err; }
    );
  } catch (e) {
    aiBox.textContent = "エラー: " + e.message;
  }
  btn.disabled = false;
}

/* ── Report HTML builder ─────────────────────────────────────── */
function buildReportHTML(r) {
  const cur = r.currency || "";
  const pct = v => v == null ? "-" : `${fmt(v * 100, 1)}%`;

  const sections = [];

  // ── Header card ───────────────────────────────────────────
  sections.push(`
    <div class="card wide">
      <h4>${r.name || r.ticker}（${r.ticker}）</h4>
      <table>
        <tr><td>セクター</td><td>${r.sector || "-"}</td></tr>
        <tr><td>業種</td><td>${r.industry || "-"}</td></tr>
        <tr><td>現在値</td><td>${fmtPrice(r.current_price, cur)}</td></tr>
        <tr><td>時価総額</td><td>${r.market_cap ? fmt(r.market_cap / 1e8, 0) + " 億" : "-"}</td></tr>
        <tr><td>52週高値</td><td>${fmtPrice(r.week52_high, cur)}</td></tr>
        <tr><td>52週安値</td><td>${fmtPrice(r.week52_low, cur)}</td></tr>
      </table>
    </div>`);

  // ── Valuation ─────────────────────────────────────────────
  sections.push(rCard("バリュエーション", [
    ["PER",       r.per     != null ? `${fmt(r.per, 1)} 倍`    : "-"],
    ["PBR",       r.pbr     != null ? `${fmt(r.pbr, 2)} 倍`    : "-"],
    ["EV/EBITDA", r.ev_ebitda != null ? `${fmt(r.ev_ebitda, 1)} 倍` : "-"],
    ["配当利回り",  r.dividend_yield != null ? `${fmt(r.dividend_yield * 100, 2)}%` : "-"],
    ["バリュースコア", scoreBadge(r.value_score)],
  ]));

  // ── Profitability ─────────────────────────────────────────
  sections.push(rCard("収益性", [
    ["ROE",          pct(r.roe)],
    ["ROA",          pct(r.roa)],
    ["営業利益率",    pct(r.operating_margin)],
    ["FCF マージン", pct(r.fcf_margin)],
  ]));

  // ── Financials (最新3期) ──────────────────────────────────
  const fin = r.financials || {};
  const revMap = fin.revenue          || {};
  const opMap  = fin.operating_income || {};
  const niMap  = fin.net_income       || {};
  const dates  = Object.keys(revMap).sort().reverse().slice(0, 3);
  if (dates.length) {
    const rows = dates.map(d => {
      const shortDate = d.slice(0, 7);
      return `<tr>
        <td>${shortDate}</td>
        <td style="text-align:right">${revMap[d] != null ? fmt(revMap[d] / 1e8, 0) : "-"}</td>
        <td style="text-align:right">${opMap[d]  != null ? fmt(opMap[d]  / 1e8, 0) : "-"}</td>
        <td style="text-align:right">${niMap[d]  != null ? fmt(niMap[d]  / 1e8, 0) : "-"}</td>
      </tr>`;
    }).join("");
    sections.push(`
      <div class="card wide">
        <h4>財務サマリー（億円）</h4>
        <table class="data-table">
          <thead><tr><th>期</th><th>売上高</th><th>営業利益</th><th>純利益</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  // ── Analyst ───────────────────────────────────────────────
  const a = r.analyst || {};
  if (a.analyst_count) {
    sections.push(rCard("アナリスト情報", [
      ["アナリスト数",     a.analyst_count || "-"],
      ["目標株価 (平均)",  fmtPrice(a.target_mean, cur)],
      ["目標株価 (高値)",  fmtPrice(a.target_high, cur)],
      ["目標株価 (安値)",  fmtPrice(a.target_low,  cur)],
      ["推奨",            a.recommendation || "-"],
    ]));
  }

  // ── News ──────────────────────────────────────────────────
  const news = r.news || [];
  if (news.length) {
    const items = news.map(n => {
      const title = n.title || n.headline || String(n);
      const url   = n.link  || n.url      || null;
      return url
        ? `<li><a href="${url}" target="_blank" style="color:var(--orange)">${title}</a></li>`
        : `<li>${title}</li>`;
    }).join("");
    sections.push(`
      <div class="card wide">
        <h4>最新ニュース</h4>
        <ul style="margin:0 0 0 16px;line-height:1.8;font-size:13px">${items}</ul>
      </div>`);
  }

  return `<div class="cards-grid">${sections.join("")}</div>`;
}

function rCard(title, rows) {
  const trs = rows.map(([k, v]) => {
    const vHtml = typeof v === "string" && v.includes("<") ? v : (v ?? "-");
    return `<tr><td>${k}</td><td>${vHtml}</td></tr>`;
  }).join("");
  return `<div class="card"><h4>${title}</h4><table>${trs}</table></div>`;
}
