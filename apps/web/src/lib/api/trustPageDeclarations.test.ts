// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as api from './trustPageDeclarations';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('trustPageDeclarations client', () => {
  it('getTrustDeclarations GETs the org-scoped path and unwraps { data }', async () => {
    const data = { catalog: [], active: [], history: [], publishedDeclarationIds: [], publicationRevision: 2, partnerName: 'NW' };
    const f = vi.fn(async () => ok({ data }));
    expect(await api.getTrustDeclarations(f, 'o 1')).toEqual(data);
    expect(f).toHaveBeenCalledWith('/orgs/o%201/trust-page/declarations');
  });

  it('a failed read throws an ActionError', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }), { status: 404 }));
    await expect(api.getTrustDeclarations(f, 'o1')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('declare and withdraw POST the right path and body, and return the raw Response', async () => {
    const res = ok({});
    const f = vi.fn(async () => res);
    const body = { controlId: 'cyber_insurance' as const, statement: 'We hold a cyber policy.', evidenceDocumentId: null, expectedRevision: 3 };
    expect(await api.declareTrustControl(f, 'o1', body)).toBe(res);
    expect(await api.withdrawTrustDeclaration(f, 'o1', 'd/1', 4)).toBe(res);
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe('/orgs/o1/trust-page/declarations');
    expect(calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual(body);
    expect(calls[1]![0]).toBe('/orgs/o1/trust-page/declarations/d%2F1/withdraw');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ expectedRevision: 4 });
  });
});
