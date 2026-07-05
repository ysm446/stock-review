// チャットサーバー (127.0.0.1:8001) への共通アクセス。
// トークンは Electron main プロセスが起動時に生成し、サーバー側でヘッダー検証される。
// ブラウザ等の外部オリジンからの操作を防ぐ（CORS だけでは書き込み系リクエストを止められないため）。
export const CHAT_API_BASE = "http://127.0.0.1:8001";

let tokenPromise = null;

export function getApiToken() {
  if (!tokenPromise) {
    tokenPromise = Promise.resolve(
      window.stockReviewApi?.getChatApiToken?.() ?? ""
    ).catch(() => "");
  }
  return tokenPromise;
}

export async function apiFetch(path, options = {}) {
  const token = await getApiToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["X-Api-Token"] = token;
  }
  return fetch(`${CHAT_API_BASE}${path}`, { ...options, headers });
}

const TOOL_LABELS = {
  web_search: "Web検索",
  news_search: "ニュース検索",
  stock_snapshot: "銘柄指標"
};

// エージェントの活動イベント（tool_call / tool_result / thinking / turn_reset）を
// メッセージ内の活動領域に描画するハンドラーを作る。renderer-chat / renderer-stock-chat 共用。
export function createActivityRenderer(activityEl, { onTextReset, onUpdate } = {}) {
  let lastToolLine = null;
  return (evt) => {
    if (!evt || !activityEl) return;
    if (evt.type === "tool_call") {
      const line = document.createElement("div");
      line.className = "chat-activity-line";
      const label = TOOL_LABELS[evt.name] || evt.name;
      const arg = evt.args?.query || evt.args?.ticker || "";
      line.textContent = `🔍 ${label}${arg ? `: ${arg}` : ""}`;
      activityEl.appendChild(line);
      lastToolLine = line;
    } else if (evt.type === "tool_result") {
      if (lastToolLine) {
        lastToolLine.textContent += evt.count != null ? ` → ${evt.count}件` : " → 取得";
        lastToolLine = null;
      }
    } else if (evt.type === "thinking") {
      const details = document.createElement("details");
      details.className = "chat-thinking";
      const summary = document.createElement("summary");
      summary.textContent = "思考";
      const body = document.createElement("div");
      body.className = "chat-thinking-body";
      body.textContent = evt.content || "";
      details.append(summary, body);
      activityEl.appendChild(details);
    } else if (evt.type === "turn_reset") {
      if (onTextReset) onTextReset();
    }
    if (onUpdate) onUpdate();
  };
}
