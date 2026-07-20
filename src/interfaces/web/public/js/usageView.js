// "Tokens" dashboard — every LLM call ULTRON has made (see
// src/core/memory/usage.ts's usage_log, written by recordUsage at every
// call site: the main chat turn on all three interfaces, and the cheap
// separate calls in narrator.ts/goalJudge.ts/userModelExtractor.ts/
// visionAnalyzer.ts). Same swapped-in-view pattern as healthView.js, not a
// separate page, so the sidebar/header stay put.
import { api } from "./api.js";

const thread = document.getElementById("thread");
const footer = document.querySelector("footer");
const view = document.getElementById("usage-view");
const navBtn = document.getElementById("usage-nav-btn");
const activeChatTitle = document.getElementById("active-chat-title");
// Not imported from healthView.js to avoid a circular import (healthView
// would need the mirror image of this to close the usage view) — both
// views instead reach into each other's DOM directly to stay mutually
// exclusive, same trick used for the health-view/#thread swap itself.
const otherView = document.getElementById("health-view");
const otherNavBtn = document.getElementById("health-nav-btn");

const KIND_LABELS = {
  chat: "Chat turn",
  narrator: "Narrator",
  goal_judge: "Goal judge",
  user_model: "Passive memory",
  vision: "Vision (photo)",
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== undefined) node.append(child);
  return node;
}

