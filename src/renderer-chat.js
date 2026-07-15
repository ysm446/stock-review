import { api, apiFetch, streamChat, createActivityRenderer } from "./chat-api.js";
import { renderMarkdown } from "./chat-markdown.js";
import { appendGenerationMetrics } from "./chat-metrics.js";
import { setAppStatus } from "./renderer-status.js";

// ── DOM refs ─────────────────────────────────────────────
const chatModelBar        = document.getElementById("chat-model-bar");
const chatModelIndicator  = document.getElementById("chat-model-indicator");
const chatModelNameEl     = document.getElementById("chat-model-name");
const chatMessages        = document.getElementById("chat-messages");
const chatInput           = document.getElementById("chat-input");
const chatSendButton      = document.getElementById("chat-send");
const chatFooter          = document.querySelector("#view-chat .chat-footer");
const chatSidebar         = document.querySelector(".chat-sidebar");
const chatSidebarResizer  = document.getElementById("chat-sidebar-resizer");
const chatNewSessionBtn   = document.getElementById("chat-new-session-btn");
const chatNewWsBtn        = document.getElementById("chat-new-ws-btn");
const chatTree            = document.getElementById("chat-tree");
const chatModelModalBackdrop = document.getElementById("chat-model-modal-backdrop");
const chatModelList          = document.getElementById("chat-model-list");
const closeChatModelModal    = document.getElementById("close-chat-model-modal");

// ── State ────────────────────────────────────────────────
let workspaces       = [];   // [{id, name, sessions:[]}]
let activeWsId       = null;
let activeSessionId  = null;
let activeDocumentId = null;
let activeDocument   = null;
let chatHistory      = [];
let expandedWsIds    = new Set();
let expandedDocWsIds = new Set();
let serverLoaded     = false;
let loadingModel     = false;
let streaming        = false;
let currentModelName = "";

const CHAT_SIDEBAR_WIDTH_KEY = "stock-review.chatSidebarWidth";
const CHAT_DOC_EXPANDED_KEY = "stock-review.chatDocumentsExpanded";
const CHAT_SIDEBAR_DEFAULT_WIDTH = 220;
const CHAT_SIDEBAR_MIN_WIDTH = 180;
const CHAT_SIDEBAR_MAX_WIDTH = 440;
const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536];

let treeDragState = null;

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

function setInputEnabled(on) {
  chatInput.disabled = !on;
  chatSendButton.disabled = !on;
}

function loadExpandedDocumentSections() {
  try {
    const ids = JSON.parse(localStorage.getItem(CHAT_DOC_EXPANDED_KEY) || "[]");
    expandedDocWsIds = new Set(ids.map(Number).filter(Number.isFinite));
  } catch (_) {
    expandedDocWsIds = new Set();
  }
}

function saveExpandedDocumentSections() {
  localStorage.setItem(CHAT_DOC_EXPANDED_KEY, JSON.stringify([...expandedDocWsIds]));
}

function clampChatSidebarWidth(width) {
  const viewportLimit = Math.max(CHAT_SIDEBAR_MIN_WIDTH, window.innerWidth - 520);
  const maxWidth = Math.min(CHAT_SIDEBAR_MAX_WIDTH, viewportLimit);
  return Math.min(Math.max(width, CHAT_SIDEBAR_MIN_WIDTH), maxWidth);
}

function setChatSidebarWidth(width, persist = false) {
  if (!chatSidebar) return;
  const nextWidth = clampChatSidebarWidth(Number(width) || CHAT_SIDEBAR_DEFAULT_WIDTH);
  chatSidebar.style.width = `${nextWidth}px`;
  if (persist) localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(nextWidth));
}

