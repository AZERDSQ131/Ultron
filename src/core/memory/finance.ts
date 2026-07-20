import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Personal finance tracking — accounts, daily balance snapshots, and manual
// transactions. Deliberately manual-entry only for now (no bank sync): the
// user doesn't yet have an Enable Banking developer account (Application
// ID, RSA keypair, OAuth redirect URI), which any real DSP2 connector
// would need — see the "Finance" chat discussion. Structured the same way
// HealthRegistry is (accounts/snapshots/transactions, global, never
// purged) so a future sync provider has an obvious place to write into
// without a schema rework: it would just populate finance_balance_snapshots
// on a schedule instead of a human calling finance_record_balance.

export type AccountType = "checking" | "savings" | "investment" | "crypto" | "loan" | "other";

export interface FinanceAccount {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  createdAt: string;
}

export interface BalanceSnapshot {
  id: number;
  accountId: string;
  date: string;
  balance: number;
  createdAt: string;
}

export interface FinanceTransaction {
  id: number;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  createdAt: string;
}

export interface AccountWithBalance extends FinanceAccount {
  balance: number | null;
  balanceDate: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  created_at: string;
}

interface SnapshotRow {
  id: number;
  account_id: string;
  date: string;
  balance: number;
  created_at: string;
}

interface TransactionRow {
  id: number;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  created_at: string;
}

function toAccount(row: AccountRow): FinanceAccount {
  return { id: row.id, name: row.name, type: row.type as AccountType, currency: row.currency, createdAt: row.created_at };
}

function toSnapshot(row: SnapshotRow): BalanceSnapshot {
  return { id: row.id, accountId: row.account_id, date: row.date, balance: row.balance, createdAt: row.created_at };
}

function toTransaction(row: TransactionRow): FinanceTransaction {
  return { id: row.id, accountId: row.account_id, date: row.date, description: row.description, amount: row.amount, category: row.category, createdAt: row.created_at };
}

export class FinanceRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS finance_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS finance_balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        balance REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, date)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_finance_snapshots_account_date ON finance_balance_snapshots (account_id, date)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        category TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_finance_transactions_account_date ON finance_transactions (account_id, date)");
  }

  hasData(): boolean {
    const row = this.db.prepare("SELECT 1 FROM finance_accounts LIMIT 1").get();
    return row !== undefined;
  }

  createAccount(name: string, type: AccountType, currency = "EUR"): FinanceAccount {
    const account: FinanceAccount = { id: randomUUID(), name, type, currency, createdAt: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO finance_accounts (id, name, type, currency, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(account.id, account.name, account.type, account.currency, account.createdAt);
    return account;
  }

  getAccount(id: string): FinanceAccount | undefined {
    const row = this.db.prepare("SELECT * FROM finance_accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  findAccountByName(name: string): FinanceAccount | undefined {
    const row = this.db.prepare("SELECT * FROM finance_accounts WHERE lower(name) = lower(?)").get(name) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  listAccounts(): FinanceAccount[] {
    return (this.db.prepare("SELECT * FROM finance_accounts ORDER BY created_at ASC").all() as unknown as AccountRow[]).map(toAccount);
  }

  // Every account with its most recent balance snapshot (null if never
  // recorded) — what the dashboard and net worth total actually need,
  // rather than making callers join snapshots themselves.
  listAccountsWithBalance(): AccountWithBalance[] {
    return this.listAccounts().map((account) => {
      const latest = this.db
        .prepare("SELECT date, balance FROM finance_balance_snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1")
        .get(account.id) as { date: string; balance: number } | undefined;
      return { ...account, balance: latest?.balance ?? null, balanceDate: latest?.date ?? null };
    });
  }

  deleteAccount(id: string): boolean {
    this.db.prepare("DELETE FROM finance_balance_snapshots WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM finance_transactions WHERE account_id = ?").run(id);
    const deleted = this.db.prepare("DELETE FROM finance_accounts WHERE id = ?").run(id);
    return Number(deleted.changes ?? 0) > 0;
  }

  // One snapshot per account per calendar day — recording again the same
  // day overwrites (a corrected balance), same upsert pattern as
  // HealthRegistry's daily rows.
  recordBalance(accountId: string, balance: number, date: string = new Date().toISOString().slice(0, 10)): BalanceSnapshot {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO finance_balance_snapshots (account_id, date, balance, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance, created_at = excluded.created_at`,
      )
      .run(accountId, date, balance, now);
    const row = this.db
      .prepare("SELECT * FROM finance_balance_snapshots WHERE account_id = ? AND date = ?")
      .get(accountId, date) as unknown as SnapshotRow;
    return toSnapshot(row);
  }

  getBalanceHistory(accountId: string, from: string, to: string): BalanceSnapshot[] {
    return (
      this.db
        .prepare("SELECT * FROM finance_balance_snapshots WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date ASC")
        .all(accountId, from, to) as unknown as SnapshotRow[]
    ).map(toSnapshot);
  }

  // Net worth per day across every account, forward-filling any account
  // that has no snapshot for a given date with its last known balance —
  // otherwise a single freshly-added account with no history yet would
  // make every earlier day's total look like it dropped.
  getNetWorthHistory(from: string, to: string): { date: string; netWorth: number }[] {
    const accounts = this.listAccounts();
    const dates: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const last = new Map<string, number>();
    return dates.map((date) => {
      let netWorth = 0;
      for (const account of accounts) {
        const row = this.db
          .prepare("SELECT balance FROM finance_balance_snapshots WHERE account_id = ? AND date = ?")
          .get(account.id, date) as { balance: number } | undefined;
        if (row) last.set(account.id, row.balance);
        netWorth += last.get(account.id) ?? 0;
      }
      return { date, netWorth };
    });
  }

  netWorth(): number {
    return this.listAccountsWithBalance().reduce((sum, a) => sum + (a.balance ?? 0), 0);
  }

  addTransaction(accountId: string, description: string, amount: number, date: string = new Date().toISOString().slice(0, 10), category: string | null = null): FinanceTransaction {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO finance_transactions (account_id, date, description, amount, category, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(accountId, date, description, amount, category, now);
    const row = this.db.prepare("SELECT * FROM finance_transactions WHERE id = last_insert_rowid()").get() as unknown as TransactionRow;
    return toTransaction(row);
  }

  listTransactions(limit = 50, accountId?: string): FinanceTransaction[] {
    const rows = accountId
      ? (this.db.prepare("SELECT * FROM finance_transactions WHERE account_id = ? ORDER BY date DESC, id DESC LIMIT ?").all(accountId, limit) as unknown as TransactionRow[])
      : (this.db.prepare("SELECT * FROM finance_transactions ORDER BY date DESC, id DESC LIMIT ?").all(limit) as unknown as TransactionRow[]);
    return rows.map(toTransaction);
  }

  deleteTransaction(id: number): boolean {
    const deleted = this.db.prepare("DELETE FROM finance_transactions WHERE id = ?").run(id);
    return Number(deleted.changes ?? 0) > 0;
  }
}

let sharedRegistry: FinanceRegistry | undefined;

export function getFinanceRegistry(dbPath: string): FinanceRegistry {
  if (!sharedRegistry) sharedRegistry = new FinanceRegistry(dbPath);
  return sharedRegistry;
}
