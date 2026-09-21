// Bare-metal recovery W05a: create / mint / cancel / reissue-code for
// `bare_metal_recoveries`, extracted from the W04a create route so DR plans
// and Restore-as-VM can create recoveries without HTTP. Callers authorize
// first (`authorizeRouteResilienceResources` in routes, the DR authorization
// pass in drExecutionService); every function here takes an already-authorized
// `orgId` and scopes every read and write by it. See
// docs/superpowers/plans/backup/2026-09-18-bare-metal-w05-restore-as-vm-dr-plans.md Task 4.
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db';
import {
  BARE_METAL_RECOVERY_TERMINAL,
  bareMetalRecoveries,
  backupJobs,
  backupSnapshots,
  recoveryTokens,
  type BareMetalRecoveryStatus,
} from '../db/schema';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { createAuditLogAsync } from './auditService';
import {
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryNonce,
  hashRecoveryCode,
  hashRecoveryNonce,
  RECOVERY_CODE_TTL_MS,
} from './bareMetalRecoveryCodes';
import { generateRecoveryToken, hashRecoveryToken } from './recoveryBootstrap';
import { RECOVERY_REFUSAL_MESSAGES } from './recoveryCapabilities';

export type BareMetalRecoveryRow = typeof bareMetalRecoveries.$inferSelect;

/**
 * Partial unique index on `bare_metal_recoveries (device_id)` restricted to
 * non-terminal statuses — the database-side arbiter for "one in-flight
 * recovery per device" (#6322).
 */
const DEVICE_IN_FLIGHT_CONSTRAINT = 'bare_metal_recoveries_device_in_flight_idx';
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DrDb = typeof db | DbTransaction;

export type BareMetalRecoverySource = 'route' | 'dr' | 'vm_restore';

export type BareMetalRecoveryErrorCode =
  | 'snapshot_not_found'
  | 'snapshot_not_bare_metal_restorable'
  | 'snapshot_storage_identity_unknown'
  | 'recovery_in_progress'
  | 'recovery_not_found'
  | 'invalid_state';

export class BareMetalRecoveryError extends Error {
  constructor(
    public code: BareMetalRecoveryErrorCode,
    public status: 404 | 409,
    public details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'BareMetalRecoveryError';
  }
}

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const RECOVERY_TOKEN_TTL_MS = 24 * 3600 * 1000;
/** Statuses from which the one-time code can still be rotated: the helper has
 * not authenticated yet (`created`) or has only just exchanged the previous
 * code (`media_booted`) — after `planned` the token, not the code, is live. */
const REISSUABLE_STATUSES: ReadonlySet<BareMetalRecoveryStatus> = new Set(['created', 'media_booted']);

function audit(input: {
  orgId: string;
  actorId: string | null;
  action: string;
  recoveryId: string;
  details: Record<string, unknown>;
  result?: 'success' | 'failure';
}): void {
  void createAuditLogAsync({
    orgId: input.orgId,
    actorType: input.actorId ? 'user' : 'system',
    actorId: input.actorId ?? SYSTEM_ACTOR_ID,
    action: input.action,
    resourceType: 'bare_metal_recovery',
    resourceId: input.recoveryId,
    result: input.result ?? 'success',
    details: input.details,
  }).catch(() => {
    // Already retried + Sentry-captured inside createAuditLogAsync.
  });
}

async function loadRecovery(tx: DrDb, recoveryId: string, orgId: string): Promise<BareMetalRecoveryRow> {
  const [row] = await tx
    .select()
    .from(bareMetalRecoveries)
    .where(and(eq(bareMetalRecoveries.id, recoveryId), eq(bareMetalRecoveries.orgId, orgId)))
    .limit(1);
  if (!row) throw new BareMetalRecoveryError('recovery_not_found', 404);
  return row;
}

