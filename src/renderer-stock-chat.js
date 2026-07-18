import { api, streamChat, createActivityRenderer } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { appendGenerationMetrics } from "./chat-metrics.js";
import { formatMaybeCurrency, formatMaybeMultiple, formatMaybePercent } from "./renderer-utils.js";
import { setAppStatus } from "./renderer-status.js";

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
const metricsPane = document.getElementById("review-metrics-pane");
const notesPane = document.getElementById("review-notes-pane");
const notesBody = document.getElementById("review-notes-body");

let activeTicker = "";
let activeSnapshot = null;
let sessions = [];
let activeSessionId = null;
let history = [];
let streaming = false;

// ノート（カテゴリー別カード stocks/<ticker>/notes/<key>.md）の表示と
// 「ノートに反映」ボタンからの更新。カード一覧はバックエンドの
// NOTE_CATEGORIES 定義（key/title/description）をそのまま受け取る。
let noteCards = [];    // [{key, title, description, content, updated_at, has_backup}]
let legacyNote = null; // 分割前の旧 notes.md（あれば読み取り専用で表示）
let notesQueue = [];   // 反映待ちのやり取り [{user, assistant, btn}]
let notesUpdating = false;

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

// 全プロンプト共通のノート編集ルール
const NOTES_COMMON_RULES = [
  "事実、推測、意見を区別し、会話にない情報は推測で補わないでください。",
  "投資判断・企業分析に関係しない雑談やアプリ操作はノートに含めないでください。",
  "出典URLの羅列や「出典」セクションは作らず、重要な出典は本文中に1〜2件添える程度にしてください。",
  "時期が分かる情報には年月を添えてください。",
];

function buildCardEditorSystemPrompt() {
  return [
    "あなたは、個別銘柄の会話を長期的に蓄積する投資レビューノートの編集者です。",
    "ノートはカテゴリー別のカードに分かれており、あなたは指示された1枚のカードだけを編集します。",
    "出力は更新後のカード本文（Markdown）のみとし、前置き・説明・コードフェンス・カードタイトルの見出しは書かないでください。",
    ...NOTES_COMMON_RULES,
  ].join("\n");
}

function setNotesStatus(text, isError = false) {
  if (!notesStatus) return;
  notesStatus.textContent = text;
  notesStatus.classList.toggle("is-error", isError);
}

// ノート一覧 API（GET /stocks/{ticker}/notes 形式）のレスポンスを表示へ反映する
function applyNotesData(data) {
  noteCards = Array.isArray(data?.cards) ? data.cards : [];
  legacyNote = data?.legacy || null;
  renderNotes();
}

// 単一カードの保存/復元レスポンスを状態へ反映する
function applyCardSaved(saved) {
  const index = noteCards.findIndex((card) => card.key === saved?.key);
  if (index >= 0) noteCards[index] = saved;
  renderNotes();
}

