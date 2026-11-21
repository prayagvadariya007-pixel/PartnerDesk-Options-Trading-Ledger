import * as XLSX from 'xlsx';
import type { DashboardSummary, DepositRecord, TradeGroupRecord } from '../../shared/types.ts';
import { todayIsoDate } from './format.ts';

function formatIsoDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildLedgerWorkbook(params: {
  summary: DashboardSummary | null;
  trades: TradeGroupRecord[];
  deposits: DepositRecord[];
}): XLSX.WorkBook {
  const { summary, trades, deposits } = params;
  const wb = XLSX.utils.book_new();

  const summaryRows = summary
    ? [
        { Metric: 'Export Generated', Value: new Date().toLocaleString('en-IN') },
        { Metric: 'Total Angel One Account Balance (INR)', Value: summary.totalAccountBalance },
        { Metric: 'Prayag Ownership Balance (INR)', Value: summary.ownerOwnershipBalance },
        { Metric: 'Raj Ownership Balance (INR)', Value: summary.rajOwnershipBalance },
        { Metric: 'Total Deposited Capital (INR)', Value: summary.totalPartnershipCapital },
        { Metric: 'Prayag Deposited Capital (INR)', Value: summary.ownerTotalContribution },
        { Metric: 'Raj Deposited Capital (INR)', Value: summary.rajTotalContribution },
        { Metric: 'Total Buy Turnover (INR)', Value: summary.totalBuyAmount },
        { Metric: 'Total Sell Turnover (INR)', Value: summary.totalSellAmount },
        { Metric: 'Total Realised Gross P&L (INR)', Value: summary.totalGrossPnl },
        { Metric: 'Total Brokerage & Taxes (INR)', Value: summary.totalBrokerageAndTaxes },
        { Metric: 'Total Realised Net P&L (INR)', Value: summary.totalNetPnl },
        { Metric: 'Prayag Net P&L Share (INR)', Value: summary.ownerProfitShare },
        { Metric: 'Raj Net P&L Share (INR)', Value: summary.rajProfitShare },
        { Metric: 'Completed Trades', Value: summary.totalClosedTrades },
        { Metric: 'Winning Trades', Value: summary.winningTrades },
        { Metric: 'Losing Trades', Value: summary.losingTrades },
        { Metric: 'Open Positions', Value: summary.openPositionsCount },
      ]
    : [{ Metric: 'Status', Value: 'No summary loaded yet' }];

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 38 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary & Balances');

  const tradeRows = trades.map((t) => ({
    'Trade ID': t.id,
    'Trading Date': t.tradingDate,
    'Uploaded At': formatIsoDateTimeLocal(t.uploadedAt),
    Stock: t.stockName,
    Symbol: t.tradingSymbol,
    'Expiry Date': t.expiryDate,
    'Strike Price': t.strikePrice,
    'Option Type': t.optionType,
    'Buy Qty': t.buyQty,
    'Sell Qty': t.sellQty,
    'Avg Buy Price': t.avgBuyPrice,
    'Avg Sell Price': t.avgSellPrice,
    'Buy Amount (INR)': t.totalBuyAmount,
    'Sell Amount (INR)': t.totalSellAmount,
    'Realised Qty': t.realisedQty,
    'Open Qty': t.openQty,
    'Open Side': t.openSide || '',
    'Gross P&L (INR)': t.grossPnl,
    'Brokerage (INR)': t.brokerage,
    'STT (INR)': t.stt,
    'Exchange Txn (INR)': t.exchangeTxnCharge,
    'IPFT (INR)': t.ipftCharge,
    'SEBI Fee (INR)': t.sebiCharge,
    'Stamp Duty (INR)': t.stampDuty,
    'GST (INR)': t.gst,
    'Other Charges (INR)': t.otherCharges,
    'Total Charges (INR)': t.totalCharges,
    'Net P&L (INR)': t.netPnl,
    'Charges Mode': t.chargesMode === 'CONTRACT_NOTE' ? 'Contract Note' : 'Estimated',
    'Contract Note Ref': t.contractNoteRef || '',
    Notes: t.notes || '',
  }));

  const wsTrades = XLSX.utils.json_to_sheet(
    tradeRows.length > 0 ? tradeRows : [{ Info: 'No trades recorded yet' }],
  );
  wsTrades['!cols'] = [
    { wch: 10 },
    { wch: 13 },
    { wch: 20 },
    { wch: 14 },
    { wch: 24 },
    { wch: 13 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 15 },
    { wch: 14 },
    { wch: 12 },
    { wch: 16 },
    { wch: 12 },
    { wch: 14 },
    { wch: 15 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 15 },
    { wch: 15 },
    { wch: 18 },
    { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, wsTrades, 'Trading History');

  const orderRows = trades.flatMap((t) =>
    (t.orders || []).map((o) => ({
      'Trade Group ID': t.id,
      'Order ID': o.id,
      'Trading Date': o.tradingDate,
      'Execution Time': o.executionTime,
      Stock: o.stockName,
      Symbol: o.tradingSymbol,
      'Expiry Date': o.expiryDate,
      Strike: o.strikePrice,
      Type: o.optionType,
      Side: o.side,
      'Qty (Units)': o.quantity,
      Lots: o.lots ?? '',
      'Execution Price (INR)': o.executionPrice,
      'Amount (INR)': o.amount,
      'Added By': o.createdBy,
      'Uploaded At': formatIsoDateTimeLocal(o.uploadedAt),
    })),
  );

  const wsOrders = XLSX.utils.json_to_sheet(
    orderRows.length > 0 ? orderRows : [{ Info: 'No individual orders recorded yet' }],
  );
  wsOrders['!cols'] = [
    { wch: 14 },
    { wch: 10 },
    { wch: 13 },
    { wch: 15 },
    { wch: 14 },
    { wch: 24 },
    { wch: 13 },
    { wch: 10 },
    { wch: 8 },
    { wch: 8 },
    { wch: 12 },
    { wch: 8 },
    { wch: 18 },
    { wch: 15 },
    { wch: 12 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsOrders, 'Individual Orders');

  const depositRows = deposits.map((d) => {
    const isWithdrawal = d.entryType === 'WITHDRAWAL';
    return {
      'Entry ID': d.id,
      Date: d.depositDate,
      Type: isWithdrawal ? 'Withdrawal' : 'Deposit',
      Partner: d.partner,
      'Amount (INR)': isWithdrawal ? -d.amount : d.amount,
      'Reference / Notes': d.referenceNote || '',
      'Logged By': d.createdBy,
      'Created At': formatIsoDateTimeLocal(d.createdAt),
    };
  });

  const wsDeposits = XLSX.utils.json_to_sheet(
    depositRows.length > 0 ? depositRows : [{ Info: 'No fund entries recorded yet' }],
  );
  wsDeposits['!cols'] = [
    { wch: 10 },
    { wch: 14 },
    { wch: 13 },
    { wch: 12 },
    { wch: 15 },
    { wch: 30 },
    { wch: 12 },
    { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsDeposits, 'Funds & Deposits');

  return wb;
}

export function buildLedgerWorkbookBytes(params: {
  summary: DashboardSummary | null;
  trades: TradeGroupRecord[];
  deposits: DepositRecord[];
}): Uint8Array {
  const wb = buildLedgerWorkbook(params);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export function exportLedgerToExcel(params: {
  summary: DashboardSummary | null;
  trades: TradeGroupRecord[];
  deposits: DepositRecord[];
}): void {
  const wb = buildLedgerWorkbook(params);
  const filename = `Prayag_Raj_Trading_Ledger_${todayIsoDate()}.xlsx`;
  XLSX.writeFile(wb, filename);
}
