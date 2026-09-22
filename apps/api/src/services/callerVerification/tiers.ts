/**
 * Assurance tiers (spec "Tiers and establishment"). Pure.
 *
 *  0  method disabled by policy / administrative disable off
 *  1  callback attestation; unbound workstation; recent (unestablished) destination
 *  2  established destination (age + human provenance)
 *  3  bound workstation principal; administrative step-up
 *
 * An unbound workstation is tier 1, never 2 (v5 review-note correction).
 */
import type { CallerVerificationMethod } from './types';
import type { EffectiveCallerVerificationPolicy } from './policy';

export type TierReason =
  | 'bound_principal' | 'unbound_principal' | 'destination_established' | 'destination_recent'
  | 'attestation' | 'administrative' | 'method_disabled';

export function computeTier(input: {
  method: CallerVerificationMethod;
  boundPrincipal: boolean;
  destinationEstablished: boolean;
  policy: EffectiveCallerVerificationPolicy;
}): { tier: 0 | 1 | 2 | 3; reason: TierReason } {
  const { method, policy } = input;
  if (method === 'administrative_stepup') return { tier: policy.allowAdministrativeDisable ? 3 : 0, reason: 'administrative' };
  if (!policy.allowedMethods.includes(method)) return { tier: 0, reason: 'method_disabled' };
  if (method === 'callback_attestation') return { tier: 1, reason: 'attestation' };
  if (method === 'workstation') return input.boundPrincipal ? { tier: 3, reason: 'bound_principal' } : { tier: 1, reason: 'unbound_principal' };
  return input.destinationEstablished ? { tier: 2, reason: 'destination_established' } : { tier: 1, reason: 'destination_recent' };
}
