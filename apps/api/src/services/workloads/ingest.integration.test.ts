import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { workloadsReportSchema } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceWorkloadRuntimes, deviceWorkloads } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { ingestWorkloadsReport } from './ingest';
import { reportFixture, runtimeFixture, workloadFixture } from './testFixtures';

// Settings changes in these tests must take effect immediately.
vi.mock('../redis', () => ({ getRedis: () => null }));

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };
// Relative to real time: the ordering guard clamps a future collectedAt to receipt time.
const BASE = Date.now() - 3 * 3_600_000;
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
const wl = (id: string, over: Record<string, unknown> = {}) => workloadFixture({ workloadId: id, name: id, ...over });

async function fixture(opts: { enabled?: boolean } = {}) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-ingest',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const [policy] = await getTestDb().execute(
    sql`INSERT INTO configuration_policies(partner_id, name) VALUES (${partner.id}, ${'Workloads ' + randomUUID()}) RETURNING id`,
  );
  const [link] = await getTestDb().execute(
    sql`INSERT INTO config_policy_feature_links(config_policy_id, feature_type) VALUES (${String(policy!.id)}, 'workload_inventory') RETURNING id`,
  );
  const linkId = String(link!.id);
  await withDbAccessContext(system, () =>
    db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id, enabled) VALUES (${linkId}, ${opts.enabled ?? true})`),
  );
  await getTestDb().execute(
    sql`INSERT INTO config_policy_assignments(config_policy_id, level, target_id) VALUES (${String(policy!.id)}, 'partner'::config_assignment_level, ${partner.id})`,
  );
  const ctx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const send = (report: Record<string, unknown>, orgId = org.id, context = ctx) =>
    withDbAccessContext(context, () =>
      ingestWorkloadsReport({
        deviceId: device!.id,
        orgId,
        report: workloadsReportSchema.parse(report),
        receivedAt: new Date(),
      }),
    );
  const setEnabled = (enabled: boolean) =>
    withDbAccessContext(system, () =>
      db.execute(sql`UPDATE config_policy_workload_inventory_settings SET enabled = ${enabled} WHERE feature_link_id = ${linkId}`),
    );
  const workloads = () => getTestDb().select().from(deviceWorkloads).where(eq(deviceWorkloads.deviceId, device!.id));
  const runtimes = () => getTestDb().select().from(deviceWorkloadRuntimes).where(eq(deviceWorkloadRuntimes.deviceId, device!.id));
  const host = async () => {
    const [row] = await getTestDb().select({ hostsWorkloads: devices.hostsWorkloads, workloadRuntimes: devices.workloadRuntimes }).from(devices).where(eq(devices.id, device!.id));
    return row!;
  };
  return { org, other, device: device!, ctx, send, setEnabled, workloads, runtimes, host };
}

it('creates the runtime row, the workload rows and the host axis from a first report', async () => {
  const f = await fixture();
  const result = await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  expect(result).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'b']);
  expect(await f.runtimes()).toMatchObject([
    { runtime: 'docker', detection: 'present', collection: 'ok', complete: true, runtimeVersion: '27.1.1', observedCount: 2, reportedCount: 2 },
  ]);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('keeps row ids and first_seen_at stable across later reports and advances last_seen_at', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  const [before] = await f.workloads();
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a', { state: 'stopped' })] })] }));
  const [after] = await f.workloads();
  expect(after!.id).toBe(before!.id);
  expect(after!.firstSeenAt.getTime()).toBe(before!.firstSeenAt.getTime());
  expect(after!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before!.lastSeenAt.getTime());
  expect(after!.state).toBe('stopped');
});

it('replaces the set on an ok and complete report: inserts new, deletes vanished', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b'), wl('c')] })] }));
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('b'), wl('c'), wl('d')] })] }));
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['b', 'c', 'd']);
});

it('ignores a replayed or reordered report (older and equal collectedAt)', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(10), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  const older = await f.send(reportFixture({ collectedAt: at(5), runtimes: [runtimeFixture({ workloads: [wl('c')] })] }));
  const equal = await f.send(reportFixture({ collectedAt: at(10), runtimes: [runtimeFixture({ workloads: [wl('c')] })] }));
  expect(older.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect(equal.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'b']);
});

it('a failing driver leaves rows and last_success_at alone', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  const [ok] = await f.runtimes();
  await f.send(
    reportFixture({
      collectedAt: at(1),
      runtimes: [runtimeFixture({ collection: 'error', complete: false, error: 'socket busy', workloads: [], observedCount: 0 })],
    }),
  );
  expect((await f.workloads()).map((w) => w.workloadId)).toEqual(['a']);
  const [failed] = await f.runtimes();
  expect(failed).toMatchObject({ collection: 'error', lastError: 'socket busy', complete: false });
  expect(failed!.lastSuccessAt!.getTime()).toBe(ok!.lastSuccessAt!.getTime());
});

it('a policy-disabled report deletes rows and keeps the host axis', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.setEnabled(false);
  const result = await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  expect(result.runtimes).toEqual([{ runtime: 'docker', applied: true }]);
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toMatchObject([{ collection: 'disabled', detection: 'present', reportedCount: 0 }]);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('with no policy at all, enumeration is disabled (default off) but detection still sets the host axis', async () => {
  const f = await fixture({ enabled: false });
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('detection absent keeps the runtime row as absent, deletes its workloads and drops the host axis; a replayed older present report is then skipped', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.send(
    reportFixture({
      collectedAt: at(10),
      runtimes: [runtimeFixture({ detection: 'absent', collection: 'unavailable', complete: false, workloads: [], observedCount: 0 })],
    }),
  );
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toMatchObject([{ runtime: 'docker', detection: 'absent', collection: 'unavailable' }]);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
  const replay = await f.send(reportFixture({ collectedAt: at(5), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect(replay.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
});

it('a future-dated collectedAt does not block a later normal report', async () => {
  const f = await fixture();
  const future = new Date(Date.now() + 48 * 3_600_000).toISOString();
  await f.send(reportFixture({ collectedAt: future, runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  // A normal report stamped at its own send time: clamped to its (later) receipt time, so it is newer than the
  // first report's clamped time only if the clamp worked (an unclamped +48 h stored time would skip it).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const later = await f.send(reportFixture({ collectedAt: new Date().toISOString(), runtimes: [runtimeFixture({ workloads: [wl('b')] })] }));
  expect(later.runtimes).toEqual([{ runtime: 'docker', applied: true }]);
  expect((await f.workloads()).map((w) => w.workloadId)).toEqual(['b']);
});

it('detection unknown keeps the host-axis membership and the workload rows', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.send(
    reportFixture({
      collectedAt: at(1),
      runtimes: [runtimeFixture({ detection: 'unknown', collection: 'error', complete: false, error: 'busy', workloads: [], observedCount: 0 })],
    }),
  );
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
  expect(await f.workloads()).toHaveLength(1);
  expect(await f.runtimes()).toMatchObject([{ detection: 'unknown', collection: 'error' }]);
});

it('leaves a runtime the report does not mention untouched', async () => {
  const f = await fixture();
  await f.send(
    reportFixture({
      collectedAt: at(0),
      runtimes: [runtimeFixture({ workloads: [wl('a')] }), runtimeFixture({ runtime: 'hyperv', workloads: [wl('vm1', { kind: 'vm' })] })],
    }),
  );
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect((await f.workloads()).map((w) => `${w.runtime}:${w.workloadId}`).sort()).toEqual(['docker:a', 'hyperv:vm1']);
  expect((await f.host()).workloadRuntimes).toEqual(['docker', 'hyperv']);
});

it('a truncated report ages out stale rows and never deletes by absence', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  await getTestDb().execute(
    sql`UPDATE device_workloads SET last_seen_at = now() - interval '25 hours' WHERE device_id = ${f.device.id} AND workload_id = 'b'`,
  );
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ complete: false, observedCount: 9, workloads: [wl('c')] })] }));
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'c']);
});

it('serializes concurrent identical reports: exactly one is applied', async () => {
  const f = await fixture();
  const report = reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] });
  const results = await Promise.all([f.send(report), f.send(report)]);
  expect(results.map((r) => r.runtimes[0]!.applied).sort()).toEqual([false, true]);
  expect(await f.workloads()).toHaveLength(1);
});

it('writes nothing when the caller cannot see the device (resolver and ownership checks fail closed)', async () => {
  const f = await fixture();
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: f.other.id,
    accessibleOrgIds: [f.other.id],
    accessiblePartnerIds: [],
  };
  await expect(
    f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }), f.other.id, foreign),
  ).rejects.toThrow();
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
});
