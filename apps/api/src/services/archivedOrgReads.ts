/**
 * Explicit reads of ARCHIVED organizations (org-lifecycle Wave 4, Task 3).
 *
 * Spec: docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md
 * (Part 2, "Hidden + read-only").
 *
 * `archived` orgs are excluded from `computeAccessibleOrgIds`
 * (`status IN ('active','trial')`), so a request's own RLS context cannot see
 * them at all — by design. These helpers are the explicit, opt-in door, and
 * they are the only place in the org routes that opens
 * `withArchivedOrgReadContext`.
 *
 * Two phases, on purpose:
 *
 *  1. **Discovery** — a minimal `id`-only SELECT under a system context,
 *     hard-pinned to the caller's VERIFIED partner id (never client input). The
 *     archived read context takes an explicit id allowlist, so something has to
 *     resolve "which archived orgs does this partner have" first, and nothing
 *     but a system context can see those rows.
 *  2. **Serving** — the actual row read runs under
 *     `withArchivedOrgReadContext`, whose transaction is `READ ONLY`. The
 *     system context above is read-WRITE, so serving full rows from it would
 *     hand callers exactly the capability Part 2 exists to withhold.
 *
 * Both phases run inside `runOutsideDbContext` because the request already
 * holds a tenant context: `withSystemDbAccessContext` would otherwise
 * early-return into it (discovery silently returns zero rows), and
 * `withArchivedOrgReadContext` refuses to nest outright.
 */
import { and, eq, ilike, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withArchivedOrgReadContext,
  withSystemDbAccessContext,
} from '../db';
import { devices, organizations } from '../db/schema';
import { escapeLike } from '../utils/sql';

type OrganizationRow = typeof organizations.$inferSelect;

/**
 * An archived org row, flagged so a caller merging it into a list of live orgs
 * (and the web UI rendering that list) can tell the two apart without
 * re-deriving it from `status`.
 */
export type ArchivedOrganizationRow = OrganizationRow & { archived: true };

/**
 * List shape: the org list endpoint renders `{{count}} devices` per card, and a
 * missing count interpolates to a bare " devices" (#3699). The request's own
 * RLS context cannot count an archived org's devices (its `org_id` is not in
 * `accessibleOrgIds`), so the count is taken inside the archived read
 * transaction rather than left to default to 0 and quietly under-report.
 */
export type ArchivedOrganizationListRow = ArchivedOrganizationRow & { deviceCount: number };

/**
 * Archived orgs ride ALONGSIDE the paginated live list rather than inside it
 * (they cannot be in the same query — see the module header), so they are capped
 * at the page `limit` instead of being paginated. `truncated` says whether that
 * cap actually dropped rows, so the caller can tell the operator "there are more"
 * instead of silently showing a short list — the archive view is where a missing
 * tenant is least likely to be noticed and most expensive to miss (its purge
 * timer is running).
 */
export interface ArchivedOrgListResult {
  orgs: ArchivedOrganizationListRow[];
  truncated: boolean;
}

/**
 * Which partner's archived orgs a read may reach. Deliberately a discriminated
 * union rather than a nullable `partnerId`: "null means every partner" is one
 * forgotten `?? null` away from a cross-tenant read, and this door is opened
 * from request handlers. `allPartners` is reachable only from system scope.
 */
/**
 * `partnerSelection` is the `org_access='selected'` member: partner ownership
 * PLUS the member's raw `partner_users.org_ids` list. It is a separate variant
 * rather than an optional `orgIds?: string[]` on `partner` for the same reason
 * the union exists at all — an optional allowlist is one forgotten `??` away
 * from widening the read, and archiving an org must never make it visible to
 * someone who was 404'd on it the day before.
 */
export type ArchivedOrgScope =
  | { kind: 'partner'; partnerId: string }
  | { kind: 'partnerSelection'; partnerId: string; orgIds: string[] }
  | { kind: 'allPartners' };

function partnerCondition(scope: ArchivedOrgScope): SQL | undefined {
  if (scope.kind === 'allPartners') return undefined;
  if (scope.kind === 'partner') return eq(organizations.partnerId, scope.partnerId);
  // An empty selection is an explicit impossible predicate, never `undefined`:
  // `inArray(col, [])` is safe in current drizzle, but a `where(undefined)`
  // left behind by a future edit would select every partner's archived orgs.
  if (scope.orgIds.length === 0) return sql`false`;
  return and(
    eq(organizations.partnerId, scope.partnerId),
    inArray(organizations.id, scope.orgIds),
  );
}

