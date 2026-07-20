// Health dashboard folded into the main app shell as a view — swapped in
// for #thread/footer (see openHealthView/closeHealthView below) so the
// sidebar/header stay put while it's open. Organized into named sections
// (Overview, Today, Activity, Heart & Recovery, Sleep, Records, Meals,
// Exercises) instead of one flat card grid, and surfaces every metric
// HealthRegistry actually extracts (see src/core/memory/health.ts's
// HealthDay) as either a mini chart or a stat, not just a subset —
// distance, exercise minutes, flights climbed, workout count and
// respiratory rate previously only appeared in the "today" list, with no
// 30-day trend at all.
import { api } from "./api.js";
import { closeOtherViews } from "./viewSwitcher.js";

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
  for (const child of children) if (child !== undefined) node.append(child);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function text(s) {
  return document.createTextNode(s);
}

// ---- chart primitives ----

function scoreLineChart(days) {
  return metricLineChart(days, [
    { valueOf: (d) => d.recovery, color: "var(--good)" },
    { valueOf: (d) => d.activity, color: "var(--accent)" },
  ]);
}

// Generic bar chart over `days` for any metric extracted by `valueOf`
// (returns null to skip a day).
function metricBarChart(days, valueOf, color, minMax = 1) {
  const width = 600;
  const height = 100;
  const values = days.map(valueOf).filter((v) => v !== null && v !== undefined);
  const maxValue = Math.max(minMax, ...values);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const barWidth = width / days.length;
  days.forEach((d, i) => {
    const value = valueOf(d);
    if (value === null || value === undefined) return;
    const barHeight = Math.max(1, (value / maxValue) * height);
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

// Generic multi-series line chart — heart rate (resting vs walking), HRV,
// respiratory rate and the recovery/activity trend all share this.
function metricLineChart(days, series) {
  const width = 600;
  const height = 100;
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
    if (coords) svg.append(svgEl("polyline", { points: coords, fill: "none", stroke: color, "stroke-width": "2" }));
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

// ---- layout helpers ----

function section(title, children) {
  return el("section", { class: "health-section" }, [el("h3", { class: "health-section-title" }, [text(title)]), ...children]);
}

function card(title, children, extraClass = "") {
  return el("div", { class: `card${extraClass ? ` ${extraClass}` : ""}` }, [el("h2", {}, [text(title)]), ...children]);
}

function avgOf(days, valueOf) {
  const values = days.map(valueOf).filter((v) => v !== null && v !== undefined);
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function statLine(days, valueOf, { decimals = 0, unit = "" } = {}) {
  const values = days.map(valueOf).filter((v) => v !== null && v !== undefined);
  if (!values.length) return "no data in range";
  const avg = avgOf(days, valueOf);
  return `avg ${avg.toFixed(decimals)}${unit} · ${values.length}/${days.length} day(s) logged`;
}

// A mini chart card for the Activity / Heart & Recovery grids: title, a
// one-line average/coverage stat (so a glance at the header alone still
// says something even with the chart collapsed on a narrow screen), then
// the chart itself.
function chartCard(title, days, valueOf, color, { decimals = 0, unit = "", minMax = 1 } = {}) {
  return card(
    title,
    [el("div", { class: "chart-stat" }, [text(statLine(days, valueOf, { decimals, unit }))]), metricBarChart(days, valueOf, color, minMax)],
    "chart-card mini",
  );
}

function lineChartCard(title, days, series, legend) {
  return card(
    title,
    [legend ? el("div", { class: "chart-stat" }, [text(legend)]) : undefined, metricLineChart(days, series)].filter((n) => n !== undefined),
    "chart-card mini",
  );
}

// ---- hero tiles (Overview section) ----

function heroTile(label, big, sub, extraClass = "") {
  return el("div", { class: `hero-tile${extraClass ? ` ${extraClass}` : ""}` }, [
    el("div", { class: "hero-label" }, [text(label)]),
    el("div", { class: "stat-big" }, [text(big)]),
    sub ? el("div", { class: "stat-sub" }, [text(sub)]) : undefined,
  ].filter((n) => n !== undefined));
}

async function render() {
  let data;
  try {
    data = await api.healthSummary();
  } catch {
    view.innerHTML = "";
    view.append(el("div", { class: "empty-hint" }, [text("Could not load health data.")]));
    return;
  }

  view.innerHTML = "";
  const backRow = el("div", { class: "health-back-row" }, [
    (() => {
      const btn = el("button", { class: "rail-btn", type: "button" }, [text("← Back to chat")]);
      btn.addEventListener("click", closeHealthView);
      return btn;
    })(),
  ]);
  view.append(backRow);

  if (!data.hasData) {
    view.append(el("div", { class: "empty-hint" }, [text("No health data ingested yet.")]));
    return;
  }

  const { days, latestScores: latest } = data;

  // ---- Overview: hero row + the headline recovery/activity trend ----
  const heroRow = el("div", { class: "hero-row" });
  heroRow.append(heroTile("Recovery", `${latest.recovery}`, `/100 · ${latest.date}`, "hero-good"));
  heroRow.append(heroTile("Activity", `${latest.activity}`, "/100", "hero-accent"));
  if (data.bioAge) {
    heroRow.append(heroTile("Biological age", `${data.bioAge.age}`, "wellness estimate", "hero-link"));
  }
  heroRow.append(heroTile("Sleep debt (7d)", `${data.sleepDebt.deficitHours.toFixed(1)}h`, `${data.sleepDebt.daysCounted} night(s) recorded`, "hero-warn"));
  const overviewChildren = [heroRow];
  if (data.anomalies?.length) {
    overviewChildren.push(el("div", { class: "anomaly-banner" }, data.anomalies.map((a) => el("div", { class: "anomaly-line" }, [text(`⚠ ${a.message}`)]))));
  }
  overviewChildren.push(card("Recovery (green) vs activity (red) — 30 days", [scoreLineChart(days)], "chart-card wide"));
  view.append(section("Overview", overviewChildren));

  // ---- Today: every metric extracted for the most recent day with data ----
  const todayDay = days.find((d) => d.date === latest.date);
  if (todayDay) {
    const stat = (label, value, unit = "") =>
      value === null || value === undefined
        ? undefined
        : el("div", { class: "stat-chip" }, [el("span", { class: "stat-chip-label" }, [text(label)]), el("span", { class: "stat-chip-value" }, [text(`${value}${unit}`)])]);
    const chips = [
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
      stat("Time asleep", todayDay.sleepAsleepSec !== null && todayDay.sleepAsleepSec !== undefined ? (todayDay.sleepAsleepSec / 3600).toFixed(1) : undefined, "h"),
      stat("Time in bed", todayDay.sleepDurationSec !== null && todayDay.sleepDurationSec !== undefined ? (todayDay.sleepDurationSec / 3600).toFixed(1) : undefined, "h"),
    ].filter((n) => n !== undefined);
    view.append(section(`Today — ${todayDay.date}`, [card("All metrics for the most recent day with data", [el("div", { class: "stat-chip-grid" }, chips)])]));
  }

  // ---- Activity: every activity metric HealthRegistry extracts ----
  view.append(
    section("Activity — 30 days", [
      el("div", { class: "chart-grid" }, [
        chartCard("Steps", days, (d) => d.steps, "var(--accent)", { unit: " steps" }),
        chartCard("Active energy", days, (d) => d.activeEnergyKcal, "var(--warn)", { unit: " kcal" }),
        chartCard("Distance", days, (d) => d.distanceKm, "var(--link)", { decimals: 1, unit: " km" }),
        chartCard("Exercise minutes", days, (d) => d.exerciseMinutes, "var(--good)", { unit: " min" }),
        chartCard("Flights climbed", days, (d) => d.flightsClimbed, "var(--accent-dim)", { unit: " flights" }),
        chartCard("Workouts", days, (d) => d.workoutCount, "var(--text-dim)", { decimals: 1, unit: "" }),
      ]),
    ]),
  );

  // ---- Heart & Recovery ----
  view.append(
    section("Heart & Recovery — 30 days", [
      el("div", { class: "chart-grid" }, [
        lineChartCard(
          "Heart rate — resting (green) / walking (red)",
          days,
          [
            { valueOf: (d) => d.restingHR, color: "var(--good)" },
            { valueOf: (d) => d.walkingHR, color: "var(--accent)" },
          ],
          `resting avg ${avgOf(days, (d) => d.restingHR)?.toFixed(0) ?? "—"} bpm · walking avg ${avgOf(days, (d) => d.walkingHR)?.toFixed(0) ?? "—"} bpm`,
        ),
        lineChartCard("Heart rate variability (HRV)", days, [{ valueOf: (d) => d.hrvAvg, color: "var(--link)" }], statLine(days, (d) => d.hrvAvg, { decimals: 1, unit: " ms" })),
        lineChartCard(
          "Respiratory rate",
          days,
          [{ valueOf: (d) => d.respiratoryRateAvg, color: "var(--warn)" }],
          statLine(days, (d) => d.respiratoryRateAvg, { decimals: 1, unit: " brpm" }),
        ),
      ]),
    ]),
  );

  // ---- Sleep ----
  const sleepChildren = [
    el("div", { class: "chart-grid" }, [
      lineChartCard(
        "Time asleep vs. time in bed (hours)",
        days,
        [
          { valueOf: (d) => (d.sleepAsleepSec === null ? null : d.sleepAsleepSec / 3600), color: "var(--link)" },
          { valueOf: (d) => (d.sleepDurationSec === null ? null : d.sleepDurationSec / 3600), color: "var(--text-dimmer)" },
        ],
        `asleep avg ${statLine(days, (d) => (d.sleepAsleepSec === null ? null : d.sleepAsleepSec / 3600), { decimals: 1, unit: "h" })}`,
      ),
    ]),
  ];
  const stageTimeline = sleepStageTimeline(data.latestRawJson);
  if (stageTimeline) sleepChildren.push(card("Last night's sleep stages", [stageTimeline], "chart-card wide"));
  view.append(section("Sleep — 30 days", sleepChildren));

  // ---- Records ----
  const recordsList = el("div", { class: "stat-chip-grid" });
  if (data.records.bestSleepNight) {
    recordsList.append(
      el("div", { class: "stat-chip" }, [
        el("span", { class: "stat-chip-label" }, [text(`Best sleep (${data.records.bestSleepNight.date})`)]),
        el("span", { class: "stat-chip-value" }, [text(`${(data.records.bestSleepNight.durationSec / 3600).toFixed(1)}h`)]),
      ]),
    );
  }
  if (data.records.lowestRestingHR) {
    recordsList.append(
      el("div", { class: "stat-chip" }, [
        el("span", { class: "stat-chip-label" }, [text(`Lowest resting HR (${data.records.lowestRestingHR.date})`)]),
        el("span", { class: "stat-chip-value" }, [text(`${data.records.lowestRestingHR.value} bpm`)]),
      ]),
    );
  }
  recordsList.append(
    el("div", { class: "stat-chip" }, [el("span", { class: "stat-chip-label" }, [text("Activity streak")]), el("span", { class: "stat-chip-value" }, [text(`${data.records.currentActivityStreakDays} day(s)`)])]),
  );
  view.append(section("Records", [card("Personal bests & streaks", [recordsList])]));

  // ---- Meals & Exercises ----
  const logsRow = el("div", { class: "logs-row" });
  if (data.meals?.length) logsRow.append(logTimeline("Meals", data.meals, mealSubtitle));
  if (data.exercises?.length) logsRow.append(logTimeline("Exercises", data.exercises, exerciseSubtitle));
  if (logsRow.children.length) view.append(section("Logged meals & exercises", [logsRow]));
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
            : el("div", { class: "log-entry-noimg" }, [text("✎")]),
          el("div", { class: "log-entry-body" }, [
            el("div", { class: "log-entry-date" }, [text(entry.date)]),
            el("div", { class: "log-entry-desc" }, [text(entry.description)]),
            subtitle ? el("div", { class: "log-entry-sub" }, [text(subtitle)]) : undefined,
          ].filter((n) => n !== undefined)),
        ]),
      );
    });
  return el("div", { class: "card logs-col" }, [el("h2", {}, [text(title)]), list]);
}

export function openHealthView() {
  closeOtherViews("health-view");
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
