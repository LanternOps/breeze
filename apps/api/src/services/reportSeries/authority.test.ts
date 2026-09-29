import { beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  partner: vi.fn(),
  org: vi.fn(),
}));

vi.mock('../siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../siteScope')>();
  return {
    ...actual,
    resolveLivePartnerReportAuthority: live.partner,
    resolveLiveReportAuthority: live.org,
  };
});

import { siteScopeFingerprint } from '../siteScope';
import { ReportSeriesError } from './errors';
import {
  assertSeriesOwnerEligible,
  captureChildExecutionScope,
  isSeriesOwnerEligible,
} from './authority';
import type { SeriesTx } from './types';

const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-09-28T12:00:00.000Z');

function txReturningUser(user: { partnerId: string | null } | null): SeriesTx {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(user ? [user] : []);
  return { select: () => chain } as unknown as SeriesTx;
}

function okOrg(kind: 'unrestricted' | 'restricted') {
  const scope = kind === 'unrestricted'
    ? { version: 1 as const, kind, orgId: ORG_ID }
    : { version: 1 as const, kind, orgId: ORG_ID, siteIds: ['44444444-4444-4444-8444-444444444444'] };
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: OWNER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ReportSeriesError);
    expect((err as ReportSeriesError).code).toBe('series_owner_ineligible');
    expect((err as ReportSeriesError).status).toBe(400);
    return (err as ReportSeriesError).body?.reason;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  live.partner.mockResolvedValue({ ok: true, authority: {} });
});

describe('assertSeriesOwnerEligible', () => {
  it('accepts an active full-partner admin of the series partner, checked on export', async () => {
    await expect(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).resolves.toBeUndefined();
    expect(live.partner).toHaveBeenCalledWith(OWNER_ID, PARTNER_ID, 'export');
  });

  it('refuses a user of another partner before any live lookup (no platform-admin escape)', async () => {
    expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: OTHER_PARTNER_ID })))).toBe('owner_not_partner_user');
    expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser(null)))).toBe('owner_not_partner_user');
    expect(live.partner).not.toHaveBeenCalled();
  });

  // Review Focus 4: a 'selected' owner is ineligible even if the selection covers every org.
  it.each(['partner_access_not_all', 'user_inactive', 'permission_removed', 'membership_removed', 'tenant_inactive'])(
    'refuses when the live partner authority says %s',
    async (reason) => {
      live.partner.mockResolvedValue({ ok: false, reason });
      expect(await reasonOf(assertSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID })))).toBe(reason);
    },
  );

  it('isSeriesOwnerEligible maps the refusal to false and rethrows anything else', async () => {
    live.partner.mockResolvedValue({ ok: false, reason: 'partner_access_not_all' });
    await expect(isSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).resolves.toBe(false);
    live.partner.mockRejectedValue(new Error('db down'));
    await expect(isSeriesOwnerEligible(OWNER_ID, PARTNER_ID, txReturningUser({ partnerId: PARTNER_ID }))).rejects.toThrow('db down');
  });
});

describe('captureChildExecutionScope', () => {
  const tx = txReturningUser({ partnerId: PARTNER_ID });

  it('captures the owner\'s unrestricted scope for THIS org, fingerprint included', async () => {
    live.org.mockResolvedValue(okOrg('unrestricted'));
    const columns = await captureChildExecutionScope(OWNER_ID, ORG_ID, tx);
    expect(live.org).toHaveBeenCalledWith(OWNER_ID, ORG_ID, 'export');
    expect(columns).toEqual({
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: OWNER_ID,
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: ORG_ID }),
      executionScopeCapturedAt: CAPTURED_AT,
      executionScopePrincipalKind: 'user',
    });
  });

  it('a site-restricted owner in that org has no series authority there', async () => {
    live.org.mockResolvedValue(okOrg('restricted'));
    await expect(captureChildExecutionScope(OWNER_ID, ORG_ID, tx)).resolves.toBe('no_authority');
  });

  it('a denied live authority is no_authority, never a fallback', async () => {
    live.org.mockResolvedValue({ ok: false, reason: 'organization_inaccessible' });
    await expect(captureChildExecutionScope(OWNER_ID, ORG_ID, tx)).resolves.toBe('no_authority');
  });
});
