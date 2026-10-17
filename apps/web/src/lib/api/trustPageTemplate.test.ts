// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as api from './trustPageTemplate';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('trustPageTemplate client (W02g)', () => {
  it('GET /trust-page-template unwraps { data }', async () => {
    const data = { template: null, revision: 0, defaults: { showManagedBy: true }, frameworkOptions: [], canManage: true };
    const f = vi.fn(async () => ok({ data }));
    expect(await api.getTrustPageTemplate(f)).toEqual(data);
    expect(f).toHaveBeenCalledWith('/trust-page-template');
  });

  it('a failed read throws an ActionError carrying status and code', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'no', code: 'X' }), { status: 403 }));
    await expect(api.getTrustPageTemplate(f)).rejects.toMatchObject({ status: 403, code: 'X' });
  });

  it('PUT sends the body as JSON and returns the raw Response for runAction', async () => {
    const res = ok({ data: { template: null, revision: 1 } });
    const f = vi.fn(async () => res);
    const out = await api.updateTrustPageTemplate(f, { expectedRevision: 0, showManagedBy: null });
    expect(out).toBe(res);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/trust-page-template');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 0, showManagedBy: null });
  });
});
