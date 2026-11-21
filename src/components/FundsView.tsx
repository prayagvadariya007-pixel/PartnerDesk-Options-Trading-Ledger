import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDownLeft, ArrowUpRight, MinusCircle, PlusCircle, Trash2 } from 'lucide-react';
import type {
  DashboardSummary,
  DepositRecord,
  FundEntryType,
  PartnerId,
} from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDateShort, formatINR, todayIsoDate } from '../lib/format.ts';

interface FundsViewProps {
  deposits: DepositRecord[];
  summary: DashboardSummary | null;
  onChanged: () => void;
}

export const FundsView: React.FC<FundsViewProps> = ({ deposits, summary, onChanged }) => {
  const [entryType, setEntryType] = useState<FundEntryType>('DEPOSIT');
  const [partner, setPartner] = useState<PartnerId>('Prayag');
  const [amount, setAmount] = useState('');
  const [depositDate, setDepositDate] = useState(todayIsoDate());
  const [referenceNote, setReferenceNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const isWithdrawal = entryType === 'WITHDRAWAL';

  const partnerAvailableBalance = summary
    ? partner === 'Prayag'
      ? summary.ownerOwnershipBalance
      : summary.rajOwnershipBalance
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError(`Enter a valid positive ${isWithdrawal ? 'withdrawal' : 'deposit'} amount.`);
      return;
    }
    if (!depositDate) {
      setError('Date is required.');
      return;
    }
    setSaving(true);
    try {
      await api.addDeposit({
        partner,
        entryType,
        amount: amt,
        depositDate,
        referenceNote: referenceNote.trim() || undefined,
      });
      setAmount('');
      setReferenceNote('');
      setSuccess(
        isWithdrawal
          ? `Recorded ₹${amt.toLocaleString('en-IN')} withdrawal for ${partner}.`
          : `Recorded ₹${amt.toLocaleString('en-IN')} capital deposit for ${partner}.`,
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save fund entry.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteDeposit(id);
      setDeleteId(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete entry.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Capital & Individual Ownership Summary */}
      {summary && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4"
        >
          <div className="col-span-2 lg:col-span-1 gallery-card-dark rounded-2xl p-4 sm:p-5 text-white">
            <div className="text-xs font-medium text-slate-300">Angel One Account Balance</div>
            <div className="mt-1.5 text-xl font-bold text-white font-mono tabular-nums">
              {formatINR(summary.totalAccountBalance)}
            </div>
          </div>
          <div className="gallery-card rounded-2xl p-4 sm:p-5">
            <div className="text-xs font-medium text-slate-500">Net Capital Funded</div>
            <div className="mt-1.5 text-lg sm:text-xl font-bold text-[#111318] font-mono tabular-nums">
              {formatINR(summary.totalPartnershipCapital)}
            </div>
          </div>
          <div className="gallery-card rounded-2xl p-4 sm:p-5">
            <div className="text-xs font-medium text-slate-500">Prayag Net Capital</div>
            <div className="mt-1.5 text-lg sm:text-xl font-bold text-[#111318] font-mono tabular-nums">
              {formatINR(summary.ownerTotalContribution)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
              Bal: {formatINR(summary.ownerOwnershipBalance)}
            </div>
          </div>
          <div className="gallery-card rounded-2xl p-4 sm:p-5">
            <div className="text-xs font-medium text-slate-500">Raj Net Capital</div>
            <div className="mt-1.5 text-lg sm:text-xl font-bold text-[#111318] font-mono tabular-nums">
              {formatINR(summary.rajTotalContribution)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
              Bal: {formatINR(summary.rajOwnershipBalance)}
            </div>
          </div>
          <div className="col-span-2 lg:col-span-1 gallery-card rounded-2xl p-4 sm:p-5">
            <div className="text-xs font-medium text-slate-500">Net Trading P&L</div>
            <div
              className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                summary.totalNetPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {formatINR(summary.totalNetPnl, true)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
              Share each: {formatINR(summary.ownerProfitShare, true)}
            </div>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Add / Withdraw Funds Form */}
        <form
          onSubmit={handleSubmit}
          className={`gallery-card rounded-3xl p-4 sm:p-6 space-y-4 ${
            isWithdrawal ? 'ring-1 ring-rose-300/70' : ''
          }`}
        >
          {/* Mode Toggle: Add Funds vs Withdraw Funds */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-900/5 border border-slate-900/10 rounded-full">
            <button
              type="button"
              onClick={() => {
                setEntryType('DEPOSIT');
                setError(null);
                setSuccess(null);
              }}
              className={`min-h-[42px] inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-full transition-colors cursor-pointer ${
                !isWithdrawal
                  ? 'bg-[#111318] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#111318]'
              }`}
            >
              <PlusCircle className="w-4 h-4 shrink-0" />
              <span>Add Funds</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEntryType('WITHDRAWAL');
                setError(null);
                setSuccess(null);
              }}
              className={`min-h-[42px] inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-full transition-colors cursor-pointer ${
                isWithdrawal
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#111318]'
              }`}
            >
              <MinusCircle className="w-4 h-4 shrink-0" />
              <span>Withdraw Funds</span>
            </button>
          </div>

          <div>
            <h2 className="font-display text-base font-bold text-[#111318]">
              {isWithdrawal ? 'Withdraw Funds from Demat Account' : 'Add Funds to Demat Account'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {isWithdrawal
                ? 'Withdrawals deduct directly from the withdrawing partner’s ownership balance and total Angel One balance.'
                : 'Deposited capital belongs directly to the partner who funded it. Net trading P&L divides equally.'}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {isWithdrawal ? 'Who withdrew the funds?' : 'Who added the funds?'}
            </label>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-900/5 border border-slate-900/10 rounded-full">
              {(['Prayag', 'Raj'] as PartnerId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPartner(id)}
                  className={`min-h-[40px] py-2 px-3 text-xs font-semibold rounded-full cursor-pointer transition-colors ${
                    partner === id
                      ? 'bg-[#111318] text-white shadow-2xs'
                      : 'text-slate-700 hover:text-[#111318]'
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
            {partnerAvailableBalance !== null && (
              <div className="mt-1.5 text-[11px] text-slate-500 font-mono tabular-nums">
                {partner} current ownership balance: {formatINR(partnerAvailableBalance)}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="fund-amount" className="block text-xs font-semibold text-slate-700 mb-1">
              {isWithdrawal ? 'Withdrawal Amount (₹)' : 'Deposit Amount (₹)'}
            </label>
            <input
              id="fund-amount"
              type="number"
              step="any"
              inputMode="decimal"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={isWithdrawal ? 'e.g. 1000' : 'e.g. 3000'}
              className="w-full h-11 px-3.5 py-2 text-sm bg-white/90 border border-slate-900/15 rounded-2xl font-mono text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
            />
          </div>

          <div>
            <label htmlFor="fund-date" className="block text-xs font-semibold text-slate-700 mb-1">
              {isWithdrawal ? 'Withdrawal Date' : 'Deposit Date'}
            </label>
            <input
              id="fund-date"
              type="date"
              value={depositDate}
              onChange={(e) => setDepositDate(e.target.value)}
              className="w-full h-11 px-3.5 py-2 text-sm bg-white/90 border border-slate-900/15 rounded-2xl font-mono text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
            />
          </div>

          <div>
            <label htmlFor="fund-note" className="block text-xs font-semibold text-slate-700 mb-1">
              Reference / Notes (Optional)
            </label>
            <input
              id="fund-note"
              type="text"
              value={referenceNote}
              onChange={(e) => setReferenceNote(e.target.value)}
              placeholder={
                isWithdrawal ? 'Bank payout ref, UPI note...' : 'UPI ref, bank transfer note...'
              }
              className="w-full h-11 px-3.5 py-2 text-sm bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
            />
          </div>

          {error && (
            <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl">
              {error}
            </div>
          )}
          {success && (
            <div className="p-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-2xl">
              {success}
            </div>
          )}

          <motion.button
            whileTap={{ scale: 0.98 }}
            type="submit"
            disabled={saving}
            className={`w-full min-h-[46px] inline-flex items-center justify-center gap-2 py-2.5 px-5 text-white text-xs font-semibold rounded-full cursor-pointer shadow-sm ${
              isWithdrawal
                ? 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-400'
                : 'bg-[#111318] hover:bg-[#242934] disabled:bg-slate-400'
            }`}
          >
            {isWithdrawal ? (
              <MinusCircle className="w-4 h-4" />
            ) : (
              <PlusCircle className="w-4 h-4 text-[#E6B949]" />
            )}
            <span>
              {saving
                ? isWithdrawal
                  ? 'Recording Withdrawal...'
                  : 'Recording Deposit...'
                : isWithdrawal
                  ? 'Record Fund Withdrawal'
                  : 'Record Fund Deposit'}
            </span>
          </motion.button>
        </form>

        {/* Capital & Cashflow Ledger */}
        <div className="lg:col-span-2 gallery-card rounded-3xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-900/8 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold text-[#111318]">
              Deposits & Withdrawals Ledger
            </h3>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {deposits.length} entries
            </span>
          </div>
          {deposits.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No fund deposits or withdrawals recorded yet.
            </div>
          ) : (
            <>
              <div className="md:hidden divide-y divide-slate-900/8">
                {deposits.map((d) => {
                  const rowIsWithdrawal = d.entryType === 'WITHDRAWAL';
                  return (
                    <div key={d.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {rowIsWithdrawal ? (
                            <ArrowUpRight className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                          ) : (
                            <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          )}
                          <span className="font-semibold text-sm text-[#111318]">{d.partner}</span>
                          <span
                            className={`text-[11px] font-medium ${
                              rowIsWithdrawal ? 'text-rose-700' : 'text-emerald-700'
                            }`}
                          >
                            · {rowIsWithdrawal ? 'Withdrawal' : 'Deposit'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                          {formatDateShort(d.depositDate)}
                          {d.referenceNote ? ` · ${d.referenceNote}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div
                          className={`font-mono tabular-nums font-bold ${
                            rowIsWithdrawal ? 'text-rose-700' : 'text-emerald-700'
                          }`}
                        >
                          {rowIsWithdrawal ? `-${formatINR(d.amount)}` : `+${formatINR(d.amount)}`}
                        </div>
                        {deleteId === d.id ? (
                          <div className="flex items-center gap-1.5 text-xs">
                            <button
                              type="button"
                              onClick={() => handleDelete(d.id)}
                              className="min-h-[36px] px-2.5 bg-rose-600 text-white font-semibold rounded-full"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteId(null)}
                              className="min-h-[36px] px-2 text-slate-600 border border-slate-900/15 rounded-full"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteId(d.id)}
                            aria-label="Delete fund entry"
                            className="min-w-[40px] min-h-[40px] inline-flex items-center justify-center text-slate-400 hover:text-rose-600 border border-slate-900/12 rounded-full"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900/[0.03] border-b border-slate-900/8 text-slate-600 font-semibold">
                      <th className="py-2.5 px-4">Date</th>
                      <th className="py-2.5 px-4">Type</th>
                      <th className="py-2.5 px-4">Partner</th>
                      <th className="py-2.5 px-4">Reference / Notes</th>
                      <th className="py-2.5 px-4">Logged By</th>
                      <th className="py-2.5 px-4 text-right">Amount</th>
                      <th className="py-2.5 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/8">
                    {deposits.map((d) => {
                      const rowIsWithdrawal = d.entryType === 'WITHDRAWAL';
                      return (
                        <tr key={d.id} className="hover:bg-slate-900/[0.025]">
                          <td className="py-2.5 px-4 font-mono tabular-nums text-slate-700">
                            {formatDateShort(d.depositDate)}
                          </td>
                          <td className="py-2.5 px-4">
                            <span
                              className={`inline-flex items-center gap-1 font-semibold ${
                                rowIsWithdrawal ? 'text-rose-700' : 'text-emerald-700'
                              }`}
                            >
                              {rowIsWithdrawal ? (
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              ) : (
                                <ArrowDownLeft className="w-3.5 h-3.5" />
                              )}
                              <span>{rowIsWithdrawal ? 'Withdrawal' : 'Deposit'}</span>
                            </span>
                          </td>
                          <td className="py-2.5 px-4 font-semibold text-[#111318]">
                            {d.partner}
                          </td>
                          <td className="py-2.5 px-4 text-slate-600">{d.referenceNote || '—'}</td>
                          <td className="py-2.5 px-4 text-slate-500">{d.createdBy}</td>
                          <td
                            className={`py-2.5 px-4 text-right font-mono tabular-nums font-semibold ${
                              rowIsWithdrawal ? 'text-rose-700' : 'text-emerald-700'
                            }`}
                          >
                            {rowIsWithdrawal
                              ? `-${formatINR(d.amount)}`
                              : `+${formatINR(d.amount)}`}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            {deleteId === d.id ? (
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleDelete(d.id)}
                                  className="text-rose-700 font-semibold cursor-pointer"
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteId(null)}
                                  className="text-slate-500 cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDeleteId(d.id)}
                                aria-label="Delete fund entry"
                                className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
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
      </div>
    </div>
  );
};

