import type {
  ChargeRates,
  DepositRecord,
  OptionType,
  OrderSide,
  SettlementPreview,
  SettlementRecord,
  TradeGroupRecord,
} from './types.ts';

export const DEFAULT_CHARGE_RATES: ChargeRates = {
  brokeragePerOrder: 20,      // Flat ₹20 per executed order on Angel One
  sttSellPct: 0.1,            // 0.1% on Sell premium (NSE Equity/Index Options)
  exchangeTxnPct: 0.03503,    // 0.03503% on total premium turnover (NSE Options)
  ipftPct: 0.0000001,         // 0.0000001% NSE Investor Protection Fund Trust (Buy & Sell)
  sebiPct: 0.0001,            // 0.0001% (₹10 per crore)
  stampDutyBuyPct: 0.003,     // 0.003% on Buy premium
  gstPct: 18,                 // 18% GST on Brokerage + Exchange Txn + IPFT + SEBI
};

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildTradeGroupKey(params: {
  tradingDate: string;
  stockName: string;
  expiryDate: string;
  strikePrice: number;
  optionType: OptionType;
}): string {
  const stock = params.stockName.trim().toUpperCase().replace(/\s+/g, '');
  const strike = Number(params.strikePrice).toString();
  return `${params.tradingDate}|${stock}|${params.expiryDate}|${strike}|${params.optionType}`;
}

export interface OrderLegInput {
  side: OrderSide;
  quantity: number;
  executionPrice: number;
  amount: number;
}

export interface ComputedTradeMetrics {
  buyQty: number;
  sellQty: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  realisedQty: number;
  openQty: number;
  openSide: OrderSide | null;
  grossPnl: number;
  brokerage: number;
  stt: number;
  exchangeTxnCharge: number;
  ipftCharge: number;
  sebiCharge: number;
  stampDuty: number;
  gst: number;
  otherCharges: number;
  totalCharges: number;
  netPnl: number;
}

export function computeEstimatedCharges(
  buyOrdersCount: number,
  sellOrdersCount: number,
  totalBuyAmount: number,
  totalSellAmount: number,
  rates: ChargeRates,
  otherCharges = 0,
): {
  brokerage: number;
  stt: number;
  exchangeTxnCharge: number;
  ipftCharge: number;
  sebiCharge: number;
  stampDuty: number;
  gst: number;
  otherCharges: number;
  totalCharges: number;
  buySideCharges: number;
  sellSideCharges: number;
} {
  const buyBrokerage = buyOrdersCount * rates.brokeragePerOrder;
  const sellBrokerage = sellOrdersCount * rates.brokeragePerOrder;
  const brokerage = round2(buyBrokerage + sellBrokerage);

  const stt = round2(totalSellAmount * (rates.sttSellPct / 100));

  const buyExch = totalBuyAmount * (rates.exchangeTxnPct / 100);
  const sellExch = totalSellAmount * (rates.exchangeTxnPct / 100);
  const exchangeTxnCharge = round2(buyExch + sellExch);

  const buyIpft = totalBuyAmount * (rates.ipftPct / 100);
  const sellIpft = totalSellAmount * (rates.ipftPct / 100);
  const ipftCharge = round2(buyIpft + sellIpft);

  const buySebi = totalBuyAmount * (rates.sebiPct / 100);
  const sellSebi = totalSellAmount * (rates.sebiPct / 100);
  const sebiCharge = round2(buySebi + sellSebi);

  const stampDuty = round2(totalBuyAmount * (rates.stampDutyBuyPct / 100));

  const buyGst = (buyBrokerage + buyExch + buyIpft + buySebi) * (rates.gstPct / 100);
  const sellGst = (sellBrokerage + sellExch + sellIpft + sellSebi) * (rates.gstPct / 100);
  const gst = round2(buyGst + sellGst);

  const cleanOther = round2(otherCharges);
  const totalCharges = round2(
    brokerage + stt + exchangeTxnCharge + ipftCharge + sebiCharge + stampDuty + gst + cleanOther,
  );

  const buySideCharges = round2(buyBrokerage + buyExch + buyIpft + buySebi + stampDuty + buyGst);
  const sellSideCharges = round2(sellBrokerage + stt + sellExch + sellIpft + sellSebi + sellGst);

  return {
    brokerage,
    stt,
    exchangeTxnCharge,
    ipftCharge,
    sebiCharge,
    stampDuty,
    gst,
    otherCharges: cleanOther,
    totalCharges,
    buySideCharges,
    sellSideCharges,
  };
}

