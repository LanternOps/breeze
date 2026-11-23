import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { unifiIntegrationKeys as k, unifiIntegrations as t } from '../../../db/schema';
import { staleAfterMinutes, unifiHealth, unifiKeyHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';
import { observeRows, staleArm, toHealthObservation, validUuids } from './observeRows';

// UniFi syncs every 30 minutes (jobs/unifiWorker.ts). `status` carries
// reauth/error, last_sync_status 'failed'. Disconnect deletes the row.
// Partner axis: not index-backed (spec §1.3).
// W4 staleness: markSynced stamps last_sync_at on every completed attempt and
// a completed failure is already `sync_failed`, so the stale arm reads "no
// attempt finished in 90 minutes" (a dead scheduler or a hung run).
//
// #11808 W3: one observation per connection (unchanged: same sourceId, so open
// incidents survive) PLUS one per enabled Site Manager API key (sourceId = the
// key id, "UniFi: <label>"). A failing key of several leaves the connection's
// run `partial`, which the connection observation counts as healthy; the key
// observation is what names the broken key. A disabled key retires; a deleted
// key's row is absent, so the reconciler retires its tracked incident.
// unifi_integration_keys is partner-axis too (at most 25 rows per connection).

const FIX_HREF = '/integrations#unifi';

export type UnifiRow = {
  id: string;
  partnerId: string;
  isActive: boolean;
  status: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  /** Computed in SQL by staleArm (W4). */
  stale: boolean;
};

export type UnifiKeyRow = {
  id: string;
  partnerId: string;
  label: string;
  integrationActive: boolean;
  isEnabled: boolean;
  status: string;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
};

type Row = ({ kind: 'integration' } & UnifiRow) | ({ kind: 'key' } & UnifiKeyRow);

const SYNC_INTERVAL_MINUTES = 30;
const stale = (now: Date) => staleArm({
  lastOk: t.lastSyncAt,
  createdAt: t.createdAt,
  now,
  minutes: staleAfterMinutes(SYNC_INTERVAL_MINUTES),
  withTimezone: false,
});

function observation(input: {
  verdict: ReturnType<typeof unifiHealth>;
  now: Date;
  createdAt: Date;
  sourceId: string;
  partnerId: string;
  displayName: string;
  rawDetail: string | null;
}): HealthObservation {
  return toHealthObservation({
    kind: 'unifi',
    verdict: input.verdict,
    now: input.now,
    createdAt: input.createdAt,
    sourceId: input.sourceId,
    partnerId: input.partnerId,
    orgId: null,
    displayName: input.displayName,
    rawDetail: input.rawDetail,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export function unifiObservation(row: UnifiRow, now: Date): HealthObservation {
  const verdict = unifiHealth(row);
  return observation({
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    displayName: 'UniFi',
    // A stale sync has no current error; the last one may be old.
    rawDetail: verdict.state === 'broken' && verdict.condition === 'sync_stale' ? null : row.lastSyncError,
  });
}

export function unifiKeyObservation(row: UnifiKeyRow, now: Date): HealthObservation {
  return observation({
    verdict: unifiKeyHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    displayName: `UniFi: ${row.label}`,
    rawDetail: row.lastSyncError,
  });
}

const integrationBroken = (now: Date) =>
  sql`${t.isActive} AND (${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${t.lastSyncStatus} = ${sql.raw(`'failed'`)} OR (${t.status} = ${sql.raw(`'connected'`)} AND ${stale(now)}))`;

const keyBroken = () =>
  sql`${t.isActive} AND ${k.isEnabled} AND (${k.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR ${k.lastSyncStatus} = ${sql.raw(`'failed'`)})`;

// The key joins its own connection (same id AND partner, as the composite FK pins).
const keyJoin = () => and(eq(t.id, k.integrationId), eq(t.partnerId, k.partnerId));

/** The ids of every broken connection and every broken enabled key: the query the index contract EXPLAINs. */
function brokenUnifiIdsQuery(now: Date) {
  return sql`(SELECT ${t.id} AS id FROM ${t} WHERE ${integrationBroken(now)})
    union all
    (SELECT ${k.id} AS id FROM ${k} INNER JOIN ${t} ON ${keyJoin()} WHERE ${keyBroken()})`;
}

async function loadIntegrations(ids: string[], now: Date): Promise<Row[]> {
  const rows = await db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      isActive: t.isActive,
      status: t.status,
      lastSyncStatus: t.lastSyncStatus,
      lastSyncError: t.lastSyncError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(inArray(t.id, ids));
  return rows.map((r) => ({ kind: 'integration' as const, ...r }));
}

async function loadKeys(ids: string[]): Promise<Row[]> {
  // Never select the key's ciphertext here.
  const rows = await db
    .select({
      id: k.id,
      partnerId: k.partnerId,
      label: k.label,
      integrationActive: t.isActive,
      isEnabled: k.isEnabled,
      status: k.status,
      lastSyncStatus: k.lastSyncStatus,
      lastSyncError: k.lastSyncError,
      createdAt: k.createdAt,
    })
    .from(k)
    .innerJoin(t, keyJoin())
    .where(inArray(k.id, ids));
  return rows.map((r) => ({ kind: 'key' as const, ...r }));
}

/** Connection and key ids are both uuids from one generator, so one id list serves both lookups. In sequence: one pooled connection. */
async function loadRows(ids: string[], now: Date): Promise<Row[]> {
  const valid = validUuids(ids);
  if (valid.length === 0) return [];
  const integrations = await loadIntegrations(valid, now);
  const keys = await loadKeys(valid);
  return [...integrations, ...keys];
}

export const unifiSource: HealthSource = {
  kind: 'unifi',
  intervalMinutes: 30,
  tables: ['unifi_integrations', 'unifi_integration_keys'],
  fixHrefs: [FIX_HREF],
  brokenQuery: brokenUnifiIdsQuery,
  observe: (now, trackedSourceIds) => observeRows<Row>({
    now,
    trackedSourceIds,
    loadBroken: async () => {
      const found = (await db.execute(brokenUnifiIdsQuery(now))) as unknown as Array<{ id: string }>;
      return loadRows(found.map((r) => r.id), now);
    },
    loadTracked: (ids) => loadRows(ids, now),
    sourceIdOf: (r) => r.id,
    toObservation: (r, at) => (r.kind === 'key' ? unifiKeyObservation(r, at) : unifiObservation(r, at)),
  }),
};
