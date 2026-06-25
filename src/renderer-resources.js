// 上部バーのリソースモニター。設定の「表示」タブで ON のとき、
// CPU / RAM / GPU / VRAM の使用量を 1 秒ごとにバーで表示する。
// 値はバックエンド（chat_server, :8001）の /system/resources から取得。
const RESOURCE_API = "http://127.0.0.1:8001";
export const RESOURCE_MONITOR_KEY = "stock-review.resourceMonitor";

const monitor = document.getElementById("resource-monitor");
let pollTimer = null;
let installing = false;

function meterColor(percent) {
  if (percent < 50) return "#4a9eff";
  if (percent < 80) return "#e8814a";
  return "#e84a4a";
}

function meterHtml(label, percent, value) {
  const clamped = Math.min(100, Math.max(0, percent || 0));
  return `
    <div class="resource-meter" title="${label} ${value}">
      <span class="resource-meter-label">${label}</span>
      <div class="resource-meter-track">
        <div class="resource-meter-fill" style="width:${clamped}%;background:${meterColor(clamped)}"></div>
      </div>
      <span class="resource-meter-value">${value}</span>
    </div>`;
}

function gb(used, total) {
  return `${used.toFixed(1)}/${total.toFixed(1)}GB`;
}

async function poll() {
  if (!monitor) return;
  try {
    const res = await fetch(`${RESOURCE_API}/system/resources`);
    if (!res.ok) throw new Error();
    const r = await res.json();
    if (!r.available) {
      monitor.innerHTML = '<span class="resource-unavailable">psutil 未導入</span>';
      return;
    }
    let html = meterHtml("CPU", r.cpu_percent, `${Math.round(r.cpu_percent)}%`)
      + meterHtml("RAM", r.ram_percent, gb(r.ram_used_gb, r.ram_total_gb));
    const gpu = r.gpus && r.gpus[0];
    if (gpu) {
      html += meterHtml("GPU", gpu.gpu_percent, `${Math.round(gpu.gpu_percent)}%`)
        + meterHtml("VRAM", gpu.vram_percent, gb(gpu.vram_used_gb, gpu.vram_total_gb));
    }
    monitor.innerHTML = html;
  } catch {
    monitor.innerHTML = '<span class="resource-unavailable">取得不可</span>';
  }
}

function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = window.setInterval(poll, 1000);
}

// 依存（psutil 等）が未導入なら .venv へ自動インストールしてから表示を開始する。
async function ensureDepsAndStart() {
  let data;
  try {
    const res = await fetch(`${RESOURCE_API}/system/resources`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    monitor.innerHTML = '<span class="resource-unavailable">バックエンド接続不可</span>';
    return;
  }

  if (!data.available) {
    if (installing) return;
    installing = true;
    monitor.innerHTML = '<span class="resource-unavailable">準備中…（psutil を導入）</span>';
    try {
      const res = await fetch(`${RESOURCE_API}/system/install-deps`, { method: "POST" });
      if (!res.ok) throw new Error();
    } catch {
      monitor.innerHTML = '<span class="resource-unavailable">導入に失敗しました</span>';
      installing = false;
      return;
    }
    installing = false;
  }

  startPolling();
}

export function setResourceMonitorEnabled(enabled) {
  if (!monitor) return;
  monitor.classList.toggle("is-hidden", !enabled);
  if (enabled) {
    ensureDepsAndStart();
  } else {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    monitor.innerHTML = "";
  }
}

// 別モジュール（設定）からの切り替え通知を受ける。
window.addEventListener("stock-review:resource-monitor", e => {
  setResourceMonitorEnabled(Boolean(e.detail?.enabled));
});

// 起動時に保存済みの設定を反映。
setResourceMonitorEnabled(localStorage.getItem(RESOURCE_MONITOR_KEY) === "1");
