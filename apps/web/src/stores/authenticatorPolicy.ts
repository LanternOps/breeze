import { fetchWithAuth } from './auth';
import type { RiskTier, AssuranceLevel } from '@breeze/shared';

/**
 * Breeze Authenticator (Phase 4) — partner approval-security policy client.
 * Reads/writes the per-MSP enforcement floor. The server re-validates the
 * raise-only invariant; this client constrains the UI to it as well.
 */
export interface AuthenticatorPolicy {
  floorOverrides: Partial<Record<RiskTier, AssuranceLevel>>;
  requireEnrollment: boolean;
  enforceFrom: string | null;
}

export async function getAuthenticatorPolicy(): Promise<AuthenticatorPolicy> {
  const res = await fetchWithAuth('/authenticator/policy');
  // Throw on a server error so the tab shows its load-error state rather than
  // an empty/undefined policy (fetchWithAuth doesn't throw on non-2xx).
  if (!res.ok) throw new Error('Failed to load approval-security policy.');
  const data = await res.json();
  return data.policy as AuthenticatorPolicy;
}

export async function putAuthenticatorPolicy(policy: AuthenticatorPolicy): Promise<Response> {
  return fetchWithAuth('/authenticator/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}
