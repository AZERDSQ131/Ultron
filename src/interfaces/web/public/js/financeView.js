// "Finance" dashboard — manual-entry accounts, balances, and transactions
// (src/core/memory/finance.ts). No bank sync provider is wired up: DSP2/
// Enable Banking would need a developer Application ID, an RSA keypair,
// and a public OAuth redirect URI the Jetson doesn't have — scoped out as
// too much setup. Optimized instead for "just tell ULTRON in chat": the
// finance_* tools auto-create an account by name, so this dashboard is
// mainly for *reading* the richer picture (spending by category, monthly
// cash flow, net worth trend) rather than the primary way of logging
// anything, though the inline per-account forms below still work fine for
// that too. Same swapped-in-view pattern as healthView.js/usageView.js.
import { api } from "./api.js";
import { closeOtherViews } from "./viewSwitcher.js";

const thread = document.getElementById("thread");
const footer = document.querySelector("footer");
const view = document.getElementById("finance-view");
const navBtn = document.getElementById("finance-nav-btn");
const activeChatTitle = document.getElementById("active-chat-title");

const ACCOUNT_TYPE_LABELS = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  crypto: "Crypto",
  loan: "Loan",
  other: "Other",
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

function fmtMoney(n, currency = "EUR") {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function netWorthChart(history) {
  const width = 600;
  const height = 110;
  if (!history.length) return svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
  const values = history.map((d) => d.netWorth);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const range = max - min || 1;
  const step = width / Math.max(1, history.length - 1);
  const coords = history.map((d, i) => `${i * step},${height - ((d.netWorth - min) / range) * height}`).join(" ");
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  svg.append(svgEl("polyline", { points: coords, fill: "none", stroke: "var(--good)", "stroke-width": "2" }));
  return svg;
}

// Monthly income (green) vs. expenses (accent/red) grouped bars — the
// "am I saving money" chart, last 6 months including the current one.
function cashFlowChart(months) {
  const width = 600;
  const height = 110;
  if (!months.length) return svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses]));
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const groupWidth = width / months.length;
  months.forEach((m, i) => {
    const barWidth = groupWidth * 0.32;
    const gap = groupWidth * 0.06;
    const x0 = i * groupWidth + groupWidth * 0.15;
    const incomeH = (m.income / max) * height;
    const expensesH = (m.expenses / max) * height;
    svg.append(svgEl("rect", { x: x0, y: height - incomeH, width: barWidth, height: incomeH, fill: "var(--good)", rx: 2 }));
    svg.append(svgEl("rect", { x: x0 + barWidth + gap, y: height - expensesH, width: barWidth, height: expensesH, fill: "var(--accent)", rx: 2 }));
  });
  return svg;
}

// Spending-by-category breakdown, reusing the .usage-table look — biggest
// category first, with a proportional bar like the Tokens page's tables.
function categoryTable(rows) {
  if (!rows.length) return el("div", { class: "empty-hint" }, [text("No spending logged this month yet.")]);
  const maxAmount = Math.max(1, ...rows.map((r) => Math.abs(r.total)));
  const table = el("div", { class: "usage-table" });
  table.append(
    el("div", { class: "usage-table-row usage-table-head" }, [
      el("span", {}, [text("Category")]),
      el("span", {}, [text("Transactions")]),
      el("span", {}, [text("Total")]),
    ]),
  );
  for (const row of rows) {
    const barPct = Math.round((Math.abs(row.total) / maxAmount) * 100);
    table.append(
      el("div", { class: "usage-table-row" }, [
        el("span", { class: "usage-table-key" }, [text(row.category), el("span", { class: "usage-table-bar", style: `width:${barPct}%` })]),
        el("span", {}, [text(String(row.count))]),
        el("span", { class: "finance-amount-negative" }, [text(fmtMoney(row.total))]),
      ]),
    );
  }
  return table;
}

let currentRangeDays = 30;
let addAccountFormOpen = false;
let addTxAccountId = null;

