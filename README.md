# SettleMatch

**Shopify says one number. Your bank says another. SettleMatch explains the difference, rupee by rupee.**

Indian D2C sellers collect through a payment gateway, but the money that lands in the bank never equals the order total. Gateway fees, GST on fees, refunds, chargebacks and batched settlements break every match. Founders and their CAs reconcile this in Excel every month, and real leaks (overcharged fees, refunds never sent, settlements that never arrived) hide inside the noise.

SettleMatch takes three exports, reconciles them end to end, and returns every gap typed, sized in rupees and explained.

- **Live demo:** `https://<your-domain>` (click "Run on sample data")
- **Inputs:** Shopify orders export, Razorpay settlement report, bank statement (CSV)

## Results on the sample

The sample is synthetic (300 orders, 289 gateway rows, 36 bank lines) with 25 problems planted on purpose, so every stage can be scored against a known answer key.

| Stage | Records matched correctly | Wrong matches | False alarms | Planted problems found | Sent to AI |
|---|---|---|---|---|---|
| Exact rules | 94.4% | 0 | 34 | 25 of 25 | none |
| + Heuristics | 96.7% | 0 | 20 | 25 of 25 | none |
| + AI | 99.7% | 0 | 2 | 25 of 25 | 10 records, $0.0013 |

Reproduce with `npm run eval`. The app shows the same table live, and each column is clickable.

What the numbers say:
- **Rules are safe but noisy.** They never link the wrong records, but every payment they can't place shows up as two false alarms (an "unpaid" order and an "orphan" payment).
- **Heuristics take the clear cases and refuse the rest.** They commit only when a candidate scores at least 70 and leads the runner-up by 20. On the 10 hard payments the candidates tie, so heuristics abstain rather than guess.
- **AI only sees those 10 leftovers**, each with at most 5 candidates. Notes like "mor wala print" (Hindi for peacock), "paying for Laxmi aunty order" or "pymt agnst ord l226" need language and world knowledge, which is exactly where a model earns its cost. One call, a few thousand tokens, a fraction of a rupee.
- **The one miss is an abstention, not a wrong match.** For "gol design wali badi painting" three Mandala orders fit, so the model abstained and the payment went to human review instead of a guess. That single unplaced payment is both remaining false alarms.

## How it works

```
Shopify CSV ─┐
Razorpay CSV ┼─▶ 1 Normalize ─▶ 2 Rules: order↔payment ─▶ 3 Fee check ─▶ 4 Rules: settlement↔bank (UTR)
Bank CSV ────┘                                                                   │
                                              7 Exceptions ◀─ 6 AI (leftovers) ◀─ 5 Heuristics (scored)
```

1. **Normalize.** Column aliases, Indian date formats, ₹ and comma parsing, Shopify multi-row line items collapsed.
2. **Rules, order to payment.** Shopify payment reference, then gateway order receipt.
3. **Fee check.** Recomputes every fee from the contract (method and card network aware) plus 18% GST on the fee. The contract is editable in the UI and the overcharges update instantly.
4. **Rules, settlement to bank.** Aggregates gateway rows into settlements and finds each settlement's UTR in the bank narration.
5. **Heuristics.** Scores candidates on amount, date proximity, email, phone, order number, customer name and product tokens. Greedy, highest score first, and only commits on strong, unambiguous evidence.
6. **AI.** Claude Haiku receives only the unresolved records with their shortlists and must answer through a forced tool call (structured output). Answers are validated: a match must be one of the offered candidates, confidence must be at least 0.6, and no candidate can be claimed twice. Anything else falls back to human review.
7. **Exceptions.** Twelve types, each with severity, rupee amount, a plain-English explanation and evidence:

| Money at risk | Owed to customers | Needs review |
|---|---|---|
| Fee above contract | Customer charged twice | Payment with no order |
| Order paid, no payment in gateway | Refund promised, never sent | Refund not recorded in Shopify |
| Settlement never reached the bank | | Gateway credit with no settlement |
| Bank received less than settled | | Bank received more than settled |
| Collected less than order total | | |
| Chargeback deducted | | |

## Key decisions

- **Rules first, AI last.** Deterministic matching is free, instant and auditable. The AI sees 10 of 600+ records. Cost stays flat as volume grows because only ambiguity scales the AI bill.
- **Abstain over guess.** A wrong match in reconciliation is worse than no match: it hides two real problems. Every stage is tuned for zero wrong matches, and the tests enforce it.
- **Measured, not claimed.** The synthetic generator plants each problem with a known answer, so accuracy, false alarms and misses are computed, not estimated.
- **Privacy by default.** Parsing and matching run in the browser. Only the ambiguous records go to the AI, and only when the user clicks.
- **Cheap public demo.** The sample's AI results are precomputed, so reviewers get an instant result at zero cost. "Run the AI stage live" makes a real call, rate limited to 5 per minute per IP, with payload size and shape checks.

## Deliberately cut

- Login, saved runs and a database. Nothing in the core problem needs them.
- Live Razorpay and bank APIs. CSV exports are what sellers and CAs already have, and the engine is source-agnostic.
- Marketplaces (Amazon, Flipkart), COD remittances, TDS/TCS and GST return filing. Each is a new source with its own rules. They plug into the same pipeline as new normalizers and rules.
- Multi-currency and international settlements.

## Next

1. Marketplace settlement reports with TCS and TDS deductions.
2. COD remittance matching against courier reports.
3. Learning from human review: confirmed matches become new rules for that merchant.
4. Monthly close pack for the CA: exceptions export, GST on fees for input credit, journal entries.

## Run it

```bash
npm install
npm run dev          # local app at http://localhost:5173
npm test             # engine tests
npm run generate     # regenerate the synthetic sample + answer key
npm run eval         # print the ablation table
```

### Precompute the sample's AI stage

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run precompute   # writes src/sample/ai-run.json
npm run eval                                       # now includes the AI row
```

### Deploy to Cloudflare Workers

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Then add a custom domain under Workers & Pages > settlematch > Settings > Domains & Routes.

## Repo map

```
src/engine/normalize.ts   CSV parsing, column aliases, dates, money
src/engine/reconcile.ts   the 7-stage pipeline, scoring, exceptions, money summary
src/engine/ai.ts          prompt, tool schema, response validation, cost
src/engine/evaluate.ts    scoring against the answer key
src/App.tsx               UI
worker/index.ts           Cloudflare Worker: static assets + /api/resolve
scripts/generate.ts       synthetic data with planted problems
scripts/precompute.ts     one-off AI run for the sample
tests/engine.test.ts      pipeline guarantees (zero wrong matches, 100% recall, validation)
```

## Assumptions

- Gateway `fee` includes GST on the fee, and `tax` is the GST portion, as in Razorpay settlement reports.
- Default contract: 2% on UPI, domestic cards, netbanking and wallets, 3% on Amex and Diners. Edit it in the app to match yours.
- Settlements after the bank statement's last date are treated as in transit, not missing.
- All sample data is synthetic. No real customer or merchant data is used.
