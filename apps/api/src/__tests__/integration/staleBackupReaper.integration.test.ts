import './setup';

import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { reapStaleBackupJobs } from '../../jobs/staleCommandReaper';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Real-Postgres proof that the reaper's WHERE guard is honoured — the chainable
// Drizzle mock in the unit suite swallows `.where()`, so deleting the
// status='running' / inArray(status, in-flight) guards passes every unit test.
// This exercises the actual predicate: a terminal (completed) job is NOT reaped,
// while an in-flight stalled job IS. The device is left `offline` so the stall
// reap takes the no-stop-command branch (no Redis/command-queue dependency).
runDb('reaps an in-flight stalled backup job but leaves a terminal (completed) job untouched', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const staleProgress = new Date(Date.now() - 20 * 60 * 1000); // 20min > 15min stall window
  const started = new Date(Date.now() - 40 * 60 * 1000);

  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `Reap Partner ${unique}`, slug: `reap-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({ currencyCode: 'USD', partnerId: partner!.id, name: `Reap Org ${unique}`, slug: `reap-org-${unique}`, type: 'customer', status: 'active' })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Reap Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `reap-agent-${unique}`,
        hostname: `reap-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    const [config] = await db
      .insert(backupConfigs)
      .values({ orgId: org!.id, name: `Reap Config ${unique}`, type: 'file', provider: 'local', providerConfig: {} })
      .returning({ id: backupConfigs.id });

    const base = { orgId: org!.id, configId: config!.id, deviceId: device!.id, startedAt: started, lastProgressAt: staleProgress };
    const [runningJob] = await db
      .insert(backupJobs)
      .values({ ...base, status: 'running' })
      .returning({ id: backupJobs.id });
    const [completedJob] = await db
      .insert(backupJobs)
      .values({ ...base, status: 'completed', completedAt: new Date(Date.now() - 19 * 60 * 1000) })
      .returning({ id: backupJobs.id });

    return { runningJob: runningJob!.id, completedJob: completedJob!.id };
  });

  const reaped = await withSystemDbAccessContext(() => reapStaleBackupJobs());
  // Shared DB may have other stalled jobs; assert on our specific rows.
  expect(reaped).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const [runningRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ids.runningJob));
    expect(runningRow!.status).toBe('failed');
    expect(runningRow!.errorLog ?? '').toContain('[stale-backup-reaper]');

    const [completedRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ids.completedJob));
    // The terminal job MUST be untouched — if the status guard were dropped, the
    // reaper would clobber this completed job to failed.
    expect(completedRow!.status).toBe('completed');
    expect(completedRow!.errorLog ?? '').not.toContain('[stale-backup-reaper]');
  });
});

// #2798: a live agent (keepalive fresh) whose transfer counters stopped moving
// used to be unreapable, because the keepalive refreshed last_progress_at. The
// no-transfer rule keys on last_progress_at alone, with a window sized so a
// legitimately slow single large file is not killed.
runDb('reaps a live-but-wedged job on the no-transfer rule, but spares a live job that may still be uploading a large file', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fresh = new Date(Date.now() - 60 * 1000);
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const GiB = 1024 * 1024 * 1024;

  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `Wedge Partner ${unique}`, slug: `wedge-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({ currencyCode: 'USD', partnerId: partner!.id, name: `Wedge Org ${unique}`, slug: `wedge-org-${unique}`, type: 'customer', status: 'active' })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Wedge Site ${unique}` }).returning({ id: sites.id });
    // Offline status keeps the reap on the no-stop-command branch (no Redis);
    // the fresh keepalive keeps rule B (offline grace) from firing first.
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `wedge-agent-${unique}`,
        hostname: `wedge-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    const [config] = await db
      .insert(backupConfigs)
      .values({ orgId: org!.id, name: `Wedge Config ${unique}`, type: 'file', provider: 'local', providerConfig: {} })
      .returning({ id: backupConfigs.id });

    const base = {
      orgId: org!.id, configId: config!.id, deviceId: device!.id, status: 'running' as const,
      startedAt: threeHoursAgo, lastProgressAt: threeHoursAgo, lastKeepaliveAt: fresh,
    };
    // 1 GiB left: the 2h floor applies, 3h without a transfer is a wedge.
    const [wedged] = await db
      .insert(backupJobs)
      .values({ ...base, totalSize: 10 * GiB, transferredSize: 9 * GiB })
      .returning({ id: backupJobs.id });
    // 90 GiB left: at the 512 KiB/s floor rate one remaining file could still
    // legitimately be in flight after 3h, so this must be spared.
    const [bigFile] = await db
      .insert(backupJobs)
      .values({ ...base, totalSize: 100 * GiB, transferredSize: 10 * GiB })
      .returning({ id: backupJobs.id });
    return { wedged: wedged!.id, bigFile: bigFile!.id };
  });

  await withSystemDbAccessContext(() => reapStaleBackupJobs());

  await withSystemDbAccessContext(async () => {
    const [wedgedRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ids.wedged));
    expect(wedgedRow!.status).toBe('failed');
    expect(wedgedRow!.errorLog ?? '').toContain('no data transferred');

    const [bigRow] = await db.select().from(backupJobs).where(eq(backupJobs.id, ids.bigFile));
    expect(bigRow!.status).toBe('running');
  });
});
