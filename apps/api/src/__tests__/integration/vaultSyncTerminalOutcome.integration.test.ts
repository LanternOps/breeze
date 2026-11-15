/**
 * #11905 — a `vault_sync` that never produces an agent result still gives its
 * vault a terminal outcome.
 *
 * The Sync route writes `local_vaults.last_sync_status = 'pending'` before it
 * queues `vault_sync`, and only an agent result used to move it on. A command
 * that expired undelivered, hit its execution timeout, was refused at delivery
 * or was cancelled left the vault `pending` forever with no error.
 *
 * Why integration, not unit: what decides each case is SQL — the reaper's
 * two-clock selection, the refusal expiry's CAS, and the vault write's
 * "no newer attempt" NOT EXISTS over `device_commands`. A Drizzle mock would
 * pass every case below whatever that SQL said.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vaultSyncTerminalOutcome.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, localVaults } from '../../db/schema';
import { reapStaleDeviceCommands } from '../../jobs/staleCommandReaper';
import { expireRefusedClaimedCommandDelivery } from '../../services/commandDispatch';
import { cancelDeviceCommands } from '../../services/commandCancelPropagation';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;

const asSystem = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

let counter = 0;

async function seed() {
  const tdb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  counter++;
  const agentId = `agent-11905-${counter}-${Date.now()}`;
  const [device] = await tdb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId,
    hostname: `vault-sync-${counter}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  const [vault] = await tdb.insert(localVaults).values({
    orgId: org.id,
    deviceId: device!.id,
    vaultPath: 'D:\\BreezeVault',
    isActive: true,
    // What the Sync route leaves behind before it queues the command.
    lastSyncStatus: 'pending',
    lastSyncSnapshotId: 'snap-1',
  }).returning({ id: localVaults.id });
  return { partnerId: partner.id, orgId: org.id, deviceId: device!.id, vaultId: vault!.id };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function insertVaultSync(
  s: Seeded,
  row: Partial<typeof deviceCommands.$inferInsert> & { status: 'pending' | 'sent' },
): Promise<string> {
  const [cmd] = await getTestDb().insert(deviceCommands).values({
    deviceId: s.deviceId,
    type: 'vault_sync',
    payload: { vaultId: s.vaultId, vaultPath: 'D:\\BreezeVault', snapshotId: 'snap-1' },
    submittedOrgId: s.orgId,
    ...row,
  }).returning({ id: deviceCommands.id });
  return cmd!.id;
}

async function vault(vaultId: string) {
  const [v] = await getTestDb().select().from(localVaults).where(eq(localVaults.id, vaultId)).limit(1);
  if (!v) throw new Error(`vault ${vaultId} not found`);
  return v;
}

async function commandStatus(commandId: string) {
  const [c] = await getTestDb()
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  return c?.status;
}

describe('vault_sync terminal outcome without an agent result (#11905)', () => {
  it('a vault_sync that expired undelivered marks its vault failed with the reason', async () => {
    const s = await seed();
    const commandId = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(commandId)).toBe('failed');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('failed');
    expect(v.lastSyncError).toMatch(/^Vault sync did not complete: Device did not reconnect before .+; command was never delivered$/);
  });

  it('a delivered vault_sync the agent never answered marks its vault failed with the timeout', async () => {
    const s = await seed();
    const executedAt = new Date(Date.now() - 7 * DAY_MS);
    const commandId = await insertVaultSync(s, {
      status: 'sent',
      createdAt: executedAt,
      executedAt,
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(commandId)).toBe('failed');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('failed');
    expect(v.lastSyncError).toMatch(/^Vault sync did not complete: Server-side timeout: no response from agent after \d+ minutes$/);
  });

  it('a vault_sync refused at delivery marks its vault failed with the refusal reason', async () => {
    const s = await seed();
    const executedAt = new Date(Date.now() - 1_000);
    const commandId = await insertVaultSync(s, { status: 'sent', executedAt });

    // Exactly what the delivery refresher's refusal does to the claimed row.
    await expireRefusedClaimedCommandDelivery(
      commandId,
      executedAt,
      "The snapshot's backup destination is not available to this device.",
    );
    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(commandId)).toBe('failed');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('failed');
    expect(v.lastSyncError).toBe(
      "Vault sync did not complete: Command was not delivered: The snapshot's backup destination is not available to this device.",
    );
  });

  it('a cancelled vault_sync marks its vault failed', async () => {
    const s = await seed();
    const commandId = await insertVaultSync(s, { status: 'pending', deliverBy: new Date(Date.now() + DAY_MS) });

    await asSystem(() => cancelDeviceCommands({
      where: eq(deviceCommands.id, commandId),
      result: { cancelledBy: 'test' },
    }));

    expect(await commandStatus(commandId)).toBe('cancelled');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('failed');
    expect(v.lastSyncError).toBe('Vault sync did not complete: Cancelled before the device received it');
  });

  it('leaves the vault pending when a newer sync for it is still in flight', async () => {
    const s = await seed();
    const old = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
    });
    // The operator pressed Sync again; that attempt is queued and not yet due.
    const newer = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000),
      deliverBy: new Date(Date.now() + DAY_MS),
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(old)).toBe('failed');
    expect(await commandStatus(newer)).toBe('pending');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('pending');
    expect(v.lastSyncError).toBeNull();
  });

  it('does not overwrite an outcome a newer sync already recorded', async () => {
    const s = await seed();
    await getTestDb().update(localVaults).set({ lastSyncStatus: 'completed', lastSyncError: null })
      .where(eq(localVaults.id, s.vaultId));
    const commandId = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(commandId)).toBe('failed');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('completed');
    expect(v.lastSyncError).toBeNull();
  });

  it('does not write a vault outside the org the command was queued for', async () => {
    const s = await seed();
    const otherOrg = await createOrganization({ partnerId: s.partnerId });
    const commandId = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
      submittedOrgId: otherOrg.id,
    });

    await asSystem(() => reapStaleDeviceCommands());

    // The reaper did process the row; only the vault write was withheld.
    expect(await commandStatus(commandId)).toBe('failed');
    const v = await vault(s.vaultId);
    expect(v.lastSyncStatus).toBe('pending');
  });

  it('a newer sync that is already delivered (sent) also keeps the vault pending', async () => {
    const s = await seed();
    const old = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
    });
    await insertVaultSync(s, {
      status: 'sent',
      createdAt: new Date(Date.now() - 60_000),
      executedAt: new Date(Date.now() - 30_000),
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(old)).toBe('failed');
    expect((await vault(s.vaultId)).lastSyncStatus).toBe('pending');
  });

  it("a newer in-flight sync for a DIFFERENT vault on the device does not block this vault's outcome", async () => {
    const s = await seed();
    const [otherVault] = await getTestDb().insert(localVaults).values({
      orgId: s.orgId,
      deviceId: s.deviceId,
      vaultPath: 'E:\\OtherVault',
      isActive: true,
      lastSyncStatus: 'pending',
    }).returning({ id: localVaults.id });
    await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
    });
    await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000),
      deliverBy: new Date(Date.now() + DAY_MS),
      payload: { vaultId: otherVault!.id, vaultPath: 'E:\\OtherVault', snapshotId: 'snap-1' },
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect((await vault(s.vaultId)).lastSyncStatus).toBe('failed');
    expect((await vault(otherVault!.id)).lastSyncStatus).toBe('pending');
  });

  it('an OLDER sync still in flight does not block a newer one that expired', async () => {
    const s = await seed();
    await insertVaultSync(s, {
      status: 'sent',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      executedAt: new Date(Date.now() - 30_000),
    });
    const newer = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000),
      deliverBy: new Date(Date.now() - 1_000),
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(newer)).toBe('failed');
    expect((await vault(s.vaultId)).lastSyncStatus).toBe('failed');
  });

  it("does not write another device's vault the payload names", async () => {
    const s = await seed();
    const other = await seed();
    const commandId = await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
      payload: { vaultId: other.vaultId, vaultPath: 'D:\\BreezeVault', snapshotId: 'snap-1' },
      submittedOrgId: null,
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect(await commandStatus(commandId)).toBe('failed');
    expect((await vault(other.vaultId)).lastSyncStatus).toBe('pending');
  });

  it('a legacy command with no submitted org still fails its own vault', async () => {
    const s = await seed();
    await insertVaultSync(s, {
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      deliverBy: new Date(Date.now() - 60_000),
      submittedOrgId: null,
    });

    await asSystem(() => reapStaleDeviceCommands());

    expect((await vault(s.vaultId)).lastSyncStatus).toBe('failed');
  });
});
