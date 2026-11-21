import React, { useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  FileImage,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  buildTradeGroupKey,
  computeTradeGroupMetrics,
  DEFAULT_CHARGE_RATES,
  round2,
} from '../../shared/calculations.ts';
import type {
  ChargeRates,
  ExtractedOrderLeg,
  OptionType,
  OrderSide,
  TradeGroupRecord,
} from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDateShort, formatINR, todayIsoDate } from '../lib/format.ts';

interface UploadTradeViewProps {
  rates: ChargeRates;
  existingTrades: TradeGroupRecord[];
  onSaved: () => void;
}

export const UploadTradeView: React.FC<UploadTradeViewProps> = ({
  rates,
  existingTrades,
  onSaved,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [tradingDateMissingWarning, setTradingDateMissingWarning] = useState(false);
  const [ocrNotes, setOcrNotes] = useState<string>('');
  const [orders, setOrders] = useState<ExtractedOrderLeg[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const activeRates = rates || DEFAULT_CHARGE_RATES;

  const normalizeImageToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const maxDim = 2000;
          let { naturalWidth: w, naturalHeight: h } = img;
          if (!w || !h) {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Could not read image dimensions.'));
            return;
          }
          if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Canvas context unavailable.'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const preferPng =
            file.type === 'image/png' && file.size <= 2 * 1024 * 1024 && w <= 1600 && h <= 1600;
          const outUrl = preferPng
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', 0.92);
          URL.revokeObjectURL(objectUrl);
          resolve(outUrl);
        } catch (err) {
          URL.revokeObjectURL(objectUrl);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Unable to read the selected image file.'));
        reader.readAsDataURL(file);
      };
      img.src = objectUrl;
    });
  };

  const runOcrExtraction = async (dataUrl: string) => {
    setError(null);
    setSuccessMsg(null);
    setExtracting(true);
    setTradingDateMissingWarning(false);
    setOcrNotes('');
    try {
      const res = await api.extractScreenshot(dataUrl);
      if (!res.orders || res.orders.length === 0) {
        setError(
          'No executed CE/PE option orders were detected in this screenshot. You can add rows manually below or upload a clearer Order Book / Trade Book image.',
        );
        setOrders([]);
      } else {
        setOrders(res.orders);
        const anyMissingDate = !res.tradingDateFound || res.orders.some((o) => !o.tradingDate);
        setTradingDateMissingWarning(anyMissingDate);
        setOcrNotes(res.notes || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract screenshot.');
      setOrders([]);
    } finally {
      setExtracting(false);
    }
  };

  const processFile = async (file: File) => {
    setError(null);
    setSuccessMsg(null);
    const isImageMime = file.type.startsWith('image/');
    const isImageExt = /\.(png|jpe?g|webp|gif|bmp|heic|avif)$/i.test(file.name);
    if (!isImageMime && !isImageExt) {
      setError('Please upload an image screenshot (PNG, JPG, WEBP).');
      return;
    }

    try {
      const dataUrl = await normalizeImageToDataUrl(file);
      setScreenshotDataUrl(dataUrl);
      setFilename(file.name);
      await runOcrExtraction(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the selected image.');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  const addBlankLeg = (side: OrderSide = 'BUY') => {
    const base = orders[0];
    setOrders((prev) => [
      ...prev,
      {
        stockName: base?.stockName || '',
        tradingSymbol: base?.tradingSymbol || '',
        expiryDate: base?.expiryDate || '',
        strikePrice: base?.strikePrice || 0,
        optionType: base?.optionType || 'CE',
        side,
        quantity: base?.quantity || 0,
        lots: base?.lots || null,
        executionPrice: 0,
        amount: 0,
        executionTime: '09:30 AM',
        tradingDate: base?.tradingDate || todayIsoDate(),
      },
    ]);
  };

  const updateLeg = (idx: number, patch: Partial<ExtractedOrderLeg>) => {
    setOrders((prev) =>
      prev.map((item, i) => {
        if (i !== idx) return item;
        const next = { ...item, ...patch };
        if (
          ('quantity' in patch || 'executionPrice' in patch) &&
          !('amount' in patch) &&
          next.quantity > 0 &&
          next.executionPrice > 0
        ) {
          next.amount = round2(next.quantity * next.executionPrice);
        }
        return next;
      }),
    );
  };

  const deriveQtyFromAmount = (idx: number) => {
    const leg = orders[idx];
    if (!leg || leg.amount <= 0 || leg.executionPrice <= 0) return;
    const implied = Math.round(leg.amount / leg.executionPrice);
    updateLeg(idx, { quantity: implied });
  };

  const removeLeg = (idx: number) => {
    setOrders((prev) => prev.filter((_, i) => i !== idx));
  };

  const applyTradingDateToAll = (dateStr: string) => {
    setOrders((prev) => prev.map((o) => ({ ...o, tradingDate: dateStr })));
    if (dateStr) setTradingDateMissingWarning(false);
  };

  const previewGroups = useMemo(() => {
    const grouped = new Map<string, ExtractedOrderLeg[]>();
    for (const o of orders) {
      if (!o.stockName || !o.expiryDate || !o.tradingDate || !o.strikePrice) continue;
      const key = buildTradeGroupKey({
        tradingDate: o.tradingDate,
        stockName: o.stockName,
        expiryDate: o.expiryDate,
        strikePrice: o.strikePrice,
        optionType: o.optionType,
      });
      const list = grouped.get(key) || [];
      list.push(o);
      grouped.set(key, list);
    }

    return Array.from(grouped.entries()).map(([key, legs]) => {
      const existing = existingTrades.find((t) => t.groupKey === key);
      const combinedLegs = [
        ...(existing?.orders || []).map((o) => ({
          side: o.side,
          quantity: o.quantity,
          executionPrice: o.executionPrice,
          amount: o.amount,
        })),
        ...legs.map((o) => ({
          side: o.side,
          quantity: o.quantity,
          executionPrice: o.executionPrice,
          amount: o.amount,
        })),
      ];
      const metrics = computeTradeGroupMetrics(combinedLegs, activeRates);
      return {
        key,
        sample: legs[0],
        combiningWithExisting: Boolean(existing),
        metrics,
      };
    });
  }, [orders, existingTrades, activeRates]);

  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);

    if (orders.length === 0) {
      setError('Add or extract at least one order before saving.');
      return;
    }

    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      if (!o.stockName.trim()) {
        setError(`Row ${i + 1}: Stock name is required.`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.expiryDate)) {
        setError(`Row ${i + 1}: Valid expiry date (YYYY-MM-DD) is required.`);
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.tradingDate)) {
        setError(`Row ${i + 1}: Please confirm the Trading Date (YYYY-MM-DD).`);
        return;
      }
      if (o.tradingDate === o.expiryDate && tradingDateMissingWarning) {
        setError(`Row ${i + 1}: Confirm that Trading Date is not mistakenly set to Expiry Date.`);
        return;
      }
      if (o.strikePrice <= 0 || o.quantity <= 0 || o.executionPrice <= 0) {
        setError(`Row ${i + 1}: Strike price, unit quantity, and execution price must be positive.`);
        return;
      }
    }

    setSaving(true);
    try {
      const res = await api.saveOrders({
        screenshotDataUrl,
        originalFilename: filename,
        orders,
      });
      setSuccessMsg(
        `Saved ${orders.length} order(s) into ${res.affectedTrades.length} trade record(s) with screenshot attached.`,
      );
      setOrders([]);
      setScreenshotDataUrl(null);
      setFilename(null);
      setTradingDateMissingWarning(false);
      setOcrNotes('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save trade.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Dropzone + Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 gallery-card rounded-3xl p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4">
            <div>
              <h2 className="font-display text-base font-bold text-[#111318]">
                Upload Angel One Order Book / Trade Book Screenshot
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Upload a screenshot or tap Add Manual Order. Everything saves locally in PartnerDesk_Data.
              </p>
            </div>
            <button
              type="button"
              onClick={() => addBlankLeg('BUY')}
              className="w-full sm:w-auto min-h-[44px] sm:min-h-[38px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#111318] bg-white/90 hover:bg-white border border-slate-900/12 rounded-full cursor-pointer whitespace-nowrap shrink-0 shadow-2xs transition-colors"
            >
              <Plus className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#C89D3C]" />
              <span>Add Manual Order</span>
            </button>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer ${
              dragOver
                ? 'border-[#111318] bg-white/90 shadow-inner'
                : 'border-slate-900/18 bg-white/55 hover:bg-white/80 hover:border-slate-900/35'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void processFile(f);
                e.target.value = '';
              }}
            />
            <div className="w-12 h-12 rounded-2xl bg-[#111318] text-[#E6B949] flex items-center justify-center mx-auto mb-3 shadow-sm">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-[#111318]">
              {extracting
                ? 'Reading Angel One screenshot...'
                : 'Drop Angel One screenshot here, or click to browse'}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Supports PNG, JPG, WEBP & mobile screenshots · Duplicate screenshots are blocked
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 p-3.5 text-sm text-rose-700 bg-rose-50/90 border border-rose-200 rounded-2xl"
            >
              {error}
            </div>
          )}

          {successMsg && (
            <div className="mt-4 p-3.5 text-sm text-emerald-800 bg-emerald-50/90 border border-emerald-200 rounded-2xl flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        {/* Screenshot Thumbnail Panel */}
        <div className="gallery-card rounded-3xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-[#111318]">Original Screenshot</span>
            {filename && (
              <span className="text-xs text-slate-500 truncate max-w-[160px]">{filename}</span>
            )}
          </div>
          {screenshotDataUrl ? (
            <div className="border border-slate-900/10 rounded-2xl overflow-hidden bg-white/80">
              <img
                src={screenshotDataUrl}
                alt="Uploaded Angel One screenshot"
                referrerPolicy="no-referrer"
                className="w-full max-h-64 object-contain"
              />
            </div>
          ) : (
            <div className="h-44 border border-slate-900/10 rounded-2xl bg-slate-900/[0.03] flex flex-col items-center justify-center text-slate-400 text-xs">
              <FileImage className="w-6 h-6 mb-1.5" />
              <span>No screenshot selected yet</span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>Upload timestamp is captured automatically when saved.</span>
            {screenshotDataUrl && (
              <button
                type="button"
                disabled={extracting}
                onClick={() => void runOcrExtraction(screenshotDataUrl)}
                className="inline-flex items-center gap-1 text-[#111318] hover:text-[#9F771B] font-semibold cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${extracting ? 'animate-spin' : ''}`} />
                <span>{extracting ? 'Reading...' : 'Retry OCR'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Extracted Orders Review & Confirmation */}
      {orders.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="gallery-card rounded-3xl overflow-hidden"
        >
          <div className="px-4 sm:px-6 py-4 border-b border-slate-900/8 bg-slate-900/[0.025] flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <div>
              <h3 className="font-display text-sm font-bold text-[#111318] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#C89D3C]" />
                <span>Verify Orders Before Saving</span>
              </h3>
              {ocrNotes && <p className="text-xs text-slate-600 mt-0.5">{ocrNotes}</p>}
            </div>

            <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
              <label htmlFor="batch-trading-date" className="text-xs font-semibold text-slate-700">
                Trading Date:
              </label>
              <input
                id="batch-trading-date"
                type="date"
                value={orders[0]?.tradingDate || ''}
                onChange={(e) => applyTradingDateToAll(e.target.value)}
                className="flex-1 sm:flex-initial min-h-[42px] sm:min-h-0 px-3 py-1.5 text-xs bg-white/95 border border-slate-900/15 rounded-xl font-mono text-[#111318] focus:outline-none focus:border-[#111318]"
              />
              <button
                type="button"
                onClick={() => applyTradingDateToAll(todayIsoDate())}
                className="min-h-[42px] sm:min-h-0 px-3.5 py-1.5 text-xs font-semibold text-[#111318] bg-white border border-slate-900/15 rounded-full hover:bg-slate-50 cursor-pointer"
              >
                Use Today
              </button>
            </div>
          </div>

          {tradingDateMissingWarning && (
            <div className="px-4 sm:px-6 py-3 bg-amber-50 border-b border-amber-200 flex items-center gap-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
              <span>
                Trading Date was not clearly visible in the screenshot. Please confirm the actual execution date above (do not confuse with Expiry Date).
              </span>
            </div>
          )}

          {/* Mobile Stacked Order Cards */}
          <div className="md:hidden divide-y divide-slate-900/8">
            {orders.map((leg, idx) => (
              <div key={idx} className="p-4 space-y-3 bg-white/60">
                <div className="flex items-center justify-between gap-2">
                  <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900/5 rounded-full flex-1">
                    {(['BUY', 'SELL'] as OrderSide[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => updateLeg(idx, { side: s })}
                        className={`min-h-[40px] text-xs font-bold rounded-full cursor-pointer ${
                          leg.side === s
                            ? s === 'BUY'
                              ? 'bg-[#111318] text-white'
                              : 'bg-[#C89D3C] text-white'
                            : 'text-slate-600'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900/5 rounded-full w-28">
                    {(['CE', 'PE'] as OptionType[]).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => updateLeg(idx, { optionType: opt })}
                        className={`min-h-[40px] text-xs font-bold rounded-full cursor-pointer ${
                          leg.optionType === opt ? 'bg-white text-[#111318] shadow-xs' : 'text-slate-600'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => removeLeg(idx)}
                    aria-label="Remove order"
                    className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-slate-400 hover:text-rose-600 border border-slate-900/12 rounded-full"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-500 mb-1">Stock</label>
                    <input
                      type="text"
                      value={leg.stockName}
                      onChange={(e) => updateLeg(idx, { stockName: e.target.value.toUpperCase() })}
                      placeholder="HDFCBANK"
                      className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-semibold uppercase text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Strike Price</label>
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={leg.strikePrice || ''}
                      onChange={(e) => updateLeg(idx, { strikePrice: Number(e.target.value) })}
                      placeholder="830"
                      className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Trade Date</label>
                    <input
                      type="date"
                      value={leg.tradingDate}
                      onChange={(e) => updateLeg(idx, { tradingDate: e.target.value })}
                      className={`w-full h-11 px-2.5 border rounded-xl font-mono text-xs ${
                        !leg.tradingDate ? 'border-amber-400 bg-amber-50' : 'bg-white border-slate-900/15'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Expiry Date</label>
                    <input
                      type="date"
                      value={leg.expiryDate}
                      onChange={(e) => updateLeg(idx, { expiryDate: e.target.value })}
                      className="w-full h-11 px-2.5 bg-white border border-slate-900/15 rounded-xl font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Qty (Units)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        value={leg.quantity || ''}
                        onChange={(e) => updateLeg(idx, { quantity: Number(e.target.value) })}
                        placeholder="650"
                        className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-mono text-sm"
                      />
                      {leg.amount > 0 && leg.executionPrice > 0 && (
                        <button
                          type="button"
                          onClick={() => deriveQtyFromAmount(idx)}
                          title="Derive qty from Amount ÷ Price"
                          className="min-w-[44px] h-11 px-2 text-xs font-bold text-[#111318] bg-white border border-slate-900/15 rounded-xl"
                        >
                          ÷
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Exec Price (₹)</label>
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={leg.executionPrice || ''}
                      onChange={(e) => updateLeg(idx, { executionPrice: Number(e.target.value) })}
                      placeholder="3.35"
                      className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Amount (₹)</label>
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={leg.amount || ''}
                      onChange={(e) => updateLeg(idx, { amount: Number(e.target.value) })}
                      className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">Time</label>
                    <input
                      type="text"
                      value={leg.executionTime}
                      onChange={(e) => updateLeg(idx, { executionTime: e.target.value })}
                      className="w-full h-11 px-3 bg-white border border-slate-900/15 rounded-xl font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            ))}
            <div className="p-3 bg-slate-900/[0.025] flex justify-center">
              <button
                type="button"
                onClick={() => addBlankLeg(orders[orders.length - 1]?.side === 'BUY' ? 'SELL' : 'BUY')}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#111318] bg-white border border-slate-900/15 rounded-full"
              >
                <Plus className="w-4 h-4 text-[#C89D3C]" />
                <span>Add Another Order Leg</span>
              </button>
            </div>
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-900/8 bg-slate-900/[0.03] text-slate-600 font-semibold">
                  <th className="py-2.5 px-3">Side</th>
                  <th className="py-2.5 px-3">Stock</th>
                  <th className="py-2.5 px-3">Symbol</th>
                  <th className="py-2.5 px-3">Expiry Date</th>
                  <th className="py-2.5 px-3">Strike</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Trade Date</th>
                  <th className="py-2.5 px-3">Time</th>
                  <th className="py-2.5 px-3 text-right">Qty (Units)</th>
                  <th className="py-2.5 px-3 text-right">Price (₹)</th>
                  <th className="py-2.5 px-3 text-right">Amount (₹)</th>
                  <th className="py-2.5 px-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/8">
                {orders.map((leg, idx) => (
                  <tr key={idx} className="hover:bg-slate-900/[0.02]">
                    <td className="py-2 px-3">
                      <select
                        value={leg.side}
                        onChange={(e) => updateLeg(idx, { side: e.target.value as OrderSide })}
                        className={`px-2 py-1 border rounded-lg font-semibold ${
                          leg.side === 'BUY'
                            ? 'text-[#111318] border-slate-900/20 bg-slate-900/5'
                            : 'text-amber-800 border-amber-200 bg-amber-50'
                        }`}
                      >
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={leg.stockName}
                        onChange={(e) => updateLeg(idx, { stockName: e.target.value.toUpperCase() })}
                        className="w-24 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-medium uppercase"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={leg.tradingSymbol}
                        onChange={(e) => updateLeg(idx, { tradingSymbol: e.target.value.toUpperCase() })}
                        className="w-36 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono uppercase"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="date"
                        value={leg.expiryDate}
                        onChange={(e) => updateLeg(idx, { expiryDate: e.target.value })}
                        className="px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={leg.strikePrice || ''}
                        onChange={(e) => updateLeg(idx, { strikePrice: Number(e.target.value) })}
                        className="w-20 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono text-right"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <select
                        value={leg.optionType}
                        onChange={(e) =>
                          updateLeg(idx, { optionType: e.target.value as OptionType })
                        }
                        className="px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-medium"
                      >
                        <option value="CE">CE</option>
                        <option value="PE">PE</option>
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="date"
                        value={leg.tradingDate}
                        onChange={(e) => updateLeg(idx, { tradingDate: e.target.value })}
                        className={`px-2 py-1 border rounded-lg font-mono ${
                          !leg.tradingDate ? 'border-amber-400 bg-amber-50' : 'bg-white border-slate-900/15'
                        }`}
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={leg.executionTime}
                        onChange={(e) => updateLeg(idx, { executionTime: e.target.value })}
                        className="w-20 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono"
                      />
                    </td>
                    <td className="py-2 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          value={leg.quantity || ''}
                          onChange={(e) => updateLeg(idx, { quantity: Number(e.target.value) })}
                          className="w-20 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono text-right"
                        />
                        {leg.amount > 0 && leg.executionPrice > 0 && (
                          <button
                            type="button"
                            title="Derive units from Amount ÷ Price"
                            onClick={() => deriveQtyFromAmount(idx)}
                            className="px-1.5 py-1 text-[10px] font-semibold text-[#111318] bg-white border border-slate-900/15 rounded hover:bg-slate-50 cursor-pointer"
                          >
                            ÷
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={leg.executionPrice || ''}
                        onChange={(e) => updateLeg(idx, { executionPrice: Number(e.target.value) })}
                        className="w-20 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono text-right"
                      />
                    </td>
                    <td className="py-2 px-3 text-right">
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={leg.amount || ''}
                        onChange={(e) => updateLeg(idx, { amount: Number(e.target.value) })}
                        className="w-24 px-2 py-1 bg-white border border-slate-900/15 rounded-lg font-mono text-right"
                      />
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button
                        type="button"
                        onClick={() => removeLeg(idx)}
                        aria-label="Remove order row"
                        className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Live Calculation & Grouping Preview */}
          {previewGroups.length > 0 && (
            <div className="p-4 sm:p-6 border-t border-slate-900/8 bg-slate-900/[0.02] space-y-4">
              <h4 className="text-xs font-semibold text-slate-700">
                Automatic Grouping & Estimated Angel One Charges Preview
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {previewGroups.map(({ key, sample, combiningWithExisting, metrics }) => (
                  <div
                    key={key}
                    className="bg-white/90 border border-slate-900/10 rounded-2xl p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold text-[#111318]">
                          {sample.stockName} {sample.strikePrice} {sample.optionType}
                        </div>
                        <div className="text-xs text-slate-500">
                          Trade {formatDateShort(sample.tradingDate)} · Exp{' '}
                          {formatDateShort(sample.expiryDate)}
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-[#9F771B]">
                        {combiningWithExisting ? 'Merges with existing group' : 'New trade group'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs border-t border-slate-900/8 pt-3 font-mono tabular-nums">
                      <div className="text-slate-500">Total Buy ({metrics.buyQty} qty)</div>
                      <div className="text-right text-[#111318]">{formatINR(metrics.totalBuyAmount)}</div>
                      <div className="text-slate-500">Total Sell ({metrics.sellQty} qty)</div>
                      <div className="text-right text-[#111318]">{formatINR(metrics.totalSellAmount)}</div>
                      <div className="text-slate-700 font-semibold">Gross Profit/Loss</div>
                      <div
                        className={`text-right font-semibold ${
                          metrics.grossPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {metrics.realisedQty > 0 ? formatINR(metrics.grossPnl, true) : 'Open Position'}
                      </div>
                      <div className="text-slate-500">Brokerage (Est.)</div>
                      <div className="text-right text-slate-700">{formatINR(metrics.brokerage)}</div>
                      <div className="text-slate-500">STT + Exch + IPFT + SEBI + Stamp</div>
                      <div className="text-right text-slate-700">
                        {formatINR(
                          metrics.stt +
                            metrics.exchangeTxnCharge +
                            metrics.ipftCharge +
                            metrics.sebiCharge +
                            metrics.stampDuty,
                        )}
                      </div>
                      <div className="text-slate-500">GST (18%)</div>
                      <div className="text-right text-slate-700">{formatINR(metrics.gst)}</div>
                      <div className="text-slate-700 font-semibold border-t border-slate-900/8 pt-1.5">
                        Total Estimated Charges
                      </div>
                      <div className="text-right font-semibold text-[#111318] border-t border-slate-900/8 pt-1.5">
                        {formatINR(metrics.totalCharges)}
                      </div>
                      <div className="text-[#111318] font-bold">Final Net Profit/Loss</div>
                      <div
                        className={`text-right font-bold ${
                          metrics.netPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {metrics.realisedQty > 0 ? formatINR(metrics.netPnl, true) : 'Open Position'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="px-4 sm:px-6 py-4 border-t border-slate-900/8 bg-white/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span className="text-xs text-slate-500">
              Saved locally in PartnerDesk_Data · Estimated charges can be reconciled later with a Contract Note.
            </span>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => {
                  setOrders([]);
                  setScreenshotDataUrl(null);
                  setFilename(null);
                  setError(null);
                }}
                className="min-h-[46px] sm:min-h-[40px] px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-900/15 rounded-full hover:bg-slate-50 cursor-pointer"
              >
                Discard
              </button>
              <motion.button
                whileTap={{ scale: 0.98 }}
                type="button"
                disabled={saving}
                onClick={handleSave}
                className="flex-1 sm:flex-initial min-h-[46px] sm:min-h-[40px] px-5 py-2 text-xs font-semibold text-white bg-[#111318] hover:bg-[#242934] disabled:bg-slate-400 rounded-full cursor-pointer shadow-sm"
              >
                {saving ? 'Saving to PartnerDesk_Data...' : 'Confirm & Save Trade'}
              </motion.button>
            </div>
          </div>
        </motion.section>
      )}
    </div>
  );
};

