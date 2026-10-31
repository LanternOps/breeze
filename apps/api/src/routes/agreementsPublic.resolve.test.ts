import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Enumeration guard (#9075 W2b; spec §3.3 last paragraph, §8): EVERY token
// route on agreementsPublicRoutes goes through the shared resolveAgreementLink() and
// isAgreementLinkDead(). The registered-route inventory is compared strictly
// with the list below, so adding a route without adding it here fails — and
// adding it here asserts it 401s on a forged / revoked / stale token and 410s
// on a dead link, with no service call and no DB work past the resolver.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
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
vi.mock('../services/agreementOutcomeNotify', () => ({ notifyAgreementOutcome: vi.fn() }));
vi.mock('../services/agreementSignedCopyEmail', () => ({ sendSignedAgreementCopy: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));

import { verifyAgreementAcceptToken, isAgreementAcceptJtiRevoked } from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import { resolveAgreementRequestLinkOrgGate } from '../services/publicLinkOrgGate';
import { loadTemplateVersionRenderData } from '../services/contractTemplateRender';
import {
  acceptAgreementRequest,
  declineAgreementRequest,
  markAgreementRequestViewed,
} from '../services/agreementRequestAcceptService';
import { agreementsPublicRoutes } from './agreementsPublic';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'agreement-token-aaaaaaaaaaaaaaaaaaaa';
const JTI = 'jti-current';

interface TokenRoute { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }

// Keep in sync with agreementsPublic.ts — the strict inventory check below fails otherwise.
const TOKEN_ROUTES: TokenRoute[] = [
  { method: 'GET', path: '/:token' },
  { method: 'GET', path: '/:token/file' },
  { method: 'POST', path: '/:token/accept', body: { signerName: 'Dana Buyer', signerEmail: 'dana@example.com' } },
  { method: 'POST', path: '/:token/decline', body: { reason: 'Not now' } },
];

function row(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID, orgId: ORG_ID, status: 'sent', templateVersionId: 'v', variableValues: {},
    expiresAt: new Date(Date.now() + 86_400_000), publicLinkRevokedAt: null, acceptTokenJti: JTI,
    ...over,
  };
}

function live(over: Record<string, unknown> = {}) {
  return {
    request: row(over), partnerId: PARTNER_ID, partnerName: 'Acme MSP',
    gate: { orgId: ORG_ID, status: 'active', partnerStatus: 'active', blocked: false },
  };
}

function send(route: TokenRoute) {
  const a = new Hono();
  a.route('/agreements/public', agreementsPublicRoutes);
  const path = `/agreements/public${route.path.replace(':token', TOKEN)}`;
  return a.request(path, route.method === 'POST'
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body ?? {}) }
    : undefined);
}

function expectNoServiceWork() {
  expect(loadTemplateVersionRenderData).not.toHaveBeenCalled();
  expect(acceptAgreementRequest).not.toHaveBeenCalled();
  expect(declineAgreementRequest).not.toHaveBeenCalled();
  expect(markAgreementRequestViewed).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  vi.mocked(verifyAgreementAcceptToken).mockResolvedValue({ requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI });
  vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(false);
  vi.mocked(resolveMergedOrgIds).mockResolvedValue([ORG_ID]);
  vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live() as never);
});

describe('agreementsPublic token-route enumeration', () => {
  it('the registered route inventory is exactly the enumerated list', () => {
    const registered = Array.from(new Set(
      (agreementsPublicRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes
        .filter((r) => r.method !== 'ALL') // the response-headers middleware
        .map((r) => `${r.method} ${r.path}`),
    )).sort();
    expect(registered).toEqual(TOKEN_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  const refusals: Array<[string, () => void]> = [
    ['forged token', () => vi.mocked(verifyAgreementAcceptToken).mockResolvedValue(null)],
    ['revoked jti', () => vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(true)],
    ['stale (reissued) jti', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live({ acceptTokenJti: 'jti-new' }) as never)],
    ['re-parented org', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue({ ...live(), partnerId: 'other-partner' } as never)],
    ['never-sent draft', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live({ status: 'draft' }) as never)],
  ];

  for (const route of TOKEN_ROUTES) {
    it.each(refusals)(`${route.method} ${route.path}: %s → 401, nothing else runs`, async (_n, arrange) => {
      arrange();
      const res = await send(route);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'This link is invalid or has expired' });
      expectNoServiceWork();
    });

    it(`${route.method} ${route.path}: voided link → 410 LINK_REVOKED, nothing else runs`, async () => {
      vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live({ status: 'voided', publicLinkRevokedAt: new Date() }) as never);
      const res = await send(route);
      expect(res.status).toBe(410);
      expect((await res.json()).code).toBe('LINK_REVOKED');
      expectNoServiceWork();
    });

    it.each([
      ['past its expiry instant', { expiresAt: new Date(Date.now() - 1) }],
      ['reaper-expired', { status: 'expired' }],
    ])(`${route.method} ${route.path}: %s → 410 AGREEMENT_EXPIRED, nothing else runs`, async (_n, rowOver) => {
      vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live(rowOver) as never);
      const res = await send(route);
      expect(res.status).toBe(410);
      expect((await res.json()).code).toBe('AGREEMENT_EXPIRED');
      expectNoServiceWork();
    });

    // #10199: a link whose jti marker was armed by answering may still be VIEWED
    // (read-only, signed/declined) but never ANSWER again. A new route must pick
    // a side explicitly: GETs view, POSTs respond.
    it(`${route.method} ${route.path}: answered link (marker armed, row signed) → ${route.method === 'GET' ? 'viewable' : '401, never answers twice'}`, async () => {
      vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(true);
      vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(live({ status: 'signed', signedAt: new Date() }) as never);
      vi.mocked(loadTemplateVersionRenderData).mockResolvedValue({
        templateId: 'tpl', templateVersionId: 'v', sourceType: 'uploaded', bodyHtml: null,
        fileData: Buffer.from('%PDF-1.7'), versionSha256: 'sha', declaredVariables: [],
        templateName: 'Agreement', versionNumber: 1,
      } as never);
      const res = await send(route);
      if (route.method === 'GET') {
        expect(res.status).toBe(200);
        expect(loadTemplateVersionRenderData).toHaveBeenCalled();
      } else {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'This link is invalid or has expired' });
        expectNoServiceWork();
      }
      expect(acceptAgreementRequest).not.toHaveBeenCalled();
      expect(declineAgreementRequest).not.toHaveBeenCalled();
      expect(markAgreementRequestViewed).not.toHaveBeenCalled();
    });

    it(`${route.method} ${route.path}: blocked tenant → 410 ORG_UNAVAILABLE`, async () => {
      vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue({ ...live(), gate: { orgId: ORG_ID, status: 'archived', partnerStatus: 'active', blocked: true } } as never);
      const res = await send(route);
      expect(res.status).toBe(410);
      expect((await res.json()).code).toBe('ORG_UNAVAILABLE');
      expectNoServiceWork();
    });
  }
});
