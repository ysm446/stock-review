const API = "http://127.0.0.1:8001";

// ── HTTP helpers ─────────────────────────────────────────
async function api(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}${text ? ": " + text : ""}`);
  }
  return res.json();
}

async function streamChat(sessionId, messages, onToken, onDone, onError) {
  let res;
  try {
    res = await fetch(`${API}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, messages }),
    });
  } catch (e) {
    onError(e.message);
    return;
  }
  if (!res.ok) {
    onError(`HTTP ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (!payload) continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "token") onToken(evt.content);
          else if (evt.type === "done") onDone(evt);
          else if (evt.type === "error") onError(evt.message);
        } catch (_) {}
      }
    }
  }
  if (buf.trim()) {
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "token") onToken(evt.content);
        else if (evt.type === "done") onDone(evt);
        else if (evt.type === "error") onError(evt.message);
      } catch (_) {}
    }
  }
}

// ── DOM refs ─────────────────────────────────────────────
const chatModelBar        = document.getElementById("chat-model-bar");
const chatModelIndicator  = document.getElementById("chat-model-indicator");
const chatModelNameEl     = document.getElementById("chat-model-name");
const chatMessages        = document.getElementById("chat-messages");
const chatInput           = document.getElementById("chat-input");
const chatSendButton      = document.getElementById("chat-send");
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
let chatHistory      = [];
let expandedWsIds    = new Set();
let serverLoaded     = false;
let loadingModel     = false;
let streaming        = false;
let currentModelName = "";

// ── Helpers ──────────────────────────────────────────────
function setModelStatus(state, label) {
  chatModelIndicator.className = `chat-model-indicator${state ? " " + state : ""}`;
  chatModelNameEl.textContent = label;
}

function setInputEnabled(on) {
  chatInput.disabled = !on;
  chatSendButton.disabled = !on;
}

async function refreshModelStatus() {
  const status = await api("GET", "/model/status");
  serverLoaded = Boolean(status.loaded);
  currentModelName = serverLoaded ? (status.model_name || "") : "";

  if (serverLoaded) {
    setModelStatus("is-loaded", currentModelName || "読み込み済み");
    if (activeSessionId !== null) setInputEnabled(true);
  } else {
    setModelStatus("", "モデルを選択");
    setInputEnabled(false);
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

// ── Server readiness ──────────────────────────────────────
async function waitForServer(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API}/health`);
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
    }))
  );
  if (workspaces.length > 0) expandedWsIds.add(workspaces[0].id);
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
  actions.appendChild(makeActionBtn("×", "削除", () => deleteWorkspace(ws.id)));

  header.append(toggle, label, actions);
  header.addEventListener("click", () => toggleWs(ws.id));
  section.appendChild(header);

  // Sessions
  if (isExpanded) {
    for (const sess of ws.sessions) {
      section.appendChild(buildSessionItem(sess));
    }
  }
  return section;
}

function buildSessionItem(sess) {
  const item = document.createElement("div");
  item.className = `chat-session-item${sess.id === activeSessionId ? " is-active" : ""}`;
  item.dataset.sessionId = sess.id;

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
  actions.appendChild(makeActionBtn("×", "削除", e => { e.stopPropagation(); deleteSession(sess.id); }));

  item.append(content, actions);
  item.addEventListener("click", () => selectSession(sess.id));
  return item;
}

function makeActionBtn(text, title, handler) {
  const btn = document.createElement("button");
  btn.className = "chat-tree-action-btn";
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener("click", e => { e.stopPropagation(); handler(e); });
  return btn;
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

async function createWorkspace() {
  const ws = await api("POST", "/workspaces", { name: "新しいワークスペース" });
  ws.sessions = [];
  workspaces.push(ws);
  expandedWsIds.add(ws.id);
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
  if (activeSessionId) {
    const still = workspaces.flatMap(w => w.sessions).find(s => s.id === activeSessionId);
    if (!still) { activeSessionId = null; chatHistory = []; clearMessages("会話を選択してください"); setInputEnabled(false); }
  }
  renderTree();
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
  chatHistory = [];
  clearMessages();

  const msgs = await api("GET", `/sessions/${id}/messages`);
  for (const m of msgs) {
    chatHistory.push({ role: m.role, content: m.content });
    appendBubble(m.role, m.content, m.created_at);
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
function appendBubble(role, content, createdAt = Date.now()) {
  chatMessages.querySelectorAll(".chat-empty-hint").forEach(el => el.remove());
  const wrap = document.createElement("div");
  wrap.className = `chat-message ${role}`;
  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = formatMessageMeta(role, createdAt);
  const body = document.createElement("div");
  body.className = role === "user" ? "chat-message-bubble" : "chat-message-text";
  body.textContent = content;
  wrap.append(meta, body);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrap;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !serverLoaded || streaming || activeSessionId === null) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  streaming = true;
  setInputEnabled(false);

  chatHistory.push({ role: "user", content: text });
  appendBubble("user", text);

  const wrap = document.createElement("div");
  wrap.className = "chat-message assistant loading";
  const meta = document.createElement("div");
  meta.className = "chat-message-meta";
  meta.textContent = `アシスタント${currentModelName ? `（${currentModelName}）` : ""} 生成中`;
  const bubble = document.createElement("div");
  bubble.className = "chat-message-text";
  wrap.append(meta, bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let accumulated = "";
  const sidAtSend = activeSessionId;

  await streamChat(
    sidAtSend,
    chatHistory,
    chunk => {
      wrap.classList.remove("loading");
      accumulated += chunk;
      bubble.textContent = accumulated;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    },
    evt => {
      wrap.classList.remove("loading");
      meta.textContent = formatMessageMeta("assistant", evt?.message?.created_at || Date.now());
      chatHistory.push({ role: "assistant", content: accumulated });
      // Refresh session title in sidebar (auto-title was applied server-side)
      refreshSession(sidAtSend);
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
      if (serverLoaded) chatInput.focus();
    },
    err => {
      chatHistory.pop();
      wrap.classList.remove("loading");
      wrap.classList.add("error");
      bubble.textContent = `エラー: ${err}`;
      streaming = false;
      setInputEnabled(serverLoaded && activeSessionId !== null);
    }
  );
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

// ── Model picker ──────────────────────────────────────────
async function openModelPicker() {
  if (loadingModel) return;
  chatModelList.innerHTML = "";
  chatModelModalBackdrop.classList.remove("is-hidden");

  let models;
  let status;
  try {
    models = await api("GET", "/models");
    status = await refreshModelStatus();
  } catch (err) {
    chatModelList.innerHTML = `<p style="padding:16px;color:var(--muted)">取得失敗: ${err.message}</p>`;
    return;
  }

  if (!models.length) {
    chatModelList.innerHTML = '<p style="padding:16px;color:var(--muted)">models/ に GGUF ファイルが見つかりません</p>';
    return;
  }

  models.forEach(({ name, path, relative_path }) => {
    const btn = document.createElement("button");
    btn.className = `chat-model-item${path === status.model_path ? " is-active" : ""}`;
    btn.type = "button";
    btn.innerHTML = `<div>
      <div class="chat-model-item-name">${name}</div>
      <div class="chat-model-item-path">${relative_path}</div>
    </div>`;
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
    await api("POST", "/model/load", { model_path: modelPath });
    serverLoaded = true;
    currentModelName = displayName;
    setModelStatus("is-loaded", displayName);
    if (activeSessionId !== null) setInputEnabled(true);
  } catch (err) {
    currentModelName = "";
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
loadWorkspaces();
