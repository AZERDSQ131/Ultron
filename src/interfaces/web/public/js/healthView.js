// Health dashboard folded into the main app shell as a view — previously
// public/health.html was a fully separate page (own <body>, own script, not
// linked from index.html at all). Reuses the same GET /api/health-data/summary
// endpoint and the same hand-rolled SVG charts (see the removed health.js),
// just rendered into a container inside the SPA instead of a standalone
// document, so the sidebar/header/chat list stay put while it's open.
import { api } from "./api.js";

const thread = document.getElementById("thread");
const footer = document.querySelector("footer");
const view = document.getElementById("health-view");
const navBtn = document.getElementById("health-nav-btn");
const activeChatTitle = document.getElementById("active-chat-title");

const STAGE_COLORS = {
  awake: "var(--warn)",
  asleepREM: "var(--link)",
  asleepCore: "var(--accent-dim)",
  asleepDeep: "var(--good)",
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function scoreLineChart(days) {
  const width = 600;
  const height = 120;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const points = (key, color) => {
    const step = width / Math.max(1, days.length - 1);
    const coords = days.map((d, i) => `${i * step},${height - (d[key] / 100) * height}`).join(" ");
    return svgEl("polyline", { points: coords, fill: "none", stroke: color, "stroke-width": "2" });
  };
  svg.append(points("recovery", "var(--good)"));
  svg.append(points("activity", "var(--accent)"));
  return svg;
}

function sleepBarChart(days) {
  const width = 600;
  const height = 120;
  const maxHours = Math.max(8, ...days.map((d) => (d.sleepDurationSec ?? 0) / 3600));
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const barWidth = width / days.length;
  days.forEach((d, i) => {
    if (d.sleepDurationSec === null) return;
    const hours = d.sleepDurationSec / 3600;
    const barHeight = (hours / maxHours) * height;
    svg.append(
      svgEl("rect", {
        x: i * barWidth + barWidth * 0.15,
        y: height - barHeight,
        width: barWidth * 0.7,
        height: barHeight,
        fill: "var(--link)",
        rx: 2,
      }),
    );
  });
  return svg;
}

function sleepStageTimeline(rawJson) {
  try {
    const payload = JSON.parse(rawJson);
    const session = payload.sleep?.sessions?.[payload.sleep.sessions.length - 1];
    if (!session?.stages?.length) return undefined;
    const total = session.stages.reduce((sum, s) => sum + s.durationSec, 0);
    const width = 600;
    const height = 28;
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", style: "height: 28px" });
    let x = 0;
    for (const stage of session.stages) {
      const w = (stage.durationSec / total) * width;
      svg.append(svgEl("rect", { x, y: 0, width: w, height, fill: STAGE_COLORS[stage.stage] ?? "var(--text-dimmer)" }));
      x += w;
    }
    return svg;
  } catch {
    return undefined;
  }
}

function bioAgeGauge(bioAge) {
  const size = 100;
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  svg.append(svgEl("circle", { cx: size / 2, cy: size / 2, r: 40, fill: "none", stroke: "var(--line)", "stroke-width": "8" }));
  const label = el("div", { class: "stat-big" }, [document.createTextNode(bioAge.age)]);
  return el("div", { class: "gauge-wrap" }, [svg, label]);
}

function card(title, children) {
  return el("div", { class: "card" }, [el("h2", {}, [document.createTextNode(title)]), ...children]);
}

async function render() {
  let data;
  try {
    data = await api.healthSummary();
  } catch {
    view.innerHTML = "";
    view.append(el("div", { class: "empty-hint" }, [document.createTextNode("Could not load health data.")]));
    return;
  }

  view.innerHTML = "";
  const backRow = el("div", { class: "health-back-row" }, [
    (() => {
      const btn = el("button", { class: "rail-btn", type: "button" }, [document.createTextNode("← Back to chat")]);
      btn.addEventListener("click", closeHealthView);
      return btn;
    })(),
  ]);
  view.append(backRow);

  if (!data.hasData) {
    view.append(el("div", { class: "empty-hint" }, [document.createTextNode("No health data ingested yet.")]));
    return;
  }

  const grid = el("div", { class: "health-grid" });

  const latest = data.latestScores;
  const scoreCard = card(`${latest.date} — recovery`, [
    el("div", { class: "stat-big" }, [document.createTextNode(`${latest.recovery}/100`)]),
    el("div", { class: "stat-sub" }, [document.createTextNode(`activity ${latest.activity}/100`)]),
  ]);
  if (data.anomalies?.length) {
    scoreCard.append(el("div", { class: "anomaly-line" }, [document.createTextNode(`⚠ ${data.anomalies[0].message}`)]));
  }
  grid.append(scoreCard);

  if (data.bioAge) {
    grid.append(card("Biological age (wellness estimate)", [bioAgeGauge(data.bioAge)]));
  }

  grid.append(
    card("Sleep debt (7 days)", [
      el("div", { class: "stat-big" }, [document.createTextNode(`${data.sleepDebt.deficitHours.toFixed(1)}h`)]),
      el("div", { class: "stat-sub" }, [document.createTextNode(`across ${data.sleepDebt.daysCounted} recorded night(s)`)]),
    ]),
  );

  const recordsList = el("ul", { class: "records-list" });
  if (data.records.bestSleepNight) {
    recordsList.append(
      el("li", {}, [document.createTextNode("Best sleep: "), el("strong", {}, [document.createTextNode(`${(data.records.bestSleepNight.durationSec / 3600).toFixed(1)}h`)]), document.createTextNode(` (${data.records.bestSleepNight.date})`)]),
    );
  }
  if (data.records.lowestRestingHR) {
    recordsList.append(
      el("li", {}, [document.createTextNode("Lowest resting HR: "), el("strong", {}, [document.createTextNode(`${data.records.lowestRestingHR.value}`)]), document.createTextNode(` (${data.records.lowestRestingHR.date})`)]),
    );
  }
  recordsList.append(el("li", {}, [document.createTextNode(`Activity streak: `), el("strong", {}, [document.createTextNode(`${data.records.currentActivityStreakDays} day(s)`)])]));
  grid.append(card("Records", [recordsList]));

  grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Recovery (green) / Activity (red) — 30 days")]), scoreLineChart(data.days)]));
  grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Sleep duration — 30 days")]), sleepBarChart(data.days)]));

  const stageTimeline = sleepStageTimeline(data.latestRawJson);
  if (stageTimeline) {
    grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Last night's sleep stages")]), stageTimeline]));
  }

  view.append(grid);
}

export function openHealthView() {
  thread.hidden = true;
  footer.hidden = true;
  view.hidden = false;
  navBtn.classList.add("active");
  activeChatTitle.textContent = "Health";
  render();
}

export function closeHealthView() {
  if (view.hidden) return;
  thread.hidden = false;
  footer.hidden = false;
  view.hidden = true;
  navBtn.classList.remove("active");
}

export function isHealthViewOpen() {
  return !view.hidden;
}

export function initHealthView() {
  navBtn.addEventListener("click", () => (isHealthViewOpen() ? closeHealthView() : openHealthView()));
}
