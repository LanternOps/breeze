/**
 * Backup Retention — GFS tagging and legal-hold-aware cleanup
 *
 * GFS (Grandfather-Father-Son) retention tags every completed backup snapshot
 * with daily/weekly/monthly/yearly labels. Retention cleanup respects legal
 * holds and immutability windows.
 */

import { resolve as resolveLocalPath } from 'node:path';
import { db } from '../db';
import {
  backupSnapshots,
  backupPolicies,
  backupJobs,
  configPolicyBackupSettings,
  backupConfigs,
} from '../db/schema';
import { eq, and, lt, desc, inArray, isNull } from 'drizzle-orm';
import {
  BACKUP_SNAPSHOT_ROOT_DIR,
  BACKUP_SNAPSHOT_MANIFEST_KEY,
  backupSnapshotManifestKey,
  backupSnapshotRootPrefix,
  deleteBackupObjectKeys,
  fetchBackupObjectText,
  listBackupObjectsUnderPrefix,
  type BackupObjectListing,
} from '../services/backupSnapshotStorage';
import { asRecord, getStringValue } from '../services/recoveryBootstrap';

// ── GFS tag types ────────────────────────────────────────────────────────────

export type GfsTags = {
  daily: boolean;
  weekly?: boolean;
  monthly?: boolean;
  yearly?: boolean;
};

export type GfsConfig = {
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
  weeklyDay?: number;
  retentionDays?: number;
  maxVersions?: number;
};

// ── GFS tag computation ──────────────────────────────────────────────────────

export function computeGfsTags(
  completedAt: Date,
  gfsConfig: GfsConfig | null | undefined
): GfsTags {
  const tags: GfsTags = { daily: true }; // every backup is daily

  if (!gfsConfig) return tags;

  const dayOfWeek = completedAt.getUTCDay(); // 0=Sunday
  const dayOfMonth = completedAt.getUTCDate();
  const month = completedAt.getUTCMonth();

  // Weekly: backup on the configured day (default Sunday=0)
  const gfsWeeklyDay = gfsConfig.weeklyDay ?? 0;
  if (dayOfWeek === gfsWeeklyDay) {
    tags.weekly = true;
  }

  // Monthly: last day of month (next day rolls into a new month)
  const nextDay = new Date(completedAt);
  nextDay.setUTCDate(dayOfMonth + 1);
  if (nextDay.getUTCMonth() !== month) {
    tags.monthly = true;
  }

  // Yearly: last day of December
  if (month === 11 && tags.monthly) {
    tags.yearly = true;
  }

  return tags;
}

// ── Resolve GFS config from job's policy ─────────────────────────────────────

export async function resolveGfsConfigForJob(
  jobId: string
): Promise<GfsConfig | null> {
  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      policyId: backupJobs.policyId,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job) return null;

  // New path: config policy backup settings
  if (job.featureLinkId) {
    const [settings] = await db
      .select({ retention: configPolicyBackupSettings.retention })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    if (settings?.retention) {
      const r = settings.retention as Record<string, number>;
      return {
        daily: r.keepDaily,
        weekly: r.keepWeekly,
        monthly: r.keepMonthly,
        yearly: r.keepYearly,
        weeklyDay: r.weeklyDay,
        retentionDays: r.retentionDays,
        maxVersions: r.maxVersions,
      };
    }
  }

  // Legacy fallback: deprecated backupPolicies
  if (job.policyId) {
    const [policy] = await db
      .select({ gfsConfig: backupPolicies.gfsConfig })
      .from(backupPolicies)
      .where(eq(backupPolicies.id, job.policyId))
      .limit(1);

    return (policy?.gfsConfig as GfsConfig) ?? null;
  }

  return null;
}

// ── Apply GFS tags to a snapshot ─────────────────────────────────────────────

export async function applyGfsTagsToSnapshot(
  snapshotDbId: string,
  completedAt: Date,
  jobId: string
): Promise<GfsTags> {
  const gfsConfig = await resolveGfsConfigForJob(jobId);
  const tags = computeGfsTags(completedAt, gfsConfig);

  await db
    .update(backupSnapshots)
    .set({ gfsTags: tags })
    .where(eq(backupSnapshots.id, snapshotDbId));

  return tags;
}

// ── Retention cleanup (legal hold + immutability aware) ──────────────────────

export type RetentionCleanupResult = {
  deleted: number;
  skippedLegalHold: number;
  skippedImmutable: number;
  prunedByMaxVersions: number;
};

