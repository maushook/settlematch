/**
 * Synthetic data generator for SettleMatch.
 *
 * Produces three realistic exports for a fictional D2C wall-art brand
 * ("Kalakriti Home") for September 2026, plus an answer key:
 *   public/sample/shopify_orders.csv
 *   public/sample/razorpay_settlement_report.csv
 *   public/sample/bank_statement.csv
 *   src/sample/answer-key.json
 *
 * Every problem in the data is planted on purpose, so we know the right
 * answer for every row and can measure the engine's accuracy honestly.
 * Seeded RNG: the output is identical on every run.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AnswerKey, ExceptionType } from '../src/engine/types';

// ---------- seeded RNG ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260930);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;
const alnum = (n: number) => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(rnd() * c.length)]; return s;
};
const digits = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += int(0, 9); return s; };
const r2 = (x: number) => Math.round(x * 100) / 100;

// ---------- time helpers (wall-clock IST stored as UTC) ----------
const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s);
const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const fmtBankDate = (t: number) => { const d = new Date(t); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const settleDay = (t: number) => {
  let d = dayStart(t) + 2 * DAY;
  if (new Date(d).getUTCDay() === 0) d += DAY; // no Sunday settlements
  return d;
};

// ---------- catalogue ----------
const PRODUCTS = [
  { name: 'Mandala Canvas 24x36', price: 2499, informal: 'gol design wali badi painting' },
  { name: 'Kerala Backwaters Canvas', price: 2499, informal: 'houseboat wali canvas, green one' },
  { name: 'Madhubani Peacock Print', price: 1799, informal: 'mor wala print' },
  { name: 'Warli Harvest Frame', price: 1799, informal: 'tribal stick figure wala frame' },
  { name: 'Taj Sunset Panorama', price: 3499, informal: 'Agra wali painting, evening colours' },
  { name: 'Gold Leaf Abstract Trio', price: 3499, informal: 'sone ki patti wala 3 piece' },
  { name: 'Botanical Line Art Set', price: 1299, informal: '' },
  { name: 'Buddha Meditation Canvas', price: 2799, informal: '' },
  { name: 'Jaipur Doors Collage', price: 1999, informal: '' },
  { name: 'Kolam Pattern Print', price: 999, informal: '' },
];
const P = (n: string) => PRODUCTS.find((p) => p.name.startsWith(n))!;

const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Arjun', 'Meera', 'Kabir', 'Isha', 'Vikram', 'Divya', 'Rahul', 'Sneha', 'Aditya', 'Pooja', 'Nikhil', 'Kavya', 'Siddharth', 'Neha', 'Varun', 'Tanvi', 'Harish', 'Ritu', 'Manoj', 'Anjali', 'Suresh', 'Deepa', 'Gaurav', 'Swati', 'Rajesh', 'Nandini'];
const LAST = ['Sharma', 'Patel', 'Menon', 'Gupta', 'Kapoor', 'Joshi', 'Pillai', 'Verma', 'Bose', 'Kulkarni', 'Chopra', 'Desai', 'Agarwal', 'Shetty', 'Banerjee', 'Malhotra', 'Hegde', 'Saxena', 'Chatterjee', 'Bhat'];
const phone = () => `9${digits(9)}`;
const emailOf = (f: string, l: string) => `${f}.${l}${int(1, 99)}@${pick(['gmail.com', 'yahoo.co.in', 'outlook.com', 'gmail.com'])}`.toLowerCase();

// ---------- order specs ----------
type Kind =
  | 'normal' | 'cod' | 'hard' | 'easy' | 'missingPayment' | 'duplicate' | 'mismatch'
  | 'refund' | 'refundNotInGateway' | 'unrecordedRefund' | 'chargeback' | 'overcharge';

interface Spec {
  kind: Kind;
  ts: number;
  first: string; last: string; email: string; phone: string;
  items: { name: string; price: number }[];
  total: number;
  method: 'upi' | 'card' | 'netbanking' | 'cod';
  network?: string;
  note?: (num: string) => string;    // payment notes for payment-link orders
  payerEmail?: string; payerPhone?: string;
  id?: string; payId?: string;
}

const specs: Spec[] = [];
const randTs = (fromDay = 1, toDay = 28) => D(2026, 9, int(fromDay, toDay), int(8, 22), int(0, 59), int(0, 59));
const person = () => { const f = pick(FIRST), l = pick(LAST); return { first: f, last: l, email: emailOf(f, l), phone: phone() }; };
const method = (): Spec['method'] => { const x = rnd(); return x < 0.58 ? 'upi' : x < 0.9 ? 'card' : 'netbanking'; };

function normalSpec(kind: Kind = 'normal', m?: Spec['method']): Spec {
  const items = [pick(PRODUCTS)];
  if (chance(0.18)) items.push(pick(PRODUCTS));
  let total = items.reduce((s, i) => s + i.price, 0);
  if (chance(0.15)) total = Math.round(total * 0.9); // 10% coupon
  const mm = m ?? method();
  return { kind, ts: randTs(), ...person(), items: items.map(({ name, price }) => ({ name, price })), total, method: mm,
    network: mm === 'card' ? (chance(0.12) ? 'amex' : pick(['visa', 'mastercard', 'rupay'])) : '' };
}

// 1) Hard pairs: payment-link orders with no references; same amount, same week.
function pairSpecs(prodA: ReturnType<typeof P>, prodB: ReturnType<typeof P>, day: number,
  personA: { first: string; last: string }, personB: { first: string; last: string },
  noteA: (n: string) => string, noteB: (n: string) => string, kind: Kind) {
  for (const [prod, per, note] of [[prodA, personA, noteA], [prodB, personB, noteB]] as const) {
    const payer = person();
    specs.push({
      kind, ts: D(2026, 9, day, int(9, 21), int(0, 59), int(0, 59)),
      first: per.first, last: per.last, email: emailOf(per.first, per.last), phone: phone(),
      items: [{ name: prod.name, price: prod.price }], total: prod.price, method: 'upi', note,
      payerEmail: kind === 'easy' ? undefined : (chance(0.5) ? payer.email : ''), payerPhone: payer.phone,
    });
  }
}

// Hard: informal product descriptions in Hinglish (same price, different products)
pairSpecs(P('Mandala'), P('Kerala'), 4, person(), person(),
  () => `${P('Mandala').informal} - gift for didi`, () => `${P('Kerala').informal} pls deliver before sunday`, 'hard');
pairSpecs(P('Madhubani'), P('Warli'), 9, person(), person(),
  () => `${P('Madhubani').informal}, link from whatsapp`, () => `${P('Warli').informal} for new office`, 'hard');
pairSpecs(P('Taj'), P('Gold'), 15, person(), person(),
  () => `${P('Taj').informal}`, () => `${P('Gold').informal} for living room`, 'hard');
// Hard: same product, disambiguated only by spelling variants of the buyer's first name
pairSpecs(P('Mandala'), P('Mandala'), 19, { first: 'Lakshmi', last: 'Iyer' }, { first: 'Venkatesh', last: 'Murthy' },
  () => `paying for Laxmi aunty order`, () => `on behalf of Venky sir`, 'hard');
// Hard: order number obfuscated (letter O for zero, number spelled out)
pairSpecs(P('Botanical'), P('Botanical'), 22, person(), person(),
  (n) => `pymt agnst ord ${n.replace(/0/g, 'O').replace(/1/g, 'l')}`,
  (n) => `order no ${n.split('').map((d) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][+d]).join(' ')}`, 'hard');
// Easy: clean order number / full name / email in the payment record
pairSpecs(P('Buddha'), P('Buddha'), 11, person(), person(),
  (n) => `Payment for order #${n}`, () => '', 'easy');
pairSpecs(P('Jaipur'), P('Jaipur'), 24, person(), person(),
  () => 'payment link', () => 'payment link', 'easy');

// 2) Orders marked paid in Shopify but the payment never reached the gateway.
for (let i = 0; i < 3; i++) {
  const s = normalSpec('missingPayment', 'upi');
  if (i === 0) { s.items = [{ name: P('Mandala').name, price: 2499 }]; s.total = 2499; s.ts = D(2026, 9, 5, 13, 12, 0); } // decoy for a hard pair
  specs.push(s);
}
// 3) Other planted cases
for (let i = 0; i < 2; i++) specs.push(normalSpec('duplicate', 'upi'));
for (let i = 0; i < 2; i++) { const s = normalSpec('mismatch', 'card'); s.network = 'visa'; specs.push(s); }
for (let i = 0; i < 8; i++) specs.push(normalSpec('refund'));
for (let i = 0; i < 3; i++) specs.push(normalSpec('refundNotInGateway'));
for (let i = 0; i < 2; i++) specs.push(normalSpec('unrecordedRefund'));
{ const s = normalSpec('chargeback', 'card'); s.network = 'visa'; specs.push(s); }
for (let i = 0; i < 9; i++) { const s = normalSpec('overcharge', 'card'); s.network = pick(['visa', 'mastercard']); specs.push(s); }
// 4) COD + normal fill to 300
for (let i = 0; i < 21; i++) specs.push(normalSpec('cod', 'cod'));
while (specs.length < 300) specs.push(normalSpec('normal'));

// Assign order numbers in time order
specs.sort((a, b) => a.ts - b.ts);
specs.forEach((s, i) => { s.id = `#${1001 + i}`; });

// ---------- gateway rows ----------
interface GRow {
  entity_id: string; type: string; debit: number; credit: number; amount: number; currency: string;
  fee: number; tax: number; on_hold: string; settled: string; created_at: string; settled_at: string;
  settlement_id: string; description: string; notes: string; payment_id: string; settlement_utr: string;
  order_id: string; order_receipt: string; method: string; card_network: string; email: string; contact: string;
  _ts: number;
}
const gateway: GRow[] = [];
const key: AnswerKey = { orderPayment: {}, settlementBank: {}, exceptions: [], hard: { payments: [], bank: [] } };
const exc = (type: ExceptionType, k: string) => key.exceptions.push({ type, key: k });

const CONTRACT = { upi: 2, card: 2, amex: 3, netbanking: 2 };
const feeFor = (amount: number, m: string, net: string, pct?: number) => {
  const rate = pct ?? (m === 'card' && net === 'amex' ? CONTRACT.amex : (CONTRACT as any)[m] ?? 2);
  const base = r2((amount * rate) / 100);
  const tax = r2(base * 0.18);
  return { fee: r2(base + tax), tax };
};

function addPayment(s: Spec, opts: { amount?: number; ts?: number; receipt?: string; ratePct?: number; notes?: string; email?: string; contact?: string } = {}) {
  const id = `pay_${alnum(14)}`;
  const amount = opts.amount ?? s.total;
  const { fee, tax } = feeFor(amount, s.method, s.network ?? '', opts.ratePct);
  const ts = opts.ts ?? s.ts + int(20, 240) * 1000;
  gateway.push({
    entity_id: id, type: 'payment', debit: 0, credit: r2(amount - fee), amount, currency: 'INR', fee, tax,
    on_hold: '0', settled: '1', created_at: fmt(ts), settled_at: '', settlement_id: '', description: '',
    notes: opts.notes ?? '', payment_id: '', settlement_utr: '', order_id: `order_${alnum(14)}`,
    order_receipt: opts.receipt ?? s.id!, method: s.method, card_network: s.network ?? '',
    email: opts.email ?? s.email, contact: opts.contact ?? `+91${s.phone}`, _ts: ts,
  });
  key.orderPayment[id] = s.id!;
  return id;
}
function addRefund(payId: string, amount: number, ts: number) {
  const id = `rfnd_${alnum(14)}`;
  gateway.push({
    entity_id: id, type: 'refund', debit: amount, credit: 0, amount, currency: 'INR', fee: 0, tax: 0,
    on_hold: '0', settled: '1', created_at: fmt(ts), settled_at: '', settlement_id: '', description: 'Refund',
    notes: '', payment_id: payId, settlement_utr: '', order_id: '', order_receipt: '', method: '', card_network: '',
    email: '', contact: '', _ts: ts,
  });
  return id;
}

const orderRows: Record<string, string | number>[] = [];
for (const s of specs) {
  let paymentReference = '';
  let financial = s.method === 'cod' ? 'pending' : 'paid';
  let refunded = 0;
  // debits must land in a settlement that also has payment credits, so keep them inside the sales window
  const refundTs = () => Math.min(s.ts + int(2, 6) * DAY, D(2026, 9, 26, 18, 0, 0));

  switch (s.kind) {
    case 'cod': break;
    case 'normal': {
      const pid = addPayment(s, { receipt: chance(0.92) ? s.id : '' });
      // Shopify only records the gateway reference for some orders; the receipt is the main link
      paymentReference = chance(0.7) ? pid : '';
      if (!paymentReference && !gateway[gateway.length - 1].order_receipt) paymentReference = pid;
      break;
    }
    case 'overcharge': {
      const pid = addPayment(s, { ratePct: 2.36 });
      paymentReference = pid; exc('FEE_OVERCHARGE', pid); break;
    }
    case 'hard': case 'easy': {
      const ts = s.ts + int(1, 3) * DAY + int(0, 6) * 3600000;
      const pid = addPayment(s, {
        ts, receipt: '', notes: s.note!(s.id!.slice(1)),
        email: s.kind === 'easy' && s.note!('x') === 'payment link' ? s.email : (s.payerEmail ?? ''),
        contact: s.kind === 'easy' && s.note!('x') === 'payment link' ? `+91${s.phone}` : `+91${s.payerPhone}`,
      });
      gateway[gateway.length - 1].description = 'Payment link';
      if (s.kind === 'easy' && s.note!('x') === '') gateway[gateway.length - 1].notes = `${s.first} ${s.last}`;
      key.hard.payments.push(pid);
      break;
    }
    case 'missingPayment': {
      paymentReference = `pay_${alnum(14)}`; exc('PAYMENT_MISSING', s.id!); break;
    }
    case 'duplicate': {
      const pid = addPayment(s); paymentReference = pid;
      const dup = addPayment(s, { ts: s.ts + int(300, 900) * 1000 });
      exc('DUPLICATE_PAYMENT', dup); break;
    }
    case 'mismatch': {
      const pid = addPayment(s, { amount: s.total - 200 }); paymentReference = pid;
      exc('AMOUNT_MISMATCH', pid); break;
    }
    case 'refund': {
      const pid = addPayment(s); paymentReference = pid;
      refunded = chance(0.6) ? s.total : Math.round(s.total / 2);
      financial = refunded === s.total ? 'refunded' : 'partially_refunded';
      addRefund(pid, refunded, refundTs()); break;
    }
    case 'refundNotInGateway': {
      const pid = addPayment(s); paymentReference = pid;
      refunded = s.total; financial = 'refunded';
      exc('REFUND_NOT_IN_GATEWAY', s.id!); break;
    }
    case 'unrecordedRefund': {
      const pid = addPayment(s); paymentReference = pid;
      const rid = addRefund(pid, s.total, refundTs());
      exc('UNRECORDED_REFUND', rid); break;
    }
    case 'chargeback': {
      const pid = addPayment(s); paymentReference = pid;
      const ts = Math.min(s.ts + 8 * DAY, D(2026, 9, 26, 12, 0, 0));
      const id = `adj_${alnum(14)}`;
      gateway.push({
        entity_id: id, type: 'adjustment', debit: s.total, credit: 0, amount: s.total, currency: 'INR', fee: 0, tax: 0,
        on_hold: '0', settled: '1', created_at: fmt(ts), settled_at: '', settlement_id: '',
        description: `Chargeback debit for dispute disp_${alnum(14)}`, notes: '', payment_id: pid, settlement_utr: '',
        order_id: '', order_receipt: '', method: '', card_network: '', email: '', contact: '', _ts: ts,
      });
      exc('CHARGEBACK', id); break;
    }
  }

  orderRows.push({
    'Name': s.id!, 'Email': s.email, 'Phone': `+91 ${s.phone.slice(0, 5)} ${s.phone.slice(5)}`,
    'Created at': `${fmt(s.ts)} +0530`, 'Financial Status': financial, 'Total': s.total.toFixed(2),
    'Payment Method': s.method === 'cod' ? 'Cash on Delivery (COD)' : s.kind === 'hard' || s.kind === 'easy' ? 'manual' : 'Razorpay Secure (UPI, Cards, Wallets, NetBanking)',
    'Payment Reference': paymentReference, 'Refunded Amount': refunded.toFixed(2),
    'Lineitems': s.items.map((i) => `${i.name} x1`).join(' | '),
    'Billing Name': `${s.first} ${s.last}`,
  });
}

// ---------- settlements ----------
gateway.sort((a, b) => a._ts - b._ts);
const byDay = new Map<number, GRow[]>();
for (const g of gateway) {
  const d = settleDay(g._ts);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d)!.push(g);
}
interface Setl { id: string; utr: string; day: number; net: number }
const settlements: Setl[] = [];
for (const [day, rows] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
  const id = `setl_${alnum(14)}`; const utr = `YESBN${digits(11)}`;
  const at = fmt(day + 10 * 3600000 + int(0, 50) * 60000);
  let net = 0;
  for (const r of rows) { r.settlement_id = id; r.settlement_utr = utr; r.settled_at = at; net += r.credit - r.debit; }
  settlements.push({ id, utr, day, net: r2(net) });
}

// ---------- bank statement ----------
interface BRow { _ts: number; narration: string; deposit: number; withdrawal: number; tranId?: string; valueTs?: number }
const bank: BRow[] = [];
const midIdx = Math.floor(settlements.length / 2);
const missingInBank = settlements[midIdx];           // E
const shortCredit = settlements[midIdx - 6];         // F
const noUtr = [settlements[4], settlements[midIdx + 3], settlements[settlements.length - 4]]; // G
const fmtNarr = [
  (u: string) => `NEFT CR-YESB0000001-RAZORPAY SOFTWARE PRIVATE LIMITED-KALAKRITI HOME-${u}`,
  (u: string) => `NEFT/${u}/RAZORPAY SOFTWARE PVT LTD/SETTLEMENT`,
  (u: string) => `IMPS-${u}-RAZORPAY SOFTWA`,
];
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
for (const s of settlements) {
  if (s === missingInBank) { exc('SETTLEMENT_NOT_IN_BANK', s.id); continue; }
  const bt: BRow = { _ts: s.day + 11 * 3600000, narration: pick(fmtNarr)(s.utr), deposit: s.net, withdrawal: 0 };
  if (s === shortCredit) { bt.deposit = r2(s.net - 1250); exc('BANK_SHORT_CREDIT', s.id); }
  if (noUtr.includes(s)) {
    const d = new Date(s.day);
    bt.narration = `BY TRANSFER-RAZORPAY SOFTWARE PVT-SETL ${pad(d.getUTCDate())}${MON[d.getUTCMonth()]}`;
    if (s === noUtr[1]) bt._ts += DAY; // bank posted a day late
  }
  bank.push(bt);
  (s as any)._bank = bt;
}
// Unknown gateway credit (UTR not in the settlement report)
const unknown: BRow = { _ts: D(2026, 9, 17, 11), narration: fmtNarr[0](`YESBN${digits(11)}`), deposit: 4318.62, withdrawal: 0 };
bank.push(unknown);
// Noise
const noise: [number, string, number, number][] = [
  [D(2026, 9, 1, 10), 'NEFT DR-HDFC0000240-PRESTIGE ESTATES-RENT SEP 2026', 0, 45000],
  [D(2026, 9, 2, 12), 'GST CHALLAN PMT-CPIN 26092900123456', 0, 18240],
  [D(2026, 9, 3, 9), 'ACH D- SHIPROCKET PVT LTD-WALLET RECHARGE', 0, 15000],
  [D(2026, 9, 10, 9), 'ACH D- SHIPROCKET PVT LTD-WALLET RECHARGE', 0, 15000],
  [D(2026, 9, 17, 9), 'ACH D- SHIPROCKET PVT LTD-WALLET RECHARGE', 0, 15000],
  [D(2026, 9, 24, 9), 'ACH D- SHIPROCKET PVT LTD-WALLET RECHARGE', 0, 15000],
  [D(2026, 9, 6, 15), 'POS 4022XXXXXX1187 FACEBOOK *ADS', 0, 8000],
  [D(2026, 9, 14, 15), 'POS 4022XXXXXX1187 FACEBOOK *ADS', 0, 12000],
  [D(2026, 9, 22, 15), 'POS 4022XXXXXX1187 FACEBOOK *ADS', 0, 10000],
  [D(2026, 9, 12, 16), 'UPI/CR/626112345678/Ananya Kapoor/okhdfcbank/for kolam print', 999, 0],
  [D(2026, 9, 30, 18), 'SALARY SEP-2026 BULK UPLOAD', 0, 62000],
  [D(2026, 9, 30, 20), 'SMS ALERT CHARGES SEP', 0, 17.7],
];
for (const [t, n, dep, wd] of noise) bank.push({ _ts: t, narration: n, deposit: dep, withdrawal: wd });

bank.sort((a, b) => a._ts - b._ts);
let bal = 342118.55;
const bankRows = bank.map((b) => {
  b.tranId = `S${digits(8)}`;
  bal = r2(bal + b.deposit - b.withdrawal);
  return {
    'Date': fmtBankDate(b._ts), 'Narration': b.narration, 'Tran Id': b.tranId, 'Value Date': fmtBankDate(b._ts),
    'Withdrawal': b.withdrawal ? b.withdrawal.toFixed(2) : '', 'Deposit': b.deposit ? b.deposit.toFixed(2) : '',
    'Balance': bal.toFixed(2),
  };
});
for (const s of settlements) {
  const bt = (s as any)._bank as BRow | undefined;
  if (bt) key.settlementBank[s.id] = bt.tranId!;
}
for (const s of noUtr) key.hard.bank.push(((s as any)._bank as BRow).tranId!);
exc('UNKNOWN_GATEWAY_CREDIT', unknown.tranId!);

// ---------- write ----------
const csv = (rows: Record<string, unknown>[]) => {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};
const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'public/sample'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/sample'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/sample/shopify_orders.csv'), csv(orderRows));
fs.writeFileSync(path.join(root, 'public/sample/razorpay_settlement_report.csv'),
  csv(gateway.map(({ _ts, ...g }) => { void _ts; return g; })));
fs.writeFileSync(path.join(root, 'public/sample/bank_statement.csv'), csv(bankRows));
fs.writeFileSync(path.join(root, 'src/sample/answer-key.json'), JSON.stringify(key, null, 2));

const counts = key.exceptions.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
console.log(`orders=${orderRows.length} gateway_rows=${gateway.length} settlements=${settlements.length} bank_rows=${bankRows.length}`);
console.log('planted exceptions:', counts);
console.log(`hard payments=${key.hard.payments.length} hard bank=${key.hard.bank.length}`);
