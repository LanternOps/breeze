import { fetchWithAuth } from './auth';
import type { RiskTier, AssuranceLevel } from '@breeze/shared';

/**
 * Breeze Authenticator (Phase 4) — partner approval-security policy client.
 * Reads/writes the per-MSP enforcement floor. The server re-validates the
 * raise-only invariant; this client constrains the UI to it as well.
 */
export interface AuthenticatorPolicy {
  floorOverrides: Partial<Record<RiskTier, AssuranceLevel>>;
  /** null = blank: the partner inherits the platform default. */
  requireEnrollment: boolean | null;
  enforceFrom: string | null;
}

/** The policy in force once the platform default is folded in (server-computed). */
export interface EffectiveAuthenticatorPolicy {
  source: 'explicit' | 'platform_default';
  mode: 'off' | 'grace' | 'enforcing';
  requireEnrollment: boolean;
  enforceFrom: string | null;
  enforcedTiers: RiskTier[];
  /** Set only while inheriting the platform default: 'upcoming' before its
   * date, 'active' from it. */
  defaultNotice: 'upcoming' | 'active' | null;
}

export interface AuthenticatorPolicyState {
  policy: AuthenticatorPolicy;
  effective: EffectiveAuthenticatorPolicy;
  platformDefault: { enforceFrom: string; enforcedTiers: RiskTier[] };
}

export async function getAuthenticatorPolicyState(): Promise<AuthenticatorPolicyState> {
  const res = await fetchWithAuth('/authenticator/policy');
  // Throw on a server error so the tab shows its load-error state rather than
  // an empty/undefined policy (fetchWithAuth doesn't throw on non-2xx).
  if (!res.ok) throw new Error('Failed to load approval-security policy.');
  return (await res.json()) as AuthenticatorPolicyState;
}

export async function putAuthenticatorPolicy(policy: AuthenticatorPolicy): Promise<Response> {
  return fetchWithAuth('/authenticator/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}
