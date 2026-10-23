/**
 * Synthetic month generator for SettleMatch. Pure: no fs or node imports, so it runs in the browser.
 *
 * Produces three realistic exports for a fictional D2C wall-art brand ("Kalakriti Home")
 * for September 2026, plus an answer key. Every problem in the data is planted on purpose,
 * so the right answer is known for every row and accuracy can be measured honestly.
 *
 * Two layouts:
 *   sample  the published sample month. Fixed counts and pairs; seed 20260930 reproduces
 *           public/sample/* and src/sample/answer-key.json byte for byte.
 *   random  everything varies by seed: order count, customers, product mix, how many of
 *           each problem are planted, and the wording of the hard payment notes, drawn
 *           from pools. Used by the "Generate a new month" button and scripts/robustness.ts.
 */
import type { AnswerKey, ExceptionType } from './types';

export const SAMPLE_SEED = 20260930;

export interface GenerateOptions {
  /** Defaults to 'sample' for SAMPLE_SEED and 'random' for every other seed. */
  layout?: 'sample' | 'random';
}

export interface GeneratedMonth {
  seed: number;
  layout: 'sample' | 'random';
  files: { orders: string; gateway: string; bank: string };
  key: AnswerKey;
  stats: { orders: number; gatewayRows: number; settlements: number; bankRows: number; planted: Record<string, number> };
}

// ---------- seeded RNG ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
const r2 = (x: number) => Math.round(x * 100) / 100;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ---------- catalogue ----------
interface Product { name: string; price: number; informal: string; pool?: string[] }

