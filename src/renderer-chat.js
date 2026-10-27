import { api, apiFetch, streamChat, createActivityRenderer } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { appendGenerationMetrics } from "./chat-metrics.js";
import { setAppStatus } from "./renderer-status.js";

// 右サイドバーに常設するチャット。会話は全般ワークスペースの会話をまとめて扱い、
// ヘッダーの一覧アイコンから切り替える。新しい会話は最初の送信時に保存する。

// ── DOM refs ─────────────────────────────────────────────
const chatModelBar        = document.getElementById("chat-model-bar");
const chatModelIndicator  = document.getElementById("chat-model-indicator");
const chatModelNameEl     = document.getElementById("chat-model-name");
const chatDock            = document.getElementById("chat-dock");
const chatDockToggle      = document.getElementById("chat-dock-toggle");
const chatDockResizer     = document.getElementById("chat-dock-resizer");
const chatDockHead        = document.getElementById("chat-dock-head");
const chatDockTitle       = document.getElementById("chat-dock-title");
const chatHistoryButton   = document.getElementById("chat-history-button");
const chatNewButton       = document.getElementById("chat-new-button");
const chatDeleteButton    = document.getElementById("chat-delete-button");
const chatHistoryPopover  = document.getElementById("chat-history-popover");
const chatHistoryList     = document.getElementById("chat-history-list");
const chatMessages        = document.getElementById("chat-messages");
const chatInput           = document.getElementById("chat-input");
const chatSendButton      = document.getElementById("chat-send");
const chatModelModalBackdrop = document.getElementById("chat-model-modal-backdrop");
const chatModelList          = document.getElementById("chat-model-list");
const closeChatModelModal    = document.getElementById("close-chat-model-modal");

// ── State ────────────────────────────────────────────────
let sessions         = [];   // 全般ワークスペースの会話（新しい順）
let activeSessionId  = null; // null = まだ保存していない新しい会話
let chatHistory      = [];
let serverLoaded     = false;
let loadingModel     = false;
let streaming        = false;
let currentModelName = "";
let renamingSessionId = null;

const CHAT_DOCK_OPEN_KEY = "stock-review.chatDockOpen";
const CHAT_DOCK_WIDTH_KEY = "stock-review.chatDockWidth";
const CHAT_ACTIVE_SESSION_KEY = "stock-review.chatActiveSession";
const CHAT_DOCK_DEFAULT_WIDTH = 420;
const CHAT_DOCK_MIN_WIDTH = 320;
const CHAT_DOCK_MAX_WIDTH = 900;
const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536];

// ── Helpers ──────────────────────────────────────────────
function setModelStatus(state, label) {
  chatModelIndicator.setAttribute("class", "chat-model-indicator" + (state ? " " + state : ""));
  chatModelNameEl.textContent = label;
  const isLoading = state === "is-loading";
  chatModelBar.classList.toggle("is-loading", isLoading);
  chatModelBar.setAttribute("aria-busy", isLoading ? "true" : "false");
}

function ctxLabel(size) {
  return `${Math.round(size / 1024)}K`;
}

// 入力欄は常に書けるようにし、送信だけをモデルの状態で止める
function updateComposerState() {
  chatInput.disabled = streaming;
  chatSendButton.disabled = streaming || !serverLoaded || !chatInput.value.trim();
  chatSendButton.title = serverLoaded ? "" : "モデルが読み込まれていません";
  chatNewButton.disabled = streaming;
  chatDeleteButton.disabled = streaming || activeSessionId === null;
  chatHistoryButton.disabled = streaming;
}

async function refreshModelStatus() {
  const status = await api("GET", "/llama/status");
  serverLoaded = Boolean(status.ready);
  currentModelName = status.model_name || "";

  if (serverLoaded) {
    setModelStatus("is-loaded", currentModelName || "読み込み済み");
  } else {
    setModelStatus("", "モデルを設定");
  }
  updateComposerState();
  return status;
}

function clearMessages(hint = "") {
  chatMessages.innerHTML = "";
  if (hint) {
    const p = document.createElement("p");
    p.className = "chat-empty-hint";
    p.textContent = hint;
    chatMessages.appendChild(p);
  }
}

