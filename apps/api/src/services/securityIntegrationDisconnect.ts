/**
 * Disconnect and reconnect for the partner-level SentinelOne and Huntress
 * integrations (#12691).
 *
 * Disconnect is soft. The integration row stays because synced agents,
 * threats, incidents and site/org mappings reference it, and history must stay
 * readable. What changes:
 *   - `is_active` goes false. The sync workers, the action poller, manual sync,
 *     the installer resolvers and the Huntress webhook refuse an inactive
 *     integration. S1 isolation and threat actions resolve their integration
 *     through getActiveS1IntegrationForOrg, which returns only an active one;
 *     the dispatchers behind it would also fail on the missing token.
 *   - Every stored secret on the row is set to NULL: the SentinelOne API token
 *     and each site's registration token; the Huntress API key, account key
 *     and webhook signing secret. A row disconnected here holds nothing that
 *     could reach the vendor or enroll an agent. (A row deactivated before
 *     #12691, through `isActive: false` on the connect route, may still hold
 *     its secrets until it is reconnected; nothing reads them while inactive.)
 *
 * Reconnect rule: connecting the same provider again, while the partner has no
 * active integration, reactivates the partner's most recently disconnected row
 * instead of inserting a new one. History and the site/org mappings stay on
 * one integration id, and the `(partner_id) WHERE is_active` unique index is
 * normally uncontended. A reconnect is treated like a first connect: every
 * secret must be supplied again; nothing stored on the old row is revived,
 * including S1 site registration tokens, which a reconnect clears.
 *
 * Races. An edit locks the active row before it reads the secrets it keeps,
 * so it cannot write them back over a disconnect; one that saw the row active
 * and then lost it to a disconnect answers 409. Two connects that race answer
 * 409 for the loser: a lost race on the unique index, or, for two reconnects
 * of one row, an update that finds the row already reactivated. Disconnect locks the
 * integration row first and its mappings second; the S1 sync takes the same
 * integration lock before it writes any mapping. A sync that finishes after a
 * disconnect writes no status onto the disconnected row.
 *
 * The writes below run in the caller's DB context. For a partner-scope caller
 * forced RLS fences them to that partner; for a system-scope caller the
 * explicit partner condition is the only fence.
 *
 * Write gate. The integration rows are partner-wide state: one connection
 * serves every organization under the partner. Each exported function that
 * writes takes the caller's auth and refuses, before any statement, a caller
 * that fails canManagePartnerWidePolicies (a partner member with selected-org
 * access, or an organization-scope user), with PartnerWideWriteDeniedError.
 * The routes check the same capability first; this check keeps a future
 * caller that forgets its own gate from clearing a partner's credentials.
 */
import { and, desc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbTransactionIfHeld, withSystemDbAccessContext } from '../db';
import { huntressAgents, huntressIntegrations, s1Agents, s1Integrations, s1OrgMappings } from '../db/schema';
import { isPgUniqueViolation } from '../utils/pgErrors';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';

export type DisconnectedIntegration = { id: string; partnerId: string; name: string };

/** The part of the caller's auth the write gate reads. */
export type IntegrationWriteAuth = Pick<AuthContext, 'scope' | 'partnerOrgAccess'>;

function assertCanWritePartnerIntegration(auth: IntegrationWriteAuth): void {
  if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
}

/** Throws PartnerWideWriteDeniedError, before any write, unless the caller may manage partner-wide state. */
export async function disconnectS1Integration(
  auth: IntegrationWriteAuth,
  partnerId: string,
): Promise<DisconnectedIntegration | null> {
  assertCanWritePartnerIntegration(auth);
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
    await clearSiteRegistrationTokens(row.id, partnerId);
    return row;
  });
}