/**
 * W09 (#6464) preflight, replacing the #6469 hard refusal. A referenced
 * snapshot (referenced_files > 0) is no longer refused outright at creation
 * — token-mode recovery CAN follow cross-snapshot references once the server
 * has a verified-complete file index (Task 3/5). The only thing still
 * refused HERE, before any row is written, is a snapshot whose storage
 * identity is unknown (fail closed — Part 0 §0 "storage identity"): without
 * it hydration cannot even verify which physical bucket/path the referenced
 * objects live under. A known identity enqueues hydration (idempotent,
 * dedupe-keyed) and lets creation proceed; the ACTUAL authorization gate is
 * the authenticate/exchange negotiation (recoveryCapabilities.ts) and the
 * per-object download check (recoveryDownloadService.ts, Task 6) — this
 * function only prevents starting a recovery that can NEVER succeed.
 */
export async function externalReferencePreflight(input: {
  referencedFiles: number | null | undefined;
  snapshotDbId: string;
  storageIdentity?: string | null;
}): Promise<BareMetalRecoveryError | null> {
  if (typeof input.referencedFiles !== 'number' || input.referencedFiles <= 0) return null;
  if (!input.storageIdentity) {
    return new BareMetalRecoveryError('snapshot_storage_identity_unknown', 409, {
      referencedFiles: input.referencedFiles,
      snapshotId: input.snapshotDbId,
      reasons: [RECOVERY_REFUSAL_MESSAGES.snapshot_storage_identity_unknown],
    });
  }
  const { enqueueSnapshotFileIndexHydration } = await import('../jobs/backupSnapshotFileIndexWorker');
  await enqueueSnapshotFileIndexHydration(input.snapshotDbId, 'recovery_create');
  return null;
}

/** The device's current non-terminal recovery, if any. */
async function findInFlightRecovery(
  tx: DrDb,
  deviceId: string,
  orgId: string,
): Promise<{ id: string; status: BareMetalRecoveryStatus } | undefined> {
  const [row] = await tx
    .select({ id: bareMetalRecoveries.id, status: bareMetalRecoveries.status })
    .from(bareMetalRecoveries)
    .where(
      and(
        eq(bareMetalRecoveries.deviceId, deviceId),
        eq(bareMetalRecoveries.orgId, orgId),
        notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]),
      ),
    )
    .limit(1);
  return row;
}

function recoveryInProgressError(
  winner: { id: string; status: BareMetalRecoveryStatus } | undefined,
): BareMetalRecoveryError {
  // `winner` is undefined only if the row that beat us reached a terminal
  // status between the 23505 and this read. The 409 still stands for this
  // attempt — the caller retries and wins the next one — but the details
  // cannot name the blocker, so say so rather than emitting an anonymous 409.
  if (!winner) {
    console.warn(
      '[bareMetalRecoveryService] one-in-flight conflict resolved to an already-terminal row; '
      + 'returning recovery_in_progress without a blocking recovery id',
    );
  }
  return new BareMetalRecoveryError('recovery_in_progress', 409, {
    recoveryId: winner?.id ?? null,
    status: winner?.status ?? null,
  });
}

/**
 * Insert the recovery row, letting the database settle the one-in-flight race
 * (#6322).
 *
 * The insert runs in a NESTED transaction so drizzle emits a SAVEPOINT when a
 * request transaction is already open: a 23505 then rolls back to the
 * savepoint and leaves the caller's transaction usable. Catching the violation
 * on a bare statement instead would abort the enclosing transaction and turn
 * every later statement into a 25P02 — the trap that produced the repeat 500s
 * in the network-proxy incident.
 */
async function insertRecoveryRow(
  tx: DrDb,
  values: typeof bareMetalRecoveries.$inferInsert,
  deviceId: string,
  orgId: string,
): Promise<BareMetalRecoveryRow> {
  let row: BareMetalRecoveryRow | undefined;
  try {
    row = await (tx as typeof db).transaction(async (inner) => {
      const [inserted] = await inner.insert(bareMetalRecoveries).values(values).returning();
      return inserted;
    });
  } catch (error) {
    if (isPgUniqueViolation(error, DEVICE_IN_FLIGHT_CONSTRAINT)) {
      throw recoveryInProgressError(await findInFlightRecovery(tx, deviceId, orgId));
    }
    throw error;
  }
  if (!row) {
    throw new Error('Failed to create bare-metal recovery');
  }
  return row;
}

