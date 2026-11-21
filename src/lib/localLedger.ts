import {
  buildTradeGroupKey,
  computePartnershipAndSettlement,
  computeTradeGroupMetrics,
  DEFAULT_CHARGE_RATES,
  round2,
} from '../../shared/calculations.ts';
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
  TradeGroupRecord,
  TradeOrderRecord,
} from '../../shared/types.ts';
import { buildLedgerWorkbookBytes } from './exportExcel.ts';
import { todayIsoDate } from './format.ts';

const DB_NAME = 'PartnerDeskLocalDB';
const DB_VERSION = 1;
const FOLDER_NAME = 'PartnerDesk_Data';

export interface StoredUploadRecord {
  id: number;
  imageHash: string;
  imageDataUrl: string;
  originalFilename: string | null;
  uploadedBy: PartnerId;
  uploadedAt: string;
}

interface StoredGroupScreenshotLink {
  tradeGroupId: number;
  uploadId: number;
}

interface StoredMeta {
  key: string;
  value: unknown;
}

export interface LocalStorageStatus {
  tradesCount: number;
  ordersCount: number;
  screenshotsCount: number;
  depositsCount: number;
  auditLogsCount: number;
  persistentGranted: boolean | null;
  opfsAvailable: boolean;
  opfsSyncedAt: string | null;
  opfsFolderName: string;
  directoryPickerSupported: boolean;
  linkedFolderName: string | null;
  linkedFolderSyncedAt: string | null;
  linkedFolderNeedsPermission: boolean;
  estimatedUsageBytes: number | null;
  estimatedQuotaBytes: number | null;
}

export interface LocalBackupPayload {
  format: 'partnerdesk-local-backup-v1';
  folderName: 'PartnerDesk_Data';
  exportedAt: string;
  chargeRates: ChargeRates;
  deposits: DepositRecord[];
  uploads: StoredUploadRecord[];
  tradeGroups: TradeGroupRecord[];
  orders: TradeOrderRecord[];
  auditLogs: AuditLogRecord[];
}

export interface LocalDashboardPayload {
  summary: DashboardSummary;
  settlementPreview: SettlementPreview;
  recentTrades: TradeGroupRecord[];
  openPositions: TradeGroupRecord[];
  recentDeposits: DepositRecord[];
  recentSettlements: [];
}