function accountCard(account) {
  const rows = [
    el("div", { class: "stat-chip" }, [
      el("span", { class: "stat-chip-label" }, [text(ACCOUNT_TYPE_LABELS[account.type] ?? account.type)]),
      el("span", { class: "stat-chip-value" }, [text(account.balance !== null ? fmtMoney(account.balance, account.currency) : "—")]),
    ]),
  ];
  const sub = account.balanceDate ? el("div", { class: "chart-stat" }, [text(`as of ${account.balanceDate}`)]) : el("div", { class: "chart-stat" }, [text("no balance recorded yet")]);

  const balanceForm = el("form", { class: "finance-inline-form" }, [
    el("input", { type: "number", step: "0.01", placeholder: "New balance", required: "true", class: "finance-balance-input" }),
    el("button", { type: "submit", class: "rail-btn" }, [text("Update")]),
  ]);
  balanceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = balanceForm.querySelector(".finance-balance-input");
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    await api.financeRecordBalance(account.id, value);
    input.value = "";
    await render();
  });

  const txForm = el("form", { class: "finance-inline-form" }, [
    el("input", { type: "text", placeholder: "Description", required: "true", class: "finance-tx-desc" }),
    el("input", { type: "number", step: "0.01", placeholder: "± amount", required: "true", class: "finance-tx-amount" }),
    el("button", { type: "submit", class: "rail-btn" }, [text("Add transaction")]),
  ]);
  txForm.hidden = addTxAccountId !== account.id;
  txForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const desc = txForm.querySelector(".finance-tx-desc").value.trim();
    const amount = Number(txForm.querySelector(".finance-tx-amount").value);
    if (!desc || !Number.isFinite(amount)) return;
    await api.financeAddTransaction(account.id, desc, amount);
    addTxAccountId = null;
    await render();
  });

  const actions = el("div", { class: "finance-card-actions" }, [
    (() => {
      const btn = el("button", { type: "button", class: "rail-btn" }, [text(addTxAccountId === account.id ? "Cancel" : "+ Transaction")]);
      btn.addEventListener("click", () => {
        addTxAccountId = addTxAccountId === account.id ? null : account.id;
        render();
      });
      return btn;
    })(),
    (() => {
      const btn = el("button", { type: "button", class: "rail-btn danger" }, [text("Delete")]);
      btn.addEventListener("click", async () => {
        if (!confirm(`Delete account "${account.name}"? This removes its history too.`)) return;
        await api.financeDeleteAccount(account.id);
        await render();
      });
      return btn;
    })(),
  ]);

  return card(account.name, [...rows, sub, balanceForm, txForm, actions], "finance-account-card");
}

function addAccountCard() {
  if (!addAccountFormOpen) {
    const btn = el("button", { type: "button", class: "rail-btn finance-add-account-btn" }, [text("+ Add account")]);
    btn.addEventListener("click", () => {
      addAccountFormOpen = true;
      render();
    });
    return el("div", { class: "card finance-account-card finance-add-card" }, [btn]);
  }
  const nameInput = el("input", { type: "text", placeholder: "Account name, e.g. Crédit Agricole Courant", required: "true" });
  const typeSelect = el(
    "select",
    {},
    Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => el("option", { value }, [text(label)])),
  );
  const currencyInput = el("input", { type: "text", placeholder: "EUR", value: "EUR", maxlength: "3", class: "finance-currency-input" });
  const form = el("form", { class: "finance-inline-form finance-add-form" }, [
    nameInput,
    typeSelect,
    currencyInput,
    el("button", { type: "submit", class: "rail-btn" }, [text("Create")]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!nameInput.value.trim()) return;
    const data = await api.financeCreateAccount(nameInput.value.trim(), typeSelect.value, currencyInput.value.trim() || "EUR");
    if (data?.error) {
      alert(data.error);
      return;
    }
    addAccountFormOpen = false;
    await render();
  });
  return card("New account", [form], "finance-account-card");
}

