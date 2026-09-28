/**
 * Best-effort provider-side release on disconnect (spec W02 "Disconnect"):
 * Xero → DELETE /connections/{provider_connection_ref}. Runs BEFORE the row
 * (and its tokens) is deleted, and never blocks the disconnect. Never token
 * revocation (quorum finding 3): that would drop every link the authorising
 * user has to the app, which can include another Breeze partner's connection.
 */
import { db } from '../../db';
import { captureException } from '../sentry';
import { rateLimitRetryAfterMs } from './accountingProviderError';
import { assertNoAmbientDbContext } from './dbContextGuard';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { findAccountingProvider } from './providerRegistry';
import type { AccountingConnection } from './accountingConnectionService';

export type ProviderReleaseOutcome = 'released' | 'skipped' | 'failed';

export async function releaseProviderConnection(conn: AccountingConnection): Promise<ProviderReleaseOutcome> {
  // getValidAccessToken may refresh (its own short system transactions) and the
  // release is an outbound call: neither may run inside a held request context.
  assertNoAmbientDbContext('releaseProviderConnection');
  const impl = findAccountingProvider(conn.provider);
  if (!impl?.releaseConnection || !conn.providerConnectionRef) return 'skipped';
  try {
    const accessToken = await getValidAccessToken(db, conn);
    await impl.releaseConnection({ ...conn, accessToken });
    return 'released';
  } catch (err) {
    // A revoked grant or a throttle is an expected outcome, not an incident: the
    // link stays at the provider and the user can remove it there.
    if (!(err instanceof ReauthRequiredError) && rateLimitRetryAfterMs(err) === null) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingProviderRelease' });
    }
    console.warn('[accountingProviderRelease] provider-side release failed; disconnecting anyway', {
      connectionId: conn.id, provider: conn.provider, error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
