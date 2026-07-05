import { apiFetch, createActivityRenderer } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";

const panel = document.getElementById("stock-chat-panel");
const subtitle = document.getElementById("stock-chat-subtitle");
const newButton = document.getElementById("stock-chat-new");
const summarizeButton = document.getElementById("stock-chat-summarize");
const sessionList = document.getElementById("stock-chat-sessions");
const notePath = document.getElementById("stock-chat-note-path");
const messagesEl = document.getElementById("stock-chat-messages");
const inputEl = document.getElementById("stock-chat-input");
const sendButton = document.getElementById("stock-chat-send");

let activeTicker = "";
let activeSnapshot = null;
let sessions = [];
let activeSessionId = null;
let history = [];
let streaming = false;

async function api(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

async function streamChat(sessionId, messages, options, onToken, onDone, onError) {
  const dispatch = (payload) => {
    if (payload.type === "token") onToken(payload.content);
    else if (payload.type === "done") onDone(payload);
    else if (payload.type === "error") onError(payload.message);
    else if (options.onActivity) options.onActivity(payload);
  };

  let res;
  try {
    res = await apiFetch(options.endpoint || "/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        persist_user: options.persistUser !== false,
        persist_assistant: options.persistAssistant !== false,
        system_prompt: options.systemPrompt || "",
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          dispatch(JSON.parse(line.slice(6)));
        } catch (_) {}
      }
    }
  }
  // 最終イベントの後ろに空行が無いままストリームが終わるケースを取りこぼさない
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        dispatch(JSON.parse(line.slice(6)));
      } catch (_) {}
    }
  }
}

function setEnabled(enabled) {
  const canChat = enabled && activeSessionId !== null && !streaming;
  inputEl.disabled = !canChat;
  sendButton.disabled = !canChat;
  newButton.disabled = !enabled || streaming;
  summarizeButton.disabled = !canChat || history.length === 0;
}

function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit" });
}

function clearMessages(text = "新しい会話を作成してください") {
  messagesEl.innerHTML = "";
  const empty = document.createElement("p");
  empty.className = "chat-empty-hint";
  empty.textContent = text;
  messagesEl.appendChild(empty);
}

function appendMessage(role, content, createdAt = Date.now()) {
  messagesEl.querySelectorAll(".chat-empty-hint").forEach((el) => el.remove());
  const wrap = document.createElement("div");
  wrap.className = `chat-message ${role}`;

  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = role === "user" ? "あなた" : "ローカルLLM";

  const body = document.createElement("div");
  body.className = role === "user" ? "chat-message-bubble" : "chat-message-text";
  if (role === "assistant") {
    body.innerHTML = renderMarkdown(content);
  } else {
    body.textContent = content;
    body.style.whiteSpace = "pre-wrap";
  }

  wrap.append(meta, body);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, body, meta };
}

function renderSessions() {
  sessionList.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "chat-tree-empty";
    empty.textContent = "過去の会話はありません";
    sessionList.appendChild(empty);
    return;
  }

  sessions.forEach((session) => {
    const item = document.createElement("div");
    item.className = `stock-chat-session${session.id === activeSessionId ? " is-active" : ""}`;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    const title = document.createElement("span");
    title.className = "stock-chat-session-title";
    title.textContent = session.title || "新しい会話";
    const date = document.createElement("span");
    date.className = "stock-chat-session-date";
    date.textContent = formatDate(session.updated_at || session.created_at);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "stock-chat-session-delete";
    del.textContent = "×";
    del.title = "会話を削除";
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSession(session);
    });
    item.append(title, date, del);
    item.addEventListener("click", () => selectSession(session.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectSession(session.id);
    });
    sessionList.appendChild(item);
  });
}

function buildStockSystemPrompt() {
  const snapshot = activeSnapshot || {};
  const overview = snapshot.overview || {};
  const valuation = snapshot.valuation || {};
  const profitability = snapshot.profitability || {};
  const analyst = snapshot.analyst || {};
  return [
    "あなたは個別銘柄レビュー用の投資調査アシスタントです。",
    "事実、推測、意見を分け、断定しすぎず、必要なら追加確認事項を提示してください。",
    `対象銘柄: ${activeTicker}`,
    `銘柄名: ${snapshot.name || activeTicker}`,
    `セクター: ${overview.sector || "-"}`,
    `業種: ${overview.industry || "-"}`,
    `現在値: ${overview.currentPrice ?? "-"} ${snapshot.currency || ""}`,
    `時価総額: ${overview.marketCap ?? "-"}`,
    `PER: ${valuation.trailingPE ?? "-"}`,
    `PBR: ${valuation.priceToBook ?? "-"}`,
    `ROE: ${profitability.returnOnEquity ?? "-"}`,
    `推奨: ${analyst.recommendationKey || "-"}`,
    "Markdown保存が必要なときは、会話内で要約案を作ってください。保存自体は画面のボタンで実行されます。",
  ].join("\n");
}

async function loadTicker(ticker, snapshot) {
  activeTicker = String(ticker || "").trim().toUpperCase();
  activeSnapshot = snapshot || null;
  activeSessionId = null;
  history = [];

  if (!activeTicker) {
    subtitle.textContent = "銘柄を表示すると会話できます";
    notePath.textContent = "";
    sessions = [];
    renderSessions();
    clearMessages("銘柄を選択してください");
    setEnabled(false);
    return;
  }

  subtitle.textContent = `${snapshot?.name || activeTicker} (${activeTicker})`;
  clearMessages("会話を選択するか、新しい会話を作成してください");
  setEnabled(false);

  try {
    const data = await api("GET", `/stocks/${encodeURIComponent(activeTicker)}/workspace`);
    sessions = data.sessions || [];
    notePath.textContent = data.notes?.relative_path ? `保存先: ${data.notes.relative_path}` : "";
    renderSessions();
    if (sessions.length) {
      await selectSession(sessions[0].id);
    } else {
      setEnabled(true);
    }
  } catch (error) {
    clearMessages(`銘柄チャットの初期化に失敗しました: ${error.message}`);
    setEnabled(false);
  }
}