/**
 * Deletes a `backup_snapshots` ROW ONLY. Deliberately does NOT touch object
 * storage: under the incremental/synthetic-full manifest model, an
 * incremental snapshot's unchanged files are *references* whose backupPath
 * points into an OLDER snapshot's prefix (see design doc, "reference
 * mechanism"). Eagerly nuking this snapshot's whole storage prefix the
 * instant its row expires would delete objects a still-retained, newer
 * sibling snapshot's manifest still points at — a live-data-loss bug.
 *
 * Object deletion is now the mark-and-sweep GC's exclusive job
 * (sweepUnreferencedBackupObjects, below): it only deletes an object once no
 * RETAINED manifest anywhere for the destination references it, and only
 * after a 48h grace window. Deleting this row here is what makes the
 * snapshot's objects eligible for GC to consider on a later run — GC runs as
 * a separate phase, so there's no order-of-operations gap to close here.
 */
async function deleteSnapshotRow(params: { id: string }): Promise<void> {
  await db
    .delete(backupSnapshots)
    .where(eq(backupSnapshots.id, params.id));
}

/**
 * Cleans up expired snapshots for an org, respecting legal holds and immutability.
 *
 * Snapshots are deleted when:
 *   - `expiresAt` is in the past
 *   - `legalHold` is NOT true
 *   - `isImmutable` is NOT true OR `immutableUntil` is in the past
 */
export async function cleanupExpiredSnapshots(
  orgId: string
): Promise<RetentionCleanupResult> {
  const now = new Date();
  const result: RetentionCleanupResult = {
    deleted: 0,
    skippedLegalHold: 0,
    skippedImmutable: 0,
    prunedByMaxVersions: 0,
  };

  // Find all expired snapshots for this org
  const expired = await db
    .select({
      id: backupSnapshots.id,
      snapshotId: backupSnapshots.snapshotId,
      metadata: backupSnapshots.metadata,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupSnapshots)
    .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
    .where(
      and(
        eq(backupSnapshots.orgId, orgId),
        lt(backupSnapshots.expiresAt, now)
      )
    );

  for (const snap of expired) {
    // Skip legal holds
    if (snap.legalHold) {
      result.skippedLegalHold++;
      console.warn(
        `[BackupRetention] Snapshot ${snap.snapshotId} held by legal hold — skipping deletion`
      );
      continue;
    }

    // Skip immutable snapshots that haven't expired yet
    if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
      result.skippedImmutable++;
      console.warn(
        `[BackupRetention] Snapshot ${snap.snapshotId} immutable until ${snap.immutableUntil.toISOString()} — skipping deletion`
      );
      continue;
    }

    // Safe to delete
    await deleteSnapshotRow({ id: snap.id });

    result.deleted++;
  }

  const versionBoundSnapshots = await db
    .select({
      id: backupSnapshots.id,
      snapshotId: backupSnapshots.snapshotId,
      timestamp: backupSnapshots.timestamp,
      deviceId: backupSnapshots.deviceId,
      configId: backupSnapshots.configId,
      metadata: backupSnapshots.metadata,
      legalHold: backupSnapshots.legalHold,
      isImmutable: backupSnapshots.isImmutable,
      immutableUntil: backupSnapshots.immutableUntil,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
      retention: configPolicyBackupSettings.retention,
    })
    .from(backupSnapshots)
    .innerJoin(backupJobs, eq(backupSnapshots.jobId, backupJobs.id))
    .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
    .leftJoin(
      configPolicyBackupSettings,
      eq(backupJobs.featureLinkId, configPolicyBackupSettings.featureLinkId),
    )
    .where(eq(backupSnapshots.orgId, orgId))
    .orderBy(
      backupSnapshots.deviceId,
      backupSnapshots.configId,
      desc(backupSnapshots.timestamp),
    );

  const snapshotsByGroup = new Map<string, typeof versionBoundSnapshots>();
  for (const row of versionBoundSnapshots) {
    const groupKey = `${row.deviceId}:${row.configId ?? 'none'}`;
    const existing = snapshotsByGroup.get(groupKey);
    if (existing) {
      existing.push(row);
    } else {
      snapshotsByGroup.set(groupKey, [row]);
    }
  }

  for (const groupRows of snapshotsByGroup.values()) {
    const retention = groupRows[0]?.retention as Record<string, unknown> | null | undefined;
    const maxVersions = typeof retention?.maxVersions === 'number' ? retention.maxVersions : null;
    if (!maxVersions || maxVersions < 1 || groupRows.length <= maxVersions) {
      continue;
    }

    for (const snap of groupRows.slice(maxVersions)) {
      if (snap.legalHold) {
        result.skippedLegalHold++;
        continue;
      }

      if (snap.isImmutable && snap.immutableUntil && snap.immutableUntil > now) {
        result.skippedImmutable++;
        continue;
      }

      await deleteSnapshotRow({ id: snap.id });
      result.deleted++;
      result.prunedByMaxVersions++;
    }
  }

  if (
    result.deleted > 0 ||
    result.skippedLegalHold > 0 ||
    result.skippedImmutable > 0 ||
    result.prunedByMaxVersions > 0
  ) {
    console.log(
      `[BackupRetention] Org ${orgId}: deleted ${result.deleted}, ` +
      `skipped ${result.skippedLegalHold} (legal hold), ` +
      `${result.skippedImmutable} (immutable), ` +
      `pruned ${result.prunedByMaxVersions} by maxVersions`
    );
  }

  return result;
}

