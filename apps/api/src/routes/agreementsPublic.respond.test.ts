import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// POST /agreements/public/:token/accept + /decline (#9075 W2b; spec §3.3).
// The system-context mock tracks which transaction is open, so "render data is
// pre-fetched OUTSIDE the accept transaction" and "post-commit side effects
// run with no transaction open" are observable.
const { tx } = vi.hoisted(() => ({ tx: { seq: 0, current: 0 } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: chain,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
      const outer = tx.current;
      tx.seq += 1;
      tx.current = tx.seq;
      try { return await fn(); } finally { tx.current = outer; }
    },
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
vi.mock('../services/agreementOutcomeNotify', () => ({ notifyAgreementOutcome: vi.fn() }));
vi.mock('../services/agreementSignedCopyEmail', () => ({ sendSignedAgreementCopy: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
// The trusted-proxy policy decides the signer IP — never the raw header.
vi.mock('../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '203.0.113.9') }));

import {
  isAgreementAcceptJtiRevoked,
  revokeAgreementAcceptJti,
  verifyAgreementAcceptToken,
} from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import { resolveAgreementRequestLinkOrgGate } from '../services/publicLinkOrgGate';
import { loadTemplateVersionRenderData, type TemplateVersionRenderData } from '../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../services/contractTemplateService';
import { acceptAgreementRequest, declineAgreementRequest } from '../services/agreementRequestAcceptService';
import { AgreementRequestServiceError } from '../services/agreementRequestService';
import { notifyAgreementOutcome } from '../services/agreementOutcomeNotify';
import { sendSignedAgreementCopy } from '../services/agreementSignedCopyEmail';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { captureException } from '../services/sentry';
import { agreementsPublicRoutes } from './agreementsPublic';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SURVIVOR_ORG_ID = '23232323-2323-4323-8323-232323232323';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const DOC_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'agreement-token-aaaaaaaaaaaaaaaaaaaa';
const JTI = 'jti-current';
const EXPIRES = new Date(Date.now() + 7 * 86_400_000);

const renderData: TemplateVersionRenderData = {
  templateId: 'tpl', templateVersionId: VERSION_ID, sourceType: 'authored', bodyHtml: '<p>x</p>', fileData: null,
  versionSha256: 'vsha', declaredVariables: [], templateName: 'BAA', versionNumber: 1,
};

function live(rowOver: Record<string, unknown> = {}) {
  return {
    request: {
      id: REQUEST_ID, orgId: ORG_ID, status: 'viewed', templateVersionId: VERSION_ID, variableValues: {},
      expiresAt: EXPIRES, publicLinkRevokedAt: null, acceptTokenJti: JTI, acceptTokenExpiresAt: EXPIRES, ...rowOver,
    },
    partnerId: PARTNER_ID, partnerName: 'Acme MSP',
    gate: { orgId: ORG_ID, status: 'active', partnerStatus: 'active', blocked: false },
  };
}

function post(action: 'accept' | 'decline', body: unknown, headers: Record<string, string> = {}) {
  const a = new Hono();
  a.route('/agreements/public', agreementsPublicRoutes);
  return a.request(`/agreements/public/${TOKEN}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'customer-browser', ...headers },
    body: JSON.stringify(body),
  });
}

const ACCEPT_BODY = { signerName: ' Dana Buyer ', signerEmail: ' Dana@Example.com ' };
const txSeen: Record<string, number> = {};

beforeEach(() => {
  vi.clearAllMocks();
  tx.seq = 0;
  tx.current = 0;
  for (const k of Object.keys(txSeen)) delete txSeen[k];
  vi.mocked(getRedis).mockReturnValue(null);
  vi.mocked(verifyAgreementAcceptToken).mockResolvedValue({ requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI });
  vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(false);
  vi.mocked(resolveMergedOrgIds).mockResolvedValue([ORG_ID, SURVIVOR_ORG_ID]);
  vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live() as never);
  vi.mocked(loadTemplateVersionRenderData).mockImplementation(async () => { txSeen.load = tx.current; return renderData; });
  vi.mocked(acceptAgreementRequest).mockImplementation(async () => {
    txSeen.accept = tx.current;
    return { requestId: REQUEST_ID, orgId: ORG_ID, signedAgreementId: DOC_ID, contentSha256: 'sha', revoke: { jti: JTI, tokenExpiresAt: EXPIRES } };
  });
  vi.mocked(declineAgreementRequest).mockImplementation(async () => {
    txSeen.decline = tx.current;
    return { requestId: REQUEST_ID, orgId: ORG_ID, revoke: { jti: JTI, tokenExpiresAt: EXPIRES } };
  });
  vi.mocked(revokeAgreementAcceptJti).mockImplementation(async () => { txSeen.revoke = tx.current; });
  vi.mocked(notifyAgreementOutcome).mockImplementation(async () => { txSeen.notify = tx.current; });
  vi.mocked(sendSignedAgreementCopy).mockImplementation(async () => { txSeen.copy = tx.current; return { sent: true, recipients: [], attached: true, certified: true }; });
});

describe('POST /:token/accept', () => {
  it('signs in ONE system tx with render data pre-fetched in a separate, earlier one; returns no internal ids', async () => {
    const res = await post('accept', ACCEPT_BODY, { 'x-forwarded-for': '198.51.100.7' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ data: { status: 'signed', signedAt: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain(DOC_ID);

    expect(txSeen.load).toBeGreaterThan(0);
    expect(txSeen.accept).toBeGreaterThan(0);
    expect(txSeen.accept).not.toBe(txSeen.load);
    expect(vi.mocked(loadTemplateVersionRenderData).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(acceptAgreementRequest).mock.invocationCallOrder[0]!);
    expect(loadTemplateVersionRenderData).toHaveBeenCalledWith(VERSION_ID, { includeFileData: true });

    expect(acceptAgreementRequest).toHaveBeenCalledWith(expect.objectContaining({
      claims: { requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI },
      allowedOrgIds: [ORG_ID, SURVIVOR_ORG_ID],
      renderData,
      signerName: 'Dana Buyer',
      signerEmail: 'dana@example.com',
      // From getTrustedClientIpOrUndefined (mocked), NOT the raw x-forwarded-for.
      ipAddress: '203.0.113.9',
      userAgent: 'customer-browser',
      now: expect.any(Date),
    }));
  });

  it('no trusted client IP → ipAddress null (never the spoofable header)', async () => {
    const { getTrustedClientIpOrUndefined } = await import('../services/clientIp');
    vi.mocked(getTrustedClientIpOrUndefined).mockReturnValueOnce(undefined);
    await post('accept', ACCEPT_BODY, { 'x-forwarded-for': '198.51.100.7' });
    expect(vi.mocked(acceptAgreementRequest).mock.calls[0]![0].ipAddress).toBeNull();
  });

  it('per-token limiter allowed → proceeds; called with the per-token limit (10/min)', async () => {
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as never);
    expect((await post('accept', ACCEPT_BODY)).status).toBe(200);
    expect(vi.mocked(rateLimiter).mock.calls[0]!.slice(2, 4)).toEqual([10, 60]);
    expect(acceptAgreementRequest).toHaveBeenCalledTimes(1);
  });

  it('post-commit, in order, with no transaction open: revoke → notify → signed copy', async () => {
    await post('accept', ACCEPT_BODY);
    await vi.waitFor(() => expect(sendSignedAgreementCopy).toHaveBeenCalled());
    expect(revokeAgreementAcceptJti).toHaveBeenCalledWith(JTI, EXPIRES);
    expect(notifyAgreementOutcome).toHaveBeenCalledWith({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer', signerName: 'Dana Buyer' });
    expect(sendSignedAgreementCopy).toHaveBeenCalledWith({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: 'dana@example.com' });
    const order = [revokeAgreementAcceptJti, notifyAgreementOutcome, sendSignedAgreementCopy]
      .map((m) => vi.mocked(m).mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(vi.mocked(acceptAgreementRequest).mock.invocationCallOrder[0]!);
    expect([txSeen.revoke, txSeen.notify, txSeen.copy]).toEqual([0, 0, 0]);
  });

  it('each post-commit failure is swallowed (and captured) — the 200 stands', async () => {
    vi.mocked(revokeAgreementAcceptJti).mockRejectedValue(new Error('redis down'));
    vi.mocked(notifyAgreementOutcome).mockRejectedValue(new Error('should never reject, but'));
    vi.mocked(sendSignedAgreementCopy).mockRejectedValue(new Error('should never reject, but'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('accept', ACCEPT_BODY);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captureException).toHaveBeenCalledTimes(3));
    err.mockRestore();
  });

  it.each([
    ['RESPONSE_CONSUMED', 401],
    ['LINK_REVOKED', 410],
    ['AGREEMENT_EXPIRED', 410],
    ['INVALID_SIGNER_NAME', 400],
    ['AGREEMENT_VARIABLES_UNRESOLVED', 422],
    ['INVALID_STATE', 409],
    ['AGREEMENT_ALREADY_SIGNED', 409],
    ['REQUEST_NOT_FOUND', 404],
  ] as const)('service %s → %i with its code; no post-commit side effects', async (code, status) => {
    vi.mocked(acceptAgreementRequest).mockRejectedValue(new AgreementRequestServiceError('nope', status, code));
    const res = await post('accept', ACCEPT_BODY);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'nope', code });
    expect(notifyAgreementOutcome).not.toHaveBeenCalled();
    expect(sendSignedAgreementCopy).not.toHaveBeenCalled();
    if (code === 'RESPONSE_CONSUMED') {
      // The durable backstop fired (Redis marker lost): re-arm the hot path.
      expect(revokeAgreementAcceptJti).toHaveBeenCalledWith(JTI, EXPIRES);
    } else {
      expect(revokeAgreementAcceptJti).not.toHaveBeenCalled();
    }
  });

  it('a missing pinned version (ContractTemplateServiceError) maps to its status, never a 500', async () => {
    vi.mocked(loadTemplateVersionRenderData).mockRejectedValue(new ContractTemplateServiceError('gone', 404, 'VERSION_NOT_FOUND'));
    const res = await post('accept', ACCEPT_BODY);
    expect(res.status).toBe(404);
    expect(acceptAgreementRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['missing signerEmail', { signerName: 'Dana' }],
    ['invalid signerEmail', { signerName: 'Dana', signerEmail: 'nope' }],
    ['blank signerName', { signerName: '  ', signerEmail: 'a@example.com' }],
  ])('%s → 400 before any resolve or DB work', async (_n, body) => {
    const res = await post('accept', body);
    expect(res.status).toBe(400);
    expect(verifyAgreementAcceptToken).not.toHaveBeenCalled();
    expect(acceptAgreementRequest).not.toHaveBeenCalled();
  });

  it('per-token limiter: 429 before resolve and before any DB context; keyed on sha256(token), never the raw token', async () => {
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: false } as never);
    const res = await post('accept', ACCEPT_BODY);
    expect(res.status).toBe(429);
    expect(verifyAgreementAcceptToken).not.toHaveBeenCalled();
    expect(tx.seq).toBe(0);
    const key = String(vi.mocked(rateLimiter).mock.calls[0]![1]);
    expect(key).toContain(createHash('sha256').update(TOKEN).digest('hex'));
    expect(key).not.toContain(TOKEN);
  });

  it('an unexpected limiter throw is logged + captured and does not block (the durable jti is the single-use guard)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockRejectedValue(new Error('unexpected'));
    expect((await post('accept', ACCEPT_BODY)).status).toBe(200);
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a dead link never reaches the service', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live({ status: 'voided', publicLinkRevokedAt: new Date() }) as never);
    const res = await post('accept', ACCEPT_BODY);
    expect(res.status).toBe(410);
    expect(loadTemplateVersionRenderData).not.toHaveBeenCalled();
    expect(acceptAgreementRequest).not.toHaveBeenCalled();
  });
});

describe('POST /:token/decline', () => {
  it('declines in one system tx, then revoke → notify (declined) post-commit; no signed copy', async () => {
    const res = await post('decline', { reason: 'Not this year' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'declined' } });
    expect(txSeen.decline).toBeGreaterThan(0);
    expect(declineAgreementRequest).toHaveBeenCalledWith(expect.objectContaining({
      claims: { requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI },
      allowedOrgIds: [ORG_ID, SURVIVOR_ORG_ID],
      reason: 'Not this year',
      now: expect.any(Date),
    }));
    await vi.waitFor(() => expect(notifyAgreementOutcome).toHaveBeenCalledWith({ requestId: REQUEST_ID, outcome: 'declined', source: 'customer' }));
    expect(vi.mocked(revokeAgreementAcceptJti).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(notifyAgreementOutcome).mock.invocationCallOrder[0]!);
    expect([txSeen.revoke, txSeen.notify]).toEqual([0, 0]);
    expect(sendSignedAgreementCopy).not.toHaveBeenCalled();
  });

  it('reason is optional', async () => {
    expect((await post('decline', {})).status).toBe(200);
  });

  it.each([
    ['RESPONSE_CONSUMED', 401],
    ['LINK_REVOKED', 410],
    ['AGREEMENT_EXPIRED', 410],
    ['INVALID_STATE', 409],
    ['AGREEMENT_ALREADY_SIGNED', 409],
  ] as const)('service %s → %i; nothing notified', async (code, status) => {
    vi.mocked(declineAgreementRequest).mockRejectedValue(new AgreementRequestServiceError('nope', status, code));
    const res = await post('decline', { reason: 'x' });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    expect(notifyAgreementOutcome).not.toHaveBeenCalled();
  });

  it('post-commit failures on decline are swallowed + captured — the 200 stands', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(revokeAgreementAcceptJti).mockRejectedValue(new Error('redis down'));
    vi.mocked(notifyAgreementOutcome).mockRejectedValue(new Error('should never reject, but'));
    expect((await post('decline', {})).status).toBe(200);
    await vi.waitFor(() => expect(captureException).toHaveBeenCalledTimes(2));
    err.mockRestore();
  });

  it('RESPONSE_CONSUMED on decline re-arms the Redis revoke', async () => {
    vi.mocked(declineAgreementRequest).mockRejectedValue(new AgreementRequestServiceError('nope', 401, 'RESPONSE_CONSUMED'));
    expect((await post('decline', {})).status).toBe(401);
    expect(revokeAgreementAcceptJti).toHaveBeenCalledWith(JTI, EXPIRES);
  });

  it('per-token limiter applies to decline too', async () => {
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: false } as never);
    expect((await post('decline', {})).status).toBe(429);
    expect(declineAgreementRequest).not.toHaveBeenCalled();
  });
});