function formatChatDate(value) {
  if (!value) return "";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

// 最後に更新してからの経過（「3日前」など）。30日を過ぎたら日付にする
function formatUpdatedAgo(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}日前`;
  return new Date(time).toLocaleDateString("ja-JP");
}

function formatMessageMeta(role, createdAt = Date.now()) {
  const date = formatChatDate(createdAt);
  if (role === "assistant") {
    return `アシスタント${currentModelName ? `（${currentModelName}）` : ""}${date ? ` ${date}` : ""}`;
  }
  return date;
}

function setMessageBodyContent(body, role, content) {
  if (role === "assistant") {
    body.innerHTML = renderMarkdown(content);
  } else {
    body.textContent = content;
  }
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Server readiness ──────────────────────────────────────
async function waitForServer(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await apiFetch("/health");
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ── Dock（開閉・幅） ────────────────────────────────────────
function setDockOpen(open, persist = true) {
  chatDock.classList.toggle("is-hidden", !open);
  chatDockToggle.classList.toggle("is-active", open);
  chatDockToggle.setAttribute("aria-expanded", open ? "true" : "false");
  chatDockToggle.title = open ? "チャットを閉じる" : "チャットを開く";
  if (!open) closeHistory();
  if (!persist) return;
  localStorage.setItem(CHAT_DOCK_OPEN_KEY, open ? "1" : "0");
  if (open) chatInput.focus();
}

function clampDockWidth(width) {
  const maxWidth = Math.max(CHAT_DOCK_MIN_WIDTH, Math.min(CHAT_DOCK_MAX_WIDTH, window.innerWidth * 0.6));
  return Math.min(Math.max(width, CHAT_DOCK_MIN_WIDTH), maxWidth);
}

function setDockWidth(width) {
  chatDock.style.width = `${Math.round(clampDockWidth(Number(width) || CHAT_DOCK_DEFAULT_WIDTH))}px`;
}

function initDock() {
  setDockOpen(localStorage.getItem(CHAT_DOCK_OPEN_KEY) !== "0", false);
  setDockWidth(Number(localStorage.getItem(CHAT_DOCK_WIDTH_KEY)) || CHAT_DOCK_DEFAULT_WIDTH);

  let resizing = false;
  const move = event => {
    if (!resizing) return;
    setDockWidth(chatDock.getBoundingClientRect().right - event.clientX);
  };
  const finish = () => {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove("is-resizing-chat-dock");
    chatDockResizer.classList.remove("is-active");
    localStorage.setItem(CHAT_DOCK_WIDTH_KEY, String(Math.round(chatDock.getBoundingClientRect().width)));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };
  chatDockResizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    resizing = true;
    document.body.classList.add("is-resizing-chat-dock");
    chatDockResizer.classList.add("is-active");
    chatDockResizer.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
  chatDockResizer.addEventListener("dblclick", () => {
    localStorage.removeItem(CHAT_DOCK_WIDTH_KEY);
    setDockWidth(CHAT_DOCK_DEFAULT_WIDTH);
  });
  window.addEventListener("resize", () => {
    setDockWidth(Number(localStorage.getItem(CHAT_DOCK_WIDTH_KEY)) || CHAT_DOCK_DEFAULT_WIDTH);
  });
}

// ── Sessions ──────────────────────────────────────────────
function activeSession() {
  return sessions.find(s => s.id === activeSessionId) || null;
}

function renderDockTitle() {
  const label = activeSession()?.title || (activeSessionId === null ? "新しい会話" : "会話を読み込み中…");
  chatDockTitle.textContent = label;
  chatDockTitle.title = label;
}

async function loadSessions() {
  sessions = await api("GET", "/chat/sessions");
  renderDockTitle();
  if (!chatHistoryPopover.classList.contains("is-hidden")) renderHistory();
}

function rememberActiveSession() {
  if (activeSessionId === null) localStorage.removeItem(CHAT_ACTIVE_SESSION_KEY);
  else localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, String(activeSessionId));
}

function startNewChat({ focus = true } = {}) {
  if (streaming) return;
  activeSessionId = null;
  chatHistory = [];
  rememberActiveSession();
  clearMessages("メッセージを入力して会話を始めます");
  renderDockTitle();
  updateComposerState();
  if (focus) chatInput.focus();
}

async function selectSession(id) {
  if (streaming) return;
  activeSessionId = id;
  rememberActiveSession();
  renderDockTitle();
  updateComposerState();
  await reloadActiveSessionMessages();
}

async function reloadActiveSessionMessages() {
  if (activeSessionId === null) return;
  const sid = activeSessionId;
  const msgs = await api("GET", `/sessions/${sid}/messages`);
  if (sid !== activeSessionId) return; // 読み込み中に別の会話へ切り替えた
  chatHistory = [];
  clearMessages();
  for (const m of msgs) {
    chatHistory.push({ id: m.id, role: m.role, content: m.content });
    appendBubble(m.role, m.content, m.created_at, m.id);
  }
  if (!msgs.length) clearMessages("メッセージを入力して会話を始めます");
  scrollToBottom();
}

async function renameSession(id, title) {
  await api("PATCH", `/sessions/${id}`, { title });
  await loadSessions();
}

async function deleteSession(id) {
  if (streaming) return;
  const session = sessions.find(s => s.id === id);
  if (!window.confirm(`「${session?.title || "この会話"}」を削除しますか？（元に戻せません）`)) return;
  try {
    await api("DELETE", `/sessions/${id}`);
  } catch (err) {
    setAppStatus(`会話の削除に失敗しました: ${err.message}`, "error");
    return;
  }
  if (activeSessionId === id) startNewChat();
  await loadSessions();
}

// ── History popover ───────────────────────────────────────
function openHistory() {
  renderHistory();
  chatHistoryPopover.classList.remove("is-hidden");
  chatHistoryButton.classList.add("is-active");
  chatHistoryButton.setAttribute("aria-expanded", "true");
}

function closeHistory() {
  renamingSessionId = null;
  chatHistoryPopover.classList.add("is-hidden");
  chatHistoryButton.classList.remove("is-active");
  chatHistoryButton.setAttribute("aria-expanded", "false");
}

function makeRowIconButton(icon, title, handler, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `chat-history-row-button${extraClass ? ` ${extraClass}` : ""}`;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", e => { e.stopPropagation(); handler(); });
  return btn;
}

function renderHistory() {
  chatHistoryList.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "chat-history-empty";
    empty.textContent = "まだ会話がありません";
    chatHistoryList.appendChild(empty);
    return;
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `chat-history-row${session.id === activeSessionId ? " is-active" : ""}`;

    if (session.id === renamingSessionId) {
      row.appendChild(buildRenameInput(session));
      chatHistoryList.appendChild(row);
      continue;
    }

    const main = document.createElement("button");
    main.type = "button";
    main.className = "chat-history-row-main";
    main.title = `${session.title}\n最終更新: ${new Date(Number(session.updated_at)).toLocaleString("ja-JP")}`;
    const title = document.createElement("span");
    title.className = "chat-history-row-title";
    title.textContent = session.title || "新しい会話";
    const time = document.createElement("span");
    time.className = "chat-history-row-time";
    time.textContent = formatUpdatedAgo(session.updated_at);
    main.append(title, time);
    main.addEventListener("click", () => {
      closeHistory();
      if (session.id !== activeSessionId) selectSession(session.id);
    });

    row.append(
      main,
      makeRowIconButton("edit", "名前を変更", () => {
        renamingSessionId = session.id;
        renderHistory();
      }),
      makeRowIconButton("trash", "削除", () => deleteSession(session.id), "is-danger")
    );
    chatHistoryList.appendChild(row);
  }
}

function buildRenameInput(session) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat-history-rename-input";
  input.value = session.title || "";
  input.placeholder = "会話名";
  let done = false;
  const finish = async commit => {
    if (done) return;
    done = true;
    renamingSessionId = null;
    const next = input.value.trim();
    if (commit && next && next !== session.title) {
      try {
        await renameSession(session.id, next);
      } catch (err) {
        setAppStatus(`会話名の変更に失敗しました: ${err.message}`, "error");
      }
    }
    renderHistory();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return input;
}

// ── Messages ──────────────────────────────────────────────
const ICONS = {
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.2 6.5"/><path d="M3 12A9 9 0 0 1 18.2 5.5"/><path d="M18 2v4h-4M6 22v-4h4"/></svg>`,
};

