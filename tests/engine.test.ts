import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { money, parseDataset, parseDate, parseOrders } from '../src/engine/normalize';
import { DEFAULT_CONTRACT, reconcile } from '../src/engine/reconcile';
import { evaluate } from '../src/engine/evaluate';
import { parseResponse } from '../src/engine/ai';
import type { AiDecision, AnswerKey } from '../src/engine/types';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data, issues } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});
const key: AnswerKey = JSON.parse(read('src/sample/answer-key.json'));

/** Perfect AI: answers every pending packet with the answer key. Tests the plumbing, not the model. */
function oracle(mode: 'right' | 'wrong-candidate' | 'low-confidence'): AiDecision[] {
  const r = reconcile(data, { mode: 'heuristic' });
  const bankTruth = Object.fromEntries(Object.entries(key.settlementBank).map(([s, t]) => [t, s]));
  return r.pendingPackets.map((p) => {
    const truth = p.kind === 'payment' ? key.orderPayment[p.id] : bankTruth[p.id];
    return {
      kind: p.kind, id: p.id,
      match: mode === 'wrong-candidate' ? 'not-a-candidate' : truth ?? null,
      confidence: mode === 'low-confidence' ? 0.3 : 0.95,
      reason: 'oracle',
    };
  });
}

describe('normalize', () => {
  it('parses the sample without issues', () => {
    expect(issues).toEqual([]);
    expect(data.orders).toHaveLength(300);
    expect(data.gateway.length).toBeGreaterThan(250);
  });
  it('parses common date and money formats', () => {
    expect(parseDate('2026-09-05 14:22:10 +0530')).toBe(Date.UTC(2026, 8, 5, 14, 22, 10));
    expect(parseDate('05/09/2026')).toBe(Date.UTC(2026, 8, 5));
    expect(parseDate('05-09-26')).toBe(Date.UTC(2026, 8, 5));
    expect(money('₹1,23,456.78')).toBe(123456.78);
    expect(money('(500.00)')).toBe(-500);
  });
  it('collapses Shopify multi-row line item exports', () => {
    const csv = 'Name,Total,Created at,Lineitem name\n#1,100,2026-09-01,A\n#1,,2026-09-01,B\n';
    const o = parseOrders(csv, []);
    expect(o).toHaveLength(1);
    expect(o[0].items).toBe('A | B');
    expect(o[0].total).toBe(100);
  });
});

describe('pipeline', () => {
  it('rules never link the wrong records and miss no planted problem', () => {
    const e = evaluate(reconcile(data, { mode: 'rules' }), key);
    expect(e.wrongLinks).toBe(0);
    expect(e.exceptions.recall).toBe(100);
  });

  it('heuristics only commit on strong evidence (no wrong links)', () => {
    const r = reconcile(data, { mode: 'heuristic' });
    const e = evaluate(r, key);
    expect(e.wrongLinks).toBe(0);
    expect(e.exceptions.recall).toBe(100);
    expect(r.pendingPackets.length).toBeGreaterThan(0);
  });

  it('with correct AI decisions every link and exception is exact', () => {
    const e = evaluate(reconcile(data, { mode: 'ai', ai: oracle('right') }), key);
    expect(e.linkAccuracy).toBe(100);
    expect(e.exceptions.precision).toBe(100);
    expect(e.exceptions.recall).toBe(100);
  });

  it('rejects AI answers that are off the candidate list or low confidence', () => {
    for (const m of ['wrong-candidate', 'low-confidence'] as const) {
      const r = reconcile(data, { mode: 'ai', ai: oracle(m) });
      expect(r.aiApplied).toHaveLength(0);
      expect(evaluate(r, key).wrongLinks).toBe(0);
    }
  });

  it('fee check follows the contract', () => {
    const base = reconcile(data, { mode: 'heuristic' }).exceptions.filter((x) => x.type === 'FEE_OVERCHARGE');
    expect(base).toHaveLength(9);
    const loose = reconcile(data, { mode: 'heuristic', contract: { ...DEFAULT_CONTRACT, card: 2.36 } });
    expect(loose.exceptions.filter((x) => x.type === 'FEE_OVERCHARGE')).toHaveLength(0);
  });

  it('money flow is internally consistent', () => {
    const m = reconcile(data, { mode: 'heuristic' }).money;
    expect(Math.abs(m.captured - m.fees - m.refunds - m.adjustments - m.netSettled)).toBeLessThan(0.05);
  });
});

describe('ai response parsing', () => {
  it('drops unknown ids and off-list matches, clamps confidence', () => {
    const packets = [{ kind: 'payment' as const, id: 'p1', fields: {}, candidates: [{ id: '#1', fields: {}, heuristicScore: 50 }] }];
    const json = { content: [{ type: 'tool_use', input: { decisions: [
      { kind: 'payment', id: 'p1', match: '#999', confidence: 7, reason: 'x' },
      { kind: 'payment', id: 'nope', match: '#1', confidence: 0.9, reason: 'x' },
    ] } }] };
    const d = parseResponse(json, packets);
    expect(d).toHaveLength(1);
    expect(d[0].match).toBeNull();
    expect(d[0].confidence).toBe(1);
  });
});
