import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Staff lifecycle of a standalone agreement request (#9075 W2a, spec §3.5 /
// §5). Controllable Drizzle chain (agreementRequestService.test.ts idiom):
// awaiting a select / delete / insert-without-returning shifts the next queued
// result; `.returning()` resolves the next queued result; every insert / update
// payload is recorded.
const queued: unknown[][] = [];
const inserted: unknown[] = [];
const updated: Array<Record<string, unknown>> = [];
const locks: string[] = [];
function queue(rows: unknown[]) { queued.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn((v: unknown) => { inserted.push(v); return chain; });
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn((v: Record<string, unknown>) => { updated.push(v); return chain; });
  chain.delete = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(queued.shift() ?? []));
  chain.for = vi.fn((mode: string) => { locks.push(mode); return chain; });
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve, reject);
  return { db: chain };
});

const loadRenderDataMock = vi.fn();
vi.mock('./contractTemplateRender', async (importActual) => ({
  ...(await importActual<typeof import('./contractTemplateRender')>()),
  loadTemplateVersionRenderData: (...args: unknown[]) => loadRenderDataMock(...args),
}));

const assertUsableMock = vi.fn();
vi.mock('./contractTemplateService', async (importActual) => ({
  ...(await importActual<typeof import('./contractTemplateService')>()),
  assertTemplateVersionUsable: (...args: unknown[]) => assertUsableMock(...args),
}));

vi.mock('./portalUrl', () => ({ portalBase: () => 'https://portal.example.test' }));

import { db } from '../db';
import {
  createAgreementRequest,
  updateAgreementRequest,
  deleteAgreementRequest,
  getAgreementRequestDetail,
  sendAgreementRequest,
  getAgreementRequestLink,
  voidAgreementRequest,
  previewAgreementRequest,
  buildAgreementSigningUrl,
  renderAgreementRequestHtml,
} from './agreementRequestLifecycle';
import { verifyAgreementAcceptToken } from './agreementAcceptToken';
import type { TemplateVersionRenderData } from './contractTemplateRender';
import type { AuthContext } from '../middleware/auth';

