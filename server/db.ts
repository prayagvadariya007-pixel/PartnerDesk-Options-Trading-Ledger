import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  buildTradeGroupKey,
  computePartnershipAndSettlement,
  computeTradeGroupMetrics,
  DEFAULT_CHARGE_RATES,
  round2,
} from '../shared/calculations.ts';
import type {
  AuditLogRecord,
  ChargeRates,
  ChargesMode,
  DashboardSummary,
  DepositRecord,
  ExtractedOrderLeg,
  FundEntryType,
  OptionType,
  OrderSide,
  PartnerId,
  SettlementPreview,
  SettlementRecord,
  TradeGroupRecord,
  TradeOrderRecord,
} from '../shared/types.ts';

type SqlParam = string | number | null;

interface DbExecutor {
  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): Promise<{ changes: number; lastInsertRowid?: number }>;
  insertReturningId(sql: string, ...params: SqlParam[]): Promise<number>;
}

const PG_URL = (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
const IS_POSTGRES = PG_URL.length > 0;
const IS_VERCEL = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

function toPgSql(sql: string): string {
  let idx = 0;
  let inSingleQuote = false;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inSingleQuote && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingleQuote) {
      idx += 1;
      out += `$${idx}`;
    } else {
      out += ch;
    }
  }
  return out;
}

let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let initPromise: Promise<void> | null = null;
let sqliteTxChain: Promise<void> = Promise.resolve();

function getWritableSqliteDir(): string {
  if (IS_VERCEL) {
    return path.join(os.tmpdir(), 'partnerdesk_data');
  }
  const preferred = path.resolve(process.cwd(), 'data');
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(os.tmpdir(), 'partnerdesk_data');
  }
}

