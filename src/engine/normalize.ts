// Stage 1: parse and normalize the three CSV exports into clean typed records.
// Real exports differ in column names, date formats and number formats, so every
// field is looked up through a list of aliases.
import Papa from 'papaparse';
import type { BankTxn, Dataset, GatewayTxn, Order, PayMethod } from './types';

export interface ParseIssue { file: 'orders' | 'gateway' | 'bank'; message: string }

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export const money = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
};

export const r2 = (x: number) => Math.round(x * 100) / 100;
export const phone10 = (v: string) => (v || '').replace(/\D/g, '').slice(-10);
export const canonOrderKey = (v: string) => (v || '').replace(/[^0-9a-z]/gi, '').toUpperCase();

const pad = (n: number) => String(n).padStart(2, '0');
export const fmtTs = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** Parses common Indian export date formats into a wall-clock timestamp (no TZ shifting). */
export function parseDate(v: string): number | null {
  const s = (v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(y, +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function rowsOf(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

function makeGetter(headers: string[], aliases: Record<string, string[]>) {
  const map: Record<string, string | undefined> = {};
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  for (const [field, list] of Object.entries(aliases)) {
    map[field] = list.map((a) => byNorm.get(a)).find(Boolean);
  }
  return {
    has: (f: string) => !!map[f],
    get: (row: Record<string, string>, f: string) => (map[f] ? (row[map[f]!] ?? '').trim() : ''),
  };
}

const ORDER_ALIASES = {
  id: ['name', 'ordername', 'orderid', 'ordernumber', 'order', 'orderno'],
  email: ['email', 'customeremail'],
  phone: ['phone', 'billingphone', 'shippingphone', 'customerphone'],
  createdAt: ['createdat', 'orderdate', 'date', 'processedat'],
  status: ['financialstatus', 'paymentstatus'],
  total: ['total', 'ordertotal', 'totalprice', 'amount'],
  method: ['paymentmethod', 'gateway', 'paymentgateway'],
  ref: ['paymentreference', 'paymentid', 'transactionid', 'gatewayreference', 'razorpaypaymentid'],
  refunded: ['refundedamount', 'refunded', 'totalrefunded'],
  items: ['lineitems', 'lineitemname', 'items', 'products'],
  name: ['billingname', 'customername', 'shippingname', 'customer'],
};

const GATEWAY_ALIASES = {
  id: ['entityid', 'id', 'transactionid'],
  type: ['type', 'entitytype'],
  debit: ['debit'], credit: ['credit'], amount: ['amount'],
  fee: ['fee', 'fees'], tax: ['tax', 'gst'],
  createdAt: ['createdat', 'date'], settledAt: ['settledat', 'settlementdate'],
  settlementId: ['settlementid'], utr: ['settlementutr', 'utr'],
  paymentId: ['paymentid'], method: ['method', 'paymentmethod'], network: ['cardnetwork', 'network'],
  receipt: ['orderreceipt', 'receipt'], email: ['email'], contact: ['contact', 'phone'],
  notes: ['notes'], description: ['description'],
};

const BANK_ALIASES = {
  date: ['date', 'txndate', 'transactiondate', 'trandate', 'valuedate'],
  narration: ['narration', 'description', 'particulars', 'remarks', 'transactiondetails'],
  tranId: ['tranid', 'chqrefno', 'refno', 'referenceno', 'transactionid', 'chequerefno', 'utr'],
  deposit: ['deposit', 'depositamt', 'depositamount', 'credit', 'cramount', 'creditamount'],
  withdrawal: ['withdrawal', 'withdrawalamt', 'withdrawalamount', 'debit', 'dramount', 'debitamount'],
  balance: ['balance', 'closingbalance', 'runningbalance'],
};

const gwMethod = (v: string): PayMethod => {
  const s = v.toLowerCase();
  if (s.includes('upi')) return 'upi';
  if (s.includes('card') || s === 'emi') return 'card';
  if (s.includes('netbanking') || s.includes('net banking') || s === 'nb') return 'netbanking';
  if (s.includes('wallet')) return 'wallet';
  if (s.includes('cod') || s.includes('cash')) return 'cod';
  return 'other';
};

export function parseOrders(text: string, issues: ParseIssue[]): Order[] {
  const { headers, rows } = rowsOf(text);
  const g = makeGetter(headers, ORDER_ALIASES);
  for (const f of ['id', 'total', 'createdAt']) if (!g.has(f)) issues.push({ file: 'orders', message: `Missing column for "${f}" (e.g. ${ORDER_ALIASES[f as keyof typeof ORDER_ALIASES][0]})` });
  if (issues.some((i) => i.file === 'orders')) return [];
  // Shopify exports one row per line item; collapse rows sharing an order id.
  const byId = new Map<string, Order>();
  for (const row of rows) {
    const id = g.get(row, 'id');
    if (!id) continue;
    const existing = byId.get(id);
    const item = g.get(row, 'items');
    if (existing) { if (item) existing.items = existing.items ? `${existing.items} | ${item}` : item; continue; }
    const ts = parseDate(g.get(row, 'createdAt')) ?? 0;
    const methodText = g.get(row, 'method').toLowerCase();
    byId.set(id, {
      id, key: canonOrderKey(id), createdAt: fmtTs(ts), ts,
      customerName: g.get(row, 'name'), email: g.get(row, 'email').toLowerCase(), phone: phone10(g.get(row, 'phone')),
      items: item, total: money(g.get(row, 'total')),
      method: methodText.includes('cod') || methodText.includes('cash') ? 'cod' : 'other',
      checkout: g.get(row, 'method'),
      paymentReference: g.get(row, 'ref'), financialStatus: g.get(row, 'status').toLowerCase(),
      refundedAmount: money(g.get(row, 'refunded')),
    });
  }
  return [...byId.values()];
}

export function parseGateway(text: string, issues: ParseIssue[]): GatewayTxn[] {
  const { headers, rows } = rowsOf(text);
  const g = makeGetter(headers, GATEWAY_ALIASES);
  for (const f of ['id', 'type', 'amount']) if (!g.has(f)) issues.push({ file: 'gateway', message: `Missing column for "${f}"` });
  if (issues.some((i) => i.file === 'gateway')) return [];
  const out: GatewayTxn[] = [];
  for (const row of rows) {
    const type = g.get(row, 'type').toLowerCase();
    if (type !== 'payment' && type !== 'refund' && type !== 'adjustment') continue;
    const ts = parseDate(g.get(row, 'createdAt')) ?? 0;
    const amount = money(g.get(row, 'amount'));
    const fee = money(g.get(row, 'fee'));
    out.push({
      entityId: g.get(row, 'id'), type, amount, fee, tax: money(g.get(row, 'tax')),
      debit: g.has('debit') ? money(g.get(row, 'debit')) : type === 'payment' ? 0 : amount,
      credit: g.has('credit') ? money(g.get(row, 'credit')) : type === 'payment' ? r2(amount - fee) : 0,
      createdAt: fmtTs(ts), ts, settledAt: g.get(row, 'settledAt'), settlementId: g.get(row, 'settlementId'),
      settlementUtr: g.get(row, 'utr'), paymentId: g.get(row, 'paymentId'), method: gwMethod(g.get(row, 'method')),
      cardNetwork: g.get(row, 'network').toLowerCase(), orderReceipt: g.get(row, 'receipt'),
      email: g.get(row, 'email').toLowerCase(), contact: phone10(g.get(row, 'contact')),
      notes: g.get(row, 'notes'), description: g.get(row, 'description'),
    });
  }
  return out;
}

export function parseBank(text: string, issues: ParseIssue[]): BankTxn[] {
  const { headers, rows } = rowsOf(text);
  const g = makeGetter(headers, BANK_ALIASES);
  for (const f of ['date', 'narration', 'deposit']) if (!g.has(f)) issues.push({ file: 'bank', message: `Missing column for "${f}"` });
  if (issues.some((i) => i.file === 'bank')) return [];
  return rows.map((row, i) => {
    const ts = parseDate(g.get(row, 'date')) ?? 0;
    return {
      tranId: g.get(row, 'tranId') || `ROW-${i + 1}`,
      date: fmtTs(ts).slice(0, 10), ts, narration: g.get(row, 'narration'),
      deposit: money(g.get(row, 'deposit')), withdrawal: money(g.get(row, 'withdrawal')), balance: money(g.get(row, 'balance')),
    };
  });
}

export function parseDataset(files: { orders: string; gateway: string; bank: string }): { data: Dataset; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const data = {
    orders: parseOrders(files.orders, issues),
    gateway: parseGateway(files.gateway, issues),
    bank: parseBank(files.bank, issues),
  };
  return { data, issues };
}
