/**
 * The AUTHORIZED read of a `device_commands` execution reference (#5205 W06),
 * baseline §1.2 / §2.5, spec §11.3.
 *
 * WHY THIS FILE EXISTS AT ALL. `device_commands` is deliberately NOT
 * RLS-protected — it is in `INTENTIONAL_UNSCOPED`
 * (`rls-coverage.integration.test.ts`) because the agent WS path is a
 * system-scoped command queue, and the migration that added
 * `submitted_org_id` says in so many words that the column is "PROVENANCE,
 * NOT TENANCY" and must not be reclassified. The consequence, spelled out in
 * baseline §1.2, is that the app-layer device/org check **is the whole
 * authorization boundary**. A stored `(kind, id)` pair on an operation row is
 * a pointer, never an authorization. So every read of one goes through here,
 * and NEVER through a bare `db.select().from(deviceCommands)`.
 *
 * WHY NOT CALL THE ROUTE. `GET /devices/:id/commands/:commandId`
 * (`routes/devices/commands.ts`) is route-only: its org/site check is inline
 * in the handler and is not factored into anything a service can call. The
 * coordinator is also not a user — it has no `UserPermissions` and no session
 * — so the two halves of that handler's check are not equally applicable:
 *
 *  - The ORG check IS applicable and is reproduced here, tightened: rather
 *    than `getDeviceWithOrgCheck`'s accessible-org list, this reads the
 *    device under the TASK'S OWN org RLS context, so Postgres itself refuses
 *    a device outside the task's tenant. That is strictly stronger than the
 *    route's app-layer comparison, and it is the boundary that matters for a
 *    machine principal.
 *  - The SITE check is NOT applicable and is deliberately not reproduced. Site
 *    restriction is a USER-facing visibility rule: AI agent runs are not
 *    site-filtered anywhere today (baseline C15 — `routes/aiAgents.ts` has no
 *    `allowedSiteIds`/`canAccessSite` reference at all, while
 *    `routes/devices/core.ts` does), and inventing one here for the
 *    coordinator would be new, untested behaviour diverging from every other
 *    agent read path. Site-restricted VIEWS of task evidence are spec §11's
 *    explicitly-named new work, enforced on the read routes (W07/W08), not in
 *    the coordinator.
 *
 * The returned shape is the sanitized history projection, the same one the
 * route returns, so no raw stdout beyond what `sanitizeCommandForHistory`
 * permits can reach a task checkpoint or an event.
 */

import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { devices, deviceCommands } from '../../db/schema/devices';
import { sanitizeCommandForHistory } from '../commandAudit';

/**
 * What the coordinator is allowed to learn about a dispatched device command.
 *
 * `status` is `device_commands.status`; `resultStatus` is the AGENT's own
 * `result.status`, which is the field that distinguishes a genuine failure
 * from a server-side timeout that is still open to a late result
 * (`SERVER_TIMEOUT_RESULT_STATUS`, `commandResultAcceptance.ts:47`).
 */
export interface DeviceCommandEvidence {
  commandId: string;
  deviceId: string;
  type: string;
  status: string;
  /** `result.status` as written by the agent or a server-side timeout writer. */
  resultStatus: string | null;
  completedAt: Date | null;
  createdAt: Date;
  /** Sanitized projection — never the raw jsonb. */
  sanitized: Record<string, unknown>;
}

export type ReadDeviceCommandOutcome =
  | { ok: true; evidence: DeviceCommandEvidence }
  /** The device is not in this org (moved, deleted, or never was). */
  | { ok: false; reason: 'device_not_in_org' }
  /** The device is in this org but the command row is gone or belongs to
   *  another device — evidence erased (spec §11.3's adapter contract). */
  | { ok: false; reason: 'evidence_erased' };

