import { sql, type SQL } from 'drizzle-orm';
import { M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS, type M365SyncDomain } from '@breeze/shared/m365';
import { db, withSystemDbAccessContext } from '../../db';
import { enqueueSyncDomain } from '../../jobs/m365SyncQueue';
import { M365_SYNC_IMPLEMENTED_DOMAINS, M365_SYNC_LEASE_MINUTES, type M365SyncJobData } from './types';

const READ_PROFILE = 'customer-graph-read';
const EXECUTABLE_STATUSES = ['active', 'degraded'] as const;

/**
 * BullMQ custom job ids MUST NOT contain `:` — it is the internal key
 * separator, and a colon silently corrupts the key space. The GENERATION is in
 * the id on purpose (spec §5.2 "Priority lanes"): a retained failed job under a
 * stale generation can never block the priority-1 job a re-claim just created,
 * because they are different ids.
 */
export function syncJobId(d: Pick<M365SyncJobData, 'orgId' | 'domain' | 'generation'>): string {
  return `m365-sync-${d.orgId}-${d.domain}-${d.generation}`;
}

function rowsToExtract<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Spec §10 step 2. INSERT … SELECT over every executable customer-graph-read
 * connection crossed with the domains this wave can persist, ON CONFLICT DO
 * NOTHING on the `(org_id, domain)` unique key.
 *
 * `next_sync_at` is staggered uniformly over the first hour: without it, turning
 * the flag on would make every seeded org due in the same second and the first
 * tick would hit backpressure instead of draining.
 *
 * `now` is bound as an ISO STRING and cast, never as a Date — postgres.js
 * throws `Buffer.byteLength` at bind time on a Date inside a raw fragment, and
 * a compiled-SQL test cannot see it.
 */
export function buildReconcileEligibleSql(now: Date): SQL {
  const nowIso = now.toISOString();
  const domainRows = M365_SYNC_IMPLEMENTED_DOMAINS.map((domain) => sql`(
    ${domain}::m365_sync_domain,
    ${M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain]}::int
  )`);

  return sql`
    insert into "m365_sync_state" ("org_id", "connection_id", "domain", "next_sync_at", "interval_seconds")
    select
      c."org_id",
      c."id",
      d.domain,
      ${nowIso}::timestamptz + (floor(random() * 3600))::int * interval '1 second',
      d.interval_seconds
    from "m365_connections" c
    cross join (values ${sql.join(domainRows, sql`, `)}) as d(domain, interval_seconds)
    where c."profile" = ${READ_PROFILE}
      and c."status" in (${sql.join(EXECUTABLE_STATUSES.map((s) => sql`${s}`), sql`, `)})
      and c."org_id" is not null
      and c."tenant_id" is not null
    on conflict ("org_id", "domain") do nothing
    returning 1
  `;
}

/**
 * Runs the reconcile in its own short SYSTEM transaction. This is a cross-org
 * scheduler read (spec §8) — under a tenant context it would see nothing, and
 * contextless it would be denied outright rather than bypassing RLS.
 * Returns the number of state rows actually created.
 */
export async function reconcileEligibleConnections(now: Date = new Date()): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute(buildReconcileEligibleSql(now));
    return rowsToExtract<unknown>(result).length;
  }, 'm365SyncReconcileEligible');
}

interface ClaimedRow {
  org_id: string;
  domain: M365SyncDomain;
  run_generation: number;
  connection_id: string;
  tenant_id: string;
  consent_generation: number;
}

/**
 * Spec §5.2 step 3, as ONE statement so the select-lock and the lease/generation
 * write cannot be torn apart by a crash between them.
 *
 * Three properties this SQL is load-bearing for, each with its own compiled-SQL
 * assertion in claim.sql.test.ts:
 *
 *  - `FOR UPDATE OF s SKIP LOCKED` locks only the state row. Locking the
 *    connection too would serialise every domain of one org behind one row.
 *  - `next_sync_at` is NOT touched. Cadence advances only when a run COMPLETES,
 *    so a failed handoff or a dead worker leaves the row due and the lease
 *    expires into a fresh claim with a new generation (spec §5.2 "Recovery").
 *    Advancing it here is exactly the bug the advisor quorum found in draft v1.
 *  - The UPDATE is keyed on the unique `(org_id, domain)`, not a surrogate id,
 *    so it does not depend on a column the spec never pins.
 */
