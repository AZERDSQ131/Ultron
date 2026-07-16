const thread = document.getElementById("thread");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const thinkingSelect = document.getElementById("thinking-mode");
const modelLabel = document.getElementById("model-label");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");

let generating = false;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Small inline-markdown pass: **bold**, *italic*, `code`. Kept intentionally
// minimal to match the terminal's own supported subset.
function renderInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return html;
}

function scrollToEnd() {
  thread.scrollTop = thread.scrollHeight;
}

function addSystemNote(text, isError = false) {
  const el = document.createElement("div");
  el.className = "system-note" + (isError ? " error" : "");
  el.textContent = text;
  thread.appendChild(el);
  scrollToEnd();
  return el;
}

function addTurn(role) {
  const turn = document.createElement("div");
  turn.className = `turn ${role}`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "user" ? "you" : "ultron";
  const body = document.createElement("div");
  body.className = "body";
  turn.appendChild(label);
  turn.appendChild(body);
  thread.appendChild(turn);
  scrollToEnd();
  return body;
}

function addToolBlock(name, summary) {
  const details = document.createElement("details");
  details.className = "tool-block";
  const s = document.createElement("summary");
  s.innerHTML = `<span class="tool-name">[${escapeHtml(name)}]</span> ${escapeHtml(summary)}`;
  const pre = document.createElement("pre");
  pre.textContent = "…";
  details.appendChild(s);
  details.appendChild(pre);
  thread.appendChild(details);
  scrollToEnd();
  return pre;
}

function setGenerating(state) {
  generating = state;
  sendBtn.hidden = state;
  stopBtn.hidden = !state;
  input.disabled = state;
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autoGrow);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

function updateContextGauge(usedTokens, maxTokens) {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  contextFill.style.width = `${Math.round(ratio * 100)}%`;
  contextFill.classList.toggle("warn", ratio >= 0.5 && ratio < 0.8);
  contextFill.classList.toggle("hot", ratio >= 0.8);
  const maxLabel = maxTokens >= 1_000_000 ? `${maxTokens / 1_000_000}M` : `${Math.round(maxTokens / 1000)}k`;
  contextLabel.textContent = `${usedTokens.toLocaleString()} / ${maxLabel} tokens`;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    modelLabel.textContent = data.model;
    updateContextGauge(data.contextTokens, data.maxTokens);
  } catch {
    modelLabel.textContent = "offline";
  }
}

async function streamTurn(body) {
  setGenerating(true);
  let assistantBody = null;
  let assistantText = "";
  let cursorEl = null;

  const finishAssistant = () => {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
  };

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "request failed" }));
      addSystemNote(`[ultron] ${err.error ?? "request failed"}`, true);
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
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const lines = raw.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice("event: ".length);
        const data = JSON.parse(dataLine.slice("data: ".length));

        if (eventName === "text") {
          if (!assistantBody) {
            assistantBody = addTurn("assistant");
            cursorEl = document.createElement("span");
            cursorEl.className = "cursor";
          }
          assistantText += data.delta;
          assistantBody.innerHTML = renderInline(assistantText);
          if (cursorEl) assistantBody.appendChild(cursorEl);
          scrollToEnd();
        } else if (eventName === "tool_call") {
          finishAssistant();
          const pre = addToolBlock(data.name, data.summary);
          pre.dataset.name = data.name;
        } else if (eventName === "tool_result") {
          const blocks = [...document.querySelectorAll(".tool-block pre")];
          const match = [...blocks].reverse().find((p) => p.dataset.name === data.name && p.textContent === "…");
          if (match) match.textContent = data.content;
        } else if (eventName === "done") {
          finishAssistant();
          updateContextGauge(data.contextTokens, data.maxTokens);
        } else if (eventName === "aborted") {
          finishAssistant();
          addSystemNote("[ultron] generation stopped.");
        } else if (eventName === "error") {
          finishAssistant();
          addSystemNote(`[ultron] error: ${data.message}`, true);
        }
      }
    }
  } catch (err) {
    addSystemNote(`[ultron] connection error: ${err.message}`, true);
  } finally {
    finishAssistant();
    setGenerating(false);
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (generating) return;
  const text = input.value.trim();
  if (!text) return;
  addTurn("user").textContent = text;
  input.value = "";
  autoGrow();
  streamTurn({ text, thinking: thinkingSelect.value });
});

stopBtn.addEventListener("click", async () => {
  await fetch("/api/stop", { method: "POST" });
});

loadStatus();
input.focus();
