/**
 * B-W03 (#6157): is this CIMD client id already an admitted, enabled
 * `oauth_clients` row? Used by `cimdAllowFetch` so a refetch for a known client
 * (its cached document expired or was evicted) draws on its own budget and
 * cannot be starved by a flood of new, attacker-chosen client ids.
 *
 * A read only; it runs outside any request DB context (no fetch happens here).
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients } from '../db/schema';

export async function isActiveMaterializedCimdClient(clientId: string): Promise<boolean> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ disabledAt: oauthClients.disabledAt })
        .from(oauthClients)
        .where(eq(oauthClients.id, clientId))
        .limit(1),
    ),
  );
  return Boolean(row) && !row!.disabledAt;
}
