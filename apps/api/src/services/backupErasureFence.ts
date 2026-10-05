/**
 * Backup storage fences for org erasure.
 *
 * Org erasure deletes the org's backup rows (snapshots, retirements, id
 * reservations, recovery-media artifacts) but never the storage objects those
 * rows describe: deleting backup data must be an explicit, separate decision.
 * Storage GC (jobs/backupRetention.ts), however, decides what it may reclaim
 * from exactly those rows, per storage identity — and several orgs of one MSP
 * routinely share one bucket. Without a record, the erased org's prefixes
 * would look like unowned orphans to a sibling org's sweep.
 *
 * This module writes that record (`backup_erasure_manifests` /
 * `backup_erasure_targets`, platform tables with no tenant axis that survive
 * the cascade) and gives GC the readers it needs to honour it. A fenced
 * target is never reclaimed by GC. Nothing here deletes an object.
 *
 * Two mechanisms, both idempotent:
 *   1. `captureBackupErasureFence` — before the cascade's FIRST destructive
 *      step, in one committed transaction, from every source table at once,
 *      resolving each destination through backup_configs while they still
 *      exist. The cascade deletes children first, so recovery-media rows are
 *      gone before backup_snapshots; capturing up front is the only point where
 *      every source row and every destination still exists.
 *   2. The `breeze_backup_erasure_fence_on_delete` BEFORE DELETE trigger on the
 *      five source tables (migration 2026-12-11-100000). Every cascade
 *      transaction sets `breeze.backup_erasure_org` LOCAL
 *      (`setBackupErasureContext`); while it names the row's org, ANY delete of
 *      a source row — its own table's step, or an ON DELETE CASCADE from
 *      backup_jobs / devices / backup_configs / recovery_tokens /
 *      backup_snapshots — records the fence in the deleting transaction. This
 *      is what covers a row created after step 1 (a backup finishing, an id
 *      reserved mid-erasure). One trigger rather than per-step
 *      DELETE … RETURNING, because RETURNING sees only the step's own table and
 *      misses every FK-cascaded delete.
 * Together: every source row the cascade deletes was fenced no later than the
 * transaction that deleted it, and normally long before. GC's ordering rule
 * (see jobs/backupRetention.ts, "erasure fences") relies on exactly this.
 *
 * Fences carry their subject org. GC treats a fenced id as foreign for every
 * org EXCEPT the subject org's own sweep while it still holds a live row for
 * that id — so an erasure that aborts after step 1 leaves the still-existing
 * org's own retention and GC working normally.
 */
import { inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { backupErasureFenceRefs, backupErasureTargets, type BackupErasureTargetSource } from '../db/schema/backupErasureFences';
import { asRecord, getStringValue, normalizeStorageIdentity } from './backupStorageIdentity';

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Marks the CURRENT transaction as part of `orgId`'s erasure, so the on-delete
 * fence trigger records every backup source row of that org deleted in it
 * (directly or through an FK cascade). Transaction-local (set_config … true);
 * must run inside a DB context.
 */
export async function setBackupErasureContext(orgId: string): Promise<void> {
  await dbModule.db.execute(sql`SELECT set_config('breeze.backup_erasure_org', ${orgId}, true)`);
}

export interface BackupErasureFenceCounts {
  snapshotPrefixes: number;
  recoveryMediaKeys: number;
  /** Targets recorded without a resolvable storage identity (still fenced: GC matches by id/key). */
  unresolvedIdentity: number;
}

type TargetInsert = typeof backupErasureTargets.$inferInsert;

// ── Destination resolution ──────────────────────────────────────────────────

type ConfigRow = { id: string; provider: string; provider_config: unknown };

interface Destination {
  storageIdentity: string | null;
  provider: string | null;
}

/**
 * Same precedence as recoveryBootstrap.resolveSnapshotProviderConfig, ending
 * in the identity string GC uses: the row's own denormalised
 * storage_identity first (it is what GC matches), then its configuration
 * (row config_id → metadata.configId → the owning job's config_id), then a
 * destination embedded in the snapshot metadata. Only the normalised
 * provider::endpoint::bucket string is kept — never credentials.
 */
function resolveDestination(
  input: { storageIdentity: string | null; configId: string | null; metadata?: unknown; jobConfigId?: string | null },
  configs: ReadonlyMap<string, ConfigRow>,
): Destination {
  const metadata = asRecord(input.metadata);
  const configId = input.configId ?? getStringValue(metadata, 'configId') ?? input.jobConfigId ?? null;
  const config = configId ? configs.get(configId) : undefined;
  const providerFromIdentity = input.storageIdentity ? input.storageIdentity.split('::')[0] || null : null;

  if (input.storageIdentity) {
    return { storageIdentity: input.storageIdentity, provider: config?.provider ?? providerFromIdentity };
  }
  if (config) {
    return {
      storageIdentity: normalizeStorageIdentity(config.provider, asRecord(config.provider_config)),
      provider: config.provider,
    };
  }
  const metaProvider = getStringValue(metadata, 'provider')
    || getStringValue(metadata, 'providerType')
    || getStringValue(metadata, 'storageProvider');
  const metaConfigRaw = metadata.providerConfig ?? metadata.providerDetails ?? metadata.storageConfig;
  if (metaProvider && metaConfigRaw && typeof metaConfigRaw === 'object' && !Array.isArray(metaConfigRaw)) {
    return { storageIdentity: normalizeStorageIdentity(metaProvider, asRecord(metaConfigRaw)), provider: metaProvider };
  }
  return { storageIdentity: null, provider: metaProvider ?? null };
}

async function loadConfigs(configIds: Iterable<string | null | undefined>): Promise<Map<string, ConfigRow>> {
  const ids = [...new Set([...configIds].filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const map = new Map<string, ConfigRow>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const rows = rowsOf<ConfigRow>(await dbModule.db.execute(sql`
      SELECT id, provider::text AS provider, provider_config FROM backup_configs
       WHERE id IN (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
    `));
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

async function loadJobConfigIds(jobIds: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set([...jobIds].filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const rows = rowsOf<{ id: string; config_id: string | null }>(await dbModule.db.execute(sql`
      SELECT id, config_id FROM backup_jobs WHERE id IN (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
    `));
    for (const row of rows) if (row.config_id) map.set(row.id, row.config_id);
  }
  return map;
}

// ── Row shapes read from each source table ──────────────────────────────────

type SnapshotRow = {
  id: string;
  snapshot_id: string;
  config_id: string | null;
  job_id: string | null;
  storage_identity: string | null;
  size: number | string | null;
  file_count: number | null;
  timestamp: Date | string | null;
  is_immutable: boolean | null;
  immutable_until: Date | string | null;
  immutability_enforcement: string | null;
  metadata: unknown;
};

type IdRow = { snapshot_id: string; storage_identity: string | null; config_id: string | null };

type ArtifactRow = {
  snapshot_db_id: string | null;
  storage_key: string | null;
  checksum_storage_key: string | null;
  signature_storage_key: string | null;
};

const SNAPSHOT_COLUMNS = sql.raw(
  'id, snapshot_id, config_id, job_id, storage_identity, size, file_count, "timestamp", '
  + 'is_immutable, immutable_until, immutability_enforcement::text AS immutability_enforcement, metadata',
);
const ID_COLUMNS = sql.raw('snapshot_id, storage_identity, config_id');
const ARTIFACT_COLUMNS = sql.raw('snapshot_id AS snapshot_db_id, storage_key, checksum_storage_key, signature_storage_key');

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Builds target rows from already-read source rows. Recovery-media artifacts
 * live in their snapshot's destination, so they resolve through the snapshot
 * (by its row id) — `snapshotsById` must cover every artifact's snapshot.
 */
async function buildTargets(input: {
  manifestId: string;
  orgId: string;
  snapshots: SnapshotRow[];
  retirements: IdRow[];
  reservations: IdRow[];
  media: ArtifactRow[];
  bootMedia: ArtifactRow[];
  snapshotsById: ReadonlyMap<string, SnapshotRow>;
}): Promise<TargetInsert[]> {
  const allSnapshots = [...input.snapshots, ...input.snapshotsById.values()];
  const jobConfigIds = await loadJobConfigIds(allSnapshots.filter((s) => !s.config_id).map((s) => s.job_id));
  const configs = await loadConfigs([
    ...allSnapshots.map((s) => s.config_id),
    ...allSnapshots.map((s) => getStringValue(asRecord(s.metadata), 'configId')),
    ...jobConfigIds.values(),
    ...input.retirements.map((r) => r.config_id),
    ...input.reservations.map((r) => r.config_id),
  ]);

  const snapshotDestination = (s: SnapshotRow): Destination => resolveDestination({
    storageIdentity: s.storage_identity,
    configId: s.config_id,
    metadata: s.metadata,
    jobConfigId: s.job_id ? jobConfigIds.get(s.job_id) ?? null : null,
  }, configs);

  const base = { manifestId: input.manifestId, subjectOrgId: input.orgId, state: 'fenced' as const };
  const targets: TargetInsert[] = [];

  // Snapshot rows first: when the same prefix also appears as a retirement or
  // reservation, ON CONFLICT DO NOTHING keeps the richer snapshot record.
  for (const s of input.snapshots) {
    const dest = snapshotDestination(s);
    targets.push({
      ...base,
      kind: 'snapshot_prefix',
      source: 'snapshot',
      storageIdentity: dest.storageIdentity,
      provider: dest.provider,
      snapshotId: s.snapshot_id,
      sizeBytes: toNumber(s.size),
      fileCount: s.file_count,
      snapshotAt: toDate(s.timestamp),
      isImmutable: s.is_immutable,
      immutableUntil: toDate(s.immutable_until),
      immutabilityEnforcement: s.immutability_enforcement,
    });
  }
  const idSources: Array<[IdRow[], BackupErasureTargetSource]> = [
    [input.retirements, 'retirement'],
    [input.reservations, 'reservation'],
  ];
  for (const [rows, source] of idSources) {
    for (const r of rows) {
      const dest = resolveDestination({ storageIdentity: r.storage_identity, configId: r.config_id }, configs);
      targets.push({
        ...base,
        kind: 'snapshot_prefix',
        source,
        storageIdentity: dest.storageIdentity,
        provider: dest.provider,
        snapshotId: r.snapshot_id,
      });
    }
  }
  const artifactSources: Array<[ArtifactRow[], BackupErasureTargetSource]> = [
    [input.media, 'recovery_media'],
    [input.bootMedia, 'recovery_boot_media'],
  ];
  for (const [rows, source] of artifactSources) {
    for (const a of rows) {
      const snapshot = a.snapshot_db_id ? input.snapshotsById.get(a.snapshot_db_id) : undefined;
      const dest = snapshot ? snapshotDestination(snapshot) : { storageIdentity: null, provider: null };
      for (const key of [a.storage_key, a.checksum_storage_key, a.signature_storage_key]) {
        if (!key) continue;
        targets.push({
          ...base,
          kind: 'recovery_media_key',
          source,
          storageIdentity: dest.storageIdentity,
          provider: dest.provider,
          snapshotId: snapshot?.snapshot_id ?? null,
          objectKey: key,
        });
      }
    }
  }
  return targets;
}

async function loadSnapshotsById(ids: Iterable<string | null | undefined>): Promise<Map<string, SnapshotRow>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const map = new Map<string, SnapshotRow>();
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    const rows = rowsOf<SnapshotRow>(await dbModule.db.execute(sql`
      SELECT ${SNAPSHOT_COLUMNS} FROM backup_snapshots
       WHERE id IN (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
    `));
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

async function insertTargets(targets: TargetInsert[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < targets.length; i += 500) {
    const rows = await dbModule.db
      .insert(backupErasureTargets)
      .values(targets.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ id: backupErasureTargets.id });
    inserted += rows.length;
  }
  return inserted;
}

/** Creates (or returns) the org's manifest. Must run inside a system DB context. */
async function ensureManifest(orgId: string, erasureJobId: string | null): Promise<string> {
  await dbModule.db.execute(sql`
    INSERT INTO backup_erasure_manifests (subject_org_id, subject_partner_id, erasure_job_id)
    VALUES (${orgId}::uuid, (SELECT partner_id FROM organizations WHERE id = ${orgId}::uuid), ${erasureJobId})
    ON CONFLICT (subject_org_id) DO NOTHING
  `);
  const [row] = rowsOf<{ id: string }>(await dbModule.db.execute(sql`
    SELECT id FROM backup_erasure_manifests WHERE subject_org_id = ${orgId}::uuid
  `));
  if (!row) throw new Error(`[backupErasureFence] manifest for org ${orgId} could not be created`);
  return row.id;
}

async function countTargets(orgId: string): Promise<BackupErasureFenceCounts> {
  const rows = rowsOf<{ kind: string; n: number | string; unresolved: number | string }>(await dbModule.db.execute(sql`
    SELECT kind, count(*) AS n, count(*) FILTER (WHERE storage_identity IS NULL) AS unresolved
      FROM backup_erasure_targets WHERE subject_org_id = ${orgId}::uuid
     GROUP BY kind
  `));
  const counts: BackupErasureFenceCounts = { snapshotPrefixes: 0, recoveryMediaKeys: 0, unresolvedIdentity: 0 };
  for (const row of rows) {
    if (row.kind === 'snapshot_prefix') counts.snapshotPrefixes = Number(row.n);
    if (row.kind === 'recovery_media_key') counts.recoveryMediaKeys = Number(row.n);
    counts.unresolvedIdentity += Number(row.unresolved);
  }
  return counts;
}

/**
 * Step 1: fence everything the org owns, before any of it is deleted. One
 * system transaction (committed when this returns). Idempotent — a re-run
 * after a partial cascade only adds targets for rows that still exist and
 * never loses or duplicates earlier ones.
 */
export async function captureBackupErasureFence(
  orgId: string,
  opts: { erasureJobId?: string | null } = {},
): Promise<BackupErasureFenceCounts> {
  return dbModule.withSystemDbAccessContext(async () => {
    const manifestId = await ensureManifest(orgId, opts.erasureJobId ?? null);
    const snapshots = rowsOf<SnapshotRow>(await dbModule.db.execute(sql`
      SELECT ${SNAPSHOT_COLUMNS} FROM backup_snapshots WHERE org_id = ${orgId}::uuid
    `));
    const retirements = rowsOf<IdRow>(await dbModule.db.execute(sql`
      SELECT ${ID_COLUMNS} FROM backup_snapshot_retirements WHERE org_id = ${orgId}::uuid
    `));
    const reservations = rowsOf<IdRow>(await dbModule.db.execute(sql`
      SELECT ${ID_COLUMNS} FROM backup_snapshot_id_reservations WHERE org_id = ${orgId}::uuid
    `));
    const media = rowsOf<ArtifactRow>(await dbModule.db.execute(sql`
      SELECT ${ARTIFACT_COLUMNS} FROM recovery_media_artifacts WHERE org_id = ${orgId}::uuid
    `));
    const bootMedia = rowsOf<ArtifactRow>(await dbModule.db.execute(sql`
      SELECT ${ARTIFACT_COLUMNS} FROM recovery_boot_media_artifacts WHERE org_id = ${orgId}::uuid
    `));
    const snapshotsById = new Map(snapshots.map((s) => [s.id, s]));
    const missing = [...media, ...bootMedia]
      .map((a) => a.snapshot_db_id)
      .filter((id): id is string => !!id && !snapshotsById.has(id));
    for (const [id, row] of await loadSnapshotsById(missing)) snapshotsById.set(id, row);

    const targets = await buildTargets({
      manifestId, orgId, snapshots, retirements, reservations, media, bootMedia, snapshotsById,
    });
    await insertTargets(targets);
    return countTargets(orgId);
  }, 'tenantErasure.backupFenceCapture');
}

// ── Readers for storage GC ──────────────────────────────────────────────────

export interface BackupErasureFenceSet {
  /** Fenced snapshot ids among those asked about (prefix snapshots/<id>/) → the org(s) whose erasure fenced them. */
  snapshotSubjects: Map<string, Set<string>>;
  /** Fenced recovery-media object keys among those asked about (or all, when none were passed). */
  objectKeys: Set<string>;
}

/**
 * Which of `snapshotIds` / `objectKeys` are fenced. Matched by snapshot id
 * and object key ONLY, deliberately not by storage identity: an identity
 * string can change under a config edit while the bucket stays the same, and
 * a NULL identity must still fence. A legacy snapshot id reused on another
 * identity is therefore over-protected — never under-protected. With
 * `objectKeys` omitted, every fenced recovery-media key is returned (there
 * are few). Must run inside a system DB context.
 */
export async function loadBackupErasureFences(
  snapshotIds: Iterable<string>,
  objectKeys?: Iterable<string>,
): Promise<BackupErasureFenceSet> {
  const ids = [...new Set(snapshotIds)];
  const snapshotSubjects = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await dbModule.db
      .select({ snapshotId: backupErasureTargets.snapshotId, subjectOrgId: backupErasureTargets.subjectOrgId })
      .from(backupErasureTargets)
      .where(sql`${backupErasureTargets.kind} = 'snapshot_prefix' AND ${inArray(backupErasureTargets.snapshotId, ids.slice(i, i + 1000))}`);
    for (const row of rows) {
      if (!row.snapshotId) continue;
      let subjects = snapshotSubjects.get(row.snapshotId);
      if (!subjects) {
        subjects = new Set();
        snapshotSubjects.set(row.snapshotId, subjects);
      }
      subjects.add(row.subjectOrgId);
    }
  }
  const fencedKeys = new Set<string>();
  if (objectKeys === undefined) {
    const rows = await dbModule.db
      .select({ objectKey: backupErasureTargets.objectKey })
      .from(backupErasureTargets)
      .where(sql`${backupErasureTargets.kind} = 'recovery_media_key'`);
    for (const row of rows) if (row.objectKey) fencedKeys.add(row.objectKey);
  } else {
    const keys = [...new Set(objectKeys)];
    for (let i = 0; i < keys.length; i += 1000) {
      const rows = await dbModule.db
        .select({ objectKey: backupErasureTargets.objectKey })
        .from(backupErasureTargets)
        .where(sql`${backupErasureTargets.kind} = 'recovery_media_key' AND ${inArray(backupErasureTargets.objectKey, keys.slice(i, i + 1000))}`);
      for (const row of rows) if (row.objectKey) fencedKeys.add(row.objectKey);
    }
  }
  return { snapshotSubjects, objectKeys: fencedKeys };
}

/**
 * The fenced ids one (identity, org) sweep must treat as foreign: every fenced
 * id, EXCEPT one fenced by this org's own erasure for which the org still
 * holds a live row (snapshot, unswept retirement or NULL-identity row). That
 * exception keeps an erasure that aborted after the up-front capture from
 * freezing the still-existing org's own retention: its rows already establish
 * ownership toward every other org, and its own GC keeps deciding for them
 * exactly as before. A fenced id whose row is gone stays foreign even to its
 * subject org.
 */
export function fencedIdsForeignTo(
  snapshotSubjects: ReadonlyMap<string, ReadonlySet<string>>,
  unitOrgId: string,
  unitOwnedSnapshotIds: ReadonlySet<string>,
): Set<string> {
  const foreign = new Set<string>();
  for (const [snapshotId, subjects] of snapshotSubjects) {
    if (subjects.has(unitOrgId) && unitOwnedSnapshotIds.has(snapshotId)) continue;
    foreign.add(snapshotId);
  }
  return foreign;
}

/**
 * Which of `snapshotIds` the org holds a live row for RIGHT NOW (a snapshot or
 * an unswept retirement). Used by GC's pre-delete recheck so the
 * own-erasure exception in `fencedIdsForeignTo` is never decided from state
 * read before an erasure deleted the row. System DB context.
 */
export async function loadOrgLiveSnapshotIds(orgId: string, snapshotIds: string[]): Promise<Set<string>> {
  const owned = new Set<string>();
  for (let i = 0; i < snapshotIds.length; i += 1000) {
    const chunk = snapshotIds.slice(i, i + 1000);
    const list = sql.join(chunk.map((id) => sql`${id}`), sql`, `);
    const rows = rowsOf<{ snapshot_id: string }>(await dbModule.db.execute(sql`
      SELECT snapshot_id FROM backup_snapshots WHERE org_id = ${orgId}::uuid AND snapshot_id IN (${list})
      UNION
      SELECT snapshot_id FROM backup_snapshot_retirements
       WHERE org_id = ${orgId}::uuid AND swept_at IS NULL AND snapshot_id IN (${list})
    `));
    for (const row of rows) owned.add(row.snapshot_id);
  }
  return owned;
}

// ── Referenced-key cache for fenced snapshots ───────────────────────────────

export type FenceRefsRow =
  | { snapshotId: string; state: 'resolved'; referencedKeys: string[] }
  | { snapshotId: string; state: 'unreadable'; attempts: number; nextAttemptAt: Date | null };

/** Stored resolution state for these fenced ids on one physical identity. System DB context. */
export async function loadFenceRefs(storageIdentity: string, snapshotIds: string[]): Promise<Map<string, FenceRefsRow>> {
  const out = new Map<string, FenceRefsRow>();
  for (let i = 0; i < snapshotIds.length; i += 1000) {
    const rows = await dbModule.db
      .select()
      .from(backupErasureFenceRefs)
      .where(sql`${backupErasureFenceRefs.storageIdentity} = ${storageIdentity} AND ${inArray(backupErasureFenceRefs.snapshotId, snapshotIds.slice(i, i + 1000))}`);
    for (const row of rows) {
      out.set(row.snapshotId, row.state === 'resolved'
        ? { snapshotId: row.snapshotId, state: 'resolved', referencedKeys: row.referencedKeys }
        : { snapshotId: row.snapshotId, state: 'unreadable', attempts: row.attempts, nextAttemptAt: row.nextAttemptAt });
    }
  }
  return out;
}

/** Records a resolved reference set. A resolved row is never overwritten. System DB context. */
export async function recordFenceRefsResolved(storageIdentity: string, snapshotId: string, referencedKeys: string[]): Promise<void> {
  await dbModule.db
    .insert(backupErasureFenceRefs)
    .values({ storageIdentity, snapshotId, state: 'resolved', referencedKeys, attempts: 0 })
    .onConflictDoUpdate({
      target: [backupErasureFenceRefs.storageIdentity, backupErasureFenceRefs.snapshotId],
      set: { state: 'resolved', referencedKeys, lastError: null, nextAttemptAt: null, updatedAt: new Date() },
      setWhere: sql`${backupErasureFenceRefs.state} <> 'resolved'`,
    });
}

/** Exponential retry backoff for an unreadable fenced manifest: 1h, 2h, 4h … capped at 7 days. */
export function fenceRefsRetryDelayMs(attempts: number): number {
  const hour = 60 * 60 * 1000;
  return Math.min(hour * 2 ** Math.max(0, attempts - 1), 7 * 24 * hour);
}

/**
 * Records a failed resolution attempt and schedules the next one with
 * backoff. Never downgrades a resolved row. Returns the attempt count.
 * System DB context.
 */
export async function recordFenceRefsUnreadable(storageIdentity: string, snapshotId: string, error: string, nowMs: number): Promise<number> {
  const [existing] = await dbModule.db
    .select({ state: backupErasureFenceRefs.state, attempts: backupErasureFenceRefs.attempts })
    .from(backupErasureFenceRefs)
    .where(sql`${backupErasureFenceRefs.storageIdentity} = ${storageIdentity} AND ${backupErasureFenceRefs.snapshotId} = ${snapshotId}`);
  if (existing?.state === 'resolved') return existing.attempts;
  const attempts = (existing?.attempts ?? 0) + 1;
  const nextAttemptAt = new Date(nowMs + fenceRefsRetryDelayMs(attempts));
  await dbModule.db
    .insert(backupErasureFenceRefs)
    .values({ storageIdentity, snapshotId, state: 'unreadable', attempts, lastError: error, nextAttemptAt })
    .onConflictDoUpdate({
      target: [backupErasureFenceRefs.storageIdentity, backupErasureFenceRefs.snapshotId],
      set: { attempts, lastError: error, nextAttemptAt, updatedAt: new Date() },
      setWhere: sql`${backupErasureFenceRefs.state} <> 'resolved'`,
    });
  return attempts;
}
