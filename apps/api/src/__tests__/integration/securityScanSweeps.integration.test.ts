/**
 * IOC sweeps against real Postgres (#6263 W05, migration
 * 2027-01-04-140000-security-scan-sweeps.sql).
 *
 * tenancy  — security_scan_sweeps RLS (shape 1) through breeze_app, the CHECKs,
 *            and the plain security_scans.sweep_id FK (ON DELETE SET NULL).
 * races    — the locked claim, cancel vs claim, finalize by command id, late
 *            results and pump re-admission, against real Postgres with the
 *            claim and the pump each in their own transaction.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, securityScans, securityScanSweeps } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { claimAndDispatchScan } from '../../jobs/securityScanClaim';
import { pumpSweeps, type SweepDispatchJob } from '../../jobs/securityScanSweepPump';
import { handleSecurityCommandResult } from '../../routes/agents/helpers';
import { cancelSweep } from '../../services/securityScanSweeps';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const as = <T>(ctx: DbAccessContext, fn: () => Promise<T>) => withDbAccessContext(ctx, fn);

const PIN = { id: randomUUID(), version: 1, sha256: 'a'.repeat(64) };

function sweepValues(orgId: string, overrides: Partial<typeof securityScanSweeps.$inferInsert> = {}) {
  return {
    orgId,
    groupId: randomUUID(),
    dedupeKey: 'b'.repeat(64),
    ruleSetIds: [PIN.id],
    ruleSetPins: [PIN],
    scanType: 'quick',
    scope: { kind: 'all' },
    targetedCount: 1,
    origin: 'web',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  } satisfies typeof securityScanSweeps.$inferInsert;
}

async function seedOrgs() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const deviceA = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, deviceA: deviceA.id };
}

async function insertSweep(orgId: string, overrides: Partial<typeof securityScanSweeps.$inferInsert> = {}) {
  return as(SYSTEM_CTX, async () => {
    const [row] = await db.insert(securityScanSweeps).values(sweepValues(orgId, overrides)).returning();
    return row!;
  });
}

describe('tenancy', () => {
  it('org A user cannot read org B sweep', async () => {
    const w = await seedOrgs();
    const sweepA = await insertSweep(w.orgA);
    const sweepB = await insertSweep(w.orgB);
    const seen = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.select({ id: securityScanSweeps.id }).from(securityScanSweeps),
    );
    expect(seen.map((r) => r.id)).toEqual([sweepA.id]);
    expect(seen.map((r) => r.id)).not.toContain(sweepB.id);

    // Nor update or delete it.
    const updated = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.update(securityScanSweeps).set({ state: 'cancelled' }).where(eq(securityScanSweeps.id, sweepB.id)).returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.delete(securityScanSweeps).where(eq(securityScanSweeps.id, sweepB.id)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  it('forged org-B insert under org-A breeze_app context fails WITH CHECK', async () => {
    const w = await seedOrgs();
    await expect(
      as(orgCtx(w.orgA, w.partnerId), () => db.insert(securityScanSweeps).values(sweepValues(w.orgB))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Moving an own row into another org is refused by the UPDATE WITH CHECK.
    const own = await insertSweep(w.orgA);
    await expect(
      as(orgCtx(w.orgA, w.partnerId), () =>
        db.update(securityScanSweeps).set({ orgId: w.orgB }).where(eq(securityScanSweeps.id, own.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('security_scans.sweep_id SET NULL on sweep delete', async () => {
    const w = await seedOrgs();
    const sweep = await insertSweep(w.orgA);
    const scanId = await as(SYSTEM_CTX, async () => {
      const [scan] = await db
        .insert(securityScans)
        .values({ orgId: w.orgA, deviceId: w.deviceA, scanType: 'quick', status: 'queued', sweepId: sweep.id })
        .returning({ id: securityScans.id });
      return scan!.id;
    });
    await as(SYSTEM_CTX, () => db.delete(securityScanSweeps).where(eq(securityScanSweeps.id, sweep.id)));
    const [scan] = await as(SYSTEM_CTX, () =>
      db.select({ sweepId: securityScans.sweepId }).from(securityScans).where(eq(securityScans.id, scanId)),
    );
    expect(scan).toEqual({ sweepId: null });
  });

  it("state CHECK rejects 'done'", async () => {
    const w = await seedOrgs();
    await expect(insertSweep(w.orgA, { state: 'done' })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('paths and origin CHECKs', async () => {
    const w = await seedOrgs();
    // custom without paths
    await expect(insertSweep(w.orgA, { scanType: 'custom' })).rejects.toMatchObject({ cause: { code: '23514' } });
    // quick with paths
    await expect(insertSweep(w.orgA, { paths: ['/tmp'] })).rejects.toMatchObject({ cause: { code: '23514' } });
    // custom with 21 paths
    await expect(
      insertSweep(w.orgA, { scanType: 'custom', paths: Array.from({ length: 21 }, (_, i) => `/p${i}`) }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    // unknown origin
    await expect(insertSweep(w.orgA, { origin: 'cron' })).rejects.toMatchObject({ cause: { code: '23514' } });
    // 0 and 21 rule sets
    await expect(insertSweep(w.orgA, { ruleSetIds: [] })).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      insertSweep(w.orgA, { ruleSetIds: Array.from({ length: 21 }, () => randomUUID()) }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    // the happy custom shape is accepted
    const ok = await insertSweep(w.orgA, { scanType: 'custom', paths: ['/tmp', 'C:\\Users'], origin: 'mcp' });
    expect(ok.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// races
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(64);

interface SweepWorld {
  partnerId: string;
  orgId: string;
  siteId: string;
  setId: string;
  sweepId: string;
  deviceIds: string[];
  scanIds: string[];
}

/**
 * Superuser seeding: an org with `devices` YARA-capable devices (online unless
 * told otherwise), one published org set, one active sweep pinning it, and a
 * queued sweep scan per device.
 */
