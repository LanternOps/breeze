import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({ db: {} }));
const readCounts = vi.fn(async (..._a: unknown[]) => new Map<string, number>());
vi.mock('../oauthRetryCounter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oauthRetryCounter')>()),
  readRefreshRetryCounts: (...a: unknown[]) => readCounts(...a),
}));

import type { HealthObservation } from '../types';
import { decorateStillRetrying } from './oauthGrant';

const NOW = new Date('2026-10-17T12:00:00Z');
const ACCT = '11111111-1111-4111-8111-111111111111';
const obs = (state: HealthObservation['state'], client: string): HealthObservation => ({
  sourceKind: 'oauth_grant', sourceId: `${ACCT}:${client}`, partnerId: 'p', orgId: null, ownerUserId: ACCT,
  state, severity: 'permanent', condition: 'grant_revoked_reuse', detail: null, displayName: 'Agent',
  fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
  viewPermission: { resource: 'connected_apps', action: 'read' }, repairPermission: { resource: 'connected_apps', action: 'manage' },
  observedAt: NOW,
});

describe('oauth_grant still-retrying detail (W4)', () => {
  it('adds the count to broken grants only, reading only their clients', async () => {
    readCounts.mockResolvedValueOnce(new Map([['client:with:colons', 740]]));
    const out = await decorateStillRetrying([obs('broken', 'client:with:colons'), obs('healthy', 'other'), obs('broken', 'quiet')], NOW);
    expect(readCounts).toHaveBeenCalledWith(['client:with:colons', 'quiet'], NOW);
    expect(out[0]!.detail).toBe('The app keeps retrying its revoked token (740 failed refreshes today, UTC).');
    expect(out[1]!.detail).toBeNull();
    expect(out[2]!.detail).toBeNull();
  });

  it('skips the Redis read when nothing is broken', async () => {
    readCounts.mockClear();
    await decorateStillRetrying([obs('healthy', 'a')], NOW);
    expect(readCounts).not.toHaveBeenCalled();
  });
});
