// why.html is static, so its numbers are copied by hand. This keeps them honest:
// each figure on the page must equal what the engine computes on the sample.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { evaluate } from '../src/engine/evaluate';
import type { AiRun, AnswerKey, ExceptionType, Mode } from '../src/engine/types';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});
const key: AnswerKey = JSON.parse(read('src/sample/answer-key.json'));
const aiRun: AiRun | null = JSON.parse(read('src/sample/ai-run.json'));
const html = read('why.html');

const inr = (n: number, dp = 0) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const cells = (label: string) => {
  const row = html.match(new RegExp(`<tr><td>${label.replace('+', '\\+')}</td>(.*?)</tr>`))?.[1] ?? '';
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
};

describe.skipIf(!aiRun)('why.html numbers', () => {
  const runs: Record<Mode, ReturnType<typeof reconcile>> = {
    rules: reconcile(data, { mode: 'rules' }),
    heuristic: reconcile(data, { mode: 'heuristic' }),
    ai: reconcile(data, { mode: 'ai', ai: aiRun?.decisions }),
  };
  const ai = runs.ai;
  const sum = (t: ExceptionType) => ai.exceptions.filter((e) => e.type === t).reduce((s, e) => s + e.amount, 0);
  const count = (t: ExceptionType) => ai.exceptions.filter((e) => e.type === t).length;

  it('ablation table matches the eval', () => {
    const rows: [Mode, string][] = [['rules', 'Exact rules'], ['heuristic', '+ Heuristics'], ['ai', '+ AI']];
    for (const [mode, label] of rows) {
      const e = evaluate(runs[mode], key);
      const [acc, wrong, fp, found] = cells(label);
      expect(acc).toBe(`${e.linkAccuracy}%`);
      expect(wrong).toBe(String(e.wrongLinks));
      expect(fp).toBe(String(e.exceptions.fp));
      expect(found).toBe(`${e.exceptions.tp} of ${e.exceptions.tp + e.exceptions.fn}`);
    }
    expect(cells('+ AI')[4]).toBe(`${runs.heuristic.pendingPackets.length} records, $${aiRun!.usage.costUsd.toFixed(4)}`);
  });

  it('stats and catches match the sample run', () => {
    const e = evaluate(ai, key);
    const has = (s: string) => expect(html).toContain(s);
    has(`<dd>${e.exceptions.tp} of ${e.exceptions.tp + e.exceptions.fn}</dd>`);
    has(`<dd>${inr(ai.money.atRisk)}</dd>`);
    has(`<dd>${inr(ai.money.owedToCustomers)}</dd>`);
    has(inr(sum('SETTLEMENT_NOT_IN_BANK'), 2));
    has(`>${inr(sum('REFUND_NOT_IN_GATEWAY'))}<`);
    has(`${count('REFUND_NOT_IN_GATEWAY')} orders as refunded`);
    has(`>${inr(sum('DUPLICATE_PAYMENT'))}<`);
    has(`${count('DUPLICATE_PAYMENT')} orders were paid twice`);
    has(inr(sum('FEE_OVERCHARGE'), 2));
    has(`${count('FEE_OVERCHARGE')} card payments`);
    has(`>${inr(sum('BANK_SHORT_CREDIT'))}<`);
    const peacock = ai.paymentLinks.find((l) => l.method === 'ai' && l.orderId === '#1100');
    expect(peacock?.orderId).toBe(key.orderPayment[peacock!.paymentId]);
  });
});
