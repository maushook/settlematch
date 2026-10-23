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

Pick the candidate the evidence actually supports, or null if none clearly fits.

How to read the evidence:
- Payment notes are written by real customers: Hinglish, typos, nicknames, relations ("aunty", "sir", "didi"), spelling variants of Indian names (Laxmi = Lakshmi, Venky = Venkatesh), the letter O or l typed for 0 or 1, and numbers spelled out in words.
- Products are often described informally or in Hindi (e.g. "mor" means peacock, "sone ki patti" means gold leaf, a place name can point to a landmark artwork).
- The payer is often not the customer (gifts, family members), so a different email or phone is normal.
- An order whose payment reference is "not found in gateway" is a weak candidate unless the notes point to it.
- Amounts and dates are usually tied between candidates; decide on the notes, names and products.
- For bank credits, prefer the settlement whose net amount and date match the deposit.

Never guess. If two candidates fit equally, return null. Confidence is your probability of being right (0 to 1).
Keep each reason under 20 words and cite the specific evidence.`;

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
            match: { type: ['string', 'null'] },
            confidence: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['kind', 'id', 'match', 'confidence', 'reason'],
        },
      },
    },
    required: ['decisions'],
  },
} as const;

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
  const out: AiDecision[] = [];
  for (const d of raw) {
    const pk = byId.get(`${d?.kind}:${d?.id}`);
    if (!pk) continue;
    const match = typeof d.match === 'string' && pk.candidates.some((c) => c.id === d.match) ? d.match : null;
    const confidence = Math.max(0, Math.min(1, Number(d.confidence) || 0));
    out.push({ kind: pk.kind, id: pk.id, match, confidence, reason: String(d.reason ?? '').slice(0, 200) });
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
