# SettleMatch

Submission for the Razorpay AI Builders hiring challenge. Reconciles Shopify orders, Razorpay settlement reports and bank statements. Reviewers judge core logic over polish, original work, and visible prioritization.

## Commands
- `npm test` engine tests (must stay green)
- `npm run eval` ablation table: rules vs + heuristics vs + AI, scored against the answer key
- `npm run precompute` runs the AI stage on the sample (needs ANTHROPIC_API_KEY), writes `src/sample/ai-run.json`
- `npm run precompute -- drafts` polishes only the sample's drafts, writes `src/sample/ai-drafts.json`
- `npm run generate` regenerates synthetic sample data + answer key (seeded, deterministic)
- `npm run dev` local app, `npm run build` type-check + build
- Deploy: Cloudflare Workers via `npm run deploy` (wrangler). Live at https://maushook.com/settlematch/. Pushes to `main` deploy automatically via `.github/workflows/deploy.yml`.

## Architecture
- `src/engine/` pure TypeScript, runs in the browser. Pipeline in `reconcile.ts`: normalize, rules (order to payment), fee check, rules (settlement to bank by UTR), heuristics, AI, exceptions.
- `src/engine/ai.ts` shared by `worker/index.ts` and `scripts/precompute.ts`. Forced tool call, evidence strength categories mapped to confidence, output validated against the candidate shortlist.
- `src/engine/drafts.ts` builds drafts from exception facts only; `checkFacts` guards any AI rewrite. `src/engine/draft-ai.ts` is shared by the Worker and precompute.
- `worker/index.ts` serves `dist/`, `POST /api/resolve` and `POST /api/draft` (rate limited, key server-side).
- Path prefix: the app lives under `/settlematch/` (Vite `base`). In app code, build every URL from `import.meta.env.BASE_URL`, never a root-absolute path. The Worker strips the prefix and 404s anything outside it on maushook.com; other paths on that zone belong to another site.

## Invariants (do not break)
- Zero wrong matches. Abstaining is always better than guessing; tests enforce it.
- The AI only sees records heuristics refused to decide, with at most 5 candidates each.
- Never put sample-specific answers (planted notes, names, products) in the AI prompt. Only general domain guidance.
- Accuracy numbers in README and UI must come from `npm run eval`, never be estimated.

## Style
- Never use em dashes in code comments, UI copy or docs.
- UI copy: plain, sentence case, active voice.