interface FileSystemDirectoryHandleLike {
  name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    createWritable(): Promise<{
      write(data: BlobPart | Uint8Array): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let bootstrapPromise: Promise<void> | null = null;

function openLocalDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tradeGroups')) {
        db.createObjectStore('tradeGroups', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('orders')) {
        db.createObjectStore('orders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('uploads')) {
        db.createObjectStore('uploads', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('groupScreenshots')) {
        db.createObjectStore('groupScreenshots', { keyPath: ['tradeGroupId', 'uploadId'] });
      }
      if (!db.objectStoreNames.contains('deposits')) {
        db.createObjectStore('deposits', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('auditLogs')) {
        db.createObjectStore('auditLogs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Request durable device persistence silently so mobile/desktop browsers never evict records
      if (navigator.storage?.persist) {
        navigator.storage.persist().catch(() => {});
      }
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open local IndexedDB storage.'));
    };
  });
  return dbPromise;
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openLocalDb();
  const tx = db.transaction('meta', 'readonly');
  const rec = await idbReq<StoredMeta | undefined>(tx.objectStore('meta').get(key));
  return rec?.value as T | undefined;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value } satisfies StoredMeta);
  await idbTxDone(tx);
}

async function allocateId(counterKey: string, existingMax: number): Promise<number> {
  const current = (await getMeta<number>(counterKey)) ?? 0;
  const next = Math.max(current, existingMax) + 1;
  await setMeta(counterKey, next);
  return next;
}

async function getAllStore<T>(storeName: string): Promise<T[]> {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, 'readonly');
  return idbReq<T[]>(tx.objectStore(storeName).getAll());
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getRatesInternal(): Promise<ChargeRates> {
  const stored = await getMeta<ChargeRates>('chargeRates');
  return stored ? { ...DEFAULT_CHARGE_RATES, ...stored } : { ...DEFAULT_CHARGE_RATES };
}

async function appendAuditLog(params: {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  details?: unknown;
}): Promise<void> {
  const existing = await getAllStore<AuditLogRecord>('auditLogs');
  const maxId = existing.reduce((m, l) => Math.max(m, l.id), 0);
  const id = await allocateId('nextAuditId', maxId);
  const entry: AuditLogRecord = {
    id,
    actor: params.actor,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    summary: params.summary,
    detailsJson: params.details !== undefined ? JSON.stringify(params.details) : null,
    createdAt: new Date().toISOString(),
  };
  const db = await openLocalDb();
  const tx = db.transaction('auditLogs', 'readwrite');
  tx.objectStore('auditLogs').put(entry);
  await idbTxDone(tx);
}

async function hydrateAllTrades(): Promise<TradeGroupRecord[]> {
  const [groups, orders, uploads, links] = await Promise.all([
    getAllStore<TradeGroupRecord>('tradeGroups'),
    getAllStore<TradeOrderRecord>('orders'),
    getAllStore<StoredUploadRecord>('uploads'),
    getAllStore<StoredGroupScreenshotLink>('groupScreenshots'),
  ]);

  const uploadMap = new Map<number, StoredUploadRecord>();
  for (const u of uploads) uploadMap.set(u.id, u);

  const ordersByGroup = new Map<number, TradeOrderRecord[]>();
  for (const o of orders) {
    const arr = ordersByGroup.get(o.tradeGroupId) || [];
    arr.push(o);
    ordersByGroup.set(o.tradeGroupId, arr);
  }

  const screenshotsByGroup = new Map<number, NonNullable<TradeGroupRecord['screenshots']>>();
  for (const link of links) {
    const u = uploadMap.get(link.uploadId);
    if (!u) continue;
    const arr = screenshotsByGroup.get(link.tradeGroupId) || [];
    if (!arr.some((s) => s.id === u.id)) {
      arr.push({
        id: u.id,
        imageDataUrl: u.imageDataUrl,
        originalFilename: u.originalFilename,
        uploadedBy: u.uploadedBy,
        uploadedAt: u.uploadedAt,
      });
    }
    screenshotsByGroup.set(link.tradeGroupId, arr);
  }

  return groups
    .map((g) => ({
      ...g,
      orders: (ordersByGroup.get(g.id) || []).sort((a, b) => a.id - b.id),
      screenshots: (screenshotsByGroup.get(g.id) || []).sort((a, b) => b.id - a.id),
    }))
    .sort((a, b) => b.tradingDate.localeCompare(a.tradingDate) || b.id - a.id);
}

async function recomputeGroupById(groupId: number, rates: ChargeRates): Promise<TradeGroupRecord | null> {
  const db = await openLocalDb();
  const txRead = db.transaction(['tradeGroups', 'orders'], 'readonly');
  const group = await idbReq<TradeGroupRecord | undefined>(
    txRead.objectStore('tradeGroups').get(groupId),
  );
  if (!group) return null;

  const allOrders = await idbReq<TradeOrderRecord[]>(txRead.objectStore('orders').getAll());
  const groupOrders = allOrders
    .filter((o) => o.tradeGroupId === groupId)
    .sort((a, b) => a.id - b.id);

  const override =
    group.chargesMode === 'CONTRACT_NOTE'
      ? {
          brokerage: group.brokerage,
          stt: group.stt,
          exchangeTxnCharge: group.exchangeTxnCharge,
          ipftCharge: group.ipftCharge,
          sebiCharge: group.sebiCharge,
          stampDuty: group.stampDuty,
          gst: group.gst,
          otherCharges: group.otherCharges,
        }
      : null;

  const metrics = computeTradeGroupMetrics(
    groupOrders.map((o) => ({
      side: o.side,
      quantity: o.quantity,
      executionPrice: o.executionPrice,
      amount: o.amount,
    })),
    rates,
    override,
  );

  const updated: TradeGroupRecord = {
    ...group,
    buyQty: metrics.buyQty,
    sellQty: metrics.sellQty,
    avgBuyPrice: metrics.avgBuyPrice,
    avgSellPrice: metrics.avgSellPrice,
    totalBuyAmount: metrics.totalBuyAmount,
    totalSellAmount: metrics.totalSellAmount,
    realisedQty: metrics.realisedQty,
    openQty: metrics.openQty,
    openSide: metrics.openSide,
    grossPnl: metrics.grossPnl,
    brokerage: metrics.brokerage,
    stt: metrics.stt,
    exchangeTxnCharge: metrics.exchangeTxnCharge,
    ipftCharge: metrics.ipftCharge,
    sebiCharge: metrics.sebiCharge,
    stampDuty: metrics.stampDuty,
    gst: metrics.gst,
    otherCharges: metrics.otherCharges,
    totalCharges: metrics.totalCharges,
    netPnl: metrics.netPnl,
    updatedAt: new Date().toISOString(),
  };

  // Strip transient joined arrays before saving raw group record
  const cleanGroup: TradeGroupRecord = { ...updated };
  delete cleanGroup.orders;
  delete cleanGroup.screenshots;

  const txWrite = db.transaction('tradeGroups', 'readwrite');
  txWrite.objectStore('tradeGroups').put(cleanGroup);
  await idbTxDone(txWrite);

  const allHydrated = await hydrateAllTrades();
  return allHydrated.find((g) => g.id === groupId) || null;
}

function buildSummaryFromData(
  trades: TradeGroupRecord[],
  deposits: DepositRecord[],
): { summary: DashboardSummary; settlementPreview: SettlementPreview } {
  const settlementPreview = computePartnershipAndSettlement(trades, deposits, []);
  const closedTrades = trades.filter((t) => t.realisedQty > 0);
  const openTrades = trades.filter((t) => t.openQty > 0);

  const totalBuyAmount = round2(trades.reduce((s, t) => s + t.totalBuyAmount, 0));
  const totalSellAmount = round2(trades.reduce((s, t) => s + t.totalSellAmount, 0));
  const winningTrades = closedTrades.filter((t) => t.netPnl > 0).length;
  const losingTrades = closedTrades.filter((t) => t.netPnl < 0).length;

  const summary: DashboardSummary = {
    totalPartnershipCapital: settlementPreview.totalPartnershipCapital,
    totalAccountBalance: settlementPreview.totalAccountBalance,
    ownerTotalContribution: settlementPreview.ownerTotalDeposits,
    rajTotalContribution: settlementPreview.rajTotalDeposits,
    ownerOwnershipBalance: settlementPreview.ownerOwnershipBalance,
    rajOwnershipBalance: settlementPreview.rajOwnershipBalance,
    ownerPaidOutAmount: settlementPreview.ownerPaidOutSoFar,
    rajPaidOutAmount: settlementPreview.rajPaidOutSoFar,
    eachCapitalObligation: 0,
    ownerOutstandingAmount: 0,
    rajOutstandingAmount: 0,
    totalBuyAmount,
    totalSellAmount,
    totalGrossPnl: settlementPreview.totalRealisedGrossPnl,
    totalBrokerageAndTaxes: settlementPreview.totalRealisedCharges,
    totalNetPnl: settlementPreview.totalRealisedNetPnl,
    ownerProfitShare: round2(settlementPreview.totalRealisedNetPnl / 2),
    rajProfitShare: round2(
      settlementPreview.totalRealisedNetPnl - round2(settlementPreview.totalRealisedNetPnl / 2),
    ),
    totalDistributedAmount: 0,
    pendingSettlementAmount: settlementPreview.unsettledNetPnl,
    totalClosedTrades: closedTrades.length,
    winningTrades,
    losingTrades,
    openPositionsCount: openTrades.length,
  };

  return { summary, settlementPreview };
}

async function writePartnerDeskFilesToDir(
  dirHandle: FileSystemDirectoryHandleLike,
  payload: LocalBackupPayload,
  xlsxBytes: Uint8Array,
): Promise<void> {
  const targetDir =
    dirHandle.name === FOLDER_NAME
      ? dirHandle
      : await dirHandle.getDirectoryHandle(FOLDER_NAME, { create: true });

  const writeFile = async (fileName: string, content: BlobPart | Uint8Array) => {
    const fh = await targetDir.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  };

  await writeFile('ledger_backup.json', JSON.stringify(payload, null, 2));
  await writeFile('trades.json', JSON.stringify(payload.tradeGroups, null, 2));
  await writeFile('deposits.json', JSON.stringify(payload.deposits, null, 2));
  await writeFile('PartnerDesk_Ledger.xlsx', xlsxBytes);
}

export async function exportLocalBackupPayload(): Promise<LocalBackupPayload> {
  const [chargeRates, deposits, uploads, tradeGroupsRaw, orders, auditLogs] = await Promise.all([
    getRatesInternal(),
    getAllStore<DepositRecord>('deposits'),
    getAllStore<StoredUploadRecord>('uploads'),
    getAllStore<TradeGroupRecord>('tradeGroups'),
    getAllStore<TradeOrderRecord>('orders'),
    getAllStore<AuditLogRecord>('auditLogs'),
  ]);

  const sortedDeposits = [...deposits].sort(
    (a, b) => b.depositDate.localeCompare(a.depositDate) || b.id - a.id,
  );
  const sortedTrades = [...tradeGroupsRaw].sort(
    (a, b) => b.tradingDate.localeCompare(a.tradingDate) || b.id - a.id,
  );
  const sortedOrders = [...orders].sort((a, b) => a.id - b.id);
  const sortedLogs = [...auditLogs].sort((a, b) => b.id - a.id);

  return {
    format: 'partnerdesk-local-backup-v1',
    folderName: FOLDER_NAME,
    exportedAt: new Date().toISOString(),
    chargeRates,
    deposits: sortedDeposits,
    uploads,
    tradeGroups: sortedTrades,
    orders: sortedOrders,
    auditLogs: sortedLogs,
  };
}

export async function syncPartnerDeskFolder(): Promise<{
  opfsSynced: boolean;
  linkedFolderSynced: boolean;
}> {
  let opfsSynced = false;
  let linkedFolderSynced = false;

  try {
    const payload = await exportLocalBackupPayload();
    const hydratedTrades = await hydrateAllTrades();
    const { summary } = buildSummaryFromData(hydratedTrades, payload.deposits);
    const xlsxBytes = buildLedgerWorkbookBytes({
      summary,
      trades: hydratedTrades,
      deposits: payload.deposits,
    });

    // 1. Automatic on-device OPFS `PartnerDesk_Data` directory (works on Phone & Laptop)
    if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
      try {
        const root = (await navigator.storage.getDirectory()) as unknown as FileSystemDirectoryHandleLike;
        await writePartnerDeskFilesToDir(root, payload, xlsxBytes);
        await setMeta('opfsSyncedAt', new Date().toISOString());
        opfsSynced = true;
      } catch {
        opfsSynced = false;
      }
    }

    // 2. Optional user-linked real OS folder (`PartnerDesk_Data` on Laptop drive / Phone files)
    const linkedHandle = await getMeta<FileSystemDirectoryHandleLike>('linkedDirectoryHandle');
    if (linkedHandle) {
      try {
        const perm = linkedHandle.queryPermission
          ? await linkedHandle.queryPermission({ mode: 'readwrite' })
          : 'granted';
        if (perm === 'granted') {
          await writePartnerDeskFilesToDir(linkedHandle, payload, xlsxBytes);
          await setMeta('linkedFolderSyncedAt', new Date().toISOString());
          linkedFolderSynced = true;
        }
      } catch {
        linkedFolderSynced = false;
      }
    }
  } catch {
    // Non-fatal; IndexedDB remains authoritative
  }

