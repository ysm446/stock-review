// ── DOM refs ────────────────────────────────────────────
const chatModelBar       = document.getElementById("chat-model-bar");
const chatModelIndicator = document.getElementById("chat-model-indicator");
const chatModelNameEl    = document.getElementById("chat-model-name");
const chatMessages       = document.getElementById("chat-messages");
const chatInput          = document.getElementById("chat-input");
const chatSendButton     = document.getElementById("chat-send");
const chatNewBtn         = document.getElementById("chat-new-btn");
const chatTree           = document.getElementById("chat-tree");
const chatEmptyHint      = document.getElementById("chat-empty-hint");
const chatModelModalBackdrop = document.getElementById("chat-model-modal-backdrop");
const chatModelList          = document.getElementById("chat-model-list");
const closeChatModelModal    = document.getElementById("close-chat-model-modal");

// ── State ───────────────────────────────────────────────
let conversations       = [];   // flat list from DB
let activeConvId        = null;
let chatHistory         = [];   // [{role, content}]
let expandedIds         = new Set();
let serverLoaded        = false;
let loadingModel        = false;
let currentModelPath    = "";
let streaming           = false;

// ── Helpers ─────────────────────────────────────────────
function setModelStatus(state, label) {
  chatModelIndicator.className = `chat-model-indicator${state ? " " + state : ""}`;
  chatModelNameEl.textContent = label;
}

function setInputEnabled(enabled) {
  chatInput.disabled = !enabled;
  chatSendButton.disabled = !enabled;
}

function hideEmptyHint() {
  if (chatEmptyHint) chatEmptyHint.remove();
}

// ── Conversation tree ────────────────────────────────────
function buildTree(list) {
  const map = new Map(list.map(c => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const item of map.values()) {
    if (item.parent_id) map.get(item.parent_id)?.children.push(item);
    else roots.push(item);
  }
  function sortBy(arr) {
    arr.sort((a, b) => b.updated_at - a.updated_at);
    arr.forEach(n => sortBy(n.children));
  }
  sortBy(roots);
  return roots;
}

function renderTree() {
  chatTree.innerHTML = "";
  const roots = buildTree(conversations);

  if (!roots.length) {
    chatTree.innerHTML = '<p class="chat-tree-empty">会話がありません</p>';
    return;
  }

  function renderNode(node, depth) {
    const hasChildren = node.children.length > 0;
    const isExpanded  = expandedIds.has(node.id);

    const item = document.createElement("div");
    item.className = `chat-tree-item${node.id === activeConvId ? " is-active" : ""}`;
    item.style.paddingLeft = `${10 + depth * 14}px`;
    item.dataset.id = String(node.id);

    // Expand/collapse toggle
    const toggle = document.createElement("button");
    toggle.className = "chat-tree-toggle";
    toggle.textContent = hasChildren ? (isExpanded ? "▾" : "▸") : "";
    toggle.addEventListener("click", e => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (expandedIds.has(node.id)) expandedIds.delete(node.id);
      else expandedIds.add(node.id);
      renderTree();
    });

    // Label
    const label = document.createElement("span");
    label.className = "chat-tree-item-label";
    label.textContent = node.title;

    // Action buttons (visible on hover)
    const actions = document.createElement("div");
    actions.className = "chat-tree-item-actions";

    const addBtn = makeActionBtn("+", "子会話を追加", e => {
      e.stopPropagation();
      createConversation(node.id);
    });
    const delBtn = makeActionBtn("×", "削除", e => {
      e.stopPropagation();
      deleteConversation(node.id);
    });
    actions.append(addBtn, delBtn);

    item.append(toggle, label, actions);

    // Click → select
    item.addEventListener("click", () => selectConversation(node.id));

    // Double-click label → rename
    label.addEventListener("dblclick", e => {
      e.stopPropagation();
      startInlineRename(node.id, label);
    });

    chatTree.appendChild(item);

    if (hasChildren && isExpanded) {
      node.children.forEach(child => renderNode(child, depth + 1));
    }
  }

  roots.forEach(n => renderNode(n, 0));
}

function makeActionBtn(text, title, handler) {
  const btn = document.createElement("button");
  btn.className = "chat-tree-action-btn";
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener("click", handler);
  return btn;
}

