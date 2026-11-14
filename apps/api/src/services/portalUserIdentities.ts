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
 * facts), `findPortalUserIdByIdentity` (any provider; W7) and its Entra
 * wrapper `findPortalUserIdByEntraIdentity` (the add-in exchange's lookup) and
 * `listIdentityProvidersByUser` (the portal-user list). Nothing reads
 * `portal_users.entra_*` for a decision any more. Writers still dual-write those
 * columns (plan D4 writer fence) so a rolling-deploy release-A instance, which
 * still reads them, finds every account. The deploy migration
 * (2027-01-22-232800-portal-access-policies-requests.sql §4) re-ran the
 * backfill; the daily job (jobs/portalIdentityReconcile.ts) REPORTS drift and
 * never repairs it (plan D10). Release C drops the columns.
 *
 * W8 (#11385, plan D1/D3): an identity can be DISABLED (blockers), never
 * deleted, so its `(issuer, subject)` stays reserved. The readers return its
 * `disabled_at`; `portalUserHasUsableIdentitySql` is the "has a working
 * credential" twin of the any-row fact; `lockIdentityForAccount` re-reads one
 * identity under the account lock (lock order: account, then identity).
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import {
  portalUserIdentities,
  portalUsers,
  type PortalIdentityBlocker,
  type PortalIdentityDisabledReason,
  type PortalIdentityProvider,
} from '../db/schema/portal';
import { PORTAL_GOOGLE_ISSUER } from './portalOidc/validators';

/** `db` or a transaction handle (same shape as `ContactExecutor`, services/contacts/compat.ts). */
export type IdentityExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The Entra v2.0 issuer for a tenant — the `iss` an Entra v2 ID token carries. */
export function entraIssuer(tid: string): string {
  return `https://login.microsoftonline.com/${tid}/v2.0`;
}

/** The `iss` of a Google ID token; the issuer stored for a Google request and identity. */
export { PORTAL_GOOGLE_ISSUER };

/**
 * The key of one external identity, per provider (W7 plan D5). Entra: the
 * tenant and object id from a verified ID token; Google: the `sub` claim,
 * compared and stored case-sensitively and never normalized (D1).
 */
export type PortalIdentityKey =
  | { provider: 'entra'; tid: string; oid: string }
  | { provider: 'google'; sub: string };

/** The `(issuer, subject)` an identity row stores for a key (`portal_user_identities_issuer_subject_uq`). */
export function identityIssuerSubject(key: PortalIdentityKey): { issuer: string; subject: string } {
  return key.provider === 'entra'
    ? { issuer: entraIssuer(key.tid), subject: key.oid }
    : { issuer: PORTAL_GOOGLE_ISSUER, subject: key.sub };
}

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
 * W8 (#11385, plan D3): `EXISTS` an ENABLED identity (`disabled_at IS NULL`)
 * for the OUTER `portal_users` row — "the account can sign in through a
 * directory". Distinct from {@link portalUserHasIdentitySql} on purpose:
 *  - the ANY fact means "identity-managed / the (issuer, subject) is
 *    reserved": invites and bulk invite never target such an account, disabled
 *    identity or not;
 *  - this USABLE fact means "has a working credential": the account rule,
 *    `msp_reactivate`, the `sso_only` stranded list and the hash clear.
 * Every call site of either is classified in
 * `__tests__/portalIdentityFacts.contract.test.ts`. Same #9692 spelling rules
 * as {@link portalUserHasIdentitySql}. A fresh object per call.
 */
export function portalUserHasUsableIdentitySql(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from "portal_user_identities" "pui_usable" where "pui_usable"."portal_user_id" = "portal_users"."id" and "pui_usable"."disabled_at" is null)`;
}

/**
 * The owner of an identity found by its key (W8 D3): the account and org, plus
 * the identity's own id and `disabled_at`. A disabled identity is still FOUND
 * (its `(issuer, subject)` stays reserved, D1); a sign-in reader refuses it.
 */
export interface PortalIdentityOwner {
  portalUserId: string;
  orgId: string;
  identityId: string;
  disabledAt: Date | null;
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
 * The account an identity belongs to, or null, matched on the full key:
 * provider, issuer and subject (the subject exactly, case-sensitive). Its
 * `orgId` is the account's org too (composite same-org FK), so a caller can
 * compare it with the org the sign-in resolved to before touching the account
 * (spec §6 inv. 4). Each provider's lookup ignores the other's identities.
 * Runs in the caller's DB context: under RLS it only sees identities the
 * context may read.
 */
export async function findPortalUserIdByIdentity(
  exec: IdentityExecutor,
  key: PortalIdentityKey,
): Promise<PortalIdentityOwner | null> {
  const { issuer, subject } = identityIssuerSubject(key);
  const [row] = await exec
    .select({
      portalUserId: portalUserIdentities.portalUserId,
      orgId: portalUserIdentities.orgId,
      identityId: portalUserIdentities.id,
      disabledAt: portalUserIdentities.disabledAt,
    })
    .from(portalUserIdentities)
    .where(and(
      eq(portalUserIdentities.provider, key.provider),
      eq(portalUserIdentities.issuer, issuer),
      eq(portalUserIdentities.subject, subject),
    ))
    .limit(1);
  return row ?? null;
}

/** {@link findPortalUserIdByIdentity} for an Entra key (the add-in exchange and W4 sign-in). */
export async function findPortalUserIdByEntraIdentity(
  exec: IdentityExecutor,
  input: { tid: string; oid: string },
): Promise<PortalIdentityOwner | null> {
  return findPortalUserIdByIdentity(exec, { provider: 'entra', tid: input.tid, oid: input.oid });
}

/** One identity row as {@link lockIdentityForAccount} reads it. */
export interface LockedPortalIdentity {
  id: string;
  orgId: string;
  portalUserId: string;
  provider: PortalIdentityProvider;
  entraTenantId: string | null;
  disabledAt: Date | null;
  disabledReason: PortalIdentityDisabledReason | null;
  disabledBlockers: PortalIdentityBlocker[];
  directoryChain: string | null;
  directoryRearmSince: Date | null;
  /** The last run that evaluated this identity (D8d: an action's evidence is still the latest). */
  directoryLastRunId: string | null;
}

/**
 * W8 (plan D3): one identity row, locked `FOR UPDATE` on the caller's
 * transaction, or null. LOCK ORDER: the caller must ALREADY hold its account
 * row (`portal_users … FOR UPDATE` / `FOR SHARE`) — account, then identity,
 * everywhere a decision depends on both (sign-in, the add-in exchange, link,
 * invite consume, disablePortalIdentity, Restore). A separate statement after
 * the account lock, so under READ COMMITTED it sees every disable that
 * committed while the account lock waited.
 */
export async function lockIdentityForAccount(
  exec: IdentityExecutor,
  identityId: string,
): Promise<LockedPortalIdentity | null> {
  const [row] = await exec
    .select({
      id: portalUserIdentities.id,
      orgId: portalUserIdentities.orgId,
      portalUserId: portalUserIdentities.portalUserId,
      provider: portalUserIdentities.provider,
      entraTenantId: portalUserIdentities.entraTenantId,
      disabledAt: portalUserIdentities.disabledAt,
      disabledReason: portalUserIdentities.disabledReason,
      disabledBlockers: portalUserIdentities.disabledBlockers,
      directoryChain: portalUserIdentities.directoryChain,
      directoryRearmSince: portalUserIdentities.directoryRearmSince,
      directoryLastRunId: portalUserIdentities.directoryLastRunId,
    })
    .from(portalUserIdentities)
    .where(eq(portalUserIdentities.id, identityId))
    .for('update')
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

export type EnsureIdentityOutcome = 'inserted' | 'present' | 'conflict' | 'disabled';

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
 *     so on that path `conflict` only means the identity moved mid-exchange;
 *   - `disabled` — W8 (plan D3): this user's identity row is disabled. Nothing
 *     is written (not even `last_used_at`); the caller refuses the sign-in.
 *     The exchange calls this while it holds the account row (its
 *     `last_login_at` update), so no disable can commit between this read and
 *     the guarded touch below (disablers lock the account first).
 */
export async function ensureEntraIdentity(
  exec: IdentityExecutor,
  input: { orgId: string; portalUserId: string; tid: string; oid: string; usedAt: Date },
): Promise<EnsureIdentityOutcome> {
  const issuer = entraIssuer(input.tid);
  const owned = and(
    eq(portalUserIdentities.issuer, issuer),
    eq(portalUserIdentities.subject, input.oid),
    eq(portalUserIdentities.portalUserId, input.portalUserId),
  );
  const [disabled] = await exec
    .select({ id: portalUserIdentities.id })
    .from(portalUserIdentities)
    .where(and(owned, isNotNull(portalUserIdentities.disabledAt)))
    .limit(1);
  if (disabled) return 'disabled';

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
    .where(and(owned, isNull(portalUserIdentities.disabledAt)))
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
 * Google (W7 plan D5) runs step 2 only, then step 3 without the fence: Google
 * has no `portal_users` legacy columns, so there is no legacy pre-check and no
 * `entra_*` write, and an existing Entra identity on the account is left as it
 * is (one identity per provider per account, `(portal_user_id, provider)`).
 * The login update still clears `password_hash` when asked and still proves
 * the login is in `orgId`.
 *
 * Throws when the login is not in `orgId` after the identity was written; the
 * caller's transaction must roll back.
 */
export async function linkPortalUserIdentity(
  tx: IdentityExecutor,
  input: PortalIdentityKey & {
    orgId: string;
    portalUserId: string;
    linkedVia: 'invite' | 'self_link' | 'jit';
    clearPasswordHash: boolean;
    now: Date;
  },
): Promise<LinkIdentityResult> {
  if (input.provider === 'google') return linkGoogleIdentity(tx, input);

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

/** The Google branch of {@link linkPortalUserIdentity}. */
async function linkGoogleIdentity(
  tx: IdentityExecutor,
  input: Extract<PortalIdentityKey, { provider: 'google' }> & {
    orgId: string;
    portalUserId: string;
    linkedVia: 'invite' | 'self_link' | 'jit';
    clearPasswordHash: boolean;
    now: Date;
  },
): Promise<LinkIdentityResult> {
  const { issuer, subject } = identityIssuerSubject(input);
  const inserted = await tx
    .insert(portalUserIdentities)
    .values({
      orgId: input.orgId,
      portalUserId: input.portalUserId,
      provider: 'google',
      issuer,
      subject,
      entraTenantId: null,
      linkedVia: input.linkedVia,
      lastUsedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: portalUserIdentities.id });
  if (inserted.length === 0) return { kind: 'conflict' };

  const updated = await tx
    .update(portalUsers)
    .set({
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
