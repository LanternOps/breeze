/**
 * Backup + Vault WS result integrity (security-hardening F5 / F6).
 *
 * Threat model: a compromised-but-legitimately-enrolled agent (valid token + WS
 * for its own device) tries to forge or replay "backup completed" / "vault
 * synced" state for its own device. Org-axis RLS and agent-auth all hold; this is
 * a same-device integrity gap. These tests drive the real WS orphaned-result
 * handler against a real DB + Redis and assert the server-side consume-once gates.
 *
 * Why integration, not unit: F5 derives legitimacy from a real persisted backup
 * snapshot row and mutates `local_vaults`; F6 consume-once lives in Redis and the
 * accept path enqueues a BullMQ job. A Drizzle/Redis mock wouldn't exercise the
 * snapshot correlation, the RLS-context writes, or the atomic Redis consume.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/backupVaultResultIntegrity.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { withDbAccessContext } from '../../db';
import { createPartner, createOrganization, createSite } from './db-utils';
import {
  devices,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  localVaults,
} from '../../db/schema';
import { processOrphanedCommandResult } from '../../routes/agentWs';
import { recordDispatchedExpectation } from '../../services/agentWorkExpectation';
import { getBackupQueue } from '../../jobs/backupEnqueue';

type OrphanResult = Parameters<typeof processOrphanedCommandResult>[2];

/**
 * Drive the orphaned-result handler the same way the live WS message loop does:
 * inside the agent's org-scoped DB context (runWithAgentDbAccess in agentWs.ts).
 * Calling it bare would leave RLS with no context and silently return 0 rows —
 * which is itself the failure mode we hardened other paths against.
 */
async function runHandler(orgId: string, agentId: string, deviceId: string, result: OrphanResult) {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      currentPartnerId: null,
    },
    () => processOrphanedCommandResult(agentId, deviceId, result),
  );
}

let agentCounter = 0;

interface Seeded {
  orgId: string;
  deviceId: string;
  agentId: string;
  configId: string;
}

async function seedDeviceWithBackup(): Promise<Seeded> {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  agentCounter++;
  const agentId = `agent-bvi-${agentCounter}-${Date.now()}`;

  const [device] = await db
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId,
      hostname: `bvi-host-${agentCounter}`,
      displayName: `bvi-host-${agentCounter}`,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });

  const [config] = await db
    .insert(backupConfigs)
    .values({
      orgId: org.id,
      name: 'bvi-config',
      type: 'file',
      provider: 'local',
      providerConfig: {},
    })
    .returning({ id: backupConfigs.id });

  return { orgId: org.id, deviceId: device!.id, agentId, configId: config!.id };
}

async function insertBackupJob(s: Seeded, status: 'pending' | 'running' | 'completed' | 'failed') {
  const db = getTestDb();
  const [job] = await db
    .insert(backupJobs)
    .values({
      orgId: s.orgId,
      configId: s.configId,
      deviceId: s.deviceId,
      status,
      type: 'manual',
      startedAt: new Date(),
    })
    .returning({ id: backupJobs.id });
  return job!.id;
}

async function insertCompletedSnapshot(s: Seeded, snapshotId: string, timestamp: Date, jobId: string) {
  const db = getTestDb();
  await db.insert(backupSnapshots).values({
    orgId: s.orgId,
    jobId,
    deviceId: s.deviceId,
    snapshotId,
    timestamp,
    size: 1024,
  });
}

async function insertVault(s: Seeded, vaultPath = '/vault/bvi') {
  const db = getTestDb();
  const [vault] = await db
    .insert(localVaults)
    .values({
      orgId: s.orgId,
      deviceId: s.deviceId,
      vaultPath,
      isActive: true,
    })
    .returning({ id: localVaults.id });
  return vault!.id;
}

async function getVault(vaultId: string) {
  const db = getTestDb();
  const [v] = await db
    .select()
    .from(localVaults)
    .where(eq(localVaults.id, vaultId))
    .limit(1);
  if (!v) throw new Error(`getVault: vault ${vaultId} not found`);
  return v;
}

/** Count enqueued process-results jobs for a given backup job id. */
async function resultJobExists(jobId: string): Promise<boolean> {
  const queue = getBackupQueue();
  const job = await queue.getJob(`backup-result-${jobId}`);
  return Boolean(job);
}

