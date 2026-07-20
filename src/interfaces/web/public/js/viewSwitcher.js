// Registry of full-width views swapped in for #thread/footer (health,
// tokens, finance — more may follow), so opening one closes the others
// without every view module needing to import every other one (which
// would tangle into a circular-import mess as more get added).
const VIEWS = [
  { viewId: "health-view", navId: "health-nav-btn" },
  { viewId: "usage-view", navId: "usage-nav-btn" },
  { viewId: "finance-view", navId: "finance-nav-btn" },
];

export function closeOtherViews(exceptViewId) {
  for (const { viewId, navId } of VIEWS) {
    if (viewId === exceptViewId) continue;
    const view = document.getElementById(viewId);
    const navBtn = document.getElementById(navId);
    if (view) view.hidden = true;
    if (navBtn) navBtn.classList.remove("active");
  }
}

export function closeAllViews() {
  closeOtherViews(null);
}
