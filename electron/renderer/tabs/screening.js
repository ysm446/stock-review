/* ── Screening tab ─────────────────────────────────────────────── */
async function init_screening() {
  const cfg = await getConfig();

  // Populate region dropdown
  const regionSel = document.getElementById("s-region");
  Object.entries(cfg.exchanges).forEach(([k, v]) => {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = v.name;
    if (k === "japan") opt.selected = true;
    regionSel.appendChild(opt);
  });

  // Populate preset radios (query mode)
  const presetRadio = document.getElementById("s-preset-radio");
  const presetList  = document.getElementById("s-preset-list");
  Object.entries(cfg.presets).forEach(([k, v], i) => {
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="radio" name="s-preset" value="${k}" ${i===0?"checked":""}> ${v.description}`;
    presetRadio.appendChild(lbl);
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = v.description;
    presetList.appendChild(opt);
  });

  // Limit slider
  const slider = document.getElementById("s-limit");
  const limitVal = document.getElementById("s-limit-val");
  slider.addEventListener("input", () => { limitVal.textContent = slider.value; });

  // Mode toggle
  document.querySelectorAll("input[name='s-mode']").forEach(r => {
    r.addEventListener("change", () => {
      const isQuery = r.value === "query";
      document.getElementById("s-query-controls").style.display = isQuery ? "" : "none";
      document.getElementById("s-list-controls").style.display  = isQuery ? "none" : "";
    });
  });

  // Run button
  document.getElementById("s-run-btn").addEventListener("click", runScreening);
}

async function runScreening() {
  const btn    = document.getElementById("s-run-btn");
  const status = document.getElementById("s-status");
  const wrap   = document.getElementById("s-result-wrap");
  const mode   = document.querySelector("input[name='s-mode']:checked").value;

  btn.disabled = true;
  status.textContent = "スクリーニング中...";
  wrap.innerHTML = "<p class='hint'>読み込み中...</p>";

  const params = new URLSearchParams({ mode });
  if (mode === "query") {
    params.set("region",  document.getElementById("s-region").value);
    params.set("preset",  document.querySelector("input[name='s-preset']:checked")?.value || "value");
    params.set("limit",   document.getElementById("s-limit").value);
  } else {
    params.set("tickers", document.getElementById("s-tickers").value);
    params.set("preset",  document.getElementById("s-preset-list").value);
  }

  try {
    const data = await apiFetch("/api/screening?" + params.toString());
    btn.disabled = false;
    if (data.error) { status.textContent = "エラー: " + data.error; wrap.innerHTML = ""; return; }
    status.textContent = data.message || `${data.count} 件`;
    renderScreeningResults(data.results, wrap);
  } catch (e) {
    btn.disabled = false;
    status.textContent = "エラー: " + e.message;
    wrap.innerHTML = "";
  }
}

function renderScreeningResults(results, wrap) {
  if (!results || !results.length) {
    wrap.innerHTML = "<p class='hint'>結果がありません。</p>"; return;
  }
  const keys    = Object.keys(results[0]);
  const tickCol = keys.find(k => k.toLowerCase().includes("ティッカー") || k.toLowerCase() === "ticker") || keys[0];
  const table   = buildTable(
    keys,
    results.map(row => keys.map(k => {
      const v = row[k];
      if (k === tickCol) return { __html: `<span class="ticker-link">${v ?? "-"}</span>` };
      if (typeof v === "number") return fmt(v, 2);
      return v;
    })),
    (row) => {
      const ticker = row[tickCol] || (typeof row[0] === "string" ? row[0] : null);
      if (ticker) gotoReport(String(ticker).replace(/<[^>]+>/g, "").trim());
    }
  );
  // Fix: actual ticker value from original results
  const tbody = table.querySelector("tbody");
  Array.from(tbody.rows).forEach((tr, i) => {
    tr.addEventListener("click", () => {
      const ticker = String(results[i][tickCol] || "").trim();
      if (ticker) gotoReport(ticker);
    });
    // Remove auto-click attached by buildTable (duplicate)
  }, true);

  wrap.innerHTML = "";
  wrap.appendChild(table);
}
