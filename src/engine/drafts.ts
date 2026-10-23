// Turns exceptions into ready-to-send drafts: tickets, customer messages, refund instructions,
// dispute checklists and notes for the CA. Templates use only the facts on the exception.
// Anything the engine cannot know (merchant ID, contact names, deadlines) stays a [placeholder].
//
// The optional AI polish (draft-ai.ts) rewrites a template's wording. checkFacts() below is the
// guard: every amount, date, id and UTR in the AI text must already be in the template.
import type { ExceptionType, RecException, Severity } from './types';

export type Audience = 'gateway' | 'customer' | 'internal' | 'ca';

export interface DraftPart {
  id: string;            // stable: type, exception key and audience
  audience: Audience;
  label: string;         // what this part is, e.g. "Ticket to the payment gateway"
  subject: string;
  body: string;
}

export const AUDIENCE_LABEL: Record<Audience, string> = {
  gateway: 'Ticket to the payment gateway', customer: 'Message to the customer',
  internal: 'Refund instruction for your team', ca: 'Note for your CA or ops team',
};

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const str = (v: unknown, placeholder: string) => (v === undefined || v === null || v === '' ? `[${placeholder}]` : String(v));
const money = (v: unknown, placeholder: string) => (typeof v === 'number' && Number.isFinite(v) ? inr(v) : `[${placeholder}]`);
const firstName = (name: unknown) => (typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : '[customer name]');

const SIGN_OFF = 'Regards,\n[your name]\n[business name]';
const MERCHANT = 'Merchant ID: [merchant ID]';

/** One line per exception type, for the CSV export and the UI. */
export const SUGGESTED_ACTION: Record<ExceptionType, string> = {
  FEE_OVERCHARGE: 'Raise one ticket with the gateway for the fee difference and ask for a credit.',
  PAYMENT_MISSING: 'Check whether the payment is on hold or the order was marked paid by hand; collect payment or mark it unpaid.',
  UNMATCHED_PAYMENT: 'Find the order this payment belongs to, or refund the payer.',
  DUPLICATE_PAYMENT: 'Refund the second payment and tell the customer.',
  AMOUNT_MISMATCH: 'Confirm the discount or edit with the team and correct the order or the books.',
  REFUND_NOT_IN_GATEWAY: 'Send the refund through the gateway and tell the customer.',
  UNRECORDED_REFUND: 'Record the refund in Shopify or book a credit note.',
  CHARGEBACK: 'Collect delivery proof and respond to the dispute before the deadline.',
  SETTLEMENT_NOT_IN_BANK: 'Raise a ticket with the gateway quoting the UTR.',
  BANK_SHORT_CREDIT: 'Ask the gateway for the deduction breakdown of this settlement.',
  BANK_EXCESS_CREDIT: 'Ask your CA to check what the extra credit is before booking it.',
  UNKNOWN_GATEWAY_CREDIT: 'Ask the gateway which settlement this credit belongs to.',
};

