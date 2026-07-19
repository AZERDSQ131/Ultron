// Read-only health dashboard — fetches GET /api/health-data/summary (see
// handleHealthSummary in server.ts) and renders everything with plain SVG,
// no charting library, consistent with the rest of this frontend (native
// ES modules, no bundler, no framework).

const root = document.getElementById("health-root");

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

// Two overlaid lines (recovery, activity) over the last N days, each 0-100.
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
    data = await fetch("/api/health-data/summary").then((r) => r.json());
  } catch {
    root.innerHTML = "";
    root.append(el("div", { class: "empty-hint" }, [document.createTextNode("Could not load health data.")]));
    return;
  }

  root.innerHTML = "";
  if (!data.hasData) {
    root.append(el("div", { class: "empty-hint" }, [document.createTextNode("No health data ingested yet.")]));
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

  root.append(grid);
}

render();
