// Runs the AI stage once on the sample data and saves the result to src/sample/ai-run.json,
// so the public demo loads instantly and costs nothing per visitor.
//   ANTHROPIC_API_KEY=sk-... npm run precompute
import fs from 'node:fs';
import path from 'node:path';
import { parseDataset } from '../src/engine/normalize';
import { reconcile } from '../src/engine/reconcile';
import { callClaude, DEFAULT_MODEL } from '../src/engine/ai';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(1); }

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { data } = parseDataset({
  orders: read('public/sample/shopify_orders.csv'),
  gateway: read('public/sample/razorpay_settlement_report.csv'),
  bank: read('public/sample/bank_statement.csv'),
});
const packets = reconcile(data, { mode: 'heuristic' }).pendingPackets;
console.log(`Sending ${packets.length} ambiguous records to ${process.env.AI_MODEL || DEFAULT_MODEL}...`);
const out = await callClaude(packets, apiKey, process.env.AI_MODEL || DEFAULT_MODEL);
fs.writeFileSync(path.join(root, 'src/sample/ai-run.json'), JSON.stringify({ ...out, createdAt: new Date().toISOString() }, null, 2));
for (const d of out.decisions) console.log(`${d.id} -> ${d.match ?? 'null'} [${d.strength ?? d.confidence}] ${d.reason}`);
console.log(`tokens in=${out.usage.inputTokens} out=${out.usage.outputTokens} cost=$${out.usage.costUsd.toFixed(5)} latency=${out.usage.latencyMs}ms`);
