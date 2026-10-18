// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as api from './trustPageContent';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('trustPageContent client', () => {
  it('reads GET and unwrap { data }', async () => {
    const f = vi.fn(async () => ok({ data: { subprocessors: [], publicationRevision: 4 } }));
    expect(await api.getTrustSubprocessors(f, 'o 1')).toEqual({ subprocessors: [], publicationRevision: 4 });
    expect(f).toHaveBeenCalledWith('/orgs/o%201/trust-page/subprocessors');
    const g = vi.fn(async () => ok({ data: { suggestions: [{ name: 'X' }] } }));
    expect(await api.getTrustSubprocessorSuggestions(g, 'o1')).toEqual([{ name: 'X' }]);
    expect(g).toHaveBeenCalledWith('/orgs/o1/trust-page/subprocessors/suggestions');
    const h = vi.fn(async () => ok({ data: { items: [], publicationRevision: 1 } }));
    await api.getTrustFaq(h, 'o1');
    expect(h).toHaveBeenCalledWith('/orgs/o1/trust-page/faq');
  });

  it('throws an ActionError on a failed read', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'nope', code: 'X' }), { status: 403 }));
    await expect(api.getTrustFaq(f, 'o1')).rejects.toMatchObject({ status: 403, code: 'X' });
  });

  it('PUTs send the replace-all body with expectedRevision and return the raw Response', async () => {
    const f = vi.fn(async () => ok({}));
    const sp = { name: 'A', purpose: 'P', location: null, websiteUrl: null, source: 'manual' as const, sourceKey: null };
    const res = await api.putTrustSubprocessors(f, 'o1', 5, [sp]);
    expect(res).toBeInstanceOf(Response);
    expect(f).toHaveBeenCalledWith('/orgs/o1/trust-page/subprocessors', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedRevision: 5, subprocessors: [sp] }) }));
    await api.putTrustFaq(f, 'o1', 6, [{ question: 'Q?????', answerHtml: '<p>a</p>' }]);
    expect(f).toHaveBeenLastCalledWith('/orgs/o1/trust-page/faq', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedRevision: 6, items: [{ question: 'Q?????', answerHtml: '<p>a</p>' }] }) }));
  });
});
