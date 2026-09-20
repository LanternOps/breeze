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
  backupSnapshots,
  recoveryTokens,
  type BareMetalRecoveryStatus,
} from '../db/schema';
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

export type BareMetalRecoveryRow = typeof bareMetalRecoveries.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DrDb = typeof db | DbTransaction;

export type BareMetalRecoverySource = 'route' | 'dr' | 'vm_restore';

export type BareMetalRecoveryErrorCode =
  | 'snapshot_not_found'
  | 'snapshot_not_bare_metal_restorable'
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
    })
    .from(backupSnapshots)
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

  // One non-terminal recovery per device (W04a). DR dispatch records this as
  // a failedDispatches entry rather than throwing past the group.
  const [inProgress] = await tx
    .select({ id: bareMetalRecoveries.id, status: bareMetalRecoveries.status })
    .from(bareMetalRecoveries)
    .where(
      and(
        eq(bareMetalRecoveries.deviceId, snapshot.deviceId),
        eq(bareMetalRecoveries.orgId, input.orgId),
        notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]),
      ),
    )
    .limit(1);
  if (inProgress) {
    throw new BareMetalRecoveryError('recovery_in_progress', 409, { recoveryId: inProgress.id, status: inProgress.status });
  }

  const code = generateRecoveryCode();
  const [row] = await tx
    .insert(bareMetalRecoveries)
    .values({
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
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create bare-metal recovery');
  }

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
