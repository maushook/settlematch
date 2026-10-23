// Runs the AI stages once on the sample data and saves the results, so the public demo loads
// instantly and costs nothing per visitor.
//   ANTHROPIC_API_KEY=sk-... npm run precompute            matching (src/sample/ai-run.json), then drafts
//   ANTHROPIC_API_KEY=sk-... npm run precompute -- drafts  drafts only, using the existing ai-run.json
import fs from 'node:fs';
import path from 'node:path';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { callClaude, DEFAULT_MODEL } from '../src/engine/ai';
import { draftsForGroup } from '../src/engine/drafts';
import { polishDraft, type PolishResult } from '../src/engine/draft-ai';
import type { AiRun, RecException } from '../src/engine/types';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(1); }
const model = process.env.AI_MODEL || DEFAULT_MODEL;
const draftsOnly = process.argv[2] === 'drafts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});

let aiRun: AiRun | null = JSON.parse(read('src/sample/ai-run.json'));
if (!draftsOnly) {
  const packets = reconcile(data, { mode: 'heuristic' }).pendingPackets;
  console.log(`Sending ${packets.length} ambiguous records to ${model}...`);
  const out = await callClaude(packets, apiKey, model);
  aiRun = { ...out, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, 'src/sample/ai-run.json'), JSON.stringify(aiRun, null, 2));
  for (const d of out.decisions) console.log(`${d.id} -> ${d.match ?? 'null'} [${d.strength ?? d.confidence}] ${d.reason}`);
  console.log(`tokens in=${out.usage.inputTokens} out=${out.usage.outputTokens} cost=$${out.usage.costUsd.toFixed(5)} latency=${out.usage.latencyMs}ms`);
}

// Drafts for every exception group the sample shows by default (the AI mode, or heuristics if there is no AI run).
const r = aiRun ? reconcile(data, { mode: 'ai', ai: aiRun.decisions }) : reconcile(data, { mode: 'heuristic' });
const groups = new Map<string, RecException[]>();
for (const e of r.exceptions) groups.set(e.type, [...(groups.get(e.type) ?? []), e]);
const parts = [...groups.values()].flatMap(draftsForGroup);
console.log(`\nPolishing ${parts.length} drafts with ${model}...`);
const drafts: Record<string, { template: { subject: string; body: string }; result: PolishResult }> = {};
let cost = 0; let kept = 0;
for (const p of parts) {
  const result = await polishDraft({ audience: p.audience, subject: p.subject, body: p.body }, apiKey, model);
  cost += result.usage?.costUsd ?? 0;
  if (!result.polished) { kept++; console.log(`  ${p.id}: ${result.note}`); }
  drafts[p.id] = { template: { subject: p.subject, body: p.body }, result };
}
fs.writeFileSync(path.join(root, 'src/sample/ai-drafts.json'), JSON.stringify({ model, createdAt: new Date().toISOString(), costUsd: cost, drafts }, null, 2));
console.log(`${parts.length - kept} polished, ${kept} kept as template. cost=$${cost.toFixed(5)}`);
