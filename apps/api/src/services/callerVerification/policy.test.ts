import { expect, it } from 'vitest';
import { resolveEffectivePolicy, policyResponse, CALLER_VERIFICATION_POLICY_DEFAULTS } from './policy';
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
