import React, { useMemo, useState } from 'react';
import { round2 } from '../../shared/calculations.ts';
import type { TradeGroupRecord } from '../../shared/types.ts';
import { formatDateShort, formatINR, formatINRCompact, todayIsoDate } from '../lib/format.ts';

interface AnalyticsViewProps {
  trades: TradeGroupRecord[];
}

type DatePreset =
  | 'TODAY'
  | 'LAST_7'
  | 'LAST_30'
  | 'THIS_MONTH'
  | 'THIS_YEAR'
  | 'ALL_TIME'
  | 'CUSTOM';

interface ChartPoint {
  label: string;
  value: number;
  sublabel?: string;
}

const InteractiveBarChart: React.FC<{
  title: string;
  subtitle: string;
  data: ChartPoint[];
  height?: number;
  colorMode?: 'PNL' | 'OBSIDIAN';
}> = ({ title, subtitle, data, height = 220, colorMode = 'PNL' }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="gallery-card rounded-3xl p-5">
        <h3 className="font-display text-sm font-bold text-[#111318]">{title}</h3>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        <div className="h-44 flex items-center justify-center text-xs text-slate-400">
          No completed trades in selected range
        </div>
      </div>
    );
  }

  const W = 560;
  const H = height;
  const padL = 58;
  const padR = 16;
  const padT = 18;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(0, ...data.map((d) => d.value));
  const minVal = Math.min(0, ...data.map((d) => d.value));
  const span = Math.max(1, maxVal - minVal);
  const zeroY = padT + (maxVal / span) * plotH;

  const step = plotW / data.length;
  const barW = Math.min(36, Math.max(8, step * 0.62));

  return (
    <div className="gallery-card rounded-3xl p-5 relative">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="font-display text-sm font-bold text-[#111318]">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        {hoverIdx !== null && data[hoverIdx] && (
          <div className="text-right font-mono tabular-nums text-xs">
            <div className="text-slate-500">{data[hoverIdx].label}</div>
            <div
              className={`font-semibold ${
                colorMode === 'OBSIDIAN'
                  ? 'text-[#111318]'
                  : data[hoverIdx].value >= 0
                    ? 'text-emerald-700'
                    : 'text-rose-700'
              }`}
            >
              {formatINR(data[hoverIdx].value, colorMode === 'PNL')}
            </div>
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto overflow-visible">
        {/* Horizontal gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = padT + frac * plotH;
          const v = maxVal - frac * span;
          return (
            <g key={frac}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="rgba(17,19,24,0.06)" strokeWidth="1" />
              <text
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {formatINRCompact(v)}
              </text>
            </g>
          );
        })}

        {/* Zero baseline */}
        <line
          x1={padL}
          x2={W - padR}
          y1={zeroY}
          y2={zeroY}
          stroke="rgba(17,19,24,0.22)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />

        {data.map((d, i) => {
          const cx = padL + i * step + step / 2;
          const valY = padT + ((maxVal - d.value) / span) * plotH;
          const y = Math.min(zeroY, valY);
          const h = Math.max(2, Math.abs(valY - zeroY));
          const fill =
            colorMode === 'OBSIDIAN'
              ? '#111318'
              : d.value >= 0
                ? '#16a34a'
                : '#dc2626';
          const isHovered = hoverIdx === i;

          return (
            <g
              key={i}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              className="cursor-pointer"
            >
              <rect
                x={cx - barW / 2}
                y={y}
                width={barW}
                height={h}
                rx={3}
                fill={fill}
                opacity={hoverIdx === null || isHovered ? 0.92 : 0.45}
              />
              {(data.length <= 12 || i % Math.ceil(data.length / 8) === 0) && (
                <text
                  x={cx}
                  y={H - 10}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px] font-mono"
                >
                  {d.label.length > 10 ? d.label.slice(0, 10) : d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const CumulativeLineChart: React.FC<{
  data: ChartPoint[];
}> = ({ data }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="gallery-card rounded-3xl p-5">
        <h3 className="font-display text-sm font-bold text-[#111318]">5. Cumulative Net Profit / Loss</h3>
        <p className="text-xs text-slate-500 mt-0.5">Equity curve across completed trades</p>
        <div className="h-44 flex items-center justify-center text-xs text-slate-400">
          No completed trades in selected range
        </div>
      </div>
    );
  }

  const W = 560;
  const H = 220;
  const padL = 58;
  const padR = 16;
  const padT = 18;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(0, ...data.map((d) => d.value));
  const minVal = Math.min(0, ...data.map((d) => d.value));
  const span = Math.max(1, maxVal - minVal);
  const zeroY = padT + (maxVal / span) * plotH;

  const points = data.map((d, i) => {
    const x =
      data.length === 1 ? padL + plotW / 2 : padL + (i / (data.length - 1)) * plotW;
    const y = padT + ((maxVal - d.value) / span) * plotH;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x} ${zeroY} L ${points[0].x} ${zeroY} Z`
      : '';

  return (
    <div className="gallery-card rounded-3xl p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="font-display text-sm font-bold text-[#111318]">5. Cumulative Net Profit / Loss</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Running equity curve after brokerage & taxes
          </p>
        </div>
        {hoverIdx !== null && points[hoverIdx] ? (
          <div className="text-right font-mono tabular-nums text-xs">
            <div className="text-slate-500">{points[hoverIdx].label}</div>
            <div
              className={`font-semibold ${
                points[hoverIdx].value >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {formatINR(points[hoverIdx].value, true)}
            </div>
          </div>
        ) : (
          <div className="text-right font-mono tabular-nums text-xs">
            <div className="text-slate-500">Latest</div>
            <div
              className={`font-semibold ${
                points[points.length - 1].value >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {formatINR(points[points.length - 1].value, true)}
            </div>
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto overflow-visible">
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = padT + frac * plotH;
          const v = maxVal - frac * span;
          return (
            <g key={frac}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="rgba(17,19,24,0.06)" strokeWidth="1" />
              <text
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {formatINRCompact(v)}
              </text>
            </g>
          );
        })}

        <line
          x1={padL}
          x2={W - padR}
          y1={zeroY}
          y2={zeroY}
          stroke="rgba(17,19,24,0.22)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />

        {areaPath && <path d={areaPath} fill="#111318" opacity="0.08" />}
        {points.length > 1 && (
          <path d={linePath} fill="none" stroke="#111318" strokeWidth="2.5" strokeLinejoin="round" />
        )}

        {points.map((p, i) => (
          <g
            key={i}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            className="cursor-pointer"
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={hoverIdx === i ? 5 : 3.5}
              fill={p.value >= 0 ? '#C89D3C' : '#dc2626'}
              stroke="#ffffff"
              strokeWidth="1.5"
            />
            {(points.length <= 10 || i % Math.ceil(points.length / 6) === 0) && (
              <text
                x={p.x}
                y={H - 10}
                textAnchor="middle"
                className="fill-slate-500 text-[10px] font-mono"
              >
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
};

function getIsoWeekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ trades }) => {
  const [preset, setPreset] = useState<DatePreset>('ALL_TIME');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [stockFilter, setStockFilter] = useState('ALL');

  // Strictly only realised/completed trades (exclude unrealised open-only positions)
  const completedTrades = useMemo(
    () =>
      trades
        .filter((t) => t.realisedQty > 0)
        .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) || a.id - b.id),
    [trades],
  );

  const uniqueStocks = useMemo(() => {
    return Array.from(new Set(completedTrades.map((t) => t.stockName))).sort();
  }, [completedTrades]);

  const filtered = useMemo(() => {
    const today = todayIsoDate();
    const nowDate = new Date();
    const shiftDays = (days: number) => {
      const d = new Date(nowDate);
      d.setDate(d.getDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const monthPrefix = today.slice(0, 7);
    const yearPrefix = today.slice(0, 4);

    return completedTrades.filter((t) => {
      if (stockFilter !== 'ALL' && t.stockName !== stockFilter) return false;
      const td = t.tradingDate;
      if (preset === 'TODAY') return td === today;
      if (preset === 'LAST_7') return td >= shiftDays(6) && td <= today;
      if (preset === 'LAST_30') return td >= shiftDays(29) && td <= today;
      if (preset === 'THIS_MONTH') return td.startsWith(monthPrefix);
      if (preset === 'THIS_YEAR') return td.startsWith(yearPrefix);
      if (preset === 'CUSTOM') {
        if (customFrom && td < customFrom) return false;
        if (customTo && td > customTo) return false;
      }
      return true;
    });
  }, [completedTrades, preset, customFrom, customTo, stockFilter]);

  const dailyData = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, number>();
    for (const t of filtered) {
      map.set(t.tradingDate, round2((map.get(t.tradingDate) || 0) + t.netPnl));
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, v]) => ({ label: formatDateShort(d), value: v }));
  }, [filtered]);

  const weeklyData = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, number>();
    for (const t of filtered) {
      const wk = getIsoWeekKey(t.tradingDate);
      map.set(wk, round2((map.get(wk) || 0) + t.netPnl));
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wk, v]) => ({ label: wk, value: v }));
  }, [filtered]);

  const monthlyData = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, number>();
    for (const t of filtered) {
      const m = t.tradingDate.slice(0, 7);
      map.set(m, round2((map.get(m) || 0) + t.netPnl));
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => ({ label: m, value: v }));
  }, [filtered]);

  const yearlyData = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, number>();
    for (const t of filtered) {
      const y = t.tradingDate.slice(0, 4);
      map.set(y, round2((map.get(y) || 0) + t.netPnl));
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([y, v]) => ({ label: y, value: v }));
  }, [filtered]);

  const cumulativeData = useMemo<ChartPoint[]>(() => {
    let running = 0;
    return filtered.map((t) => {
      running = round2(running + t.netPnl);
      return { label: formatDateShort(t.tradingDate), value: running };
    });
  }, [filtered]);

  const tradeComparisonData = useMemo<ChartPoint[]>(() => {
    return filtered.map((t) => ({
      label: `${t.stockName} ${t.strikePrice}${t.optionType}`,
      value: t.netPnl,
    }));
  }, [filtered]);

  const stockWiseData = useMemo<ChartPoint[]>(() => {
    const map = new Map<string, number>();
    for (const t of filtered) {
      map.set(t.stockName, round2((map.get(t.stockName) || 0) + t.netPnl));
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([stock, val]) => ({ label: stock, value: val }));
  }, [filtered]);

  const winLossStats = useMemo(() => {
    const wins = filtered.filter((t) => t.netPnl > 0);
    const losses = filtered.filter((t) => t.netPnl < 0);
    const breakeven = filtered.filter((t) => t.netPnl === 0);
    const totalWinsAmt = round2(wins.reduce((s, t) => s + t.netPnl, 0));
    const totalLossAmt = round2(losses.reduce((s, t) => s + t.netPnl, 0));
    return {
      winsCount: wins.length,
      lossesCount: losses.length,
      breakevenCount: breakeven.length,
      total: filtered.length,
      winRate: filtered.length > 0 ? (wins.length / filtered.length) * 100 : 0,
      avgWin: wins.length > 0 ? round2(totalWinsAmt / wins.length) : 0,
      avgLoss: losses.length > 0 ? round2(totalLossAmt / losses.length) : 0,
    };
  }, [filtered]);

  const chargesBreakdown = useMemo<ChartPoint[]>(() => {
    return [
      { label: 'Brokerage', value: round2(filtered.reduce((s, t) => s + t.brokerage, 0)) },
      { label: 'STT', value: round2(filtered.reduce((s, t) => s + t.stt, 0)) },
      {
        label: 'Exchange',
        value: round2(filtered.reduce((s, t) => s + t.exchangeTxnCharge + t.ipftCharge, 0)),
      },
      { label: 'GST', value: round2(filtered.reduce((s, t) => s + t.gst, 0)) },
      {
        label: 'Stamp+SEBI',
        value: round2(
          filtered.reduce((s, t) => s + t.stampDuty + t.sebiCharge + t.otherCharges, 0),
        ),
      },
    ].filter((c) => c.value > 0 || filtered.length > 0);
  }, [filtered]);

  const partnerSplit = useMemo(() => {
    const totalNet = round2(filtered.reduce((s, t) => s + t.netPnl, 0));
    const totalGross = round2(filtered.reduce((s, t) => s + t.grossPnl, 0));
    const totalCharges = round2(filtered.reduce((s, t) => s + t.totalCharges, 0));
    const ownerShare = round2(totalNet / 2);
    const rajShare = round2(totalNet - ownerShare);
    return { totalNet, totalGross, totalCharges, ownerShare, rajShare };
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Filter Controls */}
      <div className="gallery-card rounded-3xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-900/5 border border-slate-900/8 rounded-2xl sm:rounded-full">
          {(
            [
              ['TODAY', 'Today'],
              ['LAST_7', 'Last 7 Days'],
              ['LAST_30', 'Last 30 Days'],
              ['THIS_MONTH', 'This Month'],
              ['THIS_YEAR', 'This Year'],
              ['ALL_TIME', 'All Time'],
              ['CUSTOM', 'Custom'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPreset(key)}
              className={`min-h-[34px] px-3 py-1.5 text-xs font-semibold rounded-full cursor-pointer whitespace-nowrap transition-colors ${
                preset === key
                  ? 'bg-[#111318] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#111318]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {preset === 'CUSTOM' && (
            <div className="flex items-center gap-1.5 text-xs">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-3 py-1.5 bg-white border border-slate-900/15 rounded-full font-mono"
              />
              <span className="text-slate-400">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-3 py-1.5 bg-white border border-slate-900/15 rounded-full font-mono"
              />
            </div>
          )}

          <select
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
            className="min-h-[38px] px-3.5 py-1.5 text-xs bg-white/90 border border-slate-900/12 rounded-full text-[#111318]"
          >
            <option value="ALL">All Stocks</option>
            {uniqueStocks.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="gallery-card rounded-2xl p-4">
          <div className="text-xs text-slate-500">Completed Trades</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#111318]">
            {filtered.length}
          </div>
        </div>
        <div className="gallery-card rounded-2xl p-4">
          <div className="text-xs text-slate-500">Realised Gross P&L</div>
          <div
            className={`mt-1 text-xl font-bold font-mono tabular-nums ${
              partnerSplit.totalGross >= 0 ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {formatINR(partnerSplit.totalGross, true)}
          </div>
        </div>
        <div className="gallery-card rounded-2xl p-4">
          <div className="text-xs text-slate-500">Brokerage & Taxes</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#111318]">
            {formatINR(partnerSplit.totalCharges)}
          </div>
        </div>
        <div className="gallery-card-dark rounded-2xl p-4 text-white">
          <div className="text-xs text-slate-300 font-medium">Realised Net P&L</div>
          <div
            className={`mt-1 text-xl font-bold font-mono tabular-nums ${
              partnerSplit.totalNet >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {formatINR(partnerSplit.totalNet, true)}
          </div>
        </div>
      </div>

      {/* Charts 1–4: Timeframe Bar Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <InteractiveBarChart
          title="1. Daily Net Profit / Loss"
          subtitle="Net realised P&L per trading day"
          data={dailyData}
        />
        <InteractiveBarChart
          title="2. Weekly Net Profit / Loss"
          subtitle="Net realised P&L aggregated by ISO week"
          data={weeklyData}
        />
        <InteractiveBarChart
          title="3. Monthly Net Profit / Loss"
          subtitle="Net realised P&L aggregated by calendar month"
          data={monthlyData}
        />
        <InteractiveBarChart
          title="4. Yearly Net Profit / Loss"
          subtitle="Annual net realised P&L comparison"
          data={yearlyData}
        />
      </div>

      {/* Charts 5–7: Cumulative, Trade Comparison, Stock-Wise */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CumulativeLineChart data={cumulativeData} />
        <InteractiveBarChart
          title="6. Individual Trade Profit / Loss"
          subtitle="Net realised P&L per completed option trade"
          data={tradeComparisonData}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <InteractiveBarChart
          title="7. Stock-Wise Net Profit / Loss"
          subtitle="Net realised performance by underlying symbol"
          data={stockWiseData}
        />
        <InteractiveBarChart
          title="9. Brokerage & Taxes Analysis"
          subtitle="Breakdown of total trading costs by charge category"
          data={chargesBreakdown}
          colorMode="OBSIDIAN"
        />
      </div>

      {/* Charts 8 & 10: Win vs Loss & 50:50 Partner Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 8. Winning vs Losing Trades */}
        <div className="gallery-card rounded-3xl p-5 space-y-4">
          <div>
            <h3 className="font-display text-sm font-bold text-[#111318]">
              8. Winning Trades vs Losing Trades
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Distribution of net-profitable vs net-losing completed trades
            </p>
          </div>
          {winLossStats.total === 0 ? (
            <div className="h-32 flex items-center justify-center text-xs text-slate-400">
              No completed trades in selected range
            </div>
          ) : (
            <>
              <div className="h-5 w-full bg-slate-900/8 rounded-full overflow-hidden flex">
                {winLossStats.winsCount > 0 && (
                  <div
                    style={{ width: `${(winLossStats.winsCount / winLossStats.total) * 100}%` }}
                    className="bg-emerald-600 h-full"
                    title={`Wins: ${winLossStats.winsCount}`}
                  />
                )}
                {winLossStats.lossesCount > 0 && (
                  <div
                    style={{ width: `${(winLossStats.lossesCount / winLossStats.total) * 100}%` }}
                    className="bg-rose-600 h-full"
                    title={`Losses: ${winLossStats.lossesCount}`}
                  />
                )}
              </div>
              <div className="grid grid-cols-3 gap-4 text-xs font-mono tabular-nums pt-1">
                <div>
                  <div className="text-slate-500 font-sans">Winning Trades</div>
                  <div className="text-base font-bold text-emerald-700 mt-0.5">
                    {winLossStats.winsCount} ({winLossStats.winRate.toFixed(1)}%)
                  </div>
                  <div className="text-slate-500">Avg: {formatINR(winLossStats.avgWin, true)}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Losing Trades</div>
                  <div className="text-base font-bold text-rose-700 mt-0.5">
                    {winLossStats.lossesCount} (
                    {((winLossStats.lossesCount / winLossStats.total) * 100).toFixed(1)}%)
                  </div>
                  <div className="text-slate-500">Avg: {formatINR(winLossStats.avgLoss, true)}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Breakeven</div>
                  <div className="text-base font-bold text-slate-700 mt-0.5">
                    {winLossStats.breakevenCount}
                  </div>
                  <div className="text-slate-500">Total: {winLossStats.total}</div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 10. Prayag vs Raj Profit/Loss Share */}
        <div className="gallery-card rounded-3xl p-5 space-y-4">
          <div>
            <h3 className="font-display text-sm font-bold text-[#111318]">
              10. Prayag vs Raj Profit/Loss Share
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Equal split of net realised profit/loss after all charges
            </p>
          </div>
          {filtered.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-xs text-slate-400">
              No completed trades in selected range
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-[#111318]">Prayag</span>
                  <span
                    className={`font-mono tabular-nums font-bold ${
                      partnerSplit.ownerShare >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {formatINR(partnerSplit.ownerShare, true)}
                  </span>
                </div>
                <div className="h-4 bg-slate-900/8 rounded-full overflow-hidden">
                  <div
                    className={`h-full w-1/2 rounded-full ${
                      partnerSplit.ownerShare >= 0 ? 'bg-[#111318]' : 'bg-rose-600'
                    }`}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-[#111318]">Raj</span>
                  <span
                    className={`font-mono tabular-nums font-bold ${
                      partnerSplit.rajShare >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {formatINR(partnerSplit.rajShare, true)}
                  </span>
                </div>
                <div className="h-4 bg-slate-900/8 rounded-full overflow-hidden">
                  <div
                    className={`h-full w-1/2 rounded-full ${
                      partnerSplit.rajShare >= 0 ? 'bg-[#C89D3C]' : 'bg-rose-500'
                    }`}
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-slate-900/8 flex justify-between text-xs font-mono tabular-nums text-slate-600">
                <span>Combined Net Realised P&L</span>
                <span className="font-bold text-[#111318]">
                  {formatINR(partnerSplit.totalNet, true)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
