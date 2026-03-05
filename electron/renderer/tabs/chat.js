/* ── Chat tab ──────────────────────────────────────────────────── */
let _chatHistory = [];   // [{role, content}]

function init_chat() {
  document.getElementById("chat-send-btn").addEventListener("click", sendChat);
  document.getElementById("chat-clear-btn").addEventListener("click", clearChat);
  document.getElementById("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

function clearChat() {
  _chatHistory = [];
  document.getElementById("chat-messages").innerHTML = "";
}

function appendMessage(role, html, streaming = false) {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}${streaming ? " streaming" : ""}`;
  div.innerHTML = html;
  document.getElementById("chat-messages").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  return div;
}

function nl2br(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
             .replace(/\n/g, "<br>");
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const btn   = document.getElementById("chat-send-btn");
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = "";
  btn.disabled = true;

  appendMessage("user", nl2br(msg));

  // Add to history
  _chatHistory.push({ role: "user", content: msg });
  // Trim history
  if (_chatHistory.length > 40) _chatHistory = _chatHistory.slice(-40);

  const assistantDiv = appendMessage("assistant", "▋", true);

  try {
    await apiStream(
      "/api/chat/stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, history: _chatHistory.slice(0, -1) }),
      },
      (chunk) => {
        assistantDiv.innerHTML = nl2br(chunk) + "<span class='cursor'>▋</span>";
        assistantDiv.scrollIntoView({ behavior: "smooth", block: "end" });
      },
      (err) => {
        assistantDiv.innerHTML = `<span class="bad">エラー: ${err}</span>`;
        assistantDiv.classList.remove("streaming");
      }
    );
    // Remove cursor, finalize
    const finalText = assistantDiv.textContent.replace("▋", "").trim();
    assistantDiv.innerHTML = nl2br(finalText);
    assistantDiv.classList.remove("streaming");
    _chatHistory.push({ role: "assistant", content: finalText });
  } catch (e) {
    assistantDiv.innerHTML = `<span class="bad">エラー: ${e.message}</span>`;
    assistantDiv.classList.remove("streaming");
  }
  btn.disabled = false;
  input.focus();
}
