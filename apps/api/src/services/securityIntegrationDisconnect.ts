/**
 * Disconnect and reconnect for the partner-level SentinelOne and Huntress
 * integrations (#12691).
 *
 * Disconnect is soft. The integration row stays because synced agents,
 * threats, incidents and site/org mappings reference it, and history must stay
 * readable. What changes:
 *   - `is_active` goes false. Every sync worker, poller, manual sync, action
 *     dispatcher, installer resolver and the Huntress webhook already refuse an
 *     inactive integration.
 *   - Every stored secret on the row is set to NULL: the SentinelOne API token
 *     and each site's registration token; the Huntress API key, account key
 *     and webhook signing secret. A disconnected integration holds nothing
 *     that could reach the vendor or enroll an agent.
 *
 * Reconnect rule: connecting the same provider again, while the partner has no
 * active integration, reactivates the partner's most recently disconnected row
 * instead of inserting a new one. History and the site/org mappings stay on
 * one integration id, and the `(partner_id) WHERE is_active` unique index is
 * never contended. A reconnect is treated like a first connect: every secret
 * must be supplied again; nothing stored on the old row is revived.
 *
 * The writes below run in the caller's DB context, so forced RLS fences them
 * to the caller's partner; the explicit partner condition is the app-layer
 * half of that fence.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbTransactionIfHeld, withSystemDbAccessContext } from '../db';
import { huntressIntegrations, s1Integrations, s1OrgMappings } from '../db/schema';

export type DisconnectedIntegration = { id: string; partnerId: string; name: string };

export async function disconnectS1Integration(partnerId: string): Promise<DisconnectedIntegration | null> {
  return withDbTransactionIfHeld(async () => {
    const now = new Date();
    const [row] = await db
      .update(s1Integrations)
      .set({ isActive: false, apiTokenEncrypted: null, updatedAt: now })
      .where(and(eq(s1Integrations.partnerId, partnerId), eq(s1Integrations.isActive, true)))
      .returning({ id: s1Integrations.id, partnerId: s1Integrations.partnerId, name: s1Integrations.name });
    if (!row) return null;

    // Site registration tokens enroll agents into the vendor console. The
    // site → org assignments themselves are kept for a reconnect.
    await db
      .update(s1OrgMappings)
      .set({ registrationToken: null, updatedAt: now })
      .where(and(eq(s1OrgMappings.integrationId, row.id), eq(s1OrgMappings.partnerId, partnerId)));
    return row;
  });
}

export async function disconnectHuntressIntegration(partnerId: string): Promise<DisconnectedIntegration | null> {
  const [row] = await db
    .update(huntressIntegrations)
    .set({
      isActive: false,
      apiKeyEncrypted: null,
      accountKeyEncrypted: null,
      webhookSecretEncrypted: null,
      updatedAt: new Date(),
    })
    .where(and(eq(huntressIntegrations.partnerId, partnerId), eq(huntressIntegrations.isActive, true)))
    .returning({ id: huntressIntegrations.id, partnerId: huntressIntegrations.partnerId, name: huntressIntegrations.name });
  return row ?? null;
}

/** The row a reconnect reactivates, or null when the partner never had one. */
export async function findReconnectableS1Integration(partnerId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: s1Integrations.id })
    .from(s1Integrations)
    .where(and(eq(s1Integrations.partnerId, partnerId), eq(s1Integrations.isActive, false)))
    .orderBy(desc(s1Integrations.updatedAt), desc(s1Integrations.id))
    .limit(1);
  return row ?? null;
}

export async function findReconnectableHuntressIntegration(partnerId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: huntressIntegrations.id })
    .from(huntressIntegrations)
    .where(and(eq(huntressIntegrations.partnerId, partnerId), eq(huntressIntegrations.isActive, false)))
    .orderBy(desc(huntressIntegrations.updatedAt), desc(huntressIntegrations.id))
    .limit(1);
  return row ?? null;
}

/**
 * Which of these integration ids are active. Used to label synced history rows
 * that came from a disconnected integration.
 *
 * Runs in system context because the integration tables are partner-axis and
 * an organization-scope caller cannot read them. It only answers for ids taken
 * from rows the caller already read under its own RLS, and returns nothing but
 * membership.
 */
export async function activeIntegrationIds(
  vendor: 'sentinelone' | 'huntress',
  ids: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => {
      if (vendor === 'sentinelone') {
        return db
          .select({ id: s1Integrations.id })
          .from(s1Integrations)
          .where(and(inArray(s1Integrations.id, unique), eq(s1Integrations.isActive, true)));
      }
      return db
        .select({ id: huntressIntegrations.id })
        .from(huntressIntegrations)
        .where(and(inArray(huntressIntegrations.id, unique), eq(huntressIntegrations.isActive, true)));
    })
  );
  return new Set(rows.map((row) => row.id));
}
