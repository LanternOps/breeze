import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { auditLogs, deviceCommands, remoteSessions } from '../db/schema';
import type { RemoteConnectionIdentity } from './remoteWsOwnership';
import type { RemoteWsSharedLeaseClaim } from './remoteWsSharedLease';
import {
  getRemoteWsSharedLeaseManager,
  type DesktopFinalizationSharedState,
  type RemoteWsSharedLeaseManager,
} from './remoteWsSharedLease';
import { ensureDesktopStreamStopped } from './desktopSessionStop';
import { revokeViewerSession } from './viewerTokenRevocation';

const connectionIdentitySchema = z.object({
  connectionId: z.string().uuid(),
  generation: z.number().int().positive(),
  instanceId: z.string().uuid(),
  leaseToken: z.string().uuid(),
}).strict();

export const desktopSessionFinalizationInputSchema = z.object({
  version: z.literal(1),
  finalizationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  connection: connectionIdentitySchema,
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
  reason: z.enum([
    'client_close',
    'socket_error',
    'pong_timeout',
    'revoked',
    'setup_failed',
    'orphan_recovery',
  ]),
  terminalStatus: z.enum(['disconnected', 'failed']),
  endedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }),
  inputEvents: z.number().finite(),
  frameBytes: z.number().finite(),
}).strict();

export interface DesktopSessionFinalizationInput {
  version: 1;
  finalizationId: string;
  sessionId: string;
  connection: RemoteConnectionIdentity;
  orgId: string;
  userId: string;
  deviceId: string;
  reason:
    | 'client_close'
    | 'socket_error'
    | 'pong_timeout'
    | 'revoked'
    | 'setup_failed'
    | 'orphan_recovery';
  terminalStatus: 'disconnected' | 'failed';
  endedAt: string;
  startedAt: string;
  inputEvents: number;
  frameBytes: number;
}

export interface PersistedDesktopFinalizationIntent {
  input: DesktopSessionFinalizationInput;
  canonicalPayload: string;
  payloadSha256: string;
}

function canonicalize(input: DesktopSessionFinalizationInput): PersistedDesktopFinalizationIntent {
  const validated = desktopSessionFinalizationInputSchema.parse(input);
  const canonicalPayload = JSON.stringify(validated);
  return {
    input: validated,
    canonicalPayload,
    payloadSha256: createHash('sha256').update(canonicalPayload).digest('hex'),
  };
}

function parsePersistedSharedState(
  state: DesktopFinalizationSharedState,
): PersistedDesktopFinalizationIntent | null {
  if (!state.consistent) throw new Error('desktop finalization intent is inconsistent');
  if (state.finalizationId === null && state.canonicalPayload === null) return null;
  if (state.finalizationId === null || state.canonicalPayload === null) {
    throw new Error('desktop finalization intent is incomplete');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(state.canonicalPayload);
  } catch {
    throw new Error('desktop finalization payload is invalid');
  }
  const persisted = canonicalize(desktopSessionFinalizationInputSchema.parse(decoded));
  if (persisted.input.finalizationId !== state.finalizationId) {
    throw new Error('desktop finalization identity mismatch');
  }
  return persisted;
}

export async function persistDesktopFinalizationIntent(input: {
  finalization: DesktopSessionFinalizationInput;
  sharedOwner: RemoteWsSharedLeaseClaim;
  sharedLeases?: RemoteWsSharedLeaseManager;
}): Promise<PersistedDesktopFinalizationIntent> {
  const persisted = canonicalize(input.finalization);
  if (
    input.sharedOwner.kind !== 'desktop'
    || input.sharedOwner.sessionId !== persisted.input.sessionId
  ) {
    throw new Error('desktop finalization owner mismatch');
  }
  const manager = input.sharedLeases ?? getRemoteWsSharedLeaseManager();
  if (!manager) throw new Error('desktop finalization persistence unavailable');
  const result = await manager.writeDesktopFinalizationIntent(
    input.sharedOwner,
    persisted.input.finalizationId,
    persisted.canonicalPayload,
  );
  if (result !== 'written' && result !== 'already_written') {
    throw new Error(`desktop finalization persistence failed: ${result}`);
  }
  return persisted;
}

