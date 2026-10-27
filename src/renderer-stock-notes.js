import { api, streamChat } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { formatMaybeCurrency, formatMaybeMultiple, formatMaybePercent } from "./renderer-utils.js";
import { setAppStatus } from "./renderer-status.js";

// 個別銘柄画面の「指標 / ノート」タブと、銘柄ノート（カテゴリー別カード
// stocks/<ticker>/notes/<key>.md）の更新処理。会話は右サイドバーのチャット
// （renderer-chat.js）が持ち、銘柄に紐づいた会話から「ノートに反映」「作り直す」を呼ぶ。

const tabMetricsBtn = document.getElementById("review-tab-metrics");
const tabNotesBtn = document.getElementById("review-tab-notes");
const notesDot = document.getElementById("review-notes-dot");
const notesStatus = document.getElementById("review-notes-status");
const regenerateButton = document.getElementById("review-notes-regenerate");
const metricsPane = document.getElementById("review-metrics-pane");
const notesPane = document.getElementById("review-notes-pane");
const notesBody = document.getElementById("review-notes-body");

let reviewTicker = "";
let noteCards = [];  // 表示中の銘柄のカード [{key, title, description, content, updated_at, has_backup}]
let notesQueue = []; // 反映待ち [{ticker, sessionId, user, assistant, btn}]
let notesUpdating = false;
let regenerating = false;
let regenerateSource = () => null; // チャット側が登録する「今開いている会話」の取得関数
const snapshots = new Map();       // ticker -> 個別銘柄画面で取得した指標
const tickerListeners = new Set();

export function normalizeTicker(ticker) {
  return String(ticker || "").trim().toUpperCase();
}

export function getReviewTicker() {
  return reviewTicker;
}

export function onReviewTickerChange(listener) {
  tickerListeners.add(listener);
}

// ── 銘柄の前提（system prompt） ─────────────────────────────

