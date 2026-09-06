import { isHosted } from './env';

export type PartnerTrustMode = 'off' | 'shadow' | 'enforce';

/**
 * Partner trust probation flag. Self-hosted safeguard: resolves to 'off'
 * whenever IS_HOSTED is not true, regardless of PARTNER_TRUST_MODE, so a
 * self-hosted install never evaluates the gate. Read at call time (like
 * abuseSignalsEnabled) so tests can flip it per case.
 */
export function partnerTrustMode(): PartnerTrustMode {
  if (!isHosted()) return 'off';
  const raw = (process.env.PARTNER_TRUST_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  if (raw !== '') console.warn(`[PartnerTrust] Ignoring unrecognized PARTNER_TRUST_MODE value ${JSON.stringify(raw)}; using shadow`);
  return 'shadow';
}