async function render() {
  let data;
  try {
    data = await api.financeSummary(currentRangeDays);
  } catch {
    view.innerHTML = "";
    view.append(el("div", { class: "empty-hint" }, [text("Could not load finance data.")]));
    return;
  }

  view.innerHTML = "";
  const backRow = el("div", { class: "health-back-row" }, [
    (() => {
      const btn = el("button", { class: "rail-btn", type: "button" }, [text("← Back to chat")]);
      btn.addEventListener("click", closeFinanceView);
      return btn;
    })(),
  ]);
  const rangePicker = el("div", { class: "usage-range-picker" });
  for (const { label, days } of [{ label: "30d", days: 30 }, { label: "90d", days: 90 }, { label: "1y", days: 365 }]) {
    const btn = el("button", { class: `rail-btn${currentRangeDays === days ? " active" : ""}`, type: "button" }, [text(label)]);
    btn.addEventListener("click", () => {
      currentRangeDays = days;
      render();
    });
    rangePicker.append(btn);
  }
  view.append(el("div", { class: "usage-header-row" }, [backRow, rangePicker]));

  if (!data.hasData) {
    view.append(
      section("Finance", [
        el("div", { class: "empty-hint" }, [text("No data yet — just tell ULTRON a balance or a transaction in chat and it'll start tracking automatically, or add an account below.")]),
        addAccountCard(),
      ]),
    );
    return;
  }

  const month = data.monthSummary;
  const heroRow = el("div", { class: "hero-row" });
  heroRow.append(heroTile("Net worth", fmtMoney(data.netWorth), `${data.accounts.length} account(s)`, "hero-good"));
  heroRow.append(heroTile("Income this month", fmtMoney(month.income), "logged so far", "hero-link"));
  heroRow.append(heroTile("Expenses this month", fmtMoney(month.expenses), "logged so far", "hero-accent"));
  heroRow.append(
    heroTile(
      "Savings this month",
      `${month.savings >= 0 ? "+" : ""}${fmtMoney(month.savings)}`,
      month.savingsRatePct !== null ? `${month.savingsRatePct.toFixed(0)}% savings rate` : "no income logged yet",
      month.savings >= 0 ? "hero-good" : "hero-warn",
    ),
  );
  view.append(
    section("Overview", [
      heroRow,
      el("div", { class: "chart-grid" }, [
        card("Net worth trend", [netWorthChart(data.netWorthHistory)], "chart-card mini"),
        card("Income (green) vs. expenses (red) — 6 months", [cashFlowChart(data.monthlyCashFlow)], "chart-card mini"),
      ]),
    ]),
  );

  view.append(section("Spending by category — this month", [card(`${data.spendingByCategory.length} categor${data.spendingByCategory.length === 1 ? "y" : "ies"}`, [categoryTable(data.spendingByCategory)])]));

  const accountsGrid = el("div", { class: "chart-grid" }, [...data.accounts.map(accountCard), addAccountCard()]);
  view.append(section("Accounts", [accountsGrid]));

  const txTable = el("div", { class: "usage-table usage-table-recent" });
  txTable.append(
    el("div", { class: "usage-table-row usage-table-head" }, [
      el("span", {}, [text("Date")]),
      el("span", {}, [text("Account")]),
      el("span", {}, [text("Description")]),
      el("span", {}, [text("Category")]),
      el("span", {}, [text("Amount")]),
    ]),
  );
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  for (const tx of data.transactions) {
    const account = accountById.get(tx.accountId);
    txTable.append(
      el("div", { class: "usage-table-row" }, [
        el("span", { class: "dim" }, [text(tx.date)]),
        el("span", {}, [text(account?.name ?? "—")]),
        el("span", {}, [text(tx.description)]),
        el("span", { class: "dim" }, [text(tx.category ?? "—")]),
        el("span", { class: tx.amount >= 0 ? "finance-amount-positive" : "finance-amount-negative" }, [text(fmtMoney(tx.amount, account?.currency ?? "EUR"))]),
      ]),
    );
  }
  view.append(section("Transactions", [card(`Last ${data.transactions.length} transaction(s)`, [data.transactions.length ? txTable : el("div", { class: "empty-hint" }, [text("No transactions logged yet.")])])]));
}

export function openFinanceView() {
  closeOtherViews("finance-view");
  thread.hidden = true;
  footer.hidden = true;
  view.hidden = false;
  navBtn.classList.add("active");
  activeChatTitle.textContent = "Finance";
  render();
}

export function closeFinanceView() {
  if (view.hidden) return;
  thread.hidden = false;
  footer.hidden = false;
  view.hidden = true;
  navBtn.classList.remove("active");
}

export function isFinanceViewOpen() {
  return !view.hidden;
}

export function initFinanceView() {
  navBtn.addEventListener("click", () => (isFinanceViewOpen() ? closeFinanceView() : openFinanceView()));
}
