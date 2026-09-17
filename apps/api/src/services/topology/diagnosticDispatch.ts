import { and, eq } from 'drizzle-orm';
import {
  topologyDiagnosticCommandSchema,
  type TopologyDiagnosticCommand,
} from '@breeze/shared';
import { db } from '../../db';
import {
  devices,
  topologyCollectionSources,
  topologyDiagnosticRuns,
  topologyNodeBindings,
  topologySiteState,
} from '../../db/schema';
import {
  registerCommandRevalidation,
  type CommandRevalidationRow,
  type ClaimCancelReason,
} from '../commandClaimEligibility';
import { CommandTypes } from '../commandTypes';

/**
 * Why a queued `network_diagnostic` may no longer be delivered. The transport
 * is the authenticated boundary; the plan digest is an integrity seal, never
 * authorization on its own, so every one of these is re-derived from live rows
 * at the moment of delivery rather than read out of the payload.
 */
export type TopologyCommandAuthorityDecision =
  | { allow: true; payload: TopologyDiagnosticCommand }
  | { allow: false; reason: ClaimCancelReason };

type Reader = Pick<typeof db, 'select'>;

function deny(reason: ClaimCancelReason): TopologyCommandAuthorityDecision {
  return { allow: false, reason };
}

/**
 * Read-only delivery authority for one diagnostic command (M1 Task 15). Task 18
 * extends this with run-state transitions; nothing here writes.
 *
 * Fails closed: an unknown run, a malformed payload, a moved device, a rotated
 * producer epoch or a changed site configuration all deny delivery.
 */
export async function validateTopologyCommandAuthority(
  command: CommandRevalidationRow,
  rawPayload: unknown,
  options: { now?: Date; reader?: Reader } = {},
): Promise<TopologyCommandAuthorityDecision> {
  const now = options.now ?? new Date();
  const reader = options.reader ?? db;
  const parsed = topologyDiagnosticCommandSchema.safeParse(rawPayload);
  if (!parsed.success) return deny('scope_changed');
  const payload = parsed.data;
  if (payload.commandId !== command.id) return deny('scope_changed');
  if (now.getTime() >= Date.parse(payload.plan.deadline)) return deny('expired');

  const [run] = await reader
    .select()
    .from(topologyDiagnosticRuns)
    .where(eq(topologyDiagnosticRuns.id, payload.runId))
    .limit(1);
  // Persistence-as-future-execution is refused: a command with no live parent
  // run, or one the run no longer points at, is never delivered.
  if (
    !run ||
    run.commandId !== command.id ||
    run.attemptId !== payload.attemptId ||
    run.planDigest !== payload.planDigest ||
    !['queued', 'running'].includes(run.state) ||
    run.cancelRequestedAt !== null ||
    run.deadline.getTime() <= now.getTime()
  ) {
    return deny('scope_changed');
  }

  const origin = payload.plan.origin;
  if (origin.deviceId !== command.deviceId) return deny('scope_changed');

  const [device] = await reader
    .select({ orgId: devices.orgId, siteId: devices.siteId, agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, command.deviceId))
    .limit(1);
  if (
    !device ||
    device.orgId !== run.orgId ||
    device.siteId !== run.siteId ||
    device.siteId !== origin.siteId ||
    device.agentId !== origin.agentId ||
    run.siteId !== payload.plan.scope.siteId ||
    run.orgId !== payload.plan.scope.orgId
  ) {
    return deny('scope_changed');
  }

  const [binding] = await reader
    .select({ id: topologyNodeBindings.id })
    .from(topologyNodeBindings)
    .where(
      and(
        eq(topologyNodeBindings.orgId, run.orgId),
        eq(topologyNodeBindings.siteId, run.siteId),
        eq(topologyNodeBindings.nodeId, origin.nodeId),
        eq(topologyNodeBindings.deviceId, command.deviceId),
      ),
    )
    .limit(1);
  if (!binding || binding.id !== origin.bindingId) return deny('scope_changed');

  const [source] = await reader
    .select({
      producerEpoch: topologyCollectionSources.producerEpoch,
      revokedAt: topologyCollectionSources.revokedAt,
      orgId: topologyCollectionSources.orgId,
      siteId: topologyCollectionSources.siteId,
    })
    .from(topologyCollectionSources)
    .where(eq(topologyCollectionSources.id, origin.sourceId))
    .limit(1);
  if (
    !source ||
    source.revokedAt !== null ||
    source.producerEpoch !== origin.producerEpoch ||
    source.orgId !== run.orgId ||
    source.siteId !== run.siteId
  ) {
    return deny('scope_changed');
  }

  const [state] = await reader
    .select({ settingsRevision: topologySiteState.settingsRevision })
    .from(topologySiteState)
    .where(
      and(
        eq(topologySiteState.orgId, run.orgId),
        eq(topologySiteState.siteId, run.siteId),
      ),
    )
    .limit(1);
  if (!state || state.settingsRevision.toString() !== payload.plan.settingsRevision) {
    return deny('scope_changed');
  }

  return { allow: true, payload };
}

registerCommandRevalidation(
  CommandTypes.NETWORK_DIAGNOSTIC,
  async (tx, row) => {
    const decision = await validateTopologyCommandAuthority(row, row.payload, {
      reader: tx,
    });
    return decision.allow ? null : decision.reason;
  },
);
