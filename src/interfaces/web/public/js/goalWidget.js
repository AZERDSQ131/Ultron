// Persistent header widget for /task goal mode — previously the web UI had
// no ongoing visual state for an active goal at all, only ephemeral system
// notes during a live stream (see composer.js's "goal" SSE case), even
// though GET /api/status already returns the full Goal object
// (objective/status/turnsUsed/maxTurns/lastReason). This just renders that
// existing data; loadStatus() (statusBar.js) is what actually fetches it,
// on every chat switch and after every "goal" SSE event.

const widget = document.getElementById("goal-widget");

const STATUS_ICON = { active: "🎯", paused: "⏸", complete: "✓", cleared: "" };

export function updateGoalWidget(goal) {
  if (!goal || goal.status === "cleared") {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  widget.dataset.status = goal.status;
  const icon = STATUS_ICON[goal.status] ?? "🎯";
  const turns = `${goal.turnsUsed}/${goal.maxTurns}`;
  widget.textContent = `${icon} Goal ${turns}`;
  const reason = goal.lastReason ? ` — ${goal.lastReason}` : "";
  widget.title = `${goal.status} (${turns} turns): ${goal.objective}${reason}`;
}

export function initGoalWidget() {
  widget.addEventListener("click", () => alert(widget.title));
}
