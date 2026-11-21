import type {
  AuditLogRecord,
  ChargeRates,
  DashboardSummary,
  DepositRecord,
  ExtractedOrderLeg,
  FundEntryType,
  PartnerId,
  SettlementPreview,
  SettlementRecord,
  TradeGroupRecord,
} from '../../shared/types.ts';
import { localLedger, type LocalBackupPayload } from './localLedger.ts';

let memoryToken: string | null = null;
let migrationPromise: Promise<void> | null = null;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

export function setAuthToken(token: string | null, _partnerId?: PartnerId | null): void {
  memoryToken = token;
  if (!token) {
    migrationPromise = null;
  }
}

export function getAuthToken(): string | null {
  return memoryToken;
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (memoryToken) {
    headers.Authorization = `Bearer ${memoryToken}`;
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

async function ensureLegacyLocalMigratedOnce(): Promise<void> {
  if (!memoryToken) return;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      try {
        const pending = await localLedger.getPendingLegacyLocalBackup();
        if (pending) {
          await apiFetch('/api/sync/merge', {
            method: 'POST',
            body: JSON.stringify(pending),
          });
          await localLedger.markMigratedToSharedServer();
        }
      } catch {
        // Retry next session if offline/transient failure
        migrationPromise = null;
      }
    })();
  }
  return migrationPromise;
}

function scheduleMirrorSync(): void {
  if (!memoryToken) return;
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    if (!memoryToken) return;
    apiFetch<LocalBackupPayload>('/api/sync/backup')
      .then((payload) => localLedger.mirrorServerSnapshot(payload))
      .catch(() => {});
  }, 400);
}

export interface AuthStatusResponse {
  needsInitialSetup: boolean;
  envPasswordConfigured: boolean;
  persistent?: boolean;
}

export interface AuthSessionResponse {
  token: string;
  partnerId: PartnerId;
}

export interface DashboardResponse {
  summary: DashboardSummary;
  settlementPreview: SettlementPreview;
  recentTrades: TradeGroupRecord[];
  openPositions: TradeGroupRecord[];
  recentDeposits: DepositRecord[];
  recentSettlements: SettlementRecord[];
}

export interface OcrResponse {
  orders: ExtractedOrderLeg[];
  tradingDateFound: boolean;
  notes: string;
}

export const api = {
  getAuthStatus: () => apiFetch<AuthStatusResponse>('/api/auth/status'),

  setupPassword: (partnerId: PartnerId, password: string) =>
    apiFetch<AuthSessionResponse>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ partnerId, password }),
    }),

  login: (partnerId: PartnerId, password: string) =>
    apiFetch<AuthSessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ partnerId, password }),
    }),

  updatePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // All financial ledger reads & writes share the exact same website database for Prayag & Raj
  getDashboard: async (): Promise<DashboardResponse> => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<DashboardResponse>('/api/dashboard');
    scheduleMirrorSync();
    return res;
  },

  extractScreenshot: async (imageDataUrl: string): Promise<OcrResponse> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<OcrResponse>('/api/trades/ocr', {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl }),
    });
  },

  listTrades: async (): Promise<{ trades: TradeGroupRecord[]; rates: ChargeRates }> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<{ trades: TradeGroupRecord[]; rates: ChargeRates }>('/api/trades');
  },

  saveOrders: async (payload: {
    screenshotDataUrl?: string | null;
    originalFilename?: string | null;
    orders: ExtractedOrderLeg[];
  }) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{
      uploadId: number | null;
      uploadedAt: string;
      affectedTrades: TradeGroupRecord[];
    }>('/api/trades/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    scheduleMirrorSync();
    return res;
  },

  updateTrade: async (id: number, payload: Record<string, unknown>) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{ trade: TradeGroupRecord }>(`/api/trades/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    scheduleMirrorSync();
    return res;
  },

  deleteTrade: async (id: number) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{ ok: boolean }>(`/api/trades/${id}`, {
      method: 'DELETE',
    });
    scheduleMirrorSync();
    return res;
  },

  listDeposits: async (): Promise<{ deposits: DepositRecord[]; summary: DashboardSummary }> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<{ deposits: DepositRecord[]; summary: DashboardSummary }>('/api/deposits');
  },

  addDeposit: async (payload: {
    partner: PartnerId;
    entryType?: FundEntryType;
    amount: number;
    depositDate: string;
    referenceNote?: string;
  }) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{ deposit: DepositRecord }>('/api/deposits', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    scheduleMirrorSync();
    return res;
  },

  deleteDeposit: async (id: number) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{ ok: boolean }>(`/api/deposits/${id}`, {
      method: 'DELETE',
    });
    scheduleMirrorSync();
    return res;
  },

  getRates: async (): Promise<{ rates: ChargeRates }> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<{ rates: ChargeRates }>('/api/settings/rates');
  },

  updateRates: async (rates: ChargeRates & { recalculateExisting?: boolean }) => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{ rates: ChargeRates }>('/api/settings/rates', {
      method: 'PUT',
      body: JSON.stringify(rates),
    });
    scheduleMirrorSync();
    return res;
  },

  listAuditLogs: async (): Promise<{ logs: AuditLogRecord[] }> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<{ logs: AuditLogRecord[] }>('/api/audit-logs');
  },

  getBackupPayload: async (): Promise<LocalBackupPayload> => {
    await ensureLegacyLocalMigratedOnce();
    return apiFetch<LocalBackupPayload>('/api/sync/backup');
  },

  mergeBackupPayload: async (
    payload: Partial<LocalBackupPayload>,
  ): Promise<{ addedTrades: number; addedDeposits: number; addedScreenshots: number }> => {
    await ensureLegacyLocalMigratedOnce();
    const res = await apiFetch<{
      addedTrades: number;
      addedDeposits: number;
      addedScreenshots: number;
    }>('/api/sync/merge', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    scheduleMirrorSync();
    return res;
  },
};
