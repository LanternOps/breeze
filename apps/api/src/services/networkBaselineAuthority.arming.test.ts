/**
 * SEC-2026-09-05-146 — arming contract: what gets persisted when a user arms a
 * recurring network-baseline schedule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userRows: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const result: any = Promise.resolve(userRows.slice());
      for (const m of ['from', 'where', 'limit', 'innerJoin', 'for']) result[m] = vi.fn(() => result);
      return result;
    }),
  },
}));

import type { AuthContext } from '../middleware/auth';
import {
  BaselineAuthorityUnsupportedError,
  buildBaselineAuthorityEnvelope,
  computeBaselineAuthorityFingerprint,
} from './networkBaselineAuthority';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const EFFECT = {
  orgId: ORG_ID,
  siteId: SITE_ID,
  subnet: '192.168.5.0/24',
  scanSchedule: { enabled: true, intervalHours: 6, nextScanAt: null },
};

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER_ID, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
    ...overrides,
  } as AuthContext;
}

beforeEach(() => {
  userRows.length = 0;
  userRows.push({ permissionsEpoch: 12, mfaEpoch: 5 });
});

describe('buildBaselineAuthorityEnvelope', () => {
  it('records the arming user, live epochs and the effect fingerprint', async () => {
    const envelope = await buildBaselineAuthorityEnvelope(auth(), EFFECT);

    expect(envelope.authorityUserId).toBe(USER_ID);
    expect(envelope.authorityPermissionsEpoch).toBe(12);
    expect(envelope.authorityMfaEpoch).toBe(5);
    expect(envelope.authorityFingerprint).toBe(computeBaselineAuthorityFingerprint(EFFECT));
    expect(envelope.authorityArmedAt).toBeInstanceOf(Date);
    expect(envelope.scheduleBlockedReason).toBeNull();
  });

  it('records NULL for an unrestricted site ceiling', async () => {
    const envelope = await buildBaselineAuthorityEnvelope(auth({ allowedSiteIds: undefined }), EFFECT);
    expect(envelope.authoritySiteIds).toBeNull();
  });

  it('records the CURRENT explicit site ceiling for a site-restricted armer', async () => {
    const envelope = await buildBaselineAuthorityEnvelope(auth({ allowedSiteIds: [SITE_ID] }), EFFECT);
    expect(envelope.authoritySiteIds).toEqual([SITE_ID]);
  });

  it('records an empty ceiling as an empty array, never as unrestricted', async () => {
    const envelope = await buildBaselineAuthorityEnvelope(auth({ allowedSiteIds: [] }), EFFECT);
    expect(envelope.authoritySiteIds).toEqual([]);
  });

  it('refuses system-scope arming — a system principal can never be revoked', async () => {
    await expect(buildBaselineAuthorityEnvelope(auth({ scope: 'system' }), EFFECT)).rejects.toBeInstanceOf(
      BaselineAuthorityUnsupportedError,
    );
  });

  it('refuses when the arming principal no longer exists', async () => {
    userRows.length = 0;
    await expect(buildBaselineAuthorityEnvelope(auth(), EFFECT)).rejects.toBeInstanceOf(
      BaselineAuthorityUnsupportedError,
    );
  });
});