/**
 * Applies GFS-based expiration dates to a snapshot based on its tags and the
 * GFS retention config. Called after GFS tags have been applied.
 *
 * The highest-tier tag determines the longest retention:
 *   yearly > monthly > weekly > daily
 */
export function computeExpiresAt(
  completedAt: Date,
  tags: GfsTags,
  gfsConfig: GfsConfig | null | undefined
): Date | null {
  if (!gfsConfig) return null;

  let maxDays = 0;

  if (tags.daily && gfsConfig.daily) {
    maxDays = Math.max(maxDays, gfsConfig.daily);
  }
  if (tags.weekly && gfsConfig.weekly) {
    maxDays = Math.max(maxDays, gfsConfig.weekly * 7);
  }
  if (tags.monthly && gfsConfig.monthly) {
    maxDays = Math.max(maxDays, gfsConfig.monthly * 30);
  }
  if (tags.yearly && gfsConfig.yearly) {
    maxDays = Math.max(maxDays, gfsConfig.yearly * 365);
  }

  if (maxDays === 0 && gfsConfig.retentionDays) {
    maxDays = gfsConfig.retentionDays;
  }

  if (maxDays === 0) return null;

  const expires = new Date(completedAt);
  expires.setUTCDate(expires.getUTCDate() + maxDays);
  return expires;
}

// ── Mark-and-sweep GC for unreferenced backup objects ────────────────────────
//
// Incremental snapshots reference objects living under OLDER snapshots'
// prefixes (see design doc's "reference mechanism" and deleteSnapshotRow's
// comment above), so object-storage cleanup can no longer be "delete this
// snapshot's whole prefix when its row expires" — that would delete objects
// a still-retained, newer sibling snapshot's manifest points at. This phase
// runs AFTER row-level retention (cleanupExpiredSnapshots) has already
// deleted expired backup_snapshots rows, and is the ONLY code path that
// deletes backup objects.
//
// Amended 2026-07-17 after data-safety review found the sweep scope was
// wrong (see docs/superpowers/specs/2026-07-16-incremental-backups-design.md,
// "Amendments from GC review"). Current shape:
//
//   Identity: sweeps run per STORAGE IDENTITY (provider + endpoint + bucket),
//             not per backupConfigs row. Two configs can point at the same
//             physical bucket (e.g. shared credentials, migrated configs) —
//             sweeping per-config would see only ITS OWN retained snapshots
//             and delete objects a sibling config's retained snapshot still
//             references. Identity deliberately EXCLUDES providerConfig.prefix
//             (see backupSnapshotStorage.ts's IMPORTANT-1 comment: the agent
//             ignores prefix when writing, so two configs differing only by
//             prefix are the same physical namespace).
//   Mark:     live set = every backupPath + manifest key from EVERY retained
//             (still-existing) backup_snapshots row across ALL configs
//             sharing an identity, PLUS the newest manifest found in the
//             identity's own object LISTING regardless of row retention
//             (dedup-source race: agents pick their reference base from the
//             bucket listing, not from DB rows — a just-uploaded manifest
//             may not have a backup_snapshots row yet, or ever, if
//             persistence failed after upload succeeded). ANY manifest
//             fetch/parse failure anywhere in that combined set aborts the
//             mark for the WHOLE identity — an incomplete live set must
//             never justify a delete.
//   Sweep:    per snapshot-ID prefix found in the listing:
//               - has a manifest.json: normal per-object rule — delete
//                 objects not in the live set AND older than
//                 BACKUP_GC_GRACE_MS (48h).
//               - NO manifest.json (partial/resumable run): protected at
//                 PREFIX granularity for BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS
//                 (9 days = the agent's 7-day journalMaxAge + 48h resume
//                 headroom, corrected 2026-07-17 — equality with journalMaxAge
//                 alone left a boundary race) — a prefix is swept in full
//                 only once its NEWEST object clears that window; one single
//                 fresh object protects the WHOLE prefix.
//   Null config_id: a backup_snapshots row with no config_id can't be
//             attributed to any specific storage identity — its objects
//             could live in ANY bucket we're about to sweep. Its mere
//             existence blocks GC for every identity this run (fail-closed;
//             see sweepUnreferencedBackupObjects).
//   Identity normalization: two configs describing the SAME physical bucket
//             through cosmetically different config values (blank vs
//             explicit-default endpoint, trailing slash, host case, local
//             path spelling) must still collapse to ONE identity, or
//             CRITICAL 1 comes back via the back door — see
//             normalizeStorageIdentity and its belt-and-braces collision
//             check, detectSuspiciousStorageIdentityCollisions.

