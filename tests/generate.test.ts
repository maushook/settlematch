import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateMonth, SAMPLE_SEED } from '../src/engine/generate';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { evaluate } from '../src/engine/evaluate';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('generateMonth', () => {
  it('reproduces the published sample byte for byte from seed 20260930', () => {
    const m = generateMonth(SAMPLE_SEED);
    expect(m.layout).toBe('sample');
    expect(m.files.orders).toBe(read('public/sample/shopify_orders.csv'));
    expect(m.files.gateway).toBe(read('public/sample/razorpay_settlement_report.csv'));
    expect(m.files.bank).toBe(read('public/sample/bank_statement.csv'));
    expect(JSON.stringify(m.key, null, 2)).toBe(read('src/sample/answer-key.json'));
  });

  it('is deterministic per seed', () => {
    expect(generateMonth(42)).toEqual(generateMonth(42));
  });

  it('runs in the browser: no node imports', () => {
    expect(read('src/engine/generate.ts')).not.toMatch(/from ['"](node:|fs|path)/);
  });

  it('varies the month by seed', () => {
    const months = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => generateMonth(s));
    const orders = new Set(months.map((m) => m.stats.orders));
    expect(orders.size).toBeGreaterThan(4);
    for (const m of months) expect(m.stats.orders).toBeGreaterThanOrEqual(250);
    for (const m of months) expect(m.stats.orders).toBeLessThanOrEqual(400);
    const planted = new Set(months.map((m) => JSON.stringify(m.stats.planted)));
    expect(planted.size).toBe(months.length);
    const names = (m: ReturnType<typeof generateMonth>) => new Set(m.files.orders.split('\n').slice(1).map((l) => l.split(',').at(-1)));
    const a = names(months[0]), b = names(months[1]);
    expect([...a].filter((n) => b.has(n)).length).toBeLessThan(a.size / 2);
  });

  it('makes no wrong matches and misses no planted problem on random months', () => {
    for (let seed = 101; seed <= 120; seed++) {
      const m = generateMonth(seed);
      const { data, issues } = parseDataset(m.files);
      expect(issues).toEqual([]);
      for (const mode of ['rules', 'heuristic'] as const) {
        const e = evaluate(reconcile(data, { mode }), m.key);
        expect(e.wrongLinks, `seed ${seed} ${mode}`).toBe(0);
        expect(e.missed, `seed ${seed} ${mode}`).toEqual([]);
      }
    }
  });
});