/** Throws PartnerWideWriteDeniedError, before any write, unless the caller may manage partner-wide state. */
export async function disconnectHuntressIntegration(
  auth: IntegrationWriteAuth,
  partnerId: string,
): Promise<DisconnectedIntegration | null> {
  assertCanWritePartnerIntegration(auth);
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

/**
 * Run a connect/edit/reconnect write in a savepoint and answer a lost race on
 * the partner's `(partner_id) WHERE is_active` unique index as 'conflict'
 * instead of a 500. The savepoint keeps the failed statement from poisoning
 * the request transaction, so the caller can still answer 409.
 */
export async function writeOrActiveIndexConflict<T>(
  constraint: 's1_integrations_partner_active_idx' | 'huntress_integrations_partner_active_idx',
  write: () => Promise<T>,
): Promise<T | 'conflict'> {
  try {
    return await withDbTransactionIfHeld(write);
  } catch (error) {
    if (isPgUniqueViolation(error, constraint)) return 'conflict';
    throw error;
  }
}

/**
 * Reconnect clears every site registration token stored for the integration.
 * A row deactivated before #12691 can still hold them, and a site the console
 * no longer returns would otherwise keep its old token; the first sync after
 * the reconnect stores fresh ones. Runs after the integration row is updated,
 * so it locks integration then mappings, the same order as disconnect.
 * Throws PartnerWideWriteDeniedError, before any write, unless the caller may
 * manage partner-wide state.
 */
export async function clearS1SiteRegistrationTokens(
  auth: IntegrationWriteAuth,
  integrationId: string,
  partnerId: string,
): Promise<void> {
  assertCanWritePartnerIntegration(auth);
  await clearSiteRegistrationTokens(integrationId, partnerId);
}

/** Ungated; reached only from the gated entry points above. */
async function clearSiteRegistrationTokens(integrationId: string, partnerId: string): Promise<void> {
  await db
    .update(s1OrgMappings)
    .set({ registrationToken: null, updatedAt: new Date() })
    .where(and(eq(s1OrgMappings.integrationId, integrationId), eq(s1OrgMappings.partnerId, partnerId)));
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

type LegacyEdrVendor = 'sentinelone' | 'huntress';

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
  vendor: LegacyEdrVendor,
  ids: readonly string[],
): Promise<Set<string>> {
  return (await activeIntegrationIdsByVendor({ [vendor]: ids }))[vendor];
}

/**
 * activeIntegrationIds for both vendors at once: one system-context
 * transaction on one separate pooled connection, whatever the vendor count, so
 * a reader that needs both does not hold two extra connections. Same contract:
 * pass only ids from rows the caller already read; it returns membership only.
 */
export async function activeIntegrationIdsByVendor(
  ids: Partial<Record<LegacyEdrVendor, readonly string[]>>,
): Promise<Record<LegacyEdrVendor, Set<string>>> {
  const s1Ids = [...new Set(ids.sentinelone ?? [])];
  const huntressIds = [...new Set(ids.huntress ?? [])];
  if (s1Ids.length === 0 && huntressIds.length === 0) {
    return { sentinelone: new Set(), huntress: new Set() };
  }
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const s1Rows = s1Ids.length === 0 ? [] : await db
        .select({ id: s1Integrations.id })
        .from(s1Integrations)
        .where(and(inArray(s1Integrations.id, s1Ids), eq(s1Integrations.isActive, true)));
      const huntressRows = huntressIds.length === 0 ? [] : await db
        .select({ id: huntressIntegrations.id })
        .from(huntressIntegrations)
        .where(and(inArray(huntressIntegrations.id, huntressIds), eq(huntressIntegrations.isActive, true)));
      return {
        sentinelone: new Set(s1Rows.map((row) => row.id)),
        huntress: new Set(huntressRows.map((row) => row.id)),
      };
    })
  );
}

export type ActiveAgentIntegrationIds = Record<LegacyEdrVendor, string[]>;

/**
 * Current coverage from SentinelOne and Huntress agent rows (#12726).
 *
 * Agent rows outlive a disconnect, so a reader that treats them as "this
 * device is protected" must first drop the rows of a disconnected
 * integration. For each vendor this reads the distinct integration ids of the
 * agent rows that its `where` selects IN THE CALLER'S DB CONTEXT (forced RLS
 * fences that read to the caller's orgs), then asks activeIntegrationIdsByVendor
 * which of those are active. It can only answer about integrations behind
 * agent rows the caller could already read, and returns nothing but those ids.
 *
 * Feed a vendor's list to agentOfActiveIntegration to filter the reader's own
 * query. Connections: the agent-row reads are plain SELECTs on the caller's
 * connection; the active check is one system-context transaction on a separate
 * pooled connection. Neither opens a savepoint or a withDbTransaction on the
 * caller's transaction, so the call may sit beside sibling queries in a
 * Promise.all.
 */
export async function activeIntegrationIdsOfReadableAgents(
  where: Record<LegacyEdrVendor, SQL | undefined>,
): Promise<ActiveAgentIntegrationIds> {
  const [s1Rows, huntressRows] = await Promise.all([
    db.selectDistinct({ integrationId: s1Agents.integrationId }).from(s1Agents).where(where.sentinelone),
    db.selectDistinct({ integrationId: huntressAgents.integrationId }).from(huntressAgents).where(where.huntress),
  ]);
  const active = await activeIntegrationIdsByVendor({
    sentinelone: s1Rows.map((row) => row.integrationId),
    huntress: huntressRows.map((row) => row.integrationId),
  });
  return { sentinelone: [...active.sentinelone], huntress: [...active.huntress] };
}

/**
 * activeIntegrationIdsOfReadableAgents over one org's agent rows. For the
 * org-scoped coverage readers (portal, reports).
 */
export async function activeAgentIntegrationIdsForOrg(orgId: string): Promise<ActiveAgentIntegrationIds> {
  return activeIntegrationIdsOfReadableAgents({
    sentinelone: eq(s1Agents.orgId, orgId),
    huntress: eq(huntressAgents.orgId, orgId),
  });
}

/**
 * SQL condition: this agent row's integration is one of `activeIds` (from
 * activeIntegrationIdsOfReadableAgents). An empty list matches nothing, so a
 * caller with no connected integration counts no agent.
 */
export function agentOfActiveIntegration(integrationIdColumn: SQLWrapper, activeIds: readonly string[]): SQL {
  return activeIds.length > 0 ? inArray(integrationIdColumn, [...activeIds]) : sql`false`;
}
