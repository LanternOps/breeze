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

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(), getEmailServiceMock: vi.fn() }));
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  getEmailService: getEmailServiceMock,
}));

import { db } from '../db';
import {
  createAgreementRequest,
  updateAgreementRequest,
  deleteAgreementRequest,
  getAgreementRequestDetail,
  sendAgreementRequest,
  remindAgreementRequest,
  autoRemindAgreementRequest,
  getAgreementRequestDefaults,
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
    orgId: ORG, templateId: TEMPLATE, recipients: ['jane@example.com', ' Jane@Example.com ', 'bob@example.com'],
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

  it('pins the latest published version (guarded against the ORG partner), defaults expiry from the PARTNER setting (#9075 W4a), dedupes recipients, filters manual values', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ id: VERSION }]);
    queue([{ agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: null, agreementMaxReminders: 3 }]); // partner defaults
    queue([row()]);               // insert request .returning()
    queue([]);                    // insert recipients
    queue([row()]);               // detail: load
    queueDetailTail(['bob@example.com', 'jane@example.com']);

    const res = await createAgreementRequest(auth, input, NOW);

    expect(assertUsableMock).toHaveBeenCalledWith({ templateId: TEMPLATE, templateVersionId: VERSION }, { orgId: ORG, partnerId: PARTNER });
    expect(inserted[0]).toMatchObject({
      orgId: ORG, status: 'draft', templateId: TEMPLATE, templateVersionId: VERSION, contractId: null,
      variableValues: { 'custom.po': 'PO-1' },
      expiresAt: new Date(NOW.getTime() + 14 * 24 * 3600 * 1000),
      createdBy: 'user-1',
    });
    expect(inserted[1]).toEqual([
      { requestId: REQ, orgId: ORG, email: 'jane@example.com' },
      { requestId: REQ, orgId: ORG, email: 'bob@example.com' },
    ]);
    expect(res.recipients).toEqual(['bob@example.com', 'jane@example.com']);
    expect(res).not.toHaveProperty('acceptTokenJti');
  });

  it('#9075 W4a: an unreadable partner row (org-scoped token) falls back to the built-in 30 days', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ id: VERSION }]);
    queue([]);                    // partner defaults: hidden by RLS
    queue([row()]);
    queue([]);
    queue([row()]);
    queueDetailTail(['bob@example.com', 'jane@example.com']);
    await createAgreementRequest(auth, input, NOW);
    expect(inserted[0]).toMatchObject({ expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000) });
  });

  it('#9075 W4a: an explicit expiresAt is the per-request override — the partner default is not read', async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ id: VERSION }]);
    queue([row()]);
    queue([]);
    queue([row()]);
    queueDetailTail(['bob@example.com', 'jane@example.com']);
    await createAgreementRequest(auth, { ...input, expiresAt: LATER }, NOW);
    expect(inserted[0]).toMatchObject({ expiresAt: LATER });
  });
});