// The sample month's catalogue. Its informal descriptions are fixed so the sample stays byte-identical.
const SAMPLE_PRODUCTS: Product[] = [
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

// The wider catalogue for random months. Products share prices in groups, so a payment for one
// product has same-amount candidates for another, and only the description in the notes separates
// them. Each product has several informal descriptions: Hindi, Hinglish, English, a place or
// landmark, or what the artwork shows.
const CATALOGUE: Product[] = [
  { name: 'Mandala Canvas 24x36', price: 2499, informal: '', pool: ['gol design wali badi painting', 'round pattern wala big canvas', 'gol gol phool jaisa design', 'circle art wali painting'] },
  { name: 'Kerala Backwaters Canvas', price: 2499, informal: '', pool: ['houseboat wali canvas, green one', 'nariyal ke ped aur naav wali painting', 'Alleppey boat painting', 'green water and boat wala canvas'] },
  { name: 'Himalayan Peaks Canvas', price: 2499, informal: '', pool: ['pahad wali painting', 'snow mountain wala canvas', 'barf wale pahad, blue sky', 'Kedarnath side ka view wala'] },
  { name: 'Madhubani Peacock Print', price: 1799, informal: '', pool: ['mor wala print', 'nachta mor, Bihar style', 'blue bird with big feathers wala print', 'mor pankh wali painting'] },
  { name: 'Warli Harvest Frame', price: 1799, informal: '', pool: ['tribal stick figure wala frame', 'Maharashtra tribal art wala', 'white lines on brown, dancing log', 'stick people wala frame'] },
  { name: 'Lotus Pond Print', price: 1799, informal: '', pool: ['kamal wala print', 'pink flower in pond painting', 'kamal ke phool, paani wala', 'pink flowers on water'] },
  { name: 'Taj Sunset Panorama', price: 3499, informal: '', pool: ['Agra wali painting, evening colours', 'Taj Mahal shaam wala', 'white monument at sunset', 'Mumtaz wala mahal, orange sky'] },
  { name: 'Gold Leaf Abstract Trio', price: 3499, informal: '', pool: ['sone ki patti wala 3 piece', 'golden abstract teen wala set', 'gold foil 3 frame set', 'sunehri teen tukde wali painting'] },
  { name: 'Varanasi Ghats Canvas', price: 3499, informal: '', pool: ['Banaras ghat wali painting', 'Ganga aarti wala canvas', 'steps and diyas on the river', 'Kashi ke ghat, evening'] },
  { name: 'Buddha Meditation Canvas', price: 2799, informal: '', pool: ['dhyaan wali calm face', 'meditating monk canvas', 'aankhen band, shaant chehra', 'Bodh Gaya wale bhagwan'] },
  { name: 'Elephant Parade Canvas', price: 2799, informal: '', pool: ['haathi wali painting', 'colourful elephants walking', 'gajraj wala rangeen canvas', 'Mysore Dasara haathi'] },
  { name: 'Jaipur Doors Collage', price: 1999, informal: '', pool: ['rangeen darwaze wala collage', 'pink city doors print', 'purane darwaze, many colours'] },
  { name: 'Kathakali Face Print', price: 1999, informal: '', pool: ['Kerala dance face wala', 'hare chehre wala dancer print', 'green face dancer with crown'] },
  { name: 'Botanical Line Art Set', price: 1299, informal: '', pool: ['patti wali line drawing', 'leaf sketch set', 'minimal plant drawings'] },
  { name: 'One Line Faces Set', price: 1299, informal: '', pool: ['ek line wale chehre', 'single stroke face drawings', 'minimal face sketches'] },
  { name: 'Kolam Pattern Print', price: 999, informal: '', pool: ['rangoli jaisa white design', 'dots and loops wala', 'Pongal wala white pattern'] },
  { name: 'Chai Lovers Poster', price: 999, informal: '', pool: ['cutting chai poster', 'kulhad wala print', 'chai pe charcha wala'] },
];

const NOTE_SUFFIX = ['gift for didi', 'pls deliver before sunday', 'for new office', 'for living room', 'link from whatsapp', 'bday gift', 'for mummy', 'housewarming gift'];

// Formal name, the variant a payer writes, and how they refer to the customer.
const NAME_VARIANTS: [string, string][] = [
  ['Lakshmi', 'Laxmi'], ['Venkatesh', 'Venky'], ['Srinivasan', 'Srini'], ['Subramaniam', 'Subbu'],
  ['Mohammed', 'Mohd'], ['Jyoti', 'Jyothi'], ['Shweta', 'Sweta'], ['Prashant', 'Prasanth'],
  ['Rajendra', 'Raju'], ['Chandrashekhar', 'Chandu'], ['Vaishnavi', 'Vaishu'], ['Bhagyashree', 'Bhagya'],
  ['Gopalakrishnan', 'Gopal'], ['Parvathi', 'Paru'], ['Sanjeev', 'Sanjiv'], ['Kaveri', 'Cauvery'],
];
const NAME_NOTES = [
  (n: string) => `paying for ${n} aunty order`, (n: string) => `on behalf of ${n} sir`, (n: string) => `${n} didi ka order`,
  (n: string) => `for ${n} ji`, (n: string) => `${n} bhaiya asked me to pay`, (n: string) => `${n}'s order, paying from my account`,
];
const ORDER_NOTES = [
  (n: string) => `pymt agnst ord ${n}`, (n: string) => `order no ${n}`, (n: string) => `for order ${n}`,
  (n: string) => `ord ${n} payment`, (n: string) => `${n} wala order`,
];
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const HI_DIGITS = ['shunya', 'ek', 'do', 'teen', 'char', 'paanch', 'chhe', 'saat', 'aath', 'nau'];

const SAMPLE_FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Arjun', 'Meera', 'Kabir', 'Isha', 'Vikram', 'Divya', 'Rahul', 'Sneha', 'Aditya', 'Pooja', 'Nikhil', 'Kavya', 'Siddharth', 'Neha', 'Varun', 'Tanvi', 'Harish', 'Ritu', 'Manoj', 'Anjali', 'Suresh', 'Deepa', 'Gaurav', 'Swati', 'Rajesh', 'Nandini'];
const SAMPLE_LAST = ['Sharma', 'Patel', 'Menon', 'Gupta', 'Kapoor', 'Joshi', 'Pillai', 'Verma', 'Bose', 'Kulkarni', 'Chopra', 'Desai', 'Agarwal', 'Shetty', 'Banerjee', 'Malhotra', 'Hegde', 'Saxena', 'Chatterjee', 'Bhat'];
const MORE_FIRST = ['Farhan', 'Zoya', 'Imran', 'Ayesha', 'Gurpreet', 'Harleen', 'Jasmine', 'Joseph', 'Anil', 'Bindu', 'Chetan', 'Esha', 'Hemant', 'Ira', 'Kunal', 'Lata', 'Mihir', 'Naina', 'Omkar', 'Pallavi', 'Ravi', 'Sakshi', 'Tarun', 'Uma', 'Vivek', 'Yamini', 'Zubin', 'Arnav', 'Diya', 'Sameer'];
const MORE_LAST = ['Iyer', 'Reddy', 'Nair', 'Khan', 'Singh', 'Das', 'Mukherjee', 'Rao', 'Naidu', 'Kaur', 'Dsouza', 'Fernandes', 'Thakur', 'Mishra', 'Trivedi', 'Jain', 'Sethi', 'Ahmed', 'Gill', 'Pandey'];

// ---------- types ----------
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
  mismatchBy?: number;
  id?: string;
}
interface GRow {
  entity_id: string; type: string; debit: number; credit: number; amount: number; currency: string;
  fee: number; tax: number; on_hold: string; settled: string; created_at: string; settled_at: string;
  settlement_id: string; description: string; notes: string; payment_id: string; settlement_utr: string;
  order_id: string; order_receipt: string; method: string; card_network: string; email: string; contact: string;
  _ts: number;
}
interface Setl { id: string; utr: string; day: number; net: number; bank?: BRow }
interface BRow { _ts: number; narration: string; deposit: number; withdrawal: number; tranId?: string }

