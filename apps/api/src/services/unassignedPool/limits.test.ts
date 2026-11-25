import { describe, expect, it } from 'vitest';
import {
  DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE,
  DEPLOY_KEY_MAX_PARKED,
  DEPLOY_KEY_MAX_TTL_DAYS,
  DEPLOY_KEY_MAX_USAGE,
  DEPLOY_KEY_RATE,
  PARKED_DEVICES_PER_PARTNER_MAX,
} from './limits';

// The ceilings confirmed in review (spec 2026-10-12 §10.2, §13 decision 8).
// The migration's CHECK constraints (2027-01-31-100000-partner-deploy-keys.sql)
// repeat the first three numbers; change both together or not at all.
describe('deploy-key ceilings', () => {
  it('match the confirmed numbers', () => {
    expect(DEPLOY_KEY_MAX_TTL_DAYS).toBe(365);
    expect(DEPLOY_KEY_MAX_USAGE).toBe(1000);
    expect(DEPLOY_KEY_MAX_PARKED).toBe(20);
    expect(DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE).toBe(2);
  });

  it('keep the parked cap and the rate buckets unchanged (#8318 condition)', () => {
    expect(PARKED_DEVICES_PER_PARTNER_MAX).toBe(50);
    expect(DEPLOY_KEY_RATE).toEqual({
      perKey: { limit: 10, windowSeconds: 600 },
      perPartner: { limit: 25, windowSeconds: 600 },
    });
  });

  it('never lets one key park more than the partner cap', () => {
    expect(DEPLOY_KEY_MAX_PARKED).toBeLessThan(PARKED_DEVICES_PER_PARTNER_MAX);
  });
});
