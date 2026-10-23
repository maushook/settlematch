# SettleMatch

**Shopify says one number. Your bank says another. SettleMatch explains the difference, rupee by rupee.**

Indian D2C sellers collect through a payment gateway, but the money that lands in the bank never equals the order total. Gateway fees, GST on fees, refunds, chargebacks and batched settlements break every match. Founders and their CAs reconcile this in Excel every month, and real leaks (overcharged fees, refunds never sent, settlements that never arrived) hide inside the noise.

SettleMatch takes three exports, reconciles them end to end, and returns every gap typed, sized in rupees and explained.

- **Live demo:** https://maushook.com/settlematch/ (click "Run on sample data")
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

## Robustness across random months

The same author wrote the sample generator and the engine, so a fair question is whether the 99.7% is tuned to one month. To check, `generateMonth(seed)` in `src/engine/generate.ts` builds a new month for any seed: 250 to 400 orders, different customers and product mix, between zero and a few of each planted problem, and hard payment notes drawn from pools. The pools hold several informal descriptions per product (Hindi, Hinglish, English, a landmark or what the artwork shows), 16 nickname and spelling-variant pairs, and order numbers written with letters for digits, spelled out in English or Hindi, spaced out, or given only as the last two digits. Heuristic thresholds and the AI prompt were not changed for any seed.

| Stage | Months | Link accuracy, mean (min to max) | Wrong matches | Exception precision | Exception recall | Hard cases solved | Sent to AI |
|---|---|---|---|---|---|---|---|
| Exact rules | 50 | 95.6% (91.1 to 100.0) | 0 | 40.1% | 100% | 0 of 682 | none |
| + Heuristics | 50 | 97.2% (94.3 to 100.0) | 0 | 50.6% | 100% | 235 of 682 | none |
| + AI | 10 | 99.2% (98.3 to 100.0) | 0 | 79.8% | 100% | 110 of 136 | 84 records, $0.0118 |

Seeds 1 to 50, with 257 to 398 orders and 7 to 26 planted problems per month (914 in total). The AI row covers seeds 1 to 10 with claude-haiku-5-5; heuristics alone average 97.4% on those same 10 months.

What the numbers say:
- **No stage made a wrong match in any month, and no planted problem was missed.** The zero on the sample is not a one-off.
- **The AI left 26 of 84 records for human review.** 12 had notes with no identifying detail ("payment link", "gift for didi"). In 4 the clue fit more than one candidate, for example "hare chehre wala dancer print" with three Kathakali Face Print orders of the same amount. In the other 10 the clue pointed to one candidate and the model still abstained, for example "for Subbu ji" and "blue bird with big feathers wala print". Those are lost matches, not wrong ones: each goes to review.
- **Exception precision is lower than on the sample** because each payment left for review shows up as two false alarms, an unpaid order and an orphan payment.
- **Limits.** Every month is still September 2026 with the same bank noise lines, and the random layout was written by the same author, so it tests variation, not independent data. Real exports remain the real test.

Reproduce with `npm run robustness` (rules and heuristics, 50 seeds) or `ANTHROPIC_API_KEY=... npm run robustness` (adds the AI stage on 10 seeds; model output can vary slightly between runs). In the app, "Generate a new month" builds a month in the browser and puts its seed in the URL, so `/?seed=123` shares it.

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

8. **Drafts.** "Draft the fix" on each exception group writes what to send, built only from the facts on the exception. Anything the engine cannot know stays a placeholder such as [merchant ID]:

| Exception | Draft |
|---|---|
| Settlement never reached the bank, bank received less, gateway credit with no settlement | Support ticket to the payment gateway with settlement id, UTR, dates and amounts |
| Fee above contract | One ticket for the whole group: a table of payment ids, expected and charged fee, and the total |
| Customer charged twice, refund promised but never sent | A message to the customer and a refund instruction for your team |
| Chargeback | A dispute evidence checklist |
| Refund not recorded, collected less than total, order paid with no payment, payment with no order, bank received more | A note for the CA or ops team |

   An optional AI polish rewrites one template at a time through a forced tool call. A fact guard in code then checks the rewrite: every amount, date, order number, payment id and UTR must already be in the template, and every placeholder must survive. If not, the app keeps the template and says why. The sample's 24 drafts are polished ahead of time, so the demo needs no live call; generated months and uploads use "Polish with AI". "Export exceptions (CSV)" gives the CA every exception with its evidence and a suggested action.