export const BACKUP_GC_GRACE_MS = 48 * 60 * 60 * 1000;

// Must stay STRICTLY LARGER than agent/internal/backup/journal.go's
// journalMaxAge (7 days) — the agent trusts its checkpoint journal (and
// therefore a partial/manifest-less snapshot prefix) for resume during that
// window and does not re-verify remote objects on resume. Using
// journalMaxAge as an exact equality boundary left a race: a resume opened
// at, say, day 6.9 legitimately keeps running past day 7, so GC could sweep
// its still-live manifest-less prefix out from under it (corrected
// 2026-07-17, GC re-review). The +48h below is resume headroom, not the
// unrelated BACKUP_GC_GRACE_MS concept, though it happens to reuse the same
// 48h value — see the cross-reference comment on journalMaxAge itself, which
// must stay strictly SMALLER than this constant.
const BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // must equal the agent's journalMaxAge
export const BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS =
  BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS + BACKUP_GC_GRACE_MS; // journalMaxAge + 48h resume headroom = 9 days

// Providers this GC path knows how to list-with-last-modified and delete for.
// Mirrors deleteBackupSnapshotArtifacts's s3/local support — other providers
// (azure_blob, google_cloud, backblaze) aren't wired to object storage here
// yet, so their identities are skipped (fail-closed: no listing means no
// age data means no safe sweep decision).
const BACKUP_GC_SUPPORTED_PROVIDERS = new Set(['s3', 'local']);

// Named `skippedIdentities` (not `skippedDestinations`) to match the rest of
// this file's terminology post-CRITICAL-1: the unit of GC work is a storage
// identity (possibly several backupConfigs rows sharing one bucket), not a
// single "destination" row.
export type BackupGcResult = { deleted: number; skippedIdentities: number };

type BackupGcManifest = { files?: Array<{ backupPath?: unknown }> };

/**
 * Resolves the per-run deletion cap from env on every call (not once at
 * module load) so it stays test-overridable without module-reset gymnastics.
 * Same normalization convention as STALE_REAPER_MAX_PER_RUN in
 * staleCommandReaper.ts: 0 means unlimited; negative/NaN falls back to the
 * default rather than silently disabling the sweep. Unset OR blank/whitespace
 * treated identically as "use the default" — `Number('')` is 0 in JS, which
 * would otherwise silently mean "unlimited" for an accidentally-empty env
 * var (e.g. a templated `.env` with `BACKUP_GC_MAX_DELETES_PER_RUN=`).
 */
export function resolveBackupGcMaxDeletesPerRun(): number {
  const envValue = process.env.BACKUP_GC_MAX_DELETES_PER_RUN;
  const trimmed = envValue?.trim();
  if (!trimmed) return 2000;
  const raw = Number(trimmed);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (raw === 0) return Number.MAX_SAFE_INTEGER;
  return 2000;
}

function parseBackupGcManifest(raw: string): BackupGcManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest is not a JSON object');
  }
  const files = (parsed as { files?: unknown }).files;
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error('manifest.files is not an array');
  }
  return parsed as BackupGcManifest;
}

// ── Storage identity grouping (CRITICAL 1 / IMPORTANT 1) ─────────────────────

type BackupGcDestination = { id: string; provider: string; providerConfig: unknown };

export type BackupGcStorageIdentity = {
  key: string;
  provider: string;
  // Representative providerConfig used for actual provider calls (list/fetch/
  // delete) — arbitrary choice among the configs sharing this identity, since
  // by construction they resolve to the same physical bucket; may still carry
  // different (but presumably equally valid) credentials or a cosmetic prefix.
  providerConfig: unknown;
  configIds: string[];
};

