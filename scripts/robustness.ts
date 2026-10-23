// Runs the engine on many random months and scores each against its own answer key, to show the
// results are not tuned to the one published sample.
//   npm run robustness                      50 seeds, rules and heuristics
//   ANTHROPIC_API_KEY=... npm run robustness  also runs the AI stage on the first 10 seeds
//   SEEDS=100 AI_SEEDS=5 npm run robustness   change the counts
import { generateMonth } from '../src/engine/generate';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { evaluate, type EvalResult } from '../src/engine/evaluate';
import { callClaude, DEFAULT_MODEL } from '../src/engine/ai';
import type { Mode } from '../src/engine/types';

const SEEDS = Number(process.env.SEEDS ?? 50);
const AI_SEEDS = Number(process.env.AI_SEEDS ?? 10);
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.AI_MODEL || DEFAULT_MODEL;
const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

type Row = { seed: number; e: EvalResult; orders: number; planted: number; pending: number };
const results: Record<Mode, Row[]> = { rules: [], heuristic: [], ai: [] };
const problems: string[] = [];
const leftForReview: string[] = [];
let aiCost = 0;

for (const seed of seeds) {
  const month = generateMonth(seed, { layout: 'random' });
  const { data, issues } = parseDataset(month.files);
  if (issues.length) { console.error(`seed ${seed}: parse issues`, issues); process.exit(1); }
  const base = { orders: month.stats.orders, planted: month.key.exceptions.length };
  const runs: [Mode, ReturnType<typeof reconcile>][] = [
    ['rules', reconcile(data, { mode: 'rules' })],
    ['heuristic', reconcile(data, { mode: 'heuristic' })],
  ];
  const pending = runs[1][1].pendingPackets;
  if (apiKey && seed <= AI_SEEDS) {
    const out = pending.length ? await callClaude(pending, apiKey, model) : { decisions: [], usage: { costUsd: 0 } };
    aiCost += out.usage.costUsd;
    const r = reconcile(data, { mode: 'ai', ai: out.decisions });
    const applied = new Set(r.aiApplied.map((d) => d.id));
    for (const p of pending) if (!applied.has(p.id)) leftForReview.push(`seed ${seed} ${p.kind} ${p.id}: "${p.fields.notes ?? p.fields.narration ?? ''}"`);
    runs.push(['ai', r]);
  }
  for (const [mode, r] of runs) {
    const e = evaluate(r, month.key);
    results[mode].push({ seed, e, ...base, pending: pending.length });
    if (e.wrongLinks) problems.push(`seed ${seed} ${mode}: ${e.wrongLinks} wrong match(es)`);
    if (e.missed.length) problems.push(`seed ${seed} ${mode}: missed ${e.missed.join(', ')}`);
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
const fmt = (x: number) => x.toFixed(1);

const all = results.heuristic;
console.log(`${SEEDS} random months: ${Math.min(...all.map((r) => r.orders))} to ${Math.max(...all.map((r) => r.orders))} orders, ` +
  `${Math.min(...all.map((r) => r.planted))} to ${Math.max(...all.map((r) => r.planted))} planted problems each, ` +
  `${sum(all.map((r) => r.planted))} in total.\n`);
console.log('| Stage | Months | Link accuracy, mean (min to max) | Wrong matches | Exception precision | Exception recall | Hard cases solved | Sent to AI |');
console.log('|---|---|---|---|---|---|---|---|');
const label: Record<Mode, string> = { rules: 'Exact rules', heuristic: '+ Heuristics', ai: '+ AI' };
for (const mode of ['rules', 'heuristic', 'ai'] as Mode[]) {
  const rows = results[mode];
  if (!rows.length) continue;
  const acc = rows.map((r) => r.e.linkAccuracy);
  const tp = sum(rows.map((r) => r.e.exceptions.tp)), fp = sum(rows.map((r) => r.e.exceptions.fp)), fn = sum(rows.map((r) => r.e.exceptions.fn));
  const hard = `${sum(rows.map((r) => r.e.hard.correct))} of ${sum(rows.map((r) => r.e.hard.total))}`;
  const sent = mode === 'ai' ? `${sum(rows.map((r) => r.pending))} records, $${aiCost.toFixed(4)}` : 'none';
  console.log(`| ${label[mode]} | ${rows.length} | ${fmt(sum(acc) / acc.length)}% (${fmt(Math.min(...acc))} to ${fmt(Math.max(...acc))}) | ` +
    `${sum(rows.map((r) => r.e.wrongLinks))} | ${pct(tp, tp + fp)}% | ${pct(tp, tp + fn)}% | ${hard} | ${sent} |`);
}
if (results.ai.length) {
  const sub = results.heuristic.filter((r) => r.seed <= AI_SEEDS);
  const acc = sub.map((r) => r.e.linkAccuracy);
  console.log(`\nHeuristics on the same ${sub.length} AI seeds: link accuracy ${fmt(sum(acc) / acc.length)}% mean. AI model: ${model}.`);
  console.log(`AI left ${leftForReview.length} of ${sum(results.ai.map((r) => r.pending))} records for human review:\n${leftForReview.join('\n')}`);
} else {
  console.log('\nAI stage skipped: set ANTHROPIC_API_KEY to include it.');
}
console.log(problems.length ? `\nIssues:\n${problems.join('\n')}` : '\nNo wrong matches and no missed problems in any month.');
