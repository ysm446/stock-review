const statusText = document.getElementById("app-status-text");
const statusItem = document.getElementById("app-status-message");
let resetTimer = null;

export function setAppStatus(message, tone = "neutral", timeout = null) {
  if (!statusText || !statusItem) return;
  if (resetTimer) {
    window.clearTimeout(resetTimer);
    resetTimer = null;
  }

  statusText.textContent = message || "準備完了";
  statusItem.classList.remove("is-active", "is-success", "is-error");
  if (["active", "success", "error"].includes(tone)) statusItem.classList.add(`is-${tone}`);

  const delay = timeout ?? (tone === "success" ? 4000 : tone === "error" ? 6000 : 0);
  if (delay > 0) {
    resetTimer = window.setTimeout(() => setAppStatus("準備完了"), delay);
  }
}

window.addEventListener("stock-review:status", (event) => {
  const detail = event.detail || {};
  setAppStatus(detail.message, detail.tone, detail.timeout);
});
