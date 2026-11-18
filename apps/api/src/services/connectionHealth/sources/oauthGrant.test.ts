import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({ db: {} }));
const readCounts = vi.fn(async (..._a: unknown[]) => new Map<string, number>());
vi.mock('../oauthRetryCounter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oauthRetryCounter')>()),
  readRefreshRetryCounts: (...a: unknown[]) => readCounts(...a),
}));

import type { HealthObservation } from '../types';
import { decorateStillRetrying, toObservation, disambiguateDisplayNames } from './oauthGrant';
import { remedyFor } from '../remedy';

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

const ACCT2 = '22222222-2222-4222-8222-222222222222';
const row = (over: Record<string, unknown> = {}) => ({
  account_id: ACCT, client_id: 'client-aaaa1111', partner_id: 'p', org_id: null,
  auto_revoked_at: new Date('2026-10-17T00:00:00Z'), has_later: false, has_active: false,
  has_later_by_name: false, has_active_by_name: false, client_disabled: false,
  client_name: 'Claude Code (breeze)', owner_email: 'pat@example.com',
  grant_created_at: new Date('2026-10-10T08:00:00Z'), ...over,
}) as Parameters<typeof toObservation>[0];

describe('oauth_grant token-reuse incident UX (#9594)', () => {
  it('1: reuse has no in-app remedy; other conditions keep theirs', () => {
    expect(remedyFor('grant_revoked_reuse')).toEqual({ kind: 'reconnect' });
    expect(remedyFor('sync_failed')).toBeNull();
  });

  it('2: always explains the condition, within the sanitized cap', async () => {
    const o = toObservation(row(), NOW);
    expect(o.detail).toMatch(/on purpose.*refresh token was reused/i);
    expect(o.detail).toMatch(/reconnect/i);
    readCounts.mockResolvedValueOnce(new Map([['client-aaaa1111', 740]]));
    const [d] = await decorateStillRetrying([o], NOW);
    expect(d!.detail).toContain('(740 failed refreshes today, UTC)');
    expect(d!.detail).toMatch(/refresh token was reused/);
    expect(d!.detail!.length).toBeLessThanOrEqual(300);
  });

  it('3: display name carries owner email and created date; identical rows get the client suffix', () => {
    const a = toObservation(row({ client_id: 'client-aaaa1111' }), NOW);
    const b = toObservation(row({ client_id: 'client-bbbb2222' }), NOW);
    const c = toObservation(row({ account_id: ACCT2, owner_email: 'sam@example.com' }), NOW);
    expect(a.displayName).toBe('Claude Code (breeze) (pat@example.com, 2026-10-10)');
    expect(a.displayName.length).toBeLessThanOrEqual(80);
    const out = disambiguateDisplayNames([a, b, c]);
    expect(out[0]!.displayName).toMatch(/ · aaaa1111$/);
    expect(out[1]!.displayName).toMatch(/ · bbbb2222$/);
    expect(out[2]!.displayName).toBe('Claude Code (breeze) (sam@example.com, 2026-10-10)');
  });

  it('3b: the 80 code-point cap holds after disambiguation, even for long names and emails', () => {
    const long = { client_name: 'n'.repeat(500), owner_email: `${'e'.repeat(120)}@example.com` };
    const out = disambiguateDisplayNames([
      toObservation(row({ ...long, client_id: 'client-aaaa1111' }), NOW),
      toObservation(row({ ...long, client_id: 'client-bbbb2222' }), NOW),
    ]);
    for (const o of out) {
      expect(Array.from(o.displayName).length).toBeLessThanOrEqual(80);
      expect(o.displayName).toMatch(/^n{8,}.*, 2026-10-10\) · (aaaa1111|bbbb2222)$/);
    }
  });

  it('4: a later active grant of the same client_name under a NEW client id retires the incident', () => {
    expect(toObservation(row(), NOW).state).toBe('broken');
    expect(toObservation(row({ has_later_by_name: true, has_active_by_name: true }), NOW).state).toBe('healthy');
    expect(toObservation(row({ has_later_by_name: true }), NOW).state).toBe('retired');
  });
});