function ticket(e: RecException): DraftPart {
  const f = e.facts;
  const base = { id: `${e.type}:${e.key}:gateway`, audience: 'gateway' as const, label: AUDIENCE_LABEL.gateway };
  if (e.type === 'SETTLEMENT_NOT_IN_BANK') {
    return { ...base,
      subject: `Settlement ${str(f.settlementId, 'settlement ID')} not received in our bank account`,
      body: [
        'Hello support team,', '',
        `Settlement ${str(f.settlementId, 'settlement ID')} for ${money(f.net, 'amount')} shows as settled on ${str(f.settledOn, 'settlement date')} with UTR ${str(f.utr, 'UTR')}, but it has not been credited to our bank account. Our bank statement up to ${str(f.statementEnd, 'statement end date')} has no matching credit.`, '',
        'Details:',
        `- ${MERCHANT}`,
        `- Settlement ID: ${str(f.settlementId, 'settlement ID')}`,
        `- UTR: ${str(f.utr, 'UTR')}`,
        `- Settled on: ${str(f.settledOn, 'settlement date')}`,
        `- Net amount: ${money(f.net, 'amount')}`,
        `- Transactions in the settlement: ${str(f.transactions, 'count')}`,
        '- Bank account: [bank account, last 4 digits]', '',
        'Please confirm the transfer status and share the bank reference, or re-initiate the transfer.', '',
        SIGN_OFF,
      ].join('\n') };
  }
  if (e.type === 'BANK_SHORT_CREDIT') {
    return { ...base,
      subject: `Settlement ${str(f.settlementId, 'settlement ID')} credited short by ${money(f.shortBy, 'amount')}`,
      body: [
        'Hello support team,', '',
        `Settlement ${str(f.settlementId, 'settlement ID')} (UTR ${str(f.utr, 'UTR')}, settled on ${str(f.settledOn, 'settlement date')}) is ${money(f.net, 'amount')} in the settlement report, but our bank credited ${money(f.bankCredit, 'amount')} on ${str(f.bankDate, 'bank date')} (bank reference ${str(f.bankRef, 'bank reference')}). The difference is ${money(f.shortBy, 'amount')}.`, '',
        'Details:',
        `- ${MERCHANT}`,
        `- Settlement ID: ${str(f.settlementId, 'settlement ID')}`,
        `- UTR: ${str(f.utr, 'UTR')}`,
        `- Settled amount: ${money(f.net, 'amount')}`,
        `- Amount credited: ${money(f.bankCredit, 'amount')}`,
        `- Difference: ${money(f.shortBy, 'amount')}`, '',
        'Please share the breakdown of any deduction from this settlement, or transfer the balance.', '',
        SIGN_OFF,
      ].join('\n') };
  }
  // UNKNOWN_GATEWAY_CREDIT
  return { ...base,
    subject: `Bank credit of ${money(f.amount, 'amount')} on ${str(f.bankDate, 'date')} with no settlement record`,
    body: [
      'Hello support team,', '',
      `We received ${money(f.amount, 'amount')} from you on ${str(f.bankDate, 'date')} (bank reference ${str(f.bankRef, 'bank reference')}), but it matches no settlement in our settlement report for [report period].`, '',
      `Bank narration: "${str(f.narration, 'narration')}"`, '',
      'Details:',
      `- ${MERCHANT}`,
      `- Amount: ${money(f.amount, 'amount')}`,
      `- Date credited: ${str(f.bankDate, 'date')}`, '',
      'Please tell us which settlement this credit belongs to and share its settlement ID and transaction list.', '',
      SIGN_OFF,
    ].join('\n') };
}