const csv = (rows: Record<string, unknown>[]) => {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};

export function generateMonth(seed: number, options: GenerateOptions = {}): GeneratedMonth {
  const layout = options.layout ?? (seed === SAMPLE_SEED ? 'sample' : 'random');
  const sample = layout === 'sample';
  const rnd = mulberry32(seed);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const chance = (p: number) => rnd() < p;
  const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const alnum = (n: number) => {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(rnd() * c.length)]; return s;
  };
  const digits = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += int(0, 9); return s; };

  const FIRST = sample ? SAMPLE_FIRST : [...SAMPLE_FIRST, ...MORE_FIRST];
  const LAST = sample ? SAMPLE_LAST : [...SAMPLE_LAST, ...MORE_LAST];
  let products: Product[] = SAMPLE_PRODUCTS;
  const P = (n: string) => products.find((p) => p.name.startsWith(n))!;
  const phone = () => `9${digits(9)}`;
  const emailOf = (f: string, l: string) => `${f}.${l}${int(1, 99)}@${pick(['gmail.com', 'yahoo.co.in', 'outlook.com', 'gmail.com'])}`.toLowerCase();

  const specs: Spec[] = [];
  const randTs = (fromDay = 1, toDay = 28) => D(2026, 9, int(fromDay, toDay), int(8, 22), int(0, 59), int(0, 59));
  const person = () => { const f = pick(FIRST), l = pick(LAST); return { first: f, last: l, email: emailOf(f, l), phone: phone() }; };
  const method = (): Spec['method'] => { const x = rnd(); return x < 0.58 ? 'upi' : x < 0.9 ? 'card' : 'netbanking'; };

  function normalSpec(kind: Kind = 'normal', m?: Spec['method']): Spec {
    const items = [pick(products)];
    if (chance(0.18)) items.push(pick(products));
    let total = items.reduce((s, i) => s + i.price, 0);
    if (chance(0.15)) total = Math.round(total * 0.9); // 10% coupon
    const mm = m ?? method();
    return { kind, ts: randTs(), ...person(), items: items.map(({ name, price }) => ({ name, price })), total, method: mm,
      network: mm === 'card' ? (chance(0.12) ? 'amex' : pick(['visa', 'mastercard', 'rupay'])) : '' };
  }

  // Hard pairs: payment-link orders with no references; same amount, same week.
  function pairSpecs(prodA: Product, prodB: Product, day: number,
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

  let orderTarget = 300;
  let codCount = 21;

  if (sample) {
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
      (n) => `order no ${n.split('').map((d) => EN_DIGITS[+d]).join(' ')}`, 'hard');
    // Easy: clean order number / full name / email in the payment record
    pairSpecs(P('Buddha'), P('Buddha'), 11, person(), person(),
      (n) => `Payment for order #${n}`, () => '', 'easy');
    pairSpecs(P('Jaipur'), P('Jaipur'), 24, person(), person(),
      () => 'payment link', () => 'payment link', 'easy');

    // Orders marked paid in Shopify but the payment never reached the gateway.
    for (let i = 0; i < 3; i++) {
      const s = normalSpec('missingPayment', 'upi');
      if (i === 0) { s.items = [{ name: P('Mandala').name, price: 2499 }]; s.total = 2499; s.ts = D(2026, 9, 5, 13, 12, 0); } // decoy for a hard pair
      specs.push(s);
    }
    for (let i = 0; i < 2; i++) specs.push(normalSpec('duplicate', 'upi'));
    for (let i = 0; i < 2; i++) { const s = normalSpec('mismatch', 'card'); s.network = 'visa'; specs.push(s); }
    for (let i = 0; i < 8; i++) specs.push(normalSpec('refund'));
    for (let i = 0; i < 3; i++) specs.push(normalSpec('refundNotInGateway'));
    for (let i = 0; i < 2; i++) specs.push(normalSpec('unrecordedRefund'));
    { const s = normalSpec('chargeback', 'card'); s.network = 'visa'; specs.push(s); }
    for (let i = 0; i < 9; i++) { const s = normalSpec('overcharge', 'card'); s.network = pick(['visa', 'mastercard']); specs.push(s); }
  } else {
    // Product mix: 2 to 4 same-price groups for description pairs, plus some other products.
    const byPrice = new Map<number, Product[]>();
    for (const p of CATALOGUE) byPrice.set(p.price, [...(byPrice.get(p.price) ?? []), p]);
    const groups = shuffle([...byPrice.values()]).slice(0, int(2, 4)).map((g) => shuffle(g).slice(0, int(2, g.length)));
    const chosen = new Set(groups.flat());
    for (const p of shuffle(CATALOGUE.filter((x) => !chosen.has(x))).slice(0, int(2, 6))) chosen.add(p);
    products = CATALOGUE.filter((p) => chosen.has(p));
    orderTarget = int(250, 400);
    codCount = Math.round(orderTarget * (0.04 + rnd() * 0.06));

    const describe = (p: Product) => {
      const base = pick(p.pool!);
      return chance(0.6) ? `${base}${pick([', ', ' - ', ' '])}${pick(NOTE_SUFFIX)}` : base;
    };
    const used = new Set<string>();
    const hardDay = () => int(2, 25);
    const pairsAt: { prod: Product; day: number }[] = [];

    // Hard: informal product descriptions (same price, different products)
    for (const g of groups.slice(0, int(0, groups.length))) {
      const [a, b] = shuffle(g); const day = hardDay();
      pairSpecs(a, b, day, person(), person(), () => describe(a), () => describe(b), 'hard');
      pairsAt.push({ prod: a, day });
    }
    // Hard: same product, one buyer named by a spelling variant or nickname
    for (let i = int(0, 3); i > 0; i--) {
      const [formal, variant] = pick(NAME_VARIANTS.filter(([f]) => !used.has(f)));
      used.add(formal);
      const prod = pick(products); const day = hardDay();
      let other = person();
      while (other.first === formal) other = person();
      const named = { first: formal, last: pick(LAST) };
      const [first, second] = chance(0.5) ? [named, other] : [other, named];
      const note = () => pick(NAME_NOTES)(variant);
      const plain = () => (chance(0.5) ? 'payment link' : pick(NOTE_SUFFIX));
      pairSpecs(prod, prod, day, first, second, first === named ? note : plain, first === named ? plain : note, 'hard');
      pairsAt.push({ prod, day });
    }
    // Hard: order number obfuscated: letters for digits, spelled out in English or Hindi, spaced, or partial
    const obfuscate = (n: string) => {
      const how = pick(['letters', 'english', 'hindi', 'spaced', 'partial'] as const);
      if (how === 'letters') return n.replace(/0/g, 'O').replace(/1/g, pick(['l', 'I'])).replace(/5/g, 'S').replace(/8/g, 'B');
      if (how === 'english') return n.split('').map((d) => EN_DIGITS[+d]).join(' ');
      if (how === 'hindi') return n.split('').map((d) => HI_DIGITS[+d]).join(' ');
      if (how === 'spaced') return n.split('').join(' ');
      return `ending ${n.slice(-2)}`;
    };
    for (let i = int(0, 3); i > 0; i--) {
      const prod = pick(products); const day = hardDay();
      const ways = [obfuscate, obfuscate].map((f) => { const tpl = pick(ORDER_NOTES); return (n: string) => tpl(f(n)); });
      pairSpecs(prod, prod, day, person(), person(), ways[0], ways[1], 'hard');
      pairsAt.push({ prod, day });
    }
    // Easy: clean order number, full name, or the customer's own email and phone
    for (let i = int(0, 3); i > 0; i--) {
      const prod = pick(products);
      if (chance(0.5)) pairSpecs(prod, prod, hardDay(), person(), person(), (n) => `Payment for order #${n}`, () => '', 'easy');
      else pairSpecs(prod, prod, hardDay(), person(), person(), () => 'payment link', () => 'payment link', 'easy');
    }

    // Orders marked paid with no gateway payment. Some are decoys: same product and amount as a hard pair, a day later.
    for (let i = int(0, 4); i > 0; i--) {
      const s = normalSpec('missingPayment', 'upi');
      if (pairsAt.length && chance(0.5)) {
        const { prod, day } = pick(pairsAt);
        s.items = [{ name: prod.name, price: prod.price }]; s.total = prod.price;
        s.ts = D(2026, 9, Math.min(day + 1, 28), int(9, 21), int(0, 59), 0);
      }
      specs.push(s);
    }
    for (let i = int(0, 3); i > 0; i--) specs.push(normalSpec('duplicate', 'upi'));
    for (let i = int(0, 3); i > 0; i--) { const s = normalSpec('mismatch', 'card'); s.network = pick(['visa', 'mastercard']); s.mismatchBy = pick([100, 150, 200, 250, 500]); specs.push(s); }
    for (let i = int(2, 12); i > 0; i--) specs.push(normalSpec('refund'));
    for (let i = int(0, 4); i > 0; i--) specs.push(normalSpec('refundNotInGateway'));
    for (let i = int(0, 3); i > 0; i--) specs.push(normalSpec('unrecordedRefund'));
    for (let i = int(0, 2); i > 0; i--) { const s = normalSpec('chargeback', 'card'); s.network = pick(['visa', 'mastercard']); specs.push(s); }
    for (let i = int(0, 12); i > 0; i--) { const s = normalSpec('overcharge', 'card'); s.network = pick(['visa', 'mastercard']); specs.push(s); }
  }
  // COD + normal fill
  for (let i = 0; i < codCount; i++) specs.push(normalSpec('cod', 'cod'));
  while (specs.length < orderTarget) specs.push(normalSpec('normal'));

  // Assign order numbers in time order
  specs.sort((a, b) => a.ts - b.ts);
  specs.forEach((s, i) => { s.id = `#${1001 + i}`; });

  // ---------- gateway rows ----------
  const gateway: GRow[] = [];
  const key: AnswerKey = { orderPayment: {}, settlementBank: {}, exceptions: [], hard: { payments: [], bank: [] } };
  const exc = (type: ExceptionType, k: string) => key.exceptions.push({ type, key: k });

  const CONTRACT = { upi: 2, card: 2, amex: 3, netbanking: 2 };
  const feeFor = (amount: number, m: string, net: string, pct?: number) => {
    const rate = pct ?? (m === 'card' && net === 'amex' ? CONTRACT.amex : (CONTRACT as Record<string, number>)[m] ?? 2);
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
        const pid = addPayment(s, { amount: s.total - (s.mismatchBy ?? 200) }); paymentReference = pid;
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
  const settlements: Setl[] = [];
  for (const [day, rows] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const id = `setl_${alnum(14)}`; const utr = `YESBN${digits(11)}`;
    const at = fmt(day + 10 * 3600000 + int(0, 50) * 60000);
    let net = 0;
    for (const r of rows) { r.settlement_id = id; r.settlement_utr = utr; r.settled_at = at; net += r.credit - r.debit; }
    settlements.push({ id, utr, day, net: r2(net) });
  }

  // ---------- bank statement ----------
  // Which settlements get a bank-side problem.
  let missingInBank: Setl[]; let shortCredits: Map<Setl, number>; let noUtr: Setl[]; let postedLate: Setl | null;
  if (sample) {
    const midIdx = Math.floor(settlements.length / 2);
    missingInBank = [settlements[midIdx]];
    shortCredits = new Map([[settlements[midIdx - 6], 1250]]);
    noUtr = [settlements[4], settlements[midIdx + 3], settlements[settlements.length - 4]];
    postedLate = noUtr[1];
  } else {
    // Keep the first and last two settlements clean so a late posting stays inside the statement.
    const pool = shuffle(settlements.slice(1, -2));
    missingInBank = pool.splice(0, int(0, 2));
    shortCredits = new Map(pool.splice(0, int(0, 2)).map((s) => [s, pick([500, 750, 1250, 2000, r2(int(100, 3000) + rnd())])]));
    noUtr = pool.splice(0, int(0, 4));
    postedLate = noUtr.length && chance(0.6) ? pick(noUtr) : null;
  }
  const bank: BRow[] = [];
  const fmtNarr = [
    (u: string) => `NEFT CR-YESB0000001-RAZORPAY SOFTWARE PRIVATE LIMITED-KALAKRITI HOME-${u}`,
    (u: string) => `NEFT/${u}/RAZORPAY SOFTWARE PVT LTD/SETTLEMENT`,
    (u: string) => `IMPS-${u}-RAZORPAY SOFTWA`,
  ];
  for (const s of settlements) {
    if (missingInBank.includes(s)) { exc('SETTLEMENT_NOT_IN_BANK', s.id); continue; }
    const bt: BRow = { _ts: s.day + 11 * 3600000, narration: pick(fmtNarr)(s.utr), deposit: s.net, withdrawal: 0 };
    const short = shortCredits.get(s);
    if (short) { bt.deposit = r2(s.net - short); exc('BANK_SHORT_CREDIT', s.id); }
    if (noUtr.includes(s)) {
      const d = new Date(s.day);
      bt.narration = `BY TRANSFER-RAZORPAY SOFTWARE PVT-SETL ${pad(d.getUTCDate())}${MON[d.getUTCMonth()]}`;
      if (s === postedLate) bt._ts += DAY; // bank posted a day late
    }
    bank.push(bt);
    s.bank = bt;
  }
  // Unknown gateway credits (UTR not in the settlement report)
  const unknowns: BRow[] = sample
    ? [{ _ts: D(2026, 9, 17, 11), narration: fmtNarr[0](`YESBN${digits(11)}`), deposit: 4318.62, withdrawal: 0 }]
    : Array.from({ length: int(0, 2) }, () => ({ _ts: D(2026, 9, int(3, 27), 11), narration: pick(fmtNarr)(`YESBN${digits(11)}`), deposit: r2(int(1500, 9000) + rnd()), withdrawal: 0 }));
  bank.push(...unknowns);
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
  let bal = sample ? 342118.55 : r2(int(150000, 600000) + rnd());
  const bankRows = bank.map((b) => {
    b.tranId = `S${digits(8)}`;
    bal = r2(bal + b.deposit - b.withdrawal);
    return {
      'Date': fmtBankDate(b._ts), 'Narration': b.narration, 'Tran Id': b.tranId, 'Value Date': fmtBankDate(b._ts),
      'Withdrawal': b.withdrawal ? b.withdrawal.toFixed(2) : '', 'Deposit': b.deposit ? b.deposit.toFixed(2) : '',
      'Balance': bal.toFixed(2),
    };
  });
  for (const s of settlements) if (s.bank) key.settlementBank[s.id] = s.bank.tranId!;
  for (const s of noUtr) key.hard.bank.push(s.bank!.tranId!);
  for (const u of unknowns) exc('UNKNOWN_GATEWAY_CREDIT', u.tranId!);

  const planted = key.exceptions.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
  return {
    seed, layout,
    files: {
      orders: csv(orderRows),
      gateway: csv(gateway.map(({ _ts, ...g }) => { void _ts; return g; })),
      bank: csv(bankRows),
    },
    key,
    stats: { orders: orderRows.length, gatewayRows: gateway.length, settlements: settlements.length, bankRows: bankRows.length, planted },
  };
}
