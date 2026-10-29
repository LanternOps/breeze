import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Portal agreement routes (#9075 W3a). The DB mock answers by TABLE: each
// `from(table)` resolves the rows registered for that table object, so a
// test states "the org-scoped read finds this request" without depending on
// query order. Every where() predicate is recorded for the org-filter checks.
const h = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => {
  const makeChain = () => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn((t: unknown) => { table = t; return chain; });
    chain.where = vi.fn((w: unknown) => { h.wheres.push(w); return chain; });
    for (const m of ['limit', 'orderBy', 'innerJoin', 'leftJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject);
    return chain;
  };
  return {
    db: { select: (...a: unknown[]) => (makeChain().select as (...x: unknown[]) => unknown)(...a) },
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

const m = vi.hoisted(() => ({
  accept: vi.fn(),
  decline: vi.fn(),
  markViewed: vi.fn(),
  renderData: vi.fn(),
  notify: vi.fn(),
  signedCopy: vi.fn(),
  revoke: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../../services/agreementRequestAcceptService', () => ({
  acceptAgreementRequest: m.accept,
  declineAgreementRequest: m.decline,
  markAgreementRequestViewed: m.markViewed,
}));
vi.mock('../../services/contractTemplateRender', async (importActual) => ({
  ...(await importActual<typeof import('../../services/contractTemplateRender')>()),
  loadTemplateVersionRenderData: m.renderData,
}));
vi.mock('../../services/agreementOutcomeNotify', () => ({ notifyAgreementOutcome: m.notify }));
vi.mock('../../services/agreementSignedCopyEmail', () => ({ sendSignedAgreementCopy: m.signedCopy }));
vi.mock('../../services/agreementAcceptToken', () => ({ revokeAgreementAcceptJti: m.revoke }));
vi.mock('../../services/sentry', () => ({ captureException: m.capture }));

import { portalAgreementRoutes, isPortalVisibleRequest } from './agreements';
import {
  agreementRequestRecipients,
  agreementRequests,
  contractDocuments,
  contractTemplateVersions,
} from '../../db/schema/contractDocuments';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { AgreementRequestServiceError } from '../../services/agreementRequestService';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { CSRF_HEADER_NAME, PORTAL_CSRF_COOKIE_NAME } from './schemas';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const REQ = '55555555-5555-4555-8555-555555555555';
const VERSION = '22222222-2222-4222-8222-222222222222';
const DOC = '66666666-6666-4666-8666-666666666666';
const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const PAST = new Date(Date.now() - 60_000);
const SESSION_EMAIL = 'Dana@Customer.Example';

function app(authMethod: 'bearer' | 'cookie' = 'bearer') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu-1', orgId: ORG, email: SESSION_EMAIL, name: 'Dana', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod, partnerId: PARTNER, timezone: 'UTC',
    });
    await next();
  });
  a.route('/', portalAgreementRoutes);
  return a;
}

function request(over: Record<string, unknown> = {}) {
  return {
    id: REQ, orgId: ORG, status: 'sent', templateId: 't-1', templateVersionId: VERSION, contractId: null,
    label: 'HIPAA BAA', coverMessage: 'Please sign', variableValues: { 'custom.po': 'PO-1' },
    clientNameSnapshot: 'Acme Dental', clientAddressSnapshot: null, sellerSnapshot: { name: 'Best MSP' },
    documentLocale: null, renderLocale: 'en', effectiveDate: null, expiresAt: FUTURE,
    sentAt: new Date('2026-10-20T10:00:00Z'), firstViewedAt: null, signedAt: null, declinedAt: null,
    publicLinkRevokedAt: null, acceptTokenJti: 'jti-1', acceptTokenExpiresAt: FUTURE,
    publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    ...over,
  };
}

function authoredRender(over: Record<string, unknown> = {}) {
  return {
    templateId: 't-1', templateVersionId: VERSION, sourceType: 'authored', bodyHtml: '<p>Agreement for {{client.name}}</p>',
    fileData: null, versionSha256: 'v', declaredVariables: [{ name: 'client.name', kind: 'auto' }], templateName: 'BAA', versionNumber: 2,
    ...over,
  };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const NOT_FOUND = { error: 'Agreement not found', code: 'NOT_FOUND' };

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.wheres.length = 0;
  m.renderData.mockResolvedValue(authoredRender());
  m.markViewed.mockResolvedValue(true);
  m.notify.mockResolvedValue(undefined);
  m.signedCopy.mockResolvedValue({ sent: true });
  m.revoke.mockResolvedValue(undefined);
});

