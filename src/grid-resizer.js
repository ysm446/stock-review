// 2カラムグリッドの左右比をドラッグで調整する共通ヘルパー。
// grid のCSS変数（%）を書き換えて localStorage に保存し、ダブルクリックで初期値に戻す。
// 使用側のCSSは grid-template-columns にこの変数を組み込んでおくこと
// （例: minmax(0, calc(var(--market-split, 63%) - 7px)) minmax(0, 1fr)）。
// カラム幅変化に伴うチャート再描画は、各画面の ResizeObserver が追従する。

export function setupColumnResizer({ grid, handle, cssVar, storageKey, min = 30, max = 80 }) {
  if (!grid || !handle) return;

  const apply = (percent) => {
    const next = Math.min(max, Math.max(min, Number(percent)));
    if (!Number.isFinite(next)) return;
    grid.style.setProperty(cssVar, `${next}%`);
  };

  const saved = Number(localStorage.getItem(storageKey));
  if (Number.isFinite(saved) && saved > 0) apply(saved);

  let dragging = false;
  const move = (event) => {
    if (!dragging) return;
    const rect = grid.getBoundingClientRect();
    if (rect.width > 0) apply((event.clientX - rect.left) / rect.width * 100);
  };
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-active");
    const value = parseFloat(grid.style.getPropertyValue(cssVar));
    if (Number.isFinite(value)) localStorage.setItem(storageKey, String(Math.round(value * 10) / 10));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    handle.classList.add("is-active");
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
  handle.addEventListener("dblclick", () => {
    grid.style.removeProperty(cssVar);
    localStorage.removeItem(storageKey);
  });
}
