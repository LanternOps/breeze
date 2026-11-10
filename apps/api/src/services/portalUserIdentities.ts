/**
 * External identities of portal accounts (`portal_user_identities`, portal
 * registration W2 / spec §5.2). This module owns every runtime identity write,
 * the readers every other module uses, and the drift report between the table
 * and the legacy `portal_users.entra_*` columns.
 *
 * Release A (W2): the table was backfilled from `portal_users.entra_*`
 * (2027-01-22-230200-portal-account-foundations.sql) and the AI for Office
 * exchange started dual-writing it.
 *
 * Release B (W3, now): **every read of external identity lives here** —
 * `portalUserHasIdentitySql` (identity-managed / bulk-invite / capability
 * facts), `findPortalUserIdByEntraIdentity` (the add-in exchange's lookup) and
 * `listIdentityProvidersByUser` (the portal-user list). Nothing reads
 * `portal_users.entra_*` for a decision any more. Writers still dual-write those
 * columns (plan D4 writer fence) so a rolling-deploy release-A instance, which
 * still reads them, finds every account. The deploy migration
 * (2027-01-22-232800-portal-access-policies-requests.sql §4) re-ran the
 * backfill; the daily job (jobs/portalIdentityReconcile.ts) REPORTS drift and
 * never repairs it (plan D10). Release C drops the columns.
 */
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { portalUserIdentities, portalUsers, type PortalIdentityProvider } from '../db/schema/portal';

/** `db` or a transaction handle (same shape as `ContactExecutor`, services/contacts/compat.ts). */
export type IdentityExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The Entra v2.0 issuer for a tenant — the `iss` an Entra v2 ID token carries. */
export function entraIssuer(tid: string): string {
  return `https://login.microsoftonline.com/${tid}/v2.0`;
}

/** The `iss` of a Google ID token; the issuer stored for a Google request and identity. */
export const PORTAL_GOOGLE_ISSUER = 'https://accounts.google.com';

// ---------------------------------------------------------------------------
// Readers (identities release B)
// ---------------------------------------------------------------------------

/**
 * `EXISTS` over `portal_user_identities` for the OUTER `portal_users` row:
 * true when the account has any external identity (Entra or Google).
 *
 * Spells `"portal_users"."id"` as text on purpose. In a single-table select
 * drizzle rewrites every column chunk of a selection `sql` to a bare
 * identifier (#9692), so `${portalUsers.id}` would render `"id"` and bind to
 * the subquery's own `id` — every account would read as having no identity,
 * silently. The inner table is aliased so the outer name stays unambiguous.
 * Consequence: the outer query must reference `portal_users` by its table
 * name (no alias), which every caller does today.
 *
 * Usable in a selection and, negated, in a WHERE
 * (`sql\`not ${portalUserHasIdentitySql()}\``). A fresh object per call.
 */
