// AI stage contract, shared by the Cloudflare Worker and the precompute script.
// The model only ever sees ambiguous leftovers with a shortlist of candidates,
// and must answer through a forced tool call, so the output is always structured.
import type { AiDecision, AiPacket } from './types';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
// USD per million tokens (prompts under 100k tokens). Update if pricing changes.
export const PRICE_PER_MTOK = { input: 0.1, output: 0.5 };
export const MAX_PACKETS = 40;

export const SYSTEM_PROMPT = `You reconcile payments for an Indian D2C seller.

Each item is either:
- a gateway PAYMENT that no rule could tie to a Shopify ORDER, with candidate orders, or
- a BANK credit from the payment gateway that no UTR could tie to a SETTLEMENT, with candidate settlements.

Candidates were shortlisted because their amount and date already fit. Amount and date therefore do not tell them apart. Your job is to decide which candidate the remaining evidence points to.

How to read payment notes:
- They are written by real customers: Hinglish or other Indian languages, typos, nicknames, relations (aunty, sir, didi, bhaiya), spelling variants of Indian names, letters typed for digits (O for 0, l or I for 1), and numbers written out in words. Decode them.
- Products are often described by what the artwork shows, in Hindi or English, or by a place or landmark it depicts, instead of the catalogue name. Translate and compare with each candidate's items.
- The payer is often not the customer (gifts, family), so a payer email or phone that differs from the order is normal and is NOT evidence against a match.
- An order whose payment reference is "not found in gateway" probably has its own missing payment. Pick it only if the notes point to it specifically.
- For bank credits, compare the deposit with each settlement's net amount and date.

For each item, first write your reasoning, then choose:
- strength "strong": the notes identify exactly one candidate (a decoded order number, a name variant of exactly one customer, or a product description that fits exactly one candidate's items).
- strength "moderate": the evidence clearly favours one candidate but involves some interpretation.
- strength "weak": a slight lean only. Use match null.
- strength "none": nothing in the evidence separates the candidates. Use match null.
Copy candidate ids exactly as given (including any #).`;

export const DECISION_TOOL = {
  name: 'submit_decisions',
  description: 'Submit one decision per item.',
  input_schema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['payment', 'bank'] },
            id: { type: 'string' },
            reasoning: { type: 'string', description: 'One or two sentences decoding the evidence, written before deciding.' },
            match: { type: ['string', 'null'] },
            strength: { type: 'string', enum: ['strong', 'moderate', 'weak', 'none'] },
          },
          required: ['kind', 'id', 'reasoning', 'match', 'strength'],
        },
      },
    },
    required: ['decisions'],
  },
} as const;

// Small models give poorly calibrated raw probabilities, so the model picks a defined
// evidence category and the engine maps it to a confidence.
export const STRENGTH_CONFIDENCE = { strong: 0.95, moderate: 0.75, weak: 0.35, none: 0 } as const;

export function buildRequestBody(packets: AiPacket[], model = DEFAULT_MODEL) {
  const items = packets.map((p) => ({
    kind: p.kind,
    id: p.id,
    record: p.fields,
    candidates: p.candidates.map((c) => ({ id: c.id, ...c.fields })),
  }));
  return {
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [DECISION_TOOL],
    tool_choice: { type: 'tool', name: DECISION_TOOL.name },
    messages: [{ role: 'user', content: `Items to decide (${items.length}):\n${JSON.stringify(items, null, 1)}` }],
  };
}

/** Validates the model output: unknown ids and off-list matches are dropped, never trusted. */
export function parseResponse(json: any, packets: AiPacket[]): AiDecision[] {
  const block = (json?.content ?? []).find((b: any) => b.type === 'tool_use');
  const raw: any[] = block?.input?.decisions ?? [];
  const byId = new Map(packets.map((p) => [`${p.kind}:${p.id}`, p]));
  const canon = (x: string) => x.replace(/[^0-9a-z_]/gi, '').toLowerCase();
  const out: AiDecision[] = [];
  for (const d of raw) {
    const pk = byId.get(`${d?.kind}:${d?.id}`);
    if (!pk) continue;
    // Accept "1231" for "#1231", but nothing outside the offered shortlist.
    const match = typeof d.match === 'string'
      ? pk.candidates.find((c) => c.id === d.match || canon(c.id) === canon(d.match))?.id ?? null
      : null;
    const strength = d.strength in STRENGTH_CONFIDENCE ? (d.strength as keyof typeof STRENGTH_CONFIDENCE) : undefined;
    const confidence = strength ? STRENGTH_CONFIDENCE[strength] : Math.max(0, Math.min(1, Number(d.confidence) || 0));
    const reason = String(d.reasoning ?? d.reason ?? '').slice(0, 240);
    out.push({ kind: pk.kind, id: pk.id, match, confidence, strength, reason });
  }
  return out;
}

export function costUsd(inputTokens: number, outputTokens: number) {
  return (inputTokens * PRICE_PER_MTOK.input + outputTokens * PRICE_PER_MTOK.output) / 1e6;
}

/** Calls the Anthropic Messages API. Used by the Worker and the precompute script. */
export async function callClaude(packets: AiPacket[], apiKey: string, model = DEFAULT_MODEL) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildRequestBody(packets, model)),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const inputTokens = json?.usage?.input_tokens ?? 0;
  const outputTokens = json?.usage?.output_tokens ?? 0;
  return {
    decisions: parseResponse(json, packets),
    usage: { inputTokens, outputTokens, costUsd: costUsd(inputTokens, outputTokens), latencyMs: Date.now() - t0, model: json?.model ?? model },
  };
}
