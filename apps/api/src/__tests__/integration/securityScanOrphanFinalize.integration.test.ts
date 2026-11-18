/**
 * #10057: scheduled and manual (non-sweep) security scans the agent will never
 * answer are finalized by the sweep pump's tick, against real Postgres
 * (jobs/securityScanOrphanFinalize.ts).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, securityScans } from '../../db/schema';
import { pumpSweeps } from '../../jobs/securityScanSweepPump';
import { handleSecurityCommandResult } from '../../routes/agents/helpers';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/** Past the 720 + 65 minute clock. */
const OLD = sql`now() - interval '14 hours'`;
/** Well inside it. */
const RECENT = sql`now() - interval '1 hour'`;

async function seedDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  return { orgId: org.id, deviceId: device.id };
}

type CommandShape = {
  status: string;
  executedAt?: ReturnType<typeof sql> | null;
  result?: Record<string, unknown>;
};

async function insertCommand(deviceId: string, c: CommandShape): Promise<string> {
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status, executed_at, completed_at, result)
    VALUES (${deviceId}, 'security_scan', ${c.status}, ${c.executedAt ?? null},
            ${['pending', 'sent'].includes(c.status) ? null : sql`now()`},
            ${c.result ? JSON.stringify(c.result) : null}::jsonb)
    RETURNING id`);
  return row!.id;
}

async function insertScan(
  w: { orgId: string; deviceId: string },
  s: { status: 'queued' | 'running'; startedAt: ReturnType<typeof sql>; commandId?: string | null },
): Promise<string> {
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO security_scans (org_id, device_id, scan_type, status, started_at, command_id)
    VALUES (${w.orgId}, ${w.deviceId}, 'quick', ${s.status}, ${s.startedAt}, ${s.commandId ?? null})
    RETURNING id`);
  return row!.id;
}

async function statusOf(scanId: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ status: securityScans.status })
    .from(securityScans)
    .where(eq(securityScans.id, scanId));
  return row!.status;
}

const pump = () => pumpSweeps(new Date(), { enqueue: async () => {} });

describe('non-sweep scan finalize (#10057)', () => {
  it('undelivered command → expired, whether the scan is a queued manual row or a claimed running one', async () => {
    const w = await seedDevice();
    // The reaper's delivery clock: failed, never executed, server-timeout marker.
    const reaped = await insertCommand(w.deviceId, {
      status: 'failed',
      result: { status: 'timeout', clock: 'delivery', timedOutBy: 'server' },
    });
    const manual = await insertScan(w, { status: 'queued', startedAt: RECENT, commandId: reaped });
    const expiredCmd = await insertCommand(w.deviceId, { status: 'expired' });
    const scheduled = await insertScan(w, { status: 'running', startedAt: RECENT, commandId: expiredCmd });

    const result = await pump();
    expect(result.deviceScansFinalized).toBe(2);
    expect(result.finalized).toBe(0);
    expect(await statusOf(manual)).toBe('expired');
    expect(await statusOf(scheduled)).toBe('expired');
    expect((await pump()).deviceScansFinalized).toBe(0);
  });

  it('clock: delivered and silent past the ceiling → failed; recent, still pending, or unclaimed rows wait', async () => {
    const w = await seedDevice();
    const silent = await insertScan(w, {
      status: 'running',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, { status: 'sent', executedAt: OLD }),
    });
    // The server timed the command out (reopenable): the agent may still answer
    // until the scan clock runs out, then the row is failed.
    const serverTimedOut = await insertScan(w, {
      status: 'running',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, {
        status: 'failed',
        executedAt: OLD,
        result: { status: 'timeout', timedOutBy: 'server' },
      }),
    });
    const manualDelivered = await insertScan(w, {
      status: 'queued',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, { status: 'sent', executedAt: OLD }),
    });
    // A legacy running row (no command id) and one whose command row is gone fall back to started_at.
    const legacy = await insertScan(w, { status: 'running', startedAt: OLD });
    const commandGone = await insertScan(w, {
      status: 'running',
      startedAt: OLD,
      commandId: '00000000-0000-4000-8000-0000000000aa',
    });

    // Created long ago but delivered an hour ago: measured from delivery.
    const recentlyDelivered = await insertScan(w, {
      status: 'running',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, { status: 'sent', executedAt: RECENT }),
    });
    // A manual scan for an offline device: the command's own deliver_by owns it.
    const stillPending = await insertScan(w, {
      status: 'queued',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, { status: 'pending' }),
    });
    // Queued with no command yet: waiting for its claim job, not orphaned.
    const unclaimed = await insertScan(w, { status: 'queued', startedAt: OLD });

    const result = await pump();
    expect(result.deviceScansFinalized).toBe(5);
    for (const id of [silent, serverTimedOut, manualDelivered, legacy, commandGone]) {
      expect(await statusOf(id)).toBe('failed');
    }
    expect(await statusOf(recentlyDelivered)).toBe('running');
    expect(await statusOf(stillPending)).toBe('queued');
    expect(await statusOf(unclaimed)).toBe('queued');
    expect((await pump()).deviceScansFinalized).toBe(0);
  });

  it('never touches a sweep child or a finished scan', async () => {
    const w = await seedDevice();
    const [sweep] = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO security_scan_sweeps (org_id, group_id, dedupe_key, rule_set_ids, rule_set_pins, scan_type, scope,
                                        targeted_count, origin, expires_at)
      VALUES (${w.orgId}, gen_random_uuid(), ${'e'.repeat(64)}, ARRAY[gen_random_uuid()]::uuid[],
              ${JSON.stringify([{ id: '00000000-0000-4000-8000-0000000000bb', version: 1, sha256: 'a'.repeat(64) }])}::jsonb,
              'quick', '{"kind":"all"}'::jsonb, 1, 'web', now() + interval '1 hour')
      RETURNING id`);
    const sweepCmd = await insertCommand(w.deviceId, { status: 'sent', executedAt: RECENT });
    const [child] = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO security_scans (org_id, device_id, scan_type, status, started_at, command_id, sweep_id)
      VALUES (${w.orgId}, ${w.deviceId}, 'quick', 'running', ${RECENT}, ${sweepCmd}, ${sweep!.id}) RETURNING id`);
    const done = await insertScan(w, {
      status: 'running',
      startedAt: OLD,
      commandId: await insertCommand(w.deviceId, { status: 'sent', executedAt: OLD }),
    });
    await getTestDb().execute(sql`UPDATE security_scans SET status = 'completed' WHERE id = ${done}`);

    const result = await pump();
    expect(result.deviceScansFinalized).toBe(0);
    expect(await statusOf(child!.id)).toBe('running');
    expect(await statusOf(done)).toBe('completed');
  });

  it('a late agent result still lands on a scan the clock failed', async () => {
    const w = await seedDevice();
    const commandId = await insertCommand(w.deviceId, {
      status: 'failed',
      executedAt: OLD,
      result: { status: 'timeout', timedOutBy: 'server' },
    });
    const scanId = await insertScan(w, { status: 'running', startedAt: OLD, commandId });
    expect((await pump()).deviceScansFinalized).toBe(1);
    expect(await statusOf(scanId)).toBe('failed');

    const [command] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, commandId));
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        handleSecurityCommandResult(command!, {
          status: 'completed',
          stdout: JSON.stringify({ scanRecordId: scanId, scanType: 'quick', threatsFound: 0, threats: [] }),
          durationMs: 1000,
        }),
      ),
    );
    expect(await statusOf(scanId)).toBe('completed');
  });
});