export function buildClaimDueDomainsSql(opts: {
  limit: number; now: Date; orgId?: string; domains?: M365SyncDomain[];
}): SQL {
  const nowIso = opts.now.toISOString();
  const orgFilter = opts.orgId ? sql` and s."org_id" = ${opts.orgId}` : sql``;
  const domainFilter = opts.domains?.length
    ? sql` and s."domain" in (${sql.join(opts.domains.map((d) => sql`${d}::m365_sync_domain`), sql`, `)})`
    : sql``;

  return sql`
    with due as (
      select s."org_id", s."domain", c."id" as connection_id, c."tenant_id", c."consent_generation"
      from "m365_sync_state" s
      join "m365_connections" c
        on c."id" = s."connection_id" and c."org_id" = s."org_id"
      where s."next_sync_at" is not null
        and s."next_sync_at" <= ${nowIso}::timestamptz
        and (s."lease_until" is null or s."lease_until" < ${nowIso}::timestamptz)
        and c."status" in (${sql.join(EXECUTABLE_STATUSES.map((s2) => sql`${s2}`), sql`, `)})
        and c."tenant_id" is not null${orgFilter}${domainFilter}
      order by s."next_sync_at" asc
      limit ${opts.limit}
      for update of s skip locked
    )
    update "m365_sync_state" as t
    set "lease_until" = ${nowIso}::timestamptz + interval '${sql.raw(String(M365_SYNC_LEASE_MINUTES))} minutes',
        "run_generation" = t."run_generation" + 1,
        "updated_at" = ${nowIso}::timestamptz
    from due
    where t."org_id" = due."org_id" and t."domain" = due."domain"
    returning t."org_id", t."domain", t."run_generation",
              due."connection_id", due."tenant_id", due."consent_generation"
  `;
}

export async function claimDueDomains(opts: {
  limit: number; now?: Date; orgId?: string; domains?: M365SyncDomain[]; priority?: 1 | 10;
}): Promise<M365SyncJobData[]> {
  const now = opts.now ?? new Date();
  const priority = opts.priority ?? 10;
  const rows = await withSystemDbAccessContext(async () => {
    const result = await db.execute(buildClaimDueDomainsSql({
      limit: opts.limit, now, orgId: opts.orgId, domains: opts.domains,
    }));
    return rowsToExtract<ClaimedRow>(result);
  }, 'm365SyncClaimDue');

  return rows.map((row) => ({
    orgId: row.org_id,
    domain: row.domain,
    generation: Number(row.run_generation),
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    consentGeneration: Number(row.consent_generation),
    priority,
  }));
}

/** Gauge feed for `m365_sync_due_backlog` (spec §5.9). Uses the partial index on next_sync_at. */
export async function countDueDomains(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  return withSystemDbAccessContext(async () => {
    const result = await db.execute(sql`
      select count(*)::int as due
      from "m365_sync_state"
      where "next_sync_at" is not null and "next_sync_at" <= ${nowIso}::timestamptz
    `);
    return Number(rowsToExtract<{ due: number }>(result)[0]?.due ?? 0);
  }, 'm365SyncCountDue');
}

/**
 * The priority lane (spec §5.2): make the named domains due NOW, then run the
 * SAME claim so they get a generation and a lease like any other run — an
 * on-demand run that skipped the claim would have no fence at Phase C.
 *
 * The enqueue happens AFTER the claim's transaction has committed. Issuing
 * Redis commands with a pooled connection held open is the #1105 anti-pattern,
 * and a job that started before its own claim committed could read a stale
 * generation and fence itself.
 */
export async function claimAndEnqueue(
  orgId: string,
  domains: M365SyncDomain[],
  priority: 1 | 10,
): Promise<void> {
  if (domains.length === 0) return;
  const now = new Date();
  const nowIso = now.toISOString();

  await withSystemDbAccessContext(async () => {
    await db.execute(sql`
      update "m365_sync_state"
      set "next_sync_at" = ${nowIso}::timestamptz, "updated_at" = ${nowIso}::timestamptz
      where "org_id" = ${orgId}
        and "domain" in (${sql.join(domains.map((d) => sql`${d}::m365_sync_domain`), sql`, `)})
    `);
  }, 'm365SyncMakeDue');

  const claimed = await claimDueDomains({ limit: domains.length, now, orgId, domains, priority });

  // Every row in `claimed` already holds a lease from the claim above, so one
  // failing enqueue must not abandon the rest of the batch (they would
  // otherwise sit unscheduled until the 20-minute lease expires). Unlike the
  // ticker's equivalent loop (jobs/m365SyncWorker.ts runM365SyncTick, which
  // only logs and lets the next tick reclaim), this is an ON-DEMAND caller —
  // it needs to see that something failed, so the FIRST error is re-thrown
  // after every job has been attempted.
  let firstError: unknown;
  for (const job of claimed) {
    try {
      await enqueueSyncDomain(job);
    } catch (error) {
      firstError ??= error;
      console.log('[M365Sync] enqueue-failed', JSON.stringify({
        orgId: job.orgId, domain: job.domain, generation: job.generation,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (firstError !== undefined) throw firstError;
}
