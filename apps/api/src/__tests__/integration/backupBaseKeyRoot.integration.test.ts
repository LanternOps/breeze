import './setup';

import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotRetirements,
  backupSnapshots,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { cleanupExpiredSnapshots } from '../../jobs/backupRetention';
import { __testOnly } from '../../jobs/backupWorker';

/**
 * #7081 W02, I4: a dedupe base must share the key root of the run it serves,
 * so a chain never spans roots and the first run after a prefix change is a
 * full backup. The run's root is the mint root (`resolveMintKeyRoot`), which
 * W02 still pins to the legacy root — so a prefixed snapshot is never a base.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(unique: string) {
  const [partner] = await db.insert(partners).values({ name: `BK ${unique}`, slug: `bk-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: partner!.id, name: `BKO ${unique}`, slug: `bko-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `BKS ${unique}` }).returning({ id: sites.id });
  // An older helper: unrestricted (unattested) base selection.
  const [device] = await db.insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: `bka-${unique}`, hostname: `bkh-${unique}`, osType: 'windows', osVersion: '11',
    architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    backupReadProtocolVersion: 0, backupIntegrityProtocolVersion: 0, backupWriteProtocolVersion: 0,
  }).returning({ id: devices.id });
  const providerConfig = { path: `/tmp/bk-test-${unique}` };
  const [config] = await db.insert(backupConfigs).values({ orgId: org!.id, name: `BKC ${unique}`, type: 'file', provider: 'local', providerConfig }).returning({ id: backupConfigs.id });
  return { orgId: org!.id, deviceId: device!.id, configId: config!.id, providerConfig, identity: `local::/tmp/bk-test-${unique}` };
}

async function snapshot(
  ctx: { orgId: string; deviceId: string; configId: string; identity: string },
  snapshotId: string,
  takenAgoMs: number,
  root: { keyLayout: 'legacy_flat' | 'prefixed_flat'; keyPrefix: string | null },
  expiresAt: Date = new Date(Date.now() + 7 * DAY_MS),
) {
  const [job] = await db.insert(backupJobs).values({
    orgId: ctx.orgId, configId: ctx.configId, deviceId: ctx.deviceId, status: 'completed', startedAt: new Date(), completedAt: new Date(),
  }).returning({ id: backupJobs.id });
  await db.insert(backupSnapshots).values({
    orgId: ctx.orgId, jobId: job!.id, deviceId: ctx.deviceId, configId: ctx.configId, snapshotId, backupType: 'file',
    storageIdentity: ctx.identity, timestamp: new Date(Date.now() - takenAgoMs), expiresAt, ...root,
  });
}

const LEGACY = { keyLayout: 'legacy_flat' as const, keyPrefix: null };
const PREFIXED = { keyLayout: 'prefixed_flat' as const, keyPrefix: 'msp/acme' };

runDb('pins the newest base under the run\'s own key root, passing over a newer one under another root (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const c = await seed(unique);
    await snapshot(c, `legacy-older-${unique}`, 2 * DAY_MS, LEGACY);
    await snapshot(c, `prefixed-newer-${unique}`, DAY_MS, PREFIXED);
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId: c.orgId, configId: c.configId, deviceId: c.deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { ...c, dispatchJobId: dispatchJob!.id };
  });

  const outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId, mode: 'file', provider: 'local', providerConfig: ctx.providerConfig,
  }));

  expect(outcome.baseSnapshotId).toBe(`legacy-older-${unique}`);
  const [row] = await withSystemDbAccessContext(() => db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId)));
  expect(row!.baseSnapshotId).toBe(`legacy-older-${unique}`);
});

runDb('takes no base — a full backup — when no candidate shares the run\'s key root, and says why (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const c = await seed(unique);
    await snapshot(c, `prefixed-only-${unique}`, DAY_MS, PREFIXED);
    const [dispatchJob] = await db.insert(backupJobs).values({ orgId: c.orgId, configId: c.configId, deviceId: c.deviceId, status: 'pending' }).returning({ id: backupJobs.id });
    return { ...c, dispatchJobId: dispatchJob!.id };
  });

  const warnings: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  let outcome;
  try {
    outcome = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
      deviceId: ctx.deviceId, configId: ctx.configId, jobId: ctx.dispatchJobId, mode: 'file', provider: 'local', providerConfig: ctx.providerConfig,
    }));
  } finally {
    warnSpy.mockRestore();
  }

  expect(outcome!.baseSnapshotId).toBe('');
  const [row] = await withSystemDbAccessContext(() => db.select().from(backupJobs).where(eq(backupJobs.id, ctx.dispatchJobId)));
  expect(row!.baseSnapshotId).toBeNull();
  expect(warnings.find((w) => w.includes('will upload a FULL copy'))).toContain('reason=key_root_changed');
});

runDb('a retired prefixed snapshot\'s retirement records its key root (#7081)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = await withSystemDbAccessContext(async () => {
    const c = await seed(unique);
    await snapshot(c, `prefixed-expired-${unique}`, 3 * DAY_MS, PREFIXED, new Date(Date.now() - 60 * 1000));
    await snapshot(c, `legacy-expired-${unique}`, 3 * DAY_MS, LEGACY, new Date(Date.now() - 60 * 1000));
    return c;
  });

  const result = await cleanupExpiredSnapshots(ctx.orgId);
  expect(result.deleted).toBe(2);
  expect(result.skippedUnsupportedLayout).toBe(0);

  const rows = await withSystemDbAccessContext(() =>
    db.select({ snapshotId: backupSnapshotRetirements.snapshotId, keyLayout: backupSnapshotRetirements.keyLayout, keyPrefix: backupSnapshotRetirements.keyPrefix })
      .from(backupSnapshotRetirements)
      .where(eq(backupSnapshotRetirements.storageIdentity, ctx.identity)));
  expect(rows.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId))).toEqual([
    { snapshotId: `legacy-expired-${unique}`, ...LEGACY },
    { snapshotId: `prefixed-expired-${unique}`, ...PREFIXED },
  ]);
});
