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
import { db, getCurrentDbAccessContext, getDbContextMemo, withDbTransactionIfHeld } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
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
    forgetActiveIntegrationLookups();
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
  forgetActiveIntegrationLookups();
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
  } finally {
    // A connect, edit or reconnect may change which integration is active.
    forgetActiveIntegrationLookups();
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

const LEGACY_EDR_VENDORS: readonly LegacyEdrVendor[] = ['sentinelone', 'huntress'];

/**
 * Per-request memo of the active lookup: `vendor:id` -> whether that
 * integration is active. Lives in getDbContextMemo, so it lasts one outermost
 * DB context (one request) and never carries across requests: a disconnect is
 * seen by the next request. The writes in this module clear it, so a request
 * that changes an integration's state never reads its own stale answer.
 */
const ACTIVE_INTEGRATION_MEMO = Symbol('securityIntegrationDisconnect.activeIntegrationIds');

function forgetActiveIntegrationLookups(): void {
  getDbContextMemo(ACTIVE_INTEGRATION_MEMO)?.clear();
}

/**
 * Which of these integration ids are active. Used to label synced history rows
 * that came from a disconnected integration.
 *
 * Reads through readWithPartnerAxisVisibility because the integration tables
 * are partner-axis and an organization-scope caller cannot read them. It only
 * answers for ids taken from rows the caller already read under its own RLS,
 * and returns nothing but membership.
 */
export async function activeIntegrationIds(
  vendor: LegacyEdrVendor,
  ids: readonly string[],
): Promise<Set<string>> {
  return (await activeIntegrationIdsByVendor({ [vendor]: ids }))[vendor];
}

/**
 * activeIntegrationIds for both vendors at once. Same contract: pass only ids
 * from rows the caller already read; it returns membership only.
 *
 * Connections. A caller already in system scope reads in place, on its own
 * connection. Any other caller escalates (readWithPartnerAxisVisibility),
 * which takes a second pooled connection from the small nested reserve, so
 * that caller's answers are memoised for the rest of its request: one
 * escalation covers every vendor asked about together, concurrent calls share
 * one in-flight lookup, a later call looks up only the ids not answered yet,
 * and no id is ever looked up twice in one request. A failed lookup rejects
 * every caller waiting on it and is forgotten, so a later call retries; it is
 * never read as "active".
 */
export async function activeIntegrationIdsByVendor(
  ids: Partial<Record<LegacyEdrVendor, readonly string[]>>,
): Promise<Record<LegacyEdrVendor, Set<string>>> {
  const wanted = {
    sentinelone: [...new Set(ids.sentinelone ?? [])],
    huntress: [...new Set(ids.huntress ?? [])],
  };
  // System scope reads in place: nothing to save, and no memo to go stale
  // across a long-lived job context.
  const memo = getCurrentDbAccessContext()?.scope === 'system'
    ? undefined
    : getDbContextMemo<Promise<boolean>>(ACTIVE_INTEGRATION_MEMO);
  if (!memo) return readActiveIntegrationIds(wanted);

  const key = (vendor: LegacyEdrVendor, id: string) => `${vendor}:${id}`;
  const missing = {
    sentinelone: wanted.sentinelone.filter((id) => !memo.has(key('sentinelone', id))),
    huntress: wanted.huntress.filter((id) => !memo.has(key('huntress', id))),
  };
  if (missing.sentinelone.length > 0 || missing.huntress.length > 0) {
    const lookup = readActiveIntegrationIds(missing);
    for (const vendor of LEGACY_EDR_VENDORS) {
      for (const id of missing[vendor]) {
        const entry = lookup.then((active) => active[vendor].has(id));
        // Forget a failed answer so a later call retries. This branch also
        // marks the rejection handled; every awaiter still sees it.
        entry.catch(() => {
          if (memo.get(key(vendor, id)) === entry) memo.delete(key(vendor, id));
        });
        memo.set(key(vendor, id), entry);
      }
    }
  }

  const answer = async (vendor: LegacyEdrVendor) => {
    const flags = await Promise.all(wanted[vendor].map((id) => memo.get(key(vendor, id))!));
    return new Set(wanted[vendor].filter((_, i) => flags[i]));
  };
  const [sentinelone, huntress] = await Promise.all([answer('sentinelone'), answer('huntress')]);
  return { sentinelone, huntress };
}

/** The lookup itself: one partner-axis read covering both vendors. */
async function readActiveIntegrationIds(
  ids: Record<LegacyEdrVendor, readonly string[]>,
): Promise<Record<LegacyEdrVendor, Set<string>>> {
  if (ids.sentinelone.length === 0 && ids.huntress.length === 0) {
    return { sentinelone: new Set(), huntress: new Set() };
  }
  return readWithPartnerAxisVisibility(async () => {
    const s1Rows = ids.sentinelone.length === 0 ? [] : await db
      .select({ id: s1Integrations.id })
      .from(s1Integrations)
      .where(and(inArray(s1Integrations.id, [...ids.sentinelone]), eq(s1Integrations.isActive, true)));
    const huntressRows = ids.huntress.length === 0 ? [] : await db
      .select({ id: huntressIntegrations.id })
      .from(huntressIntegrations)
      .where(and(inArray(huntressIntegrations.id, [...ids.huntress]), eq(huntressIntegrations.isActive, true)));
    return {
      sentinelone: new Set(s1Rows.map((row) => row.id)),
      huntress: new Set(huntressRows.map((row) => row.id)),
    };
  });
}

export type ActiveAgentIntegrationIds = Record<LegacyEdrVendor, string[]>;

/**
 * Current coverage from SentinelOne and Huntress agent rows (#12726).
 *
 * Agent rows outlive a disconnect, so a reader that treats them as "this
 * device is protected" must first drop the rows of a disconnected
 * integration. For each vendor KEY in `where`, and only those, this reads the
 * distinct integration ids of the agent rows its condition selects IN THE
 * CALLER'S DB CONTEXT (forced RLS fences that read to the caller's orgs), then
 * asks activeIntegrationIdsByVendor which of those are active. A key whose
 * condition is `undefined` reads every agent row of that vendor the caller can
 * see; a vendor left out is not read and is absent from the result. It can
 * only answer about integrations behind agent rows the caller could already
 * read, and returns nothing but those ids.
 *
 * Feed a vendor's list to agentOfActiveIntegration to filter the reader's own
 * query. Connections: the agent-row reads are plain SELECTs on the caller's
 * connection; the active check costs at most one escalation per request (see
 * activeIntegrationIdsByVendor). Neither opens a savepoint or a
 * withDbTransaction on the caller's transaction, so the call may sit beside
 * sibling queries in a Promise.all.
 */
export async function activeIntegrationIdsOfReadableAgents<V extends LegacyEdrVendor>(
  where: Record<V, SQL | undefined>,
): Promise<Record<V, string[]>> {
  const vendors = LEGACY_EDR_VENDORS.filter((vendor): vendor is V => vendor in where);
  const conditions = where as Partial<Record<LegacyEdrVendor, SQL | undefined>>;
  const readIds = async (vendor: LegacyEdrVendor): Promise<string[]> => {
    if (!(vendor in conditions)) return [];
    const rows = vendor === 'sentinelone'
      ? await db.selectDistinct({ integrationId: s1Agents.integrationId }).from(s1Agents).where(conditions.sentinelone)
      : await db.selectDistinct({ integrationId: huntressAgents.integrationId }).from(huntressAgents).where(conditions.huntress);
    return rows.map((row) => row.integrationId);
  };
  const [s1Ids, huntressIds] = await Promise.all([readIds('sentinelone'), readIds('huntress')]);
  const active = await activeIntegrationIdsByVendor({ sentinelone: s1Ids, huntress: huntressIds });
  const result = {} as Record<V, string[]>;
  for (const vendor of vendors) result[vendor] = [...active[vendor]];
  return result;
}

/**
 * activeIntegrationIdsOfReadableAgents over one org's agent rows, for the
 * org-scoped coverage readers (portal, reports). Pass `vendors` to read only
 * the vendors the reader uses; by default both.
 */
export async function activeAgentIntegrationIdsForOrg<V extends LegacyEdrVendor = LegacyEdrVendor>(
  orgId: string,
  vendors: readonly V[] = LEGACY_EDR_VENDORS as readonly V[],
): Promise<Record<V, string[]>> {
  const orgConditions: Record<LegacyEdrVendor, SQL> = {
    sentinelone: eq(s1Agents.orgId, orgId),
    huntress: eq(huntressAgents.orgId, orgId),
  };
  const where = {} as Record<V, SQL>;
  for (const vendor of vendors) where[vendor] = orgConditions[vendor];
  return activeIntegrationIdsOfReadableAgents(where);
}

/**
 * SQL condition: this agent row's integration is one of `activeIds` (from
 * activeIntegrationIdsOfReadableAgents). An empty list matches nothing, so a
 * caller with no connected integration counts no agent.
 */
export function agentOfActiveIntegration(integrationIdColumn: SQLWrapper, activeIds: readonly string[]): SQL {
  return activeIds.length > 0 ? inArray(integrationIdColumn, [...activeIds]) : sql`false`;
}
