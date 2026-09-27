/**
 * Pickers for a connection's default refs, plus the organisation name and
 * demo-company badge (Xero W02, plan refinement 7 — the status route stays
 * DB-only). Live provider reads; no DB context is held across them: the
 * connection row is read in one short `runInDbContext` transaction and the
 * token refresh + provider calls run with nothing held.
 */
import {
  AccountingMappingError, callProviderOrThrow, resolveConnectionAndToken,
} from './accountingMappingService';
import type { DbContextRunner } from './dbContextGuard';
import { accountingProviderDisplayName, getAccountingProvider } from './providerRegistry';
import type { AccountingProviderId, ProviderSettingsOptions } from './types';

export async function listProviderSettingsOptions(
  input: { partnerId: string; provider: AccountingProviderId },
  runInDbContext: DbContextRunner,
): Promise<ProviderSettingsOptions> {
  const impl = getAccountingProvider(input.provider);
  const label = accountingProviderDisplayName(input.provider);
  if (!impl.listSettingsOptions) {
    throw new AccountingMappingError('capability_unavailable', 409, `${label} has no settings pickers`);
  }
  // not_connected (incl. a pending_tenant row) → 404, reauth_required → 409, token throttle → 429.
  const { liveConn } = await resolveConnectionAndToken(input.partnerId, { provider: input.provider }, runInDbContext);
  // Throttle → 429 rate_limited with retryAfterMs; anything else (incl. a plain
  // Error such as a missing tenant id) → 502 provider_error with no upstream text.
  return callProviderOrThrow(
    () => impl.listSettingsOptions!(liveConn),
    `${label} returned an error while loading settings options`,
  );
}
