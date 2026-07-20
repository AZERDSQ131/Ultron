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
  return metricBarChart(days, (d) => (d.sleepDurationSec === null ? null : d.sleepDurationSec / 3600), "var(--link)", 8);
}

// Generic bar chart over `days` for any metric extracted by `valueOf`
// (returns null to skip a day) — sleep/steps/active-energy charts all
// share this instead of three near-identical copies.
function metricBarChart(days, valueOf, color, minMax = 1) {
  const width = 600;
  const height = 120;
  const values = days.map(valueOf).filter((v) => v !== null && v !== undefined);
  const maxValue = Math.max(minMax, ...values);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const barWidth = width / days.length;
  days.forEach((d, i) => {
    const value = valueOf(d);
    if (value === null || value === undefined) return;
    const barHeight = (value / maxValue) * height;
    svg.append(
      svgEl("rect", {
        x: i * barWidth + barWidth * 0.15,
        y: height - barHeight,
        width: barWidth * 0.7,
        height: barHeight,
        fill: color,
        rx: 2,
      }),
    );
  });
  return svg;
}

// Generic multi-series line chart — used for heart rate (resting vs
// walking) and HRV, alongside the existing recovery/activity chart.
function metricLineChart(days, series) {
  const width = 600;
  const height = 120;
  const allValues = series.flatMap(({ valueOf }) => days.map(valueOf).filter((v) => v !== null && v !== undefined));
  if (!allValues.length) return svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const step = width / Math.max(1, days.length - 1);
  for (const { valueOf, color } of series) {
    const coords = days
      .map((d, i) => {
        const v = valueOf(d);
        return v === null || v === undefined ? null : `${i * step},${height - ((v - min) / range) * height}`;
      })
      .filter((p) => p !== null)
      .join(" ");
    svg.append(svgEl("polyline", { points: coords, fill: "none", stroke: color, "stroke-width": "2" }));
  }
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

  const todayDay = data.days.find((d) => d.date === latest.date);
  if (todayDay) {
    const stat = (label, value, unit = "") =>
      value === null || value === undefined
        ? undefined
        : el("li", {}, [document.createTextNode(`${label}: `), el("strong", {}, [document.createTextNode(`${value}${unit}`)])]);
    const statsList = el(
      "ul",
      { class: "records-list" },
      [
        stat("Steps", todayDay.steps),
        stat("Distance", todayDay.distanceKm?.toFixed(2), " km"),
        stat("Active energy", todayDay.activeEnergyKcal?.toFixed(0), " kcal"),
        stat("Exercise", todayDay.exerciseMinutes, " min"),
        stat("Flights climbed", todayDay.flightsClimbed),
        stat("Workouts", todayDay.workoutCount),
        stat("Resting HR", todayDay.restingHR, " bpm"),
        stat("Walking HR", todayDay.walkingHR, " bpm"),
        stat("HRV", todayDay.hrvAvg?.toFixed(1), " ms"),
        stat("Respiratory rate", todayDay.respiratoryRateAvg?.toFixed(1), " brpm"),
        stat("Sleep", todayDay.sleepAsleepSec !== null && todayDay.sleepAsleepSec !== undefined ? (todayDay.sleepAsleepSec / 3600).toFixed(1) : undefined, "h asleep"),
      ].filter((n) => n !== undefined),
    );
    grid.append(card(`${todayDay.date} — today's metrics`, [statsList]));
  }

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
  grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Steps — 30 days")]), metricBarChart(data.days, (d) => d.steps, "var(--accent)")]));
  grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Active energy (kcal) — 30 days")]), metricBarChart(data.days, (d) => d.activeEnergyKcal, "var(--warn)")]));
  grid.append(
    el("div", { class: "card chart-card" }, [
      el("h2", {}, [document.createTextNode("Heart rate — resting (green) / walking (red) — 30 days")]),
      metricLineChart(data.days, [
        { valueOf: (d) => d.restingHR, color: "var(--good)" },
        { valueOf: (d) => d.walkingHR, color: "var(--accent)" },
      ]),
    ]),
  );
  grid.append(
    el("div", { class: "card chart-card" }, [
      el("h2", {}, [document.createTextNode("HRV (ms) — 30 days")]),
      metricLineChart(data.days, [{ valueOf: (d) => d.hrvAvg, color: "var(--link)" }]),
    ]),
  );

  const stageTimeline = sleepStageTimeline(data.latestRawJson);
  if (stageTimeline) {
    grid.append(el("div", { class: "card chart-card" }, [el("h2", {}, [document.createTextNode("Last night's sleep stages")]), stageTimeline]));
  }

  view.append(grid);

  if (data.meals?.length) view.append(logTimeline("Meals", data.meals, mealSubtitle));
  if (data.exercises?.length) view.append(logTimeline("Exercises", data.exercises, exerciseSubtitle));
}

function mealSubtitle(m) {
  return [
    m.estimatedCalories !== null ? `~${m.estimatedCalories} kcal` : undefined,
    m.proteinG !== null ? `${m.proteinG}g P` : undefined,
    m.carbsG !== null ? `${m.carbsG}g C` : undefined,
    m.fatG !== null ? `${m.fatG}g F` : undefined,
  ].filter((x) => x !== undefined).join(" · ");
}

function exerciseSubtitle(e) {
  return [
    e.exerciseType ?? undefined,
    e.durationMinutes !== null ? `${e.durationMinutes} min` : undefined,
    e.intensity ?? undefined,
    e.estimatedCaloriesBurned !== null ? `~${e.estimatedCaloriesBurned} kcal` : undefined,
  ].filter((x) => x !== undefined).join(" · ");
}

// Photo-log timeline shared by the meal and exercise sections — most
// recent entry first, thumbnail + one-line description + subtitle stats.
function logTimeline(title, entries, subtitleOf) {
  const list = el("div", { class: "log-timeline" });
  entries
    .slice()
    .reverse()
    .forEach((entry) => {
      const subtitle = subtitleOf(entry);
      list.append(
        el("div", { class: "log-entry" }, [
          entry.photoUrl
            ? el("img", { src: entry.photoUrl, alt: entry.description, loading: "lazy" })
            : el("div", { class: "log-entry-noimg" }, [document.createTextNode("✎")]),
          el("div", { class: "log-entry-body" }, [
            el("div", { class: "log-entry-date" }, [document.createTextNode(entry.date)]),
            el("div", { class: "log-entry-desc" }, [document.createTextNode(entry.description)]),
            subtitle ? el("div", { class: "log-entry-sub" }, [document.createTextNode(subtitle)]) : undefined,
          ].filter((n) => n !== undefined)),
        ]),
      );
    });
  return el("div", { class: "card" }, [el("h2", {}, [document.createTextNode(title)]), list]);
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