export async function createBareMetalRecovery(input: {
  orgId: string;
  snapshotId: string;
  identity: 'original' | 'new';
  createdBy: string | null;
  source: BareMetalRecoverySource;
  /** The rebuild host for engine-driven recoveries; NULL for boot media. */
  executingDeviceId?: string | null;
  drExecutionId?: string | null;
  drGroupId?: string | null;
  target?: Record<string, unknown> | null;
  tx?: DrDb;
}): Promise<{ row: BareMetalRecoveryRow; code: string }> {
  const tx = input.tx ?? db;

  const [snapshot] = await tx
    .select({
      id: backupSnapshots.id,
      deviceId: backupSnapshots.deviceId,
      bareMetalRestorable: backupSnapshots.bareMetalRestorable,
      bareMetalReasons: backupSnapshots.bareMetalReasons,
      referencedFiles: backupJobs.referencedFiles,
      storageIdentity: backupSnapshots.storageIdentity,
    })
    .from(backupSnapshots)
    .leftJoin(backupJobs, eq(backupJobs.id, backupSnapshots.jobId))
    .where(and(eq(backupSnapshots.id, input.snapshotId), eq(backupSnapshots.orgId, input.orgId)))
    .limit(1);
  if (!snapshot) {
    throw new BareMetalRecoveryError('snapshot_not_found', 404);
  }
  if (snapshot.bareMetalRestorable !== true) {
    throw new BareMetalRecoveryError('snapshot_not_bare_metal_restorable', 409, {
      reasons: snapshot.bareMetalReasons ?? ['snapshot was not assessed for bare-metal restore'],
    });
  }

  const preflight = await externalReferencePreflight({
    referencedFiles: snapshot.referencedFiles,
    snapshotDbId: snapshot.id,
    storageIdentity: snapshot.storageIdentity ?? null,
  });
  if (preflight) throw preflight;

  // One non-terminal recovery per device (W04a). DR dispatch records this as
  // a failedDispatches entry rather than throwing past the group.
  //
  // This pre-check is the fast path and the source of the friendly 409 detail,
  // but it is NOT the guard: two concurrent creators both pass it (#6322). The
  // partial unique index `bare_metal_recoveries_device_in_flight_idx` is the
  // real arbiter, and the loser's 23505 is mapped to the same error below.
  const inProgress = await findInFlightRecovery(tx, snapshot.deviceId, input.orgId);
  if (inProgress) {
    throw recoveryInProgressError(inProgress);
  }

  const code = generateRecoveryCode();
  const row = await insertRecoveryRow(tx, {
      orgId: input.orgId,
      deviceId: snapshot.deviceId,
      snapshotId: snapshot.id,
      identity: input.identity,
      codeHash: hashRecoveryCode(code),
      codeExpiresAt: new Date(Date.now() + RECOVERY_CODE_TTL_MS),
      // Placeholder until exchange, which generates and discloses the real
      // nonce exactly once — the column is NOT NULL so create needs some hash
      // here, but nothing in the system knows this placeholder's preimage, so
      // it authenticates nothing on its own.
      nonceHash: hashRecoveryNonce(generateRecoveryNonce()),
      status: 'created',
      ...(input.target ? { target: input.target } : {}),
      createdBy: input.createdBy,
      executingDeviceId: input.executingDeviceId ?? null,
      drExecutionId: input.drExecutionId ?? null,
      drGroupId: input.drGroupId ?? null,
  }, snapshot.deviceId, input.orgId);

  audit({
    orgId: input.orgId,
    actorId: input.createdBy,
    action: 'bmr.recovery.create',
    recoveryId: row.id,
    details: {
      snapshotId: snapshot.id,
      deviceId: snapshot.deviceId,
      identity: input.identity,
      source: input.source,
      ...(input.executingDeviceId ? { executingDeviceId: input.executingDeviceId } : {}),
      ...(input.drExecutionId ? { drExecutionId: input.drExecutionId } : {}),
      ...(input.drGroupId ? { drGroupId: input.drGroupId } : {}),
    },
  });

  return { row, code: formatRecoveryCode(code) };
}

