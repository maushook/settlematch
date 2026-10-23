// Routing for the /settlematch prefix: maushook.com serves only the prefix; workers.dev also serves the bare paths.
import { describe, expect, it } from 'vitest';
import worker from '../worker/index';

const seen: string[] = [];
const env = {
  ASSETS: { fetch: async (req: Request) => { seen.push(new URL(req.url).pathname + new URL(req.url).search); return new Response('asset'); } },
  ANTHROPIC_API_KEY: 'test-key',
};
const get = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env as any);

describe('worker routing', () => {
  it('redirects /settlematch to /settlematch/ and keeps the query', async () => {
    const r = await get('https://maushook.com/settlematch?seed=5');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://maushook.com/settlematch/?seed=5');
  });

  it('strips the prefix before serving assets', async () => {
    seen.length = 0;
    for (const p of ['/settlematch/', '/settlematch/why', '/settlematch/sample/bank_statement.csv', '/settlematch/?seed=123']) {
      expect((await get(`https://maushook.com${p}`)).status).toBe(200);
    }
    expect(seen).toEqual(['/', '/why', '/sample/bank_statement.csv', '/?seed=123']);
  });

  it('strips the prefix before routing the API', async () => {
    const r = await get('https://maushook.com/settlematch/api/resolve', { method: 'POST', body: '{"packets":[]}' });
    expect(r.status).toBe(400);
    expect((await get('https://maushook.com/settlematch/api/other')).status).toBe(404);
  });

  it('returns 404 for every other path on maushook.com', async () => {
    seen.length = 0;
    for (const p of ['/', '/blog', '/why', '/settlematchx', '/sample/bank_statement.csv', '/api/resolve']) {
      expect((await get(`https://maushook.com${p}`)).status, p).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('still serves paths without the prefix on workers.dev', async () => {
    seen.length = 0;
    expect((await get('https://settlematch.example.workers.dev/')).status).toBe(200);
    expect((await get('https://settlematch.example.workers.dev/why')).status).toBe(200);
    expect((await get('https://settlematch.example.workers.dev/settlematch/why')).status).toBe(200);
    expect(seen).toEqual(['/', '/why', '/why']);
  });
});
