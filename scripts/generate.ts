// Writes the sample month to disk. The generator itself lives in src/engine/generate.ts so the
// browser can make new months too. Seeded: the output is identical on every run.
//   npm run generate              the published sample (seed 20260930)
//   npm run generate -- 123       a random month for seed 123 (overwrites the sample files)
import fs from 'node:fs';
import path from 'node:path';
import { generateMonth, SAMPLE_SEED } from '../src/engine/generate';

const seed = process.argv[2] ? Number(process.argv[2]) : SAMPLE_SEED;
const month = generateMonth(seed);

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'public/sample'), { recursive: true });
fs.mkdirSync(path.join(root, 'src/sample'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/sample/shopify_orders.csv'), month.files.orders);
fs.writeFileSync(path.join(root, 'public/sample/razorpay_settlement_report.csv'), month.files.gateway);
fs.writeFileSync(path.join(root, 'public/sample/bank_statement.csv'), month.files.bank);
fs.writeFileSync(path.join(root, 'src/sample/answer-key.json'), JSON.stringify(month.key, null, 2));

const { stats, key } = month;
console.log(`seed=${seed} layout=${month.layout}`);
console.log(`orders=${stats.orders} gateway_rows=${stats.gatewayRows} settlements=${stats.settlements} bank_rows=${stats.bankRows}`);
console.log('planted exceptions:', stats.planted);
console.log(`hard payments=${key.hard.payments.length} hard bank=${key.hard.bank.length}`);
