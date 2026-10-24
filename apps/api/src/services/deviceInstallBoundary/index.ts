/**
 * The install incarnation boundary (#8318 wave 1a, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md §5).
 *
 * When a reattach hands an existing device row to a NEW agent install, the
 * row's history, membership and configuration survive, but nothing that was
 * executing on, granted to, or cached about the OLD install may carry over:
 * "configuration survives, instances of work and grants do not" (§5). This
 * service advances `devices.install_incarnation` from n to n+1 and runs every
 * handler, in ONE transaction — the caller's.
 *
 * Nothing calls it in production yet. Wave 1b's `rebind-confirm` runs it as
 * step 3 of the confirm's effects (§6.4), after taking its locks; until then
 * the boundary is exercised only by its contract and integration tests.
 *
 * Contract:
 *  - Call it inside `withSystemDbAccessContext` (asserted). Several of the
 *    tables it writes are RLS-scoped by org or partner, and a narrower context
 *    would silently miss rows. Every write goes through the ambient `db`, so it
 *    joins the caller's transaction; post-commit teardown is registered with
 *    `runAfterDbContextCommit` and is dropped on rollback.
 *  - It locks the device row `FOR UPDATE` first and refuses unless the row's
 *    incarnation is still `expectedIncarnation` (the version the human
 *    authorized). A caller that already holds the lock re-takes it for free.
 *  - The device row is advanced FIRST, so anything enqueued later in the
 *    transaction (or by an insert that waited behind the row lock) is stamped
 *    for the new install; the command handler then cancels exactly the
 *    earlier incarnations' open rows.
 *
 * The §5.8 enforcement lives beside it: `classification.ts` (every table that
 * references a device, by FK or by a curated FK-less column, is classified,
 * checked against the live schema by an integration contract test) and
 * `orgMoveParity.ts` (every device-bound write of the org move has a boundary
 * counterpart or is move-only, checked statically).
 */
import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { backupRecoveryHandler } from './handlers/backup';
import { commandsHandler } from './handlers/commands';
import { deviceRowHandler } from './handlers/deviceRow';
import { grantsHandler } from './handlers/grants';
import { installStateHandler } from './handlers/installState';
import { pamHandler } from './handlers/pam';
import { sessionsHandler } from './handlers/sessions';
import { workInFlightHandler } from './handlers/workInFlight';
import type { BoundaryContext, BoundaryCounts, BoundaryHandler, BoundaryHandlerId } from './types';

export * from './types';

/**
 * Every handler, in execution order. The device row goes first (see above);
 * the commands go next, so their propagation settles the records that own
 * them before any handler below looks at those records.
 */
export const INSTALL_BOUNDARY_HANDLERS: readonly BoundaryHandler[] = [
  deviceRowHandler,
  commandsHandler,
  pamHandler,
  backupRecoveryHandler,
  grantsHandler,
  sessionsHandler,
  workInFlightHandler,
  installStateHandler,
];

export interface InstallBoundaryInput {
  deviceId: string;
  /** The incarnation the reattach was authorized against; the boundary refuses if the row moved on. */
  expectedIncarnation: number;
  /** The human who authorized the reattach. Null = the system. */
  actorUserId: string | null;
  /** Override for tests; defaults to now. */
  at?: Date;
}

export interface InstallBoundaryResult {
  deviceId: string;
  previousIncarnation: number;
  newIncarnation: number;
  incarnationStartedAt: Date;
  /** What each handler invalidated — the counts the wave 1b ledger records (§4.4). */
  counts: Record<BoundaryHandlerId, BoundaryCounts>;
}

export class InstallBoundaryRefusedError extends Error {
  constructor(
    readonly code: 'device_not_found' | 'incarnation_changed',
    message: string,
  ) {
    super(message);
    this.name = 'InstallBoundaryRefusedError';
  }
}

export async function runInstallIncarnationBoundary(input: InstallBoundaryInput): Promise<InstallBoundaryResult> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('runInstallIncarnationBoundary must run inside withSystemDbAccessContext');
  }

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      installIncarnation: devices.installIncarnation,
      ownershipEpoch: devices.ownershipEpoch,
    })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1)
    .for('update');
  if (!device) {
    throw new InstallBoundaryRefusedError('device_not_found', `device ${input.deviceId} not found`);
  }
  if (device.installIncarnation !== input.expectedIncarnation) {
    throw new InstallBoundaryRefusedError(
      'incarnation_changed',
      `device ${input.deviceId} is at incarnation ${device.installIncarnation}, expected ${input.expectedIncarnation}`,
    );
  }

  const ctx: BoundaryContext = {
    deviceId: device.id,
    orgId: device.orgId,
    ownershipEpoch: device.ownershipEpoch,
    previousIncarnation: device.installIncarnation,
    newIncarnation: device.installIncarnation + 1,
    at: input.at ?? new Date(),
    actorUserId: input.actorUserId,
  };

  const counts = {} as Record<BoundaryHandlerId, BoundaryCounts>;
  for (const handler of INSTALL_BOUNDARY_HANDLERS) {
    counts[handler.id] = await handler.run(ctx);
  }

  return {
    deviceId: ctx.deviceId,
    previousIncarnation: ctx.previousIncarnation,
    newIncarnation: ctx.newIncarnation,
    incarnationStartedAt: ctx.at,
    counts,
  };
}