export function portalUserHasIdentitySql(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from "portal_user_identities" "pui_has" where "pui_has"."portal_user_id" = "portal_users"."id")`;
}

/**
 * The Entra identity key — provider, issuer derived from the tenant, subject =
 * oid — as a `WHERE` over `portal_user_identities`. Shared by
 * {@link findPortalUserIdByEntraIdentity} and the add-in exchange, which joins
 * the identity to its login in one statement.
 */
export function entraIdentityMatch(input: { tid: string; oid: string }): SQL {
  return and(
    eq(portalUserIdentities.provider, 'entra'),
    eq(portalUserIdentities.issuer, entraIssuer(input.tid)),
    eq(portalUserIdentities.subject, input.oid),
  )!;
}

/**
 * The account an Entra identity belongs to, or null. Its `orgId` is the
 * account's org too (composite same-org FK), so a caller can compare it with
 * the org a tenant maps to before touching the account (spec §6 inv. 4).
 * Runs in the caller's DB context: under RLS it only sees identities the
 * context may read.
 */
export async function findPortalUserIdByEntraIdentity(
  exec: IdentityExecutor,
  input: { tid: string; oid: string },
): Promise<{ portalUserId: string; orgId: string } | null> {
  const [row] = await exec
    .select({ portalUserId: portalUserIdentities.portalUserId, orgId: portalUserIdentities.orgId })
    .from(portalUserIdentities)
    .where(entraIdentityMatch(input))
    .limit(1);
  return row ?? null;
}

/**
 * Providers per account, sorted, for the accounts given. Accounts with no
 * identity are absent from the map. No query for an empty list.
 */
export async function listIdentityProvidersByUser(
  exec: IdentityExecutor,
  portalUserIds: string[],
): Promise<Map<string, PortalIdentityProvider[]>> {
  const out = new Map<string, PortalIdentityProvider[]>();
  if (portalUserIds.length === 0) return out;
  const rows = await exec
    .select({ portalUserId: portalUserIdentities.portalUserId, provider: portalUserIdentities.provider })
    .from(portalUserIdentities)
    .where(inArray(portalUserIdentities.portalUserId, portalUserIds))
    .orderBy(portalUserIdentities.portalUserId, portalUserIdentities.provider);
  for (const row of rows) {
    const list = out.get(row.portalUserId);
    if (list) list.push(row.provider);
    else out.set(row.portalUserId, [row.provider]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Plain insert of an Entra identity that THROWS on conflict (23505 on either
 * unique key). For use only inside the JIT savepoint in clientAiExchange, so a
 * collision rolls back the login insert with it (no half-provisioned row).
 */
export async function insertEntraIdentity(
  exec: IdentityExecutor,
  input: { orgId: string; portalUserId: string; tid: string; oid: string; linkedVia: 'jit'; usedAt: Date },
): Promise<void> {
  await exec.insert(portalUserIdentities).values({
    orgId: input.orgId,
    portalUserId: input.portalUserId,
    provider: 'entra',
    issuer: entraIssuer(input.tid),
    subject: input.oid,
    entraTenantId: input.tid,
    linkedVia: input.linkedVia,
    lastUsedAt: input.usedAt,
  });
}

export type EnsureIdentityOutcome = 'inserted' | 'present' | 'conflict';

/**
 * Make sure an existing Entra login has its identity row, and record its use.
 *
 * `INSERT … ON CONFLICT DO NOTHING` (no target, so it covers BOTH unique keys)
 * never raises 23505, so it needs no savepoint and cannot poison the caller's
 * transaction. Then the use is recorded on the row only if it belongs to this
 * user. Returns:
 *   - `inserted` — the row did not exist (e.g. a login written by an older
 *     binary during the deploy window) and now does;
 *   - `present`  — it already belonged to this user; `last_used_at` bumped;
 *   - `conflict` — the `(issuer, subject)` belongs to another user, or this
 *     user already holds a different Entra subject. Drift: the caller reports
 *     it. Since release B the exchange finds the login THROUGH this identity,
 *     so on that path `conflict` only means the identity moved mid-exchange.
 */
export async function ensureEntraIdentity(
  exec: IdentityExecutor,
  input: { orgId: string; portalUserId: string; tid: string; oid: string; usedAt: Date },
): Promise<EnsureIdentityOutcome> {
  const issuer = entraIssuer(input.tid);
  const inserted = await exec
    .insert(portalUserIdentities)
    .values({
      orgId: input.orgId,
      portalUserId: input.portalUserId,
      provider: 'entra',
      issuer,
      subject: input.oid,
      entraTenantId: input.tid,
      linkedVia: 'jit',
      lastUsedAt: input.usedAt,
    })
    .onConflictDoNothing()
    .returning({ id: portalUserIdentities.id });
  if (inserted.length > 0) return 'inserted';

  const touched = await exec
    .update(portalUserIdentities)
    .set({ lastUsedAt: input.usedAt })
    .where(and(
      eq(portalUserIdentities.issuer, issuer),
      eq(portalUserIdentities.subject, input.oid),
      eq(portalUserIdentities.portalUserId, input.portalUserId),
    ))
    .returning({ id: portalUserIdentities.id });
  return touched.length > 0 ? 'present' : 'conflict';
}

export type LinkIdentityResult = { kind: 'linked' } | { kind: 'conflict' };

/**
 * Link an external identity to an EXISTING account (portal registration W4:
 * an invitation-bound or a session-bound Microsoft sign-in, spec §5.6 steps
 * 2–3). Never called on an email match (inv. 5): the caller has already proven
 * continuity through the invite or the signed-in session.
 *
 * Runs on the caller's transaction, sequentially, and never raises a unique
 * violation, so it cannot poison that transaction:
 *  1. the legacy `(entra_tenant_id, entra_oid)` key (`portal_users_entra_identity_uniq`)
 *     held by ANOTHER login is drift the daily reconcile reports; refuse here
 *     rather than hit 23505 in step 3. Nothing is written;
 *  2. ONE `INSERT … ON CONFLICT DO NOTHING RETURNING` (no target: both unique
 *     keys, `(issuer, subject)` and `(portal_user_id, provider)`). No row →
 *     `conflict`, nothing written;
 *  3. on success, the W3 D4 writer fence: `portal_users.entra_tenant_id` /
 *     `entra_oid` in the same transaction (a release-A reader still finds the
 *     account) and, when `clearPasswordHash`, `password_hash = NULL` in that
 *     same statement (plan D12: linking while the org is effectively
 *     `sso_only`). No epoch bump.
 *
 * Throws when the login is not in `orgId` after the identity was written; the
 * caller's transaction must roll back.
 */
export async function linkPortalUserIdentity(
  tx: IdentityExecutor,
  input: {
    orgId: string;
    portalUserId: string;
    provider: 'entra';
    tid: string;
    oid: string;
    linkedVia: 'invite' | 'self_link' | 'jit';
    clearPasswordHash: boolean;
    now: Date;
  },
): Promise<LinkIdentityResult> {
  const [legacyHolder] = await tx
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(
      eq(portalUsers.entraTenantId, input.tid),
      eq(portalUsers.entraOid, input.oid),
      ne(portalUsers.id, input.portalUserId),
    ))
    .limit(1);
  if (legacyHolder) return { kind: 'conflict' };

  const inserted = await tx
    .insert(portalUserIdentities)
    .values({
      orgId: input.orgId,
      portalUserId: input.portalUserId,
      provider: input.provider,
      issuer: entraIssuer(input.tid),
      subject: input.oid,
      entraTenantId: input.tid,
      linkedVia: input.linkedVia,
      lastUsedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: portalUserIdentities.id });
  if (inserted.length === 0) return { kind: 'conflict' };

  const updated = await tx
    .update(portalUsers)
    .set({
      entraTenantId: input.tid,
      entraOid: input.oid,
      ...(input.clearPasswordHash ? { passwordHash: null } : {}),
      updatedAt: input.now,
    })
    .where(and(eq(portalUsers.id, input.portalUserId), eq(portalUsers.orgId, input.orgId)))
    .returning({ id: portalUsers.id });
  if (updated.length === 0) throw new Error('linkPortalUserIdentity: the portal account is not in this org');
  return { kind: 'linked' };
}

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

export type IdentityMismatchField = 'subject' | 'entra_tenant_id' | 'org_id';

export interface PortalIdentityDriftReport {
  checkedAt: string;
  counts: { missingIdentity: number; orphanIdentity: number; mismatched: number; halfPopulated: number };
  samples: {
    /** Both `entra_*` columns set, no `provider='entra'` identity. */
    missingIdentity: Array<{ portalUserId: string; orgId: string }>;
    /** An Entra identity whose login has `entra_oid IS NULL`. */
    orphanIdentity: Array<{ identityId: string; portalUserId: string }>;
    /** Login and identity disagree on the subject, the tenant or the org. */
    mismatched: Array<{ portalUserId: string; identityId: string; field: IdentityMismatchField }>;
    /** Exactly one of `entra_oid` / `entra_tenant_id` set (never backfilled). */
    halfPopulated: Array<{ portalUserId: string }>;
  };
}

const DEFAULT_SAMPLE_LIMIT = 100;

type CountedRow = { total: number } & Record<string, unknown>;

async function bucket<T>(query: SQL, map: (row: Record<string, unknown>) => T): Promise<{ count: number; samples: T[] }> {
  const rows = (await db.execute(query)) as unknown as CountedRow[];
  return { count: rows.length > 0 ? Number(rows[0]!.total) : 0, samples: rows.map(map) };
}

/**
 * Report (never repair) drift between `portal_user_identities` and
 * `portal_users.entra_*`. Run on demand via `scripts/portal-identity-reconcile.ts`
 * (prints the samples) and daily by `jobs/portalIdentityReconcile.ts` (counts
 * only). Repair happens once, at deploy, in the migration (plan D10): a
 * scheduled repair could resurrect an identity a later unlink writer removed
 * while the legacy columns were still set.
 *
 * Opens its own system context and refuses to run inside one that is already
 * held, so it is never nested inside a request transaction. The four buckets
 * are read sequentially (never `Promise.all` inside one transaction).
 */
export async function reconcilePortalUserIdentities(
  opts: { orgId?: string; sampleLimit?: number } = {},
): Promise<PortalIdentityDriftReport> {
  if (hasDbAccessContext()) {
    throw new Error('reconcilePortalUserIdentities must not run inside a held DB access context');
  }
  const limit = Math.max(1, Math.floor(opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT));
  const userOrg = opts.orgId ? sql`AND pu.org_id = ${opts.orgId}` : sql``;
  const identityOrg = opts.orgId ? sql`AND i.org_id = ${opts.orgId}` : sql``;

  return withSystemDbAccessContext(async () => {
    const missingIdentity = await bucket(sql`
      SELECT pu.id AS portal_user_id, pu.org_id, count(*) OVER () AS total
        FROM portal_users pu
       WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL ${userOrg}
         AND NOT EXISTS (SELECT 1 FROM portal_user_identities i
                          WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
       ORDER BY pu.id
       LIMIT ${limit}`,
      (r) => ({ portalUserId: String(r.portal_user_id), orgId: String(r.org_id) }));

    const orphanIdentity = await bucket(sql`
      SELECT i.id AS identity_id, i.portal_user_id, count(*) OVER () AS total
        FROM portal_user_identities i
        JOIN portal_users pu ON pu.id = i.portal_user_id
       WHERE i.provider = 'entra' AND pu.entra_oid IS NULL ${identityOrg}
       ORDER BY i.id
       LIMIT ${limit}`,
      (r) => ({ identityId: String(r.identity_id), portalUserId: String(r.portal_user_id) }));

    const mismatched = await bucket(sql`
      SELECT pu.id AS portal_user_id, i.id AS identity_id,
             CASE WHEN pu.entra_oid IS DISTINCT FROM i.subject THEN 'subject'
                  WHEN pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id THEN 'entra_tenant_id'
                  ELSE 'org_id' END AS field,
             count(*) OVER () AS total
        FROM portal_user_identities i
        JOIN portal_users pu ON pu.id = i.portal_user_id
       WHERE i.provider = 'entra' AND pu.entra_oid IS NOT NULL ${userOrg}
         AND (pu.entra_oid IS DISTINCT FROM i.subject
              OR pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id
              OR pu.org_id IS DISTINCT FROM i.org_id)
       ORDER BY pu.id
       LIMIT ${limit}`,
      (r) => ({
        portalUserId: String(r.portal_user_id),
        identityId: String(r.identity_id),
        field: String(r.field) as IdentityMismatchField,
      }));

    const halfPopulated = await bucket(sql`
      SELECT pu.id AS portal_user_id, count(*) OVER () AS total
        FROM portal_users pu
       WHERE (pu.entra_oid IS NULL) <> (pu.entra_tenant_id IS NULL) ${userOrg}
       ORDER BY pu.id
       LIMIT ${limit}`,
      (r) => ({ portalUserId: String(r.portal_user_id) }));

    return {
      checkedAt: new Date().toISOString(),
      counts: {
        missingIdentity: missingIdentity.count,
        orphanIdentity: orphanIdentity.count,
        mismatched: mismatched.count,
        halfPopulated: halfPopulated.count,
      },
      samples: {
        missingIdentity: missingIdentity.samples,
        orphanIdentity: orphanIdentity.samples,
        mismatched: mismatched.samples,
        halfPopulated: halfPopulated.samples,
      },
    };
  });
}

/** True when a drift report found nothing. */
export function isDriftReportClean(report: PortalIdentityDriftReport): boolean {
  const c = report.counts;
  return c.missingIdentity + c.orphanIdentity + c.mismatched + c.halfPopulated === 0;
}
