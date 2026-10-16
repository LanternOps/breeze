import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './callerVerification';
import { ORG, CONTACT, TARGET, TICKET, row, history, policyResponse, methods } from '@/components/callerVerification/testFixtures';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: mocks.fetch }));
vi.mock('@/components/shared/Toast', () => ({ showToast: mocks.toast }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockImplementation(() => Promise.resolve(json({ data: row })));
});

describe('caller verification client', () => {
  it('starts with the exact body, the org pinned by the path, and accepts 202', async () => {
    mocks.fetch.mockResolvedValue(json({ data: row }, 202));
    expect(await api.startVerification({ orgId: ORG, contactId: CONTACT, actionScope: 'reset_password', method: 'sms' })).toEqual(row);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe(`/orgs/${ORG}/caller-verifications`);
    expect(init).toMatchObject({ method: 'POST', orgIdOverride: ORG });
    expect(JSON.parse(init.body)).toEqual({ contactId: CONTACT, actionScope: 'reset_password', method: 'sms' });
  });

  it('does not turn an HTTP-200 application failure into success', async () => {
    mocks.fetch.mockResolvedValue(json({ success: false, error: 'boom' }));
    await expect(api.cancelVerification(ORG, row.id)).rejects.toMatchObject({ status: 200 });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('maps a coded refusal to human copy, never the raw code', async () => {
    mocks.fetch.mockResolvedValue(json({ error: 'Contact is fenced', code: 'contact_fenced' }, 400));
    await expect(api.attestVerification(ORG, row.id, 'Called back on the number of record')).rejects.toMatchObject({ status: 400, code: 'contact_fenced' });
    const message = mocks.toast.mock.calls[0][0].message as string;
    expect(message).not.toContain('contact_fenced');
    expect(message.length).toBeGreaterThan(10);
  });

  it('maps the uncoded start rate limit to human copy', async () => {
    mocks.fetch.mockResolvedValue(json({ error: 'Rate limited' }, 429));
    await expect(api.startVerification({ orgId: ORG, contactId: CONTACT, actionScope: 'any', method: 'sms' })).rejects.toMatchObject({ status: 429 });
    expect(mocks.toast.mock.calls[0][0].message).not.toBe('Rate limited');
  });

  it('reads a verification with abort support and the pinned org', async () => {
    const signal = new AbortController().signal;
    expect(await api.getVerification(ORG, row.id, signal)).toEqual(row);
    expect(mocks.fetch).toHaveBeenCalledWith(`/orgs/${ORG}/caller-verifications/${row.id}`, expect.objectContaining({ method: 'GET', signal, orgIdOverride: ORG }));
  });

  it('rejects a projection missing grant fields instead of fabricating state', async () => {
    const { usableUntil: _u, ...incomplete } = row;
    mocks.fetch.mockResolvedValue(json({ data: incomplete }));
    await expect(api.getVerification(ORG, row.id)).rejects.toThrow('Incomplete caller verification projection');
  });

  it('accepts a start response with only id and status so a created challenge is never reported as failed', async () => {
    const { usableUntil: _u, remainingAttempts: _r, ...partial } = row;
    mocks.fetch.mockResolvedValue(json({ data: partial }, 202));
    expect(await api.startVerification({ orgId: ORG, contactId: CONTACT, actionScope: 'any', method: 'sms' })).toMatchObject({ id: row.id, status: 'pending' });
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it.each([
    ['getVerification', () => api.getVerification(ORG, row.id)],
    ['cancelVerification', () => api.cancelVerification(ORG, row.id)],
    ['attestVerification', () => api.attestVerification(ORG, row.id, 'Called back on the number of record')],
    ['contactHistory', () => api.contactHistory(ORG, CONTACT)],
    ['methodsForContact', () => api.methodsForContact(ORG, CONTACT, 'any')],
    ['freshForTicket', () => api.freshForTicket(ORG, TICKET)],
    ['fenceOverride', () => api.fenceOverride(ORG, CONTACT, 'Confirmed in person at the office today')],
    ['attestDestination', () => api.attestDestination(ORG, CONTACT, TARGET)],
    ['bindContact', () => api.bindContact(ORG, CONTACT, { entraTenantId: ORG, entraOid: TARGET, upn: 'a@b.test', displayName: 'A' })],
    ['unbindContact', () => api.unbindContact(ORG, CONTACT, TARGET)],
    ['directoryUsers', () => api.directoryUsers(ORG, 'ada')],
    ['syncDirectory', () => api.syncDirectory(ORG, [])],
    ['putPolicy(org)', () => api.putPolicy({ ownerScope: 'organization', orgId: ORG }, {} as api.PolicyDraft)],
    ['contactsPage', () => api.contactsPage(ORG, 1)],
  ])('%s pins the request to the path org', async (_name, call) => {
    mocks.fetch.mockImplementation(() => Promise.resolve(json({
      data: { ...row, ...history, rows: [], isFresh: false, isConsumed: false, available: false, users: [], truncated: false, ...policyResponse },
    })));
    await call().catch(() => undefined);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ orgIdOverride: ORG });
  });

  it('rejects a missing data envelope', async () => {
    mocks.fetch.mockResolvedValue(json(row));
    await expect(api.getVerification(ORG, row.id)).rejects.toThrow('Missing API data envelope');
  });

  it('reads methods for an action scope', async () => {
    mocks.fetch.mockResolvedValue(json({ data: methods }));
    expect(await api.methodsForContact(ORG, CONTACT, 'disable_user')).toEqual(methods);
    expect(mocks.fetch.mock.calls[0][0]).toBe(`/orgs/${ORG}/contacts/${CONTACT}/caller-verifications/methods?actionScope=disable_user`);
  });

  it('reads contact history and the ticket freshness projection', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ data: { ...history, rows: [row] } }));
    expect((await api.contactHistory(ORG, CONTACT)).rows[0]).toEqual(row);
    mocks.fetch.mockResolvedValueOnce(json({ data: { row, isFresh: false, isConsumed: false } }));
    expect(await api.freshForTicket(ORG, TICKET)).toEqual({ row, isFresh: false, isConsumed: false });
    expect(mocks.fetch.mock.calls[1][0]).toBe(`/orgs/${ORG}/tickets/${TICKET}/caller-verification`);
  });

  it('pins org policy to the org and partner policy to no org', async () => {
    mocks.fetch.mockImplementation(() => Promise.resolve(json({ data: policyResponse })));
    await api.getPolicy({ ownerScope: 'organization', orgId: ORG });
    await api.putPolicy({ ownerScope: 'partner' }, { ...Object.fromEntries(Object.keys(policyResponse.defaults).map((k) => [k, null])), maxAttemptsPerHour: 2 } as api.PolicyDraft);
    expect(mocks.fetch.mock.calls[0]).toEqual([`/orgs/${ORG}/caller-verification-policy`, expect.objectContaining({ orgIdOverride: ORG })]);
    expect(mocks.fetch.mock.calls[1]).toEqual(['/partner/caller-verification-policy', expect.objectContaining({ method: 'PUT', orgIdOverride: null })]);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).maxAttemptsPerHour).toBe(2);
  });

  it('rejects an incomplete policy projection', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { row: null, effective: policyResponse.effective } }));
    await expect(api.getPolicy({ ownerScope: 'partner' })).rejects.toThrow('Incomplete caller verification projection');
  });

  it('searches the directory with an encoded query', async () => {
    const data: api.DirectorySearch = { available: true, users: [{ entraTenantId: ORG, entraOid: TARGET, upn: 'ada@example.test', displayName: 'Ada' }], truncated: false };
    mocks.fetch.mockResolvedValue(json({ data }));
    expect(await api.directoryUsers(ORG, 'Ada & team')).toEqual(data);
    expect(mocks.fetch.mock.calls[0][0]).toBe(`/orgs/${ORG}/caller-verification-directory-users?search=Ada+%26+team`);
  });

  it.each([400, 403, 404])('surfaces directory HTTP %s as an error', async (status) => {
    mocks.fetch.mockResolvedValue(json({ error: 'Directory unavailable' }, status));
    await expect(api.directoryUsers(ORG, 'Ada')).rejects.toMatchObject({ status });
  });

  it('binds with only directory-returned identity fields', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { id: TARGET } }, 201));
    await api.bindContact(ORG, CONTACT, { entraTenantId: ORG, entraOid: TARGET, upn: 'ada@example.test', displayName: 'Ada' });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ entraTenantId: ORG, entraOid: TARGET, upn: 'ada@example.test' });
  });

  it('posts fence override, destination attestation, unbind and directory sync to the shipped routes', async () => {
    mocks.fetch.mockImplementation(() => Promise.resolve(json({ data: { ok: true, id: TARGET, attestedAt: 'x', imported: 1, revoked: 0, complete: true } })));
    await api.fenceOverride(ORG, CONTACT, 'Caller confirmed in person at the office');
    await api.attestDestination(ORG, CONTACT, TARGET);
    await api.unbindContact(ORG, CONTACT, TARGET);
    await api.syncDirectory(ORG, [{ contactId: CONTACT, entraOid: TARGET }]);
    expect(mocks.fetch.mock.calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      `POST /orgs/${ORG}/contacts/${CONTACT}/caller-verifications/fence-override`,
      `POST /orgs/${ORG}/contacts/${CONTACT}/caller-verification-destinations/${TARGET}/attest`,
      `DELETE /orgs/${ORG}/contacts/${CONTACT}/caller-verification-bindings/${TARGET}`,
      `POST /orgs/${ORG}/caller-verification-directory-sync`,
    ]);
  });
});
