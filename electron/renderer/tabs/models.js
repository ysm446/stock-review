/* ── Models tab ────────────────────────────────────────────────── */
let _selectedModelPath = null;
let _pollTimer = null;

function init_models() {
  document.getElementById("m-load-btn").addEventListener("click", loadModel);
  document.getElementById("m-unload-btn").addEventListener("click", unloadModel);
  document.getElementById("m-refresh-btn").addEventListener("click", refreshModels);
  refreshModels();
}

async function refreshModels() {
  try {
    const data = await apiFetch("/api/models");
    renderModelList(data.models || {});
    updateStatus(data.status);
  } catch (e) {
    document.getElementById("m-status-box").textContent = "バックエンド未接続: " + e.message;
  }
}

function renderModelList(models) {
  const wrap = document.getElementById("m-model-list");
  wrap.innerHTML = "";
  const entries = Object.entries(models);
  if (!entries.length) {
    wrap.innerHTML = "<p class='hint'>models/ フォルダに .gguf ファイルが見つかりません。</p>"; return;
  }
  entries.forEach(([name, path]) => {
    const item = document.createElement("div");
    item.className = "model-item" + (_selectedModelPath === path ? " selected" : "");
    item.innerHTML = `<input type="radio" name="m-model" value="${path}" ${_selectedModelPath === path ? "checked" : ""}> ${name}`;
    item.addEventListener("click", () => {
      _selectedModelPath = path;
      document.querySelectorAll(".model-item").forEach(el => el.classList.toggle("selected", el === item));
      item.querySelector("input").checked = true;
    });
    wrap.appendChild(item);
  });
  // Auto-select first if nothing selected
  if (!_selectedModelPath && entries.length) {
    _selectedModelPath = entries[0][1];
    wrap.querySelector(".model-item").classList.add("selected");
  }
}

function updateStatus(status) {
  const box = document.getElementById("m-status-box");
  const vram = document.getElementById("m-vram-bar");
  if (!status) { box.textContent = "ステータス取得失敗"; return; }
  if (status.loading) {
    box.textContent = `読み込み中: ${status.current_model_id || "..."}`;
  } else if (status.available) {
    const vramLine = status.vram_total_gb > 0
      ? `\nVRAM: ${status.vram_allocated_gb.toFixed(1)} / ${status.vram_total_gb.toFixed(1)} GB`
      : "";
    box.textContent = `Loaded: ${status.current_model_id}${vramLine}`;
    vram.textContent = buildVramBar(status);
  } else if (status.load_error) {
    box.textContent = "エラー: " + status.load_error;
  } else {
    box.textContent = "モデル未読み込み。「Load」を押してください。";
  }
}

function buildVramBar(status) {
  if (!status.vram_total_gb) return "GPU: 未検出 (CPU モード)";
  const pct = Math.min(status.vram_allocated_gb / status.vram_total_gb, 1);
  const filled = Math.round(pct * 20);
  const bar = "#".repeat(filled) + "-".repeat(20 - filled);
  return `VRAM [${bar}] ${status.vram_allocated_gb.toFixed(1)} / ${status.vram_total_gb.toFixed(1)} GB (${Math.round(pct * 100)}%)`;
}

async function loadModel() {
  if (!_selectedModelPath) { alert("モデルを選択してください。"); return; }
  const logBox = document.getElementById("m-log");
  logBox.textContent = "読み込み開始: " + _selectedModelPath;
  try {
    const res = await apiFetch("/api/models/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_path: _selectedModelPath }),
    });
    if (res.error) { logBox.textContent = "エラー: " + res.error; return; }
    startPolling();
  } catch (e) {
    logBox.textContent = "エラー: " + e.message;
  }
}

async function unloadModel() {
  try {
    await apiFetch("/api/models/unload", { method: "POST" });
    stopPolling();
    await refreshModels();
    document.getElementById("m-log").textContent = "アンロードしました。";
  } catch (e) {
    document.getElementById("m-log").textContent = "エラー: " + e.message;
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(async () => {
    try {
      const status = await apiFetch("/api/models/status");
      updateStatus(status);
      document.getElementById("m-log").textContent = status.load_error
        ? "エラー: " + status.load_error
        : status.available ? "読み込み完了: " + status.current_model_id
        : status.loading ? "読み込み中..."
        : "";
      if (!status.loading) stopPolling();
    } catch { stopPolling(); }
  }, 1500);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