async function initDatabase(): Promise<void> {
  if (IS_POSTGRES) {
    const sslDisabled = /sslmode=disable/i.test(PG_URL);
    const needsSsl =
      !sslDisabled &&
      (/sslmode=(require|verify-ca|verify-full|prefer)/i.test(PG_URL) ||
        /neon\.tech|supabase\.|vercel-storage|amazonaws\.com/i.test(PG_URL) ||
        IS_VERCEL);

    pgPool = new Pool({
      connectionString: PG_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS uploads (
        id SERIAL PRIMARY KEY,
        image_hash TEXT UNIQUE NOT NULL,
        image_data_url TEXT NOT NULL,
        original_filename TEXT,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trade_groups (
        id SERIAL PRIMARY KEY,
        group_key TEXT UNIQUE NOT NULL,
        trading_date TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        stock_name TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        strike_price DOUBLE PRECISION NOT NULL,
        option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
        buy_qty INTEGER NOT NULL DEFAULT 0,
        sell_qty INTEGER NOT NULL DEFAULT 0,
        avg_buy_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        avg_sell_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_buy_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_sell_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        realised_qty INTEGER NOT NULL DEFAULT 0,
        open_qty INTEGER NOT NULL DEFAULT 0,
        open_side TEXT,
        gross_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        brokerage DOUBLE PRECISION NOT NULL DEFAULT 0,
        stt DOUBLE PRECISION NOT NULL DEFAULT 0,
        exchange_txn_charge DOUBLE PRECISION NOT NULL DEFAULT 0,
        sebi_charge DOUBLE PRECISION NOT NULL DEFAULT 0,
        stamp_duty DOUBLE PRECISION NOT NULL DEFAULT 0,
        ipft_charge DOUBLE PRECISION NOT NULL DEFAULT 0,
        gst DOUBLE PRECISION NOT NULL DEFAULT 0,
        other_charges DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_charges DOUBLE PRECISION NOT NULL DEFAULT 0,
        net_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
        charges_mode TEXT NOT NULL DEFAULT 'ESTIMATED' CHECK(charges_mode IN ('ESTIMATED', 'CONTRACT_NOTE')),
        contract_note_ref TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        trade_group_id INTEGER NOT NULL REFERENCES trade_groups(id) ON DELETE CASCADE,
        upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
        trading_date TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        stock_name TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        strike_price DOUBLE PRECISION NOT NULL,
        option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
        side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
        quantity INTEGER NOT NULL,
        lots INTEGER,
        execution_price DOUBLE PRECISION NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        execution_time TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_screenshots (
        trade_group_id INTEGER NOT NULL REFERENCES trade_groups(id) ON DELETE CASCADE,
        upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
        PRIMARY KEY (trade_group_id, upload_id)
      );

      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        partner TEXT NOT NULL CHECK(partner IN ('Prayag', 'Raj')),
        entry_type TEXT NOT NULL DEFAULT 'DEPOSIT' CHECK(entry_type IN ('DEPOSIT', 'WITHDRAWAL')),
        amount DOUBLE PRECISION NOT NULL CHECK(amount > 0),
        deposit_date TEXT NOT NULL,
        reference_note TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settlements (
        id SERIAL PRIMARY KEY,
        settlement_date TEXT NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        settled_gross_pnl DOUBLE PRECISION NOT NULL,
        settled_total_charges DOUBLE PRECISION NOT NULL,
        settled_net_pnl DOUBLE PRECISION NOT NULL,
        owner_profit_share DOUBLE PRECISION NOT NULL,
        raj_profit_share DOUBLE PRECISION NOT NULL,
        owner_outstanding_before DOUBLE PRECISION NOT NULL,
        raj_outstanding_before DOUBLE PRECISION NOT NULL,
        owner_outstanding_adjusted DOUBLE PRECISION NOT NULL,
        raj_outstanding_adjusted DOUBLE PRECISION NOT NULL,
        owner_remaining_outstanding DOUBLE PRECISION NOT NULL,
        raj_remaining_outstanding DOUBLE PRECISION NOT NULL,
        owner_payable DOUBLE PRECISION NOT NULL,
        raj_payable DOUBLE PRECISION NOT NULL,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        summary TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    return;
  }

  const dataDir = getWritableSqliteDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'partnerdesk.db');
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_hash TEXT UNIQUE NOT NULL,
      image_data_url TEXT NOT NULL,
      original_filename TEXT,
      uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key TEXT UNIQUE NOT NULL,
      trading_date TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      trading_symbol TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      strike_price REAL NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
      buy_qty INTEGER NOT NULL DEFAULT 0,
      sell_qty INTEGER NOT NULL DEFAULT 0,
      avg_buy_price REAL NOT NULL DEFAULT 0,
      avg_sell_price REAL NOT NULL DEFAULT 0,
      total_buy_amount REAL NOT NULL DEFAULT 0,
      total_sell_amount REAL NOT NULL DEFAULT 0,
      realised_qty INTEGER NOT NULL DEFAULT 0,
      open_qty INTEGER NOT NULL DEFAULT 0,
      open_side TEXT,
      gross_pnl REAL NOT NULL DEFAULT 0,
      brokerage REAL NOT NULL DEFAULT 0,
      stt REAL NOT NULL DEFAULT 0,
      exchange_txn_charge REAL NOT NULL DEFAULT 0,
      sebi_charge REAL NOT NULL DEFAULT 0,
      stamp_duty REAL NOT NULL DEFAULT 0,
      ipft_charge REAL NOT NULL DEFAULT 0,
      gst REAL NOT NULL DEFAULT 0,
      other_charges REAL NOT NULL DEFAULT 0,
      total_charges REAL NOT NULL DEFAULT 0,
      net_pnl REAL NOT NULL DEFAULT 0,
      charges_mode TEXT NOT NULL DEFAULT 'ESTIMATED' CHECK(charges_mode IN ('ESTIMATED', 'CONTRACT_NOTE')),
      contract_note_ref TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_group_id INTEGER NOT NULL REFERENCES trade_groups(id) ON DELETE CASCADE,
      upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
      trading_date TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      trading_symbol TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      strike_price REAL NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
      side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      quantity INTEGER NOT NULL,
      lots INTEGER,
      execution_price REAL NOT NULL,
      amount REAL NOT NULL,
      execution_time TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_screenshots (
      trade_group_id INTEGER NOT NULL REFERENCES trade_groups(id) ON DELETE CASCADE,
      upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      PRIMARY KEY (trade_group_id, upload_id)
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner TEXT NOT NULL CHECK(partner IN ('Prayag', 'Raj')),
      entry_type TEXT NOT NULL DEFAULT 'DEPOSIT' CHECK(entry_type IN ('DEPOSIT', 'WITHDRAWAL')),
      amount REAL NOT NULL CHECK(amount > 0),
      deposit_date TEXT NOT NULL,
      reference_note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_date TEXT NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      settled_gross_pnl REAL NOT NULL,
      settled_total_charges REAL NOT NULL,
      settled_net_pnl REAL NOT NULL,
      owner_profit_share REAL NOT NULL,
      raj_profit_share REAL NOT NULL,
      owner_outstanding_before REAL NOT NULL,
      raj_outstanding_before REAL NOT NULL,
      owner_outstanding_adjusted REAL NOT NULL,
      raj_outstanding_adjusted REAL NOT NULL,
      owner_remaining_outstanding REAL NOT NULL,
      raj_remaining_outstanding REAL NOT NULL,
      owner_payable REAL NOT NULL,
      raj_payable REAL NOT NULL,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      summary TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const tbl = sqliteDb
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deposits'")
    .get() as { sql?: string } | undefined;
  if (tbl?.sql && tbl.sql.includes("'Owner'")) {
    sqliteDb.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE deposits_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        partner TEXT NOT NULL CHECK(partner IN ('Prayag', 'Raj')),
        entry_type TEXT NOT NULL DEFAULT 'DEPOSIT' CHECK(entry_type IN ('DEPOSIT', 'WITHDRAWAL')),
        amount REAL NOT NULL CHECK(amount > 0),
        deposit_date TEXT NOT NULL,
        reference_note TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO deposits_new (id, partner, entry_type, amount, deposit_date, reference_note, created_by, created_at)
      SELECT id, CASE WHEN partner = 'Owner' THEN 'Prayag' ELSE partner END, 'DEPOSIT', amount, deposit_date, reference_note,
             CASE WHEN created_by = 'Owner' THEN 'Prayag' ELSE created_by END, created_at
      FROM deposits;
      DROP TABLE deposits;
      ALTER TABLE deposits_new RENAME TO deposits;
      UPDATE orders SET created_by = 'Prayag' WHERE created_by = 'Owner';
      UPDATE uploads SET uploaded_by = 'Prayag' WHERE uploaded_by = 'Owner';
      UPDATE settlements SET created_by = 'Prayag' WHERE created_by = 'Owner';
      UPDATE audit_logs SET actor = 'Prayag' WHERE actor = 'Owner';
      COMMIT;
    `);
  }

  const depCols = sqliteDb.prepare('PRAGMA table_info(deposits)').all() as { name: string }[];
  if (!depCols.some((c) => c.name === 'entry_type')) {
    sqliteDb.exec("ALTER TABLE deposits ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'DEPOSIT'");
  }

  sqliteDb.exec(`
    INSERT OR IGNORE INTO group_screenshots (trade_group_id, upload_id)
    SELECT DISTINCT trade_group_id, upload_id FROM orders WHERE upload_id IS NOT NULL;
  `);
}

export async function ensureDbReady(): Promise<void> {
  if (!initPromise) {
    initPromise = initDatabase().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

function makeSqliteExecutor(db: DatabaseSync): DbExecutor {
  return {
    async get<T>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, ...params: SqlParam[]) {
      const res = db.prepare(sql).run(...params);
      return {
        changes: Number(res.changes ?? 0),
        lastInsertRowid:
          res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
      };
    },
    async insertReturningId(sql: string, ...params: SqlParam[]): Promise<number> {
      const res = db.prepare(sql).run(...params);
      return Number(res.lastInsertRowid);
    },
  };
}

function makePgExecutor(runner: Pool | PoolClient): DbExecutor {
  return {
    async get<T>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
      const res = await runner.query<QueryResultRow>(toPgSql(sql), params);
      return res.rows[0] as T | undefined;
    },
    async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
      const res = await runner.query<QueryResultRow>(toPgSql(sql), params);
      return res.rows as T[];
    },
    async run(sql: string, ...params: SqlParam[]) {
      const res = await runner.query(toPgSql(sql), params);
      return { changes: Number(res.rowCount ?? 0) };
    },
    async insertReturningId(sql: string, ...params: SqlParam[]): Promise<number> {
      const cleaned = sql.trim().replace(/;+$/, '');
      const withReturning = /\bRETURNING\b/i.test(cleaned) ? cleaned : `${cleaned} RETURNING id`;
      const res = await runner.query<{ id: number | string }>(toPgSql(withReturning), params);
      return Number(res.rows[0]?.id);
    },
  };
}

async function getExecutor(): Promise<DbExecutor> {
  await ensureDbReady();
  if (IS_POSTGRES) {
    return makePgExecutor(pgPool!);
  }
  return makeSqliteExecutor(sqliteDb!);
}

async function runInTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  await ensureDbReady();
  if (IS_POSTGRES) {
    const client = await pgPool!.connect();
    try {
      await client.query('BEGIN');
      const tx = makePgExecutor(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  let releaseMutex!: () => void;
  const previous = sqliteTxChain;
  sqliteTxChain = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  await previous;

  const db = sqliteDb!;
  try {
    db.exec('BEGIN IMMEDIATE');
    const tx = makeSqliteExecutor(db);
    const result = await fn(tx);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw err;
  } finally {
    releaseMutex();
  }
}

export function getStorageInfo(): {
  engine: 'postgres' | 'sqlite';
  persistent: boolean;
} {
  return {
    engine: IS_POSTGRES ? 'postgres' : 'sqlite',
    persistent: IS_POSTGRES || !IS_VERCEL,
  };
}

// Session secret strictly in server memory fallback if SESSION_SECRET env is not set
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function nowIso(): string {
  return new Date().toISOString();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export async function getAuthStatus(): Promise<{
  needsInitialSetup: boolean;
  envPasswordConfigured: boolean;
}> {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    return { needsInitialSetup: false, envPasswordConfigured: true };
  }
  const db = await getExecutor();
  const row = await db.get<{ value: string }>(
    'SELECT value FROM app_config WHERE key = ?',
    'partner_password_hash',
  );
  return {
    needsInitialSetup: !row,
    envPasswordConfigured: false,
  };
}

export async function claimInitialPassword(password: string, actor: PartnerId): Promise<void> {
  const status = await getAuthStatus();
  if (!status.needsInitialSetup) {
    throw new Error('ALREADY_CONFIGURED');
  }
  const hash = hashPassword(password);
  const now = nowIso();
  const db = await getExecutor();
  await db.run(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)',
    'partner_password_hash',
    hash,
    now,
  );
  await logAudit(
    actor,
    'SETUP_PASSWORD',
    'AUTH',
    'shared',
    'Configured initial shared partnership password',
  );
}

export async function verifyPartnerPassword(password: string): Promise<boolean> {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(envPass, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const db = await getExecutor();
  const row = await db.get<{ value: string }>(
    'SELECT value FROM app_config WHERE key = ?',
    'partner_password_hash',
  );
  if (!row) return false;
  return verifyPasswordHash(password, row.value);
}

export async function updateSharedPassword(
  currentPassword: string,
  newPassword: string,
  actor: PartnerId,
): Promise<void> {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    throw new Error('ENV_PASSWORD_LOCKED');
  }
  if (!(await verifyPartnerPassword(currentPassword))) {
    throw new Error('INVALID_CURRENT_PASSWORD');
  }
  const hash = hashPassword(newPassword);
  const now = nowIso();
  const db = await getExecutor();
  await db.run(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    'partner_password_hash',
    hash,
    now,
  );
  await logAudit(
    actor,
    'UPDATE_PASSWORD',
    'AUTH',
    'shared',
    `${actor} updated the shared partnership password`,
  );
}

export interface SessionPayload {
  partnerId: PartnerId;
  iat: number;
  exp: number;
}

export function signSessionToken(partnerId: PartnerId): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    partnerId,
    iat: now,
    exp: now + 60 * 60 * 12,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (parsed.partnerId !== 'Prayag' && parsed.partnerId !== 'Raj') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function logAudit(
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  details?: unknown,
  tx?: DbExecutor,
): Promise<void> {
  const db = tx || (await getExecutor());
  await db.run(
    `INSERT INTO audit_logs (actor, action, entity_type, entity_id, summary, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    actor,
    action,
    entityType,
    entityId,
    summary,
    details !== undefined ? JSON.stringify(details) : null,
    nowIso(),
  );
}

export async function getChargeRates(tx?: DbExecutor): Promise<ChargeRates> {
  const db = tx || (await getExecutor());
  const row = await db.get<{ value: string }>(
    'SELECT value FROM app_config WHERE key = ?',
    'charge_rates',
  );
  if (!row) return { ...DEFAULT_CHARGE_RATES };
  try {
    const parsed = JSON.parse(row.value) as Partial<ChargeRates>;
    return {
      brokeragePerOrder: Number(parsed.brokeragePerOrder ?? DEFAULT_CHARGE_RATES.brokeragePerOrder),
      sttSellPct: Number(parsed.sttSellPct ?? DEFAULT_CHARGE_RATES.sttSellPct),
      exchangeTxnPct: Number(parsed.exchangeTxnPct ?? DEFAULT_CHARGE_RATES.exchangeTxnPct),
      ipftPct: Number(parsed.ipftPct ?? DEFAULT_CHARGE_RATES.ipftPct),
      sebiPct: Number(parsed.sebiPct ?? DEFAULT_CHARGE_RATES.sebiPct),
      stampDutyBuyPct: Number(parsed.stampDutyBuyPct ?? DEFAULT_CHARGE_RATES.stampDutyBuyPct),
      gstPct: Number(parsed.gstPct ?? DEFAULT_CHARGE_RATES.gstPct),
    };
  } catch {
    return { ...DEFAULT_CHARGE_RATES };
  }
}

export async function saveChargeRates(
  rates: ChargeRates,
  actor: PartnerId,
  recalculateEstimatedTrades = false,
): Promise<ChargeRates> {
  const safeRate = (val: unknown, fallback: number) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const clean: ChargeRates = {
    brokeragePerOrder: safeRate(rates.brokeragePerOrder, DEFAULT_CHARGE_RATES.brokeragePerOrder),
    sttSellPct: safeRate(rates.sttSellPct, DEFAULT_CHARGE_RATES.sttSellPct),
    exchangeTxnPct: safeRate(rates.exchangeTxnPct, DEFAULT_CHARGE_RATES.exchangeTxnPct),
    ipftPct: safeRate(rates.ipftPct, DEFAULT_CHARGE_RATES.ipftPct),
    sebiPct: safeRate(rates.sebiPct, DEFAULT_CHARGE_RATES.sebiPct),
    stampDutyBuyPct: safeRate(rates.stampDutyBuyPct, DEFAULT_CHARGE_RATES.stampDutyBuyPct),
    gstPct: safeRate(rates.gstPct, DEFAULT_CHARGE_RATES.gstPct),
  };

  await runInTransaction(async (tx) => {
    const now = nowIso();
    await tx.run(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      'charge_rates',
      JSON.stringify(clean),
      now,
    );

    if (recalculateEstimatedTrades) {
      const groups = await tx.all<{ id: number }>(
        "SELECT id FROM trade_groups WHERE charges_mode = 'ESTIMATED'",
      );
      for (const g of groups) {
        await recomputeTradeGroup(Number(g.id), clean, tx);
      }
    }

    await logAudit(
      actor,
      'UPDATE_RATES',
      'SETTINGS',
      'charge_rates',
      `${actor} updated Angel One & exchange charge rates${recalculateEstimatedTrades ? ' and recalculated estimated trades' : ''}`,
      clean,
      tx,
    );
  });

  return clean;
}

export async function checkDuplicateScreenshot(
  imageBase64DataUrl: string,
  tx?: DbExecutor,
): Promise<{
  imageHash: string;
  duplicate: { id: number; uploadedBy: string; uploadedAt: string; originalFilename: string | null } | null;
}> {
  const raw = imageBase64DataUrl.includes(',')
    ? imageBase64DataUrl.split(',')[1]
    : imageBase64DataUrl;
  const imageHash = crypto.createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex');
  const db = tx || (await getExecutor());
  const row = await db.get<{
    id: number;
    uploaded_by: string;
    uploaded_at: string;
    original_filename: string | null;
  }>(
    'SELECT id, uploaded_by, uploaded_at, original_filename FROM uploads WHERE image_hash = ?',
    imageHash,
  );
  return {
    imageHash,
    duplicate: row
      ? {
          id: Number(row.id),
          uploadedBy: row.uploaded_by,
          uploadedAt: row.uploaded_at,
          originalFilename: row.original_filename,
        }
      : null,
  };
}

function mapOrderRow(row: Record<string, unknown>): TradeOrderRecord {
  return {
    id: Number(row.id),
    tradeGroupId: Number(row.trade_group_id),
    uploadId: row.upload_id !== null && row.upload_id !== undefined ? Number(row.upload_id) : null,
    tradingDate: String(row.trading_date),
    uploadedAt: String(row.uploaded_at),
    stockName: String(row.stock_name),
    tradingSymbol: String(row.trading_symbol),
    expiryDate: String(row.expiry_date),
    strikePrice: Number(row.strike_price),
    optionType: String(row.option_type) as OptionType,
    side: String(row.side) as OrderSide,
    quantity: Number(row.quantity),
    lots: row.lots !== null && row.lots !== undefined ? Number(row.lots) : null,
    executionPrice: Number(row.execution_price),
    amount: Number(row.amount),
    executionTime: String(row.execution_time),
    createdBy: String(row.created_by) as PartnerId,
    createdAt: String(row.created_at),
  };
}

function mapTradeGroupRow(row: Record<string, unknown>): TradeGroupRecord {
  return {
    id: Number(row.id),
    groupKey: String(row.group_key),
    tradingDate: String(row.trading_date),
    uploadedAt: String(row.uploaded_at),
    stockName: String(row.stock_name),
    tradingSymbol: String(row.trading_symbol),
    expiryDate: String(row.expiry_date),
    strikePrice: Number(row.strike_price),
    optionType: String(row.option_type) as OptionType,
    buyQty: Number(row.buy_qty),
    sellQty: Number(row.sell_qty),
    avgBuyPrice: Number(row.avg_buy_price),
    avgSellPrice: Number(row.avg_sell_price),
    totalBuyAmount: Number(row.total_buy_amount),
    totalSellAmount: Number(row.total_sell_amount),
    realisedQty: Number(row.realised_qty),
    openQty: Number(row.open_qty),
    openSide: row.open_side ? (String(row.open_side) as OrderSide) : null,
    grossPnl: Number(row.gross_pnl),
    brokerage: Number(row.brokerage),
    stt: Number(row.stt),
    exchangeTxnCharge: Number(row.exchange_txn_charge),
    sebiCharge: Number(row.sebi_charge),
    stampDuty: Number(row.stamp_duty),
    ipftCharge: Number(row.ipft_charge),
    gst: Number(row.gst),
    otherCharges: Number(row.other_charges),
    totalCharges: Number(row.total_charges),
    netPnl: Number(row.net_pnl),
    chargesMode: String(row.charges_mode) as ChargesMode,
    contractNoteRef: row.contract_note_ref ? String(row.contract_note_ref) : null,
    notes: row.notes ? String(row.notes) : null,
    updatedAt: String(row.updated_at),
  };
}

export async function recomputeTradeGroup(
  tradeGroupId: number,
  ratesOverride?: ChargeRates,
  tx?: DbExecutor,
): Promise<TradeGroupRecord | null> {
  const db = tx || (await getExecutor());
  const groupRow = await db.get<Record<string, unknown>>(
    'SELECT * FROM trade_groups WHERE id = ?',
    tradeGroupId,
  );
  if (!groupRow) return null;

  const orderRows = await db.all<Record<string, unknown>>(
    'SELECT * FROM orders WHERE trade_group_id = ? ORDER BY id ASC',
    tradeGroupId,
  );

  if (orderRows.length === 0) {
    await db.run('DELETE FROM trade_groups WHERE id = ?', tradeGroupId);
    return null;
  }

  const orders = orderRows.map(mapOrderRow);
  const rates = ratesOverride || (await getChargeRates(db));
  const existing = mapTradeGroupRow(groupRow);

  const contractOverride =
    existing.chargesMode === 'CONTRACT_NOTE'
      ? {
          brokerage: existing.brokerage,
          stt: existing.stt,
          exchangeTxnCharge: existing.exchangeTxnCharge,
          ipftCharge: existing.ipftCharge,
          sebiCharge: existing.sebiCharge,
          stampDuty: existing.stampDuty,
          gst: existing.gst,
          otherCharges: existing.otherCharges,
        }
      : null;

  const computed = computeTradeGroupMetrics(
    orders.map((o) => ({
      side: o.side,
      quantity: o.quantity,
      executionPrice: o.executionPrice,
      amount: o.amount,
    })),
    rates,
    contractOverride,
  );

  const now = nowIso();
  await db.run(
    `UPDATE trade_groups SET
      buy_qty = ?, sell_qty = ?, avg_buy_price = ?, avg_sell_price = ?,
      total_buy_amount = ?, total_sell_amount = ?, realised_qty = ?, open_qty = ?, open_side = ?,
      gross_pnl = ?, brokerage = ?, stt = ?, exchange_txn_charge = ?, sebi_charge = ?,
      stamp_duty = ?, ipft_charge = ?, gst = ?, other_charges = ?, total_charges = ?,
      net_pnl = ?, updated_at = ?
     WHERE id = ?`,
    computed.buyQty,
    computed.sellQty,
    computed.avgBuyPrice,
    computed.avgSellPrice,
    computed.totalBuyAmount,
    computed.totalSellAmount,
    computed.realisedQty,
    computed.openQty,
    computed.openSide,
    computed.grossPnl,
    computed.brokerage,
    computed.stt,
    computed.exchangeTxnCharge,
    computed.sebiCharge,
    computed.stampDuty,
    computed.ipftCharge,
    computed.gst,
    computed.otherCharges,
    computed.totalCharges,
    computed.netPnl,
    now,
    tradeGroupId,
  );

  return getTradeGroupById(tradeGroupId, db);
}

export async function saveUploadedOrders(params: {
  actor: PartnerId;
  screenshotDataUrl?: string | null;
  originalFilename?: string | null;
  orders: ExtractedOrderLeg[];
}): Promise<{
  uploadId: number | null;
  uploadedAt: string;
  affectedTrades: TradeGroupRecord[];
}> {
  const uploadedAt = nowIso();

  return runInTransaction(async (tx) => {
    let uploadId: number | null = null;

    if (params.screenshotDataUrl && params.screenshotDataUrl.trim().length > 0) {
      const { imageHash, duplicate } = await checkDuplicateScreenshot(
        params.screenshotDataUrl,
        tx,
      );
      if (duplicate) {
        throw new Error(
          `DUPLICATE_SCREENSHOT:${duplicate.uploadedAt}:${duplicate.uploadedBy}`,
        );
      }
      uploadId = await tx.insertReturningId(
        `INSERT INTO uploads (image_hash, image_data_url, original_filename, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?)`,
        imageHash,
        params.screenshotDataUrl,
        params.originalFilename || null,
        params.actor,
        uploadedAt,
      );
    }

    const rates = await getChargeRates(tx);
    const touchedGroupIds = new Set<number>();

    for (const leg of params.orders) {
      const stockName = leg.stockName.trim().toUpperCase();
      const tradingSymbol = (
        leg.tradingSymbol || `${stockName} ${leg.strikePrice} ${leg.optionType}`
      )
        .trim()
        .toUpperCase();
      const tradingDate = leg.tradingDate.trim();
      const expiryDate = leg.expiryDate.trim();
      const strikePrice = Number(leg.strikePrice);
      const optionType = leg.optionType;
      const side = leg.side;
      const quantity = Math.round(Number(leg.quantity));
      const executionPrice = Number(leg.executionPrice);
      const amount = round2(Number(leg.amount) > 0 ? Number(leg.amount) : quantity * executionPrice);
      const groupKey = buildTradeGroupKey({
        tradingDate,
        stockName,
        expiryDate,
        strikePrice,
        optionType,
      });

      let existingGroup = await tx.get<{ id: number }>(
        'SELECT id FROM trade_groups WHERE group_key = ?',
        groupKey,
      );

      let groupId: number;
      if (!existingGroup) {
        groupId = await tx.insertReturningId(
          `INSERT INTO trade_groups (
            group_key, trading_date, uploaded_at, stock_name, trading_symbol, expiry_date,
            strike_price, option_type, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          groupKey,
          tradingDate,
          uploadedAt,
          stockName,
          tradingSymbol,
          expiryDate,
          strikePrice,
          optionType,
          uploadedAt,
        );
      } else {
        groupId = Number(existingGroup.id);
      }

      await tx.run(
        `INSERT INTO orders (
          trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
          expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
          amount, execution_time, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        groupId,
        uploadId,
        tradingDate,
        uploadedAt,
        stockName,
        tradingSymbol,
        expiryDate,
        strikePrice,
        optionType,
        side,
        quantity,
        leg.lots !== null && leg.lots !== undefined ? Number(leg.lots) : null,
        executionPrice,
        amount,
        leg.executionTime || '09:15 AM',
        params.actor,
        uploadedAt,
      );

      if (uploadId !== null) {
        await tx.run(
          'INSERT INTO group_screenshots (trade_group_id, upload_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
          groupId,
          uploadId,
        );
      }

      touchedGroupIds.add(groupId);
    }

    const affectedTrades: TradeGroupRecord[] = [];
    for (const gid of touchedGroupIds) {
      const updated = await recomputeTradeGroup(gid, rates, tx);
      if (updated) affectedTrades.push(updated);
    }

    await logAudit(
      params.actor,
      'SAVE_TRADE',
      'TRADE',
      affectedTrades.map((t) => t.id).join(','),
      `${params.actor} saved ${params.orders.length} order leg(s) across ${affectedTrades.length} trade group(s)`,
      {
        uploadId,
        orderCount: params.orders.length,
        symbols: affectedTrades.map((t) => `${t.stockName} ${t.strikePrice} ${t.optionType}`),
      },
      tx,
    );

    return { uploadId, uploadedAt, affectedTrades };
  });
}

export async function listTradeGroups(tx?: DbExecutor): Promise<TradeGroupRecord[]> {
  const db = tx || (await getExecutor());
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM trade_groups ORDER BY trading_date DESC, id DESC',
  );
  if (rows.length === 0) return [];

  const allOrderRows = await db.all<Record<string, unknown>>(
    'SELECT * FROM orders ORDER BY id ASC',
  );
  const ordersByGroup = new Map<number, TradeOrderRecord[]>();
  for (const r of allOrderRows) {
    const mapped = mapOrderRow(r);
    const list = ordersByGroup.get(mapped.tradeGroupId) || [];
    list.push(mapped);
    ordersByGroup.set(mapped.tradeGroupId, list);
  }

  const screenshotLinks = await db.all<{
    trade_group_id: number;
    id: number;
    image_data_url: string;
    original_filename: string | null;
    uploaded_by: string;
    uploaded_at: string;
  }>(
    `SELECT DISTINCT links.trade_group_id, u.id, u.image_data_url, u.original_filename, u.uploaded_by, u.uploaded_at
     FROM (
       SELECT trade_group_id, upload_id FROM group_screenshots
       UNION
       SELECT trade_group_id, upload_id FROM orders WHERE upload_id IS NOT NULL
     ) links
     JOIN uploads u ON u.id = links.upload_id
     ORDER BY u.id DESC`,
  );
  const screenshotsByGroup = new Map<number, TradeGroupRecord['screenshots']>();
  for (const u of screenshotLinks) {
    const gid = Number(u.trade_group_id);
    const list = screenshotsByGroup.get(gid) || [];
    list.push({
      id: Number(u.id),
      imageDataUrl: u.image_data_url,
      originalFilename: u.original_filename,
      uploadedBy: u.uploaded_by as PartnerId,
      uploadedAt: u.uploaded_at,
    });
    screenshotsByGroup.set(gid, list);
  }

  return rows.map((row) => {
    const group = mapTradeGroupRow(row);
    group.orders = ordersByGroup.get(group.id) || [];
    group.screenshots = screenshotsByGroup.get(group.id) || [];
    return group;
  });
}

export async function getTradeGroupById(
  id: number,
  tx?: DbExecutor,
): Promise<TradeGroupRecord | null> {
  const db = tx || (await getExecutor());
  const row = await db.get<Record<string, unknown>>('SELECT * FROM trade_groups WHERE id = ?', id);
  if (!row) return null;
  const group = mapTradeGroupRow(row);
  const orderRows = await db.all<Record<string, unknown>>(
    'SELECT * FROM orders WHERE trade_group_id = ? ORDER BY id ASC',
    id,
  );
  group.orders = orderRows.map(mapOrderRow);
  const uploadRows = await db.all<{
    id: number;
    image_data_url: string;
    original_filename: string | null;
    uploaded_by: string;
    uploaded_at: string;
  }>(
    `SELECT DISTINCT u.id, u.image_data_url, u.original_filename, u.uploaded_by, u.uploaded_at
     FROM uploads u
     WHERE u.id IN (
       SELECT upload_id FROM group_screenshots WHERE trade_group_id = ?
       UNION
       SELECT upload_id FROM orders WHERE trade_group_id = ? AND upload_id IS NOT NULL
     )
     ORDER BY u.id DESC`,
    id,
    id,
  );
  group.screenshots = uploadRows.map((u) => ({
    id: Number(u.id),
    imageDataUrl: u.image_data_url,
    originalFilename: u.original_filename,
    uploadedBy: u.uploaded_by as PartnerId,
    uploadedAt: u.uploaded_at,
  }));
  return group;
}

export async function updateTradeGroupDetails(
  id: number,
  actor: PartnerId,
  payload: {
    tradingDate?: string;
    stockName?: string;
    tradingSymbol?: string;
    expiryDate?: string;
    strikePrice?: number;
    optionType?: OptionType;
    notes?: string | null;
    orders?: {
      id?: number;
      side: OrderSide;
      quantity: number;
      lots: number | null;
      executionPrice: number;
      amount: number;
      executionTime: string;
    }[];
    contractNote?: {
      mode: ChargesMode;
      contractNoteRef?: string | null;
      brokerage?: number;
      stt?: number;
      exchangeTxnCharge?: number;
      ipftCharge?: number;
      sebiCharge?: number;
      stampDuty?: number;
      gst?: number;
      otherCharges?: number;
    };
  },
): Promise<TradeGroupRecord | null> {
  return runInTransaction(async (tx) => {
    const existing = await getTradeGroupById(id, tx);
    if (!existing) return null;

    const tradingDate = payload.tradingDate ?? existing.tradingDate;
    const stockName = (payload.stockName ?? existing.stockName).trim().toUpperCase();
    const tradingSymbol = (payload.tradingSymbol ?? existing.tradingSymbol).trim().toUpperCase();
    const expiryDate = payload.expiryDate ?? existing.expiryDate;
    const strikePrice = Number(payload.strikePrice ?? existing.strikePrice);
    const optionType = payload.optionType ?? existing.optionType;
    const notes = payload.notes !== undefined ? payload.notes : existing.notes;
    const groupKey = buildTradeGroupKey({
      tradingDate,
      stockName,
      expiryDate,
      strikePrice,
      optionType,
    });

    const now = nowIso();
    await tx.run(
      `UPDATE trade_groups SET
        group_key = ?, trading_date = ?, stock_name = ?, trading_symbol = ?,
        expiry_date = ?, strike_price = ?, option_type = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      groupKey,
      tradingDate,
      stockName,
      tradingSymbol,
      expiryDate,
      strikePrice,
      optionType,
      notes,
      now,
      id,
    );

    if (payload.orders && payload.orders.length > 0) {
      const existingOrderIds = new Set((existing.orders || []).map((o) => o.id));
      const incomingIds = new Set(
        payload.orders.filter((o) => typeof o.id === 'number').map((o) => Number(o.id)),
      );

      for (const oldId of existingOrderIds) {
        if (!incomingIds.has(oldId)) {
          await tx.run('DELETE FROM orders WHERE id = ? AND trade_group_id = ?', oldId, id);
        }
      }

      for (const o of payload.orders) {
        const amt = round2(o.amount > 0 ? o.amount : o.quantity * o.executionPrice);
        if (o.id && existingOrderIds.has(o.id)) {
          await tx.run(
            `UPDATE orders SET
              trading_date = ?, stock_name = ?, trading_symbol = ?, expiry_date = ?,
              strike_price = ?, option_type = ?, side = ?, quantity = ?, lots = ?,
              execution_price = ?, amount = ?, execution_time = ?
             WHERE id = ? AND trade_group_id = ?`,
            tradingDate,
            stockName,
            tradingSymbol,
            expiryDate,
            strikePrice,
            optionType,
            o.side,
            Math.round(o.quantity),
            o.lots,
            o.executionPrice,
            amt,
            o.executionTime,
            o.id,
            id,
          );
        } else {
          await tx.run(
            `INSERT INTO orders (
              trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
              expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
              amount, execution_time, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            null,
            tradingDate,
            existing.uploadedAt,
            stockName,
            tradingSymbol,
            expiryDate,
            strikePrice,
            optionType,
            o.side,
            Math.round(o.quantity),
            o.lots,
            o.executionPrice,
            amt,
            o.executionTime || '09:15 AM',
            actor,
            now,
          );
        }
      }
    } else {
      await tx.run(
        `UPDATE orders SET
          trading_date = ?, stock_name = ?, trading_symbol = ?, expiry_date = ?,
          strike_price = ?, option_type = ?
         WHERE trade_group_id = ?`,
        tradingDate,
        stockName,
        tradingSymbol,
        expiryDate,
        strikePrice,
        optionType,
        id,
      );
    }

    if (payload.contractNote) {
      if (payload.contractNote.mode === 'CONTRACT_NOTE') {
        await tx.run(
          `UPDATE trade_groups SET
            charges_mode = 'CONTRACT_NOTE',
            contract_note_ref = ?,
            brokerage = ?, stt = ?, exchange_txn_charge = ?, ipft_charge = ?,
            sebi_charge = ?, stamp_duty = ?, gst = ?, other_charges = ?, updated_at = ?
           WHERE id = ?`,
          payload.contractNote.contractNoteRef || null,
          round2(payload.contractNote.brokerage ?? existing.brokerage),
          round2(payload.contractNote.stt ?? existing.stt),
          round2(payload.contractNote.exchangeTxnCharge ?? existing.exchangeTxnCharge),
          round2(payload.contractNote.ipftCharge ?? existing.ipftCharge),
          round2(payload.contractNote.sebiCharge ?? existing.sebiCharge),
          round2(payload.contractNote.stampDuty ?? existing.stampDuty),
          round2(payload.contractNote.gst ?? existing.gst),
          round2(payload.contractNote.otherCharges ?? existing.otherCharges),
          now,
          id,
        );
      } else {
        await tx.run(
          `UPDATE trade_groups SET charges_mode = 'ESTIMATED', contract_note_ref = NULL, other_charges = 0, updated_at = ? WHERE id = ?`,
          now,
          id,
        );
      }
    }

    const updated = await recomputeTradeGroup(id, undefined, tx);
    await logAudit(
      actor,
      payload.contractNote ? 'RECONCILE_TRADE' : 'UPDATE_TRADE',
      'TRADE',
      String(id),
      `${actor} updated trade ${stockName} ${strikePrice} ${optionType} (${tradingDate})`,
      undefined,
      tx,
    );

    return updated;
  });
}

export async function deleteTradeGroup(id: number, actor: PartnerId): Promise<boolean> {
  return runInTransaction(async (tx) => {
    const existing = await getTradeGroupById(id, tx);
    if (!existing) return false;

    const uploadIds = await tx.all<{ upload_id: number }>(
      `SELECT upload_id FROM group_screenshots WHERE trade_group_id = ?
       UNION
       SELECT DISTINCT upload_id FROM orders WHERE trade_group_id = ? AND upload_id IS NOT NULL`,
      id,
      id,
    );

    await tx.run('DELETE FROM trade_groups WHERE id = ?', id);

    for (const u of uploadIds) {
      const uid = Number(u.upload_id);
      const stillInOrders = await tx.get('SELECT 1 FROM orders WHERE upload_id = ? LIMIT 1', uid);
      const stillInLinks = await tx.get(
        'SELECT 1 FROM group_screenshots WHERE upload_id = ? LIMIT 1',
        uid,
      );
      if (!stillInOrders && !stillInLinks) {
        await tx.run('DELETE FROM uploads WHERE id = ?', uid);
      }
    }

    await logAudit(
      actor,
      'DELETE_TRADE',
      'TRADE',
      String(id),
      `${actor} deleted trade ${existing.stockName} ${existing.strikePrice} ${existing.optionType} (${existing.tradingDate})`,
      { grossPnl: existing.grossPnl, netPnl: existing.netPnl },
      tx,
    );

    return true;
  });
}

export async function listDeposits(tx?: DbExecutor): Promise<DepositRecord[]> {
  const db = tx || (await getExecutor());
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM deposits ORDER BY deposit_date DESC, id DESC',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    partner: String(r.partner) as PartnerId,
    entryType: (r.entry_type === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT') as FundEntryType,
    amount: Number(r.amount),
    depositDate: String(r.deposit_date),
    referenceNote: r.reference_note ? String(r.reference_note) : null,
    createdBy: String(r.created_by) as PartnerId,
    createdAt: String(r.created_at),
  }));
}

export async function addDeposit(params: {
  partner: PartnerId;
  entryType?: FundEntryType;
  amount: number;
  depositDate: string;
  referenceNote?: string | null;
  actor: PartnerId;
}): Promise<DepositRecord> {
  const cleanAmt = round2(Number(params.amount));
  if (!Number.isFinite(cleanAmt) || cleanAmt <= 0) {
    throw new Error('INVALID_AMOUNT');
  }
  const entryType: FundEntryType = params.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
  const now = nowIso();

  return runInTransaction(async (tx) => {
    const id = await tx.insertReturningId(
      `INSERT INTO deposits (partner, entry_type, amount, deposit_date, reference_note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params.partner,
      entryType,
      cleanAmt,
      params.depositDate,
      params.referenceNote?.trim() || null,
      params.actor,
      now,
    );
    await logAudit(
      params.actor,
      entryType === 'WITHDRAWAL' ? 'WITHDRAWAL_RECORDED' : 'ADD_DEPOSIT',
      'DEPOSIT',
      String(id),
      entryType === 'WITHDRAWAL'
        ? `${params.actor} recorded ₹${cleanAmt.toLocaleString('en-IN')} fund withdrawal for ${params.partner}`
        : `${params.actor} recorded ₹${cleanAmt.toLocaleString('en-IN')} capital deposit for ${params.partner}`,
      { partner: params.partner, entryType, amount: cleanAmt, depositDate: params.depositDate },
      tx,
    );
    return {
      id,
      partner: params.partner,
      entryType,
      amount: cleanAmt,
      depositDate: params.depositDate,
      referenceNote: params.referenceNote?.trim() || null,
      createdBy: params.actor,
      createdAt: now,
    };
  });
}

export async function deleteDeposit(id: number, actor: PartnerId): Promise<boolean> {
  return runInTransaction(async (tx) => {
    const existing = await tx.get<Record<string, unknown>>(
      'SELECT * FROM deposits WHERE id = ?',
      id,
    );
    if (!existing) return false;
    const isWithdrawal = existing.entry_type === 'WITHDRAWAL';
    await tx.run('DELETE FROM deposits WHERE id = ?', id);
    await logAudit(
      actor,
      isWithdrawal ? 'WITHDRAWAL_DELETED' : 'DELETE_DEPOSIT',
      'DEPOSIT',
      String(id),
      `${actor} removed ${isWithdrawal ? 'withdrawal' : 'deposit'} #${id} (₹${Number(existing.amount).toLocaleString('en-IN')} by ${existing.partner})`,
      undefined,
      tx,
    );
    return true;
  });
}

export async function listSettlements(tx?: DbExecutor): Promise<SettlementRecord[]> {
  const db = tx || (await getExecutor());
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM settlements ORDER BY settlement_date DESC, id DESC',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    settlementDate: String(r.settlement_date),
    idempotencyKey: String(r.idempotency_key),
    settledGrossPnl: Number(r.settled_gross_pnl),
    settledTotalCharges: Number(r.settled_total_charges),
    settledNetPnl: Number(r.settled_net_pnl),
    ownerProfitShare: Number(r.owner_profit_share),
    rajProfitShare: Number(r.raj_profit_share),
    ownerOutstandingBefore: Number(r.owner_outstanding_before),
    rajOutstandingBefore: Number(r.raj_outstanding_before),
    ownerOutstandingAdjusted: Number(r.owner_outstanding_adjusted),
    rajOutstandingAdjusted: Number(r.raj_outstanding_adjusted),
    ownerRemainingOutstanding: Number(r.owner_remaining_outstanding),
    rajRemainingOutstanding: Number(r.raj_remaining_outstanding),
    ownerPayable: Number(r.owner_payable),
    rajPayable: Number(r.raj_payable),
    notes: r.notes ? String(r.notes) : null,
    createdBy: String(r.created_by) as PartnerId,
    createdAt: String(r.created_at),
  }));
}

