// Theme is a user preference persisted in localStorage, with "system" as
// the default so a first-time visit follows the OS. CSS carries the actual
// values (see style.css tokens): this module's only job is deciding which
// of "system" / "dark" / "light" is active and stamping data-theme on the
// root element accordingly — :root[data-theme] overrides the
// prefers-color-scheme media query in both directions, per how the tokens
// are structured.
const STORAGE_KEY = "ultron-theme";
const root = document.documentElement;

function storedPreference() {
  return localStorage.getItem(STORAGE_KEY) ?? "system";
}

function effectiveTheme(pref) {
  if (pref === "dark" || pref === "light") return pref;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(pref) {
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

let themeToggleBtn;
let themeSelect;

function syncControls(pref) {
  if (themeSelect) themeSelect.value = pref;
  if (themeToggleBtn) themeToggleBtn.textContent = effectiveTheme(pref) === "dark" ? "◐" : "◑";
}

export function setTheme(pref) {
  localStorage.setItem(STORAGE_KEY, pref);
  apply(pref);
  syncControls(pref);
}

export function initTheme({ toggleBtn, select }) {
  themeToggleBtn = toggleBtn;
  themeSelect = select;

  const pref = storedPreference();
  apply(pref);
  syncControls(pref);

  toggleBtn.addEventListener("click", () => {
    const next = effectiveTheme(storedPreference()) === "dark" ? "light" : "dark";
    setTheme(next);
  });

  select.addEventListener("change", () => setTheme(select.value));

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedPreference() === "system") syncControls("system");
  });
}
