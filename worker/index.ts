// Cloudflare Worker: serves the static app and two AI endpoints.
// The API key never reaches the browser. The endpoint is rate limited and
// only accepts small, well-formed packets, so a public demo link can't be abused.
import { callClaude, DEFAULT_MODEL, MAX_PACKETS } from '../src/engine/ai';
import { polishDraft, validDraftInput } from '../src/engine/draft-ai';
import type { AiPacket } from '../src/engine/types';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  AI_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
}

// The app is served under this prefix on maushook.com, where other paths belong to another site.
// The workers.dev address also accepts paths without it, so the old link keeps working.
const PREFIX = '/settlematch';
const acceptsUnprefixed = (host: string) => host.endsWith('.workers.dev');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function validPackets(x: unknown): x is AiPacket[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > MAX_PACKETS) return false;
  return x.every((p) =>
    p && (p.kind === 'payment' || p.kind === 'bank') && typeof p.id === 'string' && p.id.length < 64 &&
    typeof p.fields === 'object' && Array.isArray(p.candidates) && p.candidates.length > 0 && p.candidates.length <= 5 &&
    p.candidates.every((c: any) => c && typeof c.id === 'string' && typeof c.fields === 'object'));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === PREFIX) return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 301);
    let path: string;
    if (url.pathname.startsWith(`${PREFIX}/`)) path = url.pathname.slice(PREFIX.length);
    else if (acceptsUnprefixed(url.hostname)) path = url.pathname;
    else return new Response('Not found', { status: 404 });

    if (path !== '/api/resolve' && path !== '/api/draft') {
      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(new Request(new URL(`${path}${url.search}`, url.origin), req));
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI is not configured on this deployment.' }, 503);

    const ip = req.headers.get('cf-connecting-ip') ?? 'anon';
    if (env.AI_LIMITER) {
      const { success } = await env.AI_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Rate limit: try again in a minute.' }, 429);
    }

    const text = await req.text();
    if (text.length > 60_000) return json({ error: 'Payload too large' }, 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }

    // POST /api/draft: polish one draft. The body is a single template built from one exception group.
    if (path === '/api/draft') {
      if (!validDraftInput(body?.draft)) return json({ error: 'Send one draft: audience, subject (up to 300 characters) and body (up to 6,000).' }, 400);
      try {
        const { audience, subject, body: text } = body.draft;
        return json(await polishDraft({ audience, subject, body: text }, env.ANTHROPIC_API_KEY, env.AI_MODEL || DEFAULT_MODEL));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : 'AI call failed' }, 502);
      }
    }

    if (!validPackets(body?.packets)) return json({ error: `Send 1 to ${MAX_PACKETS} packets with up to 5 candidates each.` }, 400);

    try {
      const out = await callClaude(body.packets, env.ANTHROPIC_API_KEY, env.AI_MODEL || DEFAULT_MODEL);
      return json({ ...out, createdAt: new Date().toISOString() });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'AI call failed' }, 502);
    }
  },
};
