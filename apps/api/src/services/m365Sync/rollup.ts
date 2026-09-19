import { eq } from 'drizzle-orm';
import { M365_SYNC_DOMAINS, type M365SyncDomain } from '@breeze/shared/m365';
import { db } from '../../db';
import { m365PostureRollups, m365SyncState } from '../../db/schema';

type RollupColumn = Exclude<
  keyof typeof m365PostureRollups.$inferInsert,
  'id' | 'orgId' | 'tenantId' | 'rollupDate' | 'domainsFresh' | 'computedAt'
>;

/**
 * Which domain's `last_counts` key feeds which rollup column. Exported so the
 * end-to-end suite can assert it covers the table and claims no column twice —
 * a silently unmapped column would report NULL forever.
 */
export const ROLLUP_COUNTER_SOURCES: Record<M365SyncDomain, Record<string, RollupColumn>> = {
  users: {
    users_total: 'usersTotal',
    users_enabled: 'usersEnabled',
    users_mfa_registered: 'usersMfaRegistered',
    users_mfa_unknown: 'usersMfaUnknown',
    users_admin: 'usersAdmin',
    admins_without_mfa: 'adminsWithoutMfa',
    admins_mfa_unknown: 'adminsMfaUnknown',
  },
  intune_devices: {
    devices_total: 'devicesTotal',
    devices_compliant: 'devicesCompliant',
    devices_noncompliant: 'devicesNoncompliant',
    devices_in_grace: 'devicesInGrace',
    devices_unknown: 'devicesUnknown',
  },
  ca_policies: {
    ca_policies_enabled: 'caPoliciesEnabled',
    ca_policies_report_only: 'caPoliciesReportOnly',
    ca_policies_disabled: 'caPoliciesDisabled',
  },
  skus: {
    seats_purchased: 'seatsPurchased',
    seats_consumed: 'seatsConsumed',
  },
  secure_score: {
    secure_score: 'secureScore',
    secure_score_max: 'secureScoreMax',
  },
  signin_activity: {},
  // #5784 W05. The daily posture rollup has no sign-in-event column, and adding
  // one would be a schema change this wave deliberately does not make: the
  // events are raw evidence for W06's period report, not a posture counter.
  signin_events: {},
};

/** numeric(8,2) columns: drizzle binds them as strings. */
const NUMERIC_COLUMNS = new Set<RollupColumn>(['secureScore', 'secureScoreMax']);

function counterOf(counts: unknown, key: string): number | null {
  if (counts === null || typeof counts !== 'object') return null;
  const value = (counts as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Assembles one day's posture row from the org's sync-state rows: one indexed
 * read and one upsert, no COUNT queries (spec §5.9). Counters no domain has
 * reported stay NULL rather than 0 — "we do not know" and "there are none" are
 * different facts, and reporting the second when the first is true is exactly
 * the false negative the spec's `*_unknown` columns exist to prevent.
 *
 * MUST run inside a system DB context (the post-commit hook opens one); every
 * statement is keyed on the org explicitly. Called AFTER the completion
 * transaction committed, so the domain that just ran contributes its fresh,
 * durable `last_counts`.
 */
export async function upsertPostureRollup(orgId: string, tenantId: string, date: string): Promise<void> {
  const rows = await db
    .select({
      domain: m365SyncState.domain,
      lastCounts: m365SyncState.lastCounts,
      lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
    })
    .from(m365SyncState)
    .where(eq(m365SyncState.orgId, orgId));

  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));

  const counters: Partial<Record<RollupColumn, number | string | null>> = {};
  for (const [domain, keyMap] of Object.entries(ROLLUP_COUNTER_SOURCES) as Array<[M365SyncDomain, Record<string, RollupColumn>]>) {
    const counts = byDomain.get(domain)?.lastCounts ?? null;
    for (const [countsKey, column] of Object.entries(keyMap)) {
      const value = counterOf(counts, countsKey);
      counters[column] = value === null ? null : NUMERIC_COLUMNS.has(column) ? String(value) : Math.trunc(value);
    }
  }

  const domainsFresh: Record<string, { asOf: string | null; complete: boolean }> = {};
  for (const domain of M365_SYNC_DOMAINS) {
    const at = byDomain.get(domain)?.lastCompleteSnapshotAt ?? null;
    domainsFresh[domain] = { asOf: at ? new Date(at).toISOString() : null, complete: at !== null };
  }

  const computedAt = new Date();
  const payload = {
    tenantId,
    // Built per column above: integers for the integer columns, strings for
    // the two numeric(8,2) ones — a mixed record TS cannot correlate itself.
    ...(counters as Partial<Pick<typeof m365PostureRollups.$inferInsert, RollupColumn>>),
    domainsFresh: domainsFresh as Record<string, { asOf: string; complete: boolean }>,
    computedAt,
  };
  await db.insert(m365PostureRollups)
    .values({ orgId, rollupDate: date, ...payload })
    .onConflictDoUpdate({
      target: [m365PostureRollups.orgId, m365PostureRollups.rollupDate],
      set: payload,
    });
}