/**
 * Read one device command as evidence for a task in `orgId`.
 *
 * Two contexts on purpose, and NEITHER is held across the other:
 *  1. the device ownership probe runs under the TASK'S org context, so RLS
 *     enforces tenancy rather than an `if`;
 *  2. the `device_commands` read runs system-scoped, because the table has no
 *     RLS to enforce anything — step 1 is what authorized it, and the read is
 *     pinned to `(commandId, deviceId)` so it cannot drift to another device.
 *
 * `runOutsideDbContext` sits between them because a caller may already hold an
 * ambient context (#1105): nesting a second one would pin two pooled
 * connections for one read, which is the hang this codebase has already paid
 * for once at concurrency >= pool size.
 */
export async function readDeviceCommandEvidence(args: {
  orgId: string;
  deviceId: string;
  commandId: string;
}): Promise<ReadDeviceCommandOutcome> {
  const { orgId, deviceId, commandId } = args;

  const owned = await runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      async () => {
        const [row] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1);
        return row ?? null;
      },
    ));

  if (!owned) return { ok: false, reason: 'device_not_in_org' };

  const command = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(deviceCommands)
        .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, deviceId)))
        .limit(1);
      return row ?? null;
    }));

  if (!command) return { ok: false, reason: 'evidence_erased' };

  const result = command.result as { status?: unknown } | null;
  const resultStatus = result && typeof result.status === 'string' ? result.status : null;

  return {
    ok: true,
    evidence: {
      commandId: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      resultStatus,
      completedAt: command.completedAt ?? null,
      createdAt: command.createdAt,
      // `allowRawStdout: false` — the route passes true because a human is
      // reading a capture_pprof artifact; nothing here is displayed to a
      // human and everything here may be persisted, so take the tighter
      // projection.
      sanitized: sanitizeCommandForHistory(command, { allowRawStdout: false }) as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Map a device command's persisted state onto the adapter's `ObserveResult`
 * vocabulary (baseline §1.1).
 *
 * The three-clock rule (baseline §2.6) lives here: the tool waits 30 s, the
 * command reaps at 5 min. Between those two a `failed` row carrying
 * `result.status = 'timeout'` is NOT a finished failure — it is a live
 * command that `commandAcceptsAgentResultCondition` deliberately keeps open
 * to a genuine late agent result. Reporting it as `finished/failed` would let
 * the task conclude "the restart failed" while the service was in fact coming
 * up, which is the exact false verdict spec §8.1 forbids.
 */
export function classifyDeviceCommandEvidence(
  evidence: DeviceCommandEvidence,
): { state: 'pending' } | { state: 'finished'; outcome: 'succeeded' | 'failed' } | { state: 'unknown'; reason: string } {
  if (evidence.resultStatus === 'timeout') {
    // Server-side timeout: provisional, still reconcilable. Never terminal.
    return { state: 'unknown', reason: 'server_timeout_awaiting_agent_result' };
  }
  if (evidence.status === 'completed' || evidence.resultStatus === 'completed') {
    return { state: 'finished', outcome: 'succeeded' };
  }
  if (evidence.status === 'failed' || evidence.resultStatus === 'failed') {
    return { state: 'finished', outcome: 'failed' };
  }
  if (evidence.status === 'cancelled') {
    return { state: 'finished', outcome: 'failed' };
  }
  if (evidence.status === 'pending' || evidence.status === 'sent' || evidence.status === 'running') {
    return { state: 'pending' };
  }

  // A status this module has not been taught. Treated as still-in-flight,
  // which is the SAFE default (it cannot fabricate a result), and bounded by
  // the recipe's unknown-effect horizon so it cannot strand a task. But it is
  // logged rather than silently absorbed: a new terminal `device_commands`
  // status added elsewhere would otherwise read as "in flight" for the whole
  // horizon, with nothing anywhere pointing at the real cause.
  console.warn('[aiOperator] unrecognized device_commands status; treating as pending', {
    commandId: evidence.commandId, status: evidence.status, resultStatus: evidence.resultStatus,
  });
  return { state: 'pending' };
}
