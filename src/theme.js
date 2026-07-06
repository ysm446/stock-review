// テーマ（配色）の早期適用。
// CSP が script-src 'self' のためインライン script は使えない。
// <head> でスタイルシートより前に非モジュールで読み込み、
// body 描画前に data-theme を確定させてちらつき（FOUC）を防ぐ。
(function () {
  "use strict";

  var KEY = "stock-review.theme";

  // 利用可能なテーマ。styles.css の :root[data-theme="..."] と対応。
  // ラベルはデザインテンプレートの表示名。今後ここに追加するだけで増やせる。
  var THEMES = [
    { value: "dark", label: "ダーク" },
    { value: "navy", label: "ネイビー" }
  ];
  var DEFAULT = "dark";

  function isValid(value) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].value === value) return true;
    }
    return false;
  }

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function apply(value) {
    var theme = isValid(value) ? value : DEFAULT;
    document.documentElement.setAttribute("data-theme", theme);
    return theme;
  }

  // 起動時: 保存済みテーマを即適用。
  var current = apply(stored());

  // 設定画面などから使う API。
  window.StockReviewTheme = {
    KEY: KEY,
    THEMES: THEMES,
    DEFAULT: DEFAULT,
    get: function () {
      return document.documentElement.getAttribute("data-theme") || DEFAULT;
    },
    set: function (value) {
      var theme = apply(value);
      try {
        localStorage.setItem(KEY, theme);
      } catch (e) {
        /* localStorage 不可でも見た目は反映する */
      }
      window.dispatchEvent(
        new CustomEvent("stock-review:theme", { detail: { theme: theme } })
      );
      return theme;
    }
  };

  // 参照だけしておく（未使用変数回避）。
  void current;
})();