describe('isPortalVisibleRequest — the one visibility rule', () => {
  const now = new Date();
  it.each([
    ['sent', {}, true],
    ['viewed', {}, true],
    ['signed', {}, true],
    ['declined', {}, true],
    ['draft', {}, false],
    ['voided', {}, false],
    ['expired', {}, false],
    ['sent', { publicLinkRevokedAt: PAST }, false],
    ['sent', { expiresAt: now }, false],
    ['viewed', { expiresAt: PAST }, false],
    // A settled request stays readable history after its expiry instant.
    ['signed', { expiresAt: PAST }, true],
  ])('%s %o → %s', (status, over, expected) => {
    expect(isPortalVisibleRequest(request({ status, ...over }) as never, now)).toBe(expected);
  });
});

describe('GET /agreements', () => {
  it('lists the open requests with canSign from the recipient list and the template name', async () => {
    h.rows.set(agreementRequests, [
      { id: REQ, status: 'sent', label: null, templateVersionId: VERSION, sentAt: new Date('2026-10-20T10:00:00Z'), expiresAt: FUTURE },
      { id: 'r-2', status: 'viewed', label: 'DPA 2026', templateVersionId: VERSION, sentAt: null, expiresAt: FUTURE },
    ]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    h.rows.set(contractTemplateVersions, [{ versionId: VERSION, versionNumber: 2, templateName: 'BAA' }]);
    const res = await app().request('/agreements');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { id: REQ, name: 'BAA', templateName: 'BAA', status: 'sent', sentAt: '2026-10-20T10:00:00.000Z', expiresAt: FUTURE.toISOString(), canSign: true },
      { id: 'r-2', name: 'BAA', templateName: 'BAA', status: 'viewed', sentAt: null, expiresAt: FUTURE.toISOString(), canSign: false },
    ]);
  });

  it('#10294: the staff-internal label never reaches the portal payload — the customer sees the template name', async () => {
    h.rows.set(agreementRequests, [
      { id: REQ, status: 'sent', label: 'Portal sign 10-26', templateVersionId: VERSION, sentAt: null, expiresAt: FUTURE },
    ]);
    h.rows.set(contractTemplateVersions, [{ versionId: VERSION, versionNumber: 1, templateName: 'QA Master Services Agreement' }]);
    const res = await app().request('/agreements');
    const raw = await res.text();
    expect(raw).not.toContain('Portal sign 10-26');
    const [item] = JSON.parse(raw).data;
    expect(item.name).toBe('QA Master Services Agreement');
    expect(item).not.toHaveProperty('label');
  });

  it('matches recipients on the NORMALIZED session email', async () => {
    h.rows.set(agreementRequests, [{ id: REQ, status: 'sent', label: null, templateVersionId: VERSION, sentAt: null, expiresAt: FUTURE }]);
    await app().request('/agreements');
    expect(JSON.stringify(h.wheres, (_k, v) => (typeof v === 'object' && v && 'table' in v ? undefined : v))).toContain('dana@customer.example');
  });

  it('an org with nothing pending → [] without any recipient or template read', async () => {
    const res = await app().request('/agreements');
    expect((await res.json()).data).toEqual([]);
    expect(h.wheres).toHaveLength(1);
  });
});

