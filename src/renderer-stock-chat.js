import { apiFetch, createActivityRenderer } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { formatMaybeCurrency, formatMaybeMultiple, formatMaybePercent } from "./renderer-utils.js";

const panel = document.getElementById("stock-chat-panel");
const subtitle = document.getElementById("stock-chat-subtitle");
const newButton = document.getElementById("stock-chat-new");
const summarizeButton = document.getElementById("stock-chat-summarize");
const sessionList = document.getElementById("stock-chat-sessions");
const notePath = document.getElementById("stock-chat-note-path");
const suggestionsEl = document.getElementById("stock-chat-suggestions");
const messagesEl = document.getElementById("stock-chat-messages");
const inputEl = document.getElementById("stock-chat-input");
const sendButton = document.getElementById("stock-chat-send");

const tabMetricsBtn = document.getElementById("review-tab-metrics");
const tabNotesBtn = document.getElementById("review-tab-notes");
const notesDot = document.getElementById("review-notes-dot");
const notesStatus = document.getElementById("review-notes-status");
const notesRestoreBtn = document.getElementById("review-notes-restore");
const metricsPane = document.getElementById("review-metrics-pane");
const notesPane = document.getElementById("review-notes-pane");
const notesBody = document.getElementById("review-notes-body");

let activeTicker = "";
let activeSnapshot = null;
let sessions = [];
let activeSessionId = null;
let history = [];
let streaming = false;

// ノート（notes.md）の表示と「ノートに反映」ボタンからの更新
let notesContent = "";
let notesHasBackup = false;
let notesQueue = []; // 反映待ちのやり取り [{user, assistant, btn}]
let notesUpdating = false;

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
  // テンプレート質問は銘柄が表示されていれば常時表示（応答中は押せない）
  suggestionsEl?.classList.toggle("is-hidden", !activeTicker);
  suggestionsEl
    ?.querySelectorAll(".stock-chat-suggestion")
    .forEach((btn) => (btn.disabled = !enabled || streaming));
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

// 入力欄の上に常時表示するテンプレート質問
const TEMPLATE_QUESTIONS = [
  "最近のニュースを教えて",
  "直近の決算のポイントは？",
  "強みと競合優位性を整理して",
  "ここ数年の会社の経緯と変化を整理して",
];

function renderSuggestions() {
  if (!suggestionsEl) return;
  TEMPLATE_QUESTIONS.forEach((question) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stock-chat-suggestion";
    btn.textContent = question;
    btn.addEventListener("click", async () => {
      if (!activeTicker || streaming) return;
      // 会話がまだ無い銘柄では作成から送信まで一気に行う
      if (!activeSessionId) await createSession();
      inputEl.value = question;
      sendMessage();
    });
    suggestionsEl.appendChild(btn);
  });
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
  // 指標は画面表示と同じ整形済みの値で渡す（yfinance の ROE 等は小数（0.519 = 51.9%）
  // で返るため、生の値を渡すと LLM が「0.519%」のように単位を誤読する）
  return [
    "あなたは個別銘柄レビュー用の投資調査アシスタントです。",
    "事実、推測、意見を分け、断定しすぎず、必要なら追加確認事項を提示してください。",
    `対象銘柄: ${activeTicker}`,
    `銘柄名: ${snapshot.name || activeTicker}`,
    `セクター: ${overview.sector || "-"}`,
    `業種: ${overview.industry || "-"}`,
    `現在値: ${overview.currentPrice ?? "-"} ${snapshot.currency || ""}`,
    `時価総額: ${formatMaybeCurrency(overview.marketCap, snapshot.currency || "JPY", true)}`,
    `PER: ${formatMaybeMultiple(valuation.trailingPE)}（トレーリング）`,
    `PBR: ${formatMaybeMultiple(valuation.priceToBook)}`,
    `ROE: ${formatMaybePercent(profitability.returnOnEquity, 1)}`,
    `推奨: ${analyst.recommendationKey || "-"}`,
    "上記の指標は Yahoo Finance 由来の参考値で、日本株では更新が遅い・不正確なことがあります。重要な判断に関わる場合は一次情報（決算短信・会社IR）での確認を促してください。",
  ].join("\n");
}

function buildNotesSystemPrompt() {
  return [
    "あなたは、個別銘柄の会話を長期的に蓄積する投資レビューノートの編集者です。",
    "出力は更新後のMarkdownノート本文のみとし、前置き・説明・コードフェンスは書かないでください。",
    "事実、推測、意見を区別し、会話にない情報は推測で補わないでください。",
    "投資判断・企業分析に関係しない雑談やアプリ操作はノートに含めないでください。",
    "出典URLの羅列や「出典」セクションは作らず、重要な出典は本文中に1〜2件添える程度にしてください。",
    "基本構成は「# 銘柄コード 銘柄名」「## 投資仮説」「## ここ数年の経緯」「## 強み」「## リスク」「## 確認事項」「## メモ」とし、情報がない見出しは省略できます。",
    "「ここ数年の経緯」は、事業構成、業績、経営方針、重要イベントの変化を、年や時期がわかる範囲で時系列に整理してください。",
  ].join("\n");
}