function initChatSidebarResize() {
  if (!chatSidebar) return;

  const savedWidth = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY));
  setChatSidebarWidth(savedWidth || CHAT_SIDEBAR_DEFAULT_WIDTH);

  if (!chatSidebarResizer) return;

  let resizing = false;

  function finishResize() {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove("is-resizing-chat-sidebar");
    chatSidebarResizer.classList.remove("is-active");
    const width = Math.round(chatSidebar.getBoundingClientRect().width);
    localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(width));
    window.removeEventListener("pointermove", resizeSidebar);
    window.removeEventListener("pointerup", finishResize);
    window.removeEventListener("pointercancel", finishResize);
  }

  function resizeSidebar(event) {
    if (!resizing) return;
    const sidebarLeft = chatSidebar.getBoundingClientRect().left;
    setChatSidebarWidth(event.clientX - sidebarLeft);
  }

  chatSidebarResizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    resizing = true;
    document.body.classList.add("is-resizing-chat-sidebar");
    chatSidebarResizer.classList.add("is-active");
    chatSidebarResizer.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", resizeSidebar);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  });

  window.addEventListener("resize", () => {
    const width = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY)) || chatSidebar.getBoundingClientRect().width;
    setChatSidebarWidth(width);
  });
}

async function refreshModelStatus() {
  const status = await api("GET", "/llama/status");
  serverLoaded = Boolean(status.ready);
  currentModelName = status.model_name || "";

  if (serverLoaded) {
    setModelStatus("is-loaded", currentModelName || "読み込み済み");
    if (activeSessionId !== null && !streaming) setInputEnabled(true);
  } else {
    setModelStatus("", "モデルを設定");
    if (!streaming) setInputEnabled(false);
  }

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

function formatChatDate(value, withTime = true) {
  if (!value) return "";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";

  const options = withTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("ja-JP", options).format(date);
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

// ── Workspace tree ────────────────────────────────────────
async function loadWorkspaces() {
  const ready = await waitForServer();
  if (!ready) {
    chatTree.innerHTML = '<p class="chat-tree-empty">バックエンドに接続できません</p>';
    return;
  }
  await refreshModelStatus().catch(() => {});
  const wsList = await api("GET", "/workspaces");
  workspaces = await Promise.all(
    wsList.map(async ws => ({
      ...ws,
      sessions: await api("GET", `/workspaces/${ws.id}/sessions`),
      documents: await api("GET", `/workspaces/${ws.id}/documents`),
    }))
  );
  if (workspaces.length > 0) expandedWsIds.add(workspaces[0].id);
  const hasSavedDocState = localStorage.getItem(CHAT_DOC_EXPANDED_KEY) !== null;
  for (const ws of workspaces) {
    if (!hasSavedDocState || activeDocument?.workspace_id === ws.id) {
      expandedDocWsIds.add(ws.id);
    }
  }
  renderTree();
}

function renderTree() {
  chatTree.innerHTML = "";
  if (!workspaces.length) {
    chatTree.innerHTML = '<p class="chat-tree-empty">ワークスペースがありません</p>';
    return;
  }
  for (const ws of workspaces) {
    chatTree.appendChild(buildWsSection(ws));
  }
}

function buildWsSection(ws) {
  const isExpanded = expandedWsIds.has(ws.id);
  const section = document.createElement("div");
  section.className = "chat-ws-section";
  section.dataset.wsId = ws.id;

  // Header
  const header = document.createElement("div");
  header.className = "chat-ws-header";
  header.draggable = true;
  header.dataset.wsId = ws.id;

  const toggle = document.createElement("button");
  toggle.className = "chat-ws-toggle";
  toggle.textContent = isExpanded ? "▾" : "▸";
  toggle.addEventListener("click", e => { e.stopPropagation(); toggleWs(ws.id); });

  const label = document.createElement("span");
  label.className = "chat-ws-label";
  label.textContent = ws.name;
  label.addEventListener("dblclick", e => { e.stopPropagation(); startRename(label, v => renameWorkspace(ws.id, v)); });

  const actions = document.createElement("div");
  actions.className = "chat-ws-actions";
  actions.appendChild(makeActionBtn("+", "会話を追加", () => createSession(ws.id)));
  actions.appendChild(makeActionBtn("✎", "名前を変更", e => { e.stopPropagation(); startRename(label, v => renameWorkspace(ws.id, v)); }));
  actions.appendChild(makeActionBtn("trash", "削除", () => deleteWorkspace(ws.id), { icon: "trash" }));

  header.append(toggle, label, actions);
  header.addEventListener("click", () => toggleWs(ws.id));
  header.addEventListener("dragstart", e => startWorkspaceDrag(e, ws.id));
  header.addEventListener("dragover", e => handleWorkspaceDragOver(e, ws.id, header));
  header.addEventListener("dragleave", () => clearDropClasses(header));
  header.addEventListener("drop", e => handleWorkspaceDrop(e, ws.id, header));
  header.addEventListener("dragend", finishTreeDrag);
  section.appendChild(header);
  section.addEventListener("dragover", e => handleWorkspaceSectionDragOver(e, ws.id, section));
  section.addEventListener("dragleave", () => clearDropClasses(section));
  section.addEventListener("drop", e => handleWorkspaceSectionDrop(e, ws.id, section));

  // Sessions
  if (isExpanded) {
    section.appendChild(buildDocumentsSection(ws));
    for (const sess of ws.sessions) {
      section.appendChild(buildSessionItem(sess));
    }
  }
  return section;
}

function buildDocumentsSection(ws) {
  const isExpanded = expandedDocWsIds.has(ws.id);
  const group = document.createElement("div");
  group.className = `chat-doc-section${isExpanded ? " is-expanded" : ""}`;

  const header = document.createElement("div");
  header.className = "chat-doc-header";

  const toggle = document.createElement("button");
  toggle.className = "chat-doc-toggle";
  toggle.textContent = isExpanded ? "▾" : "▸";
  toggle.title = isExpanded ? "DOCUMENTS を折りたたむ" : "DOCUMENTS を開く";
  toggle.addEventListener("click", e => { e.stopPropagation(); toggleDocuments(ws.id); });

  const label = document.createElement("span");
  label.className = "chat-doc-label";
  label.textContent = "DOCUMENTS";
  label.addEventListener("click", e => { e.stopPropagation(); toggleDocuments(ws.id); });

  const actions = document.createElement("div");
  actions.className = "chat-doc-actions";
  actions.appendChild(makeActionBtn("+", "DOCUMENTS に追加", e => { e.stopPropagation(); createDocument(ws.id); }));

  header.append(toggle, label, actions);
  header.addEventListener("click", () => toggleDocuments(ws.id));
  group.appendChild(header);

  if (!isExpanded) return group;

  if (!ws.documents || !ws.documents.length) {
    const empty = document.createElement("div");
    empty.className = "chat-doc-empty";
    empty.textContent = "No documents";
    group.appendChild(empty);
    return group;
  }

  for (const doc of ws.documents) {
    group.appendChild(buildDocumentItem(doc));
  }
  return group;
}

function buildDocumentItem(doc) {
  const item = document.createElement("div");
  item.className = `chat-doc-item${doc.id === activeDocumentId ? " is-active" : ""}`;
  item.dataset.documentId = doc.id;

  const content = document.createElement("div");
  content.className = "chat-session-content";

  const label = document.createElement("span");
  label.className = "chat-session-label";
  label.textContent = doc.title || "Untitled";

  const date = document.createElement("span");
  date.className = "chat-session-date";
  date.textContent = formatChatDate(doc.updated_at || doc.created_at);

  content.append(label, date);

  const actions = document.createElement("div");
  actions.className = "chat-session-actions";
  actions.appendChild(makeActionBtn("trash", "削除", e => { e.stopPropagation(); deleteDocument(doc.id); }, { icon: "trash" }));

  item.append(content, actions);
  item.addEventListener("click", () => selectDocument(doc.id));
  return item;
}

function buildSessionItem(sess) {
  const item = document.createElement("div");
  item.className = `chat-session-item${sess.id === activeSessionId ? " is-active" : ""}`;
  item.dataset.sessionId = sess.id;
  item.draggable = true;

  const content = document.createElement("div");
  content.className = "chat-session-content";

  const label = document.createElement("span");
  label.className = "chat-session-label";
  label.textContent = sess.title;
  label.addEventListener("dblclick", e => { e.stopPropagation(); startRename(label, v => renameSession(sess.id, v)); });

  const date = document.createElement("span");
  date.className = "chat-session-date";
  date.textContent = formatChatDate(sess.updated_at || sess.created_at);

  content.append(label, date);

  const actions = document.createElement("div");
  actions.className = "chat-session-actions";
  actions.appendChild(makeActionBtn("✎", "名前を変更", e => { e.stopPropagation(); startRename(label, v => renameSession(sess.id, v)); }));
  actions.appendChild(makeActionBtn("trash", "削除", e => { e.stopPropagation(); deleteSession(sess.id); }, { icon: "trash" }));

  item.append(content, actions);
  item.addEventListener("click", () => selectSession(sess.id));
  item.addEventListener("dragstart", e => startSessionDrag(e, sess));
  item.addEventListener("dragover", e => handleSessionDragOver(e, sess, item));
  item.addEventListener("dragleave", () => clearDropClasses(item));
  item.addEventListener("drop", e => handleSessionDrop(e, sess, item));
  item.addEventListener("dragend", finishTreeDrag);
  return item;
}

function makeActionBtn(text, title, handler, options = {}) {
  const btn = document.createElement("button");
  btn.className = "chat-tree-action-btn";
  btn.draggable = false;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  if (options.icon === "trash") {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
        <path d="M4 7h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M6 7l1 14h10l1-14M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `;
  } else if (options.icon === "edit") {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
        <path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `;
  } else if (options.icon === "refresh") {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
        <path d="M21 12a9 9 0 0 1-15.2 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M3 12A9 9 0 0 1 18.2 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M18 2v4h-4M6 22v-4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  } else {
    btn.textContent = text;
  }
  btn.addEventListener("click", e => { e.stopPropagation(); handler(e); });
  return btn;
}

function clearDropClasses(el) {
  el?.classList.remove("is-dragging", "is-drop-before", "is-drop-after", "is-drop-target");
}

function clearAllDropClasses() {
  chatTree.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after, .is-drop-target")
    .forEach(clearDropClasses);
}

function getDropPlacement(event, el) {
  const rect = el.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function findSessionLocation(sessionId) {
  for (const ws of workspaces) {
    const index = ws.sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) return { ws, index };
  }
  return null;
}

function startWorkspaceDrag(event, wsId) {
  if (event.target.closest("button, input, textarea")) return;
  treeDragState = { type: "workspace", id: Number(wsId) };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", `workspace:${wsId}`);
  event.currentTarget.classList.add("is-dragging");
}

function startSessionDrag(event, session) {
  if (event.target.closest("button, input, textarea")) return;
  treeDragState = {
    type: "session",
    id: Number(session.id),
    sourceWorkspaceId: Number(session.workspace_id),
  };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", `session:${session.id}`);
  event.currentTarget.classList.add("is-dragging");
}

function finishTreeDrag() {
  treeDragState = null;
  clearAllDropClasses();
}

function handleWorkspaceDragOver(event, targetWsId, header) {
  if (!treeDragState) return;
  if (treeDragState.type === "workspace" && treeDragState.id === targetWsId) return;
  event.preventDefault();
  event.stopPropagation();
  clearDropClasses(header);
  if (treeDragState.type === "workspace") {
    header.classList.add(getDropPlacement(event, header) === "before" ? "is-drop-before" : "is-drop-after");
  } else if (treeDragState.type === "session") {
    header.classList.add("is-drop-target");
  }
}

async function handleWorkspaceDrop(event, targetWsId, header) {
  if (!treeDragState) return;
  event.preventDefault();
  event.stopPropagation();
  const state = treeDragState;
  const placement = getDropPlacement(event, header);
  finishTreeDrag();
  if (state.type === "workspace") {
    await moveWorkspace(state.id, targetWsId, placement);
  } else if (state.type === "session") {
    await moveSession(state.id, targetWsId, null, "start");
  }
}

function handleWorkspaceSectionDragOver(event, targetWsId, section) {
  if (!treeDragState || treeDragState.type !== "session") return;
  if (event.target.closest(".chat-session-item, .chat-ws-header")) return;
  event.preventDefault();
  section.classList.add("is-drop-target");
}

async function handleWorkspaceSectionDrop(event, targetWsId, section) {
  if (!treeDragState || treeDragState.type !== "session") return;
  if (event.target.closest(".chat-session-item, .chat-ws-header")) return;
  event.preventDefault();
  event.stopPropagation();
  const sessionId = treeDragState.id;
  finishTreeDrag();
  clearDropClasses(section);
  await moveSession(sessionId, targetWsId, null, "end");
}

function handleSessionDragOver(event, targetSession, item) {
  if (!treeDragState || treeDragState.type !== "session" || treeDragState.id === targetSession.id) return;
  event.preventDefault();
  event.stopPropagation();
  clearDropClasses(item);
  item.classList.add(getDropPlacement(event, item) === "before" ? "is-drop-before" : "is-drop-after");
}

async function handleSessionDrop(event, targetSession, item) {
  if (!treeDragState || treeDragState.type !== "session" || treeDragState.id === targetSession.id) return;
  event.preventDefault();
  event.stopPropagation();
  const sessionId = treeDragState.id;
  const placement = getDropPlacement(event, item);
  finishTreeDrag();
  await moveSession(sessionId, targetSession.workspace_id, targetSession.id, placement);
}

async function moveWorkspace(dragWsId, targetWsId, placement) {
  const from = workspaces.findIndex(ws => ws.id === dragWsId);
  const target = workspaces.findIndex(ws => ws.id === targetWsId);
  if (from === -1 || target === -1 || from === target) return;
  const [moved] = workspaces.splice(from, 1);
  let insertAt = workspaces.findIndex(ws => ws.id === targetWsId);
  if (placement === "after") insertAt += 1;
  workspaces.splice(insertAt, 0, moved);
  renderTree();
  try {
    await api("PATCH", "/workspaces/reorder", { ids: workspaces.map(ws => ws.id) });
  } catch (err) {
    await loadWorkspaces();
  }
}

async function moveSession(sessionId, targetWsId, targetSessionId = null, placement = "end") {
  const source = findSessionLocation(sessionId);
  const targetWs = workspaces.find(ws => ws.id === targetWsId);
  if (!source || !targetWs) return;

  const [session] = source.ws.sessions.splice(source.index, 1);
  session.workspace_id = targetWsId;

  let insertAt = targetWs.sessions.length;
  if (placement === "start") insertAt = 0;
  if (targetSessionId !== null) {
    insertAt = targetWs.sessions.findIndex(s => s.id === targetSessionId);
    if (insertAt === -1) insertAt = targetWs.sessions.length;
    if (placement === "after") insertAt += 1;
  }
  targetWs.sessions.splice(insertAt, 0, session);
  expandedWsIds.add(targetWsId);
  renderTree();

  try {
    const touchedIds = new Set([source.ws.id, targetWsId]);
    for (const wsId of touchedIds) {
      const ws = workspaces.find(w => w.id === wsId);
      if (ws) await api("PATCH", `/workspaces/${wsId}/sessions/reorder`, { ids: ws.sessions.map(s => s.id) });
    }
  } catch (err) {
    await loadWorkspaces();
  }
}

function startRename(labelEl, onCommit) {
  const input = document.createElement("input");
  input.className = "chat-tree-rename-input";
  input.value = labelEl.textContent;
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim() || labelEl.textContent;
    onCommit(val);
    labelEl.textContent = val;
    labelEl.style.display = "";
    input.remove();
  }
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { committed = true; labelEl.style.display = ""; input.remove(); }
  });
  input.addEventListener("blur", commit);
  labelEl.style.display = "none";
  labelEl.after(input);
  input.focus();
  input.select();
}

// ── Workspace/session CRUD ────────────────────────────────
function toggleWs(id) {
  if (expandedWsIds.has(id)) expandedWsIds.delete(id);
  else expandedWsIds.add(id);
  renderTree();
}

function toggleDocuments(wsId) {
  if (expandedDocWsIds.has(wsId)) expandedDocWsIds.delete(wsId);
  else expandedDocWsIds.add(wsId);
  saveExpandedDocumentSections();
  renderTree();
}

async function createWorkspace() {
  const ws = await api("POST", "/workspaces", { name: "新しいワークスペース" });
  ws.sessions = [];
  ws.documents = [];
  workspaces.unshift(ws);
  expandedWsIds.add(ws.id);
  expandedDocWsIds.add(ws.id);
  saveExpandedDocumentSections();
  activeWsId = ws.id;
  renderTree();
  // Focus rename immediately
  const header = chatTree.querySelector(`[data-ws-id="${ws.id}"] .chat-ws-label`);
  if (header) startRename(header, v => renameWorkspace(ws.id, v));
}

async function renameWorkspace(id, name) {
  await api("PATCH", `/workspaces/${id}`, { name });
  const ws = workspaces.find(w => w.id === id);
  if (ws) ws.name = name;
  renderTree();
}

async function deleteWorkspace(id) {
  await api("DELETE", `/workspaces/${id}`);
  workspaces = workspaces.filter(w => w.id !== id);
  expandedDocWsIds.delete(id);
  saveExpandedDocumentSections();
  if (activeSessionId) {
    const still = workspaces.flatMap(w => w.sessions).find(s => s.id === activeSessionId);
    if (!still) { activeSessionId = null; chatHistory = []; clearMessages("会話を選択してください"); setInputEnabled(false); }
  }
  renderTree();
}

async function createDocument(wsId) {
  const doc = await api("POST", `/workspaces/${wsId}/documents`, {
    title: "Untitled",
    content: "",
  });
  const ws = workspaces.find(w => w.id === wsId);
  if (ws) {
    if (!ws.documents) ws.documents = [];
    ws.documents.unshift(doc);
    expandedWsIds.add(wsId);
    expandedDocWsIds.add(wsId);
    saveExpandedDocumentSections();
  }
  activeWsId = wsId;
  renderTree();
  await selectDocument(doc.id);
}

async function selectDocument(id) {
  if (streaming) return;
  activeDocumentId = id;
  activeSessionId = null;
  chatHistory = [];
  activeDocument = await api("GET", `/documents/${id}`);
  if (activeDocument?.workspace_id) {
    expandedDocWsIds.add(activeDocument.workspace_id);
    saveExpandedDocumentSections();
  }
  renderDocumentEditor(activeDocument);
  renderTree();
  setInputEnabled(false);
  if (chatFooter) chatFooter.classList.add("is-hidden");
}

async function saveActiveDocument() {
  if (!activeDocumentId) return;
  const titleInput = document.getElementById("document-title-input");
  const contentInput = document.getElementById("document-content-input");
  const title = titleInput?.value.trim() || "Untitled";
  const content = contentInput?.value || "";
  const updated = await api("PATCH", `/documents/${activeDocumentId}`, { title, content });
  activeDocument = updated;
  for (const ws of workspaces) {
    const idx = (ws.documents || []).findIndex(d => d.id === activeDocumentId);
    if (idx !== -1) {
      ws.documents[idx] = {
        id: updated.id,
        workspace_id: updated.workspace_id,
        title: updated.title,
        sort_order: updated.sort_order,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      };
      ws.documents.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
      break;
    }
  }
  renderTree();
  showDocumentSaveState("Saved");
}

async function deleteDocument(id) {
  await api("DELETE", `/documents/${id}`);
  for (const ws of workspaces) {
    ws.documents = (ws.documents || []).filter(d => d.id !== id);
  }
  if (activeDocumentId === id) {
    activeDocumentId = null;
    activeDocument = null;
    clearMessages("会話を選択してください");
    if (chatFooter) chatFooter.classList.remove("is-hidden");
    setInputEnabled(serverLoaded && activeSessionId !== null);
  }
  renderTree();
}

function showDocumentSaveState(text) {
  const status = document.getElementById("document-save-status");
  if (!status) return;
  status.textContent = text;
  window.clearTimeout(showDocumentSaveState.timer);
  showDocumentSaveState.timer = window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
}

function renderDocumentEditor(doc) {
  chatMessages.innerHTML = "";
  const editor = document.createElement("div");
  editor.className = "document-editor";
  editor.innerHTML = `
    <div class="document-editor-head">
      <input class="document-title-input" id="document-title-input" value="" placeholder="Untitled" />
      <div class="document-editor-actions">
        <span class="document-save-status" id="document-save-status"></span>
        <button class="ghost-button document-save-btn" id="document-save-btn" type="button">Save</button>
      </div>
    </div>
    <textarea class="document-content-input" id="document-content-input" placeholder="Text data..."></textarea>
  `;
  chatMessages.appendChild(editor);

  const titleInput = document.getElementById("document-title-input");
  const contentInput = document.getElementById("document-content-input");
  const saveButton = document.getElementById("document-save-btn");
  titleInput.value = doc.title || "";
  contentInput.value = doc.content || "";
  saveButton.addEventListener("click", saveActiveDocument);
  const markUnsaved = () => {
    const status = document.getElementById("document-save-status");
    if (status) status.textContent = "Unsaved";
  };
  const saveShortcut = e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActiveDocument();
    }
  };
  titleInput.addEventListener("input", markUnsaved);
  contentInput.addEventListener("input", markUnsaved);
  titleInput.addEventListener("keydown", saveShortcut);
  contentInput.addEventListener("keydown", saveShortcut);
}

async function createSession(wsId) {
  const sess = await api("POST", `/workspaces/${wsId}/sessions`, { title: "新しい会話" });
  const ws = workspaces.find(w => w.id === wsId);
  if (ws) { ws.sessions.unshift(sess); expandedWsIds.add(wsId); }
  activeWsId = wsId;
  renderTree();
  await selectSession(sess.id);
}

async function renameSession(id, title) {
  await api("PATCH", `/sessions/${id}`, { title });
  for (const ws of workspaces) {
    const s = ws.sessions.find(s => s.id === id);
    if (s) { s.title = title; break; }
  }
  renderTree();
}

async function deleteSession(id) {
  await api("DELETE", `/sessions/${id}`);
  for (const ws of workspaces) {
    const idx = ws.sessions.findIndex(s => s.id === id);
    if (idx !== -1) { ws.sessions.splice(idx, 1); break; }
  }
  if (activeSessionId === id) {
    activeSessionId = null;
    chatHistory = [];
    clearMessages("会話を選択してください");
    setInputEnabled(false);
  }
  renderTree();
}

async function selectSession(id) {
  if (streaming) return;
  activeSessionId = id;
  activeDocumentId = null;
  activeDocument = null;
  chatHistory = [];
  clearMessages();
  if (chatFooter) chatFooter.classList.remove("is-hidden");

  const msgs = await api("GET", `/sessions/${id}/messages`);
  for (const m of msgs) {
    chatHistory.push({ id: m.id, role: m.role, content: m.content });
    appendBubble(m.role, m.content, m.created_at, m.id);
  }
  if (!msgs.length) clearMessages("メッセージを入力してください");

  renderTree();
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (serverLoaded) setInputEnabled(true);
}

// ── New session from top button ───────────────────────────
async function newSessionInActiveWs() {
  let wsId = activeWsId;
  if (!wsId && workspaces.length > 0) wsId = workspaces[0].id;
  if (!wsId) { await createWorkspace(); return; }
  await createSession(wsId);
}

// ── Chat ──────────────────────────────────────────────────
function makeMessageActionBtn(icon, title, handler) {
  const btn = makeActionBtn("", title, handler, { icon });
  btn.classList.add("chat-message-action-btn");
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
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

async function reloadActiveSessionMessages() {
  if (activeSessionId === null) return;
  chatHistory = [];
  clearMessages();
  const msgs = await api("GET", `/sessions/${activeSessionId}/messages`);
  for (const m of msgs) {
    chatHistory.push({ id: m.id, role: m.role, content: m.content });
    appendBubble(m.role, m.content, m.created_at, m.id);
  }
  if (!msgs.length) clearMessages("メッセージを入力してください");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function deleteUserMessage(messageId) {
  if (streaming || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}/from`);
  await reloadActiveSessionMessages();
  refreshSession(activeSessionId);
}

async function deleteAssistantMessage(messageId) {
  if (streaming || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}`);
  await reloadActiveSessionMessages();
  refreshSession(activeSessionId);
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
  refreshSession(activeSessionId);
}

async function regenerateFromUserMessage(messageId) {
  if (streaming || !serverLoaded || activeSessionId === null) return;
  await api("DELETE", `/messages/${messageId}/after`);
  await reloadActiveSessionMessages();

  const targetIndex = chatHistory.findIndex(m => m.id === messageId);
  if (targetIndex === -1 || chatHistory[targetIndex].role !== "user") return;
  chatHistory = chatHistory.slice(0, targetIndex + 1);

  streaming = true;
  setInputEnabled(false);
  setAppStatus("回答を再生成しています...", "active");

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
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let accumulated = "";
  const sidAtSend = activeSessionId;

  await streamChat(sidAtSend, chatHistory, {
    persistUser: false,
    endpoint: "/chat/agent-stream",
    onToken: chunk => {
      wrap.classList.remove("loading");
      accumulated += chunk;
      setMessageBodyContent(bubble, "assistant", accumulated);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    },
    onDone: evt => {
      wrap.classList.remove("loading");
      const assistantId = evt?.message?.id ?? null;
      meta.textContent = formatMessageMeta("assistant", evt?.message?.created_at || Date.now());
      chatHistory.push({ id: assistantId, role: "assistant", content: accumulated });
      if (assistantId) {
        wrap.dataset.messageId = assistantId;
        appendMessageActions(wrap, "assistant", assistantId, accumulated);
      }
      appendGenerationMetrics(wrap, evt?.metrics);
      refreshSession(sidAtSend);
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
      setAppStatus("回答を生成しました。", "success");
      if (serverLoaded) chatInput.focus();
    },
    onError: err => {
      wrap.classList.remove("loading");
      wrap.classList.add("error");
      bubble.textContent = `エラー: ${err}`;
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
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
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    })
  });
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !serverLoaded || streaming || activeSessionId === null) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  streaming = true;
  setInputEnabled(false);
  setAppStatus("回答を生成しています...", "active");

  chatHistory.push({ role: "user", content: text });
  const userWrap = appendBubble("user", text);

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
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let accumulated = "";
  const sidAtSend = activeSessionId;

  await streamChat(sidAtSend, chatHistory, {
    endpoint: "/chat/agent-stream",
    onToken: chunk => {
      wrap.classList.remove("loading");
      accumulated += chunk;
      setMessageBodyContent(bubble, "assistant", accumulated);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    },
    onDone: evt => {
      wrap.classList.remove("loading");
      const userMessageId = evt?.user_message?.id ?? null;
      const assistantId = evt?.message?.id ?? null;
      if (userMessageId) {
        const userMessage = chatHistory[chatHistory.length - 1];
        userMessage.id = userMessageId;
        userWrap.dataset.messageId = userMessageId;
        appendMessageActions(userWrap, "user", userMessageId, text);
      }
      meta.textContent = formatMessageMeta("assistant", evt?.message?.created_at || Date.now());
      chatHistory.push({ id: assistantId, role: "assistant", content: accumulated });
      if (assistantId) {
        wrap.dataset.messageId = assistantId;
        appendMessageActions(wrap, "assistant", assistantId, accumulated);
      }
      appendGenerationMetrics(wrap, evt?.metrics);
      // Refresh session title in sidebar (auto-title was applied server-side)
      refreshSession(sidAtSend);
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
      setAppStatus("回答を生成しました。", "success");
      if (serverLoaded) chatInput.focus();
    },
    onError: err => {
      chatHistory.pop();
      wrap.classList.remove("loading");
      wrap.classList.add("error");
      bubble.textContent = `エラー: ${err}`;
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
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
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    })
  });
}

async function refreshSession(sessionId) {
  for (const ws of workspaces) {
    const idx = ws.sessions.findIndex(s => s.id === sessionId);
    if (idx !== -1) {
      const updated = await api("GET", `/workspaces/${ws.id}/sessions`);
      ws.sessions = updated;
      renderTree();
      break;
    }
  }
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
      setInputEnabled(false);
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
chatNewSessionBtn.addEventListener("click", newSessionInActiveWs);
chatNewWsBtn.addEventListener("click", createWorkspace);
chatSendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});

// ── Init ──────────────────────────────────────────────────
loadExpandedDocumentSections();
refreshModelStatus().catch(() => {});
initChatSidebarResize();
loadWorkspaces();

// standard の自動起動（バックエンド起動後にバックグラウンドで走る）を拾うため、
// ストリーミング中を除いて定期的に役割ステータスを更新する。
setInterval(() => {
  if (!streaming && !loadingModel) refreshModelStatus().catch(() => {});
}, 10000);