export async function getSettlementPreview(): Promise<SettlementPreview> {
  const [trades, deposits, settlements] = await Promise.all([
    listTradeGroups(),
    listDeposits(),
    listSettlements(),
  ]);
  return computePartnershipAndSettlement(trades, deposits, settlements);
}

export async function createSettlement(params: {
  settlementDate: string;
  idempotencyKey: string;
  notes?: string | null;
  actor: PartnerId;
}): Promise<SettlementRecord> {
  return runInTransaction(async (tx) => {
    const existingByKey = await tx.get(
      'SELECT id FROM settlements WHERE idempotency_key = ?',
      params.idempotencyKey,
    );
    if (existingByKey) {
      throw new Error('DUPLICATE_SETTLEMENT');
    }

    const trades = await listTradeGroups(tx);
    const deposits = await listDeposits(tx);
    const settlements = await listSettlements(tx);
    const preview = computePartnershipAndSettlement(trades, deposits, settlements);

    if (!preview.canSettle) {
      throw new Error('NOTHING_TO_SETTLE');
    }

    const settledGrossPrior = settlements.reduce((s, st) => s + st.settledGrossPnl, 0);
    const settledChargesPrior = settlements.reduce((s, st) => s + st.settledTotalCharges, 0);
    const settledGrossDelta = round2(preview.totalRealisedGrossPnl - settledGrossPrior);
    const settledChargesDelta = round2(preview.totalRealisedCharges - settledChargesPrior);

    const now = nowIso();
    const id = await tx.insertReturningId(
      `INSERT INTO settlements (
        settlement_date, idempotency_key, settled_gross_pnl, settled_total_charges,
        settled_net_pnl, owner_profit_share, raj_profit_share,
        owner_outstanding_before, raj_outstanding_before,
        owner_outstanding_adjusted, raj_outstanding_adjusted,
        owner_remaining_outstanding, raj_remaining_outstanding,
        owner_payable, raj_payable, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.settlementDate,
      params.idempotencyKey,
      settledGrossDelta,
      settledChargesDelta,
      preview.unsettledNetPnl,
      preview.ownerProfitShare,
      preview.rajProfitShare,
      preview.ownerOutstandingBefore,
      preview.rajOutstandingBefore,
      preview.ownerOutstandingAdjusted,
      preview.rajOutstandingAdjusted,
      preview.ownerRemainingOutstanding,
      preview.rajRemainingOutstanding,
      preview.ownerPayable,
      preview.rajPayable,
      params.notes?.trim() || null,
      params.actor,
      now,
    );

    await logAudit(
      params.actor,
      'CREATE_SETTLEMENT',
      'SETTLEMENT',
      String(id),
      `${params.actor} confirmed settlement #${id}: Net ₹${preview.unsettledNetPnl.toLocaleString('en-IN')} (Prayag payable ₹${preview.ownerPayable.toLocaleString('en-IN')}, Raj payable ₹${preview.rajPayable.toLocaleString('en-IN')})`,
      preview,
      tx,
    );

    return {
      id,
      settlementDate: params.settlementDate,
      idempotencyKey: params.idempotencyKey,
      settledGrossPnl: settledGrossDelta,
      settledTotalCharges: settledChargesDelta,
      settledNetPnl: preview.unsettledNetPnl,
      ownerProfitShare: preview.ownerProfitShare,
      rajProfitShare: preview.rajProfitShare,
      ownerOutstandingBefore: preview.ownerOutstandingBefore,
      rajOutstandingBefore: preview.rajOutstandingBefore,
      ownerOutstandingAdjusted: preview.ownerOutstandingAdjusted,
      rajOutstandingAdjusted: preview.rajOutstandingAdjusted,
      ownerRemainingOutstanding: preview.ownerRemainingOutstanding,
      rajRemainingOutstanding: preview.rajRemainingOutstanding,
      ownerPayable: preview.ownerPayable,
      rajPayable: preview.rajPayable,
      notes: params.notes?.trim() || null,
      createdBy: params.actor,
      createdAt: now,
    };
  });
}