export function computeTradeGroupMetrics(
  orders: OrderLegInput[],
  rates: ChargeRates,
  contractNoteOverride?: {
    brokerage: number;
    stt: number;
    exchangeTxnCharge: number;
    ipftCharge: number;
    sebiCharge: number;
    stampDuty: number;
    gst: number;
    otherCharges: number;
  } | null,
): ComputedTradeMetrics {
  const buyOrders = orders.filter((o) => o.side === 'BUY');
  const sellOrders = orders.filter((o) => o.side === 'SELL');

  const buyQty = buyOrders.reduce((sum, o) => sum + o.quantity, 0);
  const sellQty = sellOrders.reduce((sum, o) => sum + o.quantity, 0);
  const totalBuyAmount = round2(buyOrders.reduce((sum, o) => sum + o.amount, 0));
  const totalSellAmount = round2(sellOrders.reduce((sum, o) => sum + o.amount, 0));

  const avgBuyPrice = buyQty > 0 ? round2(totalBuyAmount / buyQty) : 0;
  const avgSellPrice = sellQty > 0 ? round2(totalSellAmount / sellQty) : 0;

  const realisedQty = Math.min(buyQty, sellQty);
  const openQty = Math.abs(buyQty - sellQty);
  const openSide: OrderSide | null = buyQty > sellQty ? 'BUY' : sellQty > buyQty ? 'SELL' : null;

  let grossPnl = 0;
  if (realisedQty > 0 && buyQty > 0 && sellQty > 0) {
    const realisedBuyAmt =
      buyQty === realisedQty ? totalBuyAmount : (realisedQty / buyQty) * totalBuyAmount;
    const realisedSellAmt =
      sellQty === realisedQty ? totalSellAmount : (realisedQty / sellQty) * totalSellAmount;
    grossPnl = round2(realisedSellAmt - realisedBuyAmt);
  }

  let brokerage: number;
  let stt: number;
  let exchangeTxnCharge: number;
  let ipftCharge: number;
  let sebiCharge: number;
  let stampDuty: number;
  let gst: number;
  let otherCharges: number;
  let totalCharges: number;
  let realisedCharges = 0;

  if (contractNoteOverride) {
    brokerage = round2(contractNoteOverride.brokerage);
    stt = round2(contractNoteOverride.stt);
    exchangeTxnCharge = round2(contractNoteOverride.exchangeTxnCharge);
    ipftCharge = round2(contractNoteOverride.ipftCharge);
    sebiCharge = round2(contractNoteOverride.sebiCharge);
    stampDuty = round2(contractNoteOverride.stampDuty);
    gst = round2(contractNoteOverride.gst);
    otherCharges = round2(contractNoteOverride.otherCharges);
    totalCharges = round2(
      brokerage + stt + exchangeTxnCharge + ipftCharge + sebiCharge + stampDuty + gst + otherCharges,
    );
    if (realisedQty > 0) {
      realisedCharges =
        openQty === 0
          ? totalCharges
          : round2(totalCharges * (realisedQty / Math.max(buyQty, sellQty)));
    }
  } else {
    const est = computeEstimatedCharges(
      buyOrders.length,
      sellOrders.length,
      totalBuyAmount,
      totalSellAmount,
      rates,
    );
    brokerage = est.brokerage;
    stt = est.stt;
    exchangeTxnCharge = est.exchangeTxnCharge;
    ipftCharge = est.ipftCharge;
    sebiCharge = est.sebiCharge;
    stampDuty = est.stampDuty;
    gst = est.gst;
    otherCharges = est.otherCharges;
    totalCharges = est.totalCharges;

    if (realisedQty > 0) {
      if (openQty === 0) {
        realisedCharges = totalCharges;
      } else {
        const buyFrac = buyQty > 0 ? realisedQty / buyQty : 0;
        const sellFrac = sellQty > 0 ? realisedQty / sellQty : 0;
        realisedCharges = round2(est.buySideCharges * buyFrac + est.sellSideCharges * sellFrac);
      }
    }
  }

  // Never include unrealised P&L in realised profit/loss
  const netPnl = realisedQty > 0 ? round2(grossPnl - realisedCharges) : 0;

  return {
    buyQty,
    sellQty,
    avgBuyPrice,
    avgSellPrice,
    totalBuyAmount,
    totalSellAmount,
    realisedQty,
    openQty,
    openSide,
    grossPnl,
    brokerage,
    stt,
    exchangeTxnCharge,
    ipftCharge,
    sebiCharge,
    stampDuty,
    gst,
    otherCharges,
    totalCharges: realisedQty > 0 && openQty > 0 ? realisedCharges : totalCharges,
    netPnl,
  };
}

