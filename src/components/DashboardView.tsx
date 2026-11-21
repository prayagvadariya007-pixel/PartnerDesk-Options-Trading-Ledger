import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  BarChart2,
  Download,
  Landmark,
  PlusCircle,
  ReceiptIndianRupee,
  TrendingDown,
  TrendingUp,
  Upload,
  Wallet,
} from 'lucide-react';
import type { TradeGroupRecord } from '../../shared/types.ts';
import type { DashboardResponse } from '../lib/api.ts';
import { formatDateShort, formatINR } from '../lib/format.ts';
import { KineticCubeCluster } from './KineticCubeCluster.tsx';

interface DashboardViewProps {
  data: DashboardResponse | null;
  trades: TradeGroupRecord[];
  loading: boolean;
  onNavigate: (tab: 'upload' | 'history' | 'analytics' | 'funds') => void;
  onExportExcel: () => void;
}

type HorizonFilter = 'ALL' | '30D' | '7D';

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  trades,
  loading,
  onNavigate,
  onExportExcel,
}) => {
  const [horizon, setHorizon] = useState<HorizonFilter>('ALL');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const realisedTrades = useMemo(() => {
    const closed = trades
      .filter((t) => t.realisedQty > 0)
      .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) || a.id - b.id);

    if (horizon === 'ALL') return closed;
    const days = horizon === '7D' ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return closed.filter((t) => t.tradingDate >= cutoffIso);
  }, [trades, horizon]);

  const equitySeries = useMemo(() => {
    let running = 0;
    return realisedTrades.map((t) => {
      running = Math.round((running + t.netPnl) * 100) / 100;
      return {
        id: t.id,
        label: `${t.stockName} ${t.strikePrice} ${t.optionType}`,
        date: formatDateShort(t.tradingDate),
        tradePnl: t.netPnl,
        cumulative: running,
      };
    });
  }, [realisedTrades]);

  const stockLeaderboard = useMemo(() => {
    const map = new Map<string, { stock: string; netPnl: number; trades: number; wins: number }>();
    for (const t of realisedTrades) {
      const cur = map.get(t.stockName) || { stock: t.stockName, netPnl: 0, trades: 0, wins: 0 };
      cur.netPnl = Math.round((cur.netPnl + t.netPnl) * 100) / 100;
      cur.trades += 1;
      if (t.netPnl > 0) cur.wins += 1;
      map.set(t.stockName, cur);
    }
    return Array.from(map.values())
      .sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl))
      .slice(0, 5);
  }, [realisedTrades]);

  const tradeHighlights = useMemo(() => {
    if (realisedTrades.length === 0) {
      return { best: null as TradeGroupRecord | null, worst: null as TradeGroupRecord | null, avgNet: 0 };
    }
    let best = realisedTrades[0];
    let worst = realisedTrades[0];
    let total = 0;
    for (const t of realisedTrades) {
      if (t.netPnl > best.netPnl) best = t;
      if (t.netPnl < worst.netPnl) worst = t;
      total += t.netPnl;
    }
    return {
      best,
      worst,
      avgNet: Math.round((total / realisedTrades.length) * 100) / 100,
    };
  }, [realisedTrades]);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 h-80 gallery-card rounded-3xl opacity-70" />
          <div className="lg:col-span-5 h-80 gallery-card rounded-3xl opacity-70" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="h-28 gallery-card rounded-3xl opacity-70" />
          ))}
        </div>
      </div>
    );
  }

  const { summary, recentTrades, openPositions, recentDeposits } = data;

  const winRate =
    summary.totalClosedTrades > 0
      ? (summary.winningTrades / summary.totalClosedTrades) * 100
      : 0;
  const netPositive = summary.totalNetPnl >= 0;
  const grossPositive = summary.totalGrossPnl >= 0;

  const totalAccountAbs = Math.max(
    Math.abs(summary.ownerOwnershipBalance) + Math.abs(summary.rajOwnershipBalance),
    1,
  );
  const prayagPct = Math.max(
    0,
    Math.min(100, (Math.max(0, summary.ownerOwnershipBalance) / totalAccountAbs) * 100),
  );
  const rajPct = Math.max(
    0,
    Math.min(100, (Math.max(0, summary.rajOwnershipBalance) / totalAccountAbs) * 100),
  );

  const returnOnCapitalPct =
    summary.totalPartnershipCapital > 0
      ? (summary.totalNetPnl / summary.totalPartnershipCapital) * 100
      : 0;

  // Interactive Equity Curve geometry
  const W = 620;
  const H = 200;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 18;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const curveValues = equitySeries.map((p) => p.cumulative);
  const minY = Math.min(0, ...curveValues);
  const maxY = Math.max(0, ...curveValues);
  const spanY = maxY - minY || 100;
  const zeroY = PAD_T + ((maxY - 0) / spanY) * plotH;

  const points = equitySeries.map((p, idx) => {
    const x =
      equitySeries.length === 1
        ? PAD_L + plotW / 2
        : PAD_L + (idx / (equitySeries.length - 1)) * plotW;
    const y = PAD_T + ((maxY - p.cumulative) / spanY) * plotH;
    return { ...p, x, y };
  });

  const linePath = points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');

  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} L ${points[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`
      : '';

  const activePoint =
    hoverIdx !== null && points[hoverIdx]
      ? points[hoverIdx]
      : points.length > 0
        ? points[points.length - 1]
        : null;

  const chargesShareOfGross =
    summary.totalGrossPnl > 0
      ? Math.min(100, (summary.totalBrokerageAndTaxes / summary.totalGrossPnl) * 100)
      : 0;

  const maxStockAbs = Math.max(...stockLeaderboard.map((s) => Math.abs(s.netPnl)), 1);

  return (
    <div className="space-y-6">
      {/* Row 1: Focal Hero Split — Angel One Account + 3D Cube Showcase & Equity Curve (7 cols) | Partner Balances (5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-stretch">
        {/* Left Hero Card: Actual Angel One Account + Kinetic Cube Sculpture + Equity Trajectory */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="lg:col-span-7 gallery-card rounded-3xl p-4 sm:p-6 flex flex-col justify-between"
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <Landmark className="w-4 h-4 text-[#C89D3C]" />
                  <span>Total Angel One Account Balance</span>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-900/5 border border-slate-900/10 rounded-full">
                  {(['7D', '30D', 'ALL'] as HorizonFilter[]).map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => {
                        setHorizon(h);
                        setHoverIdx(null);
                      }}
                      className={`min-h-[32px] px-3 py-1 text-xs font-semibold rounded-full transition-colors cursor-pointer ${
                        horizon === h
                          ? 'bg-[#111318] text-white shadow-xs'
                          : 'text-slate-600 hover:text-[#111318]'
                      }`}
                    >
                      {h === 'ALL' ? 'All' : h}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-2.5 flex flex-wrap items-baseline gap-3">
                <span className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-[#111318] font-mono tabular-nums">
                  {formatINR(summary.totalAccountBalance)}
                </span>
                <span
                  className={`inline-flex items-center gap-1 text-xs font-semibold font-mono tabular-nums ${
                    netPositive ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {netPositive ? (
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowDownRight className="w-3.5 h-3.5" />
                  )}
                  {formatINR(summary.totalNetPnl, true)} net
                  {summary.totalPartnershipCapital > 0
                    ? ` (${returnOnCapitalPct >= 0 ? '+' : ''}${returnOnCapitalPct.toFixed(1)}% ROI)`
                    : ''}
                </span>
              </div>

              <p className="mt-1.5 text-xs text-slate-500 font-mono tabular-nums">
                Net Capital {formatINR(summary.totalPartnershipCapital)} · Gross P&L{' '}
                {formatINR(summary.totalGrossPnl, true)} · Charges{' '}
                {formatINR(summary.totalBrokerageAndTaxes)}
              </p>
            </div>

            {/* Compact 3D Isometric Cube + Spinning ₹ Token */}
            <div className="hidden sm:flex shrink-0 -my-2">
              <KineticCubeCluster compact />
            </div>
          </div>

          {/* Mobile compact sculpture strip */}
          <div className="sm:hidden flex justify-center py-1">
            <KineticCubeCluster compact />
          </div>

          {/* Interactive SVG Equity Curve */}
          <div className="mt-4 pt-4 border-t border-slate-900/8">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-2">
              <span className="font-semibold text-slate-700">Cumulative Net P&L Trajectory</span>
              {activePoint ? (
                <div className="font-mono tabular-nums text-slate-700">
                  <span className="text-slate-500 font-sans mr-2">
                    {activePoint.label} · {activePoint.date}
                  </span>
                  <span
                    className={`font-semibold ${
                      activePoint.cumulative >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {formatINR(activePoint.cumulative, true)}
                  </span>
                </div>
              ) : (
                <span className="text-slate-400">Upload trades to plot curve</span>
              )}
            </div>

            {points.length === 0 ? (
              <div className="h-44 rounded-2xl bg-slate-900/[0.03] border border-dashed border-slate-900/15 flex flex-col items-center justify-center text-center px-4">
                <BarChart2 className="w-6 h-6 text-[#C89D3C] mb-2" />
                <p className="text-xs text-slate-600 mb-3 max-w-sm">
                  Your equity curve will appear here automatically once your first completed Angel One trade is uploaded.
                </p>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={() => onNavigate('upload')}
                  className="min-h-[42px] inline-flex items-center gap-1.5 px-4 py-2 bg-[#111318] hover:bg-[#242934] text-white text-xs font-semibold rounded-full cursor-pointer shadow-sm"
                >
                  <Upload className="w-3.5 h-3.5 text-[#E6B949]" />
                  <span>Upload Trade Screenshot</span>
                </motion.button>
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full h-44 overflow-visible"
                role="img"
                aria-label="Cumulative net profit and loss trajectory"
                onMouseLeave={() => setHoverIdx(null)}
              >
                <defs>
                  <linearGradient id="dashEquityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={
                        points[points.length - 1].cumulative >= 0 ? '#111318' : '#e11d48'
                      }
                      stopOpacity="0.18"
                    />
                    <stop
                      offset="100%"
                      stopColor={
                        points[points.length - 1].cumulative >= 0 ? '#111318' : '#e11d48'
                      }
                      stopOpacity="0.01"
                    />
                  </linearGradient>
                </defs>

                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={PAD_T}
                  y2={PAD_T}
                  stroke="rgba(17,19,24,0.06)"
                  strokeWidth="1"
                />
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={zeroY}
                  y2={zeroY}
                  stroke="rgba(17,19,24,0.22)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={H - PAD_B}
                  y2={H - PAD_B}
                  stroke="rgba(17,19,24,0.06)"
                  strokeWidth="1"
                />

                <text
                  x={PAD_L - 6}
                  y={PAD_T + 4}
                  textAnchor="end"
                  className="fill-slate-400 text-[10px] font-mono"
                >
                  {formatINR(maxY)}
                </text>
                <text
                  x={PAD_L - 6}
                  y={zeroY + 3}
                  textAnchor="end"
                  className="fill-slate-400 text-[10px] font-mono"
                >
                  ₹0
                </text>

                {areaPath && <path d={areaPath} fill="url(#dashEquityGrad)" />}
                <path
                  d={linePath}
                  fill="none"
                  stroke={points[points.length - 1].cumulative >= 0 ? '#111318' : '#e11d48'}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {points.map((pt, idx) => {
                  const isActive =
                    hoverIdx === idx || (hoverIdx === null && idx === points.length - 1);
                  return (
                    <g key={pt.id}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isActive ? 5 : 3}
                        fill={pt.cumulative >= 0 ? '#C89D3C' : '#e11d48'}
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={14}
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoverIdx(idx)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </motion.section>

        {/* Right Card: Prayag vs Raj Individual Ownership Ledger */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          className="lg:col-span-5 gallery-card rounded-3xl p-4 sm:p-6 flex flex-col justify-between space-y-4 sm:space-y-5"
        >
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm sm:text-base font-bold text-[#111318]">
                Individual Partner Ownership
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('funds')}
                className="min-h-[36px] inline-flex items-center gap-1 text-xs font-semibold text-[#111318] hover:text-[#9F771B] cursor-pointer"
              >
                <PlusCircle className="w-3.5 h-3.5 text-[#C89D3C]" />
                <span>Add / Withdraw</span>
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Deposited capital stays with the funder · Net trading P&L divides equally
            </p>

            {/* Ownership Ratio Stacked Bar */}
            <div className="mt-4">
              <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-600 mb-1.5">
                <span>Prayag ({prayagPct.toFixed(1)}%)</span>
                <span>Raj ({rajPct.toFixed(1)}%)</span>
              </div>
              <div className="h-3 w-full bg-slate-900/8 rounded-full overflow-hidden flex">
                <div
                  style={{ width: `${prayagPct}%` }}
                  className="bg-[#111318] h-full transition-all duration-300"
                />
                <div
                  style={{ width: `${rajPct}%` }}
                  className="bg-[#C89D3C] h-full transition-all duration-300"
                />
              </div>
            </div>
          </div>

          {/* Individual Partner Ledgers */}
          <div className="divide-y divide-slate-900/8 border-t border-b border-slate-900/8">
            <div className="py-3.5 flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#111318] shrink-0" />
                  <span className="text-sm font-semibold text-[#111318]">Prayag</span>
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                  Capital {formatINR(summary.ownerTotalContribution)} · Trading{' '}
                  <span
                    className={
                      summary.ownerProfitShare >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }
                  >
                    {formatINR(summary.ownerProfitShare, true)}
                  </span>
                </div>
              </div>
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  summary.ownerOwnershipBalance < 0 ? 'text-rose-700' : 'text-[#111318]'
                }`}
              >
                {formatINR(summary.ownerOwnershipBalance)}
              </div>
            </div>

            <div className="py-3.5 flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#C89D3C] shrink-0" />
                  <span className="text-sm font-semibold text-[#111318]">Raj</span>
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                  Capital {formatINR(summary.rajTotalContribution)} · Trading{' '}
                  <span
                    className={summary.rajProfitShare >= 0 ? 'text-emerald-700' : 'text-rose-700'}
                  >
                    {formatINR(summary.rajProfitShare, true)}
                  </span>
                </div>
              </div>
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  summary.rajOwnershipBalance < 0 ? 'text-rose-700' : 'text-[#111318]'
                }`}
              >
                {formatINR(summary.rajOwnershipBalance)}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <motion.button
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={() => onNavigate('upload')}
              className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-1.5 py-2.5 px-4 bg-[#111318] hover:bg-[#242934] text-white text-xs font-semibold rounded-full cursor-pointer shadow-sm"
            >
              <Upload className="w-3.5 h-3.5 text-[#E6B949]" />
              <span>Upload Trade</span>
            </motion.button>
            <button
              type="button"
              onClick={onExportExcel}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 py-2.5 px-4 bg-white/85 hover:bg-white text-[#111318] border border-slate-900/12 text-xs font-semibold rounded-full cursor-pointer transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Excel (.xlsx)</span>
            </button>
          </div>
        </motion.section>
      </div>

      {/* Row 2: 4 Performance & Cost Efficiency Pulse Cards (2x2 on mobile, 4-up on desktop) */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
      >
        <div className="gallery-card rounded-2xl p-3.5 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-medium text-slate-500">
            <span>Realised Gross P&L</span>
            {grossPositive ? (
              <TrendingUp className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <TrendingDown className="w-4 h-4 text-rose-600 shrink-0" />
            )}
          </div>
          <div
            className={`mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums ${
              grossPositive ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {formatINR(summary.totalGrossPnl, true)}
          </div>
          <div className="mt-1.5 sm:mt-2 text-[11px] sm:text-xs text-slate-500 font-mono tabular-nums">
            Net: {formatINR(summary.totalNetPnl, true)}
          </div>
        </div>

        <div className="gallery-card rounded-2xl p-3.5 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-medium text-slate-500">
            <span>Win Rate</span>
            <Award className="w-4 h-4 text-[#C89D3C] shrink-0" />
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-1">
            <span className="text-lg sm:text-2xl font-bold text-[#111318] font-mono tabular-nums">
              {winRate.toFixed(1)}%
            </span>
            <span className="text-[11px] sm:text-xs font-mono tabular-nums text-slate-500">
              {summary.winningTrades}W / {summary.losingTrades}L
            </span>
          </div>
          <div className="mt-2.5 h-2 bg-slate-900/8 rounded-full overflow-hidden flex">
            <div
              style={{ width: `${winRate}%` }}
              className="bg-emerald-600 h-full transition-all duration-300"
            />
            <div
              style={{ width: `${summary.totalClosedTrades > 0 ? 100 - winRate : 0}%` }}
              className="bg-rose-400 h-full transition-all duration-300"
            />
          </div>
        </div>

        <div className="gallery-card rounded-2xl p-3.5 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-medium text-slate-500">
            <span>Options Turnover</span>
            <Wallet className="w-4 h-4 text-[#111318] shrink-0" />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold text-[#111318] font-mono tabular-nums">
            {formatINR(summary.totalBuyAmount + summary.totalSellAmount)}
          </div>
          <div className="mt-1.5 sm:mt-2 text-[11px] sm:text-xs text-slate-500 font-mono tabular-nums truncate">
            B {formatINR(summary.totalBuyAmount)} · S {formatINR(summary.totalSellAmount)}
          </div>
        </div>

        <div className="gallery-card rounded-2xl p-3.5 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-[11px] sm:text-xs font-medium text-slate-500">
            <span>Brokerage & Tax</span>
            <ReceiptIndianRupee className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold text-[#111318] font-mono tabular-nums">
            {formatINR(summary.totalBrokerageAndTaxes)}
          </div>
          <div className="mt-1.5 sm:mt-2 text-[11px] sm:text-xs text-slate-500 font-mono tabular-nums truncate">
            {summary.totalGrossPnl > 0
              ? `${chargesShareOfGross.toFixed(1)}% of gross`
              : 'STT, Exch, SEBI, GST'}
          </div>
        </div>
      </motion.div>

      {/* Row 3: Stock Performance Leaderboard + Open Positions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch"
      >
        <section className="lg:col-span-5 gallery-card rounded-3xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-display text-sm font-bold text-[#111318]">
                  Top Traded Contracts
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Net profit or loss grouped by underlying stock
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('analytics')}
                className="text-xs font-semibold text-[#111318] hover:text-[#9F771B] cursor-pointer"
              >
                Full Analytics →
              </button>
            </div>

            {stockLeaderboard.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                No completed trades yet for stock comparison.
              </div>
            ) : (
              <div className="space-y-3.5">
                {stockLeaderboard.map((item) => {
                  const widthPct = Math.max(8, (Math.abs(item.netPnl) / maxStockAbs) * 100);
                  const pos = item.netPnl >= 0;
                  return (
                    <div key={item.stock} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-[#111318]">
                          {item.stock}{' '}
                          <span className="font-normal text-slate-400 font-mono">
                            · {item.trades} {item.trades === 1 ? 'trade' : 'trades'}
                          </span>
                        </span>
                        <span
                          className={`font-mono tabular-nums font-semibold ${
                            pos ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {formatINR(item.netPnl, true)}
                        </span>
                      </div>
                      <div className="h-2 bg-slate-900/8 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${widthPct}%` }}
                          className={`h-full rounded-full ${pos ? 'bg-[#111318]' : 'bg-rose-500'}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {tradeHighlights.best && (
            <div className="mt-5 pt-4 border-t border-slate-900/8 grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-slate-500">Best Trade</div>
                <div className="mt-0.5 font-mono tabular-nums font-semibold text-emerald-700">
                  {formatINR(tradeHighlights.best.netPnl, true)}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {tradeHighlights.best.stockName} {tradeHighlights.best.strikePrice}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Worst Trade</div>
                <div
                  className={`mt-0.5 font-mono tabular-nums font-semibold ${
                    tradeHighlights.worst!.netPnl >= 0 ? 'text-[#111318]' : 'text-rose-700'
                  }`}
                >
                  {formatINR(tradeHighlights.worst!.netPnl, true)}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {tradeHighlights.worst!.stockName} {tradeHighlights.worst!.strikePrice}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Avg / Trade</div>
                <div
                  className={`mt-0.5 font-mono tabular-nums font-semibold ${
                    tradeHighlights.avgNet >= 0 ? 'text-[#111318]' : 'text-rose-700'
                  }`}
                >
                  {formatINR(tradeHighlights.avgNet, true)}
                </div>
                <div className="text-[11px] text-slate-400">
                  {realisedTrades.length} closed
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="lg:col-span-7 gallery-card rounded-3xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-900/8 flex items-center justify-between">
            <div>
              <h3 className="font-display text-sm font-bold text-[#111318]">
                Current Open Positions
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Unmatched buy or sell legs excluded from realised profit calculations
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-600">
              {openPositions.length} open
            </span>
          </div>
          {openPositions.length === 0 ? (
            <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
              <div className="text-sm font-semibold text-[#111318]">All positions squared off</div>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                No unmatched option quantities are currently open. Upload a new Angel One screenshot whenever you execute your next trade.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('upload')}
                className="mt-4 min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-[#111318] border border-slate-900/12 text-xs font-semibold rounded-full cursor-pointer shadow-2xs"
              >
                <Upload className="w-3.5 h-3.5 text-[#C89D3C]" />
                <span>Upload Trade Screenshot</span>
              </button>
            </div>
          ) : (
            <>
              <div className="md:hidden divide-y divide-slate-900/8">
                {openPositions.map((pos) => (
                  <div key={pos.id} className="p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-sm text-[#111318]">
                        {pos.stockName} {pos.strikePrice} {pos.optionType}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {formatDateShort(pos.tradingDate)} · Exp {formatDateShort(pos.expiryDate)}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div className="text-sm font-bold text-amber-700">
                        {pos.openQty} ({pos.openSide})
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatINR(
                          pos.openSide === 'BUY' ? pos.totalBuyAmount : pos.totalSellAmount,
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-900/8 bg-slate-900/[0.03] text-xs font-medium text-slate-600">
                      <th className="py-2.5 px-4">Contract</th>
                      <th className="py-2.5 px-4">Trade Date</th>
                      <th className="py-2.5 px-4 text-right">Open Qty</th>
                      <th className="py-2.5 px-4 text-right">Bought / Sold</th>
                      <th className="py-2.5 px-4 text-right">Avg Price</th>
                      <th className="py-2.5 px-4 text-right">Exposure</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/8">
                    {openPositions.map((pos) => (
                      <tr key={pos.id} className="hover:bg-slate-900/[0.025]">
                        <td className="py-2.5 px-4 font-medium text-[#111318]">
                          {pos.stockName} {pos.strikePrice} {pos.optionType}
                          <span className="ml-2 text-xs text-slate-500 font-normal">
                            Exp {formatDateShort(pos.expiryDate)}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 font-mono tabular-nums text-xs">
                          {formatDateShort(pos.tradingDate)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-amber-700 font-semibold">
                          {pos.openQty} ({pos.openSide})
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                          {pos.buyQty} / {pos.sellQty}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#111318]">
                          {formatINR(pos.openSide === 'BUY' ? pos.avgBuyPrice : pos.avgSellPrice)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#111318]">
                          {formatINR(
                            pos.openSide === 'BUY' ? pos.totalBuyAmount : pos.totalSellAmount,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </motion.div>

      {/* Row 4: Recent Trades + Recent Deposits & Withdrawals */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6"
      >
        <section className="lg:col-span-2 gallery-card rounded-3xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-900/8 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold text-[#111318]">Recent Trades</h3>
            <button
              type="button"
              onClick={() => onNavigate('history')}
              className="min-h-[36px] text-xs font-semibold text-[#111318] hover:text-[#9F771B] cursor-pointer"
            >
              View All →
            </button>
          </div>
          {recentTrades.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm text-slate-600 mb-3">
                No trades recorded yet. Upload your first Angel One screenshot to get started.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('upload')}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 bg-[#111318] hover:bg-[#242934] text-white text-xs font-semibold rounded-full cursor-pointer shadow-sm"
              >
                <Upload className="w-3.5 h-3.5 text-[#E6B949]" />
                <span>Upload Trade Screenshot</span>
              </button>
            </div>
          ) : (
            <>
              <div className="md:hidden divide-y divide-slate-900/8">
                {recentTrades.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onNavigate('history')}
                    className="w-full p-4 text-left flex items-center justify-between gap-3 hover:bg-slate-900/[0.03] cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-[#111318] truncate">
                        {t.stockName} {t.strikePrice} {t.optionType}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {formatDateShort(t.tradingDate)} · {t.realisedQty} qty
                        {t.openQty > 0 ? ` · ${t.openQty} open` : ''}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div
                        className={`text-sm font-bold ${
                          t.realisedQty === 0
                            ? 'text-amber-700'
                            : t.netPnl >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-700'
                        }`}
                      >
                        {t.realisedQty > 0 ? formatINR(t.netPnl, true) : 'Open'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Chg {formatINR(t.totalCharges)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-900/8 bg-slate-900/[0.03] text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">Contract</th>
                      <th className="py-2.5 px-4">Date</th>
                      <th className="py-2.5 px-4 text-right">Gross P&L</th>
                      <th className="py-2.5 px-4 text-right">Charges</th>
                      <th className="py-2.5 px-4 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/8">
                    {recentTrades.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => onNavigate('history')}
                        className="hover:bg-slate-900/[0.03] cursor-pointer transition-colors"
                      >
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-[#111318]">
                            {t.stockName} {t.strikePrice} {t.optionType}
                          </div>
                          <div className="text-xs text-slate-500">
                            Exp {formatDateShort(t.expiryDate)} · {t.realisedQty} qty
                            {t.openQty > 0 ? ` · ${t.openQty} open` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-xs text-slate-600 font-mono tabular-nums">
                          {formatDateShort(t.tradingDate)}
                        </td>
                        <td
                          className={`py-2.5 px-4 text-right font-mono tabular-nums text-xs ${
                            t.grossPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {t.realisedQty > 0 ? formatINR(t.grossPnl, true) : 'Open'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-600">
                          {formatINR(t.totalCharges)}
                        </td>
                        <td
                          className={`py-2.5 px-4 text-right font-mono tabular-nums font-semibold ${
                            t.netPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {t.realisedQty > 0 ? formatINR(t.netPnl, true) : 'Open'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="gallery-card rounded-3xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-900/8 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold text-[#111318]">
              Deposits & Withdrawals
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('funds')}
              className="text-xs font-semibold text-[#111318] hover:text-[#9F771B] cursor-pointer"
            >
              Add / Withdraw →
            </button>
          </div>
          {recentDeposits.length === 0 ? (
            <div className="p-5 text-xs text-slate-500">No fund entries recorded yet.</div>
          ) : (
            <ul className="divide-y divide-slate-900/8">
              {recentDeposits.map((d) => {
                const isWithdrawal = d.entryType === 'WITHDRAWAL';
                return (
                  <li key={d.id} className="px-5 py-3 flex items-center justify-between text-sm">
                    <div>
                      <div className="font-medium text-[#111318]">
                        {d.partner}{' '}
                        <span
                          className={`text-xs font-normal ${
                            isWithdrawal ? 'text-rose-600' : 'text-slate-500'
                          }`}
                        >
                          · {isWithdrawal ? 'Withdrawal' : 'Deposit'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">{formatDateShort(d.depositDate)}</div>
                    </div>
                    <div
                      className={`font-mono tabular-nums font-semibold ${
                        isWithdrawal ? 'text-rose-700' : 'text-emerald-700'
                      }`}
                    >
                      {isWithdrawal ? `-${formatINR(d.amount)}` : `+${formatINR(d.amount)}`}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </motion.div>
    </div>
  );
};

