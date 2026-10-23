// Optional AI polish for a draft, shared by the Cloudflare Worker and the precompute script.
// The model sees only one template (built from one exception group) and must answer through a
// forced tool call. Its output is then checked: if it adds any amount, date, id or UTR that is
// not in the template, it is discarded and the template is kept.
import { checkFacts, type Audience, type DraftPart } from './drafts';
import { costUsd, DEFAULT_MODEL } from './ai';

export const DRAFT_SYSTEM_PROMPT = `You polish a draft message for an Indian D2C seller who sells online and collects through a payment gateway.

Rewrite the draft so it is clear, polite and easy to act on for its audience:
- gateway: a support ticket to the payment gateway. Professional and specific.
- customer: a short, warm message to a customer. No jargon.
- internal: steps for the seller's own team. Direct and numbered.
- ca: a note for the seller's chartered accountant or ops team. Precise.

Rules:
- Keep every fact exactly as written: amounts, dates, order numbers, payment ids, settlement ids, UTRs and bank references.
- Do not add any fact that is not in the draft: no new numbers, dates, deadlines, timelines, policies, names or promises.
- Keep every [placeholder] in square brackets exactly as it is.
- Keep tables and checklists. Plain text only, no markdown headings or bold.
- Do not use em dashes.`;

export const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Submit the polished draft.',
  input_schema: {
    type: 'object',
    properties: {
      audience: { type: 'string', enum: ['gateway', 'customer', 'internal', 'ca'] },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['audience', 'subject', 'body'],
  },
} as const;

export type DraftInput = Pick<DraftPart, 'audience' | 'subject' | 'body'>;

export interface PolishResult {
  audience: Audience;
  subject: string;
  body: string;
  polished: boolean;       // false: the template was kept
  note?: string;           // why the template was kept
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; model: string };
}

const AUDIENCES = ['gateway', 'customer', 'internal', 'ca'];
export function validDraftInput(x: unknown): x is DraftInput {
  const d = x as DraftInput;
  return !!d && AUDIENCES.includes(d.audience) && typeof d.subject === 'string' && typeof d.body === 'string' &&
    d.subject.length > 0 && d.subject.length <= 300 && d.body.length > 0 && d.body.length <= 6000;
}

export function buildDraftRequest(input: DraftInput, model = DEFAULT_MODEL) {
  return {
    model,
    max_tokens: 2000,
    system: DRAFT_SYSTEM_PROMPT,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: DRAFT_TOOL.name },
    messages: [{ role: 'user', content: `Audience: ${input.audience}\n\nSubject: ${input.subject}\n\n${input.body}` }],
  };
}

const KEPT = 'Kept the factual template';

/** Applies the fact guard to a model reply. Anything off falls back to the template. */
export function acceptPolish(input: DraftInput, json: any): PolishResult {
  const template: PolishResult = { ...input, polished: false };
  const block = (json?.content ?? []).find((b: any) => b.type === 'tool_use');
  const out = block?.input;
  if (!out || typeof out.subject !== 'string' || typeof out.body !== 'string' || !out.body.trim()) {
    return { ...template, note: `${KEPT}: the AI reply was empty or malformed.` };
  }
  const rewrite = { subject: out.subject.trim(), body: out.body.trim().replace(/\s*\u2014\s*/g, ', ') };
  const missing = (input.body.match(/\[[^\]]+\]/g) ?? []).filter((ph) => !`${rewrite.subject}\n${rewrite.body}`.includes(ph));
  if (missing.length) return { ...template, note: `${KEPT}: the AI dropped ${missing.join(', ')}.` };
  const check = checkFacts(input, rewrite);
  if (!check.ok) return { ...template, note: `${KEPT}: the AI added ${check.unknown.slice(0, 3).join(', ')}, which is not in the data.` };
  return { audience: input.audience, ...rewrite, polished: true };
}

/** Calls the Anthropic Messages API for one draft. */
export async function polishDraft(input: DraftInput, apiKey: string, model = DEFAULT_MODEL): Promise<PolishResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildDraftRequest(input, model)),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const inputTokens = json?.usage?.input_tokens ?? 0;
  const outputTokens = json?.usage?.output_tokens ?? 0;
  return { ...acceptPolish(input, json), usage: { inputTokens, outputTokens, costUsd: costUsd(inputTokens, outputTokens), model: json?.model ?? model } };
}