/**
 * Mint a recovery token for an engine-driven recovery (no boot media, so no
 * code exchange): inserts `recovery_tokens` (`bare_metal`, 24 h,
 * `authenticated`) and links it. The status stays `created` — the helper's
 * first progress post moves it forward. The plaintext token is returned once,
 * for the command payload, and never stored.
 */
export async function mintRecoveryTokenForRecovery(input: {
  recoveryId: string;
  orgId: string;
  createdBy: string | null;
  tx?: DrDb;
}): Promise<{ token: string; tokenId: string }> {
  const tx = input.tx ?? db;
  const rec = await loadRecovery(tx, input.recoveryId, input.orgId);
  if (rec.status !== 'created' || rec.recoveryTokenId) {
    throw new BareMetalRecoveryError('invalid_state', 409, { status: rec.status, recoveryTokenId: rec.recoveryTokenId });
  }

  const now = new Date();
  const token = generateRecoveryToken();
  const [t] = await tx
    .insert(recoveryTokens)
    .values({
      orgId: input.orgId,
      deviceId: rec.deviceId,
      snapshotId: rec.snapshotId,
      tokenHash: hashRecoveryToken(token),
      restoreType: 'bare_metal',
      targetConfig: { bareMetalRecoveryId: rec.id },
      status: 'authenticated',
      authenticatedAt: now,
      createdBy: input.createdBy,
      expiresAt: new Date(now.getTime() + RECOVERY_TOKEN_TTL_MS),
    })
    .returning({ id: recoveryTokens.id });
  if (!t) {
    throw new Error('Failed to mint recovery token');
  }

  await tx
    .update(bareMetalRecoveries)
    .set({ recoveryTokenId: t.id, updatedAt: now })
    .where(and(eq(bareMetalRecoveries.id, rec.id), eq(bareMetalRecoveries.orgId, input.orgId)))
    .returning();

  return { token, tokenId: t.id };
}

/** Non-terminal → `failed` with `failureReason: 'cancelled'`, so an operator can clear a stuck rehearsal. */
export async function cancelBareMetalRecovery(input: {
  recoveryId: string;
  orgId: string;
  userId: string | null;
  reason?: string;
}): Promise<BareMetalRecoveryRow> {
  const rec = await loadRecovery(db, input.recoveryId, input.orgId);
  if (BARE_METAL_RECOVERY_TERMINAL.has(rec.status)) {
    throw new BareMetalRecoveryError('invalid_state', 409, { status: rec.status });
  }

  const now = new Date();
  const [row] = await db
    .update(bareMetalRecoveries)
    .set({ status: 'failed', failureReason: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(bareMetalRecoveries.id, rec.id),
        eq(bareMetalRecoveries.orgId, input.orgId),
        notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]),
      ),
    )
    .returning();
  if (!row) {
    // Lost the race with a terminal progress post between the read and the CAS.
    throw new BareMetalRecoveryError('invalid_state', 409, { status: rec.status });
  }

  audit({
    orgId: input.orgId,
    actorId: input.userId,
    action: 'bmr.recovery.cancel',
    recoveryId: rec.id,
    details: { from: rec.status, ...(input.reason ? { reason: input.reason } : {}) },
  });

  return row;
}

/**
 * Rotate the one-time code while status ∈ {created, media_booted}: new hash,
 * fresh 15-minute expiry, `codeUsedAt` cleared. The old code no longer
 * exchanges. Returns the new formatted code exactly once.
 */
