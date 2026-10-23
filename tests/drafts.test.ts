import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { generateMonth } from '../src/engine/generate';
import { checkFacts, draftsForGroup, exceptionsCsv, SUGGESTED_ACTION } from '../src/engine/drafts';
import { acceptPolish } from '../src/engine/draft-ai';
import type { AiRun, RecException } from '../src/engine/types';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});
const aiRun: AiRun | null = JSON.parse(read('src/sample/ai-run.json'));
const groupsOf = (list: RecException[]) => {
  const m = new Map<string, RecException[]>();
  for (const e of list) m.set(e.type, [...(m.get(e.type) ?? []), e]);
  return [...m.values()];
};
const reply = (input: object) => ({ content: [{ type: 'tool_use', input }] });

describe('draft templates', () => {
  const lists = [
    reconcile(data, { mode: 'rules' }).exceptions,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => reconcile(parseDataset(generateMonth(s).files).data, { mode: 'rules' }).exceptions),
  ];

  it('drafts every exception type that appears, with no missing values', () => {
    const seen = new Set<string>();
    for (const list of lists) {
      for (const group of groupsOf(list)) {
        const parts = draftsForGroup(group);
        expect(parts.length, group[0].type).toBeGreaterThan(0);
        seen.add(group[0].type);
        for (const p of parts) {
          const text = `${p.subject}\n${p.body}`;
          expect(text, p.id).not.toMatch(/undefined|NaN|null|\[object/);
          expect(text, p.id).not.toContain('\u2014');
        }
        // Each exception is named in its group's drafts.
        const all = parts.map((p) => p.body + p.subject).join('\n');
        for (const e of group) expect(all, e.key).toContain(e.key);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('builds one fee ticket for the whole group, with the total', () => {
    const fees = reconcile(data, { mode: 'rules' }).exceptions.filter((e) => e.type === 'FEE_OVERCHARGE');
    const parts = draftsForGroup(fees);
    expect(parts).toHaveLength(1);
    const total = fees.reduce((s, e) => s + e.amount, 0);
    expect(parts[0].body).toContain(`Total charged above contract: ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  });

  it('gives duplicate payments and missing refunds a customer message and a refund instruction', () => {
    const list = reconcile(data, { mode: 'rules' }).exceptions;
    for (const type of ['DUPLICATE_PAYMENT', 'REFUND_NOT_IN_GATEWAY']) {
      const parts = draftsForGroup(list.filter((e) => e.type === type).slice(0, 1));
      expect(parts.map((p) => p.audience)).toEqual(['customer', 'internal']);
    }
  });

  it('uses placeholders for what the engine cannot know', () => {
    const s = reconcile(data, { mode: 'rules' }).exceptions.find((e) => e.type === 'SETTLEMENT_NOT_IN_BANK')!;
    expect(draftsForGroup([s])[0].body).toContain('[merchant ID]');
  });
});

describe('fact guard', () => {
  const template = {
    audience: 'gateway' as const,
    subject: 'Settlement setl_ABC123def not received',
    body: 'Settlement setl_ABC123def for ₹6,832.84, settled on 2026-09-17 with UTR YESBN19288488322, is missing.\nMerchant ID: [merchant ID]',
  };

  it('rejects a hallucinated amount and keeps the template', () => {
    const r = acceptPolish(template, reply({ ...template, body: template.body.replace('is missing.', 'is missing, along with ₹4,999.00 from last week.') }));
    expect(r.polished).toBe(false);
    expect(r.body).toBe(template.body);
    expect(r.note).toMatch(/Kept the factual template/);
    expect(r.note).toContain('4999');
  });

  it('rejects a changed UTR, a new id and a new date', () => {
    expect(checkFacts(template, { ...template, body: template.body.replace('YESBN19288488322', 'YESBN19288488323') }).ok).toBe(false);
    expect(checkFacts(template, { ...template, body: `${template.body}\nSee also pay_Zz9999xx.` }).ok).toBe(false);
    expect(checkFacts(template, { ...template, body: `${template.body}\nPlease reply by 2026-10-05.` }).ok).toBe(false);
  });

  it('rejects a rewrite that drops a placeholder', () => {
    const r = acceptPolish(template, reply({ ...template, body: template.body.replace('\nMerchant ID: [merchant ID]', '') }));
    expect(r.polished).toBe(false);
  });

  it('accepts a faithful rewrite, including dates in words and numbered steps', () => {
    const body = 'Hello,\n\nOur settlement setl_ABC123def of ₹6,832.84 (UTR YESBN19288488322), settled on 17 September 2026, has not reached us.\n1. Please confirm the status.\n2. Share the bank reference.\nMerchant ID: [merchant ID]';
    const r = acceptPolish(template, reply({ audience: 'gateway', subject: template.subject, body }));
    expect(r.polished).toBe(true);
  });

  it('replaces em dashes in AI output', () => {
    const r = acceptPolish(template, reply({ ...template, body: template.body.replace('is missing.', 'is missing \u2014 please check.') }));
    expect(r.body).not.toContain('\u2014');
  });
});

describe('precomputed sample drafts', () => {
  it('cover every draft the sample shows, match its templates and pass the guard', () => {
    const pre = JSON.parse(read('src/sample/ai-drafts.json')).drafts;
    const list = reconcile(data, aiRun ? { mode: 'ai', ai: aiRun.decisions } : { mode: 'heuristic' }).exceptions;
    for (const p of groupsOf(list).flatMap(draftsForGroup)) {
      const d = pre[p.id];
      expect(d, p.id).toBeDefined();
      expect(d.template).toEqual({ subject: p.subject, body: p.body });
      if (d.result.polished) expect(checkFacts(p, d.result).ok, p.id).toBe(true);
    }
  });
});

describe('exceptions CSV', () => {
  it('has one row per exception with a suggested action', () => {
    const list = reconcile(data, { mode: 'rules' }).exceptions;
    const lines = exceptionsCsv(list).trim().split('\n');
    expect(lines[0]).toBe('type,severity,key,amount,explanation,evidence,suggested action');
    expect(lines).toHaveLength(list.length + 1);
    expect(lines[1]).toContain(SUGGESTED_ACTION[list[0].type]);
  });
});
