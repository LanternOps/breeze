import { expect, it } from 'vitest';
import { computeTier } from './tiers';
import { resolveEffectivePolicy } from './policy';

it.each(['workstation', 'sms', 'email', 'callback_attestation', 'administrative_stepup'] as const)('computes %s', (method) => {
  const policy = resolveEffectivePolicy(null, null);
  expect(computeTier({ method, boundPrincipal: false, destinationEstablished: false, policy }).tier)
    .toBe(method === 'administrative_stepup' ? 3 : 1);
  expect(computeTier({ method, boundPrincipal: true, destinationEstablished: true, policy }).tier)
    .toBe(method === 'workstation' || method === 'administrative_stepup' ? 3 : method === 'callback_attestation' ? 1 : 2);
  policy.allowedMethods = [];
  expect(computeTier({ method, boundPrincipal: true, destinationEstablished: true, policy }).tier)
    .toBe(method === 'administrative_stepup' ? 3 : 0);
});

it('reports the reason for each tier and disables administrative by policy', () => {
  const policy = resolveEffectivePolicy(null, null);
  expect(computeTier({ method: 'workstation', boundPrincipal: false, destinationEstablished: false, policy }).reason).toBe('unbound_principal');
  expect(computeTier({ method: 'sms', boundPrincipal: false, destinationEstablished: false, policy }).reason).toBe('destination_recent');
  expect(computeTier({ method: 'sms', boundPrincipal: false, destinationEstablished: true, policy }).reason).toBe('destination_established');
  expect(computeTier({ method: 'administrative_stepup', boundPrincipal: false, destinationEstablished: false, policy: { ...policy, allowAdministrativeDisable: false } }))
    .toEqual({ tier: 0, reason: 'administrative' });
});
