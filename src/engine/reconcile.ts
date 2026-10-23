// The reconciliation pipeline.
//
//   1. Normalize        (normalize.ts)
//   2. Rules            order <-> payment by payment reference / order receipt
//   3. Fee check        recompute contracted fee + GST on fee for every payment
//   4. Rules            settlement <-> bank credit by UTR
//   5. Heuristics       scored candidates; commit only on strong, unambiguous evidence
//   6. AI               only the leftovers that heuristics refused to decide
//   7. Exceptions       every gap gets a type, an amount, a reason and evidence
//
// Rules first, AI last: cheap, fast and auditable. The AI never sees a record
// that a rule or a confident heuristic could settle.
import type {
  AiCandidate, AiDecision, AiPacket, BankLink, BankTxn, Dataset, FeeContract, GatewayTxn, Mode,
  MoneySummary, Order, PaymentLink, ReconResult, RecException, Settlement, StageStat,
} from './types';
import { canonOrderKey, r2 } from './normalize';

export const DEFAULT_CONTRACT: FeeContract = { upi: 2, card: 2, amex: 3, netbanking: 2, wallet: 2, gstOnFee: 18 };

const DAY = 86400000;
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Thresholds (documented in README)
export const HEURISTIC_MIN_SCORE = 70;
export const HEURISTIC_MIN_MARGIN = 20;
export const AI_MIN_CONFIDENCE = 0.6;
const FEE_TOLERANCE = 0.05;
const BANK_TOLERANCE = 0.5;

const PRODUCT_STOP = new Set(['canvas', 'print', 'frame', 'set', 'art', 'trio', 'collage', 'panorama', 'the', 'and', 'with', 'x1', 'x2', 'pack']);

export function expectedFee(p: GatewayTxn, c: FeeContract) {
  const net = p.cardNetwork;
  const rate = p.method === 'card' && (net === 'amex' || net === 'diners') ? c.amex
    : p.method === 'upi' ? c.upi : p.method === 'netbanking' ? c.netbanking : p.method === 'wallet' ? c.wallet : c.card;
  const base = r2((p.amount * rate) / 100);
  const tax = r2((base * c.gstOnFee) / 100);
  return { rate, base, tax, fee: r2(base + tax) };
}

const isPrepaidOrder = (o: Order) =>
  o.method !== 'cod' && !['pending', 'voided', 'cancelled', 'expired'].includes(o.financialStatus);

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

// ---------- scoring ----------
export function scorePaymentOrder(p: GatewayTxn, o: Order) {
  let score = 0;
  const evidence: string[] = [];
  const diff = r2(o.total - p.amount);
  if (Math.abs(diff) <= 1) { score += 40; evidence.push('amount matches'); }
  else { score += 10; evidence.push(`payment ${inr(diff)} below order total`); }
  const days = Math.abs(p.ts - o.ts) / DAY;
  score += Math.round(15 * (1 - Math.min(days, 5) / 5));
  if (p.email && o.email && p.email === o.email) { score += 40; evidence.push('same email'); }
  if (p.contact && o.phone && p.contact === o.phone) { score += 40; evidence.push('same phone'); }
  const text = `${p.notes} ${p.description}`.toLowerCase();
  const numbers: string[] = text.match(/\d{3,8}/g) ?? [];
  if (numbers.includes(o.key)) { score += 60; evidence.push('order number in notes'); }
  const tk = tokens(text);
  const nameHits = [...tokens(o.customerName)].filter((t) => t.length >= 3 && tk.has(t)).length;
  if (nameHits) { score += Math.min(2, nameHits) * 20; evidence.push('customer name in notes'); }
  const prodHits = [...tokens(o.items)].filter((t) => t.length >= 3 && !PRODUCT_STOP.has(t) && tk.has(t)).length;
  if (prodHits) { score += Math.min(2, prodHits) * 15; evidence.push('product named in notes'); }
  return { score, evidence };
}