function setNotesStatus(text, isError = false) {
  if (!notesStatus) return;
  notesStatus.textContent = text;
  notesStatus.classList.toggle("is-error", isError);
}

function updateNotesRestoreButton() {
  notesRestoreBtn?.classList.toggle("is-hidden", !notesHasBackup || !activeTicker);
}

// 保存/復元 API のレスポンスをノート表示へ反映する共通処理
function applyNotesResponse(saved) {
  notesContent = saved?.content || "";
  notesHasBackup = Boolean(saved?.has_backup);
  renderNotes();
  updateNotesRestoreButton();
}

// ISO 日時 → 「HH:MM 更新」（当日以外は日付付き）。不正値は空文字
function formatNotesUpdatedAt(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return `${time} 更新`;
  return `${date.toLocaleDateString("ja-JP")} ${time} 更新`;
}

function renderNotes() {
  if (!notesBody) return;
  if (!notesContent.trim()) {
    notesBody.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "chat-empty-hint";
    empty.textContent = activeTicker
      ? "まだノートがありません。チャットで会話すると自動で作成されます"
      : "銘柄を選択してください";
    notesBody.appendChild(empty);
    return;
  }
  notesBody.innerHTML = renderMarkdown(notesContent);
}

function switchReviewTab(tab) {
  const showNotes = tab === "notes";
  metricsPane?.classList.toggle("is-hidden", showNotes);
  notesPane?.classList.toggle("is-hidden", !showNotes);
  tabMetricsBtn?.classList.toggle("is-active", !showNotes);
  tabNotesBtn?.classList.toggle("is-active", showNotes);
  if (showNotes) notesDot?.classList.add("is-hidden");
}

// LLM がコードフェンスで包んで返した場合に中身だけ取り出す
function stripMarkdownFences(text) {
  const trimmed = (text || "").trim();
  const match = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return match ? match[1] : trimmed;
}

function buildNotesUpdatePrompt(exchanges) {
  const name = activeSnapshot?.name || activeTicker;
  return [
    `${activeTicker}（${name}）の投資レビューノート（Markdown）を、新しい会話のやり取りを踏まえて更新してください。`,
    "",
    "ルール:",
    "- 既存の内容は保持し、新しい情報の追記や古い記述の修正だけを行う。",
    "- 会話に出ていない情報を推測で補わない。",
    "- この銘柄の投資判断・企業分析に関係しない話題（雑談、アプリの操作の話、別銘柄だけの話など）はノートに書かない。反映すべき内容が無ければ既存のノートをそのまま出力する。",
    "- 出典URLの羅列（リンク集・「出典」セクション）はノートに書かない。特に重要な出典を本文中に1〜2件添える程度にとどめ、既存ノートに出典リストが残っていれば削除する。",
    `- ノートが空のときは「# ${activeTicker} ${name}」を先頭にし、システムプロンプトの基本構成で新規作成する。`,
    "- ここ数年の経緯に追加できる事業・業績・経営方針・重要イベントの変化があれば、時系列に反映する。",
    "",
    "【現在のノート】",
    notesContent.trim() || "(空)",
    "",
    "【新しい会話】",
    exchanges
      .map((ex) => `User:\n${ex.user}\n\nAssistant:\n${ex.assistant}`)
      .join("\n\n"),
  ].join("\n");
}

function queueNotesUpdate(userText, assistantText, btn = null) {
  if (!activeTicker || !activeSessionId) return;
  notesQueue.push({ user: userText, assistant: assistantText, btn });
  processNotesQueue();
}

// アシスタント回答の下に「ノートに反映」ボタンを付ける
function addReflectButton(wrap, getExchange) {
  const actions = document.createElement("div");
  actions.className = "chat-message-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-reflect-btn";
  btn.textContent = "ノートに反映";
  btn.title = "このやり取りの内容をノートに反映します";
  btn.addEventListener("click", () => {
    const ex = getExchange();
    if (!ex || !activeSessionId) return;
    btn.disabled = true;
    btn.textContent = "反映中...";
    queueNotesUpdate(ex.user, ex.assistant, btn);
  });
  actions.appendChild(btn);
  wrap.appendChild(actions);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return btn;
}

function markReflectResult(exchanges, succeeded) {
  exchanges.forEach(({ btn }) => {
    if (!btn) return;
    if (succeeded) {
      btn.textContent = "反映済み";
      btn.disabled = true;
      btn.classList.add("is-done");
    } else {
      btn.textContent = "ノートに反映";
      btn.disabled = false;
    }
  });
}