function makeMessageActionBtn(icon, title, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-message-action-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", e => { e.stopPropagation(); handler(); });
  return btn;
}

function appendMessageActions(wrap, role, messageId, content) {
  if (!messageId) return;
  const actions = document.createElement("div");
  actions.className = "chat-message-actions";
  if (role === "user") {
    actions.appendChild(makeMessageActionBtn("edit", "編集", () => editUserMessage(messageId, content)));
    actions.appendChild(makeMessageActionBtn("refresh", "再生成", () => regenerateFromUserMessage(messageId)));
    actions.appendChild(makeMessageActionBtn("trash", "削除", () => deleteUserMessage(messageId)));
  } else if (role === "assistant") {
    actions.appendChild(makeMessageActionBtn("trash", "削除", () => deleteAssistantMessage(messageId)));
  }
  wrap.appendChild(actions);
}

function appendBubble(role, content, createdAt = Date.now(), messageId = null) {
  chatMessages.querySelectorAll(".chat-empty-hint").forEach(el => el.remove());
  const wrap = document.createElement("div");
  wrap.className = `chat-message ${role}`;
  if (messageId) wrap.dataset.messageId = messageId;
  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = formatMessageMeta(role, createdAt);
  const body = document.createElement("div");
  body.className = role === "user" ? "chat-message-bubble" : "chat-message-text";
  setMessageBodyContent(body, role, content);
  wrap.append(meta, body);
  appendMessageActions(wrap, role, messageId, content);
  chatMessages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

async function deleteUserMessage(messageId) {
  if (streaming || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}/from`);
  await reloadActiveSessionMessages();
  loadSessions();
}

async function deleteAssistantMessage(messageId) {
  if (streaming || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}`);
  await reloadActiveSessionMessages();
  loadSessions();
}