export async function getDashboardSummary(): Promise<{
  summary: DashboardSummary;
  settlementPreview: SettlementPreview;
  recentTrades: TradeGroupRecord[];
  openPositions: TradeGroupRecord[];
  recentDeposits: DepositRecord[];
  recentSettlements: SettlementRecord[];
}> {
  const [trades, deposits, settlements] = await Promise.all([
    listTradeGroups(),
    listDeposits(),
    listSettlements(),
  ]);
  const preview = computePartnershipAndSettlement(trades, deposits, settlements);

  const totalBuyAmount = round2(trades.reduce((s, t) => s + t.totalBuyAmount, 0));
  const totalSellAmount = round2(trades.reduce((s, t) => s + t.totalSellAmount, 0));

  const realisedTrades = trades.filter((t) => t.realisedQty > 0);
  const winningTrades = realisedTrades.filter((t) => t.netPnl > 0).length;
  const losingTrades = realisedTrades.filter((t) => t.netPnl < 0).length;
  const openPositions = trades.filter((t) => t.openQty > 0);

  const totalDistributedAmount = round2(
    settlements.reduce((s, st) => s + st.ownerPayable + st.rajPayable, 0),
  );

  const summary: DashboardSummary = {
    totalPartnershipCapital: preview.totalPartnershipCapital,
    totalAccountBalance: preview.totalAccountBalance,
    ownerTotalContribution: preview.ownerTotalDeposits,
    rajTotalContribution: preview.rajTotalDeposits,
    ownerOwnershipBalance: preview.ownerOwnershipBalance,
    rajOwnershipBalance: preview.rajOwnershipBalance,
    ownerPaidOutAmount: preview.ownerPaidOutSoFar,
    rajPaidOutAmount: preview.rajPaidOutSoFar,
    eachCapitalObligation: preview.eachCapitalObligation,
    ownerOutstandingAmount: preview.ownerOutstandingBefore,
    rajOutstandingAmount: preview.rajOutstandingBefore,
    totalBuyAmount,
    totalSellAmount,
    totalGrossPnl: preview.totalRealisedGrossPnl,
    totalBrokerageAndTaxes: preview.totalRealisedCharges,
    totalNetPnl: preview.totalRealisedNetPnl,
    ownerProfitShare: round2(preview.totalRealisedNetPnl / 2),
    rajProfitShare: round2(preview.totalRealisedNetPnl - round2(preview.totalRealisedNetPnl / 2)),
    totalDistributedAmount,
    pendingSettlementAmount: preview.unsettledNetPnl,
    totalClosedTrades: realisedTrades.length,
    winningTrades,
    losingTrades,
    openPositionsCount: openPositions.length,
  };

  return {
    summary,
    settlementPreview: preview,
    recentTrades: trades.slice(0, 8),
    openPositions,
    recentDeposits: deposits.slice(0, 6),
    recentSettlements: settlements.slice(0, 5),
  };
}