export async function getDesktopFinalizationIntent(
  sessionId: string,
): Promise<PersistedDesktopFinalizationIntent | null> {
  const manager = getRemoteWsSharedLeaseManager();
  if (!manager) throw new Error('desktop finalization lookup unavailable');
  return parsePersistedSharedState(await manager.observeDesktopFinalization(sessionId));
}

export async function releaseDesktopFinalizationIntent(
  sessionId: string,
  finalizationId: string,
  expectedCanonicalPayload: string,
): Promise<boolean> {
  const manager = getRemoteWsSharedLeaseManager();
  if (!manager) return false;
  return manager.releaseDesktopFinalizationIntent(
    sessionId,
    finalizationId,
    expectedCanonicalPayload,
  );
}

function clampNonnegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function finalizationFingerprint(finalizationId: string): string {
  return createHash('sha256').update(finalizationId).digest('hex').slice(0, 16);
}

export async function finalizeDesktopSessionOnce(
  unvalidatedInput: DesktopSessionFinalizationInput,
): Promise<'stop_pending' | 'finalized' | 'already_finalized'> {
  const input = desktopSessionFinalizationInputSchema.parse(unvalidatedInput);
  const stop = await ensureDesktopStreamStopped(input);
  if (stop.state === 'pending') return 'stop_pending';

  // Revocation is part of the fail-closed boundary. If Redis cannot record it,
  // finalization remains retryable and the session row is not made terminal.
  await revokeViewerSession(input.sessionId);

  const endedAt = new Date(input.endedAt);
  const startedAt = new Date(input.startedAt);
  const durationSeconds = clampNonnegativeInteger(
    (endedAt.getTime() - startedAt.getTime()) / 1000,
  );
  const inputEvents = clampNonnegativeInteger(input.inputEvents);
  const frameBytes = clampNonnegativeInteger(input.frameBytes);

  return withSystemDbAccessContext(async () => {
    const [updated] = await db
      .update(remoteSessions)
      .set({
        status: input.terminalStatus,
        endedAt,
        durationSeconds,
        bytesTransferred: BigInt(frameBytes),
        errorMessage: input.terminalStatus === 'failed' ? input.reason : null,
      })
      .where(and(
        eq(remoteSessions.id, input.sessionId),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active']),
      ))
      .returning({ id: remoteSessions.id });

    if (!updated) return 'already_finalized';

    await db.insert(auditLogs).values({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.userId,
      action: 'desktop.session.summary',
      resourceType: 'remote_session',
      resourceId: input.sessionId,
      resourceName: input.sessionId,
      details: {
        reason: input.reason,
        status: input.terminalStatus,
        durationSeconds,
        inputEvents,
        frameBytes,
        stopCommandId: stop.commandId,
        stopOutcome: stop.outcome,
        finalizationFingerprint: finalizationFingerprint(input.finalizationId),
      },
      result: 'success',
    });
    return 'finalized';
  });
}

function boundedStopState(
  result: unknown,
  input: DesktopSessionFinalizationInput,
): 'pending' | 'confirmed' {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'pending';
  const value = result as Record<string, unknown>;
  if (value.status !== 'completed' || typeof value.stdout !== 'string') return 'pending';
  try {
    const decoded = JSON.parse(value.stdout) as Record<string, unknown>;
    return (
      decoded.sessionId === input.sessionId
      && decoded.finalizationId === input.finalizationId
      && (decoded.outcome === 'stopped' || decoded.outcome === 'already_absent')
    )
      ? 'confirmed'
      : 'pending';
  } catch {
    return 'pending';
  }
}

export type DesktopFinalizationInspection =
  | {
      state: 'persisted';
      intent: PersistedDesktopFinalizationIntent;
      jobState: string | null;
      sessionStatus: string;
      stopState: 'pending' | 'confirmed';
    }
  | { state: 'orphan_candidate'; sessionId: string; sessionStatus: string }
  | { state: 'none'; sessionId: string; sessionStatus: string };

