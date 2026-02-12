import { desc, eq } from 'drizzle-orm';
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

export async function saveFilesystemSnapshot(
  deviceId: string,
  trigger: FilesystemSnapshotTrigger,
  payload: AnyObject
) {
  const summary = asRecord(payload.summary) ?? {};
  const partial = asBoolean(payload.partial, false);

  const [snapshot] = await db
    .insert(deviceFilesystemSnapshots)
    .values({
      deviceId,
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

export async function getLatestFilesystemSnapshot(deviceId: string) {
  const [snapshot] = await db
    .select()
    .from(deviceFilesystemSnapshots)
    .where(eq(deviceFilesystemSnapshots.deviceId, deviceId))
    .orderBy(desc(deviceFilesystemSnapshots.capturedAt))
    .limit(1);

  return snapshot ?? null;
}

export async function getFilesystemScanState(deviceId: string) {
  const [state] = await db
    .select()
    .from(deviceFilesystemScanState)
    .where(eq(deviceFilesystemScanState.deviceId, deviceId))
    .limit(1);

  return state ?? null;
}

export async function upsertFilesystemScanState(
  deviceId: string,
  updates: {
    lastRunMode?: string;
    lastBaselineCompletedAt?: Date | null;
    lastDiskUsedPercent?: number | null;
    checkpoint?: unknown;
    aggregate?: unknown;
    hotDirectories?: unknown;
  }
) {
  const now = new Date();
  const insertValues: typeof deviceFilesystemScanState.$inferInsert = {
    deviceId,
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

  const [state] = await db
    .insert(deviceFilesystemScanState)
    .values(insertValues)
    .onConflictDoUpdate({
      target: deviceFilesystemScanState.deviceId,
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
    summary: {
      filesScanned: asNumber(existingSummary.filesScanned, 0) + asNumber(incomingSummary.filesScanned, 0),
      dirsScanned: asNumber(existingSummary.dirsScanned, 0) + asNumber(incomingSummary.dirsScanned, 0),
      bytesScanned: asNumber(existingSummary.bytesScanned, 0) + asNumber(incomingSummary.bytesScanned, 0),
      maxDepthReached: Math.max(asNumber(existingSummary.maxDepthReached, 0), asNumber(incomingSummary.maxDepthReached, 0)),
      permissionDeniedCount:
        asNumber(existingSummary.permissionDeniedCount, 0) + asNumber(incomingSummary.permissionDeniedCount, 0),
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