// AWS's own default S3 endpoints. An endpoint that's EXPLICITLY the default
// AWS endpoint must canonicalize to the same identity as a blank/omitted
// endpoint (both mean "use AWS's default") — otherwise two configs that only
// differ by "left it blank" vs "typed the default in by hand" would split
// into two identities and resurrect CRITICAL 1. Covers the same host shapes
// deriveS3RegionFromEndpoint (packages/shared/src/utils/s3Region.ts) knows
// about, plus the bare regionless legacy host.
const DEFAULT_AWS_S3_ENDPOINT_PATTERN = /^s3(\.dualstack)?([.-][a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Normalizes an S3-compatible endpoint for identity comparison: strips
 * scheme/path/trailing-slash (only host+port matter), lowercases the host
 * (URL parsing already does this, but be explicit — this value feeds a
 * cross-config grouping decision, not just an HTTP call), and canonicalizes
 * a blank endpoint and an explicit default-AWS endpoint to the SAME value.
 * A genuinely unparseable endpoint falls back to a trimmed+lowercased raw
 * string rather than being treated as blank — fail toward "different
 * identity" (safe: at worst splits one bucket into two, never merges two
 * different ones), never toward "same identity", for anything not
 * confidently understood.
 */
function normalizeS3Endpoint(endpoint: string | null | undefined): string {
  const raw = endpoint?.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (DEFAULT_AWS_S3_ENDPOINT_PATTERN.test(host)) return '';
    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Identity = provider + endpoint + bucket (S3) or provider + resolved root
 * path (local) — deliberately EXCLUDING providerConfig.prefix. See the
 * IMPORTANT-1 comment on backupSnapshotRootPrefix in backupSnapshotStorage.ts
 * for why: the agent ignores prefix when writing, so two configs that only
 * differ by prefix are, physically, the exact same object namespace.
 *
 * Cosmetic variants that must NOT split one physical bucket into two
 * identities (GC re-review 2026-07-17, IMPORTANT 1): blank endpoint vs the
 * explicit default AWS endpoint; endpoint trailing slash and host
 * case (`https://Minio.local:9000/` vs `https://minio.local:9000`);
 * scheme-less vs schemed (both parsed the same way); local paths differing
 * only by trailing slash, `//`, or `.` segments (`path.resolve` collapses
 * these exactly like `ensureContainedLocalPath` in backupSnapshotStorage.ts
 * already does for the same reason).
 */
export function normalizeStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
  if (provider === 'local') {
    const rawPath = getStringValue(providerConfig, 'path') || getStringValue(providerConfig, 'basePath') || '';
    const normalizedPath = rawPath ? resolveLocalPath(rawPath) : '';
    return `local::${normalizedPath}`;
  }
  const endpoint = normalizeS3Endpoint(getStringValue(providerConfig, 'endpoint'));
  // Bucket names are case-sensitive per the S3 spec — trim whitespace only,
  // never lowercase.
  const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '').trim();
  return `${provider}::${endpoint}::${bucket}`;
}

function groupBackupConfigsByStorageIdentity(
  configs: BackupGcDestination[],
): Map<string, BackupGcStorageIdentity> {
  const identities = new Map<string, BackupGcStorageIdentity>();
  for (const config of configs) {
    const key = normalizeStorageIdentity(config.provider, asRecord(config.providerConfig));
    const existing = identities.get(key);
    if (existing) {
      existing.configIds.push(config.id);
      continue;
    }
    identities.set(key, {
      key,
      provider: config.provider,
      providerConfig: config.providerConfig,
      configIds: [config.id],
    });
  }
  return identities;
}

/**
 * Belt-and-braces (GC re-review 2026-07-17, IMPORTANT 1 suggestion): even
 * after normalizeStorageIdentity, an unanticipated cosmetic variant it
 * doesn't yet account for could still produce two DIFFERENT identity keys
 * for the SAME physical bucket — silently re-opening CRITICAL 1, since each
 * identity would only see its own configs' retained snapshots and could
 * delete the other's live objects. Cross-check with a CRUDER comparison —
 * bucket name case-insensitively + hostname only, ignoring port/scheme/the
 * AWS-default canonicalization entirely — and if THAT collapses two
 * identities normalizeStorageIdentity kept apart, something is wrong: log
 * loudly and fail-closed by excluding ALL of them from this run rather than
 * risk two overlapping sweeps on one bucket. Local identities are already
 * exact-path-resolved and have no separate coarse check.
 */
