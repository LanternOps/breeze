import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, remoteSessions } from '../db/schema';
import {
  getRemoteWsSharedLeaseManager,
  REMOTE_WS_SHARED_LEASE_TTL_MS,
} from './remoteWsSharedLease';
import {
  canonicalizeDesktopFinalization,
  finalizeDesktopSessionOnce,
  releaseDesktopFinalizationIntent,
  type DesktopSessionFinalizationInput,
} from './desktopSessionFinalization';
import {
  enqueueDesktopSessionFinalization,
} from '../jobs/desktopSessionFinalizationWorker';

export interface DesktopOrphanSession {
  id: string;
  /**
   * Session type from the remote_sessions row. Orphan recovery is a
   * DESKTOP-ONLY mechanism: it observes the desktop lease keyspace
   * (`remote:ws:{desktop:<id>}:*`), so a live terminal session always looks
   * "absent" to it and would be falsely finalized (revoking its viewer
   * session ~30-60s after it goes active — issue #2871). Every entry point
   * must refuse non-desktop rows.
   */
  type: string;
  deviceId: string;
  orgId: string;
  userId: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
}

export interface DesktopOrphanRecoveryDependencies {
  now(): number;
  setNow?(value: number): void;
  loadSession(sessionId: string): Promise<DesktopOrphanSession | null>;
  observeSharedState(sessionId: string): Promise<{
    ownerPresent: boolean;
    finalizationId: string | null;
    canonicalPayload: string | null;
    consistent: boolean;
  }>;
  findExistingStopIdentity(
    session: DesktopOrphanSession,
  ): Promise<{ finalizationId: string } | 'conflict' | null>;
  claimOrphanIntent(
    input: DesktopSessionFinalizationInput,
  ): Promise<'claimed' | 'already_owned' | 'conflict' | 'unavailable'>;
  finalize(
    input: DesktopSessionFinalizationInput,
  ): Promise<'stop_pending' | 'finalized' | 'already_finalized'>;
  releaseIntent(
    sessionId: string,
    finalizationId: string,
    canonicalPayload: string,
  ): Promise<boolean>;
  enqueue(input: {
    sessionId: string;
    finalizationId: string;
  }): Promise<{ acknowledged: true; jobId: string }>;
  randomUUID(): string;
}

type Trigger = 'admission' | 'background' | 'operator';
type RecoveryResult = 'not_orphaned' | 'finalized' | 'already_finalized' | 'retained';