async function createSession() {
  if (!activeTicker || streaming) return;
  const session = await api("POST", `/stocks/${encodeURIComponent(activeTicker)}/sessions`, {
    title: "新しい会話",
  });
  sessions.unshift(session);
  renderSessions();
  await selectSession(session.id);
}

async function selectSession(sessionId) {
  if (streaming) return;
  activeSessionId = sessionId;
  history = [];
  clearMessages();
  renderSessions();
  const messages = await api("GET", `/sessions/${sessionId}/messages`);
  messages.forEach((message) => {
    history.push({ id: message.id, role: message.role, content: message.content });
    appendMessage(message.role, message.content, message.created_at);
  });
  if (!messages.length) clearMessages("この銘柄について質問できます");
  setEnabled(true);
}

async function refreshSessions() {
  if (!activeTicker) return;
  sessions = await api("GET", `/stocks/${encodeURIComponent(activeTicker)}/sessions`);
  renderSessions();
}

async function deleteSession(session) {
  if (streaming) return;
  const label = session.title || "新しい会話";
  if (!window.confirm(`会話「${label}」を削除しますか？`)) return;
  try {
    await api("DELETE", `/sessions/${session.id}`);
  } catch (error) {
    window.alert(`削除に失敗しました: ${error.message}`);
    return;
  }
  if (activeSessionId === session.id) {
    activeSessionId = null;
    history = [];
    clearMessages("会話を選択するか、新しい会話を作成してください");
  }
  await refreshSessions();
  setEnabled(true);
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !activeSessionId || streaming) return;

  inputEl.value = "";
  inputEl.style.height = "auto";
  streaming = true;
  setEnabled(true);

  history.push({ role: "user", content: text });
  appendMessage("user", text);
  const assistant = appendMessage("assistant", "");
  assistant.wrap.classList.add("loading");
  const activity = document.createElement("div");
  activity.className = "chat-activity";
  assistant.wrap.insertBefore(activity, assistant.body);

  let accumulated = "";
  await streamChat(
    activeSessionId,
    history,
    {
      systemPrompt: buildStockSystemPrompt(),
      endpoint: "/chat/agent-stream",
      onActivity: createActivityRenderer(activity, {
        onModel: evt => {
          if (evt.name) assistant.meta.textContent = evt.name;
        },
        onTextReset: () => {
          accumulated = "";
          assistant.body.innerHTML = "";
        },
        onUpdate: () => {
          assistant.wrap.classList.remove("loading");
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      })
    },
    (chunk) => {
      assistant.wrap.classList.remove("loading");
      accumulated += chunk;
      assistant.body.innerHTML = renderMarkdown(accumulated);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    async (event) => {
      assistant.wrap.classList.remove("loading");
      const userId = event?.user_message?.id || null;
      const assistantId = event?.message?.id || null;
      history[history.length - 1].id = userId;
      history.push({ id: assistantId, role: "assistant", content: accumulated });
      streaming = false;
      await refreshSessions();
      setEnabled(true);
      inputEl.focus();
    },
    (error) => {
      history.pop();
      assistant.wrap.classList.remove("loading");
      assistant.wrap.classList.add("error");
      assistant.body.textContent = `エラー: ${error}`;
      streaming = false;
      setEnabled(true);
    }
  );
}

async function summarizeToMarkdown() {
  if (!activeTicker || !activeSessionId || !history.length || streaming) return;

  streaming = true;
  setEnabled(true);
  const assistant = appendMessage("assistant", "Markdownを作成しています...");
  assistant.wrap.classList.add("loading");

  const prompt = [
    `${activeTicker} の会話内容を、投資レビュー用のMarkdownノートに整理してください。`,
    "見出しは # 銘柄コード 銘柄名, ## 投資仮説, ## 強み, ## リスク, ## 確認事項, ## 会話メモ を基本にしてください。",
    "会話にない情報は推測で補わず、不明と書いてください。",
    "",
    history.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`).join("\n\n"),
  ].join("\n");

  let markdown = "";
  await streamChat(
    activeSessionId,
    [{ role: "user", content: prompt }],
    {
      persistUser: false,
      persistAssistant: false,
      systemPrompt: buildStockSystemPrompt(),
    },
    (chunk) => {
      assistant.wrap.classList.remove("loading");
      markdown += chunk;
      assistant.body.innerHTML = renderMarkdown(markdown);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    async () => {
      await api("PATCH", `/stocks/${encodeURIComponent(activeTicker)}/notes`, { content: markdown });
      assistant.wrap.classList.remove("loading");
      streaming = false;
      setEnabled(true);
    },
    (error) => {
      assistant.wrap.classList.remove("loading");
      assistant.wrap.classList.add("error");
      assistant.body.textContent = `保存に失敗しました: ${error}`;
      streaming = false;
      setEnabled(true);
    }
  );
}

newButton?.addEventListener("click", createSession);
sendButton?.addEventListener("click", sendMessage);
summarizeButton?.addEventListener("click", summarizeToMarkdown);
inputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
inputEl?.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

export function setStockReviewContext(ticker, snapshot) {
  if (!panel) return;
  loadTicker(ticker, snapshot);
}