function feeTicket(items: RecException[]): DraftPart {
  const rows = [...items].sort((a, b) => String(a.facts.paymentDate).localeCompare(String(b.facts.paymentDate)) || a.key.localeCompare(b.key));
  const total = Math.round(rows.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const head = ['Payment ID', 'Date', 'Method', 'Amount', 'Rate charged', 'Contract rate', 'Fee charged', 'Fee expected', 'Difference'];
  const cells = rows.map((e) => {
    const f = e.facts;
    return [str(f.paymentId, 'payment ID'), str(f.paymentDate, 'date'), `${f.method}${f.cardNetwork ? ` ${f.cardNetwork}` : ''}`,
      money(f.paymentAmount, 'amount'), `${f.rateCharged}%`, `${f.rateContract}%`, money(f.feeCharged, 'fee'), money(f.feeExpected, 'fee'), money(f.overcharge, 'amount')];
  });
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd();
  return {
    id: 'FEE_OVERCHARGE:group:gateway', audience: 'gateway', label: AUDIENCE_LABEL.gateway,
    subject: `Fees charged above our contract on ${rows.length} payment${rows.length === 1 ? '' : 's'}: ${inr(total)} to credit`,
    body: [
      'Hello support team,', '',
      `The fees on the ${rows.length} payment${rows.length === 1 ? '' : 's'} below are above our contracted rates. Rates are before GST on the fee; fees include it.`, '',
      line(head), line(width.map((w) => '-'.repeat(w))), ...cells.map(line), '',
      `Total charged above contract: ${inr(total)}`, '',
      `${MERCHANT}`,
      'Our contract: [contract or pricing reference]', '',
      'Please check these payments and credit the difference to our next settlement.', '',
      SIGN_OFF,
    ].join('\n'),
  };
}

function customerAndRefund(e: RecException): DraftPart[] {
  const f = e.facts;
  const hi = `Hi ${firstName(f.customer)},`;
  if (e.type === 'DUPLICATE_PAYMENT') {
    return [
      { id: `${e.type}:${e.key}:customer`, audience: 'customer', label: AUDIENCE_LABEL.customer,
        subject: `Refund for the extra payment on order ${str(f.orderId, 'order number')}`,
        body: [hi, '',
          `You were charged twice for order ${str(f.orderId, 'order number')}. We are refunding the extra payment of ${money(f.duplicateAmount, 'amount')} to the original payment method. Banks usually take [refund timeline] to show it.`, '',
          'Sorry for the trouble. Reply to this message if you have any questions.', '',
          'Thanks,', '[business name]'].join('\n') },
      { id: `${e.type}:${e.key}:internal`, audience: 'internal', label: AUDIENCE_LABEL.internal,
        subject: `Refund duplicate payment ${str(f.duplicatePaymentId, 'payment ID')} on ${str(f.orderId, 'order number')}`,
        body: [
          `Order ${str(f.orderId, 'order number')} (total ${money(f.orderTotal, 'amount')}) was paid twice:`,
          `- Keep: ${str(f.firstPaymentId, 'payment ID')} (${str(f.firstPaymentDate, 'date')})`,
          `- Refund: ${str(f.duplicatePaymentId, 'payment ID')} (${str(f.duplicatePaymentDate, 'date')}), ${str(f.minutesApart, 'minutes')} min later, ${money(f.duplicateAmount, 'amount')}`, '',
          'Steps:',
          `1. In the gateway dashboard, issue a full refund of ${money(f.duplicateAmount, 'amount')} on ${str(f.duplicatePaymentId, 'payment ID')}.`,
          `2. Note the refund ID on order ${str(f.orderId, 'order number')} in Shopify. Do not change the order total.`,
          `3. Send the customer message to ${str(f.email, 'customer email')}.`].join('\n') },
    ];
  }
  // REFUND_NOT_IN_GATEWAY
  return [
    { id: `${e.type}:${e.key}:customer`, audience: 'customer', label: AUDIENCE_LABEL.customer,
      subject: `Your refund for order ${str(f.orderId, 'order number')}`,
      body: [hi, '',
        `Our records show a refund of ${money(f.refundDue, 'amount')} for order ${str(f.orderId, 'order number')}, but it was not sent to you. We are sending it now to the original payment method. Banks usually take [refund timeline] to show it.`, '',
        'Sorry for the delay. Reply to this message if you have any questions.', '',
        'Thanks,', '[business name]'].join('\n') },
    { id: `${e.type}:${e.key}:internal`, audience: 'internal', label: AUDIENCE_LABEL.internal,
      subject: `Send the missing refund on ${str(f.orderId, 'order number')}`,
      body: [
        `Shopify shows ${money(f.refundedInShopify, 'amount')} refunded on order ${str(f.orderId, 'order number')}, but the gateway processed ${typeof f.refundedInGateway === 'number' && f.refundedInGateway > 0 ? money(f.refundedInGateway, 'amount') : 'no refund'}.`, '',
        'Steps:',
        `1. In the gateway dashboard, refund ${money(f.refundDue, 'amount')} on payment ${str(f.paymentId, 'payment ID')}.`,
        `2. Add the refund ID to order ${str(f.orderId, 'order number')} in Shopify.`,
        `3. Send the customer message to ${str(f.email, 'customer email')}.`].join('\n') },
  ];
}

function chargebackChecklist(e: RecException): DraftPart {
  const f = e.facts;
  return {
    id: `${e.type}:${e.key}:internal`, audience: 'internal', label: 'Dispute evidence checklist',
    subject: `Evidence for dispute ${str(f.disputeId, 'dispute ID')} on ${f.orderId ? `order ${f.orderId}` : `payment ${str(f.paymentId, 'payment ID')}`}`,
    body: [
      `${money(f.amount, 'amount')} was debited on ${str(f.debitDate, 'date')} from settlement ${str(f.settlementId, 'settlement ID')} for dispute ${str(f.disputeId, 'dispute ID')}.`,
      `Payment: ${str(f.paymentId, 'payment ID')}. Order: ${str(f.orderId, 'order number')}. Gateway adjustment: ${str(f.adjustmentId, 'adjustment ID')}.`,
      'Respond by: [dispute response deadline]', '',
      'Collect and upload:',
      `[ ] Invoice for order ${str(f.orderId, 'order number')}`,
      '[ ] Proof of delivery: courier name, AWB [AWB number], delivery date and signature or photo',
      '[ ] Order confirmation and shipping emails or messages sent to the customer',
      '[ ] Any messages from the customer after delivery',
      '[ ] Product page or photos showing what was sold',
      '[ ] Refund and return policy shown at checkout',
      `[ ] Payment details: ${str(f.paymentId, 'payment ID')}, ${money(f.amount, 'amount')}`, '',
      'If the claim is valid and you would rather refund, accept the dispute instead of refunding separately, so the customer is not paid twice.',
    ].join('\n'),
  };
}

function caNote(e: RecException): DraftPart {
  const f = e.facts;
  const part = (subject: string, lines: string[]): DraftPart =>
    ({ id: `${e.type}:${e.key}:ca`, audience: 'ca', label: AUDIENCE_LABEL.ca, subject, body: lines.join('\n') });
  switch (e.type) {
    case 'UNRECORDED_REFUND':
      return part(`Refund ${str(f.refundId, 'refund ID')} on ${str(f.orderId, 'order number')} is not in Shopify`, [
        `The gateway refunded ${money(f.refundAmount, 'amount')} on ${str(f.refundDate, 'date')} (refund ${str(f.refundId, 'refund ID')}, payment ${str(f.paymentId, 'payment ID')}) for order ${str(f.orderId, 'order number')}. It was deducted in settlement ${str(f.settlementId, 'settlement ID')}.`,
        `Shopify shows ${typeof f.refundedInShopify === 'number' && f.refundedInShopify > 0 ? money(f.refundedInShopify, 'amount') : 'no refund'} on this order, so ${money(f.unrecorded, 'amount')} of revenue is overstated in the books.`, '',
        'Action: record the refund in Shopify, or book a credit note for the same amount.']);
    case 'AMOUNT_MISMATCH':
      return part(`Order ${str(f.orderId, 'order number')} collected ${f.direction === 'more' ? 'more' : 'less'} than its total`, [
        `Order ${str(f.orderId, 'order number')} totals ${money(f.orderTotal, 'amount')}, but payment ${str(f.paymentId, 'payment ID')} on ${str(f.paymentDate, 'date')} captured ${money(f.captured, 'amount')}. The difference is ${money(f.difference, 'amount')}.`, '',
        'Action: check whether a discount or edit was applied on one side only. Correct the order, or book the difference as a discount.']);
    case 'PAYMENT_MISSING':
      return part(`Order ${str(f.orderId, 'order number')} is marked paid with no payment`, [
        `Shopify shows order ${str(f.orderId, 'order number')} (${str(f.orderDate, 'date')}, ${str(f.customer, 'customer')}) as ${str(f.financialStatus, 'paid')} for ${money(f.orderTotal, 'amount')}, but no gateway payment could be tied to it.`,
        ...(f.paymentReference ? [`Its payment reference ${f.paymentReference} does not exist in the settlement report.`] : []), '',
        'Action: check whether the payment is on hold with the gateway or the order was marked paid by hand. If it is unpaid, collect payment from the customer or mark the order unpaid before it ships.']);
    case 'UNMATCHED_PAYMENT':
      return part(`Payment ${str(f.paymentId, 'payment ID')} has no order`, [
        `${money(f.amount, 'amount')} was received on ${str(f.paymentDate, 'date')} (payment ${str(f.paymentId, 'payment ID')}, ${str(f.method, 'method')}) and could not be tied to an order.`,
        `Payer: ${str(f.payer, 'payer')}. Notes: ${f.notes ? `"${f.notes}"` : 'none'}.`, '',
        'Action: find the order this payment belongs to and link it. If there is none, refund the payer.']);
    case 'BANK_EXCESS_CREDIT':
      return part(`Bank credited more than settlement ${str(f.settlementId, 'settlement ID')}`, [
        `Settlement ${str(f.settlementId, 'settlement ID')} (UTR ${str(f.utr, 'UTR')}) is ${money(f.net, 'amount')}, but the bank credited ${money(f.bankCredit, 'amount')} on ${str(f.bankDate, 'date')} (bank reference ${str(f.bankRef, 'bank reference')}). The extra is ${money(f.excess, 'amount')}.`, '',
        'Action: confirm what the extra credit is before booking it as revenue.']);
    default:
      return part(e.title, [e.explanation]);
  }
}

/** Builds the drafts for one exception group (all exceptions of one type). */
export function draftsForGroup(items: RecException[]): DraftPart[] {
  if (!items.length) return [];
  const type = items[0].type;
  if (type === 'FEE_OVERCHARGE') return [feeTicket(items)];
  return items.flatMap((e) => {
    switch (e.type) {
      case 'SETTLEMENT_NOT_IN_BANK': case 'BANK_SHORT_CREDIT': case 'UNKNOWN_GATEWAY_CREDIT': return [ticket(e)];
      case 'DUPLICATE_PAYMENT': case 'REFUND_NOT_IN_GATEWAY': return customerAndRefund(e);
      case 'CHARGEBACK': return [chargebackChecklist(e)];
      default: return [caNote(e)];
    }
  });
}

// ---------- fact guard ----------
// Step numbers at the start of a line ("1.", "2)") are list markers, not facts.
const withoutListMarkers = (text: string) => text.replace(/^(\s*)\d{1,2}[.)](?=\s)/gm, '$1');
const numbersIn = (text: string) =>
  (withoutListMarkers(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((t) => Number(t.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
// Ids, UTRs and bank references: words that mix letters with digits, or carry an id prefix.
const idsIn = (text: string) =>
  (text.match(/[A-Za-z0-9_]+/g) ?? []).filter((w) => /^(pay|rfnd|adj|setl|disp|order)_/i.test(w) || (/[A-Za-z]/.test(w) && (w.match(/\d/g) ?? []).length >= 4));

/**
 * Checks that a rewrite adds no facts. Every number (amounts, dates, counts, order numbers) and
 * every id or UTR in the rewrite must already appear in the template. Returns what it could not find.
 */
export function checkFacts(template: { subject: string; body: string }, rewrite: { subject: string; body: string }) {
  const src = `${template.subject}\n${template.body}`;
  const out = `${rewrite.subject}\n${rewrite.body}`;
  const known = new Set(numbersIn(src));
  // Dates may be rewritten as words ("17 September 2026"), so a date's parts count as known too.
  for (const m of src.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) [m[1], m[2], m[3]].forEach((x) => known.add(Number(x)));
  const knownIds = new Set(idsIn(src));
  const unknown = [
    ...numbersIn(out).filter((n) => !known.has(n)).map(String),
    ...idsIn(out).filter((w) => !knownIds.has(w)),
  ];
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}

// ---------- CSV export ----------
const SEVERITY_LABEL: Record<Severity, string> = { loss: 'Money at risk', liability: 'Owed to customers', review: 'Needs review' };

export function exceptionsCsv(list: RecException[]) {
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['type', 'severity', 'key', 'amount', 'explanation', 'evidence', 'suggested action'];
  const rows = list.map((e) => [e.type, SEVERITY_LABEL[e.severity], e.key, e.amount.toFixed(2), e.explanation, e.evidence.join('; '), SUGGESTED_ACTION[e.type]]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