async function seedSweepWorld(
  opts: { devices: number; online?: boolean; expiresInMs?: number } = { devices: 1 },
): Promise<SweepWorld> {
  const tdb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const deviceIds: string[] = [];
  for (let i = 0; i < opts.devices; i++) deviceIds.push((await createDevice({ orgId: org.id, siteId: site.id })).id);
  for (const id of deviceIds) {
    await tdb.execute(sql`UPDATE devices SET agent_version = '0.124.0', status = ${opts.online === false ? 'offline' : 'online'}
                           WHERE id = ${id}`);
  }
  const [set] = await tdb.execute<{ id: string }>(sql`
    INSERT INTO yara_rule_sets (org_id, name, current_version, published_version, published_bundle, published_sha256)
    VALUES (${org.id}, 'Hunt pack', 1, 1, decode('00', 'hex'), ${SHA}) RETURNING id`);
  const [sweep] = await tdb.execute<{ id: string }>(sql`
    INSERT INTO security_scan_sweeps (org_id, group_id, dedupe_key, rule_set_ids, rule_set_pins, scan_type, scope,
                                      targeted_count, origin, expires_at)
    VALUES (${org.id}, ${randomUUID()}, ${'d'.repeat(64)}, ARRAY[${set!.id}]::uuid[],
            ${JSON.stringify([{ id: set!.id, version: 1, sha256: SHA }])}::jsonb, 'quick', '{"kind":"all"}'::jsonb,
            ${deviceIds.length}, 'web', ${new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString()}::timestamptz)
    RETURNING id`);
  const scanIds: string[] = [];
  for (const deviceId of deviceIds) {
    const [scan] = await tdb.execute<{ id: string }>(sql`
      INSERT INTO security_scans (org_id, device_id, scan_type, status, started_at, sweep_id)
      VALUES (${org.id}, ${deviceId}, 'quick', 'queued', now(), ${sweep!.id}) RETURNING id`);
    scanIds.push(scan!.id);
  }
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, setId: set!.id, sweepId: sweep!.id, deviceIds, scanIds };
}

const sweepJob = (w: SweepWorld, i = 0) => ({
  type: 'dispatch-scan' as const,
  scanId: w.scanIds[i]!,
  origin: 'sweep' as const,
  sweepId: w.sweepId,
});

async function scanRow(scanId: string) {
  const [row] = await getTestDb().select().from(securityScans).where(eq(securityScans.id, scanId));
  return row!;
}

async function commandsFor(deviceIds: string[]) {
  return getTestDb().select().from(deviceCommands).where(inArray(deviceCommands.deviceId, deviceIds));
}

