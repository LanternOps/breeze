import { describe, it, expect, vi, beforeEach } from 'vitest';

// Customer accept / decline of a standalone agreement request (#9075 W2a,
// spec §3.3 steps 1–8). Controllable Drizzle chain: awaiting a select shifts
// the next queued result; `.returning()` resolves the next queued result;
// every update payload is recorded, in order with the freeze call, so
// "freeze inside the tx, before the status flip commits" is observable.
const queued: unknown[][] = [];
const events: string[] = [];
const updated: Array<Record<string, unknown>> = [];
const locks: string[] = [];
function queue(rows: unknown[]) { queued.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => { events.push('update'); return chain; });
  chain.set = vi.fn((v: Record<string, unknown>) => { updated.push(v); return chain; });
  chain.returning = vi.fn(() => Promise.resolve(queued.shift() ?? []));
  chain.for = vi.fn((mode: string) => { locks.push(mode); return chain; });
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve, reject);
  return { db: chain };
});

const freezeMock = vi.fn();
vi.mock('./contractDocumentService', async (importActual) => ({
  ...(await importActual<typeof import('./contractDocumentService')>()),
  freezeSignedAgreement: (...args: unknown[]) => { events.push('freeze'); return freezeMock(...args); },
}));

const captureMock = vi.fn();
vi.mock('./acceptanceProvider', () => ({ getAcceptanceProvider: () => ({ kind: 'builtin', capture: captureMock }) }));

import { db } from '../db';
import { acceptAgreementRequest, declineAgreementRequest, type AcceptAgreementRequestParams } from './agreementRequestAcceptService';
import { computeAgreementSha256 } from './agreementContentHash';
import type { TemplateVersionRenderData } from './contractTemplateRender';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const VERSION = '22222222-2222-4222-8222-222222222222';
const CONTRACT = '33333333-3333-4333-8333-333333333333';
const REQ = '55555555-5555-4555-8555-555555555555';
const JTI = 'jti-current';
const EXPIRES = new Date('2026-11-24T12:00:00.000Z');
const NOW = new Date('2026-10-25T12:00:00.000Z');

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
    id: REQ, orgId: ORG, status: 'sent', templateId: TEMPLATE, templateVersionId: VERSION, contractId: CONTRACT,
    publicLinkRevokedAt: null, label: 'BAA 2026', variableValues: { 'custom.po': 'PO-1' },
    clientNameSnapshot: 'Acme', clientAddressSnapshot: null, sellerSnapshot: { name: 'Best MSP' },
    documentLocale: null, renderLocale: 'en', effectiveDate: null, expiresAt: EXPIRES,
    acceptTokenJti: JTI, acceptTokenExpiresAt: EXPIRES,
    publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    ...over,
  };
}

function params(over: Partial<AcceptAgreementRequestParams> = {}): AcceptAgreementRequestParams {
  return {
    claims: { requestId: REQ, orgId: ORG, jti: JTI },
    renderData: renderData(),
    signerName: '  Dana Buyer ',
    signerEmail: 'dana@customer.example',
    ipAddress: '198.51.100.7',
    userAgent: 'customer-browser',
    now: NOW,
    ...over,
  };
}

beforeEach(() => {
  queued.length = 0;
  events.length = 0;
  updated.length = 0;
  locks.length = 0;
  vi.mocked(db.update).mockClear();
  freezeMock.mockReset().mockResolvedValue({ id: 'sa-1', sha256: 'pdfsha' });
  captureMock.mockReset().mockImplementation(async (i: { signerName: string; signerEmail?: string | null }) => ({
    signerName: i.signerName.trim(), signerEmail: i.signerEmail ?? null, method: 'typed-signature',
  }));
});