// カード群の最新更新日時（ステータス表示用）
function latestNotesUpdatedAt() {
  const times = noteCards.map((card) => card.updated_at).filter(Boolean).sort();
  return times.at(-1) || null;
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

async function restoreNoteCard(key) {
  if (!activeTicker) return;
  const ticker = activeTicker;
  try {
    const saved = await api("POST", `/stocks/${encodeURIComponent(ticker)}/notes/${key}/restore`);
    if (activeTicker !== ticker) return;
    applyCardSaved(saved);
    setNotesStatus(`「${saved.title}」を前の内容に戻しました`);
  } catch (error) {
    setNotesStatus(`戻せませんでした: ${error.message}`, true);
  }
}

function buildNoteCardElement({ title, timeText, content, restoreKey }) {
  const card = document.createElement("section");
  card.className = "review-note-card";
  const head = document.createElement("div");
  head.className = "review-note-card-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  head.appendChild(heading);
  if (timeText) {
    const time = document.createElement("span");
    time.className = "review-note-card-time";
    time.textContent = timeText;
    head.appendChild(time);
  }
  if (restoreKey) {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "ghost-button review-note-card-restore";
    restore.textContent = "元に戻す";
    restore.title = "このカードを直前の保存前の内容に戻します。もう一度押すと戻す前の内容に戻ります";
    restore.addEventListener("click", () => restoreNoteCard(restoreKey));
    head.appendChild(restore);
  }
  const body = document.createElement("div");
  body.className = "chat-message-text review-note-card-body";
  body.innerHTML = renderMarkdown(content);
  card.append(head, body);
  return card;
}

function renderNotes() {
  if (!notesBody) return;
  notesBody.innerHTML = "";
  const visibleCards = noteCards.filter((card) => card.content.trim());
  if (!visibleCards.length && !legacyNote) {
    const empty = document.createElement("p");
    empty.className = "chat-empty-hint";
    empty.textContent = activeTicker
      ? "まだノートがありません。回答の「ノートに反映」を押すとカテゴリー別カードに蓄積されます"
      : "銘柄を選択してください";
    notesBody.appendChild(empty);
    return;
  }
  visibleCards.forEach((card) => {
    notesBody.appendChild(buildNoteCardElement({
      title: card.title,
      timeText: formatNotesUpdatedAt(card.updated_at),
      content: card.content,
      restoreKey: card.has_backup ? card.key : null,
    }));
  });
  if (legacyNote) {
    notesBody.appendChild(buildNoteCardElement({
      title: "旧ノート（分割前）",
      timeText: formatNotesUpdatedAt(legacyNote.updated_at),
      content: legacyNote.content,
      restoreKey: null,
    }));
  }
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

function formatExchanges(exchanges) {
  return exchanges
    .map((ex) => `User:\n${ex.user}\n\nAssistant:\n${ex.assistant}`)
    .join("\n\n");
}

// 反映先カードを選ばせるルーティングプロンプト。key のカンマ区切りだけを出力させる
function buildRoutingPrompt(exchanges) {
  const categoryLines = noteCards.map((card) => `- ${card.key}: ${card.title} — ${card.description}`);
  return [
    `${activeTicker} についての以下の会話を、投資ノートのどのカテゴリーカードに反映すべきか選んでください。`,
    "",
    "カテゴリー一覧:",
    ...categoryLines,
    "",
    "出力ルール:",
    "- 該当するカテゴリーの key だけをカンマ区切りで1〜3個出力する（例: recent,financials）。",
    "- 投資判断・企業分析に関わる内容が会話に無い場合だけ none と出力する。",
    "- 説明や理由は一切書かない。",
    "",
    "【会話】",
    formatExchanges(exchanges),
  ].join("\n");
}

// ルーティング出力から既知の key を抽出する（順序はカテゴリー定義順、最大3件）
function parseRoutedKeys(text) {
  const lowered = String(text || "").toLowerCase();
  const found = noteCards.map((card) => card.key).filter((key) => lowered.includes(key));
  if (!found.length) return { keys: [], none: /\bnone\b/.test(lowered) };
  return { keys: found.slice(0, 3), none: false };
}

function buildCardUpdatePrompt(card, exchanges) {
  const name = activeSnapshot?.name || activeTicker;
  return [
    `${activeTicker}（${name}）の投資ノートのうち「${card.title}」カード（${card.description}）を、新しい会話のやり取りを踏まえて更新してください。`,
    "",
    "ルール:",
    "- このカードの範囲に該当する内容だけを反映する。他のカテゴリーに属する内容は書かない。",
    "- 既存の内容は保持し、新しい情報の追記や古い記述の修正だけを行う。",
    "- 会話に出ていない情報を推測で補わない。",
    "- この銘柄の投資判断・企業分析に関係しない話題（雑談、アプリの操作の話、別銘柄だけの話など）は書かない。反映すべき内容が無ければ既存の内容をそのまま出力する。",
    "- 出典URLの羅列（リンク集・「出典」セクション）は書かない。特に重要な出典を本文中に1〜2件添える程度にとどめる。",
    "- カードのタイトル見出しは書かず、箇条書き中心の簡潔なMarkdownにする。",
    "",
    "【現在のカードの内容】",
    card.content.trim() || "(空)",
    "",
    "【新しい会話】",
    formatExchanges(exchanges),
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

// 1回のLLM呼び出しを行い、蓄積テキストを返す（失敗時は error を持つ）
async function runNotesLLM(sessionId, userContent, systemPrompt) {
  let text = "";
  let error = null;
  await streamChat(sessionId, [{ role: "user", content: userContent }], {
    persistUser: false,
    persistAssistant: false,
    systemPrompt,
    onToken: (chunk) => { text += chunk; },
    onError: (err) => { error = err; },
  });
  return { text, error };
}

async function processNotesQueue() {
  if (notesUpdating || !notesQueue.length) return;
  notesUpdating = true;
  const ticker = activeTicker;
  const sessionId = activeSessionId;

  while (notesQueue.length && activeTicker === ticker) {
    const exchanges = notesQueue.splice(0, notesQueue.length);

    // 1) どのカードへ反映するかをLLMに選ばせる
    setNotesStatus("反映先のカードを判定中...");
    setAppStatus(`${ticker} のノートへ反映しています...`, "active");
    const routing = await runNotesLLM(
      sessionId,
      buildRoutingPrompt(exchanges),
      "あなたは投資ノートの分類器です。指示された形式だけで出力し、説明は書かないでください。"
    );
    if (activeTicker !== ticker) break;
    if (routing.error !== null) {
      setNotesStatus("ノートへの反映に失敗しました", true);
      setAppStatus("ノートへの反映に失敗しました。", "error");
      markReflectResult(exchanges, false);
      continue;
    }
    const routed = parseRoutedKeys(routing.text);
    if (!routed.keys.length) {
      setNotesStatus(routed.none ? "反映すべき内容が見つかりませんでした" : "反映先を判定できませんでした", true);
      setAppStatus("ノートに反映する内容が見つかりませんでした。", "neutral", 5000);
      markReflectResult(exchanges, false);
      continue;
    }

    // 2) 選ばれたカードごとに、そのカードの内容＋会話でマージする
    let updatedTitles = [];
    let allOk = true;
    for (const key of routed.keys) {
      const card = noteCards.find((item) => item.key === key);
      if (!card) continue;
      setNotesStatus(`「${card.title}」を更新中...`);
      const merge = await runNotesLLM(sessionId, buildCardUpdatePrompt(card, exchanges), buildCardEditorSystemPrompt());
      if (activeTicker !== ticker) { allOk = false; break; }
      const cleaned = stripMarkdownFences(merge.text);
      if (merge.error !== null || !cleaned) {
        allOk = false;
        continue;
      }
      if (cleaned.trim() === card.content.trim()) continue; // 変更なし（反映対象なしと判断された）
      try {
        const saved = await api("PATCH", `/stocks/${encodeURIComponent(ticker)}/notes/${key}`, { content: cleaned });
        if (activeTicker !== ticker) { allOk = false; break; }
        applyCardSaved(saved);
        updatedTitles.push(card.title);
      } catch (_error) {
        allOk = false;
      }
    }
    if (activeTicker !== ticker) break;

    if (!allOk && !updatedTitles.length) {
      setNotesStatus("ノートへの反映に失敗しました", true);
      setAppStatus("ノートへの反映に失敗しました。", "error");
      markReflectResult(exchanges, false);
      continue;
    }
    const summary = updatedTitles.length ? `${updatedTitles.join("・")}を更新しました` : "反映する変更はありませんでした";
    setNotesStatus(allOk ? summary : `${summary}（一部失敗）`, !allOk);
    markReflectResult(exchanges, true);
    setAppStatus(`${ticker} のノートへ反映しました（${updatedTitles.length ? updatedTitles.join("・") : "変更なし"}）。`, allOk ? "success" : "neutral");
    if (updatedTitles.length && notesPane?.classList.contains("is-hidden")) notesDot?.classList.remove("is-hidden");
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
  noteCards = [];
  legacyNote = null;
  notesQueue = [];
  setNotesStatus("");
  notesDot?.classList.add("is-hidden");
  renderNotes();

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
    notePath.textContent = data.notes?.relative_dir ? `保存先: ${data.notes.relative_dir}` : "";
    applyNotesData(data.notes);
    setNotesStatus(formatNotesUpdatedAt(latestNotesUpdatedAt()));
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
  setAppStatus(`${activeTicker} の回答を生成しています...`, "active");

  history.push({ role: "user", content: text });
  appendMessage("user", text);
  const assistant = appendMessage("assistant", "");
  assistant.wrap.classList.add("loading");
  const activity = document.createElement("div");
  activity.className = "chat-activity";
  assistant.wrap.insertBefore(activity, assistant.body);

  let accumulated = "";
  await streamChat(activeSessionId, history, {
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
    }),
    onToken: (chunk) => {
      assistant.wrap.classList.remove("loading");
      accumulated += chunk;
      assistant.body.innerHTML = renderMarkdown(accumulated);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    onDone: async (event) => {
      assistant.wrap.classList.remove("loading");
      const userId = event?.user_message?.id || null;
      const assistantId = event?.message?.id || null;
      history[history.length - 1].id = userId;
      history.push({ id: assistantId, role: "assistant", content: accumulated });
      streaming = false;
      addReflectButton(assistant.wrap, () => ({ user: text, assistant: accumulated }));
      appendGenerationMetrics(assistant.wrap, event?.metrics);
      await refreshSessions();
      setEnabled(true);
      setAppStatus("回答を生成しました。", "success");
      inputEl.focus();
    },
    onError: (error) => {
      history.pop();
      assistant.wrap.classList.remove("loading");
      assistant.wrap.classList.add("error");
      assistant.body.textContent = `エラー: ${error}`;
      streaming = false;
      setEnabled(true);
      setAppStatus(`回答の生成に失敗しました: ${error}`, "error");
    },
  });
}

// 全面再生成の出力（## カテゴリー名 見出し付きMarkdown）をカード別に分割する
function splitRegeneratedNote(markdown) {
  const byTitle = new Map(noteCards.map((card) => [card.title, card.key]));
  const sections = new Map(); // key -> lines[]
  let currentKey = null;
  stripMarkdownFences(markdown).split("\n").forEach((line) => {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].trim();
      if (byTitle.has(title)) {
        currentKey = byTitle.get(title);
        if (!sections.has(currentKey)) sections.set(currentKey, []);
        return;
      }
      // 未知の見出しは「その他」へ（見出しは太字行として残す）
      if (currentKey === null) return; // 先頭のタイトル行など、最初の既知見出しより前は無視
      currentKey = "misc";
      if (!sections.has(currentKey)) sections.set(currentKey, []);
      sections.get(currentKey).push(`**${title}**`);
      return;
    }
    if (currentKey !== null) sections.get(currentKey).push(line);
  });
  const result = new Map();
  sections.forEach((lines, key) => {
    const content = lines.join("\n").trim();
    if (content) result.set(key, content);
  });
  return result;
}

async function summarizeToMarkdown() {
  if (!activeTicker || !activeSessionId || !history.length || streaming) return;

  streaming = true;
  setEnabled(true);
  const assistant = appendMessage("assistant", "Markdownを作成しています...");
  assistant.wrap.classList.add("loading");
  setAppStatus(`${activeTicker} のノートを作り直しています...`, "active");

  const titles = noteCards.map((card) => card.title);
  const prompt = [
    `${activeTicker} の会話内容を、投資レビュー用のMarkdownノートに整理してください。`,
    "会話全体からノート全文を作り直します。次のカテゴリー見出し（##）だけを使い、この名称を一字も変えずに書いてください:",
    ...noteCards.map((card) => `- ## ${card.title} — ${card.description}`),
    "情報のないカテゴリーは見出しごと省略してください。各カテゴリーの本文は箇条書き中心の簡潔なMarkdownにしてください。",
    "経緯・歴史に該当する内容は時系列に整理してください。",
    "",
    history.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`).join("\n\n"),
  ].join("\n");

  const regenSystemPrompt = [
    "あなたは、個別銘柄の会話を投資レビューノートに整理する編集者です。",
    "出力はMarkdownノート本文のみとし、前置き・説明・コードフェンスは書かないでください。",
    ...NOTES_COMMON_RULES,
  ].join("\n");

  let markdown = "";
  await streamChat(activeSessionId, [{ role: "user", content: prompt }], {
    persistUser: false,
    persistAssistant: false,
    systemPrompt: [buildStockSystemPrompt(), regenSystemPrompt].join("\n\n"),
    onToken: (chunk) => {
      assistant.wrap.classList.remove("loading");
      markdown += chunk;
      assistant.body.innerHTML = renderMarkdown(markdown);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    onDone: async (event) => {
      const ticker = activeTicker;
      try {
        const sections = splitRegeneratedNote(markdown);
        if (!sections.size) throw new Error(`カテゴリー見出し（${titles.join(" / ")}）を含む出力になりませんでした`);
        for (const [key, content] of sections) {
          const saved = await api("PATCH", `/stocks/${encodeURIComponent(ticker)}/notes/${key}`, { content });
          if (activeTicker !== ticker) break;
          applyCardSaved(saved);
        }
        setNotesStatus(`${sections.size}枚のカードを作り直しました`);
        if (notesPane?.classList.contains("is-hidden")) notesDot?.classList.remove("is-hidden");
        setAppStatus(`${ticker} のノートを作り直しました（${sections.size}カード）。`, "success");
      } catch (error) {
        setNotesStatus("ノートの作り直しの保存に失敗しました", true);
        setAppStatus(`ノートの作り直しに失敗しました: ${error.message}`, "error");
      }
      assistant.wrap.classList.remove("loading");
      streaming = false;
      setEnabled(true);
      appendGenerationMetrics(assistant.wrap, event?.metrics);
    },
    onError: (error) => {
      assistant.wrap.classList.remove("loading");
      assistant.wrap.classList.add("error");
      assistant.body.textContent = `保存に失敗しました: ${error}`;
      streaming = false;
      setEnabled(true);
      setAppStatus(`ノートの作り直しに失敗しました: ${error}`, "error");
    },
  });
}

tabMetricsBtn?.addEventListener("click", () => switchReviewTab("metrics"));
tabNotesBtn?.addEventListener("click", () => switchReviewTab("notes"));
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