beforeAll(() => { process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123'; });

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const VERSION = '22222222-2222-4222-8222-222222222222';
const CONTRACT = '33333333-3333-4333-8333-333333333333';
const REQ = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const LATER = new Date('2026-11-24T12:00:00.000Z');

const auth = {
  user: { id: 'user-1' },
  partnerId: PARTNER,
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
} as unknown as AuthContext;

function renderData(over: Partial<TemplateVersionRenderData> = {}): TemplateVersionRenderData {
  return {
    templateId: TEMPLATE,
    templateVersionId: VERSION,
    sourceType: 'authored',
    bodyHtml: '<p>{{client.name}} PO {{custom.po}}</p>',
    fileData: null,
    versionSha256: 'vsha',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'custom.po', kind: 'manual' }] as TemplateVersionRenderData['declaredVariables'],
    templateName: 'BAA',
    versionNumber: 3,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: REQ, orgId: ORG, status: 'draft', templateId: TEMPLATE, templateVersionId: VERSION, contractId: null,
    publicLinkRevokedAt: null, label: 'BAA', coverMessage: null, variableValues: { 'custom.po': 'PO-1' },
    clientNameSnapshot: null, clientAddressSnapshot: null, sellerSnapshot: null, documentLocale: null, renderLocale: null,
    effectiveDate: null, expiresAt: LATER, sentAt: null, firstViewedAt: null, signedAt: null, declinedAt: null,
    voidedAt: null, expiredAt: null, declineReason: null, voidReason: null,
    acceptTokenJti: null, acceptTokenIssuedAt: null, acceptTokenExpiresAt: null, acceptTokenKid: null,
    publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    reminderCount: 0, lastRemindedAt: null, createdBy: 'user-1', voidedBy: null,
    createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

const orgRow = {
  id: ORG, name: 'Acme', partnerId: PARTNER,
  billingAddressLine1: '1 Main St', billingAddressLine2: null, billingAddressCity: 'Springfield',
  billingAddressRegion: 'IL', billingAddressPostalCode: '62701', billingAddressCountry: 'US',
};
const partnerRow = { name: 'Best MSP', settings: {} };

/** Detail reads after the load: recipients, template names, signed agreement. */
function queueDetailTail(recipients: string[] = ['jane@example.com']) {
  queue(recipients.map((email) => ({ email })));
  queue([{ templateName: 'BAA', versionNumber: 3 }]);
  queue([]);
}

beforeEach(() => {
  queued.length = 0;
  inserted.length = 0;
  updated.length = 0;
  locks.length = 0;
  vi.mocked(db.insert).mockClear();
  vi.mocked(db.update).mockClear();
  vi.mocked(db.delete).mockClear();
  loadRenderDataMock.mockReset().mockResolvedValue(renderData());
  assertUsableMock.mockReset().mockResolvedValue(undefined);
});

describe('org scoping: a request in an org the caller cannot access is a 404, never a 403', () => {
  it('detail', async () => {
    queue([row({ orgId: OTHER_ORG })]);
    await expect(getAgreementRequestDetail(auth, REQ)).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });
  it('missing row', async () => {
    queue([]);
    await expect(getAgreementRequestDetail(auth, REQ)).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });
  it('send, void and link take the same 404', async () => {
    for (const fn of [
      () => sendAgreementRequest(auth, REQ, NOW),
      () => voidAgreementRequest(auth, REQ, {}, NOW),
      () => getAgreementRequestLink(auth, REQ, NOW),
    ]) {
      queue([row({ orgId: OTHER_ORG, status: 'sent' })]);
      await expect(fn()).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    }
  });
});

describe('createAgreementRequest', () => {
  const input = {
    orgId: ORG, templateId: TEMPLATE, recipients: ['jane@example.com', 'jane@example.com', 'bob@example.com'],
    variableValues: { 'custom.po': 'PO-1', 'client.name': 'Spoofed', 'undeclared': 'x' },
  };

  it('an org the caller cannot access → 404 ORG_NOT_FOUND before any read', async () => {
    await expect(createAgreementRequest(auth, { ...input, orgId: OTHER_ORG }, NOW)).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('an expiresAt that is not in the future → 400 EXPIRES_AT_IN_PAST', async () => {
    await expect(createAgreementRequest(auth, { ...input, expiresAt: NOW }, NOW)).rejects.toMatchObject({ status: 400, code: 'EXPIRES_AT_IN_PAST' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('no published version → 422 VERSION_NOT_PUBLISHED, nothing inserted', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([]);
    await expect(createAgreementRequest(auth, input, NOW)).rejects.toMatchObject({ status: 422, code: 'VERSION_NOT_PUBLISHED' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('a contract in another org → 404 CONTRACT_NOT_FOUND, nothing inserted', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ id: VERSION }]);
    queue([{ id: CONTRACT, orgId: OTHER_ORG }]);
    await expect(createAgreementRequest(auth, { ...input, contractId: CONTRACT }, NOW)).rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('pins the latest published version (guarded against the ORG partner), defaults expiry to now + 30 days, dedupes recipients, filters manual values', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ id: VERSION }]);
    queue([row()]);               // insert request .returning()
    queue([]);                    // insert recipients
    queue([row()]);               // detail: load
    queueDetailTail(['bob@example.com', 'jane@example.com']);

    const res = await createAgreementRequest(auth, input, NOW);

    expect(assertUsableMock).toHaveBeenCalledWith({ templateId: TEMPLATE, templateVersionId: VERSION }, { orgId: ORG, partnerId: PARTNER });
    expect(inserted[0]).toMatchObject({
      orgId: ORG, status: 'draft', templateId: TEMPLATE, templateVersionId: VERSION, contractId: null,
      variableValues: { 'custom.po': 'PO-1' },
      expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
      createdBy: 'user-1',
    });
    expect(inserted[1]).toEqual([
      { requestId: REQ, orgId: ORG, email: 'jane@example.com' },
      { requestId: REQ, orgId: ORG, email: 'bob@example.com' },
    ]);
    expect(res.recipients).toEqual(['bob@example.com', 'jane@example.com']);
    expect(res).not.toHaveProperty('acceptTokenJti');
  });
});

describe('draft-only edits', () => {
  for (const status of ['sent', 'viewed', 'signed', 'declined', 'voided', 'expired']) {
    it(`PATCH on a ${status} request → 409, nothing written`, async () => {
      queue([row({ status })]);
      await expect(updateAgreementRequest(auth, REQ, { label: 'x' }, NOW)).rejects.toMatchObject({ status: 409 });
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('PATCH locks the row', async () => {
    queue([row({ status: 'sent' })]);
    await expect(updateAgreementRequest(auth, REQ, { label: 'x' }, NOW)).rejects.toMatchObject({ status: 409 });
    expect(locks).toEqual(['update']);
  });

  it('DELETE a signed request → 409 AGREEMENT_ALREADY_SIGNED', async () => {
    queue([row({ status: 'signed' })]);
    await expect(deleteAgreementRequest(auth, REQ)).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
    expect(db.delete).not.toHaveBeenCalled();
  });

  for (const status of ['sent', 'viewed', 'declined', 'voided', 'expired']) {
    it(`DELETE a ${status} request → 409 INVALID_STATE`, async () => {
      queue([row({ status })]);
      await expect(deleteAgreementRequest(auth, REQ)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
      expect(db.delete).not.toHaveBeenCalled();
    });
  }

  it('DELETE a draft deletes it', async () => {
    queue([row()]);
    queue([]);
    await expect(deleteAgreementRequest(auth, REQ)).resolves.toEqual({ id: REQ, orgId: ORG });
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe('sendAgreementRequest', () => {
  for (const status of ['sent', 'viewed', 'signed', 'declined', 'voided', 'expired']) {
    it(`a ${status} request → 409 (resend is remind, W3b)`, async () => {
      queue([row({ status })]);
      await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409 });
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('expired at the instant boundary (now == expires_at) → 410 AGREEMENT_EXPIRED', async () => {
    queue([row({ expiresAt: NOW })]);
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('no recipients → 422 RECIPIENTS_REQUIRED', async () => {
    queue([row()]);
    queue([]);
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 422, code: 'RECIPIENTS_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a template guard rejection (archived since the draft) propagates, nothing written', async () => {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    assertUsableMock.mockRejectedValueOnce(Object.assign(new Error('archived'), { status: 422, code: 'TEMPLATE_ARCHIVED' }));
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('unresolved variables → 422 naming them, nothing written (quote-only keys are absent on a request)', async () => {
    loadRenderDataMock.mockResolvedValueOnce(renderData({
      declaredVariables: [{ name: 'totals.monthly', kind: 'auto' }, { name: 'custom.po', kind: 'manual' }, { name: 'custom.site', kind: 'manual' }] as TemplateVersionRenderData['declaredVariables'],
    }));
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({
      status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED', message: 'Agreement variables unresolved: custom.site, totals.monthly',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('draft → sent: snapshots, persisted token identity (exp = expires_at), sent_at; returns { emailed: false, link }', async () => {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([row({ status: 'sent', sentAt: NOW })]);

    const res = await sendAgreementRequest(auth, REQ, NOW);

    expect(locks).toEqual(['update']);
    const set = updated[0]!;
    expect(set).toMatchObject({
      status: 'sent', sentAt: NOW, updatedAt: NOW,
      clientNameSnapshot: 'Acme', sellerSnapshot: expect.objectContaining({ name: 'Best MSP' }), renderLocale: 'en',
      acceptTokenExpiresAt: new Date(Math.floor(LATER.getTime() / 1000) * 1000),
    });
    expect(typeof set.acceptTokenJti).toBe('string');
    expect(set.acceptTokenIssuedAt).toBeInstanceOf(Date);

    expect(res.emailed).toBe(false);
    expect(res.recipients).toEqual(['jane@example.com']);
    const prefix = 'https://portal.example.test/agreement/';
    expect(res.link.startsWith(prefix)).toBe(true);
    const claims = await verifyAgreementAcceptToken(decodeURIComponent(res.link.slice(prefix.length)));
    expect(claims).toEqual({ requestId: REQ, orgId: ORG, partnerId: PARTNER, jti: set.acceptTokenJti });
    expect(res.request).not.toHaveProperty('acceptTokenJti');
  });

  it('a concurrent send that already flipped the row → 409, no link returned', async () => {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([]); // conditional update matched nothing
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});

describe('getAgreementRequestLink', () => {
  it('a draft → 409 (send it first)', async () => {
    queue([row()]);
    await expect(getAgreementRequestLink(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  for (const status of ['signed', 'declined', 'voided', 'expired']) {
    it(`a ${status} request → 409`, async () => {
      queue([row({ status })]);
      await expect(getAgreementRequestLink(auth, REQ, NOW)).rejects.toMatchObject({ status: 409 });
    });
  }

  it('past expires_at → 410 AGREEMENT_EXPIRED (no credential for an expired request)', async () => {
    queue([row({ status: 'sent', expiresAt: new Date(NOW.getTime() - 1) })]);
    await expect(getAgreementRequestLink(auth, REQ, NOW)).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
  });

  it('regenerates the SAME link send handed out, writing nothing', async () => {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([row({ status: 'sent' })]);
    const sent = await sendAgreementRequest(auth, REQ, NOW);
    const set = updated[0]!;
    vi.mocked(db.update).mockClear();

    queue([row({ status: 'viewed', ...set })]);
    queue([{ partnerId: PARTNER }]);
    const res = await getAgreementRequestLink(auth, REQ, NOW);
    expect(res).toEqual({ link: sent.link, reissued: false, orgId: ORG });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('voidAgreementRequest', () => {
  it('a signed request → 409 AGREEMENT_ALREADY_SIGNED', async () => {
    queue([row({ status: 'signed' })]);
    await expect(voidAgreementRequest(auth, REQ, {}, NOW)).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  for (const status of ['draft', 'declined', 'voided', 'expired']) {
    it(`a ${status} request → 409 INVALID_STATE`, async () => {
      queue([row({ status })]);
      await expect(voidAgreementRequest(auth, REQ, {}, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('sent → voided: reason, voided_by, voided_at, public_link_revoked_at = now; hands back the jti for the post-commit revoke', async () => {
    const tokenExp = new Date(Math.floor(LATER.getTime() / 1000) * 1000);
    queue([row({ status: 'viewed', acceptTokenJti: 'jti-1', acceptTokenExpiresAt: tokenExp })]);
    queue([row({ status: 'voided', voidReason: 'wrong client', acceptTokenJti: 'jti-1' })]);
    const res = await voidAgreementRequest(auth, REQ, { reason: 'wrong client' }, NOW);
    expect(locks).toEqual(['update']);
    expect(updated[0]).toEqual({
      status: 'voided', voidReason: 'wrong client', voidedBy: 'user-1', voidedAt: NOW, publicLinkRevokedAt: NOW, updatedAt: NOW,
    });
    expect(res.revoke).toEqual({ jti: 'jti-1', tokenExpiresAt: tokenExp });
    expect(res.request).not.toHaveProperty('acceptTokenJti');
  });

  it('a request already past expires_at can still be voided (void only ever narrows access)', async () => {
    queue([row({ status: 'sent', expiresAt: new Date(NOW.getTime() - 1000), acceptTokenJti: 'jti-2' })]);
    queue([row({ status: 'voided' })]);
    await expect(voidAgreementRequest(auth, REQ, {}, NOW)).resolves.toMatchObject({ revoke: { jti: 'jti-2' } });
  });
});

describe('preview + the shared HTML render', () => {
  it('renders substituted, sanitized HTML and reports unresolved variables (blanked, never a raw token)', async () => {
    queue([row({ variableValues: {} })]);
    queue([orgRow]);
    queue([partnerRow]);
    const res = await previewAgreementRequest(auth, REQ, NOW);
    expect(res).toMatchObject({ sourceType: 'authored', templateName: 'BAA', versionNumber: 3, unresolved: ['custom.po'] });
    expect(res.html).toBe('<p>Acme PO </p>');
  });

  it('renderAgreementRequestHtml escapes values and strips a javascript: href', () => {
    const html = renderAgreementRequestHtml('<a href="{{custom.link}}">{{custom.name}}</a>', { 'custom.link': 'javascript:alert(1)', 'custom.name': '<b>x</b>' });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('buildAgreementSigningUrl points at the portal /agreement/<token> path', () => {
    expect(buildAgreementSigningUrl('a.b/c')).toBe('https://portal.example.test/agreement/a.b%2Fc');
  });
});
