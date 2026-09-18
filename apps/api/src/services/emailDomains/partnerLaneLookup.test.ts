import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectMock, getCurrentDbAccessContextMock, readWithPartnerAxisVisibilityMock,
  evaluateMock, partnerTrustModeMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getCurrentDbAccessContextMock: vi.fn(),
  readWithPartnerAxisVisibilityMock: vi.fn(),
  evaluateMock: vi.fn(),
  partnerTrustModeMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...(a as [])) },
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: readWithPartnerAxisVisibilityMock,
}));
vi.mock('../partnerTrust', () => ({
  evaluateCapabilityContinuationForState: evaluateMock,
}));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: partnerTrustModeMock }));

import { lookupPartnerLaneIdentity, partnerLaneAmbientCanSee } from './partnerLaneLookup';

const PARTNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  return chain;
}

function row(over: Record<string, unknown> = {}) {
  return {
    partnerName: 'Acme MSP',
    partnerStatus: 'active',
    trustState: 'trusted',
    probationEnrollments: 0,
    localPart: 'support',
    displayName: null,
    identityReplyTo: null,
    domainId: 'd1',
    domain: 'mail.acme.test',
    domainStatus: 'verified',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentDbAccessContextMock.mockReturnValue(undefined);
  readWithPartnerAxisVisibilityMock.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  evaluateMock.mockReturnValue({ allow: true });
  partnerTrustModeMock.mockReturnValue('off');
  selectMock.mockReturnValue(selectChain([row()]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('partnerLaneAmbientCanSee (spec §8.3, plan amendment 2)', () => {
  it('is true under system scope', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(true);
  });

  it('is true under partner scope whose accessible ids contain the partner', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [PARTNER] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(true);
  });

  it('is false under org scope, under portal/no context, and for a foreign partner', () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], accessiblePartnerIds: [] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
    getCurrentDbAccessContextMock.mockReturnValue(undefined);
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [OTHER] });
    expect(partnerLaneAmbientCanSee(PARTNER)).toBe(false);
  });
});

describe('lookupPartnerLaneIdentity — where the read runs', () => {
  it('reads in place under system scope', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null });
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('reads in place under partner scope, even for a partner it cannot see', async () => {
    // Plan amendment 2: escalating here would hand partner B partner A's
    // identity. RLS returns zero rows instead, and the caller falls back.
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [OTHER] });
    selectMock.mockReturnValue(selectChain([]));
    const result = await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'partner_ineligible' });
  });

  it('takes the partner-axis escape from org scope and from no context', async () => {
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'], accessiblePartnerIds: [] });
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(1);

    getCurrentDbAccessContextMock.mockReturnValue(undefined);
    await lookupPartnerLaneIdentity(PARTNER, 'support');
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(2);
  });

  it('makes exactly ONE read (spec §8.3)', async () => {
    await lookupPartnerLaneIdentity(PARTNER, 'billing');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('lookupPartnerLaneIdentity — conditions 2 and 3 of spec §8.3', () => {
  it('returns the identity for an active, trusted partner with a verified domain', async () => {
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support')).resolves.toEqual({
      ok: true, partnerName: 'Acme MSP', localPart: 'support', displayName: null,
      replyTo: null, domainId: 'd1', domain: 'mail.acme.test',
    });
  });

  it('accepts at_risk as sendable and refuses every other domain status', async () => {
    for (const status of ['verified', 'at_risk']) {
      selectMock.mockReturnValue(selectChain([row({ domainStatus: status })]));
      expect((await lookupPartnerLaneIdentity(PARTNER, 'support')).ok).toBe(true);
    }
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      selectMock.mockReturnValue(selectChain([row({ domainStatus: status })]));
      await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
        .resolves.toEqual({ ok: false, reason: 'domain_not_sendable' });
    }
  });

  it('refuses a partner whose status is not active', async () => {
    for (const status of ['pending', 'suspended', 'churned']) {
      selectMock.mockReturnValue(selectChain([row({ partnerStatus: status })]));
      await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
        .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    }
  });

  it('refuses when the trust evaluator denies, and uses the SIDE-EFFECT-FREE evaluator', async () => {
    evaluateMock.mockReturnValue({ allow: false, code: 'TRUST_PROBATION', capability: 'custom_sending_domain', reason: 'probation_default_deny' });
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
      .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    // A send must never write a denial audit row (spec §8.3 condition 2), and
    // the continuation evaluator is the only one that writes none.
    expect(evaluateMock).toHaveBeenCalledWith(
      'custom_sending_domain',
      { partnerId: PARTNER },
      { trustState: 'trusted', probationEnrollments: 0 },
    );
  });

  it('allows when trust mode is shadow (allow: true with shadowDenied)', async () => {
    evaluateMock.mockReturnValue({ allow: true, shadowDenied: { code: 'TRUST_PROBATION', reason: 'probation_default_deny' } });
    expect((await lookupPartnerLaneIdentity(PARTNER, 'support')).ok).toBe(true);
  });

  it('refuses when the stream has no identity', async () => {
    selectMock.mockReturnValue(selectChain([row({ localPart: null, domainId: null, domain: null, domainStatus: null })]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'general'))
      .resolves.toEqual({ ok: false, reason: 'no_identity' });
  });

  it('refuses when the partner row itself is invisible or gone', async () => {
    selectMock.mockReturnValue(selectChain([]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support'))
      .resolves.toEqual({ ok: false, reason: 'partner_ineligible' });
    // A null row must reach the evaluator as null so enforce mode denies it.
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('carries the identity display name and reply-to through', async () => {
    selectMock.mockReturnValue(selectChain([row({ displayName: 'Acme Support', identityReplyTo: 'help@acme.test' })]));
    await expect(lookupPartnerLaneIdentity(PARTNER, 'support')).resolves.toMatchObject({
      ok: true, displayName: 'Acme Support', replyTo: 'help@acme.test',
    });
  });
});