async function editUserMessage(messageId, currentContent) {
  if (streaming || activeSessionId === null) return;
  const next = window.prompt("メッセージを編集", currentContent);
  if (next === null) return;
  const text = next.trim();
  if (!text) return;
  await api("PATCH", `/messages/${messageId}`, { content: text });
  await api("DELETE", `/messages/${messageId}/after`);
  await reloadActiveSessionMessages();
  loadSessions();
}

async function regenerateFromUserMessage(messageId) {
  if (streaming || !serverLoaded || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}/after`);
  await reloadActiveSessionMessages();

  const targetIndex = chatHistory.findIndex(m => m.id === messageId);
  if (targetIndex === -1 || chatHistory[targetIndex].role !== "user") return;
  chatHistory = chatHistory.slice(0, targetIndex + 1);
  await streamAssistantReply({ persistUser: false, statusLabel: "回答を再生成しています..." });
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !serverLoaded || streaming) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  streaming = true;
  updateComposerState();

  // 新しい会話は最初の送信時に保存する（空の会話を一覧に残さない）
  if (activeSessionId === null) {
    try {
      const session = await api("POST", "/chat/sessions", { title: "新しい会話" });
      activeSessionId = session.id;
      rememberActiveSession();
      sessions.unshift(session);
      renderDockTitle();
    } catch (err) {
      streaming = false;
      chatInput.value = text;
      updateComposerState();
      setAppStatus(`会話の作成に失敗しました: ${err.message}`, "error");
      return;
    }
  }

  chatHistory.push({ role: "user", content: text });
  const userWrap = appendBubble("user", text);
  await streamAssistantReply({ persistUser: true, userWrap, userText: text, statusLabel: "回答を生成しています..." });
}

// アシスタントの回答をストリームで受けて描画する。送信と再生成で共用する。
async function streamAssistantReply({ persistUser, userWrap = null, userText = "", statusLabel }) {
  streaming = true;
  updateComposerState();
  setAppStatus(statusLabel, "active");

  const wrap = document.createElement("div");
  wrap.className = "chat-message assistant loading";
  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = `アシスタント${currentModelName ? `（${currentModelName}）` : ""} 生成中`;
  const activity = document.createElement("div");
  activity.className = "chat-activity";
  const bubble = document.createElement("div");
  bubble.className = "chat-message-text";
  wrap.append(meta, activity, bubble);
  chatMessages.appendChild(wrap);
  scrollToBottom();

  let accumulated = "";
  const sidAtSend = activeSessionId;
  const finish = () => {
    streaming = false;
    updateComposerState();
    loadSessions().catch(() => {});
  };

  await streamChat(sidAtSend, chatHistory, {
    persistUser,
    endpoint: "/chat/agent-stream",
    onToken: chunk => {
      wrap.classList.remove("loading");
      accumulated += chunk;
      setMessageBodyContent(bubble, "assistant", accumulated);
      scrollToBottom();
    },
    onDone: evt => {
      wrap.classList.remove("loading");
      const userMessageId = evt?.user_message?.id ?? null;
      const assistantId = evt?.message?.id ?? null;
      if (userWrap && userMessageId) {
        chatHistory[chatHistory.length - 1].id = userMessageId;
        userWrap.dataset.messageId = userMessageId;
        appendMessageActions(userWrap, "user", userMessageId, userText);
      }
      meta.textContent = formatMessageMeta("assistant", evt?.message?.created_at || Date.now());
      chatHistory.push({ id: assistantId, role: "assistant", content: accumulated });
      if (assistantId) {
        wrap.dataset.messageId = assistantId;
        appendMessageActions(wrap, "assistant", assistantId, accumulated);
      }
      appendGenerationMetrics(wrap, evt?.metrics);
      finish();
      setAppStatus("回答を生成しました。", "success");
      chatInput.focus();
    },
    onError: err => {
      if (userWrap) chatHistory.pop();
      wrap.classList.remove("loading");
      wrap.classList.add("error");
      bubble.textContent = `エラー: ${err}`;
      finish();
      setAppStatus(`回答の生成に失敗しました: ${err}`, "error");
    },
    onActivity: createActivityRenderer(activity, {
      onModel: evt => {
        if (evt.name) meta.textContent = `アシスタント（${evt.name}） 生成中`;
      },
      onTextReset: () => {
        accumulated = "";
        setMessageBodyContent(bubble, "assistant", "");
      },
      onUpdate: () => {
        wrap.classList.remove("loading");
        scrollToBottom();
      }
    })
  });
}

// ── Model picker（単一サーバー: 一覧から選んでロード、その1台が全処理を担当） ──
async function openModelPicker() {
  if (loadingModel) return;
  chatModelModalBackdrop.classList.remove("is-hidden");
  await renderModelModal();
}

async function renderModelModal() {
  chatModelList.innerHTML = "";
  let models;
  let status;
  try {
    [models, status] = await Promise.all([api("GET", "/models"), refreshModelStatus()]);
  } catch (err) {
    chatModelList.innerHTML = `<p style="padding:16px;color:var(--muted)">取得失敗: ${err.message}</p>`;
    return;
  }

  if (!models.length) {
    chatModelList.innerHTML = '<p style="padding:16px;color:var(--muted)">models/ に GGUF ファイルが見つかりません</p>';
    return;
  }

  // ヘッダー: 現在の状態 + コンテキスト長 + 停止ボタン
  const head = document.createElement("div");
  head.className = "chat-model-head";
  const state = document.createElement("span");
  state.className = `chat-role-state${status.ready ? " is-ready" : ""}`;
  state.textContent = status.ready
    ? `稼働中: ${status.model_name} (:${status.port})`
    : "モデル未ロード";

  const ctxSelect = document.createElement("select");
  ctxSelect.className = "chat-role-select chat-role-ctx";
  CTX_OPTIONS.forEach(size => {
    const option = document.createElement("option");
    option.value = String(size);
    option.textContent = ctxLabel(size);
    if (size === status.ctx_size) option.selected = true;
    ctxSelect.appendChild(option);
  });
  ctxSelect.addEventListener("change", () => {
    api("PUT", "/llama/settings", { ctx_size: Number(ctxSelect.value) || null }).catch(() => {});
  });

  const ctxField = document.createElement("label");
  ctxField.className = "chat-model-context";
  ctxField.title = "モデルが一度に参照できる情報量です。大きいほど多くの会話や資料を扱えますが、必要なメモリも増えます。";
  const ctxFieldLabel = document.createElement("span");
  ctxFieldLabel.textContent = "コンテキスト長：";
  ctxField.append(ctxFieldLabel, ctxSelect);

  head.append(state, ctxField);

  if (status.ready) {
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "ghost-button chat-role-action";
    stopBtn.textContent = "停止";
    stopBtn.addEventListener("click", async () => {
      if (loadingModel) return;
      loadingModel = true;
      stopBtn.disabled = true;
      setAppStatus("モデルを停止しています...", "active");
      try {
        await api("POST", "/llama/stop");
        setAppStatus("モデルを停止しました。", "success");
      } catch (err) {
        setAppStatus(`モデルの停止に失敗しました: ${err.message}`, "error");
        window.alert(`モデルの停止に失敗しました: ${err.message}`);
      } finally {
        loadingModel = false;
        await renderModelModal();
      }
    });
    head.appendChild(stopBtn);
  }
  chatModelList.appendChild(head);

  // モデル一覧: クリックでロード
  models.forEach(({ name, path, relative_path }) => {
    const isCurrent = path === status.model_path;
    const isRunning = isCurrent && status.ready;

    const item = document.createElement("button");
    item.type = "button";
    item.className = `chat-model-item${isRunning ? " is-running" : ""}`;
    const label = document.createElement("span");
    label.className = "chat-model-item-name";
    label.textContent = name;
    item.title = relative_path || name;
    const badge = document.createElement("span");
    badge.className = "chat-model-item-state";
    badge.textContent = isRunning ? "稼働中" : "ロード";
    item.append(label, badge);

    item.addEventListener("click", async () => {
      if (loadingModel) return;
      if (isRunning) {
        closeModelPicker();
        return;
      }
      loadingModel = true;
      serverLoaded = false;
      updateComposerState();
      const selectedName = name;
      setModelStatus("is-loading", selectedName + " をロード中...");
      closeModelPicker();
      setAppStatus(selectedName + " をロードしています...", "active");
      try {
        await api("POST", "/llama/start", {
          model_path: path,
          ctx_size: Number(ctxSelect.value) || null,
        });
        setAppStatus(selectedName + " をロードしました。", "success");
      } catch (err) {
        setAppStatus(`モデルのロードに失敗しました: ${err.message}`, "error");
        window.alert(`モデルのロードに失敗しました: ${err.message}`);
      } finally {
        loadingModel = false;
        await refreshModelStatus().catch(() => setModelStatus("", "モデルを設定"));
      }
    });

    chatModelList.appendChild(item);
  });
}

function closeModelPicker() {
  chatModelModalBackdrop.classList.add("is-hidden");
}

// ── Event listeners ───────────────────────────────────────
chatModelBar.addEventListener("click", openModelPicker);
closeChatModelModal.addEventListener("click", closeModelPicker);
chatModelModalBackdrop.addEventListener("click", e => {
  if (e.target === chatModelModalBackdrop) closeModelPicker();
});
chatDockToggle.addEventListener("click", () => setDockOpen(chatDock.classList.contains("is-hidden")));
chatHistoryButton.addEventListener("click", () => {
  if (chatHistoryPopover.classList.contains("is-hidden")) openHistory();
  else closeHistory();
});
chatNewButton.addEventListener("click", () => { closeHistory(); startNewChat(); });
chatDeleteButton.addEventListener("click", () => {
  closeHistory();
  if (activeSessionId !== null) deleteSession(activeSessionId);
});
// 一覧は外側のクリックと Esc で閉じる（名前変更中の Esc は入力の取り消しだけにする）
window.addEventListener("mousedown", e => {
  if (chatHistoryPopover.classList.contains("is-hidden")) return;
  if (!chatDockHead.contains(e.target)) closeHistory();
});
window.addEventListener("keydown", e => {
  if (e.key === "Escape" && !chatHistoryPopover.classList.contains("is-hidden")) closeHistory();
});
chatSendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
  updateComposerState();
});

// ── Init ──────────────────────────────────────────────────
async function initChat() {
  initDock();
  startNewChat({ focus: false });
  const ready = await waitForServer();
  if (!ready) {
    clearMessages("バックエンドに接続できません");
    return;
  }
  await refreshModelStatus().catch(() => {});
  try {
    await loadSessions();
  } catch (err) {
    setAppStatus(`会話一覧の取得に失敗しました: ${err.message}`, "error");
    return;
  }
  // 前回開いていた会話を復元する（消えていれば新しい会話のまま）
  const savedId = Number(localStorage.getItem(CHAT_ACTIVE_SESSION_KEY));
  if (savedId && sessions.some(s => s.id === savedId)) await selectSession(savedId);
}

initChat();

// モデルのロード状態を拾うため、ストリーミング中を除いて定期的に状態を更新する。
setInterval(() => {
  if (!streaming && !loadingModel) refreshModelStatus().catch(() => {});
}, 10000);
