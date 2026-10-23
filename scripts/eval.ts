// Prints the ablation table: exact rules vs + heuristics vs + AI, scored against the answer key.
import fs from 'node:fs';
import path from 'node:path';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { evaluate } from '../src/engine/evaluate';
import type { AiRun, AnswerKey, ReconResult } from '../src/engine/types';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data, issues } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});
if (issues.length) { console.error(issues); process.exit(1); }
const key: AnswerKey = JSON.parse(read('src/sample/answer-key.json'));
const aiRun: AiRun | null = JSON.parse(read('src/sample/ai-run.json'));

const rows: [string, ReconResult][] = [
  ['rules', reconcile(data, { mode: 'rules' })],
  ['heuristic', reconcile(data, { mode: 'heuristic' })],
];
if (aiRun) rows.push(['ai', reconcile(data, { mode: 'ai', ai: aiRun.decisions })]);

for (const [name, r] of rows) {
  const e = evaluate(r, key);
  console.log(`\n== ${name} (${r.runtimeMs} ms)`);
  console.log(`links ${e.linkAccuracy}%  wrong=${e.wrongLinks}  hard ${e.hard.correct}/${e.hard.total}`);
  console.log(`exceptions precision ${e.exceptions.precision}%  recall ${e.exceptions.recall}%  (tp ${e.exceptions.tp}, fp ${e.exceptions.fp}, fn ${e.exceptions.fn})`);
  console.log(`money atRisk=${r.money.atRisk} owed=${r.money.owedToCustomers} review=${r.money.reviewCount}  pending AI packets=${r.pendingPackets.length}`);
  if (e.falseAlarms.length) console.log('false alarms:', e.falseAlarms.join(', '));
  if (e.missed.length) console.log('missed:', e.missed.join(', '));
}