describe('getAgreementRequestDefaults (#9075 W4a)', () => {
  it('an inaccessible org → 404 before any read', async () => {
    await expect(getAgreementRequestDefaults(auth, OTHER_ORG)).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it("resolves the org's OWNING partner's defaults", async () => {
    queue([{ partnerId: PARTNER }]);
    queue([{ agreementDefaultExpiryDays: 21, agreementReminderIntervalDays: 5, agreementMaxReminders: 1 }]);
    await expect(getAgreementRequestDefaults(auth, ORG)).resolves.toEqual({
      defaultExpiryDays: 21, autoReminder: { intervalDays: 5, maxReminders: 1 },
    });
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

  it('PATCH a draft writes under a status = draft guard and returns the detail', async () => {
    queue([row()]);
    queue([{ id: REQ }]);          // update .returning()
    queue([row({ label: 'BAA v2' })]);
    queueDetailTail();
    const res = await updateAgreementRequest(auth, REQ, { label: ' BAA v2 ' }, NOW);
    expect(updated[0]).toEqual({ updatedAt: NOW, label: 'BAA v2' });
    expect(res.label).toBe('BAA v2');
  });

  it('PATCH whose guarded update matches nothing (status changed under the lock) → 409, no recipients written', async () => {
    queue([row()]);
    queue([]);
    await expect(updateAgreementRequest(auth, REQ, { label: 'x', recipients: ['a@example.com'] }, NOW))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

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

    expect(typeof res.deliverEmail).toBe('function');
    expect(res.recipients).toEqual(['jane@example.com']);
    const prefix = 'https://portal.example.test/agreement/';
    expect(res.link.startsWith(prefix)).toBe(true);
    const claims = await verifyAgreementAcceptToken(decodeURIComponent(res.link.slice(prefix.length)));
    expect(claims).toEqual({ requestId: REQ, orgId: ORG, partnerId: PARTNER, jti: set.acceptTokenJti });
    expect(res.request).not.toHaveProperty('acceptTokenJti');
  });

  describe('deferred delivery (#9075 W2b)', () => {
    async function sendOk(coverMessage: string | null = 'Please sign by Friday') {
      queue([row({ coverMessage, label: 'BAA 2027' })]);
      queue([{ email: 'jane@example.com' }, { email: 'ops@example.com' }]);
      queue([orgRow]);
      queue([{ ...partnerRow, billingEmail: 'billing@example.com' }]);
      queue([row({ status: 'sent', sentAt: NOW, coverMessage, label: 'BAA 2027', clientNameSnapshot: 'Acme' })]);
      queue([{ emailSignature: 'The Best MSP team' }]);
      return sendAgreementRequest(auth, REQ, NOW);
    }

    beforeEach(() => {
      getEmailServiceMock.mockReset().mockReturnValue({ sendEmail: sendEmailMock });
      sendEmailMock.mockReset().mockResolvedValue(undefined);
    });

    it('send itself mails nothing — delivery runs only when the caller invokes it (after commit)', async () => {
      await sendOk();
      expect(getEmailServiceMock).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('delivers to the request recipients with the signing link; memoised (a second call mails nobody twice)', async () => {
      const res = await sendOk();
      const first = await res.deliverEmail();
      const second = await res.deliverEmail();
      expect(first).toEqual({ emailed: true });
      expect(second).toBe(first);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const env = sendEmailMock.mock.calls[0]![0];
      expect(env.to).toEqual(['jane@example.com', 'ops@example.com']);
      expect(env.purpose).toBe('agreement.sent');
      expect(env.partnerId).toBe(PARTNER);
      expect(env.replyTo).toBe('billing@example.com');
      // #10294: the label is staff-internal; the customer sees the template name.
      expect(env.subject).toContain('BAA');
      for (const part of [env.subject, env.html, env.text]) expect(part).not.toContain('BAA 2027');
      expect(env.html).toContain(res.link.replace(/&/g, '&amp;'));
      expect(env.html).toContain('Please sign by Friday');
      expect(env.text).toContain('The Best MSP team');
    });

    it('a transport failure → { emailed: false, emailReason: send_failed }, never rejects', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      sendEmailMock.mockRejectedValue(new Error('smtp down'));
      const res = await sendOk();
      await expect(res.deliverEmail()).resolves.toEqual({ emailed: false, emailReason: 'send_failed' });
      err.mockRestore();
    });

    it('no email service → { emailed: false, emailReason: no_email_service }', async () => {
      getEmailServiceMock.mockReturnValue(null);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await sendOk(null);
      await expect(res.deliverEmail()).resolves.toEqual({ emailed: false, emailReason: 'no_email_service' });
      warn.mockRestore();
    });
  });

  // Review finding: an organization-scope session cannot read the partners row
  // (partners RLS), which used to freeze a BLANK seller into the legal record.
  it('an unreadable sending partner → 422 SELLER_UNAVAILABLE, nothing minted or written', async () => {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([]); // partners row invisible in this RLS context
    await expect(sendAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 422, code: 'SELLER_UNAVAILABLE' });
    expect(db.update).not.toHaveBeenCalled();
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

  it('an unreproducible identity (signing kid rotated out) mints ONE replacement, conditionally, and says so', async () => {
    const stale = { acceptTokenJti: 'old-jti', acceptTokenIssuedAt: NOW, acceptTokenExpiresAt: LATER, acceptTokenKid: 'retired-kid' };
    queue([row({ status: 'sent', ...stale })]);
    queue([{ partnerId: PARTNER }]);
    queue([{ id: REQ }]); // conditional claim won
    const res = await getAgreementRequestLink(auth, REQ, NOW);
    expect(res.reissued).toBe(true);
    const set = updated[0]!;
    expect(set.acceptTokenJti).not.toBe('old-jti');
    expect(set.acceptTokenExpiresAt).toEqual(new Date(Math.floor(LATER.getTime() / 1000) * 1000));
    const claims = await verifyAgreementAcceptToken(decodeURIComponent(res.link.split('/agreement/')[1]!));
    expect(claims).toEqual({ requestId: REQ, orgId: ORG, partnerId: PARTNER, jti: set.acceptTokenJti });
  });

  it('losing the reissue race → 409 LINK_RACE, never an unrecorded credential', async () => {
    queue([row({ status: 'sent', acceptTokenJti: 'old-jti', acceptTokenIssuedAt: NOW, acceptTokenExpiresAt: LATER, acceptTokenKid: 'retired-kid' })]);
    queue([{ partnerId: PARTNER }]);
    queue([]); // another call already replaced the identity
    await expect(getAgreementRequestLink(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'LINK_RACE' });
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

describe('remindAgreementRequest (#9075 W3b)', () => {
  beforeEach(() => {
    getEmailServiceMock.mockReset().mockReturnValue({ sendEmail: sendEmailMock });
    sendEmailMock.mockReset().mockResolvedValue(undefined);
  });

  /** Send once to get a real persisted token identity, then reset the recorders. */
  async function sentIdentity() {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([row({ status: 'sent' })]);
    queue([{ emailSignature: null }]);
    const sent = await sendAgreementRequest(auth, REQ, NOW);
    const identity = updated[0]!;
    updated.length = 0;
    locks.length = 0;
    vi.mocked(db.update).mockClear();
    return { sent, identity };
  }

  function queueRemindReads(status: 'sent' | 'viewed', identity: Record<string, unknown>, recipients = ['jane@example.com', 'ops@example.com']) {
    queue([row({ status, reminderCount: 1, ...identity })]);
    queue(recipients.map((email) => ({ email })));
    queue([orgRow]);
    queue([{ ...partnerRow, billingEmail: 'billing@example.com' }]);
  }

  for (const status of ['sent', 'viewed'] as const) {
    it(`${status} → re-sends the SAME link (no new jti), bumps reminder_count + last_reminded_at, returns a deferred email`, async () => {
      const { sent, identity } = await sentIdentity();
      queueRemindReads(status, identity);
      queue([row({ status, reminderCount: 2, lastRemindedAt: NOW })]);
      queue([{ emailSignature: 'The Best MSP team' }]);
      const res = await remindAgreementRequest(auth, REQ, NOW);

      expect(locks).toEqual(['update']);
      expect(res.link).toBe(sent.link);
      expect(res.reissued).toBe(false);
      expect(res.recipients).toEqual(['jane@example.com', 'ops@example.com']);
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ lastRemindedAt: NOW, updatedAt: NOW });
      expect(updated[0]).not.toHaveProperty('acceptTokenJti');
      expect(updated[0]).toHaveProperty('reminderCount'); // SQL increment, never read-modify-write
      expect(res.request).toMatchObject({ reminderCount: 2 });
      expect(res.request).not.toHaveProperty('acceptTokenJti');
      expect(sendEmailMock).not.toHaveBeenCalled(); // post-commit only
    });
  }

  it('delivery uses the agreement_request_send template + the same signing link, memoised', async () => {
    const { sent, identity } = await sentIdentity();
    queueRemindReads('sent', identity);
    queue([row({ status: 'sent', reminderCount: 2, label: 'BAA 2027', clientNameSnapshot: 'Acme' })]);
    queue([{ emailSignature: 'The Best MSP team' }]);
    const res = await remindAgreementRequest(auth, REQ, NOW);
    const first = await res.deliverEmail();
    expect(first).toEqual({ emailed: true });
    expect(await res.deliverEmail()).toBe(first);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.purpose).toBe('agreement.sent');
    expect(env.to).toEqual(['jane@example.com', 'ops@example.com']);
    expect(env.html).toContain(sent.link.replace(/&/g, '&amp;'));
    // #10294: a reminder names the template, never the staff-internal label.
    for (const part of [env.subject, env.html, env.text]) expect(part).not.toContain('BAA 2027');
  });

  it('a draft → 409 (send it first)', async () => {
    queue([row()]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a signed request → 409 AGREEMENT_ALREADY_SIGNED', async () => {
    queue([row({ status: 'signed' })]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
  });

  for (const status of ['declined', 'voided', 'expired']) {
    it(`a ${status} request → 409 INVALID_STATE, nothing written`, async () => {
      queue([row({ status })]);
      await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('past expires_at → 410 AGREEMENT_EXPIRED (the reaper may not have run yet), nothing written', async () => {
    queue([row({ status: 'sent', expiresAt: new Date(NOW.getTime() - 1) })]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('no recipients → 422 RECIPIENTS_REQUIRED', async () => {
    const { identity } = await sentIdentity();
    queue([row({ status: 'sent', ...identity })]);
    queue([]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 422, code: 'RECIPIENTS_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('an unreadable sending partner → 422 SELLER_UNAVAILABLE, counter untouched', async () => {
    const { identity } = await sentIdentity();
    queue([row({ status: 'sent', ...identity })]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 422, code: 'SELLER_UNAVAILABLE' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a guarded update that matches nothing (status flipped under us) → 409, no email handed back', async () => {
    const { identity } = await sentIdentity();
    queueRemindReads('sent', identity);
    queue([]);
    await expect(remindAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('an unreproducible identity (kid rotated out) reissues ONE conditional replacement and says so', async () => {
    queue([row({ status: 'sent', acceptTokenJti: 'old-jti', acceptTokenIssuedAt: NOW, acceptTokenExpiresAt: LATER, acceptTokenKid: 'retired-kid' })]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([{ id: REQ }]); // conditional identity claim won
    queue([row({ status: 'sent', reminderCount: 1 })]);
    queue([{ emailSignature: null }]);
    const res = await remindAgreementRequest(auth, REQ, NOW);
    expect(res.reissued).toBe(true);
    expect(updated[0]!.acceptTokenJti).not.toBe('old-jti');
  });
});

/** The mocked chain's `.for()` (the real Drizzle db has no top-level `for`). */
const dbFor = () => (db as unknown as { for: ReturnType<typeof vi.fn> }).for;

describe('autoRemindAgreementRequest (#9075 W4a — the automatic path through the same remind core)', () => {
  const DAY = 24 * 3600 * 1000;
  const SENT_AT = new Date(NOW.getTime() - 5 * DAY);
  const ON = { agreementDefaultExpiryDays: 30, agreementReminderIntervalDays: 3, agreementMaxReminders: 2 };

  beforeEach(() => {
    getEmailServiceMock.mockReset().mockReturnValue({ sendEmail: sendEmailMock });
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    dbFor().mockClear();
  });

  async function sentIdentity() {
    queue([row()]);
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([row({ status: 'sent' })]);
    queue([{ emailSignature: null }]);
    const sent = await sendAgreementRequest(auth, REQ, NOW);
    const identity = updated[0]!;
    updated.length = 0;
    locks.length = 0;
    vi.mocked(db.update).mockClear();
    dbFor().mockClear();
    return { sent, identity };
  }

  it('a due request: locks it SKIP LOCKED, re-checks due-ness, re-sends the SAME link and bumps the counter', async () => {
    const { sent, identity } = await sentIdentity();
    queue([row({ ...identity, status: 'viewed', sentAt: SENT_AT, reminderCount: 0 })]); // locked row
    queue([{ partnerId: PARTNER }]);
    queue([ON]);                                                                       // partner defaults
    queue([{ email: 'jane@example.com' }]);
    queue([orgRow]);
    queue([partnerRow]);
    queue([row({ status: 'viewed', reminderCount: 1, lastRemindedAt: NOW })]);
    queue([{ emailSignature: null }]);

    const out = await autoRemindAgreementRequest(REQ, NOW);

    expect(dbFor()).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(out.reminded).toBe(true);
    if (!out.reminded) throw new Error('unreachable');
    expect(out.result.link).toBe(sent.link);
    expect(out.result.request).toMatchObject({ reminderCount: 1 });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ lastRemindedAt: NOW });
    expect(sendEmailMock).not.toHaveBeenCalled(); // post-commit only
    await out.result.deliverEmail();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('a row another worker holds (or that is gone) is skipped, nothing written', async () => {
    queue([]);
    await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'locked_or_gone' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('not due on the locked row (a manual remind just reset the clock) → skipped', async () => {
    queue([row({ status: 'sent', sentAt: SENT_AT, lastRemindedAt: new Date(NOW.getTime() - DAY), reminderCount: 1 })]);
    queue([{ partnerId: PARTNER }]);
    queue([ON]);
    await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'not_due' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('the partner turned automatic reminders off → skipped', async () => {
    queue([row({ status: 'sent', sentAt: SENT_AT })]);
    queue([{ partnerId: PARTNER }]);
    queue([{ ...ON, agreementReminderIntervalDays: null }]);
    await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'not_due' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('the cap is reached (manual reminders count) → skipped', async () => {
    queue([row({ status: 'sent', sentAt: SENT_AT, reminderCount: 2 })]);
    queue([{ partnerId: PARTNER }]);
    queue([ON]);
    await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'not_due' });
    expect(db.update).not.toHaveBeenCalled();
  });

  for (const status of ['draft', 'signed', 'declined', 'voided', 'expired']) {
    it(`a ${status} request is never reminded`, async () => {
      queue([row({ status, sentAt: SENT_AT })]);
      queue([{ partnerId: PARTNER }]);
      queue([ON]);
      await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'not_due' });
      expect(db.update).not.toHaveBeenCalled();
    });
  }

  it('an expired-but-unreaped request is never reminded', async () => {
    queue([row({ status: 'sent', sentAt: SENT_AT, expiresAt: NOW })]);
    queue([{ partnerId: PARTNER }]);
    queue([ON]);
    await expect(autoRemindAgreementRequest(REQ, NOW)).resolves.toEqual({ reminded: false, reason: 'not_due' });
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

  it('a void whose guarded update matches nothing → 409, no revoke handed back', async () => {
    queue([row({ status: 'sent', acceptTokenJti: 'jti-1' })]);
    queue([]);
    await expect(voidAgreementRequest(auth, REQ, {}, NOW)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
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

  it('a draft preview with an unreadable sending partner → 422 SELLER_UNAVAILABLE (never a blank seller)', async () => {
    queue([row()]);
    queue([orgRow]);
    queue([]);
    await expect(previewAgreementRequest(auth, REQ, NOW)).rejects.toMatchObject({ status: 422, code: 'SELLER_UNAVAILABLE' });
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