async function platformAdminAuth(partnerId: string): Promise<AuthContext> {
  const user = await createUser({ partnerId, email: `admin-${randomUUID()}@example.com` });
  await getTestDb().execute(sql`UPDATE users SET is_platform_admin = true WHERE id = ${user.id}`);
  return {
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
}

describe('races', () => {
  it('two concurrent claims at the org cap → one dispatch', async () => {
    const w = await seedSweepWorld({ devices: 3, online: false });
    // 39 running scans in the org, on a third device.
    await getTestDb().execute(sql`INSERT INTO security_scans (org_id, device_id, scan_type, status, started_at)
                                   SELECT ${w.orgId}::uuid, ${w.deviceIds[2]!}::uuid, 'quick', 'running', now()
                                     FROM generate_series(1, 39)`);

    const outcomes = await Promise.all([claimAndDispatchScan(sweepJob(w, 0)), claimAndDispatchScan(sweepJob(w, 1))]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['dispatched', 'throttled']);
    expect(await commandsFor([w.deviceIds[0]!, w.deviceIds[1]!])).toHaveLength(1);
    const statuses = [(await scanRow(w.scanIds[0]!)).status, (await scanRow(w.scanIds[1]!)).status].sort();
    expect(statuses).toEqual(['queued', 'running']);
  });

  it('cancel vs claim never leaves a delivered command for a cancelled sweep', async () => {
    for (let round = 0; round < 4; round++) {
      const w = await seedSweepWorld({ devices: 1, online: false });
      const auth = await platformAdminAuth(w.partnerId);
      const [claim, cancel] = await Promise.all([claimAndDispatchScan(sweepJob(w)), cancelSweep(auth, w.sweepId)]);
      expect(cancel.ok).toBe(true);
      const [sweep] = await getTestDb().select().from(securityScanSweeps).where(eq(securityScanSweeps.id, w.sweepId));
      expect(sweep!.state).toBe('cancelled');
      expect((await scanRow(w.scanIds[0]!)).status).toBe('cancelled');
      // Either cancelled before the claim (no command) or claimed and then the
      // command cancelled with it — never a live or delivered command.
      const cmds = await commandsFor(w.deviceIds);
      for (const cmd of cmds) {
        expect(cmd.status).toBe('cancelled');
        expect(cmd.executedAt).toBeNull();
      }
      expect(cmds.length).toBe(claim.outcome === 'dispatched' ? 1 : 0);
    }
  });

  it('command cancelled (payload erased) → finalize via command_id', async () => {
    const w = await seedSweepWorld({ devices: 1, online: false });
    const claim = await claimAndDispatchScan(sweepJob(w));
    expect(claim.outcome).toBe('dispatched');
    // A terminalization that erases the payload and propagates nothing (the
    // stale-command reaper's expiry): only security_scans.command_id links them.
    await getTestDb().execute(sql`UPDATE device_commands SET status = 'expired', payload = NULL, completed_at = now()
                                   WHERE id = ${claim.commandId!}`);
    expect((await scanRow(w.scanIds[0]!)).status).toBe('running');

    const pump = await pumpSweeps(new Date(), { enqueue: async () => {} });
    expect(pump.finalized).toBe(1);
    expect((await scanRow(w.scanIds[0]!)).status).toBe('expired');
  });

  it('late result after server timeout → completed', async () => {
    const w = await seedSweepWorld({ devices: 1, online: false });
    const claim = await claimAndDispatchScan(sweepJob(w));
    expect(claim.outcome).toBe('dispatched');
    // Delivered, then timed out by the server's 30-minute command clock.
    await getTestDb().execute(sql`UPDATE device_commands SET status = 'timeout', executed_at = now() - interval '31 minutes',
                                   completed_at = now() WHERE id = ${claim.commandId!}`);
    const pump = await pumpSweeps(new Date(), { enqueue: async () => {} });
    expect(pump.finalized).toBe(0);
    expect((await scanRow(w.scanIds[0]!)).status).toBe('running');

    const [command] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, claim.commandId!));
    await withSystemDbAccessContext(() =>
      handleSecurityCommandResult(command!, {
        status: 'completed',
        stdout: JSON.stringify({ scanRecordId: w.scanIds[0], scanType: 'quick', threatsFound: 0, threats: [], engine: 'yara' }),
        durationMs: 1000,
      }),
    );
    expect((await scanRow(w.scanIds[0]!)).status).toBe('completed');
  });

  it('Redis job lost → next pump re-admits', async () => {
    const w = await seedSweepWorld({ devices: 1 });
    const lost: SweepDispatchJob[] = [];
    const first = await pumpSweeps(new Date(), { enqueue: async (jobs) => { lost.push(...jobs); } });
    expect(first.admitted).toBe(1);
    // The job never reaches a worker: the row is still queued, so the next tick admits it again.
    expect((await scanRow(w.scanIds[0]!)).status).toBe('queued');
    const delivered: SweepDispatchJob[] = [];
    const second = await pumpSweeps(new Date(), { enqueue: async (jobs) => { delivered.push(...jobs); } });
    expect(second.admitted).toBe(1);
    expect(delivered).toEqual([{ type: 'dispatch-scan', scanId: w.scanIds[0], origin: 'sweep', sweepId: w.sweepId }]);
    expect((await claimAndDispatchScan(delivered[0]!)).outcome).toBe('dispatched');
    expect((await scanRow(w.scanIds[0]!)).status).toBe('running');
  });
});