describe('GET /agreements/:id', () => {
  it.each([
    ['unknown id', null],
    // The org filter is in the query and RLS enforces it; a row for another
    // org reaching the handler anyway (a policy regression) is still the 404.
    ['a row for another org (RLS backstop)', { orgId: OTHER_ORG }],
  ])('%s → the 404', async (_label, over) => {
    if (over) h.rows.set(agreementRequests, [request(over)]);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.renderData).not.toHaveBeenCalled();
  });

  it.each([
    ['draft', { status: 'draft' }],
    ['voided', { status: 'voided', publicLinkRevokedAt: PAST }],
    ['link revoked', { publicLinkRevokedAt: PAST }],
    ['reaper-expired', { status: 'expired' }],
    ['past its expiry instant', { expiresAt: PAST }],
  ])('%s → the identical 404, nothing rendered or stamped', async (_label, over) => {
    h.rows.set(agreementRequests, [request(over)]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.renderData).not.toHaveBeenCalled();
    expect(m.markViewed).not.toHaveBeenCalled();
  });

  it('a recipient opening a sent request: rendered, canSign, stamped viewed (system tx)', async () => {
    h.rows.set(agreementRequests, [request()]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    h.rows.set(partners, [{ name: 'Best MSP', settings: {} }]);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.canSign).toBe(true);
    expect(data.request).toMatchObject({ id: REQ, status: 'viewed', coverMessage: 'Please sign' });
    // #10294: the label is staff-internal; the customer sees the template name.
    expect(data.request).not.toHaveProperty('label');
    expect(JSON.stringify(data)).not.toContain('HIPAA BAA');
    expect(data.html).toContain('Acme Dental');
    expect(data.parties).toEqual({ partnerName: 'Best MSP', orgName: 'Acme Dental' });
    expect(data.signedAgreementId).toBeNull();
    expect(m.markViewed).toHaveBeenCalledWith(REQ, ORG, expect.any(Date));
  });

  it('never leaks internal columns (the public DTO allow-list)', async () => {
    h.rows.set(agreementRequests, [request()]);
    const res = await app().request(`/agreements/${REQ}`);
    const text = await res.text();
    for (const leaked of ['variableValues', 'acceptTokenJti', 'jti-1', 'publicResponse', 'PO-1', 'templateVersionId']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('a colleague who is not a recipient sees it read-only and does not stamp it viewed', async () => {
    h.rows.set(agreementRequests, [request()]);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.canSign).toBe(false);
    expect(data.request.status).toBe('sent');
    expect(m.markViewed).not.toHaveBeenCalled();
  });

  it('a failed viewed stamp never fails the view', async () => {
    h.rows.set(agreementRequests, [request()]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    m.markViewed.mockRejectedValueOnce(new Error('deadlock'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.request.status).toBe('sent');
    expect(m.capture).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a signed request reads as history and names the signed agreement for the certified download', async () => {
    h.rows.set(agreementRequests, [request({ status: 'signed', signedAt: new Date('2026-10-21T09:00:00Z'), expiresAt: PAST })]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    h.rows.set(contractDocuments, [{ id: DOC }]);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.request).toMatchObject({ status: 'signed', signedAt: '2026-10-21T09:00:00.000Z' });
    expect(data.signedAgreementId).toBe(DOC);
    expect(m.markViewed).not.toHaveBeenCalled();
  });

  it('#10294: a signed request names the template as it was at signing, not the renamed live template', async () => {
    h.rows.set(agreementRequests, [request({ status: 'signed', signedAt: new Date('2026-10-21T09:00:00Z'), expiresAt: PAST })]);
    h.rows.set(agreementRequestRecipients, [{ requestId: REQ }]);
    h.rows.set(contractDocuments, [{ id: DOC, templateNameSnapshot: 'Business Associate Agreement' }]);
    m.renderData.mockResolvedValue(authoredRender({ templateName: 'BAA (renamed)' }));
    const { data } = await (await app().request(`/agreements/${REQ}`)).json();
    expect(data.template.name).toBe('Business Associate Agreement');
    expect(JSON.stringify(data)).not.toContain('renamed');
  });

  it('a signed request with no signed-agreement row is captured as an integrity fault (page still renders)', async () => {
    h.rows.set(agreementRequests, [request({ status: 'signed', signedAt: new Date('2026-10-21T09:00:00Z') })]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app().request(`/agreements/${REQ}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.signedAgreementId).toBeNull();
    expect(m.capture).toHaveBeenCalledWith(expect.any(Error), expect.anything(), { area: 'portal-agreements' });
    err.mockRestore();
  });

  it('a visible request whose pinned version is gone is an operator fault: captured 500, never the customer "not found"', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.renderData.mockRejectedValue(new ContractTemplateServiceError('Agreement template version not found', 404, 'VERSION_NOT_FOUND'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const path of [`/agreements/${REQ}`, `/agreements/${REQ}/file`]) {
      const res = await app().request(path);
      expect(res.status, path).toBe(500);
      expect((await res.json()).code).toBe('AGREEMENT_UNAVAILABLE');
    }
    const accept = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(accept.status).toBe(500);
    expect(m.accept).not.toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalledWith(expect.any(ContractTemplateServiceError), expect.anything(), { area: 'portal-agreements', code: 'VERSION_NOT_FOUND' });
    err.mockRestore();
  });

  it('an uploaded template points at the portal file route, never the public token route', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.renderData.mockResolvedValue(authoredRender({ sourceType: 'uploaded', bodyHtml: null }));
    const { data } = await (await app().request(`/agreements/${REQ}`)).json();
    expect(data.html).toBeNull();
    expect(data.fileUrl).toBe(`/portal/agreements/${REQ}/file`);
  });

  it('the logo falls back from org portal branding to the partner document brand', async () => {
    h.rows.set(agreementRequests, [request()]);
    h.rows.set(portalBranding, [{ logoUrl: 'https://cdn.example.test/logo.png', primaryColor: '#123456' }]);
    const { data } = await (await app().request(`/agreements/${REQ}`)).json();
    expect(data.branding.logoUrl).toBe('https://cdn.example.test/logo.png');
  });
});

describe('GET /agreements/:id/file', () => {
  it('uploaded → the PDF inline', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.renderData.mockResolvedValue(authoredRender({ sourceType: 'uploaded', bodyHtml: null, fileData: Buffer.from('%PDF-1.4 x') }));
    const res = await app().request(`/agreements/${REQ}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(m.renderData).toHaveBeenCalledWith(VERSION, { includeFileData: true });
  });

  it('authored (no file) → 404', async () => {
    h.rows.set(agreementRequests, [request()]);
    expect((await app().request(`/agreements/${REQ}/file`)).status).toBe(404);
  });

  it('a voided request → the 404 before any template read', async () => {
    h.rows.set(agreementRequests, [request({ status: 'voided', publicLinkRevokedAt: PAST })]);
    const res = await app().request(`/agreements/${REQ}/file`);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.renderData).not.toHaveBeenCalled();
  });
});

describe('POST /agreements/:id/accept', () => {
  const signed = { requestId: REQ, orgId: ORG, signedAgreementId: DOC, contentSha256: 'c', revoke: { jti: 'jti-1', tokenExpiresAt: FUTURE } };

  it('signs through the shared writer\'s PORTAL channel with the session identity, then the post-commit work', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockResolvedValue(signed);
    const res = await app().request(`/agreements/${REQ}/accept`, {
      ...json({ signerName: ' Dana Buyer ' }),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'portal-browser' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'signed', signedAt: expect.any(String), signedAgreementId: DOC } });
    expect(m.accept).toHaveBeenCalledWith(expect.objectContaining({
      portal: { requestId: REQ, orgId: ORG, email: SESSION_EMAIL },
      signerName: 'Dana Buyer',
      signerEmail: 'dana@customer.example',
      userAgent: 'portal-browser',
      renderData: expect.objectContaining({ templateVersionId: VERSION }),
    }));
    expect(m.accept.mock.calls[0]![0]).not.toHaveProperty('claims');
    expect(m.renderData).toHaveBeenCalledWith(VERSION, { includeFileData: true });
    expect(m.revoke).toHaveBeenCalledWith('jti-1', FUTURE);
    await vi.waitFor(() => {
      expect(m.notify).toHaveBeenCalledWith({ requestId: REQ, outcome: 'signed', source: 'customer', signerName: 'Dana Buyer' });
      expect(m.signedCopy).toHaveBeenCalledWith({ requestId: REQ, signedAgreementId: DOC, signerEmail: 'dana@customer.example' });
    });
  });

  it.each([
    ['unknown id', null],
    ['draft', { status: 'draft' }],
    ['voided', { status: 'voided', publicLinkRevokedAt: PAST }],
    ['expired', { expiresAt: PAST }],
  ])('%s → the 404, the writer never called', async (_label, over) => {
    if (over) h.rows.set(agreementRequests, [request(over)]);
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.accept).not.toHaveBeenCalled();
  });

  it.each([
    ['not a recipient / no recipient rows', new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND')],
    ['voided under the lock', new AgreementRequestServiceError('This agreement request was withdrawn', 410, 'LINK_REVOKED')],
    ['expired under the lock', new AgreementRequestServiceError('This agreement request has expired', 410, 'AGREEMENT_EXPIRED')],
  ])('writer says %s → the identical 404, no post-commit work', async (_label, err) => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockRejectedValue(err);
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.revoke).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.signedCopy).not.toHaveBeenCalled();
  });

  it('a recipient whose colleague already signed gets the honest 409', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockRejectedValue(new AgreementRequestServiceError('This agreement has already been signed', 409, 'AGREEMENT_ALREADY_SIGNED'));
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('AGREEMENT_ALREADY_SIGNED');
  });

  it('a blank typed name is refused by the validator before any read', async () => {
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: '   ' }));
    expect(res.status).toBe(400);
    expect(m.accept).not.toHaveBeenCalled();
  });

  it('no persisted link identity → nothing to revoke', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockResolvedValue({ ...signed, revoke: null });
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(res.status).toBe(200);
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it('a failed post-commit link revoke is captured and never fails the signature', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockResolvedValue(signed);
    m.revoke.mockRejectedValue(new Error('redis down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app().request(`/agreements/${REQ}/accept`, json({ signerName: 'Dana' }));
    expect(res.status).toBe(200);
    expect(m.capture).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('cookie sessions: the router\'s own CSRF guard on accept/decline', () => {
  const CSRF = 'csrf-token-1234567890';
  const post = (path: string, withCsrf: boolean) => app('cookie').request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(withCsrf ? { [CSRF_HEADER_NAME]: CSRF, cookie: `${PORTAL_CSRF_COOKIE_NAME}=${CSRF}` } : {}),
    },
    body: JSON.stringify({ signerName: 'Dana' }),
  });

  it.each(['accept', 'decline'])('POST %s without the double-submit token → 403, nothing read or written', async (action) => {
    h.rows.set(agreementRequests, [request()]);
    const res = await post(`/agreements/${REQ}/${action}`, false);
    expect(res.status).toBe(403);
    expect(m.accept).not.toHaveBeenCalled();
    expect(m.decline).not.toHaveBeenCalled();
    expect(m.renderData).not.toHaveBeenCalled();
  });

  it('with the matching token the signature goes through', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.accept.mockResolvedValue({ requestId: REQ, orgId: ORG, signedAgreementId: DOC, contentSha256: 'c', revoke: null });
    const res = await post(`/agreements/${REQ}/accept`, true);
    expect(res.status).toBe(200);
    expect(m.accept).toHaveBeenCalledTimes(1);
  });
});

