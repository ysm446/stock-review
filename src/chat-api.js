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

// JSONリクエストの共通ヘルパー。失敗時は "METHOD path → status: 本文" 形式のErrorを投げる。
export async function api(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

// SSEチャットストリームの共通処理。renderer-chat / renderer-stock-chat 共用。
// コールバックもオプションも1つのオブジェクトで受ける（呼び出し側での引数順の食い違いを防ぐ）。
export async function streamChat(sessionId, messages, {
  onToken = () => {},
  onDone = () => {},
  onError = () => {},
  onActivity = null,
  endpoint = "/chat/stream",
  persistUser = true,
  persistAssistant = true,
  systemPrompt = "",
} = {}) {
  const dispatch = (evt) => {
    if (evt.type === "token") onToken(evt.content);
    else if (evt.type === "done") onDone(evt);
    else if (evt.type === "error") onError(evt.message);
    else if (onActivity) onActivity(evt);
  };

  let res;
  try {
    res = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        persist_user: persistUser,
        persist_assistant: persistAssistant,
        system_prompt: systemPrompt || "",
      }),
    });
  } catch (error) {
    onError(error.message);
    return;
  }
  if (!res.ok) {
    onError(`HTTP ${res.status}`);
    return;
  }

  const dispatchLines = (chunk) => {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (!payload) continue;
      try {
        dispatch(JSON.parse(payload));
      } catch (_) {}
    }
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    events.forEach(dispatchLines);
  }
  // 最終イベントの後ろに空行が無いままストリームが終わるケースを取りこぼさない
  if (buffer.trim()) dispatchLines(buffer);
}

const TOOL_LABELS = {
  web_search: "Web検索",
  news_search: "ニュース検索",
  stock_snapshot: "銘柄指標"
};

// エージェントの活動イベント（tool_call / tool_result / thinking / turn_reset）を
// メッセージ内の活動領域に描画するハンドラーを作る。renderer-chat / renderer-stock-chat 共用。
export function createActivityRenderer(activityEl, { onTextReset, onUpdate, onModel } = {}) {
  let lastToolLine = null;
  return (evt) => {
    if (!evt || !activityEl) return;
    if (evt.type === "model") {
      if (onModel) onModel(evt);
    } else if (evt.type === "tool_call") {
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
