import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEffectivePolicy, policyResponse, maxAchievableTier, assertTiersAchievable, CALLER_VERIFICATION_POLICY_DEFAULTS } from './policy';
import type { PolicyRow } from './types';

const row = (p: Partial<PolicyRow>) => p as PolicyRow;

it('uses partner as baseline; defaults do not override tier zero', () => {
  const p = resolveEffectivePolicy(row({ requiredTierResetPassword: 0 }), row({ verificationTtlMinutes: 240 }));
  expect(p.requiredTierResetPassword).toBe(0);
  expect(p.provenance.requiredTierResetPassword).toBe('partner');
  // Org may only tighten (min): 240 > default 30 is ignored.
  expect(p.verificationTtlMinutes).toBe(30);
  expect(p.ignored).toContain('verificationTtlMinutes');
});

it('applies every tightening operator', () => {
  const p = resolveEffectivePolicy(null, row({
    requiredTierResetPassword: 3, requiredTierDisableUser: 3, verificationTtlMinutes: 5, workstationTimeoutSeconds: 30,
    destinationMinAgeDays: 90, requireAttestedDestination: true, requireTicket: true, allowCrossTechnicianUse: true,
    allowAdministrativeDisable: false, allowedMethods: ['sms'], disableUserAuthorizerRoles: [], maxAttemptsPerHour: 1, coolingOffHours: 48,
  }));
  expect(p).toMatchObject({
    requiredTierResetPassword: 3, requiredTierDisableUser: 3, verificationTtlMinutes: 5, workstationTimeoutSeconds: 30,
    destinationMinAgeDays: 90, requireAttestedDestination: true, requireTicket: true, allowCrossTechnicianUse: false,
    allowAdministrativeDisable: false, allowedMethods: ['sms'], disableUserAuthorizerRoles: [], maxAttemptsPerHour: 1, coolingOffHours: 48,
  });
  expect(p.ignored).toEqual(['allowCrossTechnicianUse']);
  for (const key of ['requiredTierResetPassword', 'allowedMethods', 'coolingOffHours']) expect(p.provenance[key]).toBe('org');
});

it('intersects mixed arrays and reports the field ignored when any member was outside the baseline', () => {
  const p = resolveEffectivePolicy(row({ allowedMethods: ['sms', 'email'] }), row({ allowedMethods: ['sms', 'workstation'] }));
  expect(p.allowedMethods).toEqual(['sms']);
  expect(p.ignored).toEqual(['allowedMethods']);
  expect(p.provenance.allowedMethods).toBe('org');
});

it('equality retains baseline provenance', () => {
  const p = resolveEffectivePolicy(row({ requiredTierResetPassword: 3 }), row({ requiredTierResetPassword: 3 }));
  expect(p.provenance.requiredTierResetPassword).toBe('partner');
  expect(p.ignored).toEqual([]);
});

it.each(['org', 'partner'] as const)('returns independent defaults, baseline and effective for %s', (owner) => {
  const partner = row({ requiredTierResetPassword: 1, verificationTtlMinutes: 60 });
  const org = row({ requiredTierResetPassword: 3, verificationTtlMinutes: 15 });
  const result = policyResponse(partner, org, owner);
  expect(result.row).toBe(owner === 'org' ? org : partner);
  expect(result.defaults).toEqual(CALLER_VERIFICATION_POLICY_DEFAULTS);
  expect(result.baseline).toMatchObject({ requiredTierResetPassword: 1, verificationTtlMinutes: 60 });
  expect(result.effective).toMatchObject({
    requiredTierResetPassword: owner === 'org' ? 3 : 1,
    verificationTtlMinutes: owner === 'org' ? 15 : 60,
  });
  expect(result.baseline).not.toHaveProperty('provenance');
});

describe('tier clamp while the workstation tier is dark (W05)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('maxAchievableTier is 2 by default and 3 only with the exact workstation flag', () => {
    delete process.env.CALLER_VERIFICATION_WORKSTATION_ENABLED;
    expect(maxAchievableTier()).toBe(2);
    vi.stubEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', '1');
    expect(maxAchievableTier()).toBe(2);
    vi.stubEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', 'true');
    expect(maxAchievableTier()).toBe(3);
  });

  it.each(['org', 'partner'] as const)('policyResponse exposes maxAchievableTier for %s', (owner) => {
    delete process.env.CALLER_VERIFICATION_WORKSTATION_ENABLED;
    expect(policyResponse(null, null, owner).maxAchievableTier).toBe(2);
    vi.stubEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', 'true');
    expect(policyResponse(null, null, owner).maxAchievableTier).toBe(3);
  });

  it('assertTiersAchievable refuses tier 3 for either action only while dark', () => {
    delete process.env.CALLER_VERIFICATION_WORKSTATION_ENABLED;
    expect(() => assertTiersAchievable({ requiredTierResetPassword: 3 })).toThrowError(expect.objectContaining({ code: 'tier_unachievable' }));
    expect(() => assertTiersAchievable({ requiredTierDisableUser: 3 })).toThrowError(expect.objectContaining({ code: 'tier_unachievable' }));
    expect(() => assertTiersAchievable({ requiredTierResetPassword: 2, requiredTierDisableUser: null })).not.toThrow();
    expect(() => assertTiersAchievable({})).not.toThrow();
    vi.stubEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', 'true');
    expect(() => assertTiersAchievable({ requiredTierResetPassword: 3, requiredTierDisableUser: 3 })).not.toThrow();
  });
});
