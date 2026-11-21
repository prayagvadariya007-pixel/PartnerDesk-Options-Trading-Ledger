import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'partnerdesk.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
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

// Safe migration if deposits table was previously created with 'Owner'
{
  const tbl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deposits'")
    .get() as { sql?: string } | undefined;
  if (tbl?.sql && tbl.sql.includes("'Owner'")) {
    db.exec(`
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

  const depCols = db.prepare('PRAGMA table_info(deposits)').all() as { name: string }[];
  if (!depCols.some((c) => c.name === 'entry_type')) {
    db.exec("ALTER TABLE deposits ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'DEPOSIT'");
  }

  db.exec(`
    INSERT OR IGNORE INTO group_screenshots (trade_group_id, upload_id)
    SELECT DISTINCT trade_group_id, upload_id FROM orders WHERE upload_id IS NOT NULL;
  `);
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

export function getAuthStatus(): {
  needsInitialSetup: boolean;
  envPasswordConfigured: boolean;
} {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    return { needsInitialSetup: false, envPasswordConfigured: true };
  }
  const row = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get('partner_password_hash') as { value: string } | undefined;
  return {
    needsInitialSetup: !row,
    envPasswordConfigured: false,
  };
}

export function claimInitialPassword(password: string, actor: PartnerId): void {
  const status = getAuthStatus();
  if (!status.needsInitialSetup) {
    throw new Error('ALREADY_CONFIGURED');
  }
  const hash = hashPassword(password);
  const now = nowIso();
  db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)',
  ).run('partner_password_hash', hash, now);
  logAudit(actor, 'SETUP_PASSWORD', 'AUTH', 'shared', 'Configured initial shared partnership password');
}

export function verifyPartnerPassword(password: string): boolean {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(envPass, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const row = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get('partner_password_hash') as { value: string } | undefined;
  if (!row) return false;
  return verifyPasswordHash(password, row.value);
}

export function updateSharedPassword(
  currentPassword: string,
  newPassword: string,
  actor: PartnerId,
): void {
  const envPass = (process.env.PARTNER_ACCESS_PASSWORD || '').trim();
  if (envPass.length > 0) {
    throw new Error('ENV_PASSWORD_LOCKED');
  }
  if (!verifyPartnerPassword(currentPassword)) {
    throw new Error('INVALID_CURRENT_PASSWORD');
  }
  const hash = hashPassword(newPassword);
  const now = nowIso();
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('partner_password_hash', hash, now);
  logAudit(actor, 'UPDATE_PASSWORD', 'AUTH', 'shared', `${actor} updated the shared partnership password`);
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
    exp: now + 60 * 60 * 12, // 12 hours
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

export function logAudit(
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  details?: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_logs (actor, action, entity_type, entity_id, summary, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actor,
    action,
    entityType,
    entityId,
    summary,
    details !== undefined ? JSON.stringify(details) : null,
    nowIso(),
  );
}

export function getChargeRates(): ChargeRates {
  const row = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get('charge_rates') as { value: string } | undefined;
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

export function saveChargeRates(
  rates: ChargeRates,
  actor: PartnerId,
  recalculateEstimatedTrades = false,
): ChargeRates {
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
  const now = nowIso();
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('charge_rates', JSON.stringify(clean), now);

  if (recalculateEstimatedTrades) {
    const groups = db
      .prepare("SELECT id FROM trade_groups WHERE charges_mode = 'ESTIMATED'")
      .all() as { id: number }[];
    for (const g of groups) {
      recomputeTradeGroup(g.id, clean);
    }
  }

  logAudit(
    actor,
    'UPDATE_RATES',
    'SETTINGS',
    'charge_rates',
    `${actor} updated Angel One & exchange charge rates${recalculateEstimatedTrades ? ' and recalculated estimated trades' : ''}`,
    clean,
  );
  return clean;
}

export function checkDuplicateScreenshot(imageBase64DataUrl: string): {
  imageHash: string;
  duplicate: { id: number; uploadedBy: string; uploadedAt: string; originalFilename: string | null } | null;
} {
  const raw = imageBase64DataUrl.includes(',')
    ? imageBase64DataUrl.split(',')[1]
    : imageBase64DataUrl;
  const imageHash = crypto.createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex');
  const row = db
    .prepare('SELECT id, uploaded_by, uploaded_at, original_filename FROM uploads WHERE image_hash = ?')
    .get(imageHash) as
    | { id: number; uploaded_by: string; uploaded_at: string; original_filename: string | null }
    | undefined;
  return {
    imageHash,
    duplicate: row
      ? {
          id: row.id,
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

export function recomputeTradeGroup(tradeGroupId: number, ratesOverride?: ChargeRates): TradeGroupRecord | null {
  const groupRow = db
    .prepare('SELECT * FROM trade_groups WHERE id = ?')
    .get(tradeGroupId) as Record<string, unknown> | undefined;
  if (!groupRow) return null;

  const orderRows = db
    .prepare('SELECT * FROM orders WHERE trade_group_id = ? ORDER BY id ASC')
    .all(tradeGroupId) as Record<string, unknown>[];

  if (orderRows.length === 0) {
    db.prepare('DELETE FROM trade_groups WHERE id = ?').run(tradeGroupId);
    return null;
  }

  const orders = orderRows.map(mapOrderRow);
  const rates = ratesOverride || getChargeRates();
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
  db.prepare(
    `UPDATE trade_groups SET
      buy_qty = ?, sell_qty = ?, avg_buy_price = ?, avg_sell_price = ?,
      total_buy_amount = ?, total_sell_amount = ?, realised_qty = ?, open_qty = ?, open_side = ?,
      gross_pnl = ?, brokerage = ?, stt = ?, exchange_txn_charge = ?, sebi_charge = ?,
      stamp_duty = ?, ipft_charge = ?, gst = ?, other_charges = ?, total_charges = ?,
      net_pnl = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
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

  return getTradeGroupById(tradeGroupId);
}

export function saveUploadedOrders(params: {
  actor: PartnerId;
  screenshotDataUrl?: string | null;
  originalFilename?: string | null;
  orders: ExtractedOrderLeg[];
}): {
  uploadId: number | null;
  uploadedAt: string;
  affectedTrades: TradeGroupRecord[];
} {
  const uploadedAt = nowIso();
  let uploadId: number | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (params.screenshotDataUrl && params.screenshotDataUrl.trim().length > 0) {
      const { imageHash, duplicate } = checkDuplicateScreenshot(params.screenshotDataUrl);
      if (duplicate) {
        throw new Error(
          `DUPLICATE_SCREENSHOT:${duplicate.uploadedAt}:${duplicate.uploadedBy}`,
        );
      }
      const insertUpload = db
        .prepare(
          `INSERT INTO uploads (image_hash, image_data_url, original_filename, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          imageHash,
          params.screenshotDataUrl,
          params.originalFilename || null,
          params.actor,
          uploadedAt,
        );
      uploadId = Number(insertUpload.lastInsertRowid);
    }

    const rates = getChargeRates();
    const touchedGroupIds = new Set<number>();

    for (const leg of params.orders) {
      const stockName = leg.stockName.trim().toUpperCase();
      const tradingSymbol = (leg.tradingSymbol || `${stockName} ${leg.strikePrice} ${leg.optionType}`).trim().toUpperCase();
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

      let existingGroup = db
        .prepare('SELECT id FROM trade_groups WHERE group_key = ?')
        .get(groupKey) as { id: number } | undefined;

      if (!existingGroup) {
        const res = db
          .prepare(
            `INSERT INTO trade_groups (
              group_key, trading_date, uploaded_at, stock_name, trading_symbol, expiry_date,
              strike_price, option_type, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
        existingGroup = { id: Number(res.lastInsertRowid) };
      }

      db.prepare(
        `INSERT INTO orders (
          trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
          expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
          amount, execution_time, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        existingGroup.id,
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
        db.prepare(
          'INSERT OR IGNORE INTO group_screenshots (trade_group_id, upload_id) VALUES (?, ?)',
        ).run(existingGroup.id, uploadId);
      }

      touchedGroupIds.add(existingGroup.id);
    }

    const affectedTrades: TradeGroupRecord[] = [];
    for (const gid of touchedGroupIds) {
      const updated = recomputeTradeGroup(gid, rates);
      if (updated) affectedTrades.push(updated);
    }

    logAudit(
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
    );

    db.exec('COMMIT');
    return { uploadId, uploadedAt, affectedTrades };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listTradeGroups(): TradeGroupRecord[] {
  const rows = db
    .prepare('SELECT * FROM trade_groups ORDER BY trading_date DESC, id DESC')
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const group = mapTradeGroupRow(row);
    const orderRows = db
      .prepare('SELECT * FROM orders WHERE trade_group_id = ? ORDER BY id ASC')
      .all(group.id) as Record<string, unknown>[];
    group.orders = orderRows.map(mapOrderRow);
    const uploadRows = db
      .prepare(
        `SELECT DISTINCT u.id, u.image_data_url, u.original_filename, u.uploaded_by, u.uploaded_at
         FROM uploads u
         WHERE u.id IN (
           SELECT upload_id FROM group_screenshots WHERE trade_group_id = ?
           UNION
           SELECT upload_id FROM orders WHERE trade_group_id = ? AND upload_id IS NOT NULL
         )
         ORDER BY u.id DESC`,
      )
      .all(group.id, group.id) as {
      id: number;
      image_data_url: string;
      original_filename: string | null;
      uploaded_by: string;
      uploaded_at: string;
    }[];
    group.screenshots = uploadRows.map((u) => ({
      id: Number(u.id),
      imageDataUrl: u.image_data_url,
      originalFilename: u.original_filename,
      uploadedBy: u.uploaded_by as PartnerId,
      uploadedAt: u.uploaded_at,
    }));
    return group;
  });
}

export function getTradeGroupById(id: number): TradeGroupRecord | null {
  const row = db.prepare('SELECT * FROM trade_groups WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const group = mapTradeGroupRow(row);
  const orderRows = db
    .prepare('SELECT * FROM orders WHERE trade_group_id = ? ORDER BY id ASC')
    .all(id) as Record<string, unknown>[];
  group.orders = orderRows.map(mapOrderRow);
  const uploadRows = db
    .prepare(
      `SELECT DISTINCT u.id, u.image_data_url, u.original_filename, u.uploaded_by, u.uploaded_at
       FROM uploads u
       WHERE u.id IN (
         SELECT upload_id FROM group_screenshots WHERE trade_group_id = ?
         UNION
         SELECT upload_id FROM orders WHERE trade_group_id = ? AND upload_id IS NOT NULL
       )
       ORDER BY u.id DESC`,
    )
    .all(id, id) as {
    id: number;
    image_data_url: string;
    original_filename: string | null;
    uploaded_by: string;
    uploaded_at: string;
  }[];
  group.screenshots = uploadRows.map((u) => ({
    id: Number(u.id),
    imageDataUrl: u.image_data_url,
    originalFilename: u.original_filename,
    uploadedBy: u.uploaded_by as PartnerId,
    uploadedAt: u.uploaded_at,
  }));
  return group;
}

export function updateTradeGroupDetails(
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
): TradeGroupRecord | null {
  const existing = getTradeGroupById(id);
  if (!existing) return null;

  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.prepare(
      `UPDATE trade_groups SET
        group_key = ?, trading_date = ?, stock_name = ?, trading_symbol = ?,
        expiry_date = ?, strike_price = ?, option_type = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
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
          db.prepare('DELETE FROM orders WHERE id = ? AND trade_group_id = ?').run(oldId, id);
        }
      }

      for (const o of payload.orders) {
        const amt = round2(o.amount > 0 ? o.amount : o.quantity * o.executionPrice);
        if (o.id && existingOrderIds.has(o.id)) {
          db.prepare(
            `UPDATE orders SET
              trading_date = ?, stock_name = ?, trading_symbol = ?, expiry_date = ?,
              strike_price = ?, option_type = ?, side = ?, quantity = ?, lots = ?,
              execution_price = ?, amount = ?, execution_time = ?
             WHERE id = ? AND trade_group_id = ?`,
          ).run(
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
          db.prepare(
            `INSERT INTO orders (
              trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
              expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
              amount, execution_time, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
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
      db.prepare(
        `UPDATE orders SET
          trading_date = ?, stock_name = ?, trading_symbol = ?, expiry_date = ?,
          strike_price = ?, option_type = ?
         WHERE trade_group_id = ?`,
      ).run(tradingDate, stockName, tradingSymbol, expiryDate, strikePrice, optionType, id);
    }

    if (payload.contractNote) {
      if (payload.contractNote.mode === 'CONTRACT_NOTE') {
        db.prepare(
          `UPDATE trade_groups SET
            charges_mode = 'CONTRACT_NOTE',
            contract_note_ref = ?,
            brokerage = ?, stt = ?, exchange_txn_charge = ?, ipft_charge = ?,
            sebi_charge = ?, stamp_duty = ?, gst = ?, other_charges = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
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
        db.prepare(
          `UPDATE trade_groups SET charges_mode = 'ESTIMATED', contract_note_ref = NULL, other_charges = 0, updated_at = ? WHERE id = ?`,
        ).run(now, id);
      }
    }

    const updated = recomputeTradeGroup(id);
    logAudit(
      actor,
      payload.contractNote ? 'RECONCILE_TRADE' : 'UPDATE_TRADE',
      'TRADE',
      String(id),
      `${actor} updated trade ${stockName} ${strikePrice} ${optionType} (${tradingDate})`,
    );

    db.exec('COMMIT');
    return updated;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteTradeGroup(id: number, actor: PartnerId): boolean {
  const existing = getTradeGroupById(id);
  if (!existing) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    const uploadIds = db
      .prepare(
        `SELECT upload_id FROM group_screenshots WHERE trade_group_id = ?
         UNION
         SELECT DISTINCT upload_id FROM orders WHERE trade_group_id = ? AND upload_id IS NOT NULL`,
      )
      .all(id, id) as { upload_id: number }[];

    db.prepare('DELETE FROM trade_groups WHERE id = ?').run(id);

    for (const u of uploadIds) {
      const stillInOrders = db
        .prepare('SELECT 1 FROM orders WHERE upload_id = ? LIMIT 1')
        .get(u.upload_id);
      const stillInLinks = db
        .prepare('SELECT 1 FROM group_screenshots WHERE upload_id = ? LIMIT 1')
        .get(u.upload_id);
      if (!stillInOrders && !stillInLinks) {
        db.prepare('DELETE FROM uploads WHERE id = ?').run(u.upload_id);
      }
    }

    logAudit(
      actor,
      'DELETE_TRADE',
      'TRADE',
      String(id),
      `${actor} deleted trade ${existing.stockName} ${existing.strikePrice} ${existing.optionType} (${existing.tradingDate})`,
      { grossPnl: existing.grossPnl, netPnl: existing.netPnl },
    );

    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listDeposits(): DepositRecord[] {
  const rows = db
    .prepare('SELECT * FROM deposits ORDER BY deposit_date DESC, id DESC')
    .all() as Record<string, unknown>[];
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

export function addDeposit(params: {
  partner: PartnerId;
  entryType?: FundEntryType;
  amount: number;
  depositDate: string;
  referenceNote?: string | null;
  actor: PartnerId;
}): DepositRecord {
  const cleanAmt = round2(Number(params.amount));
  if (!Number.isFinite(cleanAmt) || cleanAmt <= 0) {
    throw new Error('INVALID_AMOUNT');
  }
  const entryType: FundEntryType = params.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO deposits (partner, entry_type, amount, deposit_date, reference_note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.partner,
      entryType,
      cleanAmt,
      params.depositDate,
      params.referenceNote?.trim() || null,
      params.actor,
      now,
    );
  const id = Number(res.lastInsertRowid);
  logAudit(
    params.actor,
    entryType === 'WITHDRAWAL' ? 'WITHDRAWAL_RECORDED' : 'ADD_DEPOSIT',
    'DEPOSIT',
    String(id),
    entryType === 'WITHDRAWAL'
      ? `${params.actor} recorded ₹${cleanAmt.toLocaleString('en-IN')} fund withdrawal for ${params.partner}`
      : `${params.actor} recorded ₹${cleanAmt.toLocaleString('en-IN')} capital deposit for ${params.partner}`,
    { partner: params.partner, entryType, amount: cleanAmt, depositDate: params.depositDate },
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
}

export function deleteDeposit(id: number, actor: PartnerId): boolean {
  const existing = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return false;
  const isWithdrawal = existing.entry_type === 'WITHDRAWAL';
  db.prepare('DELETE FROM deposits WHERE id = ?').run(id);
  logAudit(
    actor,
    isWithdrawal ? 'WITHDRAWAL_DELETED' : 'DELETE_DEPOSIT',
    'DEPOSIT',
    String(id),
    `${actor} removed ${isWithdrawal ? 'withdrawal' : 'deposit'} #${id} (₹${Number(existing.amount).toLocaleString('en-IN')} by ${existing.partner})`,
  );
  return true;
}

export function listSettlements(): SettlementRecord[] {
  const rows = db
    .prepare('SELECT * FROM settlements ORDER BY settlement_date DESC, id DESC')
    .all() as Record<string, unknown>[];
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

export function getSettlementPreview(): SettlementPreview {
  const trades = listTradeGroups();
  const deposits = listDeposits();
  const settlements = listSettlements();
  return computePartnershipAndSettlement(trades, deposits, settlements);
}

export function createSettlement(params: {
  settlementDate: string;
  idempotencyKey: string;
  notes?: string | null;
  actor: PartnerId;
}): SettlementRecord {
  const existingByKey = db
    .prepare('SELECT id FROM settlements WHERE idempotency_key = ?')
    .get(params.idempotencyKey);
  if (existingByKey) {
    throw new Error('DUPLICATE_SETTLEMENT');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const trades = listTradeGroups();
    const deposits = listDeposits();
    const settlements = listSettlements();
    const preview = computePartnershipAndSettlement(trades, deposits, settlements);

    if (!preview.canSettle) {
      throw new Error('NOTHING_TO_SETTLE');
    }

    const settledGrossPrior = settlements.reduce((s, st) => s + st.settledGrossPnl, 0);
    const settledChargesPrior = settlements.reduce((s, st) => s + st.settledTotalCharges, 0);
    const settledGrossDelta = round2(preview.totalRealisedGrossPnl - settledGrossPrior);
    const settledChargesDelta = round2(preview.totalRealisedCharges - settledChargesPrior);

    const now = nowIso();
    const res = db
      .prepare(
        `INSERT INTO settlements (
          settlement_date, idempotency_key, settled_gross_pnl, settled_total_charges,
          settled_net_pnl, owner_profit_share, raj_profit_share,
          owner_outstanding_before, raj_outstanding_before,
          owner_outstanding_adjusted, raj_outstanding_adjusted,
          owner_remaining_outstanding, raj_remaining_outstanding,
          owner_payable, raj_payable, notes, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

    const id = Number(res.lastInsertRowid);
    logAudit(
      params.actor,
      'CREATE_SETTLEMENT',
      'SETTLEMENT',
      String(id),
      `${params.actor} confirmed settlement #${id}: Net ₹${preview.unsettledNetPnl.toLocaleString('en-IN')} (Prayag payable ₹${preview.ownerPayable.toLocaleString('en-IN')}, Raj payable ₹${preview.rajPayable.toLocaleString('en-IN')})`,
      preview,
    );

    db.exec('COMMIT');
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
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getDashboardSummary(): {
  summary: DashboardSummary;
  settlementPreview: SettlementPreview;
  recentTrades: TradeGroupRecord[];
  openPositions: TradeGroupRecord[];
  recentDeposits: DepositRecord[];
  recentSettlements: SettlementRecord[];
} {
  const trades = listTradeGroups();
  const deposits = listDeposits();
  const settlements = listSettlements();
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

export function listAuditLogs(limit = 100): AuditLogRecord[] {
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
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

export function exportServerBackupPayload(): ServerBackupPayload {
  const uploadRows = db
    .prepare('SELECT id, image_hash, image_data_url, original_filename, uploaded_by, uploaded_at FROM uploads ORDER BY id ASC')
    .all() as {
    id: number;
    image_hash: string;
    image_data_url: string;
    original_filename: string | null;
    uploaded_by: string;
    uploaded_at: string;
  }[];

  const groupRows = db
    .prepare('SELECT * FROM trade_groups ORDER BY trading_date DESC, id DESC')
    .all() as Record<string, unknown>[];

  const orderRows = db
    .prepare('SELECT * FROM orders ORDER BY id ASC')
    .all() as Record<string, unknown>[];

  return {
    format: 'partnerdesk-local-backup-v1',
    folderName: 'PartnerDesk_Data',
    exportedAt: nowIso(),
    chargeRates: getChargeRates(),
    deposits: listDeposits(),
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
    auditLogs: listAuditLogs(500),
  };
}

export function mergeServerBackupPayload(
  payload: Partial<ServerBackupPayload>,
  actor: PartnerId,
): { addedTrades: number; addedDeposits: number; addedScreenshots: number } {
  const uploadsInput = Array.isArray(payload.uploads) ? payload.uploads : [];
  const groupsInput = Array.isArray(payload.tradeGroups) ? payload.tradeGroups : [];
  const ordersInput = Array.isArray(payload.orders) ? payload.orders : [];
  const depositsInput = Array.isArray(payload.deposits) ? payload.deposits : [];

  const uploadIdRemap = new Map<number, number>();
  const groupIdRemap = new Map<number, number>();
  const touchedGroupIds = new Set<number>();

  let addedScreenshots = 0;
  let addedTrades = 0;
  let addedDeposits = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Merge uploads deduplicated by byte SHA-256 hash
    for (const u of uploadsInput) {
      if (!u || typeof u.imageDataUrl !== 'string' || !u.imageDataUrl.trim()) continue;
      const raw = u.imageDataUrl.includes(',') ? u.imageDataUrl.split(',')[1] : u.imageDataUrl;
      const computedHash = crypto
        .createHash('sha256')
        .update(Buffer.from(raw, 'base64'))
        .digest('hex');
      const existing = db
        .prepare('SELECT id FROM uploads WHERE image_hash = ?')
        .get(computedHash) as { id: number } | undefined;
      if (existing) {
        if (typeof u.id === 'number') uploadIdRemap.set(u.id, existing.id);
      } else {
        const res = db
          .prepare(
            `INSERT INTO uploads (image_hash, image_data_url, original_filename, uploaded_by, uploaded_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            computedHash,
            u.imageDataUrl,
            u.originalFilename || null,
            u.uploadedBy === 'Raj' ? 'Raj' : 'Prayag',
            u.uploadedAt || nowIso(),
          );
        const newId = Number(res.lastInsertRowid);
        if (typeof u.id === 'number') uploadIdRemap.set(u.id, newId);
        addedScreenshots += 1;
      }
    }

    // 2. Merge trade groups deduplicated by groupKey
    for (const g of groupsInput) {
      if (!g || typeof g.stockName !== 'string' || typeof g.tradingDate !== 'string') continue;
      const cleanKey = buildTradeGroupKey({
        tradingDate: g.tradingDate,
        stockName: g.stockName,
        expiryDate: g.expiryDate,
        strikePrice: Number(g.strikePrice),
        optionType: g.optionType === 'PE' ? 'PE' : 'CE',
      });
      const existing = db
        .prepare('SELECT id FROM trade_groups WHERE group_key = ?')
        .get(cleanKey) as { id: number } | undefined;
      if (existing) {
        if (typeof g.id === 'number') groupIdRemap.set(g.id, existing.id);
      } else {
        const res = db
          .prepare(
            `INSERT INTO trade_groups (
              group_key, trading_date, uploaded_at, stock_name, trading_symbol, expiry_date,
              strike_price, option_type, charges_mode, contract_note_ref, notes,
              brokerage, stt, exchange_txn_charge, sebi_charge, stamp_duty, ipft_charge, gst, other_charges,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            cleanKey,
            g.tradingDate,
            g.uploadedAt || nowIso(),
            g.stockName.trim().toUpperCase(),
            (g.tradingSymbol || `${g.stockName} ${g.strikePrice} ${g.optionType}`).trim().toUpperCase(),
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
        const newId = Number(res.lastInsertRowid);
        if (typeof g.id === 'number') groupIdRemap.set(g.id, newId);
        touchedGroupIds.add(newId);
        addedTrades += 1;
      }
    }

    // 3. Merge individual order legs
    const existingOrders = db
      .prepare('SELECT trade_group_id, side, quantity, execution_price, amount, execution_time FROM orders')
      .all() as {
      trade_group_id: number;
      side: string;
      quantity: number;
      execution_price: number;
      amount: number;
      execution_time: string;
    }[];
    const orderSigs = new Set(
      existingOrders.map(
        (o) =>
          `${o.trade_group_id}|${o.side}|${o.quantity}|${o.execution_price}|${o.amount}|${o.execution_time}`,
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
        db.prepare(
          `INSERT INTO orders (
            trade_group_id, upload_id, trading_date, uploaded_at, stock_name, trading_symbol,
            expiry_date, strike_price, option_type, side, quantity, lots, execution_price,
            amount, execution_time, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetGroupId,
          mappedUploadId,
          o.tradingDate,
          o.uploadedAt || nowIso(),
          o.stockName.trim().toUpperCase(),
          (o.tradingSymbol || `${o.stockName} ${o.strikePrice} ${o.optionType}`).trim().toUpperCase(),
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
        db.prepare(
          'INSERT OR IGNORE INTO group_screenshots (trade_group_id, upload_id) VALUES (?, ?)',
        ).run(targetGroupId, mappedUploadId);
      }
    }

    // 4. Merge deposits / withdrawals deduplicated by signature
    const existingDeps = listDeposits();
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
      db.prepare(
        `INSERT INTO deposits (partner, entry_type, amount, deposit_date, reference_note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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

    const rates = getChargeRates();
    for (const gid of touchedGroupIds) {
      recomputeTradeGroup(gid, rates);
    }

    if (addedTrades > 0 || addedDeposits > 0 || addedScreenshots > 0) {
      logAudit(
        actor,
        'SYNC_MERGE',
        'BACKUP',
        null,
        `${actor} merged ${addedTrades} trade(s), ${addedDeposits} fund entry(s), ${addedScreenshots} screenshot(s) into shared ledger`,
      );
    }

    db.exec('COMMIT');
    return { addedTrades, addedDeposits, addedScreenshots };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
