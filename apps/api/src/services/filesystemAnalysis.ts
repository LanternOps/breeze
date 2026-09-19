import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceFilesystemSnapshots,
  deviceFilesystemScanState,
  filesystemSnapshotTriggerEnum,
} from '../db/schema/filesystem';

const SAFE_CLEANUP_CATEGORIES = new Set(['temp_files', 'browser_cache', 'package_cache', 'trash']);

export type FilesystemSnapshotTrigger = typeof filesystemSnapshotTriggerEnum.enumValues[number];

export type FilesystemCleanupCandidate = {
  path: string;
  category: string;
  sizeBytes: number;
  safe: boolean;
  reason?: string;
  modifiedAt?: string;
};

type FilesystemDb = Pick<typeof db, 'insert' | 'select' | 'update'>;

type AnyObject = Record<string, unknown>;
type Numberish = number | string | null | undefined;

function asRecord(value: unknown): AnyObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as AnyObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function asNumber(value: unknown, defaultValue = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
  return defaultValue;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseFilesystemAnalysisStdout(stdout: string): AnyObject {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const record = asRecord(parsed);
    return record ?? {};
  } catch {
    return {};
  }
}

/**
 * @param scanPath the NORMALISED volume/path this scan covered
 *   (`normalizeScanPath` from `@breeze/shared`). It is the second half of the
 *   key every reader uses — a raw `c:\` here is invisible to a `C:\` read.
 */
export async function saveFilesystemSnapshot(
  deviceId: string,
  orgId: string,
  trigger: FilesystemSnapshotTrigger,
  scanPath: string,
  payload: AnyObject,
  executor: FilesystemDb = db
) {
  const summary = asRecord(payload.summary) ?? {};
  const partial = asBoolean(payload.partial, false);

  const [snapshot] = await executor
    .insert(deviceFilesystemSnapshots)
    .values({
      deviceId,
      orgId,
      scanPath,
      trigger,
      partial,
      summary,
      largestFiles: asArray(payload.topLargestFiles),
      largestDirs: asArray(payload.topLargestDirectories),
      tempAccumulation: asArray(payload.tempAccumulation),
      oldDownloads: asArray(payload.oldDownloads),
      unrotatedLogs: asArray(payload.unrotatedLogs),
      trashUsage: asArray(payload.trashUsage),
      duplicateCandidates: asArray(payload.duplicateCandidates),
      cleanupCandidates: asArray(payload.cleanupCandidates),
      errors: asArray(payload.errors),
      rawPayload: payload,
    })
    .returning();

  return snapshot ?? null;
}

