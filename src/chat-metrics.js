function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function appendGenerationMetrics(container, metrics) {
  if (!container || !metrics) return null;
  const tokens = finiteNumber(metrics.completion_tokens);
  const speed = finiteNumber(metrics.tokens_per_second);
  const seconds = finiteNumber(metrics.duration_seconds);
  const finishReason = String(metrics.finish_reason || "").trim();
  if (tokens === null && speed === null && seconds === null && !finishReason) return null;

  container.querySelector(".chat-generation-metrics")?.remove();
  const row = document.createElement("div");
  row.className = "chat-generation-metrics";

  const items = [];
  if (speed !== null) items.push(["⚡", `${speed.toFixed(1)} tok/秒`, "生成速度"]);
  if (tokens !== null) items.push(["▱", `${Math.round(tokens).toLocaleString()} tokens`, "生成トークン数"]);
  if (seconds !== null) items.push(["◷", `${seconds.toFixed(2)}秒`, "生成時間"]);
  if (finishReason) items.push(["■", `終了理由: ${finishReason}`, "終了理由"]);

  items.forEach(([icon, text, title], index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "chat-generation-metrics-separator";
      separator.textContent = "·";
      row.appendChild(separator);
    }
    const item = document.createElement("span");
    item.className = "chat-generation-metrics-item";
    item.title = title;
    const iconEl = document.createElement("span");
    iconEl.className = "chat-generation-metrics-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.textContent = icon;
    item.append(iconEl, document.createTextNode(` ${text}`));
    row.appendChild(item);
  });

  container.appendChild(row);
  return row;
}
