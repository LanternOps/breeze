// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import * as api from './trustPageAccess';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const REQ = '33333333-3333-4333-8333-333333333333';

describe('trustPageAccess client', () => {
  it('lists requests (optionally by status) and unwraps { data: { requests } }', async () => {
    const f = vi.fn(async () => ok({ data: { requests: [{ id: REQ }] } }));
    expect(await api.listTrustAccessRequests(f, 'o 1')).toEqual([{ id: REQ }]);
    expect(f).toHaveBeenCalledWith('/orgs/o%201/trust-page/access-requests');
    await api.listTrustAccessRequests(f, 'o1', 'pending_approval');
    expect(f).toHaveBeenLastCalledWith('/orgs/o1/trust-page/access-requests?status=pending_approval');
  });

  it('a failed list throws an ActionError', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'nope', code: 'X' }), { status: 403 }));
    await expect(api.listTrustAccessRequests(f, 'o1')).rejects.toMatchObject({ status: 403 });
  });

  it('decisions POST to the request path with a JSON body', async () => {
    const f = vi.fn(async () => ok({}));
    await api.approveTrustAccessRequest(f, 'o1', REQ, 'fine');
    expect(f).toHaveBeenLastCalledWith(`/orgs/o1/trust-page/access-requests/${REQ}/approve`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'fine' }) }));
    await api.approveTrustAccessRequest(f, 'o1', REQ);
    expect(f).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({}) }));
    await api.denyTrustAccessRequest(f, 'o1', REQ, 'Sign the NDA');
    expect(f).toHaveBeenLastCalledWith(`/orgs/o1/trust-page/access-requests/${REQ}/deny`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'Sign the NDA' }) }));
    await api.revokeTrustAccessGrant(f, 'o1', REQ);
    expect(f).toHaveBeenLastCalledWith(`/orgs/o1/trust-page/access-requests/${REQ}/revoke`, expect.objectContaining({ method: 'POST' }));
    await api.resendTrustAccessGrant(f, 'o1', REQ);
    expect(f).toHaveBeenLastCalledWith(`/orgs/o1/trust-page/access-requests/${REQ}/resend`, expect.objectContaining({ method: 'POST' }));
  });
});