export async function reissueRecoveryCode(input: {
  recoveryId: string;
  orgId: string;
  userId: string | null;
}): Promise<{ row: BareMetalRecoveryRow; code: string }> {
  const rec = await loadRecovery(db, input.recoveryId, input.orgId);
  if (!REISSUABLE_STATUSES.has(rec.status)) {
    throw new BareMetalRecoveryError('invalid_state', 409, { status: rec.status });
  }

  const now = new Date();
  const code = generateRecoveryCode();
  const [row] = await db
    .update(bareMetalRecoveries)
    .set({
      codeHash: hashRecoveryCode(code),
      codeExpiresAt: new Date(now.getTime() + RECOVERY_CODE_TTL_MS),
      codeUsedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(bareMetalRecoveries.id, rec.id),
        eq(bareMetalRecoveries.orgId, input.orgId),
        eq(bareMetalRecoveries.status, rec.status),
      ),
    )
    .returning();
  if (!row) {
    throw new BareMetalRecoveryError('invalid_state', 409, { status: rec.status });
  }

  audit({
    orgId: input.orgId,
    actorId: input.userId,
    action: 'bmr.recovery.reissue_code',
    recoveryId: rec.id,
    details: { status: rec.status, codeExpiresAt: row.codeExpiresAt.toISOString() },
  });

  return { row, code: formatRecoveryCode(code) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Idempotent terminal mapping from a `bare_metal_rebuild` command result to
 * the recovery row, for a rebuild host whose progress posts never reached the
 * server. The progress route stays the primary path: a row it already
 * terminalised is left untouched.
 *   completed → `validated` then `completed` (identity: new completes at validated)
 *   refused   → `refused`, failureReason = refusal
 *   failed    → `failed`,  failureReason = error
 */
export async function applyRebuildCommandResult(input: {
  recoveryId: string;
  orgId: string;
  result: Record<string, unknown>;
}): Promise<void> {
  const rec = await loadRecovery(db, input.recoveryId, input.orgId);
  if (BARE_METAL_RECOVERY_TERMINAL.has(rec.status)) return;

  const envelopeStatus = typeof input.result.status === 'string' ? input.result.status : 'failed';
  const structured = asRecord(input.result.result);
  const engineStatus = typeof structured?.status === 'string' ? structured.status : undefined;
  const refusal = typeof structured?.refusal === 'string' ? structured.refusal : undefined;
  const error =
    (typeof structured?.error === 'string' ? structured.error : undefined) ??
    (typeof input.result.error === 'string' ? input.result.error : undefined);

  const now = new Date();
  const set: Partial<typeof bareMetalRecoveries.$inferInsert> = { updatedAt: now };
  if (structured) set.result = structured;
  if (Array.isArray(structured?.warnings)) {
    set.warnings = (structured.warnings as unknown[]).filter((w): w is string => typeof w === 'string');
  }

  if (envelopeStatus === 'completed' && engineStatus !== 'refused' && engineStatus !== 'failed') {
    // The helper validated the rebuilt disk. With identity: new there is no
    // check-in to wait for; with identity: original the machine still has to
    // reboot and heartbeat, so the row parks at validated for the poller.
    set.validatedAt = rec.validatedAt ?? now;
    if (rec.identity === 'new') {
      set.status = 'completed';
      set.completedAt = now;
    } else if (!rec.validatedAt) {
      set.status = 'validated';
    } else {
      return;
    }
  } else if (engineStatus === 'refused' || refusal) {
    set.status = 'refused';
    set.failureReason = refusal ?? error ?? 'refused without reason';
  } else {
    set.status = 'failed';
    set.failureReason = error ?? (envelopeStatus === 'timeout' ? 'command timed out' : 'failed without reason');
  }

  await db
    .update(bareMetalRecoveries)
    .set(set)
    .where(
      and(
        eq(bareMetalRecoveries.id, rec.id),
        eq(bareMetalRecoveries.orgId, input.orgId),
        notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]),
      ),
    )
    .returning();
}