describe('acceptAgreementRequest — refusals freeze nothing and write nothing', () => {
  it('locks the request row first (FOR UPDATE serialises double-submit)', async () => {
    queue([row()]);
    queue([row({ status: 'signed' })]);
    await acceptAgreementRequest(params());
    expect(locks).toEqual(['update']);
  });

  it('missing row → 404', async () => {
    queue([]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });

  it('a row in an org the token does not name → the same 404', async () => {
    queue([row({ orgId: OTHER_ORG })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });

  it('a merged-away org listed by the caller is accepted', async () => {
    queue([row({ orgId: OTHER_ORG })]);
    queue([row({ status: 'signed' })]);
    await expect(acceptAgreementRequest(params({ allowedOrgIds: [ORG, OTHER_ORG] }))).resolves.toMatchObject({ signedAgreementId: 'sa-1' });
  });

  // Durable single-use (spec §3.3 step 2): checked BEFORE the status guard so
  // a replay 401s exactly like the Redis gate, even when the marker was lost.
  it('replay: this jti already consumed on the row → 401 RESPONSE_CONSUMED, before the status guard', async () => {
    queue([row({ status: 'signed', publicResponseJti: JTI, publicResponseConsumedAt: NOW, publicResponseOutcome: 'accepted' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
    expect(events).toEqual([]);
  });

  it('accept after a decline with the same (shared) link → 401 RESPONSE_CONSUMED', async () => {
    queue([row({ status: 'declined', publicResponseJti: JTI, publicResponseConsumedAt: NOW, publicResponseOutcome: 'declined' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
  });

  it('a token whose jti is not the request\'s persisted link → 401 (a superseded credential)', async () => {
    queue([row({ acceptTokenJti: 'jti-reissued' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
    expect(events).toEqual([]);
  });

  it('a revoked link (void) → 410 LINK_REVOKED, before the status guard', async () => {
    queue([row({ status: 'voided', publicLinkRevokedAt: NOW })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 410, code: 'LINK_REVOKED' });
    expect(events).toEqual([]);
  });

  it('a draft is refused on the customer path (no link was ever sent)', async () => {
    queue([row({ status: 'draft' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(events).toEqual([]);
  });

  it('an already-signed request → 409 AGREEMENT_ALREADY_SIGNED (another recipient won)', async () => {
    queue([row({ status: 'signed', publicResponseJti: 'other', publicResponseConsumedAt: NOW })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
  });

  it('a declined request → 409', async () => {
    queue([row({ status: 'declined' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 409 });
  });

  it('a request the reaper already expired → 410 AGREEMENT_EXPIRED', async () => {
    queue([row({ status: 'expired' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
  });

  it('expiry at the instant boundary: now == expires_at → 410', async () => {
    queue([row({ expiresAt: NOW })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
    expect(events).toEqual([]);
  });

  it('expiry at the instant boundary: 1 ms before expires_at is accepted', async () => {
    queue([row({ expiresAt: new Date(NOW.getTime() + 1) })]);
    queue([row({ status: 'signed' })]);
    await expect(acceptAgreementRequest(params())).resolves.toMatchObject({ signedAgreementId: 'sa-1' });
  });

  it('a blank signer name → 400 INVALID_SIGNER_NAME, before capture', async () => {
    queue([row()]);
    await expect(acceptAgreementRequest(params({ signerName: '   ' }))).rejects.toMatchObject({ status: 400, code: 'INVALID_SIGNER_NAME' });
    expect(captureMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('pre-fetched render data for another version → 500, never freezes the wrong template', async () => {
    queue([row()]);
    await expect(acceptAgreementRequest(params({ renderData: renderData({ templateVersionId: 'v-other' }) })))
      .rejects.toMatchObject({ status: 500, code: 'RENDER_DATA_MISMATCH' });
    expect(events).toEqual([]);
  });

  it('unresolved variables are refused BEFORE the freeze (nothing inserted)', async () => {
    queue([row({ variableValues: {} })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({
      status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED', message: 'Agreement variables unresolved: custom.po',
    });
    expect(events).toEqual([]);
  });

  it('a freeze failure propagates (the caller tx rolls the status flip back)', async () => {
    queue([row()]);
    freezeMock.mockRejectedValueOnce(new Error('pdf render failed'));
    await expect(acceptAgreementRequest(params())).rejects.toThrow('pdf render failed');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

describe('acceptAgreementRequest — success', () => {
  it('freezes inside the tx with customer evidence, then flips to signed and consumes the jti in the same tx', async () => {
    queue([row()]);
    queue([row({ status: 'signed' })]);

    const res = await acceptAgreementRequest(params());

    expect(events).toEqual(['freeze', 'update']);
    const freezeArg = freezeMock.mock.calls[0]![0];
    const contentSha256 = computeAgreementSha256({
      kind: 'rendered',
      versionSha: 'vsha',
      vars: {
        'client.name': 'Acme',
        'client.address': '',
        'seller.name': 'Best MSP',
        'dates.effective': 'Oct 25, 2026',
        'custom.po': 'PO-1',
      },
      renderLocale: 'en',
      effectiveDate: '2026-10-25',
    });
    expect(freezeArg).toMatchObject({
      source: { kind: 'request', agreementRequestId: REQ, label: 'BAA 2026' },
      orgId: ORG,
      contractId: CONTRACT,
      templateId: TEMPLATE,
      templateVersionId: VERSION,
      manualValues: { 'custom.po': 'PO-1' },
      allowUnresolvedFallback: false,
      evidence: {
        signerName: 'Dana Buyer',
        signerEmail: 'dana@customer.example',
        signedAt: NOW,
        signerIp: '198.51.100.7',
        signerUserAgent: 'customer-browser',
        acceptanceOrigin: 'customer',
        acceptanceMethod: 'typed-signature',
        acceptanceReference: null,
        recordedByUserId: null,
        contentSha256,
        contentHashVersion: 1,
        acceptanceRenderLocale: 'en',
      },
    });
    expect(freezeArg.externalBytes).toBeUndefined();

    expect(updated[0]).toEqual({
      status: 'signed',
      signedAt: NOW,
      // Resolved effective date persisted, so the row alone reproduces the hash input.
      effectiveDate: '2026-10-25',
      publicResponseJti: JTI,
      publicResponseConsumedAt: NOW,
      publicResponseOutcome: 'accepted',
      updatedAt: NOW,
    });
    expect(res).toEqual({
      requestId: REQ, orgId: ORG, signedAgreementId: 'sa-1', contentSha256,
      revoke: { jti: JTI, tokenExpiresAt: EXPIRES },
    });
  });

  it('a sender-set effective date is kept (not replaced by the signing day)', async () => {
    queue([row({ effectiveDate: '2026-11-01' })]);
    queue([row({ status: 'signed' })]);
    await acceptAgreementRequest(params());
    expect(updated[0]!.effectiveDate).toBe('2026-11-01');
    expect(freezeMock.mock.calls[0]![0].ctx.effectiveDate).toBe('2026-11-01');
  });

  it('a viewed request can be signed', async () => {
    queue([row({ status: 'viewed' })]);
    queue([row({ status: 'signed' })]);
    await expect(acceptAgreementRequest(params())).resolves.toMatchObject({ signedAgreementId: 'sa-1' });
  });

  // First committed response wins (OD5). Sequenced: the second caller blocks on
  // the row lock, then re-reads the row the first one committed.
  it('first response wins: a second accept on the same link after the first commit → 401, one freeze', async () => {
    queue([row()]);
    queue([row({ status: 'signed' })]);
    await acceptAgreementRequest(params());

    queue([row({ status: 'signed', publicResponseJti: JTI, publicResponseConsumedAt: NOW, publicResponseOutcome: 'accepted' })]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
    expect(freezeMock).toHaveBeenCalledTimes(1);
  });

  it('a lost conditional status flip (the row changed under the lock) → 409, not a silent success', async () => {
    queue([row()]);
    queue([]);
    await expect(acceptAgreementRequest(params())).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});

describe('declineAgreementRequest', () => {
  const dparams = (over: Record<string, unknown> = {}) => ({ claims: { requestId: REQ, orgId: ORG, jti: JTI }, reason: '  not now ', now: NOW, ...over });

  it('replay → 401 before the status guard', async () => {
    queue([row({ status: 'declined', publicResponseJti: JTI, publicResponseConsumedAt: NOW })]);
    await expect(declineAgreementRequest(dparams())).rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
  });

  it('revoked → 410', async () => {
    queue([row({ status: 'voided', publicLinkRevokedAt: NOW })]);
    await expect(declineAgreementRequest(dparams())).rejects.toMatchObject({ status: 410, code: 'LINK_REVOKED' });
  });

  it('signed → 409 AGREEMENT_ALREADY_SIGNED', async () => {
    queue([row({ status: 'signed', publicResponseJti: 'other', publicResponseConsumedAt: NOW })]);
    await expect(declineAgreementRequest(dparams())).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
  });

  it('expired at the instant → 410', async () => {
    queue([row({ expiresAt: NOW })]);
    await expect(declineAgreementRequest(dparams())).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
  });

  it('sent → declined, consuming the jti durably in the same statement; reason optional', async () => {
    queue([row()]);
    queue([row({ status: 'declined' })]);
    const res = await declineAgreementRequest(dparams());
    expect(locks).toEqual(['update']);
    expect(updated[0]).toEqual({
      status: 'declined', declinedAt: NOW, declineReason: 'not now',
      publicResponseJti: JTI, publicResponseConsumedAt: NOW, publicResponseOutcome: 'declined', updatedAt: NOW,
    });
    expect(res).toEqual({ requestId: REQ, orgId: ORG, revoke: { jti: JTI, tokenExpiresAt: EXPIRES } });

    queue([row()]);
    queue([row({ status: 'declined' })]);
    await declineAgreementRequest(dparams({ reason: undefined }));
    expect(updated[1]!.declineReason).toBeNull();
  });
});
