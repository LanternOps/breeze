import '../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from '../__tests__/integration/setup';
import {
  deviceCommands,
  devices,
  organizations,
  partners,
  peripheralPolicies,
  peripheralPolicyDeliveryEvents,
  peripheralPolicyDeviceStates,
  sites,
} from '../db/schema';
import {
  handlePeripheralPolicyResultV2,
  reconcilePeripheralPolicyDevice,
} from './peripheralPolicyState';

const runDb = it.runIf(!!process.env.DATABASE_URL);
async function seedDevice(capability: number) {
  const database = getTestDb();
  const suffix = randomUUID();
  const [partner] = await database.insert(partners).values({
    name: `Policy State Partner ${suffix}`,
    slug: `policy-state-partner-${suffix}`,
    type: 'msp',
    plan: 'pro',
    status: 'active',
  }).returning();
  const [organization] = await database.insert(organizations).values({
    partnerId: partner!.id,
    currencyCode: 'USD',
    name: `Policy State Org ${suffix}`,
    slug: `policy-state-org-${suffix}`,
    type: 'customer',
    status: 'active',
  }).returning();
  const [site] = await database.insert(sites).values({
    orgId: organization!.id,
    name: 'Policy State Site',
  }).returning();
  const [device] = await database.insert(devices).values({
    orgId: organization!.id,
    siteId: site!.id,
    agentId: `policy-state-agent-${suffix}`,
    hostname: 'policy-state-device',
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'offline',
    peripheralPolicyProtocolVersion: capability,
  }).returning();
  return { partner: partner!, organization: organization!, site: site!, device: device! };
}

describe('peripheral policy desired-state persistence', () => {
  runDb('resolves the effective policy only after acquiring the device lock', async () => {
    const database = getTestDb();
    const seeded = await seedDevice(2);
    const [policy] = await database.insert(peripheralPolicies).values({
      orgId: seeded.organization.id,
      partnerId: null,
      name: 'Mutable storage policy',
      deviceClass: 'storage',
      action: 'block',
      targetType: 'organization',
      priority: 100,
      targetIds: {},
      exceptions: [],
      isActive: true,
    }).returning();

    await reconcilePeripheralPolicyDevice(seeded.device.id, 'policy_changed');
    const [clearState] = await database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id));
    const [clearCommand] = await database.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, seeded.device.id),
      eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
    ));
    await handlePeripheralPolicyResultV2(seeded.device.id, clearCommand!.id, {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: clearState!.desiredRevision,
      digest: clearState!.desiredDigest,
      outcome: 'applied',
    });

    let releaseDeviceLock!: () => void;
    const releaseDeviceLockPromise = new Promise<void>((resolve) => {
      releaseDeviceLock = resolve;
    });
    let deviceLocked!: () => void;
    const deviceLockedPromise = new Promise<void>((resolve) => {
      deviceLocked = resolve;
    });
    const lockTransaction = database.transaction(async (tx) => {
      await tx.select({ id: devices.id }).from(devices)
        .where(eq(devices.id, seeded.device.id)).for('update');
      deviceLocked();
      await releaseDeviceLockPromise;
    });
    await deviceLockedPromise;

    const reconciliation = reconcilePeripheralPolicyDevice(seeded.device.id, 'policy_changed');
    try {
      let observedLockWait = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await database.execute(sql<{ waiting: number }>`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename = 'breeze_app'
            AND wait_event_type = 'Lock'
        `);
        if (Number(rows[0]?.waiting ?? 0) > 0) {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);

      await database.update(peripheralPolicies)
        .set({ action: 'allow' })
        .where(eq(peripheralPolicies.id, policy!.id));
    } finally {
      releaseDeviceLock();
      await lockTransaction;
    }
    await expect(reconciliation).resolves.toBe('queued');

    const [state] = await database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id));
    expect((state!.desiredEnvelope as { effectivePolicies: Array<{ action: string }> })
      .effectivePolicies.map((entry) => entry.action)).toEqual(['allow']);
  });

  runDb('serializes concurrent first admission and coalesces one clear command', async () => {
    const database = getTestDb();
    const seeded = await seedDevice(2);

    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      reconcilePeripheralPolicyDevice(seeded.device.id, 'policy_changed')));

    expect(outcomes.filter((outcome) => outcome === 'queued')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'coalesced')).toHaveLength(7);

    const [state] = await database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id));
    expect(state).toMatchObject({
      desiredPhase: 'clear_legacy',
      desiredRevision: 1,
      deliveryStatus: 'pending',
    });
    expect((state!.desiredEnvelope as { effectivePolicies: unknown[] }).effectivePolicies).toEqual([]);

    const commands = await database.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, seeded.device.id),
      eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
    ));
    expect(commands).toHaveLength(1);
    const events = await database.select().from(peripheralPolicyDeliveryEvents)
      .where(eq(peripheralPolicyDeliveryEvents.deviceId, seeded.device.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventKind: 'requested', commandId: commands[0]!.id });
  });

  runDb('accepts only the exact clear result, then queues the current effective enforcement set', async () => {
    const database = getTestDb();
    const seeded = await seedDevice(2);
    const [policy] = await database.insert(peripheralPolicies).values({
      orgId: seeded.organization.id,
      partnerId: null,
      name: 'Block storage',
      deviceClass: 'storage',
      action: 'block',
      targetType: 'organization',
      priority: 100,
      targetIds: {},
      exceptions: [],
      isActive: true,
    }).returning();
    await reconcilePeripheralPolicyDevice(seeded.device.id, 'policy_changed');
    const [clearState] = await database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id));
    const [clearCommand] = await database.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, seeded.device.id),
      eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
    ));

    const mismatch = await handlePeripheralPolicyResultV2(seeded.device.id, clearCommand!.id, {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: clearState!.desiredRevision + 1,
      digest: clearState!.desiredDigest,
      outcome: 'applied',
    });
    expect(mismatch).toBe('ignored');

    const accepted = await handlePeripheralPolicyResultV2(seeded.device.id, clearCommand!.id, {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: clearState!.desiredRevision,
      digest: clearState!.desiredDigest,
      outcome: 'applied',
    });
    expect(accepted).toBe('applied');

    const [enforceState] = await database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id));
    expect(enforceState).toMatchObject({
      desiredPhase: 'enforce',
      desiredRevision: 2,
      deliveryStatus: 'pending',
      appliedPhase: 'clear_legacy',
      appliedRevision: 1,
      appliedDigest: clearState!.desiredDigest,
    });
    expect((enforceState!.desiredEnvelope as { effectivePolicies: Array<{ policyId: string }> })
      .effectivePolicies.map((entry) => entry.policyId)).toEqual([policy!.id]);

    const commands = await database.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, seeded.device.id),
      eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
    ));
    expect(commands).toHaveLength(2);
    const events = await database.select().from(peripheralPolicyDeliveryEvents)
      .where(eq(peripheralPolicyDeliveryEvents.deviceId, seeded.device.id));
    expect(events.map((event) => event.eventKind)).toEqual(['requested', 'result', 'requested']);
  });

  runDb('does not create protocol state or commands for an incompatible device', async () => {
    const database = getTestDb();
    const seeded = await seedDevice(0);

    await expect(reconcilePeripheralPolicyDevice(seeded.device.id, 'policy_changed'))
      .resolves.toBe('incompatible');
    await expect(database.select().from(peripheralPolicyDeviceStates)
      .where(eq(peripheralPolicyDeviceStates.deviceId, seeded.device.id))).resolves.toEqual([]);
    await expect(database.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, seeded.device.id),
      eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
    ))).resolves.toEqual([]);
  });
});
