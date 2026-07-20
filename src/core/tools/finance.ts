import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config.js";
import { getFinanceRegistry, DEFAULT_ACCOUNT_NAME, type AccountType } from "../memory/finance.js";

const finance = getFinanceRegistry(config.databasePath);

// Manual-entry only — no bank sync provider is wired up (Enable Banking's
// DSP2 OAuth flow needs a developer account, an RSA keypair, and a public
// redirect URI the Jetson doesn't have; scoped out as too much setup, see
// the "Finance" chat discussion). Optimized instead for "just say it in
// chat": `account` is optional everywhere below and resolves/creates on
// the fly (getOrCreateAccount) — there's no separate bookkeeping step
// before logging a balance or a transaction, unlike log_meal_or_exercise's
// health-log counterpart which at least has a fixed schema to write into.

export const financeAddAccount = tool(
  async ({ name, type, currency }: { name: string; type: AccountType; currency?: string }) => {
    if (finance.findAccountByName(name)) return `error: an account named "${name}" already exists`;
    const account = finance.createAccount(name, type, currency ?? "EUR");
    return `Account created: ${account.name} (${account.type}, ${account.currency}).`;
  },
  {
    name: "finance_add_account",
    description:
      "Create a named financial account with a specific type/currency ahead of time. Rarely needed — finance_record_balance and finance_add_transaction auto-create an account by name if it doesn't exist yet. Only call this when the user explicitly wants to set up a specific account type (e.g. distinguishing a 'Livret A' savings account from their main checking) before logging anything against it.",
    schema: z.object({
      name: z.string().describe("Short display name, e.g. 'Crédit Agricole Courant', 'Livret A'."),
      type: z.enum(["checking", "savings", "investment", "crypto", "loan", "other"]),
      currency: z.string().optional().describe("ISO currency code, defaults to EUR."),
    }),
  },
);

export const financeRecordBalance = tool(
  async ({ account, balance, date }: { account?: string; balance: number; date?: string }) => {
    const resolved = finance.getOrCreateAccount(account?.trim() || DEFAULT_ACCOUNT_NAME);
    const snapshot = finance.recordBalance(resolved.id, balance, date);
    return `Balance recorded for ${resolved.name}: ${balance} on ${snapshot.date}.`;
  },
  {
    name: "finance_record_balance",
    description:
      "Record the user's current balance for an account — their own stated figure, not a computed one. Call this proactively whenever the user tells you a balance, even casually ('j'ai 1200€ sur mon compte', 'il me reste 300 balles'), not just when explicitly asked to log it. If they don't name a specific account, it goes to their default account — don't ask which account unless they've previously set up more than one.",
    schema: z.object({
      account: z.string().optional().describe("Account name, if the user names one. Omit for their single default account."),
      balance: z.number(),
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today."),
    }),
  },
);

export const financeAddTransaction = tool(
  async ({ account, description, amount, date, category }: { account?: string; description: string; amount: number; date?: string; category?: string }) => {
    const resolved = finance.getOrCreateAccount(account?.trim() || DEFAULT_ACCOUNT_NAME);
    finance.addTransaction(resolved.id, description, amount, date, category ?? null);
    return `Logged on ${resolved.name}: ${description} (${amount >= 0 ? "+" : ""}${amount}).`;
  },
  {
    name: "finance_add_transaction",
    description:
      "Log a single income or expense. Amount is signed: negative for any expense/purchase/withdrawal, positive for income/salary/deposit/gift received. Call this proactively whenever the user mentions spending or earning money, even briefly ('j'ai payé 15€ pour le resto', 'j'ai reçu mon salaire, 1800€', 'plein d'essence 60 balles') — not just when explicitly asked to log it. Guess a short, sensible category yourself (e.g. 'groceries', 'transport', 'salary', 'rent', 'leisure') from the description; use null only if truly nothing fits. If no account is named, it goes to the user's single default account.",
    schema: z.object({
      account: z.string().optional().describe("Account name, if the user names one. Omit for their single default account."),
      description: z.string().describe("Short description of what this was, e.g. 'Courses Carrefour', 'Salaire juillet'."),
      amount: z.number().describe("Negative for an expense, positive for income."),
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today."),
      category: z.string().nullable().optional().describe("Short category you infer from the description, e.g. 'groceries', 'salary', 'rent'."),
    }),
  },
);

export const financeQuery = tool(
  async () => {
    if (!finance.hasData()) return "No finance data tracked yet — just tell ULTRON a balance or a transaction and it'll start tracking automatically.";
    const accounts = finance.listAccountsWithBalance();
    const accountLines = accounts.map((a) => `- ${a.name} (${a.type}): ${a.balance !== null ? `${a.balance} ${a.currency}` : "no balance recorded yet"}${a.balanceDate ? ` as of ${a.balanceDate}` : ""}`);
    const netWorth = finance.netWorth();
    const month = finance.currentMonthSummary();
    const to = new Date().toISOString().slice(0, 10);
    const from = `${to.slice(0, 7)}-01`;
    const spending = finance.getSpendingByCategory(from, to).slice(0, 8);
    const recent = finance.listTransactions(10);
    return [
      `Net worth: ${netWorth.toFixed(2)} (sum of latest known account balances).`,
      "Accounts:",
      ...accountLines,
      `This month so far: income ${month.income.toFixed(2)}, expenses ${month.expenses.toFixed(2)}, net ${month.savings >= 0 ? "+" : ""}${month.savings.toFixed(2)}${month.savingsRatePct !== null ? ` (savings rate ${month.savingsRatePct.toFixed(0)}%)` : ""}.`,
      spending.length ? "Top spending categories this month:" : "No spending logged this month yet.",
      ...spending.map((s) => `- ${s.category}: ${Math.abs(s.total).toFixed(2)} (${s.count} transaction(s))`),
      recent.length ? "Recent transactions:" : "No transactions logged yet.",
      ...recent.map((t) => `- ${t.date}: ${t.description} (${t.amount >= 0 ? "+" : ""}${t.amount})${t.category ? ` [${t.category}]` : ""}`),
    ].join("\n");
  },
  {
    name: "finance_query",
    description: "Get the full financial picture: every account's latest balance, net worth, this month's income/expenses/savings rate, top spending categories this month, and the 10 most recent transactions. Call this whenever the user asks anything about their money — balance, net worth, spending, budget, how they're doing financially.",
    schema: z.object({}),
  },
);
