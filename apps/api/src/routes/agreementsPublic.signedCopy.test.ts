import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// #10695: a signer who reopens their answered agreement link can download the
// certified copy of the agreement THAT LINK signed — `GET /:token/signed-copy`,
// and the view's `signedCopyUrl` flag that shows the button. Every refusal is
// pinned here: wrong/foreign tokens (resolver, shared with the view), a dead
// link, a blocked tenant, a row this link did not sign, a missing document.
//
// The DB is a FIFO chain: the view reads portal branding, partner settings and
// then (signed-by-this-link only) the signed document id; the download reads
// the signed document row. The certificate service is mocked; the download
// builder (services/signedAgreementDownload.ts) is real, so its headers are the
// ones under test.
const { dbResults, dbWhere } = vi.hoisted(() => ({ dbResults: [] as Array<unknown[] | Error>, dbWhere: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((arg: unknown) => { dbWhere.push(arg); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const next = dbResults.shift() ?? [];
    return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(resolve, reject);
  };
  return {
    db: chain,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

vi.mock('../services/agreementAcceptToken', () => ({
  verifyAgreementAcceptToken: vi.fn(),
  isAgreementAcceptJtiRevoked: vi.fn(),
  revokeAgreementAcceptJti: vi.fn(),
}));
vi.mock('../services/orgMergeProvenance', () => ({ resolveMergedOrgIds: vi.fn() }));
vi.mock('../services/publicLinkOrgGate', async (importActual) => ({
  ...(await importActual<typeof import('../services/publicLinkOrgGate')>()),
  resolveAgreementRequestLinkOrgGate: vi.fn(),
}));
vi.mock('../services/contractTemplateRender', async (importActual) => ({
  ...(await importActual<typeof import('../services/contractTemplateRender')>()),
  loadTemplateVersionRenderData: vi.fn(),
}));
vi.mock('../services/agreementRequestAcceptService', () => ({
  acceptAgreementRequest: vi.fn(),
  declineAgreementRequest: vi.fn(),
  markAgreementRequestViewed: vi.fn(),
}));
vi.mock('../services/agreementCertificate', () => ({
  loadCertifiedAgreementInput: vi.fn(),
  renderCertifiedAgreementPdf: vi.fn(),
}));
vi.mock('../services/agreementEvents', () => ({ emitAgreementEvent: vi.fn() }));
vi.mock('../services/agreementOutcomeNotify', () => ({ notifyAgreementOutcome: vi.fn() }));
vi.mock('../services/agreementSignedCopyEmail', () => ({ sendSignedAgreementCopy: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { isAgreementAcceptJtiRevoked, verifyAgreementAcceptToken } from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import { resolveAgreementRequestLinkOrgGate } from '../services/publicLinkOrgGate';
import { loadTemplateVersionRenderData, type TemplateVersionRenderData } from '../services/contractTemplateRender';
import { loadCertifiedAgreementInput, renderCertifiedAgreementPdf } from '../services/agreementCertificate';
import { PdfMergeError } from '../services/pdfMerge';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { captureException } from '../services/sentry';
import { agreementsPublicRoutes } from './agreementsPublic';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const DOC_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'agreement-token-aaaaaaaaaaaaaaaaaaaa';
const JTI = 'jti-current';
const SIGNED_AT = new Date('2027-01-11T09:00:00.000Z');
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const INVALID = { error: 'This link is invalid or has expired' };
const CERTIFIED = Buffer.from('%PDF-1.7 certified copy');
const ORIGINAL = Buffer.from('%PDF-1.7 frozen original');

/** A request this link signed: the durable link consumption names this jti. */
function signedRow(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID, orgId: ORG_ID, status: 'signed', templateId: 'tpl', templateVersionId: VERSION_ID,
    contractId: null, label: 'BAA', coverMessage: null, variableValues: {},
    effectiveDate: null, expiresAt: FUTURE, signedAt: SIGNED_AT, declinedAt: null,
    publicLinkRevokedAt: null, acceptTokenJti: JTI, acceptTokenExpiresAt: FUTURE,
    publicResponseJti: JTI, publicResponseConsumedAt: SIGNED_AT, publicResponseOutcome: 'accepted',
    clientNameSnapshot: 'Example Clinic', clientAddressSnapshot: null, sellerSnapshot: null,
    renderLocale: 'en', documentLocale: null, createdBy: null,
    ...over,
  };
}

function resolution(rowOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    request: signedRow(rowOver),
    partnerId: PARTNER_ID,
    partnerName: 'Acme MSP',
    gate: { orgId: ORG_ID, status: 'active', partnerStatus: 'active', blocked: false },
    ...over,
  };
}

function docRow(over: Record<string, unknown> = {}) {
  return { id: DOC_ID, orgId: ORG_ID, mime: 'application/pdf', pdfData: ORIGINAL, acceptanceOrigin: 'customer', ...over };
}

function renderData(): TemplateVersionRenderData {
  return {
    templateId: 'tpl', templateVersionId: VERSION_ID, sourceType: 'authored', bodyHtml: '<p>Terms</p>', fileData: null,
    versionSha256: 'vsha', declaredVariables: [], templateName: 'Business Associate Agreement', versionNumber: 3,
  } as TemplateVersionRenderData;
}

function app() {
  const a = new Hono();
  a.route('/agreements/public', agreementsPublicRoutes);
  return a;
}

const download = () => app().request(`/agreements/public/${TOKEN}/signed-copy`);
const view = () => app().request(`/agreements/public/${TOKEN}`);

function expectPublicHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
}

/** The signed-document condition as Postgres sees it: each column paired
 *  with its bound value, so a swapped or dropped clause fails. */
const EXPECTED_DOC_WHERE = {
  sql: '("contract_documents"."agreement_request_id" = $1 and "contract_documents"."org_id" = $2 and "contract_documents"."acceptance_origin" = $3)',
  params: [REQUEST_ID, ORG_ID, 'customer'],
};
function renderWhere(cond: unknown) {
  const { sql, params } = new PgDialect().sqlToQuery(cond as SQL);
  return { sql, params };
}

function expectNoCertificateWork() {
  expect(loadCertifiedAgreementInput).not.toHaveBeenCalled();
  expect(renderCertifiedAgreementPdf).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  dbWhere.length = 0;
  vi.mocked(verifyAgreementAcceptToken).mockResolvedValue({ requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI } as never);
  // The reopened case: answering armed the Redis marker post-commit.
  vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(true);
  vi.mocked(resolveMergedOrgIds).mockResolvedValue([ORG_ID]);
  vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution() as never);
  vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData());
  vi.mocked(loadCertifiedAgreementInput).mockResolvedValue({ certified: 'input' } as never);
  vi.mocked(renderCertifiedAgreementPdf).mockResolvedValue(CERTIFIED);
  vi.mocked(getRedis).mockReturnValue(null);
});

describe('GET /:token/signed-copy (#10695)', () => {
  it('serves the certified copy of the agreement this link signed, as a no-store, no-referrer download', async () => {
    dbResults.push([docRow()]);
    const res = await download();
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-agreement-copy')).toBe('certified');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd.startsWith('attachment;')).toBe(true);
    expect(cd).toContain(`signed-agreement-${DOC_ID}.pdf`);
    expect(Buffer.from(await res.arrayBuffer()).equals(CERTIFIED)).toBe(true);
    expect(loadCertifiedAgreementInput).toHaveBeenCalledWith(DOC_ID);
  });

  it('also serves it when the marker is not armed (a lost marker; the durable row decides)', async () => {
    vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(false);
    dbResults.push([docRow()]);
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-agreement-copy')).toBe('certified');
  });

  it('the document read is one lookup by this request (never a caller-supplied id)', async () => {
    dbResults.push([docRow()]);
    await download();
    // One read: the signed document of THIS request in its current org. The
    // route takes no document id, so there is nothing else to scope.
    expect(dbWhere).toHaveLength(1);
    expect(renderWhere(dbWhere[0])).toEqual(EXPECTED_DOC_WHERE);
  });

  // The builder itself sends no-store on this fallback; the 200 test above is
  // the one that proves the router middleware overrides its max-age=300.
  it('a certificate that cannot be built falls back to the original, labelled so, still no-store', async () => {
    vi.mocked(renderCertifiedAgreementPdf).mockRejectedValue(new PdfMergeError('unreadable', 422, 'CONTRACT_PDF_UNREADABLE'));
    dbResults.push([docRow()]);
    const res = await download();
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('x-agreement-copy')).toBe('original');
    expect(res.headers.get('content-disposition')).toContain('-original.pdf');
    expect(Buffer.from(await res.arrayBuffer()).equals(ORIGINAL)).toBe(true);
  });

  // ---- Refusals -----------------------------------------------------------

  it.each([
    ['forged / expired token', () => vi.mocked(verifyAgreementAcceptToken).mockResolvedValue(null)],
    ['reissued (stale) jti', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ acceptTokenJti: 'jti-new' }) as never)],
    ['re-parented org', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { partnerId: 'other-partner' }) as never)],
    ['unknown request / other org', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue({ ...resolution(), request: null } as never)],
    ['armed marker on a still-open row', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ status: 'viewed', signedAt: null }) as never)],
  ])('%s → the identical 401, no document or certificate read', async (_n, arrange) => {
    arrange();
    const res = await download();
    expect(res.status).toBe(401);
    expectPublicHeaders(res);
    expect(await res.json()).toEqual(INVALID);
    expect(dbWhere).toHaveLength(0);
    expectNoCertificateWork();
  });

  it.each([
    ['voided', { status: 'voided', publicLinkRevokedAt: new Date() }],
    ['link revoked on the signed row', { publicLinkRevokedAt: new Date() }],
  ])('dead link (%s) → 410 LINK_REVOKED, nothing served', async (_n, rowOver) => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution(rowOver) as never);
    const res = await download();
    expect(res.status).toBe(410);
    expectPublicHeaders(res);
    expect((await res.json()).code).toBe('LINK_REVOKED');
    expect(dbWhere).toHaveLength(0);
    expectNoCertificateWork();
  });

  it('blocked tenant → 410 ORG_UNAVAILABLE, nothing served', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, {
      gate: { orgId: ORG_ID, status: 'archived', partnerStatus: 'active', blocked: true },
    }) as never);
    const res = await download();
    expect(res.status).toBe(410);
    expectPublicHeaders(res);
    expect((await res.json()).code).toBe('ORG_UNAVAILABLE');
    expect(dbWhere).toHaveLength(0);
    expectNoCertificateWork();
  });

  // Only the signer's OWN copy: a row this link did not sign carries someone
  // else's evidence (a portal user's IP, the MSP's on-behalf record) — 404.
  it.each([
    ['still open (no marker)', { status: 'sent', signedAt: null, publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null }, false],
    ['declined through this link', { status: 'declined', signedAt: null, declinedAt: SIGNED_AT, publicResponseOutcome: 'declined' }, true],
    ['signed in the portal or recorded on behalf (no link consumption)', { publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null }, true],
    ['consumed by a different jti', { publicResponseJti: 'jti-older' }, true],
  ])('a request this link did not sign (%s) → 404, no certificate read', async (_n, rowOver, marker) => {
    vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(marker as boolean);
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution(rowOver as Record<string, unknown>) as never);
    const res = await download();
    expect(res.status).toBe(404);
    expectPublicHeaders(res);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(dbWhere).toHaveLength(0);
    expectNoCertificateWork();
  });

  it('a request this link signed with no signed document → 404, reported as an integrity fault', async () => {
    dbResults.push([]);
    const res = await download();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expectNoCertificateWork();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(captureException).mock.calls[0]?.[0])).toContain(REQUEST_ID);
  });

  it.each([
    ['recorded on behalf', { acceptanceOrigin: 'on_behalf' }],
    ['no recorded origin', { acceptanceOrigin: null }],
  ])('a signed document that is not a customer acceptance (%s) → 404', async (_n, over) => {
    dbResults.push([docRow(over)]);
    const res = await download();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expectNoCertificateWork();
  });

  it('the document vanishing before the certificate read → 404', async () => {
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(null);
    dbResults.push([docRow()]);
    const res = await download();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(renderCertifiedAgreementPdf).not.toHaveBeenCalled();
  });

  it('over the per-token limit → 429 before the token is even resolved', async () => {
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: false } as never);
    const res = await download();
    expect(res.status).toBe(429);
    expectPublicHeaders(res);
    expect(verifyAgreementAcceptToken).not.toHaveBeenCalled();
    expectNoCertificateWork();
    // Keyed on a hash of the token: the bearer credential never lands in Redis.
    const [, key, limit, windowSeconds] = vi.mocked(rateLimiter).mock.calls[0] ?? [];
    expect(key).toMatch(/^agreement-public:signed-copy:[0-9a-f]{64}$/);
    expect(key).not.toContain(TOKEN);
    expect([limit, windowSeconds]).toEqual([10, 60]);
  });
});