export async function getLatestFilesystemSnapshot(deviceId: string, scanPath: string) {
  const [snapshot] = await db
    .select()
    .from(deviceFilesystemSnapshots)
    .where(and(
      eq(deviceFilesystemSnapshots.deviceId, deviceId),
      eq(deviceFilesystemSnapshots.scanPath, scanPath),
    ))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

/**
 * Slim variant for the cleanup preview/execute paths and the volumes list,
 * which need the snapshot's identity and its cleanup candidates but none of
 * the other large jsonb columns (largest files/dirs, duplicates, the duplicate
 * rawPayload blob). `capturedAt`/`partial` are cheap scalars and are what the
 * volumes list renders next to each chip.
 */
export async function getLatestFilesystemCleanupSnapshot(deviceId: string, scanPath: string) {
  const [snapshot] = await db
    .select({
      id: deviceFilesystemSnapshots.id,
      scanPath: deviceFilesystemSnapshots.scanPath,
      capturedAt: deviceFilesystemSnapshots.capturedAt,
      partial: deviceFilesystemSnapshots.partial,
      cleanupCandidates: deviceFilesystemSnapshots.cleanupCandidates,
    })
    .from(deviceFilesystemSnapshots)
    .where(and(
      eq(deviceFilesystemSnapshots.deviceId, deviceId),
      eq(deviceFilesystemSnapshots.scanPath, scanPath),
    ))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

export async function getFilesystemScanState(deviceId: string, scanPath: string, executor: FilesystemDb = db) {
  const [state] = await executor
    .select()
    .from(deviceFilesystemScanState)
    .where(and(
      eq(deviceFilesystemScanState.deviceId, deviceId),
      eq(deviceFilesystemScanState.scanPath, scanPath),
    ))
    .limit(1);

  return state ?? null;
}

export async function upsertFilesystemScanState(
  deviceId: string,
  orgId: string,
  scanPath: string,
  updates: {
    lastRunMode?: string;
    lastBaselineCompletedAt?: Date | null;
    lastDiskUsedPercent?: number | null;
    checkpoint?: unknown;
    aggregate?: unknown;
    hotDirectories?: unknown;
    // Generation and receipt are owned by the claim, never by this upsert.
  },
  executor: FilesystemDb = db
) {
  const now = new Date();
  const insertValues: typeof deviceFilesystemScanState.$inferInsert = {
    deviceId,
    orgId,
    scanPath,
    lastRunMode: updates.lastRunMode ?? 'baseline',
    lastBaselineCompletedAt: updates.lastBaselineCompletedAt ?? null,
    lastDiskUsedPercent: updates.lastDiskUsedPercent ?? null,
    checkpoint: updates.checkpoint ?? {},
    aggregate: updates.aggregate ?? {},
    hotDirectories: updates.hotDirectories ?? [],
    createdAt: now,
    updatedAt: now,
  };

  const updateSet: Partial<typeof deviceFilesystemScanState.$inferInsert> = {
    updatedAt: now,
  };

  if (updates.lastRunMode !== undefined) updateSet.lastRunMode = updates.lastRunMode;
  if (updates.lastBaselineCompletedAt !== undefined) updateSet.lastBaselineCompletedAt = updates.lastBaselineCompletedAt;
  if (updates.lastDiskUsedPercent !== undefined) updateSet.lastDiskUsedPercent = updates.lastDiskUsedPercent;
  if (updates.checkpoint !== undefined) updateSet.checkpoint = updates.checkpoint;
  if (updates.aggregate !== undefined) updateSet.aggregate = updates.aggregate;
  if (updates.hotDirectories !== undefined) updateSet.hotDirectories = updates.hotDirectories;

  const [state] = await executor
    .insert(deviceFilesystemScanState)
    .values(insertValues)
    .onConflictDoUpdate({
      // The (device_id, scan_path) key (2026-10-21-110000). It is a UNIQUE
      // INDEX in W02, not a primary key (amendment 16) — Postgres infers
      // either one from this column list, so nothing here changes when W03
      // promotes it. A single-column target names no unique index at all once
      // the old key is dropped, and every upsert raises 42P10, which is why
      // this change and that migration ship in one release (spec §4).
      target: [deviceFilesystemScanState.deviceId, deviceFilesystemScanState.scanPath],
      set: updateSet,
    })
    .returning();

  return state ?? null;
}

export function readHotDirectories(value: unknown, limit = 24): string[] {
  return asArray(value)
    .map((entry) => (typeof entry === 'string' ? entry : null))
    .filter((entry): entry is string => entry !== null && entry.length > 0)
    .slice(0, limit);
}

export function readCheckpointPendingDirectories(value: unknown, limit = 50_000): Array<{ path: string; depth: number }> {
  const record = asRecord(value);
  if (!record) return [];
  return asArray(record.pendingDirs)
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) return null;
      const path = asString(item.path);
      if (!path) return null;
      return {
        path,
        depth: Math.max(0, Math.trunc(asNumber(item.depth, 0))),
      };
    })
    .filter((entry): entry is { path: string; depth: number } => entry !== null)
    .slice(0, limit);
}

function mergeTopItemsByPath(
  first: unknown,
  second: unknown,
  sizeKey: string,
  limit: number
): AnyObject[] {
  const byPath = new Map<string, AnyObject>();
  for (const raw of [...asArray(first), ...asArray(second)]) {
    const entry = asRecord(raw);
    const path = asString(entry?.path);
    if (!entry || !path) continue;
    const current = byPath.get(path);
    if (!current || asNumber(entry[sizeKey], 0) > asNumber(current[sizeKey], 0)) {
      byPath.set(path, entry);
    } else if (current && asBoolean(current.estimated, false) === false && asBoolean(entry.estimated, false)) {
      byPath.set(path, { ...current, estimated: true });
    }
  }

  return Array.from(byPath.values())
    .sort((a, b) => asNumber(b[sizeKey], 0) - asNumber(a[sizeKey], 0))
    .slice(0, limit);
}

