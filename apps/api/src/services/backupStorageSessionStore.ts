/**
 * Drizzle data access for services/backupStorageSessions.ts. Every query runs
 * in the caller's DB access context (the delivery path's context, or the
 * agent request's org-scoped context), so RLS on backup_storage_sessions,
 * backup_snapshots, backup_snapshot_files and backup_configs applies in
 * addition to the explicit org filters below.
 */
import { and, eq, inArray, isNull, max, sql, count } from 'drizzle-orm';
import { assertInTransaction, db } from '../db';
import {
  backupSnapshotFiles,
  backupSnapshotOrigins,
  backupSnapshots,
  backupStorageSessions,
  deviceCommands,
  devices,
} from '../db/schema';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { resolveBackupProviderConfig } from './backupProviderConfig';
import { attestationJoinColumns, boundIndexCondition, joinedAttestation } from './backupRestoreIntegrity';
import { evaluateStorageSessionBudget } from './backupStorageSessionBudget';
import { isSnapshotWriteInFlight } from './backupSnapshotIdReservations';
import type { BrokeredReadStore, StorageSessionRow, StorageSnapshotRow } from './backupStorageSessions';

// Built lazily: some unit suites mock '../db/schema' with a partial table set,
// and this module is on the command-delivery import path.
const snapshotColumns = () => ({
  id: backupSnapshots.id,
  orgId: backupSnapshots.orgId,
  deviceId: backupSnapshots.deviceId,
  jobId: backupSnapshots.jobId,
  configId: backupSnapshots.configId,
  snapshotId: backupSnapshots.snapshotId,
  storageIdentity: backupSnapshots.storageIdentity,
  keyLayout: backupSnapshots.keyLayout,
  fileIndexStatus: backupSnapshots.fileIndexStatus,
  fileIndexManifestSha256: backupSnapshots.fileIndexManifestSha256,
  fileIndexError: backupSnapshots.fileIndexError,
  integrityStatus: backupSnapshots.integrityStatus,
  metadata: backupSnapshots.metadata,
  // One row per snapshot at most (unique on snapshot_db_id).
  attestation: attestationJoinColumns(),
});

function toSnapshotRow(row: Record<string, unknown>): StorageSnapshotRow {
  return { ...(row as Omit<StorageSnapshotRow, 'attestation'>), attestation: joinedAttestation(row.attestation) };
}

// Snapshot rows always carry their attestation (if any), read in the same
// statement: the file index is only used when it matches it.
const selectSnapshots = () =>
  db
    .select(snapshotColumns())
    .from(backupSnapshots)
    .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id));

const sessionColumns = () => ({
  id: backupStorageSessions.id,
  orgId: backupStorageSessions.orgId,
  commandId: backupStorageSessions.commandId,
  deviceId: backupStorageSessions.deviceId,
  sourceDeviceId: backupStorageSessions.sourceDeviceId,
  snapshotId: backupStorageSessions.snapshotId,
  configId: backupStorageSessions.configId,
  storageIdentity: backupStorageSessions.storageIdentity,
  scope: backupStorageSessions.scope,
  controlKeys: backupStorageSessions.controlKeys,
  useFileIndex: backupStorageSessions.useFileIndex,
  tokenHash: backupStorageSessions.tokenHash,
  generation: backupStorageSessions.generation,
  maxCalls: backupStorageSessions.maxCalls,
  maxResolvedObjects: backupStorageSessions.maxResolvedObjects,
  expiresAt: backupStorageSessions.expiresAt,
  deadline: backupStorageSessions.deadline,
  revokedAt: backupStorageSessions.revokedAt,
  callCount: backupStorageSessions.callCount,
  resolvedObjectCount: backupStorageSessions.resolvedObjectCount,
  rateCallsAvailable: backupStorageSessions.rateCallsAvailable,
  rateObjectsAvailable: backupStorageSessions.rateObjectsAvailable,
  rateRefilledAt: backupStorageSessions.rateRefilledAt,
  jobId: backupStorageSessions.jobId,
  reservationSnapshotId: backupStorageSessions.reservationSnapshotId,
  reservationGeneration: backupStorageSessions.reservationGeneration,
  urlHorizonAt: backupStorageSessions.urlHorizonAt,
  conditionalWrites: backupStorageSessions.conditionalWrites,
  readOnly: backupStorageSessions.readOnly,
  resumedAt: backupStorageSessions.resumedAt,
});

