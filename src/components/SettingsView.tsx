import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FolderOpen,
  FolderSync,
  HardDrive,
  KeyRound,
  RotateCcw,
  Sliders,
  Unlink,
  Upload,
} from 'lucide-react';
import { DEFAULT_CHARGE_RATES } from '../../shared/calculations.ts';
import type { AuditLogRecord, ChargeRates, PartnerId } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { localLedger, type LocalStorageStatus } from '../lib/localLedger.ts';

interface SettingsViewProps {
  partnerId: PartnerId;
  rates: ChargeRates;
  envPasswordConfigured: boolean;
  onRatesUpdated: (rates: ChargeRates) => void;
  onStorageChanged: () => void;
  onExportExcel: () => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRateInput(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const fixed = value.toFixed(10).replace(/\.?0+$/, '');
  return fixed === '' ? '0' : fixed;
}

function ratesToInputs(r: ChargeRates): Record<keyof ChargeRates, string> {
  return {
    brokeragePerOrder: formatRateInput(r.brokeragePerOrder),
    sttSellPct: formatRateInput(r.sttSellPct),
    exchangeTxnPct: formatRateInput(r.exchangeTxnPct),
    ipftPct: formatRateInput(r.ipftPct),
    sebiPct: formatRateInput(r.sebiPct),
    stampDutyBuyPct: formatRateInput(r.stampDutyBuyPct),
    gstPct: formatRateInput(r.gstPct),
  };
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  partnerId,
  rates,
  envPasswordConfigured,
  onRatesUpdated,
  onStorageChanged,
  onExportExcel,
}) => {
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const [storageStatus, setStorageStatus] = useState<LocalStorageStatus | null>(null);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  const [workingFolder, setWorkingFolder] = useState(false);

  const [rateInputs, setRateInputs] = useState<Record<keyof ChargeRates, string>>(() =>
    ratesToInputs(rates),
  );
  const [recalcExisting, setRecalcExisting] = useState(false);
  const [savingRates, setSavingRates] = useState(false);
  const [ratesMsg, setRatesMsg] = useState<string | null>(null);
  const [ratesErr, setRatesErr] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);

  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);

  useEffect(() => {
    setRateInputs(ratesToInputs(rates));
  }, [rates]);

  const loadStatusAndLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const [backup, logsRes] = await Promise.all([
        api.getBackupPayload(),
        api.listAuditLogs(),
      ]);
      const status = await localLedger.getStorageStatus({
        tradesCount: backup.tradeGroups.length,
        ordersCount: backup.orders.length,
        screenshotsCount: backup.uploads.length,
        depositsCount: backup.deposits.length,
        auditLogsCount: logsRes.logs.length,
      });
      setStorageStatus(status);
      setAuditLogs(logsRes.logs);
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    void loadStatusAndLogs();
  }, [loadStatusAndLogs]);

  const handleLinkFolder = async () => {
    setFolderMsg(null);
    setFolderErr(null);
    setWorkingFolder(true);
    try {
      const res = await localLedger.linkLocalFolder();
      const backup = await api.getBackupPayload();
      await localLedger.mirrorServerSnapshot(backup);
      setFolderMsg(
        `Connected local folder "${res.folderPath}". Shared website updates now auto-mirror ledger_backup.json, trades.json, deposits.json, and PartnerDesk_Ledger.xlsx inside it.`,
      );
      await loadStatusAndLogs();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User closed picker
      } else {
        setFolderErr(err instanceof Error ? err.message : 'Could not link folder.');
      }
    } finally {
      setWorkingFolder(false);
    }
  };

  const handleGrantPermission = async () => {
    setFolderMsg(null);
    setFolderErr(null);
    setWorkingFolder(true);
    try {
      await localLedger.grantLinkedFolderPermission();
      const backup = await api.getBackupPayload();
      await localLedger.mirrorServerSnapshot(backup);
      setFolderMsg('Folder write access restored and synced with shared website data.');
      await loadStatusAndLogs();
    } catch (err) {
      setFolderErr(err instanceof Error ? err.message : 'Failed to verify folder access.');
    } finally {
      setWorkingFolder(false);
    }
  };

  const handleUnlinkFolder = async () => {
    setFolderMsg(null);
    setFolderErr(null);
    await localLedger.unlinkLocalFolder();
    setFolderMsg('Disconnected external folder link. Your shared website ledger remains intact.');
    await loadStatusAndLogs();
  };

  const handleDownloadBackup = async () => {
    setFolderMsg(null);
    setFolderErr(null);
    try {
      const payload = await api.getBackupPayload();
      localLedger.downloadJsonFromPayload(payload);
      setFolderMsg('Downloaded shared PartnerDesk JSON backup (all trades, screenshots, deposits, and logs).');
    } catch (err) {
      setFolderErr(err instanceof Error ? err.message : 'Failed to export backup.');
    }
  };

  const handleRestoreBackupFile = async (file: File) => {
    setFolderMsg(null);
    setFolderErr(null);
    setWorkingFolder(true);
    try {
      const text = await file.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error('Invalid backup JSON file.');
      }
      if (!parsed || !Array.isArray(parsed.deposits) || !Array.isArray(parsed.tradeGroups)) {
        throw new Error('Selected file is not a valid PartnerDesk backup.');
      }
      const res = await api.mergeBackupPayload(parsed);
      setFolderMsg(
        `Merged backup into shared website ledger for both Prayag & Raj: +${res.addedTrades} trade(s), +${res.addedDeposits} deposit(s), +${res.addedScreenshots} screenshot(s).`,
      );
      onStorageChanged();
      await loadStatusAndLogs();
    } catch (err) {
      setFolderErr(err instanceof Error ? err.message : 'Failed to import backup.');
    } finally {
      setWorkingFolder(false);
    }
  };

  const handleSaveRates = async (e: React.FormEvent) => {
    e.preventDefault();
    setRatesMsg(null);
    setRatesErr(null);

    const parsedRates: Partial<ChargeRates> = {};
    for (const key of Object.keys(rateInputs) as (keyof ChargeRates)[]) {
      const raw = rateInputs[key].trim();
      if (raw === '') {
        setRatesErr('Please fill in all charge rate fields (use 0 if a charge is zero).');
        return;
      }
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        setRatesErr(`Enter a valid non-negative number for ${key}.`);
        return;
      }
      parsedRates[key] = num;
    }

    setSavingRates(true);
    try {
      const res = await api.updateRates({
        ...(parsedRates as ChargeRates),
        recalculateExisting: recalcExisting,
      });
      onRatesUpdated(res.rates);
      setRateInputs(ratesToInputs(res.rates));
      setRatesMsg('Charge rates updated successfully for both Prayag & Raj.');
      void loadStatusAndLogs();
    } catch (err) {
      setRatesErr(err instanceof Error ? err.message : 'Failed to update rates.');
    } finally {
      setSavingRates(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdMsg(null);
    setPwdErr(null);
    if (newPassword.length < 6) {
      setPwdErr('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdErr('New passwords do not match.');
      return;
    }
    setSavingPwd(true);
    try {
      await api.updatePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwdMsg('Shared partnership password updated for both Prayag and Raj.');
      void loadStatusAndLogs();
    } catch (err) {
      setPwdErr(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setSavingPwd(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Local Device Folder (PartnerDesk_Data) & Zero-Cloud Storage Panel */}
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="gallery-card rounded-3xl p-4 sm:p-6 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-[#111318] flex items-center gap-2">
              <span className="w-7 h-7 rounded-xl bg-[#111318] text-[#E6B949] flex items-center justify-center shrink-0">
                <HardDrive className="w-3.5 h-3.5" />
              </span>
              <span>Shared Website Sync & Local Backup (PartnerDesk_Data)</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              Every trade, screenshot, deposit, and withdrawal is saved centrally on the website so Prayag and Raj always see the exact same data, and auto-mirrored to your device&apos;s{' '}
              <span className="font-mono font-semibold text-[#111318]">PartnerDesk_Data</span> folder.
            </p>
          </div>
          <span className="self-start inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-600/20 text-xs font-semibold text-emerald-800 whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
            <span>Shared Live Sync</span>
          </span>
        </div>

        {/* Storage Metrics Strip */}
        {storageStatus && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="gallery-card-dark rounded-2xl p-3.5 text-white">
              <div className="text-slate-300">Saved Trades</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-white">
                {storageStatus.tradesCount}
              </div>
              <div className="text-[11px] text-[#E6B949] font-mono tabular-nums">
                {storageStatus.ordersCount} order legs
              </div>
            </div>

            <div className="bg-slate-900/[0.03] border border-slate-900/10 rounded-2xl p-3.5">
              <div className="text-slate-500">Screenshots & Deposits</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#111318]">
                {storageStatus.screenshotsCount} / {storageStatus.depositsCount}
              </div>
              <div className="text-[11px] text-slate-500">Never auto-deleted</div>
            </div>

            <div className="bg-slate-900/[0.03] border border-slate-900/10 rounded-2xl p-3.5">
              <div className="text-slate-500">Local PartnerDesk_Data Mirror</div>
              <div className="mt-1 text-sm font-semibold text-[#111318]">
                {storageStatus.opfsSyncedAt ? 'Mirrored locally' : 'Ready'}
              </div>
              <div className="text-[11px] text-slate-500 font-mono truncate">
                {storageStatus.estimatedUsageBytes !== null
                  ? `${formatBytes(storageStatus.estimatedUsageBytes)} used`
                  : 'IndexedDB + OPFS'}
              </div>
            </div>

            <div className="bg-slate-900/[0.03] border border-slate-900/10 rounded-2xl p-3.5">
              <div className="text-slate-500">Visible OS Folder Link</div>
              <div className="mt-1 text-sm font-semibold text-[#111318] truncate">
                {storageStatus.linkedFolderName || 'Not linked yet'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {storageStatus.linkedFolderSyncedAt
                  ? `Synced ${formatDateTime(storageStatus.linkedFolderSyncedAt)}`
                  : storageStatus.directoryPickerSupported
                    ? 'Link laptop/phone folder below'
                    : 'Use JSON backup to transfer'}
              </div>
            </div>
          </div>
        )}

        {/* Linked Folder Permission Notice */}
        {storageStatus?.linkedFolderName && storageStatus.linkedFolderNeedsPermission && (
          <div className="p-3.5 bg-[#C89D3C]/10 border border-[#C89D3C]/30 rounded-2xl flex flex-wrap items-center justify-between gap-3 text-xs text-[#111318]">
            <span>
              Browser restarted: tap Re-connect Folder to resume auto-writing into{' '}
              <span className="font-mono font-semibold">{storageStatus.linkedFolderName}</span>.
            </span>
            <motion.button
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={handleGrantPermission}
              disabled={workingFolder}
              className="min-h-[42px] px-4 py-2 bg-[#111318] hover:bg-[#242934] text-white font-semibold rounded-full cursor-pointer shadow-xs"
            >
              Re-connect Folder
            </motion.button>
          </div>
        )}

        {/* Action Buttons (44px+ Mobile Friendly) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {storageStatus?.directoryPickerSupported && (
            <motion.button
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={handleLinkFolder}
              disabled={workingFolder}
              className="min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#111318] hover:bg-[#242934] text-white text-xs font-semibold rounded-full cursor-pointer shadow-xs"
            >
              <FolderOpen className="w-4 h-4 shrink-0 text-[#E6B949]" />
              <span>
                {storageStatus.linkedFolderName
                  ? 'Change PartnerDesk_Data Folder'
                  : 'Create / Link PartnerDesk_Data'}
              </span>
            </motion.button>
          )}

          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={handleDownloadBackup}
            className="min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white/90 hover:bg-white text-[#111318] border border-slate-900/15 text-xs font-semibold rounded-full cursor-pointer"
          >
            <Download className="w-4 h-4 shrink-0 text-[#C89D3C]" />
            <span>Save Full Backup (.json)</span>
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={() => restoreInputRef.current?.click()}
            disabled={workingFolder}
            className="min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white/90 hover:bg-white text-[#111318] border border-slate-900/15 text-xs font-semibold rounded-full cursor-pointer"
          >
            <Upload className="w-4 h-4 shrink-0 text-[#111318]" />
            <span>Merge / Restore Backup (.json)</span>
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={onExportExcel}
            className="min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white/90 hover:bg-white text-[#111318] border border-slate-900/15 text-xs font-semibold rounded-full cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4 shrink-0 text-emerald-700" />
            <span>Download Excel (.xlsx)</span>
          </motion.button>

          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleRestoreBackupFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {storageStatus?.linkedFolderName && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-900/8 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <FolderSync className="w-3.5 h-3.5 text-emerald-700" />
              Auto-syncing JSON + Excel files into{' '}
              <span className="font-mono font-semibold text-[#111318]">
                {storageStatus.linkedFolderName}
              </span>
            </span>
            <button
              type="button"
              onClick={handleUnlinkFolder}
              className="min-h-[36px] inline-flex items-center gap-1 text-slate-500 hover:text-rose-700 cursor-pointer"
            >
              <Unlink className="w-3.5 h-3.5" />
              <span>Disconnect Folder</span>
            </button>
          </div>
        )}

        {folderErr && (
          <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl">
            {folderErr}
          </div>
        )}
        {folderMsg && (
          <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{folderMsg}</span>
          </div>
        )}
      </motion.section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Angel One & NSE Charge Rates */}
        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          onSubmit={handleSaveRates}
          className="gallery-card rounded-3xl p-4 sm:p-6 space-y-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold text-[#111318] flex items-center gap-2">
                <span className="w-7 h-7 rounded-xl bg-[#111318] text-[#E6B949] flex items-center justify-center shrink-0">
                  <Sliders className="w-3.5 h-3.5" />
                </span>
                <span>Angel One & Exchange Charge Rates</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1.5">
                Configurable official NSE Equity/Index Options charge structure.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setRateInputs(ratesToInputs(DEFAULT_CHARGE_RATES));
                setRatesErr(null);
                setRatesMsg(null);
              }}
              className="min-h-[38px] px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#111318] bg-slate-900/5 hover:bg-slate-900/10 rounded-full cursor-pointer whitespace-nowrap transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#C89D3C]" />
              <span>Official Defaults</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {(
              [
                ['brokeragePerOrder', 'Brokerage / Executed Order (₹)'],
                ['sttSellPct', 'STT on Sell Premium (%)'],
                ['exchangeTxnPct', 'NSE Exchange Txn Charge (%)'],
                ['ipftPct', 'NSE IPFT Charge — Buy & Sell (%)'],
                ['sebiPct', 'SEBI Turnover Charge (%)'],
                ['stampDutyBuyPct', 'Stamp Duty on Buy (%)'],
                ['gstPct', 'GST on Brokerage+Exch+IPFT+SEBI (%)'],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <label className="block text-slate-600 font-medium mb-1">{label}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateInputs[field]}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '' || /^\d*\.?\d*$/.test(val)) {
                      setRateInputs((prev) => ({ ...prev, [field]: val }));
                    }
                  }}
                  placeholder="0"
                  className="w-full h-11 px-3.5 py-2 bg-white/90 border border-slate-900/15 rounded-2xl font-mono text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                />
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={recalcExisting}
              onChange={(e) => setRecalcExisting(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 accent-[#111318]"
            />
            <span>Recalculate existing Estimated trades (Contract Note trades remain untouched)</span>
          </label>

          {ratesErr && (
            <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl">
              {ratesErr}
            </div>
          )}
          {ratesMsg && (
            <div className="p-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>{ratesMsg}</span>
            </div>
          )}

          <motion.button
            whileTap={{ scale: 0.98 }}
            type="submit"
            disabled={savingRates}
            className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 bg-[#111318] hover:bg-[#242934] disabled:bg-slate-400 text-white text-xs font-semibold rounded-full cursor-pointer shadow-xs"
          >
            {savingRates ? 'Saving Rates...' : 'Save Charge Rates'}
          </motion.button>
        </motion.form>

        {/* Shared Password Settings */}
        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          onSubmit={handleUpdatePassword}
          className="gallery-card rounded-3xl p-4 sm:p-6 space-y-4"
        >
          <div>
            <h2 className="font-display text-base font-bold text-[#111318] flex items-center gap-2">
              <span className="w-7 h-7 rounded-xl bg-[#111318] text-[#E6B949] flex items-center justify-center shrink-0">
                <KeyRound className="w-3.5 h-3.5" />
              </span>
              <span>Shared Partnership Password</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1.5">
              Both Prayag and Raj login IDs use this shared password to unlock the ledger.
            </p>
          </div>

          {envPasswordConfigured ? (
            <div className="p-4 text-xs bg-slate-900/[0.04] border border-slate-900/12 rounded-2xl text-[#111318]">
              Password is currently configured via the{' '}
              <span className="font-mono font-semibold">PARTNER_ACCESS_PASSWORD</span> secret.
              Update it in Settings → Secrets to change it.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full h-11 px-3.5 py-2 text-xs bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  New Shared Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full h-11 px-3.5 py-2 text-xs bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full h-11 px-3.5 py-2 text-xs bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                />
              </div>

              {pwdErr && (
                <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl">
                  {pwdErr}
                </div>
              )}
              {pwdMsg && (
                <div className="p-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>{pwdMsg}</span>
                </div>
              )}

              <motion.button
                whileTap={{ scale: 0.98 }}
                type="submit"
                disabled={savingPwd}
                className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 bg-[#111318] hover:bg-[#242934] disabled:bg-slate-400 text-white text-xs font-semibold rounded-full cursor-pointer shadow-xs"
              >
                {savingPwd ? 'Updating...' : 'Update Shared Password'}
              </motion.button>
            </>
          )}
        </motion.form>
      </div>

      {/* Permanent Local Audit History */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.34, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="gallery-card rounded-3xl overflow-hidden"
      >
        <div className="px-4 sm:px-5 py-4 border-b border-slate-900/8 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-bold text-[#111318]">
              Shared Partnership Audit History
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Synced across both Prayag and Raj — trades, deposits, withdrawals, backups, and rate changes
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadStatusAndLogs()}
            className="min-h-[38px] px-3.5 text-xs font-semibold text-[#111318] bg-slate-900/5 hover:bg-slate-900/10 rounded-full cursor-pointer transition-colors"
          >
            Refresh
          </button>
        </div>

        {loadingLogs ? (
          <div className="p-6 text-xs text-slate-500">Loading audit history...</div>
        ) : auditLogs.length === 0 ? (
          <div className="p-6 text-xs text-slate-500">No audit entries yet.</div>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-white/95 backdrop-blur-xs border-b border-slate-900/10 text-slate-600 font-semibold">
                <tr>
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Partner</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/8">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/[0.025]">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 font-semibold text-[#111318]">{log.actor}</td>
                    <td className="py-2.5 px-4 font-mono text-[#9B7722] font-semibold">
                      {log.action}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{log.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.section>
    </div>
  );
};