function detectSuspiciousStorageIdentityCollisions(
  identities: Map<string, BackupGcStorageIdentity>,
): Set<string> {
  const coarseGroups = new Map<string, Set<string>>();

  for (const identity of identities.values()) {
    if (identity.provider === 'local') continue;

    const providerConfig = asRecord(identity.providerConfig);
    const bucket = (getStringValue(providerConfig, 'bucket') || getStringValue(providerConfig, 'bucketName') || '')
      .trim()
      .toLowerCase();
    const rawEndpoint = getStringValue(providerConfig, 'endpoint');
    let hostOnly = '';
    if (rawEndpoint?.trim()) {
      try {
        hostOnly = new URL(rawEndpoint.includes('://') ? rawEndpoint : `https://${rawEndpoint}`).hostname.toLowerCase();
      } catch {
        hostOnly = rawEndpoint.trim().toLowerCase();
      }
    }
    const coarseKey = `${identity.provider}::${hostOnly}::${bucket}`;

    let identityKeys = coarseGroups.get(coarseKey);
    if (!identityKeys) {
      identityKeys = new Set();
      coarseGroups.set(coarseKey, identityKeys);
    }
    identityKeys.add(identity.key);
  }

  const suspicious = new Set<string>();
  for (const [coarseKey, identityKeys] of coarseGroups) {
    if (identityKeys.size <= 1) continue;
    console.error(
      `[BackupGC] ${identityKeys.size} DIFFERENT normalized storage identities (${[...identityKeys].join(', ')}) ` +
      `all resolve to the same bucket+host (${coarseKey}) under a cruder comparison — normalizeStorageIdentity ` +
      `likely missed a cosmetic variant. Excluding all of them from this run (fail-closed) to avoid two ` +
      `overlapping sweeps on the same physical bucket.`,
    );
    for (const key of identityKeys) suspicious.add(key);
  }
  return suspicious;
}

// ── Listing grouped by snapshot-ID prefix ─────────────────────────────────────

type BackupGcSnapshotGroup = {
  items: BackupObjectListing[];
  manifestItem: BackupObjectListing | null;
};

function groupListingBySnapshotId(listing: BackupObjectListing[]): Map<string, BackupGcSnapshotGroup> {
  const rootWithSlash = `${BACKUP_SNAPSHOT_ROOT_DIR}/`;
  const groups = new Map<string, BackupGcSnapshotGroup>();

  for (const item of listing) {
    if (!item.key.startsWith(rootWithSlash)) continue; // defense-in-depth; see listS3ObjectsWithLastModified
    const rest = item.key.slice(rootWithSlash.length);
    const slashIdx = rest.indexOf('/');
    const snapshotId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    if (!snapshotId) continue;

    let group = groups.get(snapshotId);
    if (!group) {
      group = { items: [], manifestItem: null };
      groups.set(snapshotId, group);
    }
    group.items.push(item);
    if (item.key === `${rootWithSlash}${snapshotId}/${BACKUP_SNAPSHOT_MANIFEST_KEY}`) {
      group.manifestItem = item;
    }
  }

  return groups;
}

/**
 * IMPORTANT 2 (dedup-source race): finds the snapshot ID whose manifest.json
 * has the newest last-modified among every manifest-bearing group in the
 * listing. Groups whose manifest has no last-modified data are ignored for
 * this purpose (can't compare ages) but are NOT thereby excluded from the
 * live set some other way — if such a group also happens to be the true
 * newest, its objects still get the normal per-object grace-window
 * protection, just not the extra "always live" guarantee this function adds.
 */
function pickNewestListedManifestSnapshotId(groups: Map<string, BackupGcSnapshotGroup>): string | null {
  let newestId: string | null = null;
  let newestMs = -Infinity;
  for (const [snapshotId, group] of groups) {
    const lastModified = group.manifestItem?.lastModified;
    if (!lastModified) continue;
    const ms = lastModified.getTime();
    if (ms > newestMs) {
      newestMs = ms;
      newestId = snapshotId;
    }
  }
  return newestId;
}

/**
 * Mark phase for one storage identity. Returns null (never throws) on any
 * fetch/parse failure so the caller can fail-closed and skip the sweep.
 */