function text(s) {
  return document.createTextNode(s);
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function section(title, children) {
  return el("section", { class: "health-section" }, [el("h3", { class: "health-section-title" }, [text(title)]), ...children]);
}

function card(title, children, extraClass = "") {
  return el("div", { class: `card${extraClass ? ` ${extraClass}` : ""}` }, [el("h2", {}, [text(title)]), ...children]);
}

function heroTile(label, big, sub, extraClass = "") {
  return el("div", { class: `hero-tile${extraClass ? ` ${extraClass}` : ""}` }, [
    el("div", { class: "hero-label" }, [text(label)]),
    el("div", { class: "stat-big" }, [text(big)]),
    sub ? el("div", { class: "stat-sub" }, [text(sub)]) : undefined,
  ].filter((n) => n !== undefined));
}

function fmtInt(n) {
  return n.toLocaleString();
}

function fmtCost(n) {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Day-by-day request/token volume — a simple stacked bar (input vs output
// tokens) over the selected range.
function volumeChart(byDay) {
  const width = 600;
  const height = 110;
  if (!byDay.length) return svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
  const totals = byDay.map((d) => d.inputTokens + d.outputTokens);
  const max = Math.max(1, ...totals);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const barWidth = width / byDay.length;
  byDay.forEach((d, i) => {
    const inH = (d.inputTokens / max) * height;
    const outH = (d.outputTokens / max) * height;
    const x = i * barWidth + barWidth * 0.15;
    const w = barWidth * 0.7;
    svg.append(svgEl("rect", { x, y: height - inH - outH, width: w, height: outH, fill: "var(--accent)", rx: 2 }));
    svg.append(svgEl("rect", { x, y: height - inH, width: w, height: inH, fill: "var(--text-dimmer)", rx: 2 }));
  });
  return svg;
}

// A breakdown table (provider / model / kind) — rows sorted by total
// tokens descending (already sorted server-side), with a lightweight
// proportional bar so the biggest consumer is obvious at a glance.
function breakdownTable(rows, keyLabel) {
  if (!rows.length) return el("div", { class: "empty-hint" }, [text("No data yet.")]);
  const maxTokens = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  const table = el("div", { class: "usage-table" });
  table.append(
    el("div", { class: "usage-table-row usage-table-head" }, [
      el("span", {}, [text(keyLabel)]),
      el("span", {}, [text("Requests")]),
      el("span", {}, [text("Tokens")]),
      el("span", {}, [text("Cost")]),
    ]),
  );
  for (const row of rows) {
    const tokens = row.inputTokens + row.outputTokens;
    const barPct = Math.round((tokens / maxTokens) * 100);
    table.append(
      el("div", { class: "usage-table-row" }, [
        el("span", { class: "usage-table-key" }, [
          text(KIND_LABELS[row.key] ?? row.key),
          el("span", { class: "usage-table-bar", style: `width:${barPct}%` }),
        ]),
        el("span", {}, [text(fmtInt(row.requests))]),
        el("span", {}, [text(`${fmtInt(tokens)} (${fmtInt(row.inputTokens)} in / ${fmtInt(row.outputTokens)} out)`)]),
        el("span", {}, [text(fmtCost(row.costUsd))]),
      ]),
    );
  }
  return table;
}

function recentTable(recent) {
  if (!recent.length) return el("div", { class: "empty-hint" }, [text("No requests logged yet.")]);
  const table = el("div", { class: "usage-table usage-table-recent" });
  table.append(
    el("div", { class: "usage-table-row usage-table-head" }, [
      el("span", {}, [text("When")]),
      el("span", {}, [text("Provider / model")]),
      el("span", {}, [text("Kind")]),
      el("span", {}, [text("Tokens")]),
      el("span", {}, [text("Time")]),
      el("span", {}, [text("Cost")]),
    ]),
  );
  for (const r of recent) {
    table.append(
      el("div", { class: "usage-table-row" }, [
        el("span", { class: "dim" }, [text(new Date(r.createdAt).toLocaleString())]),
        el("span", { class: "usage-table-model" }, [text(`${r.provider} / ${r.model}`)]),
        el("span", {}, [text(KIND_LABELS[r.kind] ?? r.kind)]),
        el("span", {}, [text(`${fmtInt(r.inputTokens)} in / ${fmtInt(r.outputTokens)} out`)]),
        el("span", {}, [text(fmtDuration(r.elapsedMs))]),
        el("span", {}, [text(fmtCost(r.costUsd))]),
      ]),
    );
  }
  return table;
}

let currentRangeDays = 30;

async function render() {
  let data;
  try {
    data = await api.usageSummary(currentRangeDays);
  } catch {
    view.innerHTML = "";
    view.append(el("div", { class: "empty-hint" }, [text("Could not load usage data.")]));
    return;
  }

  view.innerHTML = "";
  const backRow = el("div", { class: "health-back-row" }, [
    (() => {
      const btn = el("button", { class: "rail-btn", type: "button" }, [text("← Back to chat")]);
      btn.addEventListener("click", closeUsageView);
      return btn;
    })(),
  ]);
  const rangePicker = el("div", { class: "usage-range-picker" });
  for (const { label, days } of [{ label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "90d", days: 90 }, { label: "All time", days: 0 }]) {
    const btn = el("button", { class: `rail-btn${currentRangeDays === days ? " active" : ""}`, type: "button" }, [text(label)]);
    btn.addEventListener("click", () => {
      currentRangeDays = days;
      render();
    });
    rangePicker.append(btn);
  }
  view.append(el("div", { class: "usage-header-row" }, [backRow, rangePicker]));

  if (!data.hasData) {
    view.append(el("div", { class: "empty-hint" }, [text("No requests logged yet — send a message to start tracking.")]));
    return;
  }

  const { totals, byProvider, byModel, byKind, byDay, recent } = data;
  const avgTokens = totals.requests ? Math.round((totals.inputTokens + totals.outputTokens) / totals.requests) : 0;

  const heroRow = el("div", { class: "hero-row" });
  heroRow.append(heroTile("Requests", fmtInt(totals.requests), currentRangeDays ? `last ${currentRangeDays} day(s)` : "all time", "hero-accent"));
  heroRow.append(heroTile("Total tokens", fmtInt(totals.inputTokens + totals.outputTokens), `${fmtInt(totals.inputTokens)} in / ${fmtInt(totals.outputTokens)} out`, "hero-link"));
  heroRow.append(heroTile("Estimated cost", fmtCost(totals.costUsd), "estimate, not a billed figure", "hero-warn"));
  heroRow.append(heroTile("Avg per request", fmtInt(avgTokens), "tokens", "hero-good"));
  view.append(section("Overview", [heroRow, card("Daily volume — input (dim) / output (accent)", [volumeChart(byDay)], "chart-card wide")]));

  view.append(
    section("By provider & model", [
      el("div", { class: "chart-grid" }, [
        card("By provider", [breakdownTable(byProvider, "Provider")]),
        card("By model", [breakdownTable(byModel, "Model")]),
        card("By call kind", [breakdownTable(byKind, "Kind")]),
      ]),
    ]),
  );

  view.append(section("Recent requests", [card(`Last ${recent.length} request(s)`, [recentTable(recent)])]));
}

export function openUsageView() {
  otherView.hidden = true;
  otherNavBtn.classList.remove("active");
  thread.hidden = true;
  footer.hidden = true;
  view.hidden = false;
  navBtn.classList.add("active");
  activeChatTitle.textContent = "Tokens";
  render();
}

export function closeUsageView() {
  if (view.hidden) return;
  thread.hidden = false;
  footer.hidden = false;
  view.hidden = true;
  navBtn.classList.remove("active");
}

export function isUsageViewOpen() {
  return !view.hidden;
}

export function initUsageView() {
  navBtn.addEventListener("click", () => (isUsageViewOpen() ? closeUsageView() : openUsageView()));
}