  return { opfsSynced, linkedFolderSynced };
}

export const localLedger = {
  /**
   * One-time non-destructive import of pre-existing ledger rows (e.g. Prayag's ₹3,000 deposit)
   * only when IndexedDB is empty and has never been bootstrapped before.
   */
  async bootstrapFromServerIfEmpty(
    fetchBootstrap: () => Promise<{
      trades: TradeGroupRecord[];
      deposits: DepositRecord[];
      rates: ChargeRates;
      auditLogs: AuditLogRecord[];
    }>,
  ): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
      try {
        const alreadyDone = await getMeta<boolean>('bootstrapped_v1');
        if (alreadyDone) return;

        const [existingGroups, existingDeposits] = await Promise.all([
          getAllStore<TradeGroupRecord>('tradeGroups'),
          getAllStore<DepositRecord>('deposits'),
        ]);

        if (existingGroups.length > 0 || existingDeposits.length > 0) {
          await setMeta('bootstrapped_v1', true);
          return;
        }

        const remote = await fetchBootstrap().catch(() => null);
        if (!remote) {
          await setMeta('bootstrapped_v1', true);
          return;
        }

        const db = await openLocalDb();
        const tx = db.transaction(
          ['tradeGroups', 'orders', 'uploads', 'groupScreenshots', 'deposits', 'auditLogs', 'meta'],
          'readwrite',
        );

        let maxGroupId = 0;
        let maxOrderId = 0;
        let maxUploadId = 0;
        let maxDepositId = 0;
        let maxAuditId = 0;

        for (const d of remote.deposits || []) {
          maxDepositId = Math.max(maxDepositId, d.id);
          tx.objectStore('deposits').put(d);
        }

        for (const t of remote.trades || []) {
          maxGroupId = Math.max(maxGroupId, t.id);
          const cleanGroup: TradeGroupRecord = { ...t };
          delete cleanGroup.orders;
          delete cleanGroup.screenshots;
          tx.objectStore('tradeGroups').put(cleanGroup);

          for (const o of t.orders || []) {
            maxOrderId = Math.max(maxOrderId, o.id);
            tx.objectStore('orders').put(o);
          }

          for (const sc of t.screenshots || []) {
            maxUploadId = Math.max(maxUploadId, sc.id);
            const hash = await sha256Hex(sc.imageDataUrl);
            tx.objectStore('uploads').put({
              id: sc.id,
              imageHash: hash,
              imageDataUrl: sc.imageDataUrl,
              originalFilename: sc.originalFilename,
              uploadedBy: sc.uploadedBy,
              uploadedAt: sc.uploadedAt,
            } satisfies StoredUploadRecord);
            tx.objectStore('groupScreenshots').put({
              tradeGroupId: t.id,
              uploadId: sc.id,
            } satisfies StoredGroupScreenshotLink);
          }
        }

        for (const log of remote.auditLogs || []) {
          maxAuditId = Math.max(maxAuditId, log.id);
          tx.objectStore('auditLogs').put(log);
        }

        if (remote.rates) {
          tx.objectStore('meta').put({ key: 'chargeRates', value: remote.rates });
        }
        tx.objectStore('meta').put({ key: 'nextTradeGroupId', value: maxGroupId });
        tx.objectStore('meta').put({ key: 'nextOrderId', value: maxOrderId });
        tx.objectStore('meta').put({ key: 'nextUploadId', value: maxUploadId });
        tx.objectStore('meta').put({ key: 'nextDepositId', value: maxDepositId });
        tx.objectStore('meta').put({ key: 'nextAuditId', value: maxAuditId });
        tx.objectStore('meta').put({ key: 'bootstrapped_v1', value: true });

        await idbTxDone(tx);
        void syncPartnerDeskFolder();
      } finally {
        bootstrapPromise = null;
      }
    })();

    return bootstrapPromise;
  },

  async getPendingLegacyLocalBackup(): Promise<LocalBackupPayload | null> {
    const alreadyMigrated = await getMeta<boolean>('migratedToSharedServer_v1');
    if (alreadyMigrated) return null;

    const wasBootstrapped = await getMeta<boolean>('bootstrapped_v1');
    const [groups, deposits, uploads] = await Promise.all([
      getAllStore<TradeGroupRecord>('tradeGroups'),
      getAllStore<DepositRecord>('deposits'),
      getAllStore<StoredUploadRecord>('uploads'),
    ]);

    if (!wasBootstrapped && groups.length === 0 && deposits.length === 0 && uploads.length === 0) {
      await setMeta('migratedToSharedServer_v1', true);
      return null;
    }

    if (groups.length === 0 && deposits.length === 0 && uploads.length === 0) {
      await setMeta('migratedToSharedServer_v1', true);
      return null;
    }

    return exportLocalBackupPayload();
  },

  async markMigratedToSharedServer(): Promise<void> {
    await setMeta('migratedToSharedServer_v1', true);
  },

  async mirrorServerSnapshot(payload: LocalBackupPayload): Promise<void> {
    try {
      const db = await openLocalDb();
      const tx = db.transaction(
        ['tradeGroups', 'orders', 'uploads', 'groupScreenshots', 'deposits', 'auditLogs', 'meta'],
        'readwrite',
      );
      tx.objectStore('tradeGroups').clear();
      tx.objectStore('orders').clear();
      tx.objectStore('uploads').clear();
      tx.objectStore('groupScreenshots').clear();
      tx.objectStore('deposits').clear();
      tx.objectStore('auditLogs').clear();

      for (const d of payload.deposits || []) tx.objectStore('deposits').put(d);
      for (const u of payload.uploads || []) tx.objectStore('uploads').put(u);
      for (const g of payload.tradeGroups || []) {
        const cleanGroup: TradeGroupRecord = { ...g };
        delete cleanGroup.orders;
        delete cleanGroup.screenshots;
        tx.objectStore('tradeGroups').put(cleanGroup);
      }
      for (const o of payload.orders || []) {
        tx.objectStore('orders').put(o);
        if (o.uploadId) {
          tx.objectStore('groupScreenshots').put({
            tradeGroupId: o.tradeGroupId,
            uploadId: o.uploadId,
          } satisfies StoredGroupScreenshotLink);
        }
      }
      for (const l of payload.auditLogs || []) tx.objectStore('auditLogs').put(l);
      if (payload.chargeRates) {
        tx.objectStore('meta').put({ key: 'chargeRates', value: payload.chargeRates });
      }
      tx.objectStore('meta').put({ key: 'bootstrapped_v1', value: true });
      tx.objectStore('meta').put({ key: 'migratedToSharedServer_v1', value: true });
      await idbTxDone(tx);

      await syncPartnerDeskFolder();
    } catch {
      // Non-fatal mirror failure
    }
  },

  async checkDuplicateScreenshot(imageDataUrl: string): Promise<StoredUploadRecord | null> {
    const hash = await sha256Hex(imageDataUrl);
    const uploads = await getAllStore<StoredUploadRecord>('uploads');
    return uploads.find((u) => u.imageHash === hash) || null;
  },

  async getDashboard(): Promise<LocalDashboardPayload> {
    const [trades, deposits] = await Promise.all([
      hydrateAllTrades(),
      getAllStore<DepositRecord>('deposits'),
    ]);
    const sortedDeposits = [...deposits].sort(
      (a, b) => b.depositDate.localeCompare(a.depositDate) || b.id - a.id,
    );
    const { summary, settlementPreview } = buildSummaryFromData(trades, sortedDeposits);
    return {
      summary,
      settlementPreview,
      recentTrades: trades.slice(0, 8),
      openPositions: trades.filter((t) => t.openQty > 0),
      recentDeposits: sortedDeposits.slice(0, 6),
      recentSettlements: [],
    };
  },

  async listTrades(): Promise<{ trades: TradeGroupRecord[]; rates: ChargeRates }> {
    const [trades, rates] = await Promise.all([hydrateAllTrades(), getRatesInternal()]);
    return { trades, rates };
  },

  async saveOrders(params: {
    actor: PartnerId;
    screenshotDataUrl?: string | null;
    originalFilename?: string | null;
    orders: ExtractedOrderLeg[];
  }): Promise<{
    uploadId: number | null;
    uploadedAt: string;
    affectedTrades: TradeGroupRecord[];
  }> {
    const rates = await getRatesInternal();
    const uploadedAt = new Date().toISOString();

    let uploadId: number | null = null;
    if (params.screenshotDataUrl) {
      const hash = await sha256Hex(params.screenshotDataUrl);
      const uploads = await getAllStore<StoredUploadRecord>('uploads');
      const dup = uploads.find((u) => u.imageHash === hash);
      if (dup) {
        throw new Error(
          `Duplicate screenshot detected (already uploaded on ${new Date(
            dup.uploadedAt,
          ).toLocaleString()} by ${dup.uploadedBy}).`,
        );
      }
      const maxUploadId = uploads.reduce((m, u) => Math.max(m, u.id), 0);
      uploadId = await allocateId('nextUploadId', maxUploadId);
      const db = await openLocalDb();
      const tx = db.transaction('uploads', 'readwrite');
      tx.objectStore('uploads').put({
        id: uploadId,
        imageHash: hash,
        imageDataUrl: params.screenshotDataUrl,
        originalFilename: params.originalFilename || null,
        uploadedBy: params.actor,
        uploadedAt,
      } satisfies StoredUploadRecord);
      await idbTxDone(tx);
    }

    const existingGroups = await getAllStore<TradeGroupRecord>('tradeGroups');
    const existingOrders = await getAllStore<TradeOrderRecord>('orders');
    let maxGroupId = existingGroups.reduce((m, g) => Math.max(m, g.id), 0);
    let maxOrderId = existingOrders.reduce((m, o) => Math.max(m, o.id), 0);

    const touchedGroupIds = new Set<number>();

    for (const raw of params.orders) {
      const stockName = raw.stockName.trim().toUpperCase();
      const tradingSymbol = (raw.tradingSymbol || `${stockName} ${raw.strikePrice} ${raw.optionType}`)
        .trim()
        .toUpperCase();
      const expiryDate = raw.expiryDate.trim();
      const tradingDate = raw.tradingDate.trim();
      const strikePrice = Number(raw.strikePrice);
      const optionType: OptionType = raw.optionType === 'PE' ? 'PE' : 'CE';
      const side: OrderSide = raw.side === 'SELL' ? 'SELL' : 'BUY';
      const quantity = Math.round(Number(raw.quantity));
      const lots =
        raw.lots !== null && raw.lots !== undefined && Number(raw.lots) > 0
          ? Number(raw.lots)
          : null;
      const executionPrice = Number(raw.executionPrice);
      const amount = round2(
        Number.isFinite(raw.amount) && raw.amount > 0 ? raw.amount : quantity * executionPrice,
      );
      const executionTime = (raw.executionTime || '09:15 AM').trim();

      const groupKey = buildTradeGroupKey({
        tradingDate,
        stockName,
        expiryDate,
        strikePrice,
        optionType,
      });

      const currentGroups = await getAllStore<TradeGroupRecord>('tradeGroups');
      let group = currentGroups.find((g) => g.groupKey === groupKey);
      let groupId: number;

      if (!group) {
        groupId = await allocateId('nextTradeGroupId', maxGroupId);
        maxGroupId = Math.max(maxGroupId, groupId);
        group = {
          id: groupId,
          groupKey,
          tradingDate,
          uploadedAt,
          stockName,
          tradingSymbol,
          expiryDate,
          strikePrice,
          optionType,
          buyQty: 0,
          sellQty: 0,
          avgBuyPrice: 0,
          avgSellPrice: 0,
          totalBuyAmount: 0,
          totalSellAmount: 0,
          realisedQty: 0,
          openQty: 0,
          openSide: null,
          grossPnl: 0,
          brokerage: 0,
          stt: 0,
          exchangeTxnCharge: 0,
          sebiCharge: 0,
          stampDuty: 0,
          ipftCharge: 0,
          gst: 0,
          otherCharges: 0,
          totalCharges: 0,
          netPnl: 0,
          chargesMode: 'ESTIMATED',
          contractNoteRef: null,
          notes: null,
          updatedAt: uploadedAt,
        };
        const db = await openLocalDb();
        const tx = db.transaction('tradeGroups', 'readwrite');
        tx.objectStore('tradeGroups').put(group);
        await idbTxDone(tx);
      } else {
        groupId = group.id;
      }

      const orderId = await allocateId('nextOrderId', maxOrderId);
      maxOrderId = Math.max(maxOrderId, orderId);

      const orderRec: TradeOrderRecord = {
        id: orderId,
        tradeGroupId: groupId,
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
        lots,
        executionPrice,
        amount,
        executionTime,
        createdBy: params.actor,
        createdAt: uploadedAt,
      };

      const db = await openLocalDb();
      const tx = db.transaction(['orders', 'groupScreenshots'], 'readwrite');
      tx.objectStore('orders').put(orderRec);
      if (uploadId !== null) {
        tx.objectStore('groupScreenshots').put({
          tradeGroupId: groupId,
          uploadId,
        } satisfies StoredGroupScreenshotLink);
      }
      await idbTxDone(tx);

      touchedGroupIds.add(groupId);
    }

    const affectedTrades: TradeGroupRecord[] = [];
    for (const gid of touchedGroupIds) {
      const updated = await recomputeGroupById(gid, rates);
      if (updated) affectedTrades.push(updated);
    }

    await appendAuditLog({
      actor: params.actor,
      action: 'TRADE_UPLOADED',
      entityType: 'trade_group',
      entityId: Array.from(touchedGroupIds).join(','),
      summary: `Saved ${params.orders.length} order leg(s) locally into ${affectedTrades.length} trade group(s).`,
      details: { uploadId, filename: params.originalFilename || null },
    });

    void syncPartnerDeskFolder();
    return { uploadId, uploadedAt, affectedTrades };
  },

  async updateTrade(
    tradeGroupId: number,
    actor: PartnerId,
    payload: Record<string, unknown>,
  ): Promise<TradeGroupRecord> {
    const db = await openLocalDb();
    const txRead = db.transaction(['tradeGroups', 'orders'], 'readonly');
    const existing = await idbReq<TradeGroupRecord | undefined>(
      txRead.objectStore('tradeGroups').get(tradeGroupId),
    );
    if (!existing) {
      throw new Error('Trade not found.');
    }

    const tradingDate =
      typeof payload.tradingDate === 'string' && payload.tradingDate.trim()
        ? payload.tradingDate.trim()
        : existing.tradingDate;
    const stockName =
      typeof payload.stockName === 'string' && payload.stockName.trim()
        ? payload.stockName.trim().toUpperCase()
        : existing.stockName;
    const expiryDate =
      typeof payload.expiryDate === 'string' && payload.expiryDate.trim()
        ? payload.expiryDate.trim()
        : existing.expiryDate;
    const strikePrice =
      payload.strikePrice !== undefined ? Number(payload.strikePrice) : existing.strikePrice;
    const optionType: OptionType =
      payload.optionType === 'PE'
        ? 'PE'
        : payload.optionType === 'CE'
          ? 'CE'
          : existing.optionType;
    const tradingSymbol =
      typeof payload.tradingSymbol === 'string' && payload.tradingSymbol.trim()
        ? payload.tradingSymbol.trim().toUpperCase()
        : `${stockName} ${strikePrice} ${optionType}`;
    const notes =
      payload.notes !== undefined
        ? typeof payload.notes === 'string'
          ? payload.notes
          : null
        : existing.notes;

    const groupKey = buildTradeGroupKey({
      tradingDate,
      stockName,
      expiryDate,
      strikePrice,
      optionType,
    });

    const cn = payload.contractNote as Record<string, unknown> | undefined;
    let chargesMode: ChargesMode = existing.chargesMode;
    let contractNoteRef = existing.contractNoteRef;
    let brokerage = existing.brokerage;
    let stt = existing.stt;
    let exchangeTxnCharge = existing.exchangeTxnCharge;
    let ipftCharge = existing.ipftCharge;
    let sebiCharge = existing.sebiCharge;
    let stampDuty = existing.stampDuty;
    let gst = existing.gst;
    let otherCharges = existing.otherCharges;

    if (cn) {
      if (cn.mode === 'CONTRACT_NOTE') {
        chargesMode = 'CONTRACT_NOTE';
        contractNoteRef =
          typeof cn.contractNoteRef === 'string' ? cn.contractNoteRef : existing.contractNoteRef;
        brokerage = Number(cn.brokerage ?? existing.brokerage);
        stt = Number(cn.stt ?? existing.stt);
        exchangeTxnCharge = Number(cn.exchangeTxnCharge ?? existing.exchangeTxnCharge);
        ipftCharge = Number(cn.ipftCharge ?? existing.ipftCharge);
        sebiCharge = Number(cn.sebiCharge ?? existing.sebiCharge);
        stampDuty = Number(cn.stampDuty ?? existing.stampDuty);
        gst = Number(cn.gst ?? existing.gst);
        otherCharges = Number(cn.otherCharges ?? existing.otherCharges);
      } else {
        chargesMode = 'ESTIMATED';
        contractNoteRef = null;
      }
    }

    const updatedGroup: TradeGroupRecord = {
      ...existing,
      groupKey,
      tradingDate,
      stockName,
      tradingSymbol,
      expiryDate,
      strikePrice,
      optionType,
      notes,
      chargesMode,
      contractNoteRef,
      brokerage,
      stt,
      exchangeTxnCharge,
      ipftCharge,
      sebiCharge,
      stampDuty,
      gst,
      otherCharges,
      updatedAt: new Date().toISOString(),
    };
    delete updatedGroup.orders;
    delete updatedGroup.screenshots;

    const allOrders = await getAllStore<TradeOrderRecord>('orders');
    let maxOrderId = allOrders.reduce((m, o) => Math.max(m, o.id), 0);

    const txWrite = db.transaction(['tradeGroups', 'orders'], 'readwrite');
    txWrite.objectStore('tradeGroups').put(updatedGroup);

    if (Array.isArray(payload.orders)) {
      // Remove existing orders for this group and replace with edited list
      for (const oldOrd of allOrders) {
        if (oldOrd.tradeGroupId === tradeGroupId) {
          txWrite.objectStore('orders').delete(oldOrd.id);
        }
      }
      for (const rawOrd of payload.orders as Record<string, unknown>[]) {
        const oid =
          typeof rawOrd.id === 'number' && rawOrd.id > 0
            ? rawOrd.id
            : await allocateId('nextOrderId', maxOrderId);
        maxOrderId = Math.max(maxOrderId, oid);
        const qty = Math.round(Number(rawOrd.quantity));
        const price = Number(rawOrd.executionPrice);
        const amt = round2(
          Number.isFinite(Number(rawOrd.amount)) && Number(rawOrd.amount) > 0
            ? Number(rawOrd.amount)
            : qty * price,
        );
        const ord: TradeOrderRecord = {
          id: oid,
          tradeGroupId,
          uploadId: null,
          tradingDate,
          uploadedAt: existing.uploadedAt,
          stockName,
          tradingSymbol,
          expiryDate,
          strikePrice,
          optionType,
          side: rawOrd.side === 'SELL' ? 'SELL' : 'BUY',
          quantity: qty,
          lots:
            rawOrd.lots !== null && rawOrd.lots !== undefined ? Number(rawOrd.lots) : null,
          executionPrice: price,
          amount: amt,
          executionTime: String(rawOrd.executionTime || '09:15 AM'),
          createdBy: actor,
          createdAt: new Date().toISOString(),
        };
        txWrite.objectStore('orders').put(ord);
      }
    } else {
      // Update metadata on existing order rows
      for (const oldOrd of allOrders) {
        if (oldOrd.tradeGroupId === tradeGroupId) {
          txWrite.objectStore('orders').put({
            ...oldOrd,
            tradingDate,
            stockName,
            tradingSymbol,
            expiryDate,
            strikePrice,
            optionType,
          } satisfies TradeOrderRecord);
        }
      }
    }

    await idbTxDone(txWrite);

    const rates = await getRatesInternal();
    const recomputed = await recomputeGroupById(tradeGroupId, rates);
    if (!recomputed) throw new Error('Trade not found after update.');

    await appendAuditLog({
      actor,
      action: cn ? 'CONTRACT_NOTE_UPDATED' : 'TRADE_UPDATED',
      entityType: 'trade_group',
      entityId: String(tradeGroupId),
      summary: `${recomputed.stockName} ${recomputed.strikePrice} ${recomputed.optionType} updated locally (${recomputed.chargesMode}).`,
    });

    void syncPartnerDeskFolder();
    return recomputed;
  },

  async deleteTrade(tradeGroupId: number, actor: PartnerId): Promise<void> {
    const db = await openLocalDb();
    const txRead = db.transaction(['tradeGroups', 'orders', 'groupScreenshots'], 'readonly');
    const existing = await idbReq<TradeGroupRecord | undefined>(
      txRead.objectStore('tradeGroups').get(tradeGroupId),
    );
    if (!existing) throw new Error('Trade not found.');
    const allOrders = await idbReq<TradeOrderRecord[]>(txRead.objectStore('orders').getAll());
    const allLinks = await idbReq<StoredGroupScreenshotLink[]>(
      txRead.objectStore('groupScreenshots').getAll(),
    );

    const txDel = db.transaction(['tradeGroups', 'orders', 'groupScreenshots'], 'readwrite');
    txDel.objectStore('tradeGroups').delete(tradeGroupId);
    for (const o of allOrders) {
      if (o.tradeGroupId === tradeGroupId) txDel.objectStore('orders').delete(o.id);
    }
    for (const l of allLinks) {
      if (l.tradeGroupId === tradeGroupId) {
        txDel.objectStore('groupScreenshots').delete([l.tradeGroupId, l.uploadId]);
      }
    }
    await idbTxDone(txDel);

    await appendAuditLog({
      actor,
      action: 'TRADE_DELETED',
      entityType: 'trade_group',
      entityId: String(tradeGroupId),
      summary: `Deleted ${existing.stockName} ${existing.strikePrice} ${existing.optionType} (${existing.tradingDate}) from local storage.`,
    });

    void syncPartnerDeskFolder();
  },

  async listDeposits(): Promise<{ deposits: DepositRecord[]; summary: DashboardSummary }> {
    const [trades, deposits] = await Promise.all([
      hydrateAllTrades(),
      getAllStore<DepositRecord>('deposits'),
    ]);
    const sorted = [...deposits].sort(
      (a, b) => b.depositDate.localeCompare(a.depositDate) || b.id - a.id,
    );
    const { summary } = buildSummaryFromData(trades, sorted);
    return { deposits: sorted, summary };
  },

  async addDeposit(params: {
    partner: PartnerId;
    entryType?: FundEntryType;
    amount: number;
    depositDate: string;
    referenceNote?: string;
    actor: PartnerId;
  }): Promise<DepositRecord> {
    const existing = await getAllStore<DepositRecord>('deposits');
    const maxId = existing.reduce((m, d) => Math.max(m, d.id), 0);
    const id = await allocateId('nextDepositId', maxId);
    const entryType: FundEntryType = params.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';

    const deposit: DepositRecord = {
      id,
      partner: params.partner,
      entryType,
      amount: round2(params.amount),
      depositDate: params.depositDate,
      referenceNote: params.referenceNote?.trim() || null,
      createdBy: params.actor,
      createdAt: new Date().toISOString(),
    };

    const db = await openLocalDb();
    const tx = db.transaction('deposits', 'readwrite');
    tx.objectStore('deposits').put(deposit);
    await idbTxDone(tx);

    await appendAuditLog({
      actor: params.actor,
      action: entryType === 'WITHDRAWAL' ? 'WITHDRAWAL_RECORDED' : 'DEPOSIT_ADDED',
      entityType: 'deposit',
      entityId: String(id),
      summary:
        entryType === 'WITHDRAWAL'
          ? `Recorded ₹${deposit.amount.toFixed(2)} fund withdrawal for ${deposit.partner}.`
          : `Recorded ₹${deposit.amount.toFixed(2)} capital deposit for ${deposit.partner}.`,
    });

    void syncPartnerDeskFolder();
    return deposit;
  },

  async deleteDeposit(id: number, actor: PartnerId): Promise<void> {
    const db = await openLocalDb();
    const txRead = db.transaction('deposits', 'readonly');
    const existing = await idbReq<DepositRecord | undefined>(txRead.objectStore('deposits').get(id));
    if (!existing) throw new Error('Fund entry not found.');

    const txDel = db.transaction('deposits', 'readwrite');
    txDel.objectStore('deposits').delete(id);
    await idbTxDone(txDel);

    const isWithdrawal = existing.entryType === 'WITHDRAWAL';
    await appendAuditLog({
      actor,
      action: isWithdrawal ? 'WITHDRAWAL_DELETED' : 'DEPOSIT_DELETED',
      entityType: 'deposit',
      entityId: String(id),
      summary: `Removed ${isWithdrawal ? 'withdrawal' : 'deposit'} #${id} (₹${existing.amount.toFixed(2)} by ${existing.partner}).`,
    });

    void syncPartnerDeskFolder();
  },

  async getRates(): Promise<ChargeRates> {
    return getRatesInternal();
  },

  async updateRates(
    rates: ChargeRates & { recalculateExisting?: boolean },
    actor: PartnerId,
  ): Promise<ChargeRates> {
    const cleanRates: ChargeRates = {
      brokeragePerOrder: Number(rates.brokeragePerOrder),
      sttSellPct: Number(rates.sttSellPct),
      exchangeTxnPct: Number(rates.exchangeTxnPct),
      ipftPct: Number(rates.ipftPct),
      sebiPct: Number(rates.sebiPct),
      stampDutyBuyPct: Number(rates.stampDutyBuyPct),
      gstPct: Number(rates.gstPct),
    };
    await setMeta('chargeRates', cleanRates);

    if (rates.recalculateExisting) {
      const groups = await getAllStore<TradeGroupRecord>('tradeGroups');
      for (const g of groups) {
        if (g.chargesMode === 'ESTIMATED') {
          await recomputeGroupById(g.id, cleanRates);
        }
      }
    }

    await appendAuditLog({
      actor,
      action: 'RATES_UPDATED',
      entityType: 'settings',
      summary: `Updated charge rates locally${rates.recalculateExisting ? ' and recalculated estimated trades' : ''}.`,
    });

    void syncPartnerDeskFolder();
    return cleanRates;
  },

  async listAuditLogs(): Promise<AuditLogRecord[]> {
    const logs = await getAllStore<AuditLogRecord>('auditLogs');
    return [...logs].sort((a, b) => b.id - a.id);
  },

  async getStorageStatus(overrideCounts?: {
    tradesCount: number;
    ordersCount: number;
    screenshotsCount: number;
    depositsCount: number;
    auditLogsCount: number;
  }): Promise<LocalStorageStatus> {
    const [groups, orders, uploads, deposits, logs, opfsSyncedAt, linkedHandle, linkedSyncedAt] =
      await Promise.all([
        getAllStore<TradeGroupRecord>('tradeGroups'),
        getAllStore<TradeOrderRecord>('orders'),
        getAllStore<StoredUploadRecord>('uploads'),
        getAllStore<DepositRecord>('deposits'),
        getAllStore<AuditLogRecord>('auditLogs'),
        getMeta<string>('opfsSyncedAt'),
        getMeta<FileSystemDirectoryHandleLike>('linkedDirectoryHandle'),
        getMeta<string>('linkedFolderSyncedAt'),
      ]);

    let persistentGranted: boolean | null = null;
    let estimatedUsageBytes: number | null = null;
    let estimatedQuotaBytes: number | null = null;

    if (typeof navigator !== 'undefined' && navigator.storage) {
      if (navigator.storage.persisted) {
        persistentGranted = await navigator.storage.persisted().catch(() => null);
      }
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        if (est) {
          estimatedUsageBytes = est.usage ?? null;
          estimatedQuotaBytes = est.quota ?? null;
        }
      }
    }

    let linkedFolderNeedsPermission = false;
    if (linkedHandle?.queryPermission) {
      const perm = await linkedHandle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      linkedFolderNeedsPermission = perm !== 'granted';
    }

    return {
      tradesCount: overrideCounts ? overrideCounts.tradesCount : groups.length,
      ordersCount: overrideCounts ? overrideCounts.ordersCount : orders.length,
      screenshotsCount: overrideCounts ? overrideCounts.screenshotsCount : uploads.length,
      depositsCount: overrideCounts ? overrideCounts.depositsCount : deposits.length,
      auditLogsCount: overrideCounts ? overrideCounts.auditLogsCount : logs.length,
      persistentGranted,
      opfsAvailable: typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory),
      opfsSyncedAt: opfsSyncedAt || null,
      opfsFolderName: FOLDER_NAME,
      directoryPickerSupported:
        typeof window !== 'undefined' && 'showDirectoryPicker' in window,
      linkedFolderName: linkedHandle ? `${linkedHandle.name}/${FOLDER_NAME}` : null,
      linkedFolderSyncedAt: linkedSyncedAt || null,
      linkedFolderNeedsPermission,
      estimatedUsageBytes,
      estimatedQuotaBytes,
    };
  },

  async linkLocalFolder(): Promise<{ folderPath: string }> {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (opts?: {
          id?: string;
          mode?: 'read' | 'readwrite';
        }) => Promise<FileSystemDirectoryHandleLike>;
      }
    ).showDirectoryPicker;

    if (!picker) {
      throw new Error(
        'Your browser does not support direct folder linking. Automatic on-device storage and JSON/Excel backup downloads still work.',
      );
    }

    const dirHandle = await picker({ id: 'partnerdesk-data', mode: 'readwrite' });
    if (dirHandle.requestPermission) {
      const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        throw new Error('Folder write permission was not granted.');
      }
    }

    await setMeta('linkedDirectoryHandle', dirHandle);
    await syncPartnerDeskFolder();
    return {
      folderPath:
        dirHandle.name === FOLDER_NAME ? FOLDER_NAME : `${dirHandle.name}/${FOLDER_NAME}`,
    };
  },

  async grantLinkedFolderPermission(): Promise<void> {
    const linkedHandle = await getMeta<FileSystemDirectoryHandleLike>('linkedDirectoryHandle');
    if (!linkedHandle) return;
    if (linkedHandle.requestPermission) {
      const perm = await linkedHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        throw new Error('Permission to access the linked PartnerDesk_Data folder was declined.');
      }
    }
    await syncPartnerDeskFolder();
  },

  async unlinkLocalFolder(): Promise<void> {
    const db = await openLocalDb();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete('linkedDirectoryHandle');
    tx.objectStore('meta').delete('linkedFolderSyncedAt');
    await idbTxDone(tx);
  },

  async downloadJsonBackup(): Promise<void> {
    const payload = await exportLocalBackupPayload();
    this.downloadJsonFromPayload(payload);
  },

  downloadJsonFromPayload(payload: LocalBackupPayload): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PartnerDesk_Data_Backup_${todayIsoDate()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Non-destructive merge import from a PartnerDesk_Data JSON backup file.
   * Existing entries are preserved and missing/unique records from the backup are merged in.
   */
  async importMergeJsonBackup(
    fileText: string,
    actor: PartnerId,
  ): Promise<{ addedTrades: number; addedDeposits: number; addedScreenshots: number }> {
    let parsed: LocalBackupPayload;
    try {
      parsed = JSON.parse(fileText) as LocalBackupPayload;
    } catch {
      throw new Error('Invalid backup JSON file.');
    }

    if (!parsed || !Array.isArray(parsed.deposits) || !Array.isArray(parsed.tradeGroups)) {
      throw new Error('Selected file is not a valid PartnerDesk_Data backup.');
    }

    const [existingDeposits, existingGroups, existingOrders, existingUploads, existingLogs] =
      await Promise.all([
        getAllStore<DepositRecord>('deposits'),
        getAllStore<TradeGroupRecord>('tradeGroups'),
        getAllStore<TradeOrderRecord>('orders'),
        getAllStore<StoredUploadRecord>('uploads'),
        getAllStore<AuditLogRecord>('auditLogs'),
      ]);

    const uploadIdRemap = new Map<number, number>();
    const groupIdRemap = new Map<number, number>();

    let maxUploadId = existingUploads.reduce((m, u) => Math.max(m, u.id), 0);
    let maxGroupId = existingGroups.reduce((m, g) => Math.max(m, g.id), 0);
    let maxOrderId = existingOrders.reduce((m, o) => Math.max(m, o.id), 0);
    let maxDepositId = existingDeposits.reduce((m, d) => Math.max(m, d.id), 0);

    const existingUploadByHash = new Map(existingUploads.map((u) => [u.imageHash, u]));
    const existingGroupByKey = new Map(existingGroups.map((g) => [g.groupKey, g]));

    const db = await openLocalDb();
    const tx = db.transaction(
      ['uploads', 'tradeGroups', 'orders', 'groupScreenshots', 'deposits'],
      'readwrite',
    );

    let addedScreenshots = 0;
    for (const u of parsed.uploads || []) {
      const hash = u.imageHash || (await sha256Hex(u.imageDataUrl));
      const found = existingUploadByHash.get(hash);
      if (found) {
        uploadIdRemap.set(u.id, found.id);
      } else {
        maxUploadId += 1;
        const newU: StoredUploadRecord = { ...u, id: maxUploadId, imageHash: hash };
        tx.objectStore('uploads').put(newU);
        existingUploadByHash.set(hash, newU);
        uploadIdRemap.set(u.id, maxUploadId);
        addedScreenshots += 1;
      }
    }

    let addedTrades = 0;
    for (const g of parsed.tradeGroups || []) {
      const found = existingGroupByKey.get(g.groupKey);
      if (found) {
        groupIdRemap.set(g.id, found.id);
      } else {
        maxGroupId += 1;
        const cleanG: TradeGroupRecord = { ...g, id: maxGroupId };
        delete cleanG.orders;
        delete cleanG.screenshots;
        tx.objectStore('tradeGroups').put(cleanG);
        existingGroupByKey.set(g.groupKey, cleanG);
        groupIdRemap.set(g.id, maxGroupId);
        addedTrades += 1;
      }
    }

    const orderSignature = (o: TradeOrderRecord) =>
      `${o.tradeGroupId}|${o.side}|${o.quantity}|${o.executionPrice}|${o.amount}|${o.executionTime}`;
    const existingOrderSigs = new Set(existingOrders.map(orderSignature));

    for (const o of parsed.orders || []) {
      const targetGroupId = groupIdRemap.get(o.tradeGroupId);
      if (!targetGroupId) continue;
      const mappedUploadId = o.uploadId ? (uploadIdRemap.get(o.uploadId) ?? null) : null;
      const candidate: TradeOrderRecord = {
        ...o,
        id: 0,
        tradeGroupId: targetGroupId,
        uploadId: mappedUploadId,
      };
      const sig = orderSignature(candidate);
      if (!existingOrderSigs.has(sig)) {
        maxOrderId += 1;
        candidate.id = maxOrderId;
        tx.objectStore('orders').put(candidate);
        existingOrderSigs.add(sig);
      }
      if (mappedUploadId) {
        tx.objectStore('groupScreenshots').put({
          tradeGroupId: targetGroupId,
          uploadId: mappedUploadId,
        } satisfies StoredGroupScreenshotLink);
      }
    }

    const depSignature = (d: DepositRecord) =>
      `${d.depositDate}|${d.partner}|${d.entryType || 'DEPOSIT'}|${d.amount}|${d.createdAt}`;
    const existingDepSigs = new Set(existingDeposits.map(depSignature));
    let addedDeposits = 0;

    for (const d of parsed.deposits || []) {
      if (existingDepSigs.has(depSignature(d))) continue;
      maxDepositId += 1;
      tx.objectStore('deposits').put({ ...d, id: maxDepositId } satisfies DepositRecord);
      existingDepSigs.add(depSignature(d));
      addedDeposits += 1;
    }

    await idbTxDone(tx);

    await setMeta('nextUploadId', maxUploadId);
    await setMeta('nextTradeGroupId', maxGroupId);
    await setMeta('nextOrderId', maxOrderId);
    await setMeta('nextDepositId', maxDepositId);
    await setMeta(
      'nextAuditId',
      existingLogs.reduce((m, l) => Math.max(m, l.id), 0),
    );

    const rates = await getRatesInternal();
    for (const gid of new Set(groupIdRemap.values())) {
      await recomputeGroupById(gid, rates);
    }

    await appendAuditLog({
      actor,
      action: 'LOCAL_BACKUP_MERGED',
      entityType: 'backup',
      summary: `Merged PartnerDesk_Data backup (+${addedTrades} trade group(s), +${addedDeposits} deposit(s), +${addedScreenshots} screenshot(s)).`,
    });

    await syncPartnerDeskFolder();
    return { addedTrades, addedDeposits, addedScreenshots };
  },
};
