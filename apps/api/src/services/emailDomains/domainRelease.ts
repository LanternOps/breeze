import { and, eq, isNotNull } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withSystemDbAccessContext } from '../../db';
import { emailProviderDomainReleases, partnerSendingDomains } from '../../db/schema';

/**
 * Release every provider-side sending domain a partner still owns (spec §3.5).
 *
 * WHY THIS EXISTS. `partner_sending_domains` carries a BEFORE DELETE trigger
 * that raises while `provider_domain_id` is set, so any path that deletes a
 * partner's rows without releasing first aborts loudly instead of silently
 * leaking a domain in the provider account. This is the one function that
 * satisfies the guard, and it is called FIRST in both partner-destroying paths.
 *
 * ORDER IS LOAD-BEARING. The outbox row is written BEFORE the handle is
 * nulled, so a crash between the two leaves a releasable outbox row rather than
 * an orphaned provider domain nobody can name any more. The outbox table
 * deliberately has no partner_id, so cascadeDeletePartner's sweep leaves it
 * standing.
 *
 * `provider_managed = false` rows get their handle cleared but NO outbox row:
 * that provider domain pre-existed Breeze asking for it and is very likely the
 * operator's primary sending domain. Leaking one is recoverable; deleting
 * someone's mail domain is not.
 *
 * NO PROVIDER CALLS. This runs inside destructive paths that must not depend on
 * a third party being reachable; the worker drains the outbox later.
 *
 * DB CONTEXT. `withSystemDbAccessContext` JOINS an existing context rather than
 * nesting (db/index.ts:654-656), which is exactly right for the two callers:
 * `cascadeDeletePartner` holds none and gets a fresh system transaction;
 * `finalizePartnerOffboarding` already runs inside one (sweepOffboardingTenants
 * wraps it) and this joins it — no second pooled connection. Because joining is
 * unconditional, a future caller inside a REQUEST context would run these
 * writes under a tenant scope and match zero rows, so the ambient scope is
 * asserted first.
 */
export async function releaseSendingDomainsForPartner(partnerId: string): Promise<number> {
  const ambient = getCurrentDbAccessContext();
  if (ambient && ambient.scope !== 'system') {
    throw new Error(
      `[emailDomains] releaseSendingDomainsForPartner must run in system scope; ambient scope is '${ambient.scope}'. ` +
        'withSystemDbAccessContext joins an existing context rather than elevating, so running here would match zero rows and leak every provider domain this partner owns.'
    );
  }

  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        id: partnerSendingDomains.id,
        domain: partnerSendingDomains.domain,
        provider: partnerSendingDomains.provider,
        providerDomainId: partnerSendingDomains.providerDomainId,
        providerRegion: partnerSendingDomains.providerRegion,
        providerManaged: partnerSendingDomains.providerManaged
      })
      .from(partnerSendingDomains)
      .where(and(
        eq(partnerSendingDomains.partnerId, partnerId),
        isNotNull(partnerSendingDomains.providerDomainId)
      ));

    let released = 0;
    for (const row of rows) {
      if (row.providerManaged && row.providerDomainId) {
        // onConflictDoNothing: the (provider, provider_domain_id) unique index
        // makes a re-run idempotent, which matters because cascadeDeletePartner
        // is documented as idempotent and the offboarding sweep can retry.
        await db
          .insert(emailProviderDomainReleases)
          .values({
            provider: row.provider,
            providerDomainId: row.providerDomainId,
            providerRegion: row.providerRegion,
            domain: row.domain,
            reason: 'partner_released'
          })
          .onConflictDoNothing({
            target: [emailProviderDomainReleases.provider, emailProviderDomainReleases.providerDomainId]
          });
      }
      await db
        .update(partnerSendingDomains)
        .set({ providerDomainId: null, updatedAt: new Date() })
        .where(eq(partnerSendingDomains.id, row.id));
      released++;
    }
    return released;
  }, 'emailDomains.releaseSendingDomainsForPartner');
}
