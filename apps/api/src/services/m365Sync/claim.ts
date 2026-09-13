import { sql, type SQL } from 'drizzle-orm';
import { M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS } from '@breeze/shared/m365';
import { db, withSystemDbAccessContext } from '../../db';
import { M365_SYNC_IMPLEMENTED_DOMAINS, type M365SyncJobData } from './types';

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
