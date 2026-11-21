export type PartnerId = 'Prayag' | 'Raj';

export type OptionType = 'CE' | 'PE';
export type OrderSide = 'BUY' | 'SELL';
export type ChargesMode = 'ESTIMATED' | 'CONTRACT_NOTE';

export interface ChargeRates {
  brokeragePerOrder: number; // ₹20 per executed order (Angel One F&O Options)
  sttSellPct: number;        // 0.1% on Sell option premium
  exchangeTxnPct: number;    // 0.03503% NSE Options transaction charge
  ipftPct: number;           // 0.0000001% NSE IPFT charge (Buy & Sell)
  sebiPct: number;           // 0.0001% (₹10 per crore)
  stampDutyBuyPct: number;   // 0.003% on Buy side
  gstPct: number;            // 18% on Brokerage + Exchange Txn + IPFT + SEBI
}

export interface ExtractedOrderLeg {
  stockName: string;
  tradingSymbol: string;
  expiryDate: string;      // YYYY-MM-DD
  strikePrice: number;
  optionType: OptionType;
  side: OrderSide;
  quantity: number;        // Total units (e.g. 650)
  lots: number | null;
  executionPrice: number;
  amount: number;          // Total ₹ amount
  executionTime: string;   // e.g. "09:31 AM"
  tradingDate: string;     // YYYY-MM-DD or "" if missing
  confidenceNotes?: string;
}

export interface TradeOrderRecord {
  id: number;
  tradeGroupId: number;
  uploadId: number | null;
  tradingDate: string;
  uploadedAt: string;
  stockName: string;
  tradingSymbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: OptionType;
  side: OrderSide;
  quantity: number;
  lots: number | null;
  executionPrice: number;
  amount: number;
  executionTime: string;
  createdBy: PartnerId;
  createdAt: string;
}

export interface TradeGroupRecord {
  id: number;
  groupKey: string;
  tradingDate: string;
  uploadedAt: string;
  stockName: string;
  tradingSymbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: OptionType;
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
  sebiCharge: number;
  stampDuty: number;
  ipftCharge: number;
  gst: number;
  otherCharges: number;
  totalCharges: number;
  netPnl: number;
  chargesMode: ChargesMode;
  contractNoteRef: string | null;
  notes: string | null;
  updatedAt: string;
  orders?: TradeOrderRecord[];
  screenshots?: {
    id: number;
    imageDataUrl: string;
    originalFilename: string | null;
    uploadedBy: PartnerId;
    uploadedAt: string;
  }[];
}

export type FundEntryType = 'DEPOSIT' | 'WITHDRAWAL';

export interface DepositRecord {
  id: number;
  partner: PartnerId;
  entryType?: FundEntryType;
  amount: number;
  depositDate: string;
  referenceNote: string | null;
  createdBy: PartnerId;
  createdAt: string;
}

export interface SettlementPreview {
  totalRealisedGrossPnl: number;
  totalRealisedCharges: number;
  totalRealisedNetPnl: number;
  alreadySettledNetPnl: number;
  unsettledNetPnl: number;
  ownerProfitShare: number;
  rajProfitShare: number;
  ownerTotalDeposits: number;
  rajTotalDeposits: number;
  totalPartnershipCapital: number;
  totalAccountBalance: number;
  ownerOwnershipBalance: number;
  rajOwnershipBalance: number;
  ownerPaidOutSoFar: number;
  rajPaidOutSoFar: number;
  eachCapitalObligation: number;
  ownerAdjustedSoFar: number;
  rajAdjustedSoFar: number;
  ownerOutstandingBefore: number;
  rajOutstandingBefore: number;
  ownerOutstandingAdjusted: number;
  rajOutstandingAdjusted: number;
  ownerRemainingOutstanding: number;
  rajRemainingOutstanding: number;
  ownerPayable: number;
  rajPayable: number;
  canSettle: boolean;
  reasonIfDisabled?: string;
}

export interface SettlementRecord {
  id: number;
  settlementDate: string;
  idempotencyKey: string;
  settledGrossPnl: number;
  settledTotalCharges: number;
  settledNetPnl: number;
  ownerProfitShare: number;
  rajProfitShare: number;
  ownerOutstandingBefore: number;
  rajOutstandingBefore: number;
  ownerOutstandingAdjusted: number;
  rajOutstandingAdjusted: number;
  ownerRemainingOutstanding: number;
  rajRemainingOutstanding: number;
  ownerPayable: number;
  rajPayable: number;
  notes: string | null;
  createdBy: PartnerId;
  createdAt: string;
}

export interface AuditLogRecord {
  id: number;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  detailsJson: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  totalPartnershipCapital: number;
  totalAccountBalance: number;
  ownerTotalContribution: number;
  rajTotalContribution: number;
  ownerOwnershipBalance: number;
  rajOwnershipBalance: number;
  ownerPaidOutAmount: number;
  rajPaidOutAmount: number;
  eachCapitalObligation: number;
  ownerOutstandingAmount: number;
  rajOutstandingAmount: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  totalGrossPnl: number;
  totalBrokerageAndTaxes: number;
  totalNetPnl: number;
  ownerProfitShare: number;
  rajProfitShare: number;
  totalDistributedAmount: number;
  pendingSettlementAmount: number;
  totalClosedTrades: number;
  winningTrades: number;
  losingTrades: number;
  openPositionsCount: number;
}
