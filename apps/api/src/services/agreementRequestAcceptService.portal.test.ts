import { describe, it, expect, vi, beforeEach } from 'vitest';

// The logged-in portal channel of the ONE customer accept/decline writer
// (#9075 W3a; spec §2 "Portal users", §3.3). Same controllable Drizzle chain as
// agreementRequestAcceptService.test.ts: awaiting a select shifts the next
// queued result; `.returning()` resolves the next queued result; every
// update payload and every where() predicate is recorded.
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
  chain.select = vi.fn(() => { events.push('select'); return chain; });
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
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
import {
  acceptAgreementRequest,
  declineAgreementRequest,
  type PortalAcceptAgreementRequestParams,
} from './agreementRequestAcceptService';
import type { TemplateVersionRenderData } from './contractTemplateRender';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const VERSION = '22222222-2222-4222-8222-222222222222';
const REQ = '55555555-5555-4555-8555-555555555555';
const JTI = 'jti-current';
const EXPIRES = new Date('2026-11-24T12:00:00.000Z');
const NOW = new Date('2026-10-25T12:00:00.000Z');
const EMAIL = 'dana@customer.example';

function renderData(): TemplateVersionRenderData {
  return {
    templateId: TEMPLATE,
    templateVersionId: VERSION,
    sourceType: 'authored',
    bodyHtml: '<p>{{client.name}}</p>',
    fileData: null,
    versionSha256: 'vsha',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }] as TemplateVersionRenderData['declaredVariables'],
    templateName: 'BAA',
    versionNumber: 3,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: REQ, orgId: ORG, status: 'sent', templateId: TEMPLATE, templateVersionId: VERSION, contractId: null,
    publicLinkRevokedAt: null, label: 'BAA 2026', variableValues: {},
    clientNameSnapshot: 'Acme', clientAddressSnapshot: null, sellerSnapshot: { name: 'Best MSP' },
    documentLocale: null, renderLocale: 'en', effectiveDate: null, expiresAt: EXPIRES,
    acceptTokenJti: JTI, acceptTokenExpiresAt: EXPIRES,
    publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    ...over,
  };
}

const RECIPIENT = [{ id: 'recipient-1' }];

function portalParams(over: Partial<PortalAcceptAgreementRequestParams> = {}): PortalAcceptAgreementRequestParams {
  return {
    portal: { requestId: REQ, orgId: ORG, email: '  Dana@Customer.Example ' },
    renderData: renderData(),
    signerName: ' Dana Buyer ',
    signerEmail: EMAIL,
    ipAddress: '198.51.100.7',
    userAgent: 'portal-browser',
    now: NOW,
    ...over,
  };
}

/** The mocked chain's where() spy (the real db type has no top-level where). */
const whereMock = () => (db as unknown as { where: ReturnType<typeof vi.fn> }).where;

/** The literal values bound into every where() call, flattened (drizzle SQL chunks). */
function boundValues(): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (depth > 12 || node == null) return;
    if (typeof node === 'string') return;
    if (typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if ('value' in n && (typeof n.value === 'string' || n.value instanceof Date)) out.push(n.value);
    if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) walk(c, depth + 1);
    if (Array.isArray(node)) for (const c of node) walk(c, depth + 1);
  };
  for (const call of whereMock().mock.calls) walk(call[0]);
  return out;
}

beforeEach(() => {
  queued.length = 0;
  events.length = 0;
  updated.length = 0;
  locks.length = 0;
  vi.mocked(db.update).mockClear();
  whereMock().mockClear();
  freezeMock.mockReset().mockResolvedValue({ id: 'sa-1', sha256: 'pdfsha' });
  captureMock.mockReset().mockImplementation(async (i: { signerName: string; signerEmail?: string | null }) => ({
    signerName: i.signerName.trim(), signerEmail: i.signerEmail ?? null, method: 'typed-signature',
  }));
});

