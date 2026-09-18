import { describe, expect, it } from 'vitest';
import {
  M365_SYNC_DOMAINS,
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  M365_SYNC_DOMAIN_INTERVAL_BOUNDS,
  isM365SyncDomain,
} from './sync';

describe('m365 sync domain vocabulary', () => {
  it('names exactly the seven persisted domains in schedule order', () => {
    expect(M365_SYNC_DOMAINS).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
      'signin_events',
    ]);
    expect(new Set(M365_SYNC_DOMAINS).size).toBe(M365_SYNC_DOMAINS.length);
  });

  it('gives every domain a default interval inside its own bounds', () => {
    for (const domain of M365_SYNC_DOMAINS) {
      const bounds = M365_SYNC_DOMAIN_INTERVAL_BOUNDS[domain];
      const seconds = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain];
      expect(Number.isSafeInteger(seconds)).toBe(true);
      expect(bounds.min).toBeLessThan(bounds.max);
      expect(seconds).toBeGreaterThanOrEqual(bounds.min);
      expect(seconds).toBeLessThanOrEqual(bounds.max);
    }
  });

  it('floors sign-in activity at a day — the app-wide Graph limit is 10 req/min', () => {
    // spec §0.1: signInActivity is throttled per app across ALL tenants, so its
    // floor is an order of magnitude above every other domain's.
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_activity.min).toBe(24 * 3600);
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_activity.max).toBe(7 * 24 * 3600);
    expect(M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.signin_activity).toBe(24 * 3600);
  });

  it('floors signin_events at a day too — /auditLogs/signIns is its own expensive surface', () => {
    // #5784 W05. A DIFFERENT Graph surface from signin_activity's
    // /users?$select=signInActivity (its own token bucket in the executor), but
    // the same order of expense, so the same 24 h floor and 7-day ceiling.
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_events.min).toBe(24 * 3600);
    expect(M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_events.max).toBe(7 * 24 * 3600);
    expect(M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.signin_events).toBe(24 * 3600);
  });

  it('narrows unknown strings', () => {
    expect(isM365SyncDomain('users')).toBe(true);
    expect(isM365SyncDomain('mailboxes')).toBe(false);
    expect(isM365SyncDomain('')).toBe(false);
  });
});
