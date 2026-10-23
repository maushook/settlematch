// Core domain types for SettleMatch.

export type PayMethod = 'upi' | 'card' | 'netbanking' | 'wallet' | 'cod' | 'other';

export interface Order {
  id: string;          // as shown in Shopify, e.g. "#1047"
  key: string;         // canonical, e.g. "1047"
  createdAt: string;   // "YYYY-MM-DD HH:mm:ss"
  ts: number;
  customerName: string;
  email: string;
  phone: string;
  items: string;
  total: number;
  method: PayMethod;
  checkout: string;    // raw payment method / gateway text from the store export
  paymentReference: string;
  financialStatus: string;
  refundedAmount: number;
}

export type GatewayType = 'payment' | 'refund' | 'adjustment';

export interface GatewayTxn {
  entityId: string;
  type: GatewayType;
  amount: number;
  fee: number;   // includes GST on fee
  tax: number;   // GST portion of fee
  debit: number;
  credit: number;
  createdAt: string;
  ts: number;
  settledAt: string;
  settlementId: string;
  settlementUtr: string;
  paymentId: string;     // for refunds / adjustments
  method: PayMethod;
  cardNetwork: string;
  orderReceipt: string;
  email: string;
  contact: string;
  notes: string;
  description: string;
}

export interface BankTxn {
  tranId: string;
  date: string;   // YYYY-MM-DD
  ts: number;
  narration: string;
  deposit: number;
  withdrawal: number;
  balance: number;
}

export interface Settlement {
  id: string;
  utr: string;
  settledAt: string;
  ts: number;
  credits: number;
  debits: number;
  fees: number;
  tax: number;
  net: number;
  txnIds: string[];
}

export interface Dataset {
  orders: Order[];
  gateway: GatewayTxn[];
  bank: BankTxn[];
}

export interface FeeContract {
  upi: number;         // percent, e.g. 2 = 2%
  card: number;
  amex: number;        // amex / diners / international
  netbanking: number;
  wallet: number;
  gstOnFee: number;    // percent, 18
}

export type Mode = 'rules' | 'heuristic' | 'ai';

export type MatchMethod =
  | 'rule:payment_ref'
  | 'rule:order_receipt'
  | 'rule:utr'
  | 'heuristic'
  | 'ai';

export interface PaymentLink {
  paymentId: string;
  orderId: string;
  method: MatchMethod;
  score?: number;
  confidence?: number;
  reason?: string;
}

export interface BankLink {
  settlementId: string;
  tranId: string;
  method: MatchMethod;
  score?: number;
  confidence?: number;
  reason?: string;
}

export type ExceptionType =
  | 'FEE_OVERCHARGE'
  | 'PAYMENT_MISSING'
  | 'UNMATCHED_PAYMENT'
  | 'DUPLICATE_PAYMENT'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_NOT_IN_GATEWAY'
  | 'UNRECORDED_REFUND'
  | 'CHARGEBACK'
  | 'SETTLEMENT_NOT_IN_BANK'
  | 'BANK_SHORT_CREDIT'
  | 'BANK_EXCESS_CREDIT'
  | 'UNKNOWN_GATEWAY_CREDIT';

export type Severity = 'loss' | 'liability' | 'review';

export interface RecException {
  type: ExceptionType;
  key: string;          // canonical entity id the exception is about
  severity: Severity;
  amount: number;
  title: string;
  explanation: string;
  evidence: string[];
}

// AI stage contract (shared by browser, worker and precompute script)
export interface AiCandidate {
  id: string;
  fields: Record<string, string | number>;
  heuristicScore: number;
}

export interface AiPacket {
  kind: 'payment' | 'bank';
  id: string;
  fields: Record<string, string | number>;
  candidates: AiCandidate[];
}

export interface AiDecision {
  kind: 'payment' | 'bank';
  id: string;
  match: string | null;
  confidence: number;
  strength?: 'strong' | 'moderate' | 'weak' | 'none';
  reason: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface AiRun {
  decisions: AiDecision[];
  usage: AiUsage;
  createdAt: string;
}

export interface StageStat {
  stage: string;
  detail: string;
  resolved: number;
}

export interface MoneySummary {
  prepaidOrderValue: number;
  captured: number;
  fees: number;
  feeGst: number;
  refunds: number;
  adjustments: number;
  netSettled: number;
  receivedInBank: number;
  atRisk: number;
  owedToCustomers: number;
  reviewCount: number;
}

export interface ReconResult {
  mode: Mode;
  paymentLinks: PaymentLink[];
  bankLinks: BankLink[];
  settlements: Settlement[];
  exceptions: RecException[];
  money: MoneySummary;
  stages: StageStat[];
  pendingPackets: AiPacket[];   // what would go to the AI stage
  aiApplied: AiDecision[];
  counts: { orders: number; payments: number; settlements: number; bankCredits: number };
  runtimeMs: number;
}

export interface AnswerKey {
  orderPayment: Record<string, string>;   // paymentId -> orderId
  settlementBank: Record<string, string>; // settlementId -> tranId
  exceptions: { type: ExceptionType; key: string }[];
  hard: { payments: string[]; bank: string[] };
}