function mergeAccumulationByCategory(first: unknown, second: unknown): AnyObject[] {
  const byCategory = new Map<string, number>();
  for (const raw of [...asArray(first), ...asArray(second)]) {
    const entry = asRecord(raw);
    const category = asString(entry?.category);
    if (!category) continue;
    byCategory.set(category, (byCategory.get(category) ?? 0) + asNumber(entry?.bytes, 0));
  }
  return Array.from(byCategory.entries())
    .map(([category, bytes]) => ({ category, bytes }))
    .sort((a, b) => asNumber(b.bytes, 0) - asNumber(a.bytes, 0));
}

function mergePathSizedItems(first: unknown, second: unknown, limit: number): AnyObject[] {
  const byPath = new Map<string, AnyObject>();
  for (const raw of [...asArray(first), ...asArray(second)]) {
    const entry = asRecord(raw);
    const path = asString(entry?.path);
    if (!entry || !path) continue;
    const current = byPath.get(path);
    if (!current || asNumber(entry.sizeBytes, 0) > asNumber(current.sizeBytes, 0)) {
      byPath.set(path, entry);
    }
  }

  return Array.from(byPath.values())
    .sort((a, b) => asNumber(b.sizeBytes, 0) - asNumber(a.sizeBytes, 0))
    .slice(0, limit);
}

export function mergeFilesystemAnalysisPayload(existing: AnyObject, incoming: AnyObject): AnyObject {
  const existingSummary = asRecord(existing.summary) ?? {};
  const incomingSummary = asRecord(incoming.summary) ?? {};

  return {
    ...existing,
    ...incoming,
    path: asString(incoming.path) ?? asString(existing.path),
    partial: asBoolean(existing.partial, false) || asBoolean(incoming.partial, false),
    reason: asString(incoming.reason) ?? asString(existing.reason),
    // The checkpoint is the resume frontier of the CURRENT run, not something to
    // accumulate. A completed run omits it (Go `omitempty` on an empty map); the
    // `...existing` spread would otherwise inherit the previous run's stale
    // pending dirs, so a resumed baseline could never register as complete.
    checkpoint: asRecord(incoming.checkpoint) ?? {},
    summary: {
      filesScanned: asNumber(existingSummary.filesScanned, 0) + asNumber(incomingSummary.filesScanned, 0),
      dirsScanned: asNumber(existingSummary.dirsScanned, 0) + asNumber(incomingSummary.dirsScanned, 0),
      bytesScanned: asNumber(existingSummary.bytesScanned, 0) + asNumber(incomingSummary.bytesScanned, 0),
      maxDepthReached: Math.max(asNumber(existingSummary.maxDepthReached, 0), asNumber(incomingSummary.maxDepthReached, 0)),
      permissionDeniedCount:
        asNumber(existingSummary.permissionDeniedCount, 0) + asNumber(incomingSummary.permissionDeniedCount, 0),
      // Sticky across a resumed baseline: the summary is REBUILT from named
      // fields, so without this line a checkpointed scan that hit the duplicate
      // cap reported "no duplicates" instead of "we stopped looking".
      duplicateTrackingTruncated:
        asBoolean(existingSummary.duplicateTrackingTruncated, false) ||
        asBoolean(incomingSummary.duplicateTrackingTruncated, false),
    },
    topLargestFiles: mergeTopItemsByPath(existing.topLargestFiles, incoming.topLargestFiles, 'sizeBytes', 50),
    topLargestDirectories: mergeTopItemsByPath(existing.topLargestDirectories, incoming.topLargestDirectories, 'sizeBytes', 30),
    tempAccumulation: mergeAccumulationByCategory(existing.tempAccumulation, incoming.tempAccumulation),
    oldDownloads: mergePathSizedItems(existing.oldDownloads, incoming.oldDownloads, 200),
    unrotatedLogs: mergePathSizedItems(existing.unrotatedLogs, incoming.unrotatedLogs, 200),
    trashUsage: mergePathSizedItems(existing.trashUsage, incoming.trashUsage, 16),
    cleanupCandidates: mergePathSizedItems(existing.cleanupCandidates, incoming.cleanupCandidates, 1000),
    errors: [...asArray(existing.errors), ...asArray(incoming.errors)].slice(0, 200),
    duplicateCandidates: asArray(incoming.duplicateCandidates).length > 0
      ? asArray(incoming.duplicateCandidates).slice(0, 200)
      : asArray(existing.duplicateCandidates).slice(0, 200),
  };
}

