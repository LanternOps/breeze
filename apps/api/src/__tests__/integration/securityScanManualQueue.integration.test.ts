/**
 * #10057 gap 2: a manual "Scan now" goes through the capped dispatch claim,
 * against real Postgres. It waits in `queued` while the device is busy, can be
 * cancelled while it waits (or while its command is undelivered), and expires
 * at its queue expiry.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { deviceCommands, securityScans } from '../../db/schema';
import { claimAndDispatchScan } from '../../jobs/securityScanClaim';
import { pumpSweeps, type PumpDispatchJob } from '../../jobs/securityScanSweepPump';
import type { AuthContext } from '../../middleware/auth';
import { cancelDeviceScan, startDeviceScan } from '../../services/securityScanStart';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

async function seed(opts: { online?: boolean } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  await getTestDb().execute(sql`UPDATE devices SET agent_version = '0.124.0', status = ${opts.online === false ? 'offline' : 'online'}
                                 WHERE id = ${device.id}`);
  const user = await createUser({ partnerId: partner.id, email: `admin-${randomUUID()}@example.com` });
  await getTestDb().execute(sql`UPDATE users SET is_platform_admin = true WHERE id = ${user.id}`);
  const auth = {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: true },
    token: null,
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
  return { orgId: org.id, deviceId: device.id, auth };
}

const manualJob = (scanId: string) => ({ type: 'dispatch-scan' as const, scanId, origin: 'manual' as const });

async function scanRow(id: string) {
  const [row] = await getTestDb().select().from(securityScans).where(eq(securityScans.id, id));
  return row!;
}

async function commandCount(deviceId: string): Promise<number> {
  return (await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId))).length;
}

async function startScan(w: Awaited<ReturnType<typeof seed>>, over: { paths?: string[]; scanType?: 'quick' | 'custom' } = {}) {
  const started = await startDeviceScan(w.auth, {
    deviceId: w.deviceId, scanType: over.scanType ?? 'quick', paths: over.paths, mfaSatisfied: false,
  });
  if (!started.ok) throw new Error(started.error);
  return started.scan.id;
}

describe('Scan now through the dispatch caps (#10057 gap 2)', () => {
  it('waits while the device already runs a scan, dispatches once the slot frees, with its stored paths', async () => {
    const w = await seed();
    const [busy] = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO security_scans (org_id, device_id, scan_type, status, started_at)
      VALUES (${w.orgId}, ${w.deviceId}, 'quick', 'running', now()) RETURNING id`);

    const scanId = await startScan(w, { scanType: 'custom', paths: ['/srv'] });
    const queued = await scanRow(scanId);
    expect(queued).toMatchObject({ status: 'queued', commandId: null, paths: ['/srv'], callerMfaSatisfied: false });
    expect(queued.queueExpiresAt).toBeInstanceOf(Date);
    expect(await commandCount(w.deviceId)).toBe(0);

    expect(await claimAndDispatchScan(manualJob(scanId))).toMatchObject({ outcome: 'throttled', throttleReason: 'device cap 1' });
    expect((await scanRow(scanId)).status).toBe('queued');
    expect(await commandCount(w.deviceId)).toBe(0);

    await getTestDb().execute(sql`UPDATE security_scans SET status = 'completed', completed_at = now() WHERE id = ${busy!.id}`);
    expect((await claimAndDispatchScan(manualJob(scanId))).outcome).toBe('dispatched');
    const running = await scanRow(scanId);
    expect(running.status).toBe('running');
    const [cmd] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, running.commandId!));
    expect(cmd!.payload).toMatchObject({ scanRecordId: scanId, scanType: 'custom', paths: ['/srv'], timeoutMinutes: 720 });
  });

  it('a second Scan now on the same device is refused while the first waits', async () => {
    const w = await seed();
    const first = await startScan(w);
    expect(await startDeviceScan(w.auth, { deviceId: w.deviceId, scanType: 'full', mfaSatisfied: false })).toEqual({
      ok: false, status: 409, error: 'A scan is already queued for this device', scanId: first,
    });
  });

  it('cancel while waiting: the row is cancelled and a later claim does nothing', async () => {
    const w = await seed();
    const scanId = await startScan(w);
    expect(await cancelDeviceScan(w.auth, scanId)).toMatchObject({ ok: true, scan: { id: scanId, status: 'cancelled' } });
    expect((await scanRow(scanId)).status).toBe('cancelled');
    expect((await claimAndDispatchScan(manualJob(scanId))).outcome).toBe('skipped');
    expect(await commandCount(w.deviceId)).toBe(0);
  });

  it('cancel after dispatch to an offline device: the pending command is cancelled and the scan follows it', async () => {
    const w = await seed({ online: false });
    const scanId = await startScan(w);
    expect((await claimAndDispatchScan(manualJob(scanId))).outcome).toBe('dispatched');
    const { commandId } = await scanRow(scanId);
    expect(await cancelDeviceScan(w.auth, scanId)).toMatchObject({ ok: true });
    expect((await scanRow(scanId)).status).toBe('cancelled');
    const [cmd] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, commandId!));
    expect(cmd!.status).toBe('cancelled');
  });

  it('a delivered scan cannot be cancelled (409 SCAN_RUNNING)', async () => {
    const w = await seed();
    const scanId = await startScan(w);
    expect((await claimAndDispatchScan(manualJob(scanId))).outcome).toBe('dispatched');
    const { commandId } = await scanRow(scanId);
    await getTestDb().execute(sql`UPDATE device_commands SET status = 'sent', executed_at = now() WHERE id = ${commandId}`);
    expect(await cancelDeviceScan(w.auth, scanId)).toMatchObject({ ok: false, status: 409, code: 'SCAN_RUNNING' });
    expect((await scanRow(scanId)).status).toBe('running');
  });

  it('past its queue expiry: the claim expires it; the pump expires one whose job was lost and re-admits the rest', async () => {
    const w = await seed();
    const expiredByClaim = await startScan(w);
    await getTestDb().execute(sql`UPDATE security_scans SET queue_expires_at = now() - interval '1 minute' WHERE id = ${expiredByClaim}`);
    expect(await claimAndDispatchScan(manualJob(expiredByClaim))).toEqual({ outcome: 'expired', commandId: null });
    expect((await scanRow(expiredByClaim)).status).toBe('expired');

    const lost = await startScan(w);
    await getTestDb().execute(sql`UPDATE security_scans SET queue_expires_at = now() - interval '1 minute' WHERE id = ${lost}`);
    const other = await seed();
    const waiting = await startScan(other);

    const jobs: PumpDispatchJob[] = [];
    await pumpSweeps(new Date(), { enqueue: async (j) => { jobs.push(...j); } });
    expect((await scanRow(lost)).status).toBe('expired');
    expect(jobs).toContainEqual({ type: 'dispatch-scan', scanId: waiting, origin: 'manual' });
    expect(jobs.map((j) => j.scanId)).not.toContain(lost);
  });
});