async function processNotesQueue() {
  if (notesUpdating || !notesQueue.length) return;
  notesUpdating = true;
  const ticker = activeTicker;
  const sessionId = activeSessionId;

  while (notesQueue.length && activeTicker === ticker) {
    const exchanges = notesQueue.splice(0, notesQueue.length);
    setNotesStatus("ノートを更新中...");
    let markdown = "";
    let failed = null;
    await streamChat(
      sessionId,
      [{ role: "user", content: buildNotesUpdatePrompt(exchanges) }],
      { persistUser: false, persistAssistant: false, systemPrompt: buildNotesSystemPrompt() },
      (chunk) => {
        markdown += chunk;
      },
      () => {},
      (error) => {
        failed = error;
      }
    );

    // 更新中に銘柄が切り替わったら結果を破棄する
    if (activeTicker !== ticker) break;

    if (failed !== null || !stripMarkdownFences(markdown)) {
      setNotesStatus("ノートへの反映に失敗しました", true);
      markReflectResult(exchanges, false);
      continue;
    }

    try {
      const saved = await api("PATCH", `/stocks/${encodeURIComponent(ticker)}/notes`, {
        content: stripMarkdownFences(markdown),
      });
      if (activeTicker !== ticker) break;
      applyNotesResponse(saved);
      setNotesStatus(formatNotesUpdatedAt(saved.updated_at) || "更新しました");
      markReflectResult(exchanges, true);
      if (notesPane?.classList.contains("is-hidden")) notesDot?.classList.remove("is-hidden");
    } catch (error) {
      setNotesStatus("ノートの保存に失敗しました", true);
      markReflectResult(exchanges, false);
    }
  }

  notesUpdating = false;
  // 銘柄切替などで break した間に積まれた分を処理し直す
  if (notesQueue.length) processNotesQueue();
}

async function loadTicker(ticker, snapshot) {
  activeTicker = String(ticker || "").trim().toUpperCase();
  activeSnapshot = snapshot || null;
  activeSessionId = null;
  history = [];
  notesContent = "";
  notesHasBackup = false;
  notesQueue = [];
  setNotesStatus("");
  notesDot?.classList.add("is-hidden");
  renderNotes();
  updateNotesRestoreButton();

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
    applyNotesResponse(data.notes);
    setNotesStatus(formatNotesUpdatedAt(data.notes?.updated_at));
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
  let prevUserContent = null;
  messages.forEach((message) => {
    history.push({ id: message.id, role: message.role, content: message.content });
    const rendered = appendMessage(message.role, message.content, message.created_at);
    // 過去のやり取りもノートに反映できるようにする
    if (message.role === "assistant" && prevUserContent !== null) {
      const user = prevUserContent;
      addReflectButton(rendered.wrap, () => ({ user, assistant: message.content }));
    }
    prevUserContent = message.role === "user" ? message.content : null;
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
      addReflectButton(assistant.wrap, () => ({ user: text, assistant: accumulated }));
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
    "システムプロンプトの基本構成に従い、会話全体からノート全文を作り直してください。",
    "ここ数年の経緯に該当する内容は、時系列に整理してください。",
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
      systemPrompt: [buildStockSystemPrompt(), buildNotesSystemPrompt()].join("\n\n"),
    },
    (chunk) => {
      assistant.wrap.classList.remove("loading");
      markdown += chunk;
      assistant.body.innerHTML = renderMarkdown(markdown);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    async () => {
      const saved = await api("PATCH", `/stocks/${encodeURIComponent(activeTicker)}/notes`, {
        content: stripMarkdownFences(markdown),
      });
      applyNotesResponse(saved);
      setNotesStatus(formatNotesUpdatedAt(saved.updated_at) || "更新しました");
      if (notesPane?.classList.contains("is-hidden")) notesDot?.classList.remove("is-hidden");
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

tabMetricsBtn?.addEventListener("click", () => switchReviewTab("metrics"));
tabNotesBtn?.addEventListener("click", () => switchReviewTab("notes"));
notesRestoreBtn?.addEventListener("click", async () => {
  if (!activeTicker) return;
  const ticker = activeTicker;
  try {
    const saved = await api("POST", `/stocks/${encodeURIComponent(ticker)}/notes/restore`);
    if (activeTicker !== ticker) return;
    applyNotesResponse(saved);
    setNotesStatus("前のノートに戻しました");
    switchReviewTab("notes");
  } catch (error) {
    setNotesStatus(`戻せませんでした: ${error.message}`, true);
  }
});
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

renderNotes();
renderSuggestions();

export function setStockReviewContext(ticker, snapshot) {
  if (!panel) return;
  loadTicker(ticker, snapshot);
}