export function createDesktopSessionOrphanRecoveryService(
  deps: DesktopOrphanRecoveryDependencies,
) {
  const firstAbsentObservation = new Map<string, number>();

  async function drivePersistedIntent(
    input: DesktopSessionFinalizationInput,
    canonicalPayload: string,
  ): Promise<RecoveryResult> {
    const result = await deps.finalize(input);
    if (result === 'stop_pending') {
      await deps.enqueue({
        sessionId: input.sessionId,
        finalizationId: input.finalizationId,
      });
      return 'retained';
    }
    if (!await deps.releaseIntent(
      input.sessionId,
      input.finalizationId,
      canonicalPayload,
    )) {
      await deps.enqueue({
        sessionId: input.sessionId,
        finalizationId: input.finalizationId,
      });
      return 'retained';
    }
    return result;
  }

  return {
    async recover(sessionId: string, _trigger: Trigger): Promise<RecoveryResult> {
      const session = await deps.loadSession(sessionId);
      if (!session || !['pending', 'connecting', 'active'].includes(session.status)) {
        firstAbsentObservation.delete(sessionId);
        return 'not_orphaned';
      }
      // Never treat a non-desktop session as a desktop orphan. Terminal (and
      // any future non-desktop) sessions keep their lease under a different
      // keyspace, so the desktop observation below is vacuously "absent" for
      // them and, unguarded, a healthy live terminal session gets claimed and
      // finalized (viewer session revoked) within two scan intervals (#2871).
      if (session.type !== 'desktop') {
        firstAbsentObservation.delete(sessionId);
        return 'not_orphaned';
      }
      if (
        session.status === 'pending'
        && deps.now() - session.createdAt.getTime() < 90_000
      ) {
        firstAbsentObservation.delete(sessionId);
        return 'not_orphaned';
      }

      const observed = await deps.observeSharedState(sessionId);
      if (!observed.consistent || observed.ownerPresent) {
        firstAbsentObservation.delete(sessionId);
        return 'retained';
      }
      if (
        observed.finalizationId !== null
        || observed.canonicalPayload !== null
      ) {
        firstAbsentObservation.delete(sessionId);
        if (
          observed.finalizationId === null
          || observed.canonicalPayload === null
        ) {
          return 'retained';
        }
        try {
          const persisted = canonicalizeDesktopFinalization(
            JSON.parse(observed.canonicalPayload) as DesktopSessionFinalizationInput,
          );
          if (
            persisted.input.finalizationId !== observed.finalizationId
            || persisted.input.sessionId !== session.id
            || persisted.input.deviceId !== session.deviceId
            || persisted.input.orgId !== session.orgId
            || persisted.input.userId !== session.userId
            || persisted.canonicalPayload !== observed.canonicalPayload
          ) {
            return 'retained';
          }
          return drivePersistedIntent(
            persisted.input,
            persisted.canonicalPayload,
          );
        } catch {
          return 'retained';
        }
      }

      const first = firstAbsentObservation.get(sessionId);
      if (first === undefined) {
        firstAbsentObservation.set(sessionId, deps.now());
        return 'retained';
      }
      if (deps.now() - first < REMOTE_WS_SHARED_LEASE_TTL_MS) return 'retained';

      // Re-load after the full lease interval. A row that became terminal is
      // never claimed as an orphan.
      const current = await deps.loadSession(sessionId);
      if (
        !current
        || current.type !== 'desktop'
        || !['pending', 'connecting', 'active'].includes(current.status)
      ) {
        firstAbsentObservation.delete(sessionId);
        return 'not_orphaned';
      }

      const existingStop = await deps.findExistingStopIdentity(current);
      if (existingStop === 'conflict') return 'retained';
      const finalizationId = existingStop?.finalizationId ?? deps.randomUUID();
      const startedAt = (current.startedAt ?? current.createdAt).toISOString();
      const input: DesktopSessionFinalizationInput = {
        version: 1,
        finalizationId,
        sessionId,
        connection: {
          connectionId: finalizationId,
          generation: 1,
          instanceId: finalizationId,
          leaseToken: finalizationId,
        },
        orgId: current.orgId,
        userId: current.userId,
        deviceId: current.deviceId,
        reason: 'orphan_recovery',
        terminalStatus: 'failed',
        endedAt: new Date(deps.now()).toISOString(),
        startedAt,
        inputEvents: 0,
        frameBytes: 0,
      };
      const claim = await deps.claimOrphanIntent(input);
      if (claim !== 'claimed') return 'retained';

      firstAbsentObservation.delete(sessionId);
      const canonicalPayload =
        canonicalizeDesktopFinalization(input).canonicalPayload;
      return drivePersistedIntent(input, canonicalPayload);
    },
  };
}

let productionService: ReturnType<
  typeof createDesktopSessionOrphanRecoveryService
> | null = null;
let recoveryInterval: ReturnType<typeof setInterval> | null = null;
let orphanScanCursor: string | null = null;