export async function listAuditLogs(limit = 100, tx?: DbExecutor): Promise<AuditLogRecord[]> {
  const db = tx || (await getExecutor());
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?',
    limit,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    actor: String(r.actor),
    action: String(r.action),
    entityType: String(r.entity_type),
    entityId: r.entity_id !== null && r.entity_id !== undefined ? String(r.entity_id) : null,
    summary: String(r.summary),
    detailsJson: r.details_json ? String(r.details_json) : null,
    createdAt: String(r.created_at),
  }));
}

export interface ServerBackupPayload {
  format: 'partnerdesk-local-backup-v1';
  folderName: 'PartnerDesk_Data';
  exportedAt: string;
  chargeRates: ChargeRates;
  deposits: DepositRecord[];
  uploads: {
    id: number;
    imageHash: string;
    imageDataUrl: string;
    originalFilename: string | null;
    uploadedBy: PartnerId;
    uploadedAt: string;
  }[];
  tradeGroups: TradeGroupRecord[];
  orders: TradeOrderRecord[];
  auditLogs: AuditLogRecord[];
}

export async function exportServerBackupPayload(): Promise<ServerBackupPayload> {
  const db = await getExecutor();
  const [uploadRows, groupRows, orderRows, chargeRates, deposits, auditLogs] = await Promise.all([
    db.all<{
      id: number;
      image_hash: string;
      image_data_url: string;
      original_filename: string | null;
      uploaded_by: string;
      uploaded_at: string;
    }>(
      'SELECT id, image_hash, image_data_url, original_filename, uploaded_by, uploaded_at FROM uploads ORDER BY id ASC',
    ),
    db.all<Record<string, unknown>>('SELECT * FROM trade_groups ORDER BY trading_date DESC, id DESC'),
    db.all<Record<string, unknown>>('SELECT * FROM orders ORDER BY id ASC'),
    getChargeRates(db),
    listDeposits(db),
    listAuditLogs(500, db),
  ]);

  return {
    format: 'partnerdesk-local-backup-v1',
    folderName: 'PartnerDesk_Data',
    exportedAt: nowIso(),
    chargeRates,
    deposits,
    uploads: uploadRows.map((u) => ({
      id: Number(u.id),
      imageHash: u.image_hash,
      imageDataUrl: u.image_data_url,
      originalFilename: u.original_filename,
      uploadedBy: (u.uploaded_by === 'Raj' ? 'Raj' : 'Prayag') as PartnerId,
      uploadedAt: u.uploaded_at,
    })),
    tradeGroups: groupRows.map(mapTradeGroupRow),
    orders: orderRows.map(mapOrderRow),
    auditLogs,
  };
}