## Key decisions

- **Rules first, AI last.** Deterministic matching is free, instant and auditable. The AI sees 10 of 600+ records. Cost stays flat as volume grows because only ambiguity scales the AI bill.
- **Abstain over guess.** A wrong match in reconciliation is worse than no match: it hides two real problems. Every stage is tuned for zero wrong matches, and the tests enforce it.
- **Measured, not claimed.** The synthetic generator plants each problem with a known answer, so accuracy, false alarms and misses are computed, not estimated.
- **Privacy by default.** Parsing and matching run in the browser. Only the ambiguous records go to the AI, and only when the user clicks.
- **Templates first, AI polish second.** A ticket with a wrong UTR or amount is worse than a plain one. The AI only rewords a template that is already correct, and the fact guard throws away any rewrite that adds a number or id.
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
4. Monthly close pack for the CA: GST on fees for input credit and journal entries, next to the exceptions export.

## Run it

```bash
npm install
npm run dev          # local app at http://localhost:5173/settlematch/
npm test             # engine tests
npm run generate     # regenerate the synthetic sample + answer key (seed 20260930)
npm run eval         # print the ablation table
npm run robustness   # score 50 random months (add ANTHROPIC_API_KEY for the AI stage)
```

### Precompute the sample's AI stage

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run precompute             # matching (src/sample/ai-run.json), then drafts
ANTHROPIC_API_KEY=sk-ant-... npm run precompute -- drafts   # drafts only (src/sample/ai-drafts.json)
npm run eval                                                 # now includes the AI row
```

### Deploy to Cloudflare Workers

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

The app is served at `https://maushook.com/settlematch/`. `wrangler.jsonc` routes only `maushook.com/settlematch` and `maushook.com/settlematch/*` to the Worker, so the rest of the zone keeps serving its own site. The Worker redirects `/settlematch` to `/settlematch/`, strips the prefix before serving assets or `/api/*`, and returns 404 for anything else. Vite builds with `base: '/settlematch/'`, and app code builds every URL from `import.meta.env.BASE_URL`. The workers.dev address stays on and also accepts paths without the prefix.

## Repo map

```
src/engine/normalize.ts   CSV parsing, column aliases, dates, money
src/engine/reconcile.ts   the 7-stage pipeline, scoring, exceptions, money summary
src/engine/ai.ts          prompt, tool schema, response validation, cost
src/engine/drafts.ts      draft templates per exception type, the fact guard, CSV export
src/engine/draft-ai.ts    AI polish for one draft: prompt, tool schema, guarded acceptance
src/engine/evaluate.ts    scoring against the answer key
src/engine/generate.ts    synthetic months with planted problems, seeded, runs in the browser
src/App.tsx               UI
why.html, src/why.css     static explainer page at /why (numbers checked by tests/why.test.ts)
worker/index.ts           Cloudflare Worker: static assets + /api/resolve + /api/draft
scripts/generate.ts       writes the sample month to disk
scripts/robustness.ts     scores many random months
scripts/precompute.ts     one-off AI run for the sample
tests/engine.test.ts      pipeline guarantees (zero wrong matches, 100% recall, validation)
tests/why.test.ts         every number on /why matches the engine
tests/generate.test.ts    byte-identical sample, months vary by seed, zero wrong matches on random months
tests/drafts.test.ts      drafts for every type, fact guard (hallucinated amount, changed UTR), CSV export
```

## Assumptions

- Gateway `fee` includes GST on the fee, and `tax` is the GST portion, as in Razorpay settlement reports.
- Default contract: 2% on UPI, domestic cards, netbanking and wallets, 3% on Amex and Diners. Edit it in the app to match yours.
- Settlements after the bank statement's last date are treated as in transit, not missing.
- All sample data is synthetic. No real customer or merchant data is used.
