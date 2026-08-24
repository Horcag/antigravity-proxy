import Database from 'better-sqlite3';
import { CloudAccount, CloudAccountSchema, CloudQuotaData } from '@/modules/cloud-account/types';
import { decryptJson, encryptJson } from '@/shared/security/encryption';
import { getDatabasePath } from '@/shared/paths';

interface AccountRow {
  id: string;
  provider: CloudAccount['provider'];
  email: string;
  name: string | null;
  avatar_url: string | null;
  token_json: string;
  quota_json: string | null;
  created_at: number;
  last_used: number;
  status: CloudAccount['status'] | null;
  status_reason: string | null;
  is_active: number;
  proxy_url: string | null;
}

export class CloudAccountRepo {
  private static database: Database.Database | null = null;

  static init(): void {
    this.getDatabase();
  }

  static close(): void {
    this.database?.close();
    this.database = null;
  }

  private static getDatabase(): Database.Database {
    if (this.database) {
      return this.database;
    }
    const database = new Database(getDatabasePath());
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 3000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT,
        avatar_url TEXT,
        token_json TEXT NOT NULL,
        quota_json TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        status_reason TEXT,
        is_active INTEGER DEFAULT 0,
        proxy_url TEXT
      );
    `);
    this.database = database;
    return database;
  }

  private static toAccount(row: AccountRow): CloudAccount {
    return CloudAccountSchema.parse({
      id: row.id,
      provider: row.provider,
      email: row.email,
      name: row.name,
      avatar_url: row.avatar_url,
      token: decryptJson(row.token_json),
      quota: row.quota_json ? decryptJson(row.quota_json) : undefined,
      created_at: row.created_at,
      last_used: row.last_used,
      status: row.status ?? 'active',
      status_reason: row.status_reason ?? undefined,
      is_active: Boolean(row.is_active),
      proxy_url: row.proxy_url ?? undefined,
    });
  }

  static async getAccounts(): Promise<CloudAccount[]> {
    const rows = this.getDatabase()
      .prepare('SELECT * FROM accounts ORDER BY last_used DESC')
      .all() as AccountRow[];
    return rows.map((row) => this.toAccount(row));
  }

  static async getAccount(accountId: string): Promise<CloudAccount | undefined> {
    const row = this.getDatabase()
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(accountId) as AccountRow | undefined;
    return row ? this.toAccount(row) : undefined;
  }

  static async getAccountByEmail(email: string): Promise<CloudAccount | undefined> {
    const row = this.getDatabase()
      .prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE')
      .get(email) as AccountRow | undefined;
    return row ? this.toAccount(row) : undefined;
  }

  static async addAccount(account: CloudAccount): Promise<void> {
    const validated = CloudAccountSchema.parse(account);
    this.getDatabase()
      .prepare(`
        INSERT INTO accounts (
          id, provider, email, name, avatar_url, token_json, quota_json,
          created_at, last_used, status, status_reason, is_active, proxy_url
        ) VALUES (
          @id, @provider, @email, @name, @avatarUrl, @tokenJson, @quotaJson,
          @createdAt, @lastUsed, @status, @statusReason, @isActive, @proxyUrl
        )
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          email = excluded.email,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          token_json = excluded.token_json,
          quota_json = excluded.quota_json,
          last_used = excluded.last_used,
          status = excluded.status,
          status_reason = excluded.status_reason,
          is_active = excluded.is_active,
          proxy_url = excluded.proxy_url
      `)
      .run({
        id: validated.id,
        provider: validated.provider,
        email: validated.email,
        name: validated.name ?? null,
        avatarUrl: validated.avatar_url ?? null,
        tokenJson: encryptJson(validated.token),
        quotaJson: validated.quota ? encryptJson(validated.quota) : null,
        createdAt: validated.created_at,
        lastUsed: validated.last_used,
        status: validated.status ?? 'active',
        statusReason: validated.status_reason ?? null,
        isActive: validated.is_active ? 1 : 0,
        proxyUrl: validated.proxy_url ?? null,
      });
  }

  static async removeAccount(accountId: string): Promise<void> {
    this.getDatabase().prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  static async updateToken(accountId: string, token: CloudAccount['token']): Promise<void> {
    this.getDatabase()
      .prepare('UPDATE accounts SET token_json = ? WHERE id = ?')
      .run(encryptJson(token), accountId);
  }

  static async updateQuota(accountId: string, quota: CloudQuotaData): Promise<void> {
    this.getDatabase()
      .prepare('UPDATE accounts SET quota_json = ? WHERE id = ?')
      .run(encryptJson(quota), accountId);
  }

  static async updateLastUsed(accountId: string): Promise<void> {
    this.getDatabase()
      .prepare('UPDATE accounts SET last_used = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), accountId);
  }
}
