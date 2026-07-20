import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config.js";
import { getFinanceRegistry, type AccountType } from "../memory/finance.js";

const finance = getFinanceRegistry(config.databasePath);

// Manual-entry only for now — no bank sync provider is wired up (would
// need an Enable Banking developer account/keys, see the "Finance" chat
// discussion). These are the conversational fallbacks; the web UI's
// Finance view (public/js/financeView.js) covers the same operations with
// forms instead of a chat turn.

function resolveAccount(nameOrId: string): { id: string } | undefined {
  return finance.getAccount(nameOrId) ?? finance.findAccountByName(nameOrId);
}

export const financeAddAccount = tool(
  async ({ name, type, currency }: { name: string; type: AccountType; currency?: string }) => {
    if (finance.findAccountByName(name)) return `error: an account named "${name}" already exists`;
    const account = finance.createAccount(name, type, currency ?? "EUR");
    return `Account created: ${account.name} (${account.type}, ${account.currency}). Use finance_record_balance to set its current balance.`;
  },
  {
    name: "finance_add_account",
    description: "Create a new tracked financial account (bank account, savings, investment, crypto, loan, or other). Call this when the user mentions a new account they want tracked.",
    schema: z.object({
      name: z.string().describe("Short display name, e.g. 'Crédit Agricole Courant', 'Livret A'."),
      type: z.enum(["checking", "savings", "investment", "crypto", "loan", "other"]),
      currency: z.string().optional().describe("ISO currency code, defaults to EUR."),
    }),
  },
);

export const financeRecordBalance = tool(
  async ({ account, balance, date }: { account: string; balance: number; date?: string }) => {
    const resolved = resolveAccount(account);
    if (!resolved) return `error: no account found matching "${account}" — use finance_add_account first, or check finance_query for the exact name`;
    const snapshot = finance.recordBalance(resolved.id, balance, date);
    return `Balance recorded: ${balance} on ${snapshot.date}.`;
  },
  {
    name: "finance_record_balance",
    description: "Record (or correct) an account's balance for a given day — the user's own statement of their current balance, not a computed figure. Call this whenever the user tells you a balance, e.g. 'j'ai 1200€ sur mon Livret A'.",
    schema: z.object({
      account: z.string().describe("Account name (or id) as previously created with finance_add_account."),
      balance: z.number(),
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today."),
    }),
  },
);

export const financeAddTransaction = tool(
  async ({ account, description, amount, date, category }: { account: string; description: string; amount: number; date?: string; category?: string }) => {
    const resolved = resolveAccount(account);
    if (!resolved) return `error: no account found matching "${account}"`;
    finance.addTransaction(resolved.id, description, amount, date, category ?? null);
    return `Transaction logged: ${description} (${amount >= 0 ? "+" : ""}${amount}).`;
  },
  {
    name: "finance_add_transaction",
    description: "Log a manual income or expense on an account. Amount is signed: negative for an expense/withdrawal, positive for income/deposit. This does not change the account's recorded balance by itself — use finance_record_balance separately if the user also gives you the new total.",
    schema: z.object({
      account: z.string(),
      description: z.string(),
      amount: z.number().describe("Negative for an expense, positive for income."),
      date: z.string().optional().describe("YYYY-MM-DD, defaults to today."),
      category: z.string().optional().describe("Free-text category, e.g. 'groceries', 'salary'."),
    }),
  },
);

export const financeQuery = tool(
  async () => {
    if (!finance.hasData()) return "No finance accounts tracked yet — use finance_add_account to create one.";
    const accounts = finance.listAccountsWithBalance();
    const lines = accounts.map((a) => `- ${a.name} (${a.type}): ${a.balance !== null ? `${a.balance} ${a.currency}` : "no balance recorded yet"}${a.balanceDate ? ` as of ${a.balanceDate}` : ""}`);
    const netWorth = finance.netWorth();
    const recent = finance.listTransactions(10);
    const txLines = recent.map((t) => `- ${t.date}: ${t.description} (${t.amount >= 0 ? "+" : ""}${t.amount})`);
    return [
      `Net worth: ${netWorth.toFixed(2)} (sum of latest known balances).`,
      "Accounts:",
      ...lines,
      recent.length ? "Recent transactions:" : "No transactions logged yet.",
      ...txLines,
    ].join("\n");
  },
  {
    name: "finance_query",
    description: "Get every tracked account's latest balance, current net worth, and the 10 most recent manual transactions. Call this whenever the user asks about their balance, net worth, or spending.",
    schema: z.object({}),
  },
);