function vaultSyncResult(snapshotId: string, vaultId: string) {
  return {
    type: 'command_result' as const,
    commandId: `vault-auto-sync-${snapshotId}`,
    status: 'completed' as const,
    stdout: JSON.stringify({
      auto: true,
      snapshotId,
      vaultId,
      totalBytes: 1024,
      fileCount: 3,
      manifestVerified: true,
    }),
  };
}

/** A vault-sync result that carries NO vaultId/vaultPath, so the target vault
 *  can only be derived via the (now-disabled) single-active-vault fallback. */
function vaultSyncResultNoVaultHint(snapshotId: string) {
  return {
    type: 'command_result' as const,
    commandId: `vault-auto-sync-${snapshotId}`,
    status: 'completed' as const,
    stdout: JSON.stringify({
      auto: true,
      snapshotId,
      totalBytes: 1024,
      fileCount: 3,
      manifestVerified: true,
    }),
  };
}

function backupResult(jobId: string) {
  return {
    type: 'command_result' as const,
    commandId: jobId,
    status: 'completed' as const,
    result: {
      snapshotId: 'snap-real-1',
      filesBackedUp: 3,
      bytesBackedUp: 1024,
    },
  };
}

beforeEach(async () => {
  // Each test seeds fresh; cleanupDatabase already truncated + flushed Redis.
  await getBackupQueue().obliterate({ force: true }).catch(() => {});
});

describe('F5 — vault auto-sync orphan result integrity', () => {
  it('drops a forged vault-auto-sync result with no matching completed snapshot (vault unchanged)', async () => {
    const s = await seedDeviceWithBackup();
    const vaultId = await insertVault(s);
    const before = await getVault(vaultId);
    expect(before.lastSyncStatus).toBeNull();

    // Forged: snapshot id the server has never seen.
    await runHandler(s.orgId, s.agentId, s.deviceId, vaultSyncResult('snap-forged-xyz', vaultId));

    const after = await getVault(vaultId);
    expect(after.lastSyncStatus).toBeNull();
    expect(after.lastSyncSnapshotId).toBeNull();
  });

  it('applies a vault-auto-sync result that matches a fresh completed snapshot exactly once', async () => {
    const s = await seedDeviceWithBackup();
    const vaultId = await insertVault(s);
    const jobId = await insertBackupJob(s, 'completed');
    const snapshotId = 'snap-fresh-1';
    await insertCompletedSnapshot(s, snapshotId, new Date(), jobId);

    await runHandler(s.orgId, s.agentId, s.deviceId, vaultSyncResult(snapshotId, vaultId));

    const applied = await getVault(vaultId);
    expect(applied.lastSyncStatus).toBe('completed');
    expect(applied.lastSyncSnapshotId).toBe(snapshotId);

    // Replay of the SAME snapshot is a no-op (consume-once): mutate the vault row
    // out-of-band, replay, and assert the replay did not re-apply.
    const db = getTestDb();
    await db
      .update(localVaults)
      .set({ lastSyncStatus: 'sentinel', lastSyncSnapshotId: 'sentinel' })
      .where(eq(localVaults.id, vaultId));

    await runHandler(s.orgId, s.agentId, s.deviceId, vaultSyncResult(snapshotId, vaultId));

    const afterReplay = await getVault(vaultId);
    expect(afterReplay.lastSyncStatus).toBe('sentinel');
    expect(afterReplay.lastSyncSnapshotId).toBe('sentinel');
  });

  it('drops a vault-auto-sync result whose matching snapshot is outside the freshness window', async () => {
    const s = await seedDeviceWithBackup();
    const vaultId = await insertVault(s);
    const jobId = await insertBackupJob(s, 'completed');
    const snapshotId = 'snap-stale-1';
    // 48h old — outside the 24h freshness window.
    await insertCompletedSnapshot(s, snapshotId, new Date(Date.now() - 48 * 60 * 60 * 1000), jobId);

    await runHandler(s.orgId, s.agentId, s.deviceId, vaultSyncResult(snapshotId, vaultId));

    const after = await getVault(vaultId);
    expect(after.lastSyncStatus).toBeNull();
  });

  it('drops an unhinted vault-auto-sync result instead of guessing the single active vault', async () => {
    const s = await seedDeviceWithBackup();
    // Exactly ONE active vault: the old single-active-vault fallback would have
    // happily picked it. The orphan path disables that fallback, so a result
    // carrying no vaultId/vaultPath must be dropped, not applied to this vault.
    const vaultId = await insertVault(s);
    const jobId = await insertBackupJob(s, 'completed');
    const snapshotId = 'snap-unhinted-1';
    await insertCompletedSnapshot(s, snapshotId, new Date(), jobId);

    await runHandler(s.orgId, s.agentId, s.deviceId, vaultSyncResultNoVaultHint(snapshotId));

    expect((await getVault(vaultId)).lastSyncStatus).toBeNull();
  });

  it('drops a vault-auto-sync result with an empty snapshot id', async () => {
    const s = await seedDeviceWithBackup();
    const vaultId = await insertVault(s);

    await runHandler(s.orgId, s.agentId, s.deviceId, {
      type: 'command_result' as const,
      commandId: 'vault-auto-sync-',
      status: 'completed' as const,
      stdout: JSON.stringify({ auto: true, vaultId, totalBytes: 1 }),
    });

    expect((await getVault(vaultId)).lastSyncStatus).toBeNull();
  });

  it('drops a vault-auto-sync result for a snapshot that belongs to a different device', async () => {
    // device A is the authenticated agent; device B (another org) has the real snapshot.
    const a = await seedDeviceWithBackup();
    const b = await seedDeviceWithBackup();
    const vaultA = await insertVault(a);
    const jobB = await insertBackupJob(b, 'completed');
    const snapshotId = 'snap-other-device';
    await insertCompletedSnapshot(b, snapshotId, new Date(), jobB);

    // Agent A forges a vault-sync referencing device B's snapshot id.
    await runHandler(a.orgId, a.agentId, a.deviceId, vaultSyncResult(snapshotId, vaultA));

    expect((await getVault(vaultA)).lastSyncStatus).toBeNull();
  });
});

