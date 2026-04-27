const chatModelBar = document.getElementById("chat-model-bar");
const chatModelIndicator = document.getElementById("chat-model-indicator");
const chatModelName = document.getElementById("chat-model-name");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendButton = document.getElementById("chat-send");
const chatModelModalBackdrop = document.getElementById("chat-model-modal-backdrop");
const chatModelList = document.getElementById("chat-model-list");
const closeChatModelModal = document.getElementById("close-chat-model-modal");

let chatHistory = [];
let serverLoaded = false;
let loadingModel = false;
let currentModelName = "";

function setStatus(state, label) {
  chatModelIndicator.className = `chat-model-indicator${state ? " " + state : ""}`;
  chatModelName.textContent = label;
}

async function openModelPicker() {
  if (loadingModel) return;
  chatModelList.innerHTML = "";
  chatModelModalBackdrop.classList.remove("is-hidden");

  let models;
  try {
    models = await window.stockReviewApi.listChatModels();
  } catch (err) {
    chatModelList.innerHTML = `<p style="padding:16px;color:var(--muted)">モデル一覧の取得に失敗: ${err.message}</p>`;
    return;
  }

  if (!models.length) {
    chatModelList.innerHTML = '<p style="padding:16px;color:var(--muted)">models/ フォルダに GGUF ファイルが見つかりません</p>';
    return;
  }

  models.forEach(({ name, path, relativePath }) => {
    const btn = document.createElement("button");
    btn.className = `chat-model-item${path === currentModelName ? " is-active" : ""}`;
    btn.innerHTML = `<div><div class="chat-model-item-name">${name}</div><div class="chat-model-item-path">${relativePath}</div></div>`;
    btn.addEventListener("click", () => loadModel(path, name));
    chatModelList.appendChild(btn);
  });
}

function closeModelPicker() {
  chatModelModalBackdrop.classList.add("is-hidden");
}

async function loadModel(modelPath, modelDisplayName) {
  closeModelPicker();
  loadingModel = true;
  serverLoaded = false;
  chatInput.disabled = true;
  chatSendButton.disabled = true;
  setStatus("is-loading", `読み込み中: ${modelDisplayName}`);

  try {
    await window.stockReviewApi.loadChatModel(modelPath);
    currentModelName = modelPath;
    serverLoaded = true;
    chatHistory = [];
    chatMessages.innerHTML = "";
    setStatus("is-loaded", modelDisplayName);
    chatInput.disabled = false;
    chatSendButton.disabled = false;
    chatInput.focus();
  } catch (err) {
    setStatus("", `読み込み失敗 — 再選択してください`);
  } finally {
    loadingModel = false;
  }
}

function appendBubble(role, content) {
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
  if (!text || !serverLoaded || loadingModel) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  chatSendButton.disabled = true;
  chatInput.disabled = true;

  chatHistory.push({ role: "user", content: text });
  appendBubble("user", text);

  const wrap = document.createElement("div");
  wrap.className = "chat-message assistant loading";
  const bubble = document.createElement("div");
  bubble.className = "chat-message-bubble";
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let accumulated = "";

  function onChunk(chunk) {
    wrap.classList.remove("loading");
    accumulated += chunk;
    bubble.textContent = accumulated;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function onDone() {
    chatHistory.push({ role: "assistant", content: accumulated });
    wrap.classList.remove("loading");
    window.stockReviewApi.offStreamListeners();
    chatSendButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }

  function onError(err) {
    chatHistory.pop();
    wrap.classList.remove("loading");
    wrap.classList.add("error");
    bubble.textContent = `エラー: ${err}`;
    window.stockReviewApi.offStreamListeners();
    chatSendButton.disabled = false;
    chatInput.disabled = false;
  }

  window.stockReviewApi.offStreamListeners();
  window.stockReviewApi.onStreamChunk(onChunk);
  window.stockReviewApi.onStreamDone(onDone);
  window.stockReviewApi.onStreamError(onError);

  try {
    await window.stockReviewApi.streamChat(chatHistory);
  } catch (_) {
    // handled via onStreamError event
  }
}

chatModelBar.addEventListener("click", openModelPicker);
closeChatModelModal.addEventListener("click", closeModelPicker);
chatModelModalBackdrop.addEventListener("click", e => {
  if (e.target === chatModelModalBackdrop) closeModelPicker();
});

chatSendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});
