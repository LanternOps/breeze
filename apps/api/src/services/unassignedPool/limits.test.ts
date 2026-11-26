import { describe, expect, it } from 'vitest';
import {
  DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE,
  DEPLOY_KEY_MAX_PARKED,
  DEPLOY_KEY_MAX_TTL_DAYS,
  DEPLOY_KEY_MAX_USAGE,
  DEPLOY_KEY_RATE,
  PARKED_DEVICE_TTL_DAYS,
  PARKED_DEVICES_PER_PARTNER_MAX,
  parkedCertificateLifetimeDays,
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

// Spec 2026-10-12 §10.4 / §13 decision 9: a pool-enrolled certificate lives no
// longer than the device's parked expiry (whole days, rounded down, at least 1).
describe('parkedCertificateLifetimeDays', () => {
  const DAY = 86_400_000;
  const parkedAt = new Date('2026-11-01T00:00:00.000Z');
  const at = (days: number) => parkedAt.getTime() + days * DAY;

  it('day 0: the full parking window when the policy is longer', () => {
    expect(PARKED_DEVICE_TTL_DAYS).toBe(14);
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(0) })).toBe(14);
  });

  it('rounds the days left down', () => {
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(0.5) })).toBe(13);
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(12.01) })).toBe(1);
  });

  it('day 13.9: never below one day', () => {
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(13.9) })).toBe(1);
  });

  it('at and past the parked expiry: one day', () => {
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(14) })).toBe(1);
    expect(parkedCertificateLifetimeDays({ policyDays: 90, parkedAt, now: at(20) })).toBe(1);
  });

  it('keeps a policy shorter than the days left', () => {
    expect(parkedCertificateLifetimeDays({ policyDays: 7, parkedAt, now: at(0) })).toBe(7);
    expect(parkedCertificateLifetimeDays({ policyDays: 1, parkedAt, now: at(0) })).toBe(1);
    expect(parkedCertificateLifetimeDays({ policyDays: 7, parkedAt, now: at(10) })).toBe(4);
  });
});
