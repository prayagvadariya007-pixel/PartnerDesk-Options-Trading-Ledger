import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarChart3,
  Download,
  FolderCheck,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PlusSquare,
  RefreshCw,
  Settings,
  Upload,
  UserCheck,
  Wallet,
  X,
} from 'lucide-react';
import { DEFAULT_CHARGE_RATES } from '../shared/calculations.ts';
import type {
  ChargeRates,
  DepositRecord,
  PartnerId,
  TradeGroupRecord,
} from '../shared/types.ts';
import { api, setAuthToken, type AuthStatusResponse, type DashboardResponse } from './lib/api.ts';
import { exportLedgerToExcel } from './lib/exportExcel.ts';
import { AnalyticsView } from './components/AnalyticsView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { FundsView } from './components/FundsView.tsx';
import { LoginView } from './components/LoginView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { SunlitGalleryBackdrop } from './components/SunlitGalleryBackdrop.tsx';
import { TradingHistoryView } from './components/TradingHistoryView.tsx';
import { UploadTradeView } from './components/UploadTradeView.tsx';

type NavTab =
  | 'dashboard'
  | 'upload'
  | 'history'
  | 'analytics'
  | 'funds'
  | 'settings';

const NAV_ITEMS: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'upload', label: 'Upload Screenshot', icon: Upload },
  { id: 'history', label: 'Trading History', icon: History },
  { id: 'analytics', label: 'Profit Analytics', icon: BarChart3 },
  { id: 'funds', label: 'Add / Withdraw Funds', icon: Wallet },
  { id: 'settings', label: 'Sync, Folder & Settings', icon: Settings },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [partnerId, setPartnerId] = useState<PartnerId | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);

  const [dashboardData, setDashboardData] = useState<DashboardResponse | null>(null);
  const [trades, setTrades] = useState<TradeGroupRecord[]>([]);
  const [rates, setRates] = useState<ChargeRates>(DEFAULT_CHARGE_RATES);
  const [deposits, setDeposits] = useState<DepositRecord[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAuthStatus()
      .then(setAuthStatus)
      .catch((err) => {
        setGlobalError(err instanceof Error ? err.message : 'Unable to reach server.');
      });
  }, []);

  const refreshAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!partnerId) return;
      if (!opts?.silent) setLoadingData(true);
      if (!opts?.silent) setGlobalError(null);
      try {
        const [dash, tr, dep] = await Promise.all([
          api.getDashboard(),
          api.listTrades(),
          api.listDeposits(),
        ]);
        setDashboardData(dash);
        setTrades(tr.trades);
        setRates(tr.rates);
        setDeposits(dep.deposits);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load shared ledger.';
        if (
          msg.toLowerCase().includes('session expired') ||
          msg.toLowerCase().includes('authentication')
        ) {
          setAuthToken(null, null);
          setPartnerId(null);
        } else if (!opts?.silent) {
          setGlobalError(msg);
        }
      } finally {
        if (!opts?.silent) setLoadingData(false);
      }
    },
    [partnerId],
  );

  useEffect(() => {
    if (!partnerId) return;
    void refreshAll();
  }, [partnerId, refreshAll]);

  // Auto-sync across Prayag & Raj's devices when returning to the tab or every 15s
  useEffect(() => {
    if (!partnerId) return;
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshAll({ silent: true });
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshAll({ silent: true });
      }
    }, 15000);
    return () => {
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      clearInterval(intervalId);
    };
  }, [partnerId, refreshAll]);

  const handleAuthenticated = (token: string, id: PartnerId) => {
    setAuthToken(token, id);
    setPartnerId(id);
    setAuthStatus((prev) => (prev ? { ...prev, needsInitialSetup: false } : prev));
  };

  const handleSignOut = () => {
    setAuthToken(null, null);
    setPartnerId(null);
    setMoreSheetOpen(false);
    setDashboardData(null);
    setTrades([]);
    setDeposits([]);
    api.getAuthStatus().then(setAuthStatus).catch(() => {});
  };

  const handleExportExcel = () => {
    exportLedgerToExcel({
      summary: dashboardData?.summary || null,
      trades,
      deposits,
    });
  };

  const navigateTo = (tab: NavTab) => {
    setActiveTab(tab);
    setMoreSheetOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!authStatus) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-6 text-sm text-slate-600">
        <SunlitGalleryBackdrop />
        {globalError ? (
          <div className="gallery-card rounded-2xl p-6 text-rose-700 max-w-md border-rose-200 space-y-3">
            <div>{globalError}</div>
            <button
              type="button"
              onClick={() => {
                setGlobalError(null);
                api
                  .getAuthStatus()
                  .then(setAuthStatus)
                  .catch((err) =>
                    setGlobalError(err instanceof Error ? err.message : 'Unable to reach server.'),
                  );
              }}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#111318] rounded-full cursor-pointer"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <div className="gallery-card rounded-full px-5 py-2.5 text-xs font-medium text-[#111318]">
            Opening shared PartnerDesk ledger...
          </div>
        )}
      </div>
    );
  }

  if (!partnerId) {
    return (
      <LoginView
        authStatus={authStatus}
        onAuthenticated={handleAuthenticated}
        onRefreshAuthStatus={() => {
          api.getAuthStatus().then(setAuthStatus).catch(() => {});
        }}
      />
    );
  }

  const currentNav = NAV_ITEMS.find((n) => n.id === activeTab)!;

  return (
    <div className="relative min-h-screen text-[#111318] flex overflow-x-hidden">
      <SunlitGalleryBackdrop />

      {/* Desktop Frosted Ceramic Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-white/85 backdrop-blur-md border-r border-slate-900/8 shrink-0 sticky top-0 h-screen z-20">
        <div className="h-16 px-6 flex items-center justify-between border-b border-slate-900/8">
          <span className="font-display text-lg font-bold tracking-tight text-[#111318] whitespace-nowrap">
            PartnerDesk
          </span>
        </div>

        <nav className="flex-1 p-3.5 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`relative w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-full transition-colors cursor-pointer whitespace-nowrap ${
                  active ? 'text-white' : 'text-slate-600 hover:bg-slate-900/5 hover:text-[#111318]'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="desktopNavActive"
                    transition={{ type: 'spring', stiffness: 450, damping: 34 }}
                    className="absolute inset-0 bg-[#111318] rounded-full shadow-sm -z-0"
                  />
                )}
                <Icon
                  className={`relative z-10 w-4 h-4 shrink-0 ${
                    active ? 'text-[#E6B949]' : 'text-slate-500'
                  }`}
                />
                <span className="relative z-10">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-900/8 space-y-3">
          <button
            type="button"
            onClick={() => navigateTo('settings')}
            className="w-full text-left px-3.5 py-2.5 bg-white/75 hover:bg-white border border-slate-900/8 rounded-2xl transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
              <FolderCheck className="w-3.5 h-3.5 shrink-0" />
              <span>Shared Live Ledger</span>
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 font-mono tabular-nums">
              {trades.length} trades · {deposits.length} entries
            </div>
          </button>

          <div className="px-3.5 py-2.5 bg-slate-900/[0.03] border border-slate-900/8 rounded-2xl">
            <div className="text-[11px] text-slate-500">Signed in Partner</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-[#111318]">
              <UserCheck className="w-4 h-4 text-[#C89D3C]" />
              <span>{partnerId}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-[#111318] border border-slate-900/10 rounded-full hover:bg-white/80 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Compact Frosted Header */}
        <header className="h-14 lg:h-16 bg-white/94 lg:bg-white/85 lg:backdrop-blur-md border-b border-slate-900/8 px-4 sm:px-8 flex items-center justify-between gap-3 sticky top-0 z-20">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="lg:hidden font-display text-sm font-bold text-[#111318] shrink-0">
              PartnerDesk
            </span>
            <span className="lg:hidden text-slate-300">/</span>
            <h1 className="font-display text-sm sm:text-lg font-bold text-[#111318] truncate">
              {currentNav.label}
            </h1>
          </div>

          {/* Mobile Quick Action Strip */}
          <div className="flex lg:hidden items-center gap-2 shrink-0">
            <span className="text-xs font-semibold text-[#111318] bg-white/85 border border-slate-900/10 px-2.5 py-1.5 rounded-full">
              {partnerId}
            </span>
            <button
              type="button"
              onClick={handleExportExcel}
              aria-label="Download Excel"
              className="min-w-[44px] min-h-[40px] inline-flex items-center justify-center gap-1 px-3 text-xs font-semibold text-[#111318] bg-white/90 hover:bg-white border border-slate-900/12 rounded-full cursor-pointer shadow-2xs"
            >
              <Download className="w-4 h-4" />
              <span>.xlsx</span>
            </button>
          </div>

          {/* Desktop Action Strip */}
          <div className="hidden lg:flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-[#111318] bg-white/80 hover:bg-white border border-slate-900/12 rounded-full cursor-pointer whitespace-nowrap transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Excel</span>
            </button>
            <button
              type="button"
              onClick={() => void refreshAll()}
              aria-label="Refresh shared ledger"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-[#111318] bg-white/60 hover:bg-white border border-slate-900/10 rounded-full cursor-pointer whitespace-nowrap transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            {activeTab !== 'upload' && (
              <motion.button
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={() => navigateTo('upload')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#111318] hover:bg-[#242934] rounded-full cursor-pointer whitespace-nowrap shrink-0 shadow-sm"
              >
                <Upload className="w-3.5 h-3.5 text-[#E6B949]" />
                <span>Upload Screenshot</span>
              </motion.button>
            )}
          </div>
        </header>

        <main className="flex-1 p-3.5 sm:p-6 lg:p-8 pb-24 lg:pb-8 max-w-[1440px] w-full mx-auto">
          {globalError && (
            <div
              role="alert"
              className="mb-4 sm:mb-6 p-3.5 text-sm text-rose-700 bg-rose-50/90 border border-rose-200 rounded-2xl"
            >
              {globalError}
            </div>
          )}

          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            {activeTab === 'dashboard' && (
              <DashboardView
                data={dashboardData}
                trades={trades}
                loading={loadingData && !dashboardData}
                onNavigate={(tab) => navigateTo(tab)}
                onExportExcel={handleExportExcel}
              />
            )}

            {activeTab === 'upload' && (
              <UploadTradeView
                rates={rates}
                existingTrades={trades}
                onSaved={() => void refreshAll()}
              />
            )}

            {activeTab === 'history' && (
              <TradingHistoryView
                trades={trades}
                loading={loadingData && trades.length === 0}
                onChanged={() => void refreshAll()}
                onExportExcel={handleExportExcel}
              />
            )}

            {activeTab === 'analytics' && <AnalyticsView trades={trades} />}

            {activeTab === 'funds' && (
              <FundsView
                deposits={deposits}
                summary={dashboardData?.summary || null}
                onChanged={() => void refreshAll()}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                partnerId={partnerId}
                rates={rates}
                envPasswordConfigured={authStatus.envPasswordConfigured}
                onRatesUpdated={(newRates) => {
                  setRates(newRates);
                  void refreshAll();
                }}
                onStorageChanged={() => void refreshAll()}
                onExportExcel={handleExportExcel}
              />
            )}
          </motion.div>
        </main>
      </div>

      {/* Thumb-First Mobile Fixed Bottom Tab Bar */}
      <nav
        aria-label="Mobile navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 grid grid-cols-5 bg-white/95 border-t border-slate-900/10 shadow-[0_-8px_24px_-12px_rgba(17,19,24,0.14)]"
      >
        {(
          [
            { id: 'dashboard', label: 'Home', icon: Home },
            { id: 'upload', label: 'Entry', icon: PlusSquare },
            { id: 'history', label: 'Trades', icon: History },
            { id: 'funds', label: 'Funds', icon: Wallet },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id && !moreSheetOpen;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigateTo(tab.id)}
              className={`min-h-[58px] py-1.5 px-1 flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors cursor-pointer ${
                active ? 'text-[#111318] font-semibold' : 'text-slate-500 hover:text-[#111318]'
              }`}
            >
              <span className="relative px-3 py-1 rounded-full flex items-center justify-center">
                {active && (
                  <motion.span
                    layoutId="mobileNavActive"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    className="absolute inset-0 bg-[#111318] rounded-full"
                  />
                )}
                <Icon
                  className={`relative z-10 w-4.5 h-4.5 ${
                    active ? 'text-[#E6B949]' : 'text-slate-500'
                  }`}
                />
              </span>
              <span className="leading-none">{tab.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMoreSheetOpen(true)}
          className={`min-h-[58px] py-1.5 px-1 flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors cursor-pointer ${
            moreSheetOpen || activeTab === 'analytics' || activeTab === 'settings'
              ? 'text-[#111318] font-semibold'
              : 'text-slate-500 hover:text-[#111318]'
          }`}
        >
          <span
            className={`relative px-3 py-1 rounded-full flex items-center justify-center ${
              moreSheetOpen || activeTab === 'analytics' || activeTab === 'settings'
                ? 'bg-[#111318] text-[#E6B949]'
                : ''
            }`}
          >
            <MoreHorizontal className="w-4.5 h-4.5" />
          </span>
          <span className="leading-none">More</span>
        </button>
      </nav>

      {/* Mobile Bottom Sheet Drawer (More Menu) */}
      <AnimatePresence>
        {moreSheetOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="lg:hidden fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-xs flex items-end"
            onClick={() => setMoreSheetOpen(false)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
              className="w-full bg-white/95 backdrop-blur-xl rounded-t-3xl border-t border-slate-900/10 p-5 pb-8 space-y-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto" />

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-[#111318]">
                    Signed in as {partnerId}
                  </div>
                  <div className="text-xs text-emerald-700 font-medium flex items-center gap-1 mt-0.5">
                    <FolderCheck className="w-3.5 h-3.5" />
                    <span>Shared Website Sync · Prayag & Raj</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMoreSheetOpen(false)}
                  aria-label="Close menu"
                  className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-slate-500 hover:text-[#111318] rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => navigateTo('analytics')}
                  className={`w-full min-h-[48px] px-4 flex items-center gap-3 rounded-2xl text-sm font-medium cursor-pointer ${
                    activeTab === 'analytics'
                      ? 'bg-[#111318] text-white'
                      : 'bg-slate-900/[0.04] text-[#111318] hover:bg-slate-900/[0.08]'
                  }`}
                >
                  <BarChart3
                    className={`w-4 h-4 ${
                      activeTab === 'analytics' ? 'text-[#E6B949]' : 'text-slate-600'
                    }`}
                  />
                  <span>Profit Analytics</span>
                </button>

                <button
                  type="button"
                  onClick={() => navigateTo('settings')}
                  className={`w-full min-h-[48px] px-4 flex items-center gap-3 rounded-2xl text-sm font-medium cursor-pointer ${
                    activeTab === 'settings'
                      ? 'bg-[#111318] text-white'
                      : 'bg-slate-900/[0.04] text-[#111318] hover:bg-slate-900/[0.08]'
                  }`}
                >
                  <Settings
                    className={`w-4 h-4 ${
                      activeTab === 'settings' ? 'text-[#E6B949]' : 'text-slate-600'
                    }`}
                  />
                  <span>Sync, Folder & Settings</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    handleExportExcel();
                    setMoreSheetOpen(false);
                  }}
                  className="w-full min-h-[48px] px-4 flex items-center gap-3 rounded-2xl text-sm font-medium bg-slate-900/[0.04] text-[#111318] hover:bg-slate-900/[0.08] cursor-pointer"
                >
                  <Download className="w-4 h-4 text-slate-600" />
                  <span>Download Excel Ledger (.xlsx)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    void refreshAll();
                    setMoreSheetOpen(false);
                  }}
                  className="w-full min-h-[48px] px-4 flex items-center gap-3 rounded-2xl text-sm font-medium bg-slate-900/[0.04] text-[#111318] hover:bg-slate-900/[0.08] cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4 text-slate-600" />
                  <span>Sync Shared Data</span>
                </button>

                <button
                  type="button"
                  onClick={handleSignOut}
                  className="w-full min-h-[48px] px-4 flex items-center gap-3 rounded-2xl text-sm font-medium bg-rose-50 text-rose-700 hover:bg-rose-100 cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