describe('acceptAgreementRequest — portal channel refusals (every miss is the same 404)', () => {
  it('locks the request row, then checks the recipient list against the normalized session email', async () => {
    queue([row()]);
    queue(RECIPIENT);
    queue([{ id: REQ }]);
    await acceptAgreementRequest(portalParams());
    expect(locks).toEqual(['update']);
    expect(boundValues()).toContain(EMAIL);
  });

  it('unknown id → 404 REQUEST_NOT_FOUND', async () => {
    queue([]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    expect(events).not.toContain('freeze');
  });

  it('a request in another org → the same 404, before any recipient read', async () => {
    queue([row({ orgId: OTHER_ORG })]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    expect(events.filter((e) => e === 'select')).toHaveLength(1);
  });

  it('a portal user who is not a recipient → the same 404 (never 403, never a state hint)', async () => {
    queue([row()]);
    queue([]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    expect(events).not.toContain('freeze');
    expect(updated).toEqual([]);
  });

  it('fails closed when the request has no recipient rows at all', async () => {
    queue([row()]);
    queue([]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 404 });
  });

  it('a non-recipient learns nothing about state: a signed request is still the 404', async () => {
    queue([row({ status: 'signed' })]);
    queue([]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });

  it('a recipient on a voided (revoked) request → 410 LINK_REVOKED (the route maps it to the 404)', async () => {
    queue([row({ status: 'voided', publicLinkRevokedAt: NOW })]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 410, code: 'LINK_REVOKED' });
  });

  it('a recipient on an expired request (instant boundary) → 410 AGREEMENT_EXPIRED', async () => {
    queue([row({ expiresAt: NOW })]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
  });

  it('a recipient on an already-signed request → 409 AGREEMENT_ALREADY_SIGNED (first committed response wins)', async () => {
    queue([row({ status: 'signed' })]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
  });

  it('a recipient on a request the emailed link already answered → 409, never a second signature', async () => {
    queue([row({ status: 'declined', publicResponseJti: JTI, publicResponseConsumedAt: NOW, publicResponseOutcome: 'declined' })]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 409 });
  });

  it('a draft is refused (never sent to anyone)', async () => {
    queue([row({ status: 'draft', acceptTokenJti: null })]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('does not depend on the link\'s jti: a reissued link does not lock the portal out', async () => {
    queue([row({ acceptTokenJti: 'jti-reissued' })]);
    queue(RECIPIENT);
    queue([{ id: REQ }]);
    await expect(acceptAgreementRequest(portalParams())).resolves.toMatchObject({ signedAgreementId: 'sa-1' });
  });
});

describe('acceptAgreementRequest — portal channel success', () => {
  it('freezes customer evidence and flips to signed WITHOUT consuming the public link jti (the certificate reads that as "via portal")', async () => {
    queue([row()]);
    queue(RECIPIENT);
    queue([{ id: REQ }]);
    const result = await acceptAgreementRequest(portalParams());

    expect(events.indexOf('freeze')).toBeGreaterThan(-1);
    expect(events.indexOf('freeze')).toBeLessThan(events.lastIndexOf('update'));
    const evidence = (freezeMock.mock.calls[0]![0] as { evidence: Record<string, unknown> }).evidence;
    expect(evidence).toMatchObject({
      signerName: 'Dana Buyer',
      signerEmail: EMAIL,
      acceptanceOrigin: 'customer',
      acceptanceReference: null,
      recordedByUserId: null,
      signerIp: '198.51.100.7',
      signerUserAgent: 'portal-browser',
    });
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({ acceptanceTokenJti: null }));

    const flip = updated.at(-1)!;
    expect(flip).toMatchObject({ status: 'signed', signedAt: NOW, effectiveDate: '2026-10-25' });
    expect(flip).not.toHaveProperty('publicResponseJti');
    expect(flip).not.toHaveProperty('publicResponseConsumedAt');
    expect(flip).not.toHaveProperty('publicResponseOutcome');

    // The emailed link is killed post-commit by the caller (Redis), so a
    // reload of it 401s exactly as after a public answer.
    expect(result).toEqual({
      requestId: REQ, orgId: ORG, signedAgreementId: 'sa-1', contentSha256: expect.any(String),
      revoke: { jti: JTI, tokenExpiresAt: EXPIRES },
    });
  });

  it('a request with no persisted link identity returns revoke: null (nothing to kill)', async () => {
    queue([row({ acceptTokenJti: null, acceptTokenExpiresAt: null })]);
    queue(RECIPIENT);
    queue([{ id: REQ }]);
    const result = await acceptAgreementRequest(portalParams());
    expect(result.revoke).toBeNull();
  });

  it('a lost conditional flip → 409, not a silent success', async () => {
    queue([row()]);
    queue(RECIPIENT);
    queue([]);
    await expect(acceptAgreementRequest(portalParams())).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('a blank signer name → 400 before capture', async () => {
    queue([row()]);
    queue(RECIPIENT);
    await expect(acceptAgreementRequest(portalParams({ signerName: '   ' }))).rejects.toMatchObject({ status: 400, code: 'INVALID_SIGNER_NAME' });
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('declineAgreementRequest — portal channel', () => {
  it('non-recipient → 404, nothing written', async () => {
    queue([row()]);
    queue([]);
    await expect(declineAgreementRequest({ portal: { requestId: REQ, orgId: ORG, email: EMAIL }, now: NOW }))
      .rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
    expect(updated).toEqual([]);
  });

  it('other org → 404', async () => {
    queue([row({ orgId: OTHER_ORG })]);
    await expect(declineAgreementRequest({ portal: { requestId: REQ, orgId: ORG, email: EMAIL }, now: NOW }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('recipient: sent → declined with the reason, without consuming the public jti; revoke names the link', async () => {
    queue([row()]);
    queue(RECIPIENT);
    queue([{ id: REQ }]);
    const result = await declineAgreementRequest({ portal: { requestId: REQ, orgId: ORG, email: EMAIL }, reason: ' Not now ', now: NOW });
    const flip = updated.at(-1)!;
    expect(flip).toMatchObject({ status: 'declined', declinedAt: NOW, declineReason: 'Not now' });
    expect(flip).not.toHaveProperty('publicResponseJti');
    expect(flip).not.toHaveProperty('publicResponseConsumedAt');
    expect(result).toEqual({ requestId: REQ, orgId: ORG, revoke: { jti: JTI, tokenExpiresAt: EXPIRES } });
  });

  it('recipient on an expired request → 410', async () => {
    queue([row({ expiresAt: NOW })]);
    queue(RECIPIENT);
    await expect(declineAgreementRequest({ portal: { requestId: REQ, orgId: ORG, email: EMAIL }, now: NOW }))
      .rejects.toMatchObject({ status: 410, code: 'AGREEMENT_EXPIRED' });
  });
});
