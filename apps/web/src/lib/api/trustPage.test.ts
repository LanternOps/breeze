// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as api from './trustPage';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('trustPage client', () => {
  it('getTrustPage / getTrustControls GET and unwrap { data }', async () => {
    const f = vi.fn(async () => ok({ data: { page: { id: 'pg' } } }));
    expect(await api.getTrustPage(f, 'o 1')).toEqual({ page: { id: 'pg' } });
    expect(f).toHaveBeenCalledWith('/orgs/o%201/trust-page');
    const g = vi.fn(async () => ok({ data: { assessments: [], catalog: [], evaluatedAt: 'x', deviceCount: 0 } }));
    await api.getTrustControls(g, 'o1');
    expect(g).toHaveBeenCalledWith('/orgs/o1/trust-page/controls');
  });

  it('getTrustPage passes the linked documents through', async () => {
    const documents = [{ documentId: 'd1', visibility: 'public', disclosureConfirmedAt: '2026-10-01T00:00:00Z', sortOrder: 0, title: 'Policy', category: 'policy', contentType: 'application/pdf', byteSize: 1, supersededByDocumentId: null, deleted: false }];
    const f = vi.fn(async () => ok({ data: { page: { id: 'pg' }, documents } }));
    expect((await api.getTrustPage(f, 'o1')).documents).toEqual(documents);
  });

  it('throws an ActionError on a failed read', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'nope', code: 'X' }), { status: 403 }));
    await expect(api.getTrustPage(f, 'o1')).rejects.toMatchObject({ status: 403, code: 'X' });
  });

  it('mutations hit the right path, method and body', async () => {
    const f = vi.fn(async () => ok({}));
    await api.updateTrustPage(f, 'o1', { showManagedBy: false } as never);
    await api.updateTrustDocuments(f, 'o1', [{ documentId: 'd', visibility: 'public', disclosureConfirmed: true }]);
    await api.publishTrustPage(f, 'o1', { expectedRevision: 3, authorization: { authorizedBy: 'Jane' } });
    await api.unpublishTrustPage(f, 'o1');
    await api.setPartnerHome(f, 'o1', true);
    await api.createPreviewToken(f, 'o1');
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([p, i]) => [p, i.method])).toEqual([
      ['/orgs/o1/trust-page', 'PUT'],
      ['/orgs/o1/trust-page/documents', 'PUT'],
      ['/orgs/o1/trust-page/publish', 'POST'],
      ['/orgs/o1/trust-page/unpublish', 'POST'],
      ['/orgs/o1/trust-page/partner-home', 'POST'],
      ['/orgs/o1/trust-page/preview-token', 'POST'],
    ]);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ showManagedBy: false });
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ documents: [{ documentId: 'd', visibility: 'public', disclosureConfirmed: true }] });
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ expectedRevision: 3, authorization: { authorizedBy: 'Jane' } });
    expect(JSON.parse(calls[4][1].body as string)).toEqual({ isPartnerHome: true });
  });

  it('trustPublicUrl prefixes the origin', () => {
    expect(api.trustPublicUrl('/portal/trust/a/b')).toBe(`${window.location.origin}/portal/trust/a/b`);
  });
});
