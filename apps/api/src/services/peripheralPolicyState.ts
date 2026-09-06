import type {
  PeripheralDeviceIdentity,
  PeripheralPolicyEnvelopeV2,
  PeripheralPolicyV2,
} from './peripheralEffectivePolicy';
import {
  digestPeripheralEnvelope,
  loadAndResolveEffectivePeripheralPolicySetInCurrentDbContext,
} from './peripheralEffectivePolicy';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  deviceCommands,
  devices,
  peripheralPolicyDeliveryEvents,
  peripheralPolicyDeviceStates,
} from '../db/schema';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';

export type PeripheralReconcileReason =
  | 'policy_changed'
  | 'membership_changed'
  | 'clear_legacy_applied'
  | 'periodic_drift'
  | (string & {});

export type PeripheralPolicyResultV2 = {
  schemaVersion: 2;
  phase: 'clear_legacy' | 'enforce';
  revision: number;
  digest: string;
  outcome: 'applied' | 'rejected';
  reasonCode?:
    | 'wrong_identity'
    | 'lower_revision'
    | 'revision_digest_conflict'
    | 'malformed_digest'
    | 'invalid_payload'
    | 'detection_failed'
    | 'enforcement_failed'
    | 'persistence_failed';
};

export type PeripheralPolicyStateSnapshot = {
  desiredPhase: 'clear_legacy' | 'enforce';
  desiredRevision: number;
  desiredDigest: string;
  deliveryStatus: 'pending' | 'applied' | 'rejected';
  appliedPhase: 'clear_legacy' | 'enforce' | null;
  appliedRevision: number | null;
  appliedDigest: string | null;
};

type ReconciliationPlan =
  | { kind: 'coalesced' }
  | { kind: 'queued'; envelope: PeripheralPolicyEnvelopeV2 };

function buildEnvelope(input: {
  identity: PeripheralDeviceIdentity;
  effectivePolicies: readonly PeripheralPolicyV2[];
  phase: 'clear_legacy' | 'enforce';
  revision: number;
  generatedAt: string;
  reason: string;
}): PeripheralPolicyEnvelopeV2 {
  const digestInput = {
    schemaVersion: 2 as const,
    phase: input.phase,
    identity: {
      deviceId: input.identity.deviceId,
      orgId: input.identity.orgId,
      siteId: input.identity.siteId,
      groupIds: [...input.identity.groupIds].sort(),
    },
    revision: input.revision,
    effectivePolicies: [...input.effectivePolicies],
  };
  return {
    ...digestInput,
    digest: digestPeripheralEnvelope(digestInput),
    generatedAt: input.generatedAt,
    reason: input.reason,
  };
}

export function planPeripheralPolicyReconciliation(input: {
  identity: PeripheralDeviceIdentity;
  effectivePolicies: readonly PeripheralPolicyV2[];
  currentState: PeripheralPolicyStateSnapshot | null;
  generatedAt: string;
  reason: PeripheralReconcileReason;
}): ReconciliationPlan {
  const current = input.currentState;
  if (!current) {
    return {
      kind: 'queued',
      envelope: buildEnvelope({ ...input, phase: 'clear_legacy', revision: 1, effectivePolicies: [] }),
    };
  }

  const exactClearApplied = current.desiredPhase === 'clear_legacy'
    && current.deliveryStatus === 'applied'
    && current.appliedPhase === 'clear_legacy'
    && current.appliedRevision === current.desiredRevision
    && current.appliedDigest === current.desiredDigest;
  const phase = current.desiredPhase === 'clear_legacy' && !exactClearApplied
    ? 'clear_legacy'
    : 'enforce';
  const effectivePolicies = phase === 'clear_legacy' ? [] : input.effectivePolicies;
  const sameRevisionEnvelope = buildEnvelope({
    ...input,
    phase,
    revision: current.desiredRevision,
    effectivePolicies,
  });
  if (
    current.deliveryStatus !== 'rejected'
    && current.desiredPhase === phase
    && current.desiredDigest === sameRevisionEnvelope.digest
  ) {
    return { kind: 'coalesced' };
  }

  return {
    kind: 'queued',
    envelope: buildEnvelope({
      ...input,
      phase,
      revision: current.desiredRevision + 1,
      effectivePolicies,
    }),
  };
}

export function planPeripheralPolicyResult(
  state: PeripheralPolicyStateSnapshot,
  result: PeripheralPolicyResultV2,
): {
  accepted: boolean;
  deliveryStatus?: 'applied' | 'rejected';
  lastErrorCode?: string | null;
  scheduleEnforce: boolean;
} {
  if (
    result.schemaVersion !== 2
    || result.phase !== state.desiredPhase
    || result.revision !== state.desiredRevision
    || result.digest !== state.desiredDigest
  ) {
    return { accepted: false, scheduleEnforce: false };
  }
  return {
    accepted: true,
    deliveryStatus: result.outcome,
    lastErrorCode: result.outcome === 'rejected' ? (result.reasonCode ?? 'invalid_payload') : null,
    scheduleEnforce: result.phase === 'clear_legacy' && result.outcome === 'applied',
  };
}

function stateSnapshot(
  state: typeof peripheralPolicyDeviceStates.$inferSelect,
): PeripheralPolicyStateSnapshot {
  return {
    desiredPhase: state.desiredPhase,
    desiredRevision: state.desiredRevision,
    desiredDigest: state.desiredDigest,
    deliveryStatus: state.deliveryStatus,
    appliedPhase: state.appliedPhase,
    appliedRevision: state.appliedRevision,
    appliedDigest: state.appliedDigest,
  };
}