describe('F6 — backup completion forgery integrity', () => {
  it('accepts a backup result for a dispatched job exactly once; replay is rejected', async () => {
    const s = await seedDeviceWithBackup();
    const jobId = await insertBackupJob(s, 'running');
    await recordDispatchedExpectation('backup', s.deviceId, jobId);

    await runHandler(s.orgId, s.agentId, s.deviceId, backupResult(jobId));
    expect(await resultJobExists(jobId)).toBe(true);

    // Replay: the dispatch expectation was consumed, so the second result is
    // dropped. Remove the enqueued job first so its presence can't mask a drop.
    await getBackupQueue().getJob(`backup-result-${jobId}`).then((j) => j?.remove());
    await runHandler(s.orgId, s.agentId, s.deviceId, backupResult(jobId));
    expect(await resultJobExists(jobId)).toBe(false);
  });

  it('rejects a backup result for a job UUID that was never dispatched', async () => {
    const s = await seedDeviceWithBackup();
    // Job row exists + agent owns the device, but no dispatch expectation recorded.
    const jobId = await insertBackupJob(s, 'running');

    await runHandler(s.orgId, s.agentId, s.deviceId, backupResult(jobId));

    expect(await resultJobExists(jobId)).toBe(false);
  });

  it('rejects a re-driven result for an already-terminal (consumed) job', async () => {
    const s = await seedDeviceWithBackup();
    const jobId = await insertBackupJob(s, 'completed');
    await recordDispatchedExpectation('backup', s.deviceId, jobId);

    // First result consumes the expectation.
    await runHandler(s.orgId, s.agentId, s.deviceId, backupResult(jobId));
    await getBackupQueue().getJob(`backup-result-${jobId}`).then((j) => j?.remove());

    // Re-drive after terminal: expectation already consumed → dropped.
    await runHandler(s.orgId, s.agentId, s.deviceId, backupResult(jobId));
    expect(await resultJobExists(jobId)).toBe(false);
  });

  it('rejects a backup result for a job that belongs to another device', async () => {
    // device B owns a dispatched job; agent A (different org) tries to report it.
    const a = await seedDeviceWithBackup();
    const b = await seedDeviceWithBackup();
    const jobB = await insertBackupJob(b, 'running');
    await recordDispatchedExpectation('backup', b.deviceId, jobB);

    // Under agent A's own org context the job row isn't even visible (RLS) and
    // the agent-ownership guard rejects it; the result must be dropped.
    await runHandler(a.orgId, a.agentId, a.deviceId, backupResult(jobB));

    expect(await resultJobExists(jobB)).toBe(false);
  });
});