/** Does this scope admit one specific archived org id? */
function scopeAdmitsOrg(scope: ArchivedOrgScope, target: { id: string; partnerId: string }): boolean {
  if (scope.kind === 'allPartners') return true;
  if (target.partnerId !== scope.partnerId) return false;
  return scope.kind === 'partner' || scope.orgIds.includes(target.id);
}

function searchCondition(search: string | undefined): SQL | undefined {
  const trimmed = search?.trim();
  return trimmed ? ilike(organizations.name, `%${escapeLike(trimmed)}%`) : undefined;
}

function flagArchived(row: OrganizationRow): ArchivedOrganizationRow {
  return { ...row, archived: true };
}

/**
 * Ids of the scope's archived (not soft-deleted) orgs, oldest-first, capped at
 * `limit`. A partner-scope caller must pass its own verified `auth.partnerId`.
 */
async function discoverArchivedOrgIds(input: {
  scope: ArchivedOrgScope;
  search?: string | undefined;
  limit: number;
}): Promise<string[]> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            partnerCondition(input.scope),
            eq(organizations.status, 'archived'),
            isNull(organizations.deletedAt),
            // The hidden per-partner support org is never enumerated anywhere
            // else either (see the org list handler) — archiving is not a way
            // to surface it.
            ne(organizations.type, 'quick_support'),
            searchCondition(input.search),
          ),
        )
        .orderBy(organizations.createdAt, organizations.id)
        .limit(input.limit),
    ),
  );

  return rows.map((row) => row.id);
}

/**
 * Full archived org rows for the scope, read through the READ ONLY context.
 * Returns no rows (without opening the second transaction) when there are none.
 *
 * Discovery asks for `limit + 1` ids purely to answer "is there more?" — the
 * extra id is dropped before the serving read, so the cap on rows returned is
 * exactly `limit`. That is one indexed id-only row, versus a second COUNT query
 * over the same predicate.
 */
export async function listArchivedOrgs(input: {
  scope: ArchivedOrgScope;
  search?: string | undefined;
  limit: number;
}): Promise<ArchivedOrgListResult> {
  const discovered = await discoverArchivedOrgIds({ ...input, limit: input.limit + 1 });
  const truncated = discovered.length > input.limit;
  const ids = truncated ? discovered.slice(0, input.limit) : discovered;
  if (ids.length === 0) return { orgs: [], truncated: false };

  const { rows, deviceCounts } = await runOutsideDbContext(() =>
    withArchivedOrgReadContext(ids, async () => {
      const orgRows = await db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, ids))
        .orderBy(organizations.createdAt, organizations.id);
      const counts = await db
        .select({ orgId: devices.orgId, count: sql<number>`count(*)` })
        .from(devices)
        .where(inArray(devices.orgId, ids))
        .groupBy(devices.orgId);
      return { rows: orgRows, deviceCounts: counts };
    }),
  );

  const deviceCountByOrgId = new Map(
    deviceCounts.map((row) => [row.orgId, Number(row.count)]),
  );

  return {
    orgs: rows.map((row) => ({
      ...flagArchived(row),
      deviceCount: deviceCountByOrgId.get(row.id) ?? 0,
    })),
    truncated,
  };
}

/**
 * One archived org, or null when the target does not exist, is not archived, is
 * soft-deleted, or is outside the scope — all four collapse to the same "not
 * found" for the caller, so an archived org never becomes a cross-tenant
 * existence oracle.
 */
export async function loadArchivedOrg(input: {
  orgId: string;
  scope: ArchivedOrgScope;
}): Promise<ArchivedOrganizationRow | null> {
  const [target] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: organizations.id,
          partnerId: organizations.partnerId,
          status: organizations.status,
          deletedAt: organizations.deletedAt,
          type: organizations.type,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1),
    ),
  );

  if (!target) return null;
  if (target.status !== 'archived') return null;
  if (target.deletedAt !== null) return null;
  if (target.type === 'quick_support') return null;
  // Partner ownership AND, for a 'selected' member, the raw selection —
  // archiving an org must not widen who can read its full row.
  if (!scopeAdmitsOrg(input.scope, target)) return null;

  const [row] = await runOutsideDbContext(() =>
    withArchivedOrgReadContext([input.orgId], () =>
      db.select().from(organizations).where(eq(organizations.id, input.orgId)).limit(1),
    ),
  );

  return row ? flagArchived(row) : null;
}
