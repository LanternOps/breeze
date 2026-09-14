import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { m365Users } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

type Sources = M365SyncActionResult['sources'];

/** `default_mfa_method` is varchar(64); a longer foreign value must not fail the chunk. */
const DEFAULT_MFA_METHOD_MAX = 64;

function sourceOk(sources: Sources, key: 'mfaRegistration' | 'roleAssignments'): boolean {
  return sources[key] === 'ok';
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function mfaMethodOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, DEFAULT_MFA_METHOD_MAX) : null;
}

function rolesArray(value: unknown): Array<{ roleTemplateId: string; displayName: string; viaGroupId?: string }> {
  return Array.isArray(value) ? value as Array<{ roleTemplateId: string; displayName: string }> : [];
}

/**
 * Active directory-role assignments for one user, as projected by the executor
 * (`{ roleTemplateId, displayName, viaGroupId? }[]`). Anything that is not an
 * array is "no roles" rather than a throw: it is customer data from a foreign
 * API and must never be able to fail a whole chunk.
 */
export function deriveIsAdmin(adminRoles: unknown): boolean {
  return Array.isArray(adminRoles) && adminRoles.length > 0;
}

/**
 * Enrichment columns for ONE inserted row (spec §5.5/§6). A column whose source
 * did not return `ok` is OMITTED, so an insert leaves it NULL ("unknown") and an
 * update leaves the stored value alone. A user missing from a SUCCESSFUL
 * registration report arrives with `mfaRegistered: null` and that null is
 * written — never coerced to `false`.
 */
export function usersEnrichmentInsertColumns(
  item: Record<string, unknown>,
  sources: Sources,
): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (sourceOk(sources, 'mfaRegistration')) {
    columns.mfaRegistered = boolOrNull(item.mfaRegistered);
    columns.mfaCapable = boolOrNull(item.mfaCapable);
    columns.defaultMfaMethod = mfaMethodOrNull(item.defaultMfaMethod);
  }
  if (sourceOk(sources, 'roleAssignments')) {
    const roles = rolesArray(item.adminRoles);
    columns.adminRoles = roles;
    columns.isAdmin = deriveIsAdmin(roles);
  }
  return columns;
}

/**
 * The ON CONFLICT branch of the SAME statement. `is_admin` is recomputed from
 * `excluded.admin_roles` in SQL, and the two keys are always added or omitted
 * together, so the pair cannot disagree.
 */
export function usersEnrichmentUpdateSet(sources: Sources): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  if (sourceOk(sources, 'mfaRegistration')) {
    set.mfaRegistered = sql`excluded.mfa_registered`;
    set.mfaCapable = sql`excluded.mfa_capable`;
    set.defaultMfaMethod = sql`excluded.default_mfa_method`;
  }
  if (sourceOk(sources, 'roleAssignments')) {
    set.adminRoles = sql`excluded.admin_roles`;
    set.isAdmin = sql`jsonb_array_length(coalesce(excluded.admin_roles, '[]'::jsonb)) > 0`;
  }
  return set;
}

/**
 * Counters for `m365_sync_state.last_counts`, computed in memory (spec §5.9 —
 * no count query). A counter whose source failed is OMITTED, not zeroed: the
 * stored columns still hold the previous run's values, so counting this run's
 * all-null items would report a fully-registered tenant as "0 registered". An
 * omitted key becomes NULL in the rollup — the "unknown" spec §3.3 exists for.
 */
export function usersEnrichmentCounts(
  items: Record<string, unknown>[],
  sources: Sources,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const mfaOk = sourceOk(sources, 'mfaRegistration');
  const rolesOk = sourceOk(sources, 'roleAssignments');
  const unknown = (item: Record<string, unknown>) => boolOrNull(item.mfaRegistered) === null;
  if (mfaOk) {
    counts.users_mfa_registered = items.filter((item) => item.mfaRegistered === true).length;
    counts.users_mfa_unknown = items.filter(unknown).length;
  }
  if (rolesOk) {
    const admins = items.filter((item) => deriveIsAdmin(item.adminRoles));
    counts.users_admin = admins.length;
    if (mfaOk) {
      counts.admins_without_mfa = admins.filter((item) => item.mfaRegistered === false).length;
      counts.admins_mfa_unknown = admins.filter(unknown).length;
    }
  }
  return counts;
}

/**
 * The enrichment pass for rows the primary upsert did NOT write.
 *
 * W04's upsert is change-only on the PRIMARY hash, so a user whose MFA
 * registration or role membership changed while their primary fields did not
 * is not in the upsert at all — and enrichment is deliberately out of the hash
 * (§5.4). This is one set-based, field-wise `UPDATE … FROM (VALUES …)` per
 * 1 000-row chunk, keyed (org_id, graph_id), writing only the columns whose
 * source is `ok` and only rows where one of them actually differs
 * (`IS DISTINCT FROM`), so a steady tenant still writes zero rows. Never
 * touches core_hash or last_changed_at: enrichment is not a primary change.
 *
 * The worker holds no ambient context here (spec §5.3), so each chunk opens
 * its own system context via `writeEntityChunks`; the explicit `org_id`
 * predicate is the tenant boundary, not RLS.
 */