export async function reconcilePeripheralPolicyDevice(
  deviceId: string,
  reason: PeripheralReconcileReason,
): Promise<'coalesced' | 'queued' | 'incompatible'> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const [device] = await tx
      .select({
        id: devices.id,
        orgId: devices.orgId,
        peripheralPolicyProtocolVersion: devices.peripheralPolicyProtocolVersion,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)
      .for('update');
    const resolved = device
      ? await loadAndResolveEffectivePeripheralPolicySetInCurrentDbContext(deviceId)
      : null;
    if (
      !device
      || !resolved
      || device.peripheralPolicyProtocolVersion !== 2
      || device.orgId !== resolved.identity.orgId
    ) {
      return 'incompatible';
    }

    const [current] = await tx
      .select()
      .from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, deviceId))
      .limit(1)
      .for('update');
    const generatedAt = new Date().toISOString();
    const plan = planPeripheralPolicyReconciliation({
      identity: resolved.identity,
      effectivePolicies: resolved.effectivePolicies,
      currentState: current ? stateSnapshot(current) : null,
      generatedAt,
      reason,
    });
    if (plan.kind === 'coalesced') return 'coalesced';

    try {
      await assertDeviceExecuteAllowed(deviceId, 'peripheral_policy_sync_v2', null);
    } catch (error) {
      if (!(error instanceof TrustDeniedError)) throw error;
      console.warn('Skipping peripheral policy push because partner trust denied device execution', {
        deviceId,
        code: error.code,
      });
      return 'incompatible';
    }

    const now = new Date(generatedAt);
    if (current) {
      await tx
        .update(peripheralPolicyDeviceStates)
        .set({
          desiredPhase: plan.envelope.phase,
          desiredRevision: plan.envelope.revision,
          desiredDigest: plan.envelope.digest,
          desiredEnvelope: plan.envelope as unknown as Record<string, unknown>,
          deliveryStatus: 'pending',
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(eq(peripheralPolicyDeviceStates.deviceId, deviceId));
    } else {
      await tx.insert(peripheralPolicyDeviceStates).values({
        deviceId,
        orgId: device.orgId,
        desiredPhase: plan.envelope.phase,
        desiredRevision: plan.envelope.revision,
        desiredDigest: plan.envelope.digest,
        desiredEnvelope: plan.envelope as unknown as Record<string, unknown>,
        deliveryStatus: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    const [command] = await tx.insert(deviceCommands).values({
      deviceId,
      type: 'peripheral_policy_sync_v2',
      payload: plan.envelope,
      status: 'pending',
      targetRole: 'agent',
    }).returning({ id: deviceCommands.id });
    if (!command) throw new Error('Failed to create peripheral policy v2 command');

    await tx.insert(peripheralPolicyDeliveryEvents).values({
      orgId: device.orgId,
      deviceId,
      commandId: command.id,
      eventKind: 'requested',
      phase: plan.envelope.phase,
      revision: plan.envelope.revision,
      digest: plan.envelope.digest,
      outcome: null,
      reasonCode: null,
      evidence: { reason },
      occurredAt: now,
    });
    return 'queued';
  })));
}

export async function handlePeripheralPolicyResultV2(
  deviceId: string,
  commandId: string,
  result: PeripheralPolicyResultV2,
): Promise<'applied' | 'rejected' | 'ignored'> {
  const transition = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const [device] = await tx
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)
      .for('key share');
    if (!device) return { outcome: 'ignored' as const, scheduleEnforce: false };

    const [command] = await tx
      .select({ id: deviceCommands.id, deviceId: deviceCommands.deviceId, type: deviceCommands.type })
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
      ))
      .limit(1);
    if (!command) return { outcome: 'ignored' as const, scheduleEnforce: false };

    const [state] = await tx
      .select()
      .from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, deviceId))
      .limit(1)
      .for('update');
    if (!state) return { outcome: 'ignored' as const, scheduleEnforce: false };

    const plan = planPeripheralPolicyResult(stateSnapshot(state), result);
    if (!plan.accepted || !plan.deliveryStatus) {
      return { outcome: 'ignored' as const, scheduleEnforce: false };
    }

    const [insertedEvent] = await tx.insert(peripheralPolicyDeliveryEvents).values({
      orgId: device.orgId,
      deviceId,
      commandId,
      eventKind: 'result',
      phase: result.phase,
      revision: result.revision,
      digest: result.digest,
      outcome: result.outcome,
      reasonCode: result.reasonCode ?? null,
      evidence: { result },
      occurredAt: new Date(),
    }).onConflictDoNothing().returning({ id: peripheralPolicyDeliveryEvents.id });
    if (!insertedEvent) {
      return { outcome: result.outcome, scheduleEnforce: false };
    }

    await tx
      .update(peripheralPolicyDeviceStates)
      .set({
        deliveryStatus: plan.deliveryStatus,
        appliedPhase: result.outcome === 'applied' ? result.phase : state.appliedPhase,
        appliedRevision: result.outcome === 'applied' ? result.revision : state.appliedRevision,
        appliedDigest: result.outcome === 'applied' ? result.digest : state.appliedDigest,
        lastErrorCode: plan.lastErrorCode ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(peripheralPolicyDeviceStates.deviceId, deviceId),
        eq(peripheralPolicyDeviceStates.desiredPhase, result.phase),
        eq(peripheralPolicyDeviceStates.desiredRevision, result.revision),
        eq(peripheralPolicyDeviceStates.desiredDigest, result.digest),
      ));
    return { outcome: result.outcome, scheduleEnforce: plan.scheduleEnforce };
  })));

  if (transition.scheduleEnforce) {
    await reconcilePeripheralPolicyDevice(deviceId, 'clear_legacy_applied');
  }
  return transition.outcome;
}
