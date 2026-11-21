import React, { useMemo, useState } from 'react';
import {
  Check,
  Download,
  Edit3,
  Eye,
  FileCheck2,
  Image as ImageIcon,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ChargesMode, OptionType, OrderSide, TradeGroupRecord } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDateShort, formatDateTime, formatINR } from '../lib/format.ts';

interface TradingHistoryViewProps {
  trades: TradeGroupRecord[];
  loading: boolean;
  onChanged: () => void;
  onExportExcel: () => void;
}

export const TradingHistoryView: React.FC<TradingHistoryViewProps> = ({
  trades,
  loading,
  onChanged,
  onExportExcel,
}) => {
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CLOSED' | 'OPEN'>('ALL');

  const [selectedTrade, setSelectedTrade] = useState<TradeGroupRecord | null>(null);
  const [screenshotModalUrl, setScreenshotModalUrl] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TradeGroupRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [reconciling, setReconciling] = useState(false);
  const [cnForm, setCnForm] = useState({
    contractNoteRef: '',
    brokerage: 0,
    stt: 0,
    exchangeTxnCharge: 0,
    ipftCharge: 0,
    sebiCharge: 0,
    stampDuty: 0,
    gst: 0,
    otherCharges: 0,
  });

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{
    tradingDate: string;
    stockName: string;
    expiryDate: string;
    strikePrice: number;
    optionType: OptionType;
    notes: string;
    orders: {
      id?: number;
      side: OrderSide;
      quantity: number;
      lots: number | null;
      executionPrice: number;
      amount: number;
      executionTime: string;
    }[];
  } | null>(null);
  const [savingDetail, setSavingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const uniqueStocks = useMemo(() => {
    const set = new Set(trades.map((t) => t.stockName));
    return Array.from(set).sort();
  }, [trades]);

  const filteredTrades = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trades.filter((t) => {
      if (stockFilter !== 'ALL' && t.stockName !== stockFilter) return false;
      if (dateFrom && t.tradingDate < dateFrom) return false;
      if (dateTo && t.tradingDate > dateTo) return false;
      if (statusFilter === 'CLOSED' && t.openQty > 0) return false;
      if (statusFilter === 'OPEN' && t.openQty === 0) return false;
      if (q) {
        const hay = `${t.stockName} ${t.tradingSymbol} ${t.strikePrice} ${t.optionType} ${t.tradingDate}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [trades, search, stockFilter, dateFrom, dateTo, statusFilter]);

  const openDetailModal = (trade: TradeGroupRecord) => {
    setSelectedTrade(trade);
    setReconciling(false);
    setEditing(false);
    setDetailError(null);
    setCnForm({
      contractNoteRef: trade.contractNoteRef || '',
      brokerage: trade.brokerage,
      stt: trade.stt,
      exchangeTxnCharge: trade.exchangeTxnCharge,
      ipftCharge: trade.ipftCharge,
      sebiCharge: trade.sebiCharge,
      stampDuty: trade.stampDuty,
      gst: trade.gst,
      otherCharges: trade.otherCharges,
    });
    setEditForm({
      tradingDate: trade.tradingDate,
      stockName: trade.stockName,
      expiryDate: trade.expiryDate,
      strikePrice: trade.strikePrice,
      optionType: trade.optionType,
      notes: trade.notes || '',
      orders: (trade.orders || []).map((o) => ({
        id: o.id,
        side: o.side,
        quantity: o.quantity,
        lots: o.lots,
        executionPrice: o.executionPrice,
        amount: o.amount,
        executionTime: o.executionTime,
      })),
    });
  };

  const handleSaveContractNote = async (mode: ChargesMode) => {
    if (!selectedTrade) return;
    setSavingDetail(true);
    setDetailError(null);
    try {
      const res = await api.updateTrade(selectedTrade.id, {
        contractNote:
          mode === 'CONTRACT_NOTE'
            ? { mode, ...cnForm }
            : { mode: 'ESTIMATED' },
      });
      setSelectedTrade(res.trade);
      setReconciling(false);
      onChanged();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to update charges.');
    } finally {
      setSavingDetail(false);
    }
  };

  const handleSaveEdits = async () => {
    if (!selectedTrade || !editForm) return;
    setSavingDetail(true);
    setDetailError(null);
    try {
      const res = await api.updateTrade(selectedTrade.id, editForm);
      setSelectedTrade(res.trade);
      setEditing(false);
      onChanged();
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to update trade.');
    } finally {
      setSavingDetail(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteTrade(deleteTarget.id);
      if (selectedTrade?.id === deleteTarget.id) setSelectedTrade(null);
      setDeleteTarget(null);
      onChanged();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filters Bar */}
      <div className="gallery-card rounded-3xl p-3.5 sm:p-4 flex flex-wrap items-center gap-2.5 sm:gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stock, strike, symbol..."
            className="w-full min-h-[42px] sm:min-h-[38px] pl-10 pr-3.5 py-2 text-xs bg-white/90 border border-slate-900/12 rounded-full focus:outline-none focus:border-[#111318]"
          />
        </div>

        <select
          value={stockFilter}
          onChange={(e) => setStockFilter(e.target.value)}
          className="min-h-[42px] sm:min-h-[38px] px-3.5 py-2 text-xs bg-white/90 border border-slate-900/12 rounded-full text-[#111318]"
        >
          <option value="ALL">All Stocks</option>
          {uniqueStocks.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 text-xs text-slate-600 w-full sm:w-auto">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="From date"
            className="flex-1 sm:flex-initial min-h-[42px] sm:min-h-[38px] px-3 py-1.5 bg-white/90 border border-slate-900/12 rounded-full font-mono"
          />
          <span>to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="To date"
            className="flex-1 sm:flex-initial min-h-[42px] sm:min-h-[38px] px-3 py-1.5 bg-white/90 border border-slate-900/12 rounded-full font-mono"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-900/5 border border-slate-900/8 rounded-full">
          {(['ALL', 'CLOSED', 'OPEN'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`min-h-[34px] sm:min-h-0 px-3 py-1 text-xs font-semibold rounded-full cursor-pointer transition-colors ${
                statusFilter === st
                  ? 'bg-[#111318] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#111318]'
              }`}
            >
              {st === 'ALL' ? 'All' : st === 'CLOSED' ? 'Closed' : 'Open'}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onExportExcel}
          className="ml-auto sm:ml-0 min-h-[42px] sm:min-h-[38px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#111318] bg-white/90 hover:bg-white border border-slate-900/12 rounded-full cursor-pointer whitespace-nowrap shadow-2xs"
        >
          <Download className="w-3.5 h-3.5 text-[#C89D3C]" />
          <span>Download Excel (.xlsx)</span>
        </button>
      </div>

      {/* Main Trading History List */}
      <div className="gallery-card rounded-3xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading trading history...</div>
        ) : filteredTrades.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No matching trades found. Upload a trade screenshot or adjust your search filters.
          </div>
        ) : (
          <>
            {/* Mobile Tap-Card Feed */}
            <div className="md:hidden divide-y divide-slate-900/8">
              {filteredTrades.map((t) => (
                <div key={t.id} className="p-4 space-y-2.5">
                  <button
                    type="button"
                    onClick={() => openDetailModal(t)}
                    className="w-full text-left flex items-start justify-between gap-3 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-[#111318]">
                        {t.stockName} {t.strikePrice} {t.optionType}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {formatDateShort(t.tradingDate)} · Exp {formatDateShort(t.expiryDate)}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        Buy {t.buyQty} @ {t.buyQty > 0 ? formatINR(t.avgBuyPrice) : '—'} · Sell{' '}
                        {t.sellQty} @ {t.sellQty > 0 ? formatINR(t.avgSellPrice) : '—'}
                      </div>
                    </div>

                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div
                        className={`text-base font-bold ${
                          t.realisedQty === 0
                            ? 'text-amber-700'
                            : t.netPnl >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-700'
                        }`}
                      >
                        {t.realisedQty > 0 ? formatINR(t.netPnl, true) : `Open (${t.openQty})`}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Gross {t.realisedQty > 0 ? formatINR(t.grossPnl, true) : '—'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Chg {formatINR(t.totalCharges)}
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-900/8">
                    <span className="text-[11px] text-slate-400">
                      {t.chargesMode === 'CONTRACT_NOTE' ? 'Contract Note' : 'Estimated'}
                    </span>
                    <div className="flex items-center gap-2">
                      {t.screenshots && t.screenshots.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setScreenshotModalUrl(t.screenshots![0].imageDataUrl)}
                          className="min-h-[38px] inline-flex items-center gap-1 px-3 text-xs font-semibold text-[#111318] bg-white border border-slate-900/12 rounded-full cursor-pointer"
                        >
                          <ImageIcon className="w-3.5 h-3.5 text-[#C89D3C]" />
                          <span>Screenshot</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openDetailModal(t)}
                        className="min-h-[38px] inline-flex items-center gap-1 px-3 text-xs font-semibold text-white bg-[#111318] rounded-full cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5 text-[#E6B949]" />
                        <span>Details</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(t)}
                        aria-label="Delete trade"
                        className="min-w-[38px] min-h-[38px] inline-flex items-center justify-center text-slate-400 hover:text-rose-600 border border-slate-900/12 rounded-full cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-900/8 bg-slate-900/[0.03] text-slate-600 font-semibold">
                    <th className="py-3 px-3 whitespace-nowrap">Trade Date</th>
                    <th className="py-3 px-3 whitespace-nowrap">Upload Date</th>
                    <th className="py-3 px-3 whitespace-nowrap">Stock</th>
                    <th className="py-3 px-3 whitespace-nowrap">Expiry</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Strike</th>
                    <th className="py-3 px-3 whitespace-nowrap">Type</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Buy Qty</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Sell Qty</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Avg Buy</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Avg Sell</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Buy Amt</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Sell Amt</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Gross P&L</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Brokerage</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Taxes & Charges</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Net P&L</th>
                    <th className="py-3 px-3 text-center whitespace-nowrap">Screenshot</th>
                    <th className="py-3 px-3 text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/8">
                  {filteredTrades.map((t) => {
                    const taxesOther = t.totalCharges - t.brokerage;
                    return (
                      <tr key={t.id} className="hover:bg-slate-900/[0.025]">
                        <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap text-[#111318]">
                          {formatDateShort(t.tradingDate)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap text-slate-500">
                          {formatDateShort(t.uploadedAt)}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[#111318] whitespace-nowrap">
                          {t.stockName}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap text-slate-600">
                          {formatDateShort(t.expiryDate)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#111318]">
                          {t.strikePrice}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-700">{t.optionType}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#111318]">
                          {t.buyQty}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#111318]">
                          {t.sellQty}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {t.buyQty > 0 ? formatINR(t.avgBuyPrice) : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {t.sellQty > 0 ? formatINR(t.avgSellPrice) : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#111318]">
                          {formatINR(t.totalBuyAmount)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#111318]">
                          {formatINR(t.totalSellAmount)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono tabular-nums font-medium ${
                            t.realisedQty === 0
                              ? 'text-amber-700'
                              : t.grossPnl >= 0
                                ? 'text-emerald-700'
                                : 'text-rose-700'
                          }`}
                        >
                          {t.realisedQty > 0 ? formatINR(t.grossPnl, true) : `Open (${t.openQty})`}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {formatINR(t.brokerage)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {formatINR(taxesOther)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                            t.realisedQty === 0
                              ? 'text-amber-700'
                              : t.netPnl >= 0
                                ? 'text-emerald-700'
                                : 'text-rose-700'
                          }`}
                        >
                          {t.realisedQty > 0 ? formatINR(t.netPnl, true) : 'Open'}
                          <div className="text-[10px] font-normal text-slate-400">
                            {t.chargesMode === 'CONTRACT_NOTE' ? 'Contract Note' : 'Estimated'}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {t.screenshots && t.screenshots.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setScreenshotModalUrl(t.screenshots![0].imageDataUrl)}
                              className="inline-flex items-center gap-1 text-[#111318] hover:text-[#9F771B] font-semibold cursor-pointer"
                            >
                              <ImageIcon className="w-3.5 h-3.5 text-[#C89D3C]" />
                              <span>View</span>
                            </button>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openDetailModal(t)}
                              title="Inspect orders, charges & reconcile"
                              className="p-1 text-[#111318] hover:text-[#9F771B] cursor-pointer"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(t)}
                              title="Delete trade"
                              className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Trade Details Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white/95 backdrop-blur-xl border border-slate-900/12 rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="px-6 py-4 border-b border-slate-900/8 flex flex-wrap items-center justify-between gap-3 sticky top-0 bg-white/95 backdrop-blur-md z-10">
              <div>
                <h3 className="font-display text-base font-bold text-[#111318]">
                  {selectedTrade.stockName} {selectedTrade.strikePrice} {selectedTrade.optionType}
                </h3>
                <p className="text-xs text-slate-500">
                  Trade Date: {formatDateShort(selectedTrade.tradingDate)} · Expiry:{' '}
                  {formatDateShort(selectedTrade.expiryDate)} · Uploaded:{' '}
                  {formatDateTime(selectedTrade.uploadedAt)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!editing && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-[#111318] bg-white border border-slate-900/15 rounded-full hover:bg-slate-50 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Edit Trade</span>
                  </button>
                )}
                {!reconciling && (
                  <button
                    type="button"
                    onClick={() => setReconciling(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#111318] rounded-full hover:bg-[#242934] cursor-pointer"
                  >
                    <FileCheck2 className="w-3.5 h-3.5 text-[#E6B949]" />
                    <span>Reconcile Contract Note</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedTrade(null)}
                  aria-label="Close modal"
                  className="p-1.5 text-slate-400 hover:text-[#111318] cursor-pointer rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {detailError && (
                <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl">
                  {detailError}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="border border-slate-900/10 rounded-2xl p-4 space-y-2 text-xs font-mono tabular-nums bg-white/75">
                  <div className="text-sm font-sans font-bold text-[#111318] mb-2">
                    P&L & Charges Breakdown (
                    {selectedTrade.chargesMode === 'CONTRACT_NOTE'
                      ? 'Contract Note Actuals'
                      : 'Estimated Rates'}
                    )
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total Buy ({selectedTrade.buyQty} qty)</span>
                    <span>{formatINR(selectedTrade.totalBuyAmount)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total Sell ({selectedTrade.sellQty} qty)</span>
                    <span>{formatINR(selectedTrade.totalSellAmount)}</span>
                  </div>
                  <div className="flex justify-between font-semibold border-t border-slate-900/8 pt-2">
                    <span>Gross Profit / Loss</span>
                    <span
                      className={
                        selectedTrade.grossPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }
                    >
                      {selectedTrade.realisedQty > 0
                        ? formatINR(selectedTrade.grossPnl, true)
                        : 'Open Position'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Angel One Brokerage</span>
                    <span>{formatINR(selectedTrade.brokerage)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">STT</span>
                    <span>{formatINR(selectedTrade.stt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Exchange Txn Charges</span>
                    <span>{formatINR(selectedTrade.exchangeTxnCharge)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">NSE IPFT</span>
                    <span>{formatINR(selectedTrade.ipftCharge)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">SEBI Turnover Fee</span>
                    <span>{formatINR(selectedTrade.sebiCharge)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Stamp Duty</span>
                    <span>{formatINR(selectedTrade.stampDuty)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">GST (18%)</span>
                    <span>{formatINR(selectedTrade.gst)}</span>
                  </div>
                  {selectedTrade.otherCharges > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Other Charges</span>
                      <span>{formatINR(selectedTrade.otherCharges)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold border-t border-slate-900/8 pt-2">
                    <span>Total Charges</span>
                    <span>{formatINR(selectedTrade.totalCharges)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold border-t border-slate-900/12 pt-2">
                    <span>Final Net Profit / Loss</span>
                    <span
                      className={
                        selectedTrade.netPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }
                    >
                      {selectedTrade.realisedQty > 0
                        ? formatINR(selectedTrade.netPnl, true)
                        : 'Open Position'}
                    </span>
                  </div>
                </div>

                {/* Screenshot Preview */}
                <div className="border border-slate-900/10 rounded-2xl p-4 bg-white/75">
                  <div className="text-sm font-bold text-[#111318] mb-2">
                    Attached Screenshot(s)
                  </div>
                  {selectedTrade.screenshots && selectedTrade.screenshots.length > 0 ? (
                    <div className="space-y-3">
                      {selectedTrade.screenshots.map((sc) => (
                        <div key={sc.id} className="space-y-1">
                          <img
                            src={sc.imageDataUrl}
                            alt="Trade screenshot"
                            referrerPolicy="no-referrer"
                            onClick={() => setScreenshotModalUrl(sc.imageDataUrl)}
                            className="w-full max-h-56 object-contain bg-slate-50 border border-slate-900/10 rounded-xl cursor-pointer"
                          />
                          <div className="text-[11px] text-slate-500">
                            Uploaded by {sc.uploadedBy} on {formatDateTime(sc.uploadedAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="h-44 bg-slate-900/[0.03] border border-slate-900/10 rounded-xl flex items-center justify-center text-xs text-slate-400">
                      No screenshot attached
                    </div>
                  )}
                </div>
              </div>

              {reconciling && (
                <div className="border border-slate-900/12 bg-slate-900/[0.03] rounded-2xl p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-bold text-[#111318]">
                      Reconcile Actual Charges from Angel One Contract Note
                    </h4>
                    <button
                      type="button"
                      onClick={() => handleSaveContractNote('ESTIMATED')}
                      disabled={savingDetail}
                      className="text-xs text-slate-600 underline hover:text-[#111318] cursor-pointer"
                    >
                      Revert to Auto-Estimated Charges
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-600 mb-1">Contract Note Ref</label>
                      <input
                        type="text"
                        value={cnForm.contractNoteRef}
                        onChange={(e) => setCnForm({ ...cnForm, contractNoteRef: e.target.value })}
                        placeholder="e.g. CN-2026-1120"
                        className="w-full px-3 py-1.5 bg-white border border-slate-900/15 rounded-xl"
                      />
                    </div>
                    {(
                      [
                        ['brokerage', 'Brokerage (₹)'],
                        ['stt', 'STT (₹)'],
                        ['exchangeTxnCharge', 'Exchange Txn (₹)'],
                        ['ipftCharge', 'IPFT (₹)'],
                        ['sebiCharge', 'SEBI Fee (₹)'],
                        ['stampDuty', 'Stamp Duty (₹)'],
                        ['gst', 'GST (₹)'],
                        ['otherCharges', 'Other Charges (₹)'],
                      ] as const
                    ).map(([field, label]) => (
                      <div key={field}>
                        <label className="block text-slate-600 mb-1">{label}</label>
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={cnForm[field]}
                          onChange={(e) =>
                            setCnForm({ ...cnForm, [field]: Number(e.target.value) })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReconciling(false)}
                      className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-900/15 rounded-full cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={savingDetail}
                      onClick={() => handleSaveContractNote('CONTRACT_NOTE')}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[#111318] hover:bg-[#242934] rounded-full cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5 text-[#E6B949]" />
                      <span>Save Contract Note Actuals</span>
                    </button>
                  </div>
                </div>
              )}

              {editing && editForm && (
                <div className="border border-slate-900/12 bg-slate-900/[0.03] rounded-2xl p-5 space-y-4">
                  <h4 className="text-sm font-bold text-[#111318]">Edit Trade & Orders</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-600 mb-1">Trading Date</label>
                      <input
                        type="date"
                        value={editForm.tradingDate}
                        onChange={(e) => setEditForm({ ...editForm, tradingDate: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-600 mb-1">Stock</label>
                      <input
                        type="text"
                        value={editForm.stockName}
                        onChange={(e) =>
                          setEditForm({ ...editForm, stockName: e.target.value.toUpperCase() })
                        }
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-900/15 rounded-xl uppercase"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-600 mb-1">Expiry Date</label>
                      <input
                        type="date"
                        value={editForm.expiryDate}
                        onChange={(e) => setEditForm({ ...editForm, expiryDate: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-600 mb-1">Strike</label>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={editForm.strikePrice}
                        onChange={(e) =>
                          setEditForm({ ...editForm, strikePrice: Number(e.target.value) })
                        }
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-600 mb-1">Type</label>
                      <select
                        value={editForm.optionType}
                        onChange={(e) =>
                          setEditForm({ ...editForm, optionType: e.target.value as OptionType })
                        }
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-900/15 rounded-xl"
                      >
                        <option value="CE">CE</option>
                        <option value="PE">PE</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {editForm.orders.map((ord, i) => (
                      <div key={i} className="grid grid-cols-5 gap-2 text-xs">
                        <select
                          value={ord.side}
                          onChange={(e) => {
                            const next = [...editForm.orders];
                            next[i] = { ...ord, side: e.target.value as OrderSide };
                            setEditForm({ ...editForm, orders: next });
                          }}
                          className="px-2 py-1.5 bg-white border border-slate-900/15 rounded-xl"
                        >
                          <option value="BUY">BUY</option>
                          <option value="SELL">SELL</option>
                        </select>
                        <input
                          type="number"
                          value={ord.quantity}
                          onChange={(e) => {
                            const q = Number(e.target.value);
                            const next = [...editForm.orders];
                            next[i] = {
                              ...ord,
                              quantity: q,
                              amount: Math.round(q * ord.executionPrice * 100) / 100,
                            };
                            setEditForm({ ...editForm, orders: next });
                          }}
                          placeholder="Qty"
                          className="px-2 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                        />
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={ord.executionPrice}
                          onChange={(e) => {
                            const p = Number(e.target.value);
                            const next = [...editForm.orders];
                            next[i] = {
                              ...ord,
                              executionPrice: p,
                              amount: Math.round(ord.quantity * p * 100) / 100,
                            };
                            setEditForm({ ...editForm, orders: next });
                          }}
                          placeholder="Price"
                          className="px-2 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                        />
                        <input
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={ord.amount}
                          onChange={(e) => {
                            const next = [...editForm.orders];
                            next[i] = { ...ord, amount: Number(e.target.value) };
                            setEditForm({ ...editForm, orders: next });
                          }}
                          placeholder="Amount"
                          className="px-2 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                        />
                        <input
                          type="text"
                          value={ord.executionTime}
                          onChange={(e) => {
                            const next = [...editForm.orders];
                            next[i] = { ...ord, executionTime: e.target.value };
                            setEditForm({ ...editForm, orders: next });
                          }}
                          placeholder="Time"
                          className="px-2 py-1.5 bg-white border border-slate-900/15 rounded-xl font-mono"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="px-4 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-900/15 rounded-full cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={savingDetail}
                      onClick={handleSaveEdits}
                      className="px-4 py-1.5 text-xs font-semibold text-white bg-[#111318] hover:bg-[#242934] rounded-full cursor-pointer"
                    >
                      Save Changes
                    </button>
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-sm font-bold text-[#111318] mb-2">
                  Individual Executed Orders Combined in This Trade
                </h4>
                <div className="border border-slate-900/10 rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-900/[0.03] border-b border-slate-900/8 text-slate-600">
                        <th className="py-2 px-3">Side</th>
                        <th className="py-2 px-3">Execution Time</th>
                        <th className="py-2 px-3 text-right">Quantity</th>
                        <th className="py-2 px-3 text-right">Exec Price</th>
                        <th className="py-2 px-3 text-right">Amount</th>
                        <th className="py-2 px-3">Added By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-900/8 font-mono tabular-nums">
                      {(selectedTrade.orders || []).map((o) => (
                        <tr key={o.id}>
                          <td
                            className={`py-2 px-3 font-semibold ${
                              o.side === 'BUY' ? 'text-[#111318]' : 'text-amber-700'
                            }`}
                          >
                            {o.side}
                          </td>
                          <td className="py-2 px-3 text-slate-700">{o.executionTime}</td>
                          <td className="py-2 px-3 text-right text-[#111318]">{o.quantity}</td>
                          <td className="py-2 px-3 text-right text-[#111318]">
                            {formatINR(o.executionPrice)}
                          </td>
                          <td className="py-2 px-3 text-right text-[#111318] font-medium">
                            {formatINR(o.amount)}
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-600">{o.createdBy}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full Screenshot Lightbox */}
      {screenshotModalUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setScreenshotModalUrl(null)}
        >
          <div
            className="bg-white rounded-3xl max-w-4xl max-h-[90vh] overflow-hidden p-3 relative shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setScreenshotModalUrl(null)}
              aria-label="Close screenshot"
              className="absolute top-3 right-3 p-2 bg-white/95 border border-slate-900/15 rounded-full text-slate-700 hover:text-[#111318] cursor-pointer shadow-sm"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={screenshotModalUrl}
              alt="Full Angel One trade screenshot"
              referrerPolicy="no-referrer"
              className="max-h-[82vh] w-auto object-contain rounded-2xl"
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white/95 backdrop-blur-xl border border-slate-900/12 rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-display text-base font-bold text-[#111318]">Delete Trade Record?</h3>
            <p className="text-sm text-slate-600">
              This will permanently remove{' '}
              <span className="font-semibold text-[#111318]">
                {deleteTarget.stockName} {deleteTarget.strikePrice} {deleteTarget.optionType}
              </span>{' '}
              ({formatDateShort(deleteTarget.tradingDate)}) and recalculate all dashboard and partnership figures.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-900/15 rounded-full cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-full cursor-pointer"
              >
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