export async function mergeServerBackupPayload(
  payload: Partial<ServerBackupPayload>,
  actor: PartnerId,
): Promise<{ addedTrades: number; addedDeposits: number; addedScreenshots: number }> {
  const uploadsInput = Array.isArray(payload.uploads) ? payload.uploads : [];
  const groupsInput = Array.isArray(payload.tradeGroups) ? payload.tradeGroups : [];
  const ordersInput = Array.isArray(payload.orders) ? payload.orders : [];
  const depositsInput = Array.isArray(payload.deposits) ? payload.deposits : [];

  return runInTransaction(async (tx) => {
    const uploadIdRemap = new Map<number, number>();
    const groupIdRemap = new Map<number, number>();
    const touchedGroupIds = new Set<number>();

    let addedScreenshots = 0;
    let addedTrades = 0;
    let addedDeposits = 0;

    for (const u of uploadsInput) {
      if (!u || typeof u.imageDataUrl !== 'string' || !u.imageDataUrl.trim()) continue;
      const raw = u.imageDataUrl.includes(',') ? u.imageDataUrl.split(',')[1] : u.imageDataUrl;
      const computedHash = crypto
        .createHash('sha256')
        .update(Buffer.from(raw, 'base64'))
        .digest('hex');
      const existing = await tx.get<{ id: number }>(
        'SELECT id FROM uploads WHERE image_hash = ?',
        computedHash,
      );
      if (existing) {
        if (typeof u.id === 'number') uploadIdRemap.set(u.id, Number(existing.id));
      } else {
        const newId = await tx.insertReturningId(
          `INSERT INTO uploads (image_hash, image_data_url, original_filename, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?)`,
          computedHash,
          u.imageDataUrl,
          u.originalFilename || null,
          u.uploadedBy === 'Raj' ? 'Raj' : 'Prayag',
          u.uploadedAt || nowIso(),
        );
        if (typeof u.id === 'number') uploadIdRemap.set(u.id, newId);
        addedScreenshots += 1;
      }
    }

    for (const g of groupsInput) {
      if (!g || typeof g.stockName !== 'string' || typeof g.tradingDate !== 'string') continue;
      const cleanKey = buildTradeGroupKey({
        tradingDate: g.tradingDate,
        stockName: g.stockName,
        expiryDate: g.expiryDate,
        strikePrice: Number(g.strikePrice),
        optionType: g.optionType === 'PE' ? 'PE' : 'CE',
      });
      const existing = await tx.get<{ id: number }>(
        'SELECT id FROM trade_groups WHERE group_key = ?',
        cleanKey,
      );
      if (existing) {
        if (typeof g.id === 'number') groupIdRemap.set(g.id, Number(existing.id));
      } else {
        const newId = await tx.insertReturningId(
          `INSERT INTO trade_groups (
            group_key, trading_date, uploaded_at, stock_name, trading_symbol, expiry_date,
            strike_price, option_type, charges_mode, contract_note_ref, notes,
            brokerage, stt, exchange_txn_charge, sebi_charge, stamp_duty, ipft_charge, gst, other_charges,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          cleanKey,
          g.tradingDate,
          g.uploadedAt || nowIso(),
          g.stockName.trim().toUpperCase(),
          (g.tradingSymbol || `${g.stockName} ${g.strikePrice} ${g.optionType}`)
            .trim()
            .toUpperCase(),
          g.expiryDate,
          Number(g.strikePrice),
          g.optionType === 'PE' ? 'PE' : 'CE',
          g.chargesMode === 'CONTRACT_NOTE' ? 'CONTRACT_NOTE' : 'ESTIMATED',
          g.contractNoteRef || null,
          g.notes || null,
          Number(g.brokerage || 0),
          Number(g.stt || 0),
          Number(g.exchangeTxnCharge || 0),
          Number(g.sebiCharge || 0),
          Number(g.stampDuty || 0),
          Number(g.ipftCharge || 0),
          Number(g.gst || 0),
          Number(g.otherCharges || 0),
          g.updatedAt || nowIso(),
        );
        if (typeof g.id === 'number') groupIdRemap.set(g.id, newId);
        touchedGroupIds.add(newId);
        addedTrades += 1;
      }
    }

    const existingOrders = await tx.all<{
      trade_group_id: number;
      side: string;
      quantity: number;
      execution_price: number;
      amount: number;
      execution_time: string;
    }>('SELECT trade_group_id, side, quantity, execution_price, amount, execution_time FROM orders');
    const orderSigs = new Set(
      existingOrders.map(
        (o) =>
          `${Number(o.trade_group_id)}|${o.side}|${Number(o.quantity)}|${Number(o.execution_price)}|${Number(o.amount)}|${o.execution_time}`,
      ),
    );

    for (const o of ordersInput) {
      if (!o || typeof o.tradeGroupId !== 'number') continue;
      const targetGroupId = groupIdRemap.get(o.tradeGroupId);
      if (!targetGroupId) continue;

      const mappedUploadId =
        typeof o.uploadId === 'number' ? (uploadIdRemap.get(o.uploadId) ?? null) : null;
      const side = o.side === 'SELL' ? 'SELL' : 'BUY';
      const quantity = Math.round(Number(o.quantity));
      const executionPrice = Number(o.executionPrice);
      const amount = round2(Number(o.amount) > 0 ? Number(o.amount) : quantity * executionPrice);
      const executionTime = String(o.executionTime || '09:15 AM');

      const sig = `${targetGroupId}|${side}|${quantity}|${executionPrice}|${amount}|${executionTime}`;
      if (!orderSigs.has(sig)) {
        await tx.run(
          `INSERT INTO orders (
            trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
            expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
            amount, execution_time, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          targetGroupId,
          mappedUploadId,
          o.tradingDate,
          o.uploadedAt || nowIso(),
          o.stockName.trim().toUpperCase(),
          (o.tradingSymbol || `${o.stockName} ${o.strikePrice} ${o.optionType}`)
            .trim()
            .toUpperCase(),
          o.expiryDate,
          Number(o.strikePrice),
          o.optionType === 'PE' ? 'PE' : 'CE',
          side,
          quantity,
          o.lots !== null && o.lots !== undefined ? Number(o.lots) : null,
          executionPrice,
          amount,
          executionTime,
          o.createdBy === 'Raj' ? 'Raj' : 'Prayag',
          o.createdAt || nowIso(),
        );
        orderSigs.add(sig);
        touchedGroupIds.add(targetGroupId);
      }

      if (mappedUploadId !== null) {
        await tx.run(
          'INSERT INTO group_screenshots (trade_group_id, upload_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
          targetGroupId,
          mappedUploadId,
        );
      }
    }

    const existingDeps = await listDeposits(tx);
    const depSigs = new Set(
      existingDeps.map(
        (d) =>
          `${d.depositDate}|${d.partner}|${d.entryType || 'DEPOSIT'}|${d.amount}|${d.createdAt}`,
      ),
    );
    for (const d of depositsInput) {
      if (!d || typeof d.depositDate !== 'string') continue;
      const amt = round2(Number(d.amount));
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const partner: PartnerId = d.partner === 'Raj' ? 'Raj' : 'Prayag';
      const entryType: FundEntryType = d.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
      const createdAt = d.createdAt || nowIso();
      const sig = `${d.depositDate}|${partner}|${entryType}|${amt}|${createdAt}`;
      if (depSigs.has(sig)) continue;
      await tx.run(
        `INSERT INTO deposits (partner, entry_type, amount, deposit_date, reference_note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        partner,
        entryType,
        amt,
        d.depositDate,
        d.referenceNote?.trim() || null,
        d.createdBy === 'Raj' ? 'Raj' : 'Prayag',
        createdAt,
      );
      depSigs.add(sig);
      addedDeposits += 1;
    }

    const rates = await getChargeRates(tx);
    for (const gid of touchedGroupIds) {
      await recomputeTradeGroup(gid, rates, tx);
    }

    if (addedTrades > 0 || addedDeposits > 0 || addedScreenshots > 0) {
      await logAudit(
        actor,
        'SYNC_MERGE',
        'BACKUP',
        null,
        `${actor} merged ${addedTrades} trade(s), ${addedDeposits} fund entry(s), ${addedScreenshots} screenshot(s) into shared ledger`,
        undefined,
        tx,
      );
    }

    return { addedTrades, addedDeposits, addedScreenshots };
  });
}
