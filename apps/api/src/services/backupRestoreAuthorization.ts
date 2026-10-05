/**
 * Durable authorizations for restoring a snapshot without a usable attestation
 * (services/backupRestoreGate.ts decides when one is needed).
 *
 * A technician confirms such a restore with a two-factor step-up grant for
 * operation `backup_unattested_restore`, bound by resource digest to exactly
 * one (snapshot, target device, command type). The route consumes the grant
 * and then records the authorization: the `backup_restore_authorizations` row
 * and its audit event (`backup.restore.unattested_override`) are inserted in
 * ONE transaction, so an authorization never exists without its audit record,
 * and a failed audit write leaves no authorization (and so no restore).
 *
 * The row is bound to exactly one thing that performs the restore — the id
 * reserved for the device command before it is queued, a recovery token, or a
 * bare-metal recovery. Command delivery and recovery authentication look the
 * row up by that binding and compare its tuple; a payload that merely claims
 * an override is never trusted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbTransaction } from '../db';
import { auditLogs } from '../db/schema/audit';
import { backupRestoreAuthorizations } from '../db/schema/backupRestoreAuthorizations';
import type { RestoreAuthorizationReason } from './backupRestoreGate';

export const UNATTESTED_RESTORE_AUDIT_ACTION = 'backup.restore.unattested_override';

/** One restore an authorization covers. */
export type RestoreTuple = { snapshotDbId: string; targetDeviceId: string; commandType: string };

/**
 * Canonical step-up resource digest for one unattested restore. The mint route
 * and every restore route must produce byte-identical input for the same
 * intent: keys in fixed order, ids lower-cased.
 */
export function unattestedRestoreResourceDigest(t: RestoreTuple): `sha256:${string}` {
  const canonical = JSON.stringify({
    commandType: t.commandType,
    snapshotDbId: t.snapshotDbId.toLowerCase(),
    targetDeviceId: t.targetDeviceId.toLowerCase(),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export type RestoreAuthorizationBinding =
  | { commandId: string }
  | { recoveryTokenId: string }
  | { recoveryId: string };

export type RecordRestoreAuthorizationInput = RestoreTuple & {
  orgId: string;
  reason: RestoreAuthorizationReason;
  userId: string;
  userEmail?: string | null;
  binding: RestoreAuthorizationBinding;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export interface RestoreAuthorizationWriter {
  insertAuthorization(row: typeof backupRestoreAuthorizations.$inferInsert): Promise<void>;
  insertAudit(row: typeof auditLogs.$inferInsert): Promise<void>;
  /** Run both writes atomically. */
  atomically<T>(fn: () => Promise<T>): Promise<T>;
}

const drizzleWriter: RestoreAuthorizationWriter = {
  insertAuthorization: async (row) => {
    await db.insert(backupRestoreAuthorizations).values(row);
  },
  insertAudit: async (row) => {
    await db.insert(auditLogs).values(row);
  },
  atomically: (fn) => (hasDbAccessContext() ? withDbTransaction(fn) : db.transaction(() => fn())),
};

/**
 * Records one authorization and its audit event atomically, in the caller's
 * DB context (which must grant access to `orgId`: the row and the audit row
 * are both RLS-checked against it). Call it only after the step-up grant was
 * consumed. Returns the authorization id.
 */
export async function recordRestoreAuthorization(
  input: RecordRestoreAuthorizationInput,
  writer: RestoreAuthorizationWriter = drizzleWriter,
): Promise<string> {
  const id = randomUUID();
  const resourceDigest = unattestedRestoreResourceDigest(input);
  const binding = input.binding;
  await writer.atomically(async () => {
    await writer.insertAuthorization({
      id,
      orgId: input.orgId,
      snapshotDbId: input.snapshotDbId,
      deviceId: input.targetDeviceId,
      commandType: input.commandType,
      reason: input.reason,
      authorizedByUserId: input.userId,
      resourceDigest,
      commandId: 'commandId' in binding ? binding.commandId : null,
      recoveryTokenId: 'recoveryTokenId' in binding ? binding.recoveryTokenId : null,
      recoveryId: 'recoveryId' in binding ? binding.recoveryId : null,
      auditWrittenAt: new Date(),
    });
    await writer.insertAudit({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.userId,
      actorEmail: input.userEmail ?? null,
      action: UNATTESTED_RESTORE_AUDIT_ACTION,
      resourceType: 'backup_snapshot',
      resourceId: input.snapshotDbId,
      details: {
        authorizationId: id,
        snapshotDbId: input.snapshotDbId,
        targetDeviceId: input.targetDeviceId,
        commandType: input.commandType,
        reason: input.reason,
        ...('commandId' in binding ? { commandId: binding.commandId } : {}),
        ...('recoveryTokenId' in binding ? { recoveryTokenId: binding.recoveryTokenId } : {}),
        ...('recoveryId' in binding ? { recoveryId: binding.recoveryId } : {}),
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      result: 'success',
      initiatedBy: 'manual',
    });
  });
  return id;
}

export type StoredRestoreAuthorization = {
  id: string;
  orgId: string;
  snapshotDbId: string;
  deviceId: string;
  commandType: string;
  reason: string;
};

const selectColumns = {
  id: backupRestoreAuthorizations.id,
  orgId: backupRestoreAuthorizations.orgId,
  snapshotDbId: backupRestoreAuthorizations.snapshotDbId,
  deviceId: backupRestoreAuthorizations.deviceId,
  commandType: backupRestoreAuthorizations.commandType,
  reason: backupRestoreAuthorizations.reason,
};

/** The authorization bound to a device command, in the caller's DB context. */
export async function findCommandRestoreAuthorization(commandId: string): Promise<StoredRestoreAuthorization | null> {
  const [row] = await db
    .select(selectColumns)
    .from(backupRestoreAuthorizations)
    .where(eq(backupRestoreAuthorizations.commandId, commandId))
    .limit(1);
  return row ?? null;
}

/**
 * The authorizations bound to a recovery token or to a bare-metal recovery
 * (either may be absent), in the caller's DB context.
 */
export async function findRecoveryRestoreAuthorizations(binding: {
  recoveryTokenId?: string | null;
  recoveryId?: string | null;
}): Promise<StoredRestoreAuthorization[]> {
  const conditions = [];
  if (binding.recoveryTokenId) conditions.push(eq(backupRestoreAuthorizations.recoveryTokenId, binding.recoveryTokenId));
  if (binding.recoveryId) conditions.push(eq(backupRestoreAuthorizations.recoveryId, binding.recoveryId));
  if (conditions.length === 0) return [];
  return db
    .select(selectColumns)
    .from(backupRestoreAuthorizations)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(10);
}

/** True when `auth` authorizes exactly `tuple` (any of `commandTypes`). */
export function authorizationCovers(
  auth: StoredRestoreAuthorization | null | undefined,
  tuple: { snapshotDbId: string; targetDeviceId: string; commandTypes: readonly string[] },
): auth is StoredRestoreAuthorization {
  return !!auth
    && auth.snapshotDbId === tuple.snapshotDbId
    && auth.deviceId === tuple.targetDeviceId
    && tuple.commandTypes.includes(auth.commandType);
}