describe('POST /agreements/:id/decline', () => {
  it('declines through the portal channel with the reason, then notifies', async () => {
    h.rows.set(agreementRequests, [request({ status: 'viewed' })]);
    m.decline.mockResolvedValue({ requestId: REQ, orgId: ORG, revoke: { jti: 'jti-1', tokenExpiresAt: FUTURE } });
    const res = await app().request(`/agreements/${REQ}/decline`, json({ reason: 'Wrong entity' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'declined' } });
    expect(m.decline).toHaveBeenCalledWith({ portal: { requestId: REQ, orgId: ORG, email: SESSION_EMAIL }, reason: 'Wrong entity', now: expect.any(Date) });
    expect(m.revoke).toHaveBeenCalledWith('jti-1', FUTURE);
    await vi.waitFor(() => expect(m.notify).toHaveBeenCalledWith({ requestId: REQ, outcome: 'declined', source: 'customer' }));
  });

  it('a non-recipient → the identical 404', async () => {
    h.rows.set(agreementRequests, [request()]);
    m.decline.mockRejectedValue(new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND'));
    const res = await app().request(`/agreements/${REQ}/decline`, json({}));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('a draft → the 404 before the writer', async () => {
    h.rows.set(agreementRequests, [request({ status: 'draft' })]);
    const res = await app().request(`/agreements/${REQ}/decline`, json({}));
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(m.decline).not.toHaveBeenCalled();
  });
});