async function markLiveBackupObjects(
  identity: { provider: string; providerConfig: unknown },
  snapshotIds: Iterable<string>,
): Promise<Set<string> | null> {
  const live = new Set<string>();

  for (const snapshotId of snapshotIds) {
    const manifestKey = backupSnapshotManifestKey(snapshotId);
    live.add(manifestKey);

    let raw: string;
    try {
      raw = await fetchBackupObjectText({
        provider: identity.provider,
        providerConfig: identity.providerConfig,
        key: manifestKey,
      });
    } catch (error) {
      console.error(
        `[BackupGC] Manifest fetch failed for snapshot ${snapshotId} (key ${manifestKey}) — aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    let manifest: BackupGcManifest;
    try {
      manifest = parseBackupGcManifest(raw);
    } catch (error) {
      console.error(
        `[BackupGC] Manifest parse failed for snapshot ${snapshotId} (key ${manifestKey}) — aborting sweep for this identity:`,
        error,
      );
      return null;
    }

    for (const file of manifest.files ?? []) {
      if (typeof file.backupPath === 'string' && file.backupPath.length > 0) {
        live.add(file.backupPath);
      }
    }
  }

  return live;
}

/**
 * Sweep phase for one storage identity. Lists the identity's snapshot root
 * ONCE, groups it by snapshot-ID prefix, marks the live set (retained DB
 * rows + the newest listed manifest — IMPORTANT 2), then applies the
 * per-group deletion rule (CRITICAL 3): manifest-bearing prefixes use the
 * existing per-object 48h grace; manifest-less prefixes are protected at
 * prefix granularity until their newest object clears
 * BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS. Throws on listing/mark failure so
 * the caller's per-identity try/catch counts it as skipped (fail-closed).
 */
async function sweepStorageIdentity(
  identity: { id: string; provider: string; providerConfig: unknown },
  retainedSnapshotIds: string[],
  nowMs: number,
  deletesRemaining: number,
): Promise<number> {
  const listing = await listBackupObjectsUnderPrefix({
    provider: identity.provider,
    providerConfig: identity.providerConfig,
    prefix: backupSnapshotRootPrefix(),
  });

  const groups = groupListingBySnapshotId(listing);
  const newestListedSnapshotId = pickNewestListedManifestSnapshotId(groups);

  const snapshotIdsToMark = new Set(retainedSnapshotIds);
  if (newestListedSnapshotId) snapshotIdsToMark.add(newestListedSnapshotId);

  const liveSet = await markLiveBackupObjects(identity, snapshotIdsToMark);
  if (liveSet === null) {
    throw new Error('mark phase failed — see prior log line for the specific snapshot/manifest');
  }

  const graceThreshold = nowMs - BACKUP_GC_GRACE_MS;
  const manifestlessThreshold = nowMs - BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS;
  const deletableItems: BackupObjectListing[] = [];

  for (const group of groups.values()) {
    if (group.manifestItem) {
      // Manifest-bearing prefix: existing loose-object 48h-grace rule, per object.
      for (const item of group.items) {
        if (liveSet.has(item.key)) continue;
        // No last-modified data => cannot prove the grace window elapsed;
        // skip (fail-closed per-object — never delete without age proof).
        if (!item.lastModified) continue;
        if (item.lastModified.getTime() > graceThreshold) continue;
        deletableItems.push(item);
      }
      continue;
    }

    // Manifest-less (partial/resumable) prefix — CRITICAL 3: protected at
    // PREFIX granularity for the agent's journal lifetime. A single object
    // with unknown age, or a newest-object age still inside the window,
    // leaves the ENTIRE prefix untouched this run.
    let newestMs: number | null = null;
    let hasUnknownAge = false;
    for (const item of group.items) {
      if (!item.lastModified) {
        hasUnknownAge = true;
        break;
      }
      const ms = item.lastModified.getTime();
      if (newestMs === null || ms > newestMs) newestMs = ms;
    }
    if (hasUnknownAge || newestMs === null || newestMs > manifestlessThreshold) {
      continue; // whole prefix protected this run
    }

    // Every object under a manifest-less prefix is provably unreferenced —
    // dedup only ever bases a reference off a COMPLETED (manifest-bearing)
    // snapshot (see deleteSnapshotRow's comment above), so nothing here can
    // be "live". The liveSet check below is pure defense-in-depth.
    for (const item of group.items) {
      if (liveSet.has(item.key)) continue;
      deletableItems.push(item);
    }
  }

  if (deletableItems.length === 0 || deletesRemaining <= 0) {
    return 0;
  }

  // Oldest-first so hitting the cap mid-identity always clears the
  // longest-standing garbage first; the remainder is simply picked up again
  // (still unreferenced/still past its window) on the next run.
  deletableItems.sort((a, b) => (a.lastModified as Date).getTime() - (b.lastModified as Date).getTime());
  const toDelete = deletableItems.slice(0, deletesRemaining).map((item) => item.key);

  const { deletedKeys, failedKeys } = await deleteBackupObjectKeys({
    provider: identity.provider,
    providerConfig: identity.providerConfig,
    keys: toDelete,
  });

  if (failedKeys.length > 0) {
    console.warn(
      `[BackupGC] Identity ${identity.id}: ${failedKeys.length} object delete(s) rejected (e.g. object-lock) — left in place: ${failedKeys.map((f) => f.key).join(', ')}`,
    );
  }

  return deletedKeys.length;
}

/**
 * Mark-and-sweep GC over every backup storage identity (provider + endpoint +
 * bucket, grouped across backupConfigs rows — CRITICAL 1). Per-identity
 * failure isolation: one bad/unreachable identity never blocks GC for the
 * others. Bounded total deletes per run (BACKUP_GC_MAX_DELETES_PER_RUN,
 * default 2000, 0 = unlimited) — hitting the cap mid-run just stops cleanly;
 * the sweep is resumable by construction.
 *
 * Fail-closed on unattributed rows: a backup_snapshots row with a NULL
 * config_id can't be mapped to any storage identity, so we can't rule out
 * that its (unknown) objects live in a bucket we're about to sweep. Its mere
 * existence blocks the ENTIRE run, not just one identity — there is no safe,
 * narrower attribution to fall back on.
 */
export async function sweepUnreferencedBackupObjects(): Promise<BackupGcResult> {
  const nowMs = Date.now();

  const unattributedRows = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(isNull(backupSnapshots.configId));

  const destinations = await db
    .select({
      id: backupConfigs.id,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs);

  const identities = groupBackupConfigsByStorageIdentity(destinations);

  if (unattributedRows.length > 0) {
    // Ops-visible (console.error, not debug) and states the remediation:
    // nothing about this self-heals. Someone has to either attribute the
    // row (backfill its config_id) or confirm it's truly orphaned and
    // delete the row — until then, EVERY GC run is a no-op.
    console.error(
      `[BackupGC] ${unattributedRows.length} backup_snapshots row(s) have no config_id — cannot attribute to a ` +
      `storage identity, so their objects could live in ANY bucket. Blocking ALL ${identities.size} identity ` +
      `sweep(s) this run (fail-closed). REMEDIATION REQUIRED: this does not self-heal — attribute the affected ` +
      `row(s) to the correct backup_configs.id, or confirm they're orphaned and delete the row(s), then GC will ` +
      `resume on its next run.`,
    );
    console.log(`[BackupGC] Run complete: deleted 0 object(s), ${identities.size} identity/identities skipped`);
    return { deleted: 0, skippedIdentities: identities.size };
  }

  const suspiciousIdentityKeys = detectSuspiciousStorageIdentityCollisions(identities);

  let deleted = 0;
  let skippedIdentities = 0;
  let deletesRemaining = resolveBackupGcMaxDeletesPerRun();

  for (const identity of identities.values()) {
    if (deletesRemaining <= 0) {
      console.log('[BackupGC] Deletion cap reached for this run — stopping cleanly; remaining identities resume next run');
      break;
    }

    if (suspiciousIdentityKeys.has(identity.key)) {
      skippedIdentities++;
      continue; // detectSuspiciousStorageIdentityCollisions already logged the error
    }

    if (!BACKUP_GC_SUPPORTED_PROVIDERS.has(identity.provider)) {
      skippedIdentities++;
      console.warn(
        `[BackupGC] Identity ${identity.key}: provider '${identity.provider}' has no GC listing support — skipping (fail-closed)`,
      );
      continue;
    }

    try {
      const retainedRows = await db
        .select({ snapshotId: backupSnapshots.snapshotId })
        .from(backupSnapshots)
        .where(inArray(backupSnapshots.configId, identity.configIds));
      const retainedSnapshotIds = retainedRows.map((row) => row.snapshotId);

      const identityDeleted = await sweepStorageIdentity(
        { id: identity.key, provider: identity.provider, providerConfig: identity.providerConfig },
        retainedSnapshotIds,
        nowMs,
        deletesRemaining,
      );
      deleted += identityDeleted;
      deletesRemaining -= identityDeleted;

      if (identityDeleted > 0) {
        console.log(`[BackupGC] Identity ${identity.key}: deleted ${identityDeleted} unreferenced object(s)`);
      } else {
        console.debug(`[BackupGC] Identity ${identity.key}: 0 objects deleted`);
      }
    } catch (error) {
      skippedIdentities++;
      console.error(`[BackupGC] Identity ${identity.key}: sweep failed — isolated, other identities proceed:`, error);
    }
  }

  console.log(
    `[BackupGC] Run complete: deleted ${deleted} object(s), ${skippedIdentities} identity/identities skipped`,
  );

  return { deleted, skippedIdentities };
}