export function buildStockSystemPrompt(ticker) {
  const normalized = normalizeTicker(ticker);
  const snapshot = snapshots.get(normalized);
  const lines = [
    "あなたは個別銘柄レビュー用の投資調査アシスタントです。",
    "事実、推測、意見を分け、断定しすぎず、必要なら追加確認事項を提示してください。",
    `対象銘柄: ${normalized}`,
  ];
  if (!snapshot) {
    // 個別銘柄画面で未表示の銘柄は指標を持っていないため、ツールでの取得を促す
    lines.push("この銘柄の指標は手元にありません。必要なら stock_snapshot ツールで取得してください。");
    return lines.join("\n");
  }
  const overview = snapshot.overview || {};
  const valuation = snapshot.valuation || {};
  const profitability = snapshot.profitability || {};
  const analyst = snapshot.analyst || {};
  // 指標は画面表示と同じ整形済みの値で渡す（yfinance の ROE 等は小数（0.519 = 51.9%）
  // で返るため、生の値を渡すと LLM が「0.519%」のように単位を誤読する）
  lines.push(
    `銘柄名: ${snapshot.name || normalized}`,
    `セクター: ${overview.sector || "-"}`,
    `業種: ${overview.industry || "-"}`,
    `現在値: ${overview.currentPrice ?? "-"} ${snapshot.currency || ""}`,
    `時価総額: ${formatMaybeCurrency(overview.marketCap, snapshot.currency || "JPY", true)}`,
    `PER: ${formatMaybeMultiple(valuation.trailingPE)}（トレーリング）`,
    `PBR: ${formatMaybeMultiple(valuation.priceToBook)}`,
    `ROE: ${formatMaybePercent(profitability.returnOnEquity, 1)}`,
    `推奨: ${analyst.recommendationKey || "-"}`,
    "上記の指標は Yahoo Finance 由来の参考値で、日本株では更新が遅い・不正確なことがあります。重要な判断に関わる場合は一次情報（決算短信・会社IR）での確認を促してください。",
  );
  return lines.join("\n");
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

// ── ノートタブの表示 ─────────────────────────────────────

function setNotesStatus(text, isError = false) {
  if (!notesStatus) return;
  notesStatus.textContent = text;
  notesStatus.classList.toggle("is-error", isError);
}

// 単一カードの保存/復元レスポンスを、表示中の銘柄なら反映する
function applyCardSaved(ticker, saved) {
  if (ticker !== reviewTicker) return;
  const index = noteCards.findIndex((card) => card.key === saved?.key);
  if (index >= 0) noteCards[index] = saved;
  renderNotes();
}

function markNotesUpdated(ticker) {
  if (ticker === reviewTicker && notesPane?.classList.contains("is-hidden")) notesDot?.classList.remove("is-hidden");
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
  if (!reviewTicker) return;
  const ticker = reviewTicker;
  try {
    const saved = await api("POST", `/stocks/${encodeURIComponent(ticker)}/notes/${key}/restore`);
    applyCardSaved(ticker, saved);
    if (ticker === reviewTicker) setNotesStatus(`「${saved.title}」を前の内容に戻しました`);
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
  if (!visibleCards.length) {
    const empty = document.createElement("p");
    empty.className = "chat-empty-hint";
    empty.textContent = reviewTicker
      ? "まだノートがありません。右のチャットでこの銘柄について会話し、回答の「ノートに反映」を押すとカテゴリー別カードに蓄積されます"
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
}

function switchReviewTab(tab) {
  const showNotes = tab === "notes";
  metricsPane?.classList.toggle("is-hidden", showNotes);
  notesPane?.classList.toggle("is-hidden", !showNotes);
  tabMetricsBtn?.classList.toggle("is-active", !showNotes);
  tabNotesBtn?.classList.toggle("is-active", showNotes);
  regenerateButton?.classList.toggle("is-hidden", !showNotes);
  if (showNotes) notesDot?.classList.add("is-hidden");
  updateRegenerateButton();
}

// ── 「ノートに反映」（会話→カード） ─────────────────────────

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
function buildRoutingPrompt(ticker, cards, exchanges) {
  const categoryLines = cards.map((card) => `- ${card.key}: ${card.title} — ${card.description}`);
  return [
    `${ticker} についての以下の会話を、投資ノートのどのカテゴリーカードに反映すべきか選んでください。`,
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
function parseRoutedKeys(cards, text) {
  const lowered = String(text || "").toLowerCase();
  const found = cards.map((card) => card.key).filter((key) => lowered.includes(key));
  if (!found.length) return { keys: [], none: /\bnone\b/.test(lowered) };
  return { keys: found.slice(0, 3), none: false };
}

function buildCardUpdatePrompt(ticker, card, exchanges) {
  const name = snapshots.get(ticker)?.name || ticker;
  return [
    `${ticker}（${name}）の投資ノートのうち「${card.title}」カード（${card.description}）を、新しい会話のやり取りを踏まえて更新してください。`,
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

// 回答の「ノートに反映」から呼ぶ。反映は銘柄ごとにまとめて順番に処理する
export function queueNotesReflect({ ticker, sessionId, user, assistant, btn = null }) {
  const normalized = normalizeTicker(ticker);
  if (!normalized || !sessionId) return;
  notesQueue.push({ ticker: normalized, sessionId, user, assistant, btn });
  processNotesQueue();
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

// 表示中の銘柄のときだけノートタブのステータスに出す
function setTickerNotesStatus(ticker, text, isError = false) {
  if (ticker === reviewTicker) setNotesStatus(text, isError);
}

async function processNotesQueue() {
  if (notesUpdating || !notesQueue.length) return;
  notesUpdating = true;

  while (notesQueue.length) {
    // 先頭と同じ銘柄のやり取りをまとめて1回で処理する
    const ticker = notesQueue[0].ticker;
    const exchanges = notesQueue.filter((item) => item.ticker === ticker);
    notesQueue = notesQueue.filter((item) => item.ticker !== ticker);
    const sessionId = exchanges.at(-1).sessionId;
    await reflectExchanges(ticker, sessionId, exchanges);
  }

  notesUpdating = false;
}

async function reflectExchanges(ticker, sessionId, exchanges) {
  const fail = (text) => {
    setTickerNotesStatus(ticker, text, true);
    setAppStatus(`${ticker}: ${text}`, "error");
    markReflectResult(exchanges, false);
  };

  // 反映先の銘柄が表示中とは限らないため、カードは毎回取り直す
  let cards;
  try {
    cards = (await api("GET", `/stocks/${encodeURIComponent(ticker)}/notes`)).cards || [];
  } catch (_error) {
    fail("ノートの読み込みに失敗しました");
    return;
  }

  // 1) どのカードへ反映するかをLLMに選ばせる
  setTickerNotesStatus(ticker, "反映先のカードを判定中...");
  setAppStatus(`${ticker} のノートへ反映しています...`, "active");
  const routing = await runNotesLLM(
    sessionId,
    buildRoutingPrompt(ticker, cards, exchanges),
    "あなたは投資ノートの分類器です。指示された形式だけで出力し、説明は書かないでください。"
  );
  if (routing.error !== null) {
    fail("ノートへの反映に失敗しました");
    return;
  }
  const routed = parseRoutedKeys(cards, routing.text);
  if (!routed.keys.length) {
    setTickerNotesStatus(ticker, routed.none ? "反映すべき内容が見つかりませんでした" : "反映先を判定できませんでした", true);
    setAppStatus("ノートに反映する内容が見つかりませんでした。", "neutral", 5000);
    markReflectResult(exchanges, false);
    return;
  }

  // 2) 選ばれたカードごとに、そのカードの内容＋会話でマージする
  const updatedTitles = [];
  let allOk = true;
  for (const key of routed.keys) {
    const card = cards.find((item) => item.key === key);
    if (!card) continue;
    setTickerNotesStatus(ticker, `「${card.title}」を更新中...`);
    const merge = await runNotesLLM(sessionId, buildCardUpdatePrompt(ticker, card, exchanges), buildCardEditorSystemPrompt());
    const cleaned = stripMarkdownFences(merge.text);
    if (merge.error !== null || !cleaned) {
      allOk = false;
      continue;
    }
    if (cleaned.trim() === card.content.trim()) continue; // 変更なし（反映対象なしと判断された）
    try {
      const saved = await api("PATCH", `/stocks/${encodeURIComponent(ticker)}/notes/${key}`, { content: cleaned });
      applyCardSaved(ticker, saved);
      updatedTitles.push(card.title);
    } catch (_error) {
      allOk = false;
    }
  }

  if (!allOk && !updatedTitles.length) {
    fail("ノートへの反映に失敗しました");
    return;
  }
  const summary = updatedTitles.length ? `${updatedTitles.join("・")}を更新しました` : "反映する変更はありませんでした";
  setTickerNotesStatus(ticker, allOk ? summary : `${summary}（一部失敗）`, !allOk);
  markReflectResult(exchanges, true);
  setAppStatus(`${ticker} のノートへ反映しました（${updatedTitles.length ? updatedTitles.join("・") : "変更なし"}）。`, allOk ? "success" : "neutral");
  if (updatedTitles.length) markNotesUpdated(ticker);
}

// ── 「ノートを作り直す」（会話全体→全カード） ─────────────────

// チャット側が「今開いている会話」を返す関数を登録する
// 戻り値: { ticker, sessionId, history: [{role, content}], busy } または null
export function setRegenerateSource(provider) {
  regenerateSource = provider;
  updateRegenerateButton();
}

function currentRegenerateSource() {
  const source = regenerateSource();
  if (!source || source.ticker !== reviewTicker || !source.sessionId || !source.history?.length) return null;
  return source;
}

export function updateRegenerateButton() {
  if (!regenerateButton) return;
  const source = currentRegenerateSource();
  regenerateButton.disabled = regenerating || !source || source.busy;
  regenerateButton.title = source
    ? "右のチャットで開いている会話全体から、ノートを全面的に作り直します"
    : "右のチャットでこの銘柄の会話を開くと、その会話からノートを作り直せます";
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

async function regenerateNotes() {
  const source = currentRegenerateSource();
  if (!source || regenerating || source.busy) return;
  const { ticker, sessionId, history } = source;

  regenerating = true;
  updateRegenerateButton();
  setNotesStatus("ノートを作り直しています...");
  setAppStatus(`${ticker} のノートを作り直しています...`, "active");

  const titles = noteCards.map((card) => card.title);
  const prompt = [
    `${ticker} の会話内容を、投資レビュー用のMarkdownノートに整理してください。`,
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

  const result = await runNotesLLM(sessionId, prompt, [buildStockSystemPrompt(ticker), regenSystemPrompt].join("\n\n"));
  try {
    if (result.error !== null) throw new Error(result.error);
    const sections = splitRegeneratedNote(result.text);
    if (!sections.size) throw new Error(`カテゴリー見出し（${titles.join(" / ")}）を含む出力になりませんでした`);
    for (const [key, content] of sections) {
      const saved = await api("PATCH", `/stocks/${encodeURIComponent(ticker)}/notes/${key}`, { content });
      applyCardSaved(ticker, saved);
    }
    setTickerNotesStatus(ticker, `${sections.size}枚のカードを作り直しました`);
    markNotesUpdated(ticker);
    setAppStatus(`${ticker} のノートを作り直しました（${sections.size}カード）。`, "success");
  } catch (error) {
    setTickerNotesStatus(ticker, "ノートの作り直しに失敗しました", true);
    setAppStatus(`ノートの作り直しに失敗しました: ${error.message}`, "error");
  } finally {
    regenerating = false;
    updateRegenerateButton();
  }
}

// ── 個別銘柄画面からの呼び出し ───────────────────────────────

async function loadNotes(ticker) {
  noteCards = [];
  setNotesStatus("");
  notesDot?.classList.add("is-hidden");
  renderNotes();
  if (!ticker) return;
  try {
    const data = await api("GET", `/stocks/${encodeURIComponent(ticker)}/notes`);
    if (ticker !== reviewTicker) return;
    noteCards = Array.isArray(data?.cards) ? data.cards : [];
    if (tabNotesBtn) tabNotesBtn.title = data?.relative_dir ? `保存先: ${data.relative_dir}` : "";
    renderNotes();
    setNotesStatus(formatNotesUpdatedAt(latestNotesUpdatedAt()));
  } catch (error) {
    setNotesStatus(`ノートの読み込みに失敗しました: ${error.message}`, true);
  }
}

export function setStockReviewContext(ticker, snapshot) {
  const normalized = normalizeTicker(ticker);
  if (normalized && snapshot) snapshots.set(normalized, snapshot);
  const changed = normalized !== reviewTicker;
  reviewTicker = normalized;
  if (changed) {
    loadNotes(normalized);
    tickerListeners.forEach((listener) => listener(normalized));
  }
  updateRegenerateButton();
}

tabMetricsBtn?.addEventListener("click", () => switchReviewTab("metrics"));
tabNotesBtn?.addEventListener("click", () => switchReviewTab("notes"));
regenerateButton?.addEventListener("click", regenerateNotes);

renderNotes();