function getProductionService() {
  if (productionService) return productionService;
  productionService = createDesktopSessionOrphanRecoveryService({
    now: () => Date.now(),
    loadSession: async (sessionId) => {
      const [row] = await withSystemDbAccessContext(() =>
        db
          .select({
            id: remoteSessions.id,
            type: remoteSessions.type,
            deviceId: remoteSessions.deviceId,
            orgId: remoteSessions.orgId,
            userId: remoteSessions.userId,
            status: remoteSessions.status,
            startedAt: remoteSessions.startedAt,
            createdAt: remoteSessions.createdAt,
          })
          .from(remoteSessions)
          .where(eq(remoteSessions.id, sessionId))
          .limit(1),
      );
      return row ?? null;
    },
    observeSharedState: async (sessionId) => {
      const manager = getRemoteWsSharedLeaseManager();
      if (!manager) throw new Error('desktop orphan observation unavailable');
      const observed = await manager.observeDesktopFinalization(sessionId);
      return {
        ownerPresent: observed.ownerPresent,
        finalizationId: observed.finalizationId,
        canonicalPayload: observed.canonicalPayload,
        consistent: observed.consistent,
      };
    },
    findExistingStopIdentity: async (session) => {
      const rows = await withSystemDbAccessContext(() =>
        db
          .select({
            id: deviceCommands.id,
            payload: deviceCommands.payload,
          })
          .from(deviceCommands)
          .where(and(
            eq(deviceCommands.deviceId, session.deviceId),
            eq(deviceCommands.type, 'desktop_stream_stop'),
            eq(deviceCommands.targetRole, 'agent'),
            sql`${deviceCommands.payload} ->> 'sessionId' = ${session.id}`,
          ))
          .limit(2),
      );
      if (rows.length > 1) return 'conflict';
      const row = rows[0];
      if (!row) return null;
      if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
        return 'conflict';
      }
      const payload = row.payload as Record<string, unknown>;
      if (
        Object.keys(payload).length !== 2
        || payload.sessionId !== session.id
        || payload.finalizationId !== row.id
      ) {
        return 'conflict';
      }
      return { finalizationId: row.id };
    },
    claimOrphanIntent: async (input) => {
      const manager = getRemoteWsSharedLeaseManager();
      if (!manager) return 'unavailable';
      const persisted = canonicalizeDesktopFinalization(input);
      return manager.claimDesktopOrphan(
        input.sessionId,
        input.finalizationId,
        persisted.canonicalPayload,
      );
    },
    finalize: finalizeDesktopSessionOnce,
    releaseIntent: releaseDesktopFinalizationIntent,
    enqueue: enqueueDesktopSessionFinalization,
    randomUUID,
  });
  return productionService;
}

export async function recoverDesktopFinalizationOrphan(input: {
  sessionId: string;
  trigger: 'admission' | 'background' | 'operator';
}): Promise<'not_orphaned' | 'finalized' | 'already_finalized' | 'retained'> {
  return getProductionService().recover(input.sessionId, input.trigger);
}

async function scanDesktopSessionOrphans(): Promise<void> {
  const cursor = orphanScanCursor;
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: remoteSessions.id })
      .from(remoteSessions)
      .where(and(
        // Desktop-only: this scanner recovers desktop finalization orphans.
        // Sweeping other session types here is what killed every live
        // terminal session at ~60s (#2871).
        eq(remoteSessions.type, 'desktop'),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active']),
        cursor === null ? undefined : gt(remoteSessions.id, cursor),
      ))
      .orderBy(asc(remoteSessions.id))
      .limit(50),
  );
  orphanScanCursor = nextScanCursor(rows.map(row => row.id), 50);
  for (const row of rows) {
    await recoverDesktopFinalizationOrphan({
      sessionId: row.id,
      trigger: 'background',
    });
  }
}

function nextScanCursor(ids: string[], batchSize: number): string | null {
  return ids.length === batchSize ? ids[ids.length - 1] ?? null : null;
}

async function initializeWithScan(scan: () => Promise<void>): Promise<void> {
  if (!recoveryInterval) {
    recoveryInterval = setInterval(() => {
      void scan().catch((error) => {
        console.error('[desktopSessionOrphanRecovery] background scan failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
    }, REMOTE_WS_SHARED_LEASE_TTL_MS);
  }
  try {
    await scan();
  } catch (error) {
    console.error('[desktopSessionOrphanRecovery] initial scan failed; retry scheduled', {
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

export async function initializeDesktopSessionOrphanRecovery(): Promise<void> {
  await initializeWithScan(scanDesktopSessionOrphans);
}

export async function shutdownDesktopSessionOrphanRecovery(): Promise<void> {
  if (recoveryInterval) clearInterval(recoveryInterval);
  recoveryInterval = null;
  orphanScanCursor = null;
}

export const __desktopSessionOrphanRecoveryTestOnly = {
  nextScanCursor,
  initializeWithScan,
  shutdown: shutdownDesktopSessionOrphanRecovery,
};
