/**
 * External identities of portal accounts (`portal_user_identities`, portal
 * registration W2 / spec §5.2). This module owns every identity write and the
 * drift report between the table and the legacy `portal_users.entra_*`
 * columns.
 *
 * Release A (this wave): the table is backfilled from `portal_users.entra_*`
 * (2027-01-22-210500-portal-account-foundations.sql) and the AI for Office
 * exchange dual-writes it (services/clientAiExchange.ts). **Nothing reads it
 * for authorization yet** — reads stay on `portal_users.entra_tenant_id /
 * entra_oid` until identities release B (W3), which switches reads and turns
 * the drift report below into a repair job. Release C drops the columns.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { portalUserIdentities } from '../db/schema/portal';

/** `db` or a transaction handle (same shape as `ContactExecutor`, services/contacts/compat.ts). */
export type IdentityExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The Entra v2.0 issuer for a tenant — the `iss` an Entra v2 ID token carries. */
export function entraIssuer(tid: string): string {
  return `https://login.microsoftonline.com/${tid}/v2.0`;
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
 *     it and, in release A, does not deny (reads are still on the columns).
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
 * `portal_users.entra_*`. Run after each deploy of release A via
 * `scripts/portal-identity-reconcile.ts`; W3 turns it into the repair job that
 * gates the read switch.
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
