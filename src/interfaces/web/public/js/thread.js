import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";

const thread = document.getElementById("thread");

let handlers = { onEditLast: () => {}, onRegenerateLast: () => {} };

export function initThread(injectedHandlers) {
  handlers = injectedHandlers;
}

export function scrollToEnd() {
  thread.scrollTop = thread.scrollHeight;
}

export function clearThread() {
  thread.innerHTML = "";
}

export function addSystemNote(text, isError = false) {
  const el = document.createElement("div");
  el.className = "system-note" + (isError ? " error" : "");
  el.textContent = text;
  thread.appendChild(el);
  scrollToEnd();
  return el;
}

function makeActionBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1200);
  } catch {
    addSystemNote("[ultron] clipboard access was denied by the browser.", true);
  }
}

function toggleRaw(body) {
  const showingRaw = body.classList.toggle("raw");
  body.innerHTML = showingRaw ? "" : renderMarkdown(body.dataset.raw ?? "");
  if (showingRaw) body.textContent = body.dataset.raw ?? "";
  updateTurnActions();
}

// Re-derives which turn is "the last user turn" / "the last assistant turn"
// on every mutation instead of tracking it incrementally — the backend's
// edit/regenerate only ever act on the tail of the thread (see
// prepareEdit/prepareRetry in graph.ts), so those actions only make sense
// there, and a full rescan is simpler than keeping a pointer in sync
// through streaming, retries and history loads.
export function updateTurnActions() {
  const turns = [...thread.querySelectorAll(".turn")];
  const lastUser = [...turns].reverse().find((t) => t.classList.contains("user"));
  const lastAssistant = [...turns].reverse().find((t) => t.classList.contains("assistant"));

  for (const turn of turns) {
    const actions = turn.querySelector(".turn-actions");
    const body = turn.querySelector(".body");
    if (!actions || !body) continue;
    actions.innerHTML = "";

    if (turn.classList.contains("user")) {
      actions.appendChild(makeActionBtn("Copy", (e) => copyToClipboard(body.textContent, e.currentTarget)));
      if (turn === lastUser && !state.generating) {
        actions.appendChild(makeActionBtn("Edit", () => handlers.onEditLast()));
      }
    } else {
      actions.appendChild(makeActionBtn("Copy", (e) => copyToClipboard(body.dataset.raw ?? body.textContent, e.currentTarget)));
      if (body.dataset.raw) {
        actions.appendChild(makeActionBtn(body.classList.contains("raw") ? "Rendered" : "Raw", () => toggleRaw(body)));
      }
      if (turn === lastAssistant && !state.generating) {
        actions.appendChild(makeActionBtn("Regenerate", () => handlers.onRegenerateLast()));
      }
    }
  }
}

// Regenerate/edit act on the backend's checkpoint state (prepareRetry /
// prepareEdit in graph.ts), which drops messages but has no idea what's on
// screen. These mirror that on the DOM side before a fresh stream starts,
// so the old reply/tool blocks don't linger above the new one.
function lastUserTurnEl() {
  return [...thread.querySelectorAll(".turn.user")].at(-1);
}

export function truncateAfterLastUserTurn() {
  const anchor = lastUserTurnEl();
  if (!anchor) return;
  while (anchor.nextElementSibling) anchor.nextElementSibling.remove();
  updateTurnActions();
}

export function truncateFromLastUserTurn() {
  const anchor = lastUserTurnEl();
  if (!anchor) return;
  while (thread.lastElementChild && thread.lastElementChild !== anchor.previousElementSibling) {
    thread.lastElementChild.remove();
  }
  updateTurnActions();
}

export function addTurn(role) {
  const turn = document.createElement("div");
  turn.className = `turn ${role}`;

  const head = document.createElement("div");
  head.className = "turn-head";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "user" ? "you" : "ultron";
  const actions = document.createElement("div");
  actions.className = "turn-actions";
  head.append(label, actions);

  const body = document.createElement("div");
  body.className = "body";

  turn.append(head, body);
  thread.appendChild(turn);
  scrollToEnd();
  updateTurnActions();
  return body;
}

export function addMetaLine(text) {
  const el = document.createElement("div");
  el.className = "meta-line";
  el.textContent = text;
  thread.appendChild(el);
  scrollToEnd();
}

// Renders toolsNode's pending approval batch (see graph.ts's interrupt()
// call) and resolves once the user picks Approve/Deny — every pending call
// in the batch gets the same decision, since the UI offers one choice for
// the whole batch rather than a per-call checklist.
export function addApprovalBlock(calls) {
  const wrap = document.createElement("div");
  wrap.className = "approval-block";

  const header = document.createElement("div");
  header.className = "approval-header";
  header.textContent = `Approval required · ${calls.length} tool call${calls.length > 1 ? "s" : ""}`;

  const list = document.createElement("div");
  list.className = "approval-list";
  for (const call of calls) {
    const row = document.createElement("div");
    row.className = "approval-row";
    const scope = state.toolScopes[call.name] ?? "read";
    const badge = document.createElement("span");
    badge.className = `tool-badge scope-badge-${scope}`;
    badge.textContent = scope;
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = call.name;
    const args = document.createElement("span");
    args.className = "approval-args";
    args.textContent = JSON.stringify(call.args);
    row.append(badge, name, args);
    list.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approveBtn = makeActionBtn(`Approve${calls.length > 1 ? " all" : ""}`, () => settle(true));
  approveBtn.className = "approve";
  const denyBtn = makeActionBtn(`Deny${calls.length > 1 ? " all" : ""}`, () => settle(false));
  denyBtn.className = "deny";
  actions.append(approveBtn, denyBtn);

  wrap.append(header, list, actions);
  thread.appendChild(wrap);
  scrollToEnd();

  let settle;
  return new Promise((resolve) => {
    settle = (approved) => {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      wrap.classList.add(approved ? "approved" : "denied");
      header.textContent = approved ? "Approved" : "Denied";
      const decisions = {};
      for (const call of calls) decisions[call.id] = approved;
      resolve(decisions);
    };
  });
}

export function addToolBlock(name, summary) {
  const scope = state.toolScopes[name] ?? "read";
  const details = document.createElement("details");
  details.className = `tool-block scope-${scope}`;
  const s = document.createElement("summary");
  s.innerHTML =
    `<span class="tool-badge">${scope}</span>` +
    `<span class="tool-name">${name}</span>` +
    `<span class="tool-summary"></span>`;
  s.querySelector(".tool-summary").textContent = summary;
  const pre = document.createElement("pre");
  pre.textContent = "…";
  details.append(s, pre);
  thread.appendChild(details);
  scrollToEnd();
  return pre;
}