describe('GET /:token — signedCopyUrl (#10695)', () => {
  it('a request this link signed, with its signed document, carries the token-scoped download path', async () => {
    dbResults.push([], [], [{ id: DOC_ID }]);
    const res = await view();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.signedCopyUrl).toBe(`/agreements/public/${TOKEN}/signed-copy`);
    // Never the document id or any signer evidence — the path is the token's.
    expect(JSON.stringify(data)).not.toContain(DOC_ID);
    // The same scoped lookup as the download (the view has no row backstop).
    expect(renderWhere(dbWhere[2])).toEqual(EXPECTED_DOC_WHERE);
  });

  it.each([
    ['still open', { status: 'viewed', signedAt: null, publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null }, false],
    ['declined', { status: 'declined', signedAt: null, declinedAt: SIGNED_AT, publicResponseOutcome: 'declined' }, true],
    ['signed in the portal', { publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null }, true],
  ])('%s → null, and no document read', async (_n, rowOver, marker) => {
    vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(marker as boolean);
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution(rowOver as Record<string, unknown>) as never);
    const res = await view();
    expect(res.status).toBe(200);
    expect((await res.json()).data.signedCopyUrl).toBeNull();
    // Two branding reads only.
    expect(dbWhere).toHaveLength(2);
  });

  it('signed by this link but the document row is missing → null (no dead button), reported', async () => {
    dbResults.push([], [], []);
    const { data } = await (await view()).json();
    expect(data.signedCopyUrl).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('the signed-copy lookup failing only hides the button — the page still renders', async () => {
    dbResults.push([], [], new Error('statement timeout'));
    const res = await view();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.request.status).toBe('signed');
    expect(data.signedCopyUrl).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