function startInlineRename(id, labelEl) {
  const input = document.createElement("input");
  input.className = "chat-tree-rename-input";
  input.value = labelEl.textContent;

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim() || labelEl.textContent;
    renameConversation(id, val);
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

// ── CRUD ─────────────────────────────────────────────────
async function loadConversations() {
  conversations = await window.stockReviewApi.loadConversations();
  renderTree();
}

async function createConversation(parentId = null) {
  const conv = await window.stockReviewApi.createConversation({ parentId });
  conversations.unshift(conv);
  if (parentId) expandedIds.add(parentId);
  renderTree();
  await selectConversation(conv.id);
}

async function renameConversation(id, title) {
  await window.stockReviewApi.renameConversation({ id, title });
  const conv = conversations.find(c => c.id === id);
  if (conv) conv.title = title;
  renderTree();
}

async function deleteConversation(id) {
  function descendants(nodeId) {
    const ids = [nodeId];
    conversations.filter(c => c.parent_id === nodeId).forEach(c => ids.push(...descendants(c.id)));
    return ids;
  }
  const toRemove = new Set(descendants(id));

  await window.stockReviewApi.deleteConversation(id);
  conversations = conversations.filter(c => !toRemove.has(c.id));

  if (activeConvId && toRemove.has(activeConvId)) {
    activeConvId = null;
    chatHistory = [];
    chatMessages.innerHTML = "";
    chatMessages.innerHTML = '<p class="chat-tree-empty" style="margin:auto;font-size:.88rem">会話を選択してください</p>';
    setInputEnabled(false);
  }
  renderTree();
}

async function selectConversation(id) {
  if (streaming) return;
  activeConvId = id;
  chatHistory = [];
  chatMessages.innerHTML = "";

  const msgs = await window.stockReviewApi.loadMessages(id);
  for (const m of msgs) {
    chatHistory.push({ role: m.role, content: m.content });
    appendBubble(m.role, m.content);
  }

  if (!msgs.length) {
    chatMessages.innerHTML = '<p class="chat-empty-hint" style="margin:auto">メッセージを入力してください</p>';
  }

  renderTree();
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (serverLoaded) setInputEnabled(true);
}

// ── Chat messaging ────────────────────────────────────────
function appendBubble(role, content) {
  // Remove placeholder hints
  chatMessages.querySelectorAll(".chat-empty-hint, .chat-tree-empty").forEach(el => el.remove());

  const wrap = document.createElement("div");
  wrap.className = `chat-message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-message-bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !serverLoaded || streaming || activeConvId === null) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  streaming = true;
  setInputEnabled(false);

  // Auto-title on first user message
  const conv = conversations.find(c => c.id === activeConvId);
  if (conv && conv.title === "新しい会話") {
    const autoTitle = text.slice(0, 28).trimEnd();
    renameConversation(activeConvId, autoTitle);
  }

  // Persist user message
  chatHistory.push({ role: "user", content: text });
  await window.stockReviewApi.appendMessage({ conversationId: activeConvId, role: "user", content: text });
  appendBubble("user", text);

  // Assistant placeholder
  const wrap = document.createElement("div");
  wrap.className = "chat-message assistant loading";
  const bubble = document.createElement("div");
  bubble.className = "chat-message-bubble";
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let accumulated = "";
  const convIdAtSend = activeConvId;

  function onChunk(chunk) {
    wrap.classList.remove("loading");
    accumulated += chunk;
    bubble.textContent = accumulated;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function onDone() {
    wrap.classList.remove("loading");
    chatHistory.push({ role: "assistant", content: accumulated });
    await window.stockReviewApi.appendMessage({ conversationId: convIdAtSend, role: "assistant", content: accumulated });
    // Refresh updated_at in local list
    const c = conversations.find(x => x.id === convIdAtSend);
    if (c) { c.updated_at = Date.now(); renderTree(); }
    window.stockReviewApi.offStreamListeners();
    streaming = false;
    setInputEnabled(serverLoaded && activeConvId !== null);
    if (serverLoaded) chatInput.focus();
  }

  function onError(err) {
    chatHistory.pop();
    wrap.classList.remove("loading");
    wrap.classList.add("error");
    bubble.textContent = `エラー: ${err}`;
    window.stockReviewApi.offStreamListeners();
    streaming = false;
    setInputEnabled(serverLoaded && activeConvId !== null);
  }

  window.stockReviewApi.offStreamListeners();
  window.stockReviewApi.onStreamChunk(onChunk);
  window.stockReviewApi.onStreamDone(onDone);
  window.stockReviewApi.onStreamError(onError);

  try {
    await window.stockReviewApi.streamChat(chatHistory);
  } catch (_) {}
}

// ── Model picker ──────────────────────────────────────────
async function openModelPicker() {
  if (loadingModel) return;
  chatModelList.innerHTML = "";
  chatModelModalBackdrop.classList.remove("is-hidden");

  let models;
  try {
    models = await window.stockReviewApi.listChatModels();
  } catch (err) {
    chatModelList.innerHTML = `<p style="padding:16px;color:var(--muted)">取得失敗: ${err.message}</p>`;
    return;
  }

  if (!models.length) {
    chatModelList.innerHTML = '<p style="padding:16px;color:var(--muted)">models/ に GGUF ファイルが見つかりません</p>';
    return;
  }

  models.forEach(({ name, path, relativePath }) => {
    const btn = document.createElement("button");
    btn.className = `chat-model-item${path === currentModelPath ? " is-active" : ""}`;
    btn.innerHTML = `<div><div class="chat-model-item-name">${name}</div><div class="chat-model-item-path">${relativePath}</div></div>`;
    btn.addEventListener("click", () => loadModel(path, name));
    chatModelList.appendChild(btn);
  });
}

function closeModelPicker() {
  chatModelModalBackdrop.classList.add("is-hidden");
}

async function loadModel(modelPath, displayName) {
  closeModelPicker();
  loadingModel = true;
  serverLoaded = false;
  setInputEnabled(false);
  setModelStatus("is-loading", `読み込み中: ${displayName}`);

  try {
    await window.stockReviewApi.loadChatModel(modelPath);
    currentModelPath = modelPath;
    serverLoaded = true;
    setModelStatus("is-loaded", displayName);
    if (activeConvId !== null) setInputEnabled(true);
  } catch (err) {
    setModelStatus("", "読み込み失敗 — 再選択してください");
  } finally {
    loadingModel = false;
  }
}

// ── Event listeners ───────────────────────────────────────
chatModelBar.addEventListener("click", openModelPicker);
closeChatModelModal.addEventListener("click", closeModelPicker);
chatModelModalBackdrop.addEventListener("click", e => {
  if (e.target === chatModelModalBackdrop) closeModelPicker();
});

chatNewBtn.addEventListener("click", () => createConversation(null));
chatSendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});

// ── Init ──────────────────────────────────────────────────
loadConversations();