export const drizzleBrokeredReadStore: BrokeredReadStore = {
  async loadDevice(deviceId) {
    const [row] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        backupReadProtocolVersion: devices.backupReadProtocolVersion,
        backupIntegrityProtocolVersion: devices.backupIntegrityProtocolVersion,
        agentServerUrl: devices.agentServerUrl,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    return row ?? null;
  },

  async findSnapshots({ orgId, externalSnapshotId, configId }) {
    const rows = await selectSnapshots()
      .where(and(
        eq(backupSnapshots.orgId, orgId),
        eq(backupSnapshots.snapshotId, externalSnapshotId),
        ...(configId ? [eq(backupSnapshots.configId, configId)] : []),
      ))
      .limit(2);
    return rows.map((row) => toSnapshotRow(row));
  },

  async loadSnapshotById(snapshotDbId) {
    const [row] = await selectSnapshots().where(eq(backupSnapshots.id, snapshotDbId)).limit(1);
    return row ? toSnapshotRow(row) : null;
  },

  async resolveConfig(configId, orgId) {
    return resolveBackupProviderConfig(configId, orgId);
  },

  async countIndexedFiles(snapshotDbId) {
    const [row] = await db
      .select({ n: count() })
      .from(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId));
    return Number(row?.n ?? 0);
  },

  async nextGeneration(commandId) {
    const [row] = await db
      .select({ g: max(backupStorageSessions.generation) })
      .from(backupStorageSessions)
      .where(eq(backupStorageSessions.commandId, commandId));
    return Number(row?.g ?? 0) + 1;
  },

  async insertSession(row: StorageSessionRow) {
    await db.insert(backupStorageSessions).values({
      id: row.id,
      orgId: row.orgId,
      commandId: row.commandId,
      deviceId: row.deviceId,
      sourceDeviceId: row.sourceDeviceId,
      snapshotId: row.snapshotId,
      configId: row.configId,
      storageIdentity: row.storageIdentity,
      scope: row.scope,
      controlKeys: row.controlKeys,
      useFileIndex: row.useFileIndex,
      tokenHash: row.tokenHash,
      generation: row.generation,
      maxCalls: row.maxCalls,
      maxResolvedObjects: row.maxResolvedObjects,
      expiresAt: row.expiresAt,
      deadline: row.deadline,
      rateCallsAvailable: row.rateCallsAvailable,
      rateObjectsAvailable: row.rateObjectsAvailable,
      rateRefilledAt: row.rateRefilledAt,
    });
  },

  async loadSession(sessionId) {
    const [row] = await db.select(sessionColumns()).from(backupStorageSessions).where(eq(backupStorageSessions.id, sessionId)).limit(1);
    return (row as StorageSessionRow | undefined) ?? null;
  },

  async loadCommand(commandId) {
    const [row] = await db
      .select({ status: deviceCommands.status, deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);
    return row ?? null;
  },

  async revokeSession(sessionId, reason) {
    await db
      .update(backupStorageSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(backupStorageSessions.id, sessionId), isNull(backupStorageSessions.revokedAt)));
  },

  async filterIndexedKeys(snapshotDbId, keys, boundManifestSha256) {
    if (keys.length === 0) return new Set();
    // The index's state is re-read in the same statement as its rows: rows of
    // an index being rebuilt (status 'hydrating') or rebuilt from other bytes
    // since the caller checked it never count.
    const rows = await db
      .select({ backupPath: backupSnapshotFiles.backupPath })
      .from(backupSnapshotFiles)
      .innerJoin(backupSnapshots, eq(backupSnapshots.id, backupSnapshotFiles.snapshotDbId))
      .leftJoin(backupSnapshotAttestations, eq(backupSnapshotAttestations.snapshotDbId, backupSnapshots.id))
      .where(and(
        eq(backupSnapshotFiles.snapshotDbId, snapshotDbId),
        inArray(backupSnapshotFiles.backupPath, keys),
        boundIndexCondition(boundManifestSha256),
      ));
    return new Set(rows.map((r) => r.backupPath));
  },

  async loadVerifiedOrigins(snapshotDbId, originSnapshotIds) {
    if (originSnapshotIds.length === 0) return [];
    return db
      .select({
        originSnapshotId: backupSnapshotOrigins.originSnapshotId,
        originOrgId: backupSnapshotOrigins.originOrgId,
        originDeviceId: backupSnapshotOrigins.originDeviceId,
        originStorageIdentity: backupSnapshotOrigins.originStorageIdentity,
      })
      .from(backupSnapshotOrigins)
      .where(and(
        eq(backupSnapshotOrigins.snapshotDbId, snapshotDbId),
        inArray(backupSnapshotOrigins.originSnapshotId, originSnapshotIds),
      ));
  },

  async consumeBudget(sessionId, request, now) {
    // Read-decide-write under a row lock taken in the caller's transaction (the
    // agent request context), so concurrent calls on one session serialize and
    // the buckets are never overdrawn.
    assertInTransaction('backupStorageSessionStore.consumeBudget');
    const [row] = await db
      .select({
        callCount: backupStorageSessions.callCount,
        resolvedObjectCount: backupStorageSessions.resolvedObjectCount,
        maxCalls: backupStorageSessions.maxCalls,
        maxResolvedObjects: backupStorageSessions.maxResolvedObjects,
        rateCallsAvailable: backupStorageSessions.rateCallsAvailable,
        rateObjectsAvailable: backupStorageSessions.rateObjectsAvailable,
        rateRefilledAt: backupStorageSessions.rateRefilledAt,
      })
      .from(backupStorageSessions)
      .where(and(eq(backupStorageSessions.id, sessionId), isNull(backupStorageSessions.revokedAt)))
      .limit(1)
      .for('update');
    if (!row) return null;
    const decision = evaluateStorageSessionBudget(row, request, now);
    if (decision.kind !== 'granted') return decision;
    await db
      .update(backupStorageSessions)
      .set({ ...decision.next, lastUsedAt: now })
      .where(eq(backupStorageSessions.id, sessionId));
    return decision;
  },

  async isSnapshotSealing(snapshotId) {
    return isSnapshotWriteInFlight(snapshotId);
  },

  async extendLease(sessionId, expiresAt) {
    const [row] = await db
      .update(backupStorageSessions)
      .set({
        expiresAt: sql`LEAST(${backupStorageSessions.deadline}, GREATEST(${backupStorageSessions.expiresAt}, ${expiresAt.toISOString()}::timestamptz))`,
        lastUsedAt: new Date(),
      })
      .where(and(eq(backupStorageSessions.id, sessionId), isNull(backupStorageSessions.revokedAt)))
      .returning({ expiresAt: backupStorageSessions.expiresAt });
    return row?.expiresAt ?? null;
  },
};