export function computePartnershipAndSettlement(
  trades: Pick<TradeGroupRecord, 'realisedQty' | 'grossPnl' | 'totalCharges' | 'netPnl'>[],
  deposits: Pick<DepositRecord, 'partner' | 'entryType' | 'amount'>[],
  settlements: Pick<
    SettlementRecord,
    'settledNetPnl' | 'ownerOutstandingAdjusted' | 'rajOutstandingAdjusted' | 'ownerPayable' | 'rajPayable'
  >[],
): SettlementPreview {
  const realisedTrades = trades.filter((t) => t.realisedQty > 0);
  const totalRealisedGrossPnl = round2(realisedTrades.reduce((s, t) => s + t.grossPnl, 0));
  const totalRealisedCharges = round2(realisedTrades.reduce((s, t) => s + t.totalCharges, 0));
  const totalRealisedNetPnl = round2(realisedTrades.reduce((s, t) => s + t.netPnl, 0));

  const alreadySettledNetPnl = round2(settlements.reduce((s, st) => s + st.settledNetPnl, 0));
  const unsettledNetPnl = round2(totalRealisedNetPnl - alreadySettledNetPnl);

  // Unsettled P&L 50:50 split for settlement preview
  const ownerProfitShare = round2(unsettledNetPnl / 2);
  const rajProfitShare = round2(unsettledNetPnl - ownerProfitShare);

  // Rule 1: Original deposited capital & withdrawals belong strictly to the partner who funded/withdrew them
  const signedAmount = (d: Pick<DepositRecord, 'entryType' | 'amount'>) =>
    d.entryType === 'WITHDRAWAL' ? -d.amount : d.amount;
  const ownerTotalDeposits = round2(
    deposits.filter((d) => d.partner === 'Prayag').reduce((s, d) => s + signedAmount(d), 0),
  );
  const rajTotalDeposits = round2(
    deposits.filter((d) => d.partner === 'Raj').reduce((s, d) => s + signedAmount(d), 0),
  );
  const totalPartnershipCapital = round2(ownerTotalDeposits + rajTotalDeposits);

  // Rule 2 & 3: Only net trading profit/loss is divided 50:50 (both profits and losses)
  const cumulativeOwnerPnlShare = round2(totalRealisedNetPnl / 2);
  const cumulativeRajPnlShare = round2(totalRealisedNetPnl - cumulativeOwnerPnlShare);

  // Confirmed cash payouts distributed from the trading account
  const ownerPaidOutSoFar = round2(settlements.reduce((s, st) => s + st.ownerPayable, 0));
  const rajPaidOutSoFar = round2(settlements.reduce((s, st) => s + st.rajPayable, 0));

  // Rule 4 & 5: Individual ownership balances update automatically after every completed trade
  // and always add up to the actual total Angel One account balance
  const ownerOwnershipBalance = round2(
    ownerTotalDeposits + cumulativeOwnerPnlShare - ownerPaidOutSoFar,
  );
  const rajOwnershipBalance = round2(
    rajTotalDeposits + cumulativeRajPnlShare - rajPaidOutSoFar,
  );
  const totalAccountBalance = round2(
    totalPartnershipCapital + totalRealisedNetPnl - ownerPaidOutSoFar - rajPaidOutSoFar,
  );

  // Capital deposits belong 100% to the funding partner, so no capital equalization shortfall exists
  const eachCapitalObligation = 0;
  const ownerAdjustedSoFar = 0;
  const rajAdjustedSoFar = 0;
  const ownerOutstandingBefore = 0;
  const rajOutstandingBefore = 0;
  const ownerOutstandingAdjusted = 0;
  const rajOutstandingAdjusted = 0;
  const ownerRemainingOutstanding = 0;
  const rajRemainingOutstanding = 0;

  const ownerPayable = unsettledNetPnl > 0 ? ownerProfitShare : 0;
  const rajPayable = unsettledNetPnl > 0 ? rajProfitShare : 0;

  let canSettle = true;
  let reasonIfDisabled: string | undefined;
  if (Math.abs(unsettledNetPnl) < 0.01) {
    canSettle = false;
    reasonIfDisabled = 'No unsettled net profit or loss available to settle.';
  }

  return {
    totalRealisedGrossPnl,
    totalRealisedCharges,
    totalRealisedNetPnl,
    alreadySettledNetPnl,
    unsettledNetPnl,
    ownerProfitShare,
    rajProfitShare,
    ownerTotalDeposits,
    rajTotalDeposits,
    totalPartnershipCapital,
    totalAccountBalance,
    ownerOwnershipBalance,
    rajOwnershipBalance,
    ownerPaidOutSoFar,
    rajPaidOutSoFar,
    eachCapitalObligation,
    ownerAdjustedSoFar,
    rajAdjustedSoFar,
    ownerOutstandingBefore,
    rajOutstandingBefore,
    ownerOutstandingAdjusted,
    rajOutstandingAdjusted,
    ownerRemainingOutstanding,
    rajRemainingOutstanding,
    ownerPayable,
    rajPayable,
    canSettle,
    reasonIfDisabled,
  };
}