async function writeEnrichmentPass(
  ctx: PersistContext,
  items: Array<Record<string, unknown> & { id: string }>,
  sources: Sources,
): Promise<void> {
  const mfaOk = sourceOk(sources, 'mfaRegistration');
  const rolesOk = sourceOk(sources, 'roleAssignments');
  if ((!mfaOk && !rolesOk) || items.length === 0) return;

  await writeEntityChunks(items, async (chunk) => {
    const values = sql.join(chunk.map((item) => {
      const cells: SQL[] = [sql`${item.id}::text`];
      if (mfaOk) {
        cells.push(
          sql`${boolOrNull(item.mfaRegistered)}::boolean`,
          sql`${boolOrNull(item.mfaCapable)}::boolean`,
          sql`${mfaMethodOrNull(item.defaultMfaMethod)}::varchar`,
        );
      }
      if (rolesOk) cells.push(sql`${JSON.stringify(rolesArray(item.adminRoles))}::jsonb`);
      return sql`(${sql.join(cells, sql`, `)})`;
    }), sql`, `);

    const columns: string[] = ['graph_id'];
    const sets: SQL[] = [];
    const differs: SQL[] = [];
    if (mfaOk) {
      columns.push('mfa_registered', 'mfa_capable', 'default_mfa_method');
      for (const column of ['mfa_registered', 'mfa_capable', 'default_mfa_method']) {
        sets.push(sql.raw(`${column} = p.${column}`));
        differs.push(sql.raw(`u.${column} is distinct from p.${column}`));
      }
    }
    if (rolesOk) {
      columns.push('admin_roles');
      sets.push(sql.raw('admin_roles = p.admin_roles'));
      sets.push(sql.raw('is_admin = jsonb_array_length(p.admin_roles) > 0'));
      differs.push(sql.raw('u.admin_roles is distinct from p.admin_roles'));
      differs.push(sql.raw('u.is_admin is distinct from (jsonb_array_length(p.admin_roles) > 0)'));
    }

    await db.execute(sql`
      update m365_users u
      set ${sql.join(sets, sql`, `)}
      from (values ${values}) as p(${sql.raw(columns.join(', '))})
      where u.org_id = ${ctx.orgId}::uuid
        and u.graph_id = p.graph_id
        and (${sql.join(differs, sql` or `)})
    `);
  }, ctx);
}

/**
 * PRIMARY fields (spec §3.2, §5.4) plus the source-gated enrichment columns
 * (§5.5). Enrichment is absent from the hash: if it were in it, a
 * registration-report outage would rewrite every user row on the next run.
 * `last_successful_sign_in_at` is never written here — it is the
 * signin_activity domain's column.
 */
interface UserItem {
  id?: string;
  userPrincipalName?: string | null;
  displayName?: string | null;
  mail?: string | null;
  accountEnabled?: boolean | null;
  jobTitle?: string | null;
  department?: string | null;
  usageLocation?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  createdDateTime?: string | null;
  assignedLicenses?: string[] | null;
}

/**
 * The canonical primary-field projection. Exported so W05's enrichment pass
 * hashes the identical field set — a second definition would drift and rewrite
 * every user row.
 */
export function usersPrimaryProjection(item: UserItem): Record<string, unknown> {
  return {
    userPrincipalName: item.userPrincipalName ?? null,
    displayName: item.displayName ?? null,
    mail: item.mail ?? null,
    accountEnabled: item.accountEnabled ?? null,
    jobTitle: item.jobTitle ?? null,
    department: item.department ?? null,
    usageLocation: item.usageLocation ?? null,
    onPremisesSyncEnabled: item.onPremisesSyncEnabled ?? null,
    createdDateTime: item.createdDateTime ?? null,
    assignedLicenses: item.assignedLicenses ?? [],
  };
}

export async function persistUsers(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as UserItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.users] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const projection = usersPrimaryProjection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(projection),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        userPrincipalName: projection.userPrincipalName as string | null,
        displayName: projection.displayName as string | null,
        mail: projection.mail as string | null,
        accountEnabled: projection.accountEnabled as boolean | null,
        jobTitle: projection.jobTitle as string | null,
        department: projection.department as string | null,
        usageLocation: projection.usageLocation as string | null,
        onPremisesSyncEnabled: projection.onPremisesSyncEnabled as boolean | null,
        graphCreatedAt: projection.createdDateTime ? new Date(projection.createdDateTime as string) : null,
        assignedSkuIds: projection.assignedLicenses as string[],
        coreHash: canonicalHash(projection),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
        ...usersEnrichmentInsertColumns(item as Record<string, unknown>, result.sources),
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365Users).values(chunk).onConflictDoUpdate({
      target: [m365Users.orgId, m365Users.graphId],
      set: {
        userPrincipalName: sqlExcluded('user_principal_name'),
        displayName: sqlExcluded('display_name'),
        mail: sqlExcluded('mail'),
        accountEnabled: sqlExcluded('account_enabled'),
        jobTitle: sqlExcluded('job_title'),
        department: sqlExcluded('department'),
        usageLocation: sqlExcluded('usage_location'),
        onPremisesSyncEnabled: sqlExcluded('on_premises_sync_enabled'),
        graphCreatedAt: sqlExcluded('graph_created_at'),
        assignedSkuIds: sqlExcluded('assigned_sku_ids'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
        ...usersEnrichmentUpdateSet(result.sources),
      },
    });
  }, ctx);

  // Rows the upsert just wrote already carry their enrichment; every other
  // fetched user gets the field-wise pass.
  const written = new Set(plan.rows.map((row) => row.graphId));
  await writeEnrichmentPass(
    ctx,
    (result.items as Array<Record<string, unknown>>)
      .filter((item): item is Record<string, unknown> & { id: string } =>
        typeof item.id === 'string' && item.id.length > 0 && !written.has(item.id)),
    result.sources,
  );

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365Users as never, ctx.orgId, plan.staleIds, ctx.now, ctx)
    : 0;

  return {
    inserted: plan.inserted,
    updated: plan.updated,
    unchanged: plan.unchanged,
    stale,
    complete,
    counts: {
      users_total: items.length,
      users_enabled: items.filter((item) => item.accountEnabled === true).length,
      ...usersEnrichmentCounts(result.items, result.sources),
    },
  };
}