function paymentCandidates(p: GatewayTxn, orders: Order[], linkedOrders: Set<string>, gatewayIds: Set<string>) {
  const out: { order: Order; score: number; evidence: string[] }[] = [];
  for (const o of orders) {
    if (linkedOrders.has(o.id) || !isPrepaidOrder(o)) continue;
    if (p.ts < o.ts - DAY || p.ts > o.ts + 7 * DAY) continue;
    const exact = Math.abs(o.total - p.amount) <= 1;
    if (!exact && !(p.amount < o.total && p.amount >= 0.8 * o.total)) continue;
    const s = scorePaymentOrder(p, o);
    // An order whose own payment reference exists elsewhere in the gateway already has its payment.
    if (o.paymentReference && gatewayIds.has(o.paymentReference)) continue;
    out.push({ order: o, ...s });
  }
  return out.sort((a, b) => b.score - a.score);
}

const bankDateToken = (s: Settlement) => {
  const d = new Date(s.ts);
  return `${String(d.getUTCDate()).padStart(2, '0')}${MON[d.getUTCMonth()]}`;
};

function bankCandidates(b: BankTxn, settlements: Settlement[], linked: Set<string>) {
  const out: { s: Settlement; score: number; evidence: string[] }[] = [];
  for (const s of settlements) {
    if (linked.has(s.id)) continue;
    const days = Math.abs(b.ts - s.ts) / DAY;
    if (days > 5) continue;
    const diff = Math.abs(b.deposit - s.net);
    if (diff > Math.max(1, s.net * 0.05)) continue;
    let score = 0; const evidence: string[] = [];
    if (diff <= BANK_TOLERANCE) { score += 60; evidence.push('amount matches settlement net'); }
    else evidence.push(`amount differs by ${inr(diff)}`);
    score += Math.round(20 * (1 - Math.min(days, 3) / 3));
    if (days <= 0.99) evidence.push('same day'); else evidence.push(`${Math.round(days)} day(s) apart`);
    if (b.narration.toUpperCase().includes(bankDateToken(s))) { score += 15; evidence.push('narration mentions settlement date'); }
    out.push({ s, score, evidence });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- main ----------
export interface ReconOptions {
  contract?: FeeContract;
  mode?: Mode;
  ai?: AiDecision[];
}

export function reconcile(ds: Dataset, opts: ReconOptions = {}): ReconResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const contract = opts.contract ?? DEFAULT_CONTRACT;
  const mode: Mode = opts.mode ?? 'heuristic';
  const stages: StageStat[] = [];

  const orders = ds.orders;
  const payments = ds.gateway.filter((g) => g.type === 'payment');
  const refunds = ds.gateway.filter((g) => g.type === 'refund');
  const adjustments = ds.gateway.filter((g) => g.type === 'adjustment');
  const gatewayIds = new Set(payments.map((p) => p.entityId));
  const orderByKey = new Map(orders.map((o) => [o.key, o]));
  const orderByRef = new Map(orders.filter((o) => o.paymentReference).map((o) => [o.paymentReference, o]));
  const paymentById = new Map(payments.map((p) => [p.entityId, p]));
  stages.push({ stage: 'Normalize', detail: `${orders.length} orders, ${ds.gateway.length} gateway rows, ${ds.bank.length} bank rows`, resolved: orders.length + ds.gateway.length + ds.bank.length });

  // ---- Stage 2: rules, order <-> payment
  const pLinks = new Map<string, PaymentLink>();
  for (const p of payments) {
    const byRef = orderByRef.get(p.entityId);
    if (byRef) { pLinks.set(p.entityId, { paymentId: p.entityId, orderId: byRef.id, method: 'rule:payment_ref' }); continue; }
    const byReceipt = p.orderReceipt ? orderByKey.get(canonOrderKey(p.orderReceipt)) : undefined;
    if (byReceipt) pLinks.set(p.entityId, { paymentId: p.entityId, orderId: byReceipt.id, method: 'rule:order_receipt' });
  }
  stages.push({ stage: 'Rules: order to payment', detail: 'payment reference or order receipt', resolved: pLinks.size });

  // ---- Stage 3: fee check
  const feeIssues: RecException[] = [];
  for (const p of payments) {
    const e = expectedFee(p, contract);
    const over = r2(p.fee - e.fee);
    if (over > FEE_TOLERANCE) {
      const actualRate = p.amount ? r2(((p.fee - p.tax) / p.amount) * 100) : 0;
      feeIssues.push({
        type: 'FEE_OVERCHARGE', key: p.entityId, severity: 'loss', amount: over,
        facts: { paymentId: p.entityId, paymentDate: p.createdAt.slice(0, 10), method: p.method, cardNetwork: p.cardNetwork, paymentAmount: p.amount, feeCharged: p.fee, feeExpected: e.fee, rateCharged: actualRate, rateContract: e.rate, overcharge: over },
        title: 'Gateway fee above contract',
        explanation: `Charged ${actualRate}% on a ${p.method}${p.cardNetwork ? ` (${p.cardNetwork})` : ''} payment; contract is ${e.rate}%. Overcharged ${inr(over)} including GST on fee.`,
        evidence: [`amount ${inr(p.amount)}`, `fee charged ${inr(p.fee)}`, `fee expected ${inr(e.fee)}`],
      });
    }
  }
  stages.push({ stage: 'Fee check', detail: `${payments.length} payments checked against contract`, resolved: payments.length });

  // ---- Settlements
  const setMap = new Map<string, Settlement>();
  for (const g of ds.gateway) {
    if (!g.settlementId) continue;
    let s = setMap.get(g.settlementId);
    if (!s) {
      const ts = Date.UTC(+g.settledAt.slice(0, 4), +g.settledAt.slice(5, 7) - 1, +g.settledAt.slice(8, 10));
      s = { id: g.settlementId, utr: g.settlementUtr, settledAt: g.settledAt.slice(0, 10), ts: Number.isFinite(ts) ? ts : g.ts, credits: 0, debits: 0, fees: 0, tax: 0, net: 0, txnIds: [] };
      setMap.set(g.settlementId, s);
    }
    s.credits = r2(s.credits + g.credit); s.debits = r2(s.debits + g.debit);
    s.fees = r2(s.fees + g.fee); s.tax = r2(s.tax + g.tax); s.txnIds.push(g.entityId);
  }
  const settlements = [...setMap.values()].map((s) => ({ ...s, net: r2(s.credits - s.debits) })).sort((a, b) => a.ts - b.ts);
  const gatewayCredits = ds.bank.filter((b) => b.deposit > 0 && /razorpay/i.test(b.narration));

  // ---- Stage 4: rules, settlement <-> bank by UTR
  const bLinks = new Map<string, BankLink>();
  const usedBank = new Set<string>();
  for (const s of settlements) {
    if (!s.utr || s.utr.length < 8) continue;
    const b = gatewayCredits.find((x) => !usedBank.has(x.tranId) && x.narration.toUpperCase().includes(s.utr.toUpperCase()));
    if (b) { bLinks.set(s.id, { settlementId: s.id, tranId: b.tranId, method: 'rule:utr' }); usedBank.add(b.tranId); }
  }
  stages.push({ stage: 'Rules: settlement to bank', detail: 'UTR found in bank narration', resolved: bLinks.size });

  // ---- Stage 5: heuristics
  let heuristicCount = 0;
  if (mode !== 'rules') {
    for (;;) {
      const linkedOrders = new Set([...pLinks.values()].map((l) => l.orderId));
      let best: { p: GatewayTxn; o: Order; score: number; evidence: string[] } | null = null;
      for (const p of payments) {
        if (pLinks.has(p.entityId)) continue;
        const c = paymentCandidates(p, orders, linkedOrders, gatewayIds);
        if (!c.length) continue;
        const margin = c[0].score - (c[1]?.score ?? 0);
        if (c[0].score >= HEURISTIC_MIN_SCORE && margin >= HEURISTIC_MIN_MARGIN && (!best || c[0].score > best.score)) {
          best = { p, o: c[0].order, score: c[0].score, evidence: c[0].evidence };
        }
      }
      if (!best) break;
      pLinks.set(best.p.entityId, { paymentId: best.p.entityId, orderId: best.o.id, method: 'heuristic', score: best.score, reason: best.evidence.join(', ') });
      heuristicCount++;
    }
    for (;;) {
      const linked = new Set(bLinks.keys());
      let best: { b: BankTxn; s: Settlement; score: number; evidence: string[] } | null = null;
      for (const b of gatewayCredits) {
        if (usedBank.has(b.tranId)) continue;
        const c = bankCandidates(b, settlements, linked);
        if (!c.length) continue;
        const margin = c[0].score - (c[1]?.score ?? 0);
        if (c[0].score >= HEURISTIC_MIN_SCORE && margin >= HEURISTIC_MIN_MARGIN && (!best || c[0].score > best.score)) {
          best = { b, s: c[0].s, score: c[0].score, evidence: c[0].evidence };
        }
      }
      if (!best) break;
      bLinks.set(best.s.id, { settlementId: best.s.id, tranId: best.b.tranId, method: 'heuristic', score: best.score, reason: best.evidence.join(', ') });
      usedBank.add(best.b.tranId);
      heuristicCount++;
    }
    stages.push({ stage: 'Heuristics', detail: `commit only if score ≥ ${HEURISTIC_MIN_SCORE} and lead ≥ ${HEURISTIC_MIN_MARGIN}`, resolved: heuristicCount });
  }

  // ---- Build AI packets for whatever is still unresolved
  const pendingPackets: AiPacket[] = [];
  if (mode !== 'rules') {
    const linkedOrders = new Set([...pLinks.values()].map((l) => l.orderId));
    for (const p of payments) {
      if (pLinks.has(p.entityId)) continue;
      const c = paymentCandidates(p, orders, linkedOrders, gatewayIds).slice(0, 5);
      if (!c.length) continue;
      pendingPackets.push({
        kind: 'payment', id: p.entityId,
        fields: { amount: p.amount, createdAt: p.createdAt, method: p.method, email: p.email, phone: p.contact, notes: p.notes, description: p.description },
        candidates: c.map<AiCandidate>((x) => ({
          id: x.order.id, heuristicScore: x.score,
          fields: {
            total: x.order.total, createdAt: x.order.createdAt, customer: x.order.customerName, email: x.order.email,
            phone: x.order.phone, items: x.order.items, checkout: x.order.checkout,
            paymentReference: x.order.paymentReference ? `${x.order.paymentReference} (not found in gateway)` : '',
          },
        })),
      });
    }
    const linked = new Set(bLinks.keys());
    for (const b of gatewayCredits) {
      if (usedBank.has(b.tranId)) continue;
      const c = bankCandidates(b, settlements, linked).slice(0, 5);
      if (!c.length) continue;
      pendingPackets.push({
        kind: 'bank', id: b.tranId,
        fields: { date: b.date, narration: b.narration, deposit: b.deposit },
        candidates: c.map<AiCandidate>((x) => ({
          id: x.s.id, heuristicScore: x.score,
          fields: { settledAt: x.s.settledAt, net: x.s.net, utr: x.s.utr, transactions: x.s.txnIds.length },
        })),
      });
    }
  }

  // ---- Stage 6: AI decisions (validated: must pick one of the offered candidates)
  const aiApplied: AiDecision[] = [];
  if (mode === 'ai' && opts.ai?.length) {
    const packetById = new Map(pendingPackets.map((p) => [`${p.kind}:${p.id}`, p]));
    const claimed = new Set<string>();
    const sorted = [...opts.ai].sort((a, b) => b.confidence - a.confidence);
    for (const d of sorted) {
      const pk = packetById.get(`${d.kind}:${d.id}`);
      if (!pk || !d.match || d.confidence < AI_MIN_CONFIDENCE) continue;
      if (!pk.candidates.some((c) => c.id === d.match) || claimed.has(`${d.kind}:${d.match}`)) continue;
      claimed.add(`${d.kind}:${d.match}`);
      if (d.kind === 'payment') pLinks.set(d.id, { paymentId: d.id, orderId: d.match, method: 'ai', confidence: d.confidence, reason: d.reason });
      else { bLinks.set(d.match, { settlementId: d.match, tranId: d.id, method: 'ai', confidence: d.confidence, reason: d.reason }); usedBank.add(d.id); }
      aiApplied.push(d);
    }
    stages.push({ stage: 'AI', detail: `${pendingPackets.length} ambiguous records sent; confidence ≥ ${AI_MIN_CONFIDENCE} required`, resolved: aiApplied.length });
  }

  // ---- Stage 7: exceptions
  const ex: RecException[] = [...feeIssues];
  const paymentsByOrder = new Map<string, GatewayTxn[]>();
  for (const l of pLinks.values()) {
    const arr = paymentsByOrder.get(l.orderId) ?? [];
    arr.push(paymentById.get(l.paymentId)!);
    paymentsByOrder.set(l.orderId, arr);
  }

  for (const o of orders) {
    if (!isPrepaidOrder(o)) continue;
    const ps = (paymentsByOrder.get(o.id) ?? []).sort((a, b) => a.ts - b.ts);
    if (!ps.length) {
      ex.push({
        type: 'PAYMENT_MISSING', key: o.id, severity: 'loss', amount: o.total,
        facts: { orderId: o.id, orderDate: o.createdAt.slice(0, 10), orderTotal: o.total, customer: o.customerName, email: o.email, financialStatus: o.financialStatus || 'paid', paymentReference: o.paymentReference },
        title: 'Order marked paid, no payment in gateway',
        explanation: `Shopify shows ${o.id} as ${o.financialStatus || 'paid'} for ${inr(o.total)}, but no gateway payment could be tied to it.${o.paymentReference ? ` Its payment reference ${o.paymentReference} does not exist in the settlement report.` : ''} Check if the payment is on hold or the order was marked paid manually.`,
        evidence: [`order date ${o.createdAt.slice(0, 10)}`, `customer ${o.customerName || o.email}`],
      });
      continue;
    }
    const sum = r2(ps.reduce((s, p) => s + p.amount, 0));
    if (ps.length > 1 && Math.abs(sum - o.total) > 1) {
      for (const dup of ps.slice(1)) {
        ex.push({
          type: 'DUPLICATE_PAYMENT', key: dup.entityId, severity: 'liability', amount: dup.amount,
          facts: { orderId: o.id, orderTotal: o.total, customer: o.customerName, email: o.email, firstPaymentId: ps[0].entityId, firstPaymentDate: ps[0].createdAt.slice(0, 10), duplicatePaymentId: dup.entityId, duplicatePaymentDate: dup.createdAt.slice(0, 10), duplicateAmount: dup.amount, minutesApart: Math.round((dup.ts - ps[0].ts) / 60000), collected: sum },
          title: 'Customer charged twice',
          explanation: `${o.id} was paid by ${ps[0].entityId} and again by ${dup.entityId} ${Math.round((dup.ts - ps[0].ts) / 60000)} min later. Refund ${inr(dup.amount)} to the customer.`,
          evidence: [`order total ${inr(o.total)}`, `collected ${inr(sum)}`],
        });
      }
    } else if (ps.length === 1 && Math.abs(ps[0].amount - o.total) > 1) {
      const diff = r2(o.total - ps[0].amount);
      ex.push({
        type: 'AMOUNT_MISMATCH', key: ps[0].entityId, severity: diff > 0 ? 'loss' : 'review', amount: Math.abs(diff),
        facts: { orderId: o.id, orderTotal: o.total, paymentId: ps[0].entityId, paymentDate: ps[0].createdAt.slice(0, 10), captured: ps[0].amount, difference: Math.abs(diff), direction: diff > 0 ? 'less' : 'more' },
        title: diff > 0 ? 'Collected less than order total' : 'Collected more than order total',
        explanation: `${o.id} totals ${inr(o.total)} but the gateway captured ${inr(ps[0].amount)}. A coupon or edit was likely applied on one side only.`,
        evidence: [`payment ${ps[0].entityId}`],
      });
    }
  }

  for (const p of payments) {
    if (pLinks.has(p.entityId)) continue;
    ex.push({
      type: 'UNMATCHED_PAYMENT', key: p.entityId, severity: 'review', amount: p.amount,
      facts: { paymentId: p.entityId, paymentDate: p.createdAt.slice(0, 10), amount: p.amount, method: p.method, payer: p.email || p.contact, notes: p.notes },
      title: 'Payment with no order',
      explanation: `${inr(p.amount)} received on ${p.createdAt.slice(0, 10)} could not be tied to any order${p.notes ? `. Notes say: "${p.notes}"` : ''}.`,
      evidence: [p.email || p.contact ? `payer ${p.email || p.contact}` : 'no payer details', `method ${p.method}`],
    });
  }

  // refunds
  const refundsByOrder = new Map<string, GatewayTxn[]>();
  for (const r of refunds) {
    const l = pLinks.get(r.paymentId);
    if (!l) continue;
    const arr = refundsByOrder.get(l.orderId) ?? [];
    arr.push(r); refundsByOrder.set(l.orderId, arr);
  }
  for (const o of orders) {
    const rs = (refundsByOrder.get(o.id) ?? []).sort((a, b) => a.ts - b.ts);
    const gw = r2(rs.reduce((s, r) => s + r.amount, 0));
    if (o.refundedAmount > gw + 1) {
      ex.push({
        type: 'REFUND_NOT_IN_GATEWAY', key: o.id, severity: 'liability', amount: r2(o.refundedAmount - gw),
        facts: { orderId: o.id, orderTotal: o.total, customer: o.customerName, email: o.email, refundedInShopify: o.refundedAmount, refundedInGateway: gw, refundDue: r2(o.refundedAmount - gw), paymentId: (paymentsByOrder.get(o.id) ?? [])[0]?.entityId ?? '' },
        title: 'Refund promised, never sent',
        explanation: `Shopify shows ${inr(o.refundedAmount)} refunded on ${o.id}, but the gateway processed ${gw ? inr(gw) : 'no refund'}. The customer may still be waiting for their money.`,
        evidence: [`order status ${o.financialStatus}`],
      });
    } else if (gw > o.refundedAmount + 1) {
      for (const r of o.refundedAmount <= 0.5 ? rs : rs.slice(-1)) {
        ex.push({
          type: 'UNRECORDED_REFUND', key: r.entityId, severity: 'review',
          facts: { refundId: r.entityId, refundDate: r.createdAt.slice(0, 10), refundAmount: r.amount, orderId: o.id, paymentId: r.paymentId, settlementId: r.settlementId, refundedInShopify: o.refundedAmount, unrecorded: o.refundedAmount <= 0.5 ? r.amount : r2(gw - o.refundedAmount) },
          amount: o.refundedAmount <= 0.5 ? r.amount : r2(gw - o.refundedAmount),
          title: 'Refund not recorded in Shopify',
          explanation: `${inr(r.amount)} was refunded through the gateway on ${r.createdAt.slice(0, 10)} for ${o.id}, but Shopify shows ${o.refundedAmount ? inr(o.refundedAmount) : 'no refund'}. Revenue in your books is overstated.`,
          evidence: [`payment ${r.paymentId}`, `deducted in ${r.settlementId || 'unsettled'}`],
        });
      }
    }
  }

  for (const a of adjustments) {
    const l = pLinks.get(a.paymentId);
    ex.push({
      type: 'CHARGEBACK', key: a.entityId, severity: 'loss', amount: a.debit || a.amount,
      facts: { adjustmentId: a.entityId, debitDate: a.createdAt.slice(0, 10), amount: a.debit || a.amount, paymentId: a.paymentId, orderId: l?.orderId ?? '', settlementId: a.settlementId, disputeId: a.description.match(/disp_[A-Za-z0-9]+/)?.[0] ?? '', description: a.description },
      title: 'Chargeback deducted from settlement',
      explanation: `${inr(a.debit || a.amount)} was debited${l ? ` for ${l.orderId}` : ''}${a.description ? ` (${a.description})` : ''}. Submit delivery proof to contest it.`,
      evidence: [`payment ${a.paymentId}`, `deducted in ${a.settlementId}`],
    });
  }

  const bankEnd = ds.bank.reduce((m, b) => Math.max(m, b.ts), 0);
  const bankById = new Map(ds.bank.map((b) => [b.tranId, b]));
  for (const s of settlements) {
    const l = bLinks.get(s.id);
    if (!l) {
      if (s.ts > bankEnd) continue; // still in transit after statement end
      ex.push({
        type: 'SETTLEMENT_NOT_IN_BANK', key: s.id, severity: 'loss', amount: s.net,
        facts: { settlementId: s.id, utr: s.utr, settledOn: s.settledAt.slice(0, 10), net: s.net, credits: s.credits, debits: s.debits, transactions: s.txnIds.length, statementEnd: new Date(bankEnd).toISOString().slice(0, 10) },
        title: 'Settlement never reached the bank',
        explanation: `Razorpay settled ${inr(s.net)} on ${s.settledAt} (UTR ${s.utr}, ${s.txnIds.length} transactions), but no matching credit exists in the bank statement. Raise a ticket with the UTR.`,
        evidence: [`gross credits ${inr(s.credits)}`, `debits ${inr(s.debits)}`],
      });
      continue;
    }
    const b = bankById.get(l.tranId)!;
    const diff = r2(b.deposit - s.net);
    if (diff < -BANK_TOLERANCE) {
      ex.push({
        type: 'BANK_SHORT_CREDIT', key: s.id, severity: 'loss', amount: -diff,
        facts: { settlementId: s.id, utr: s.utr, settledOn: s.settledAt.slice(0, 10), net: s.net, bankCredit: b.deposit, bankDate: b.date, bankRef: b.tranId, shortBy: -diff },
        title: 'Bank received less than settled',
        explanation: `Settlement ${s.id} is ${inr(s.net)} but the bank credited ${inr(b.deposit)} on ${b.date}. ${inr(-diff)} is unaccounted for.`,
        evidence: [`UTR ${s.utr}`, `bank ref ${b.tranId}`],
      });
    } else if (diff > BANK_TOLERANCE) {
      ex.push({
        type: 'BANK_EXCESS_CREDIT', key: s.id, severity: 'review', amount: diff,
        facts: { settlementId: s.id, utr: s.utr, settledOn: s.settledAt.slice(0, 10), net: s.net, bankCredit: b.deposit, bankDate: b.date, bankRef: b.tranId, excess: diff },
        title: 'Bank received more than settled',
        explanation: `Bank credited ${inr(b.deposit)} against a settlement of ${inr(s.net)}.`,
        evidence: [`bank ref ${b.tranId}`],
      });
    }
  }

  for (const b of gatewayCredits) {
    if (usedBank.has(b.tranId)) continue;
    ex.push({
      type: 'UNKNOWN_GATEWAY_CREDIT', key: b.tranId, severity: 'review', amount: b.deposit,
      facts: { bankRef: b.tranId, bankDate: b.date, amount: b.deposit, narration: b.narration },
      title: 'Gateway credit with no settlement record',
      explanation: `${inr(b.deposit)} from Razorpay landed on ${b.date} but matches no settlement in the report. The report export may be missing a day.`,
      evidence: [`narration "${b.narration}"`],
    });
  }

  stages.push({ stage: 'Exceptions', detail: 'every gap typed, sized and explained', resolved: ex.length });

  // ---- money summary
  const sev = (s: string) => r2(ex.filter((e) => e.severity === s).reduce((a, e) => a + e.amount, 0));
  const money: MoneySummary = {
    prepaidOrderValue: r2(orders.filter(isPrepaidOrder).reduce((s, o) => s + o.total, 0)),
    captured: r2(payments.reduce((s, p) => s + p.amount, 0)),
    fees: r2(payments.reduce((s, p) => s + p.fee, 0)),
    feeGst: r2(payments.reduce((s, p) => s + p.tax, 0)),
    refunds: r2(refunds.reduce((s, r) => s + (r.debit || r.amount), 0)),
    adjustments: r2(adjustments.reduce((s, r) => s + (r.debit || r.amount), 0)),
    netSettled: r2(settlements.reduce((s, x) => s + x.net, 0)),
    receivedInBank: r2([...bLinks.values()].reduce((s, l) => s + (bankById.get(l.tranId)?.deposit ?? 0), 0)),
    atRisk: sev('loss'),
    owedToCustomers: sev('liability'),
    reviewCount: ex.filter((e) => e.severity === 'review').length,
  };

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    mode,
    paymentLinks: [...pLinks.values()],
    bankLinks: [...bLinks.values()],
    settlements,
    exceptions: ex,
    money,
    stages,
    pendingPackets,
    aiApplied,
    counts: { orders: orders.length, payments: payments.length, settlements: settlements.length, bankCredits: gatewayCredits.length },
    runtimeMs: Math.round((t1 - t0) * 10) / 10,
  };
}