export async function inspectDesktopFinalization(
  sessionId: string,
): Promise<DesktopFinalizationInspection> {
  const [session] = await withSystemDbAccessContext(() =>
    db
      .select({ status: remoteSessions.status })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, sessionId))
      .limit(1),
  );
  if (!session) {
    return { state: 'none', sessionId, sessionStatus: 'missing' };
  }

  const intent = await getDesktopFinalizationIntent(sessionId);
  if (!intent) {
    if (['pending', 'connecting', 'active'].includes(session.status)) {
      return { state: 'orphan_candidate', sessionId, sessionStatus: session.status };
    }
    return { state: 'none', sessionId, sessionStatus: session.status };
  }

  const [{ getDesktopSessionFinalizationJobState }, commandRows] = await Promise.all([
    import('../jobs/desktopSessionFinalizationWorker'),
    withSystemDbAccessContext(() =>
      db
        .select({
          status: deviceCommands.status,
          result: deviceCommands.result,
        })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, intent.input.finalizationId))
        .limit(1),
    ),
  ]);
  return {
    state: 'persisted',
    intent,
    jobState: await getDesktopSessionFinalizationJobState(
      sessionId,
      intent.input.finalizationId,
    ),
    sessionStatus: session.status,
    stopState: boundedStopState(commandRows[0]?.result, intent.input),
  };
}

export async function reconcileDesktopFinalizationFence(input: {
  sessionId: string;
  expectedFinalizationId: string;
  operatorUserId: string;
  operatorEmail: string;
  changeTicket: string;
}): Promise<'released' | 'retained'> {
  const persisted = await getDesktopFinalizationIntent(input.sessionId);
  if (!persisted || persisted.input.finalizationId !== input.expectedFinalizationId) {
    return 'retained';
  }
  const { getDesktopSessionFinalizationJobState } = await import(
    '../jobs/desktopSessionFinalizationWorker'
  );
  const jobState = await getDesktopSessionFinalizationJobState(
    input.sessionId,
    input.expectedFinalizationId,
  );
  if (jobState && ['waiting', 'delayed', 'active', 'waiting-children'].includes(jobState)) {
    return 'retained';
  }

  const stop = await ensureDesktopStreamStopped(persisted.input);
  if (stop.state !== 'confirmed') return 'retained';
  const result = await finalizeDesktopSessionOnce(persisted.input);
  if (result === 'stop_pending') return 'retained';

  await withSystemDbAccessContext(() =>
    db.insert(auditLogs).values({
      orgId: persisted.input.orgId,
      actorType: 'user',
      actorId: input.operatorUserId,
      actorEmail: input.operatorEmail.slice(0, 255),
      action: 'desktop.session.finalization_reconciled',
      resourceType: 'remote_session',
      resourceId: input.sessionId,
      resourceName: input.sessionId,
      details: {
        changeTicket: input.changeTicket,
        payloadSha256: persisted.payloadSha256,
        finalizationFingerprint: finalizationFingerprint(input.expectedFinalizationId),
        stopCommandId: stop.commandId,
        stopOutcome: stop.outcome,
        finalizationResult: result,
      },
      result: 'success',
    }),
  );
  const released = await releaseDesktopFinalizationIntent(
    input.sessionId,
    input.expectedFinalizationId,
    persisted.canonicalPayload,
  );
  return released ? 'released' : 'retained';
}

export async function recoverDesktopFinalizationOrphan(input: {
  sessionId: string;
  trigger: 'admission' | 'background' | 'operator';
}): Promise<'not_orphaned' | 'finalized' | 'already_finalized' | 'retained'> {
  const recovery = await import('./desktopSessionOrphanRecovery');
  return recovery.recoverDesktopFinalizationOrphan(input);
}

export { canonicalize as canonicalizeDesktopFinalization };