function toCleanupCandidate(value: unknown): FilesystemCleanupCandidate | null {
  const record = asRecord(value);
  if (!record) return null;

  const path = typeof record.path === 'string' ? record.path : '';
  const category = typeof record.category === 'string' ? record.category : '';
  if (!path || !category) return null;

  const sizeRaw = record.sizeBytes;
  const sizeBytes =
    typeof sizeRaw === 'number'
      ? sizeRaw
      : typeof sizeRaw === 'string'
        ? Number(sizeRaw)
        : 0;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;

  return {
    path,
    category,
    sizeBytes,
    safe: typeof record.safe === 'boolean' ? record.safe : SAFE_CLEANUP_CATEGORIES.has(category),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : undefined,
  };
}

export function buildCleanupPreview(
  snapshot: { cleanupCandidates: unknown; id: string },
  requestedCategories?: string[]
) {
  const requestedSet = requestedCategories && requestedCategories.length > 0
    ? new Set(requestedCategories)
    : null;

  const allCandidates = asArray(snapshot.cleanupCandidates)
    .map(toCleanupCandidate)
    .filter((candidate): candidate is FilesystemCleanupCandidate => candidate !== null)
    .filter((candidate) => candidate.safe && SAFE_CLEANUP_CATEGORIES.has(candidate.category))
    .filter((candidate) => (requestedSet ? requestedSet.has(candidate.category) : true));

  const deduped = new Map<string, FilesystemCleanupCandidate>();
  for (const candidate of allCandidates) {
    const existing = deduped.get(candidate.path);
    if (!existing || candidate.sizeBytes > existing.sizeBytes) {
      deduped.set(candidate.path, candidate);
    }
  }

  const candidates = Array.from(deduped.values()).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const estimatedBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);

  const byCategory = new Map<string, { count: number; estimatedBytes: number }>();
  for (const candidate of candidates) {
    const current = byCategory.get(candidate.category) ?? { count: 0, estimatedBytes: 0 };
    current.count += 1;
    current.estimatedBytes += candidate.sizeBytes;
    byCategory.set(candidate.category, current);
  }

  return {
    snapshotId: snapshot.id,
    estimatedBytes,
    candidateCount: candidates.length,
    categories: Array.from(byCategory.entries()).map(([category, stats]) => ({
      category,
      count: stats.count,
      estimatedBytes: stats.estimatedBytes,
    })),
    candidates,
  };
}

export const safeCleanupCategories = Array.from(SAFE_CLEANUP_CATEGORIES);

/**
 * Extracts the previewed cleanup candidates from a stored cleanup-run `plan`
 * (jsonb). Used by cleanup-execute to pin deletions to exactly what the user
 * previewed. Only safe candidates in known-safe categories are returned, so a
 * stale or hand-edited plan can never widen the deletion set.
 */
export function readPlanPreviewCandidates(plan: unknown): FilesystemCleanupCandidate[] {
  const planRecord = asRecord(plan);
  const preview = asRecord(planRecord?.preview);
  return asArray(preview?.candidates)
    .map(toCleanupCandidate)
    .filter((candidate): candidate is FilesystemCleanupCandidate => candidate !== null)
    .filter((candidate) => candidate.safe && SAFE_CLEANUP_CATEGORIES.has(candidate.category));
}

export interface StoredExecutedActions {
  partial: boolean;
  budgetMs: number;
  actions: unknown[];
}

/**
 * The stored `executed_actions` envelope. W01 changed the column from a bare
 * array to `{ partial, budgetMs, actions }` so a budget-truncated run can say
 * so (spec §5.2). No migration: the column is jsonb. This reader accepts BOTH
 * shapes, because every run recorded before W01 is a bare array and the run
 * history must still render it.
 */
export function readExecutedActions(value: unknown): StoredExecutedActions {
  if (Array.isArray(value)) {
    return { partial: false, budgetMs: 0, actions: value };
  }
  const record = asRecord(value);
  if (!record || !Array.isArray(record.actions)) {
    return { partial: false, budgetMs: 0, actions: [] };
  }
  return {
    partial: asBoolean(record.partial, false),
    budgetMs: asNumber(record.budgetMs, 0),
    actions: record.actions,
  };
}

/**
 * Extracts the scan path a cleanup preview pinned into its stored `plan`
 * (jsonb). Cleanup-execute takes no `path` of its own in W02, so a pinned run
 * is the only place the volume is recorded when the row's `scan_path` column
 * predates this wave. Returns null rather than guessing, so the caller falls
 * back to the OS root explicitly.
 */
export function readPlanScanPath(plan: unknown): string | null {
  const record = asRecord(plan);
  return asString(record?.scanPath);
}

/** Register the producer even when this is the volume's first scan. */
export async function setFilesystemScanGeneration(
  deviceId: string,
  orgId: string,
  scanPath: string,
  commandId: string
): Promise<void> {
  await db.insert(deviceFilesystemScanState)
    .values({ deviceId, orgId, scanPath, scanGeneration: commandId })
    .onConflictDoUpdate({
      target: [deviceFilesystemScanState.deviceId, deviceFilesystemScanState.scanPath],
      set: { scanGeneration: commandId, updatedAt: new Date() },
    });
}

export type ScanGenerationClaim = 'claimed' | 'superseded' | 'already_applied' | 'absent';

/**
 * Claim and persist using the SAME transaction. The row lock serializes
 * producers/results until persistence commits; a rollback restores the receipt.
 * orgId lets legacy results create a missing row before claiming, so concurrent
 * first deliveries serialize on the unique key too.
 */
export async function claimFilesystemScanGeneration(
  deviceId: string,
  scanPath: string,
  commandId: string,
  executor: FilesystemDb = db,
  orgId?: string
): Promise<ScanGenerationClaim> {
  let created = false;
  if (orgId) {
    const inserted = await executor.insert(deviceFilesystemScanState)
      .values({ deviceId, orgId, scanPath })
      .onConflictDoNothing({ target: [deviceFilesystemScanState.deviceId, deviceFilesystemScanState.scanPath] })
      .returning({ deviceId: deviceFilesystemScanState.deviceId });
    created = inserted.length > 0;
  }
  const claimed = await executor
    .update(deviceFilesystemScanState)
    .set({ scanGeneration: null, lastAppliedCommandId: commandId, updatedAt: new Date() })
    .where(and(
      eq(deviceFilesystemScanState.deviceId, deviceId),
      eq(deviceFilesystemScanState.scanPath, scanPath),
      or(
        eq(deviceFilesystemScanState.scanGeneration, commandId),
        and(
          isNull(deviceFilesystemScanState.scanGeneration),
          // Clearing the generation after B applies must not let older A (or
          // its replay) replace B. Compare in this UPDATE so the row lock and
          // receipt advance stay atomic. A pruned applied command has no
          // ordering evidence, so legacy delivery is still allowed.
          sql`NOT EXISTS (
            SELECT 1 FROM device_commands AS applied
            JOIN device_commands AS arriving ON arriving.id = ${commandId}
            WHERE applied.id = ${deviceFilesystemScanState.lastAppliedCommandId}
              AND applied.created_at >= arriving.created_at
          )`,
        ),
      ),
      sql`${deviceFilesystemScanState.lastAppliedCommandId} IS DISTINCT FROM ${commandId}`,
    ))
    .returning({ deviceId: deviceFilesystemScanState.deviceId });

  if (claimed.length > 0) return created ? 'absent' : 'claimed';

  const [state] = await executor
    .select({ scanGeneration: deviceFilesystemScanState.scanGeneration, lastAppliedCommandId: deviceFilesystemScanState.lastAppliedCommandId })
    .from(deviceFilesystemScanState)
    .where(and(
      eq(deviceFilesystemScanState.deviceId, deviceId),
      eq(deviceFilesystemScanState.scanPath, scanPath),
    ))
    .limit(1);

  if (!state) return 'absent';
  return state.lastAppliedCommandId === commandId ? 'already_applied' : 'superseded';
}
