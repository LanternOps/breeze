/**
 * Workload inventory W06 (#8195) under real Postgres + forced RLS (the code
 * connects as breeze_app). Proves, for a real org's rows:
 *   - containerImageComplianceTerms: distinct repo:tag, replicas once, VM and
 *     pinned/local rows excluded, unknowns counted separately, other orgs and
 *     ephemeral devices never counted;
 *   - the image-currency pass maintains behind_since (set on first behind,
 *     kept while behind and across a transient error, cleared on current);
 *   - ingest clears behind_since on an image change, and retires an image's
 *     open alert only when a definitive snapshot drops its last reference;
 *   - the container_image_currency handler reads the stored columns.
 */
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { workloadsReportSchema } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { alerts, devices, deviceWorkloads } from '../../db/schema';
import { createOrganization, createPartner, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { runImageCurrencyPass } from '../imageCurrency/pass';
import { MEDIA_TYPE_DOCKER_MANIFEST, type RegistryClient, type RegistryLookupResult } from '../imageCurrency/registryClient';
import { containerImageCurrencyHandler } from '../alertConditions/handlers/containerImageCurrency';
import { containerImageComplianceTerms } from './imageCompliance';
import { ingestWorkloadsReport } from './ingest';
import { reportFixture, runtimeFixture, workloadFixture } from './testFixtures';

vi.mock('../redis', () => ({ getRedis: () => null }));

const D = (c: string) => `sha256:${c.repeat(64)}`;
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

async function fixture(name: string) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const mkDevice = async (hostname: string, over: Partial<typeof devices.$inferInsert> = {}) => {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1.0.0', ...over,
      })
      .returning();
    return device!;
  };
  const device = await mkDevice(name);
  const ctx: DbAccessContext = {
    scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], currentPartnerId: partner.id,
  };
  return { partner, org, site, device, mkDevice, ctx };
}

async function enableWorkloads(partnerId: string) {
  const [policy] = await getTestDb().execute(
    sql`INSERT INTO configuration_policies(partner_id, name) VALUES (${partnerId}, ${'Workloads ' + randomUUID()}) RETURNING id`,
  );
  const [link] = await getTestDb().execute(
    sql`INSERT INTO config_policy_feature_links(config_policy_id, feature_type) VALUES (${String(policy!.id)}, 'workload_inventory') RETURNING id`,
  );
  const linkId = String(link!.id);
  await withDbAccessContext(system, () =>
    db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id, enabled) VALUES (${linkId}, true)`),
  );
  await getTestDb().execute(
    sql`INSERT INTO config_policy_assignments(config_policy_id, level, target_id) VALUES (${String(policy!.id)}, 'partner'::config_assignment_level, ${partnerId})`,
  );
  return (enabled: boolean) =>
    withDbAccessContext(system, () =>
      db.execute(sql`UPDATE config_policy_workload_inventory_settings SET enabled = ${enabled} WHERE feature_link_id = ${linkId}`),
    );
}

async function addWorkload(orgId: string, deviceId: string, workloadId: string, over: Partial<typeof deviceWorkloads.$inferInsert> = {}) {
  await getTestDb().insert(deviceWorkloads).values({
    deviceId, orgId, runtime: 'docker', kind: 'container', workloadId, name: workloadId, state: 'running', ...over,
  });
}

const rowOf = async (deviceId: string, workloadId: string) =>
  (await getTestDb().select().from(deviceWorkloads)
    .where(and(eq(deviceWorkloads.deviceId, deviceId), eq(deviceWorkloads.workloadId, workloadId))))[0]!;

describe('containerImageComplianceTerms (real rows, forced RLS)', () => {
  it('counts distinct images per device, replicas once, unknowns apart, nothing outside the scope', async () => {
    const f = await fixture('terms');
    const run = randomUUID().slice(0, 8);
    const img = (repo: string, tag: string, upstreamStatus: string) => ({
      imageRef: `${repo}:${tag}`, imageRepository: repo, imageTag: tag, imageDigest: D('a'), upstreamStatus: upstreamStatus as never,
    });
    await addWorkload(f.org.id, f.device.id, 'n1', img(`nginx-${run}`, '1', 'behind'));
    await addWorkload(f.org.id, f.device.id, 'n2', img(`nginx-${run}`, '1', 'behind')); // replica
    await addWorkload(f.org.id, f.device.id, 'n3', { ...img(`nginx-${run}`, '1', 'behind'), runtime: 'podman' }); // same image, other runtime
    await addWorkload(f.org.id, f.device.id, 'r1', img(`redis-${run}`, '7', 'current'));
    await addWorkload(f.org.id, f.device.id, 'a1', img(`app-${run}`, '2', 'pending'));
    await addWorkload(f.org.id, f.device.id, 'p1', img(`priv-${run}`, '1', 'private'));
    await addWorkload(f.org.id, f.device.id, 'b1', img(`base-${run}`, '1', 'pinned'));
    await addWorkload(f.org.id, f.device.id, 'l1', img(`mine-${run}`, 'dev', 'local'));
    await addWorkload(f.org.id, f.device.id, 'g1', img(`gone-${run}`, '0', 'not_found'));
    await addWorkload(f.org.id, f.device.id, 'vm1', { runtime: 'proxmox', kind: 'vm', upstreamStatus: 'pending' });
    // Replica disagreement: one replica behind, one current → stale only.
    await addWorkload(f.org.id, f.device.id, 'm1', img(`mixed-${run}`, '3', 'behind'));
    await addWorkload(f.org.id, f.device.id, 'm2', img(`mixed-${run}`, '3', 'current'));
    // One checked current, one not yet checked → unknown, never current.
    await addWorkload(f.org.id, f.device.id, 'u1', img(`half-${run}`, '4', 'current'));
    await addWorkload(f.org.id, f.device.id, 'u2', img(`half-${run}`, '4', 'pending'));

    const ephemeral = await f.mkDevice('terms-ephemeral', { isEphemeral: true });
    await addWorkload(f.org.id, ephemeral.id, 'e1', img(`nginx-${run}`, '1', 'behind'));
    const bare = await f.mkDevice('terms-no-workloads');

    const other = await fixture('terms-other');
    await addWorkload(other.org.id, other.device.id, 'o1', img(`nginx-${run}`, '1', 'behind'));

    const byDevice = await withDbAccessContext(f.ctx, () =>
      containerImageComplianceTerms({ deviceIds: [f.device.id, bare.id, other.device.id] }));
    expect(byDevice.get(f.device.id)).toEqual({ stale: 2, current: 1, unknown: 3 });
    expect(byDevice.has(bare.id)).toBe(false);
    // Another org's device is invisible under this org's context (RLS).
    expect(byDevice.has(other.device.id)).toBe(false);

    const byOrg = await withDbAccessContext(f.ctx, () => containerImageComplianceTerms({ orgIds: [f.org.id] }));
    expect([...byOrg.keys()]).toEqual([f.device.id]); // ephemeral excluded
    expect(byOrg.get(f.device.id)).toEqual({ stale: 2, current: 1, unknown: 3 });

    const otherSite = await withDbAccessContext(f.ctx, () =>
      containerImageComplianceTerms({ orgIds: [f.org.id], siteIds: [randomUUID()] }));
    expect(otherSite.size).toBe(0);
    const ownSite = await withDbAccessContext(f.ctx, () =>
      containerImageComplianceTerms({ orgIds: [f.org.id], siteIds: [f.site.id] }));
    expect([...ownSite.keys()]).toEqual([f.device.id]);

    // A device parked in the partner's unassigned pool never counts, even when
    // the holding org is in the requested org list.
    const holding = (await createOrganization({
      partnerId: f.partner.id, name: 'Unassigned devices', slug: `unassigned-pool-${f.partner.id}`, type: 'unassigned_pool',
    }))!;
    const holdingSite = (await createSite({ orgId: holding.id }))!;
    const [parked] = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      return tx.insert(devices).values({
        orgId: holding.id, siteId: holdingSite.id, agentId: randomUUID(), hostname: 'terms-parked', osType: 'linux',
        osVersion: '1', architecture: 'x64', agentVersion: '1.0.0',
      }).returning();
    });
    await addWorkload(holding.id, parked!.id, 'pk1', img(`nginx-${run}`, '1', 'behind'));
    const withHolding = await withDbAccessContext(system, () =>
      containerImageComplianceTerms({ orgIds: [f.org.id, holding.id] }));
    expect([...withHolding.keys()]).toEqual([f.device.id]);
    // control: the parked device's rows are real and visible by device id
    const parkedById = await withDbAccessContext(system, () => containerImageComplianceTerms({ deviceIds: [parked!.id] }));
    expect(parkedById.get(parked!.id)).toEqual({ stale: 1, current: 0, unknown: 0 });
  });
});

describe('behind_since maintenance by the image-currency pass', () => {
  it('stamps on first behind, keeps it while behind and across an error, clears it on current', async () => {
    const f = await fixture('behind-since');
    const run = randomUUID().slice(0, 8);
    const repo = `ghcr.io/acme/bs-${run}`;
    await addWorkload(f.org.id, f.device.id, 'w', { imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a') });
    let answer: RegistryLookupResult = { kind: 'ok', digest: D('f'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
    const client: RegistryClient = { lookup: async () => answer, requestCount: () => 0 };
    const t0 = new Date(Date.now() - 30 * 86_400_000);
    // 7 h apart: the row is due again and the 6 h cache entry has expired.
    const at = (step: number) => new Date(t0.getTime() + step * 7 * 3_600_000);
    const pass = (step: number) => runImageCurrencyPass({ client, onlyOrgIds: [f.org.id], now: () => at(step) });

    await pass(0);
    expect(await rowOf(f.device.id, 'w')).toMatchObject({ upstreamStatus: 'behind', behindSince: at(0) });
    await pass(1);
    expect(await rowOf(f.device.id, 'w')).toMatchObject({ upstreamStatus: 'behind', behindSince: at(0) });
    answer = { kind: 'error', reason: 'timeout' };
    await pass(2);
    expect(await rowOf(f.device.id, 'w')).toMatchObject({ upstreamStatus: 'error', behindSince: at(0) });
    answer = { kind: 'ok', digest: D('f'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
    await pass(4);
    expect(await rowOf(f.device.id, 'w')).toMatchObject({ upstreamStatus: 'behind', behindSince: at(0) });

    // The handler measures the age from behind_since.
    const breach = await withDbAccessContext(f.ctx, () =>
      containerImageCurrencyHandler.evaluate({ type: 'container_image_currency', minDaysBehind: 7 }, f.device.id));
    expect(breach.subjects).toEqual([expect.objectContaining({ subjectKey: `${repo}:1`, status: 'breaching' })]);

    answer = { kind: 'ok', digest: D('a'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
    await pass(5);
    expect(await rowOf(f.device.id, 'w')).toMatchObject({ upstreamStatus: 'current', behindSince: null });
    const recovered = await withDbAccessContext(f.ctx, () =>
      containerImageCurrencyHandler.evaluate({ type: 'container_image_currency', minDaysBehind: 7 }, f.device.id));
    expect(recovered.subjects).toEqual([expect.objectContaining({ subjectKey: `${repo}:1`, status: 'recovered' })]);
  });
});

describe('ingest: behind_since reset and image alert retirement', () => {
  const BASE = Date.now() - 3 * 3_600_000;
  const atMin = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
  const wl = (id: string, repo: string, tag: string, over: Record<string, unknown> = {}) =>
    workloadFixture({ workloadId: id, name: id, imageRef: `${repo}:${tag}`, imageRepository: repo, imageTag: tag, ...over });

  async function setup(name: string) {
    const f = await fixture(name);
    const setEnabled = await enableWorkloads(f.partner.id);
    const send = (minute: number, runtime: Record<string, unknown>) =>
      withDbAccessContext(f.ctx, () =>
        ingestWorkloadsReport({
          deviceId: f.device.id,
          orgId: f.org.id,
          report: workloadsReportSchema.parse(reportFixture({ collectedAt: atMin(minute), runtimes: [runtimeFixture(runtime)] })),
          receivedAt: new Date(),
        }));
    const openAlert = async (subjectKey: string, source = 'container_image_currency') => {
      const [row] = await getTestDb().insert(alerts).values({
        orgId: f.org.id, deviceId: f.device.id, ruleId: null, subjectKey, severity: 'low', title: `t ${subjectKey}`,
        status: 'active', triggeredAt: new Date(), context: { source, subjectKey },
      }).returning({ id: alerts.id });
      return row!.id;
    };
    const statusOf = async (id: string) =>
      (await getTestDb().select({ status: alerts.status, reason: alerts.resolutionReason }).from(alerts).where(eq(alerts.id, id)))[0]!;
    const outboxFor = async (alertId: string) =>
      getTestDb().execute(sql`SELECT id FROM hardware_alert_retirement_outbox WHERE envelope->'payload'->>'alertId' = ${alertId}`);
    return { ...f, setEnabled, send, openAlert, statusOf, outboxFor };
  }

  it('clears behind_since when the image changes', async () => {
    const s = await setup('ingest-reset');
    await s.send(1, { workloads: [wl('w', 'nginx', '1.25')] });
    await getTestDb().update(deviceWorkloads)
      .set({ upstreamStatus: 'behind', upstreamCheckedAt: new Date(), behindSince: new Date(BASE) })
      .where(eq(deviceWorkloads.deviceId, s.device.id));
    // Same image re-reported: everything kept.
    await s.send(2, { workloads: [wl('w', 'nginx', '1.25')] });
    expect(await rowOf(s.device.id, 'w')).toMatchObject({ upstreamStatus: 'behind', behindSince: new Date(BASE) });
    // New digest: back to pending, behind_since cleared.
    await s.send(3, { workloads: [wl('w', 'nginx', '1.25', { imageDigest: D('9') })] });
    expect(await rowOf(s.device.id, 'w')).toMatchObject({ upstreamStatus: 'pending', behindSince: null, upstreamCheckedAt: null });
  });

  it('retires an image alert when a complete snapshot drops the last reference, and only that one', async () => {
    const s = await setup('ingest-retire');
    await s.send(1, { workloads: [wl('a', 'nginx', '1.25'), wl('b', 'nginx', '1.25'), wl('c', 'redis', '7')] });
    const nginx = await s.openAlert('nginx:1.25');
    const redis = await s.openAlert('redis:7');
    const foreign = await s.openAlert('nginx:1.25', 'hardware_health');

    // One nginx replica goes away: the image is still referenced.
    await s.send(2, { workloads: [wl('a', 'nginx', '1.25'), wl('c', 'redis', '7')] });
    expect((await s.statusOf(nginx)).status).toBe('active');

    // The last nginx container now runs a different tag: nginx:1.25 retires.
    await s.send(3, { workloads: [wl('a', 'nginx', '1.27'), wl('c', 'redis', '7')] });
    expect(await s.statusOf(nginx)).toEqual({ status: 'resolved', reason: 'source_retired' });
    expect(await s.outboxFor(nginx)).toHaveLength(1);
    expect((await s.statusOf(redis)).status).toBe('active');
    // An alert of another monitor kind with the same subject key is untouched.
    expect((await s.statusOf(foreign)).status).toBe('active');
  });

  it('never retires on an incomplete snapshot, even when age-out deletes the row', async () => {
    const s = await setup('ingest-incomplete');
    await s.send(1, { workloads: [wl('a', 'nginx', '1.25'), wl('c', 'redis', '7')] });
    const redis = await s.openAlert('redis:7');
    await getTestDb().update(deviceWorkloads)
      .set({ lastSeenAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(and(eq(deviceWorkloads.deviceId, s.device.id), eq(deviceWorkloads.workloadId, 'c')));
    await s.send(2, { complete: false, observedCount: 1, workloads: [wl('a', 'nginx', '1.25')] });
    expect((await getTestDb().select().from(deviceWorkloads).where(eq(deviceWorkloads.deviceId, s.device.id))).map((r) => r.workloadId))
      .toEqual(['a']);
    expect((await s.statusOf(redis)).status).toBe('active');
  });

  it('never retires on a failed collection', async () => {
    const s = await setup('ingest-failed');
    await s.send(1, { workloads: [wl('c', 'redis', '7')] });
    const redis = await s.openAlert('redis:7');
    await s.send(2, { collection: 'permission_denied', complete: false, error: 'denied', observedCount: 0, workloads: [] });
    expect((await s.statusOf(redis)).status).toBe('active');
  });

  it('retires when the policy turns collection off', async () => {
    const s = await setup('ingest-disabled');
    await s.send(1, { workloads: [wl('c', 'redis', '7')] });
    const redis = await s.openAlert('redis:7');
    await s.setEnabled(false);
    await s.send(2, { workloads: [wl('c', 'redis', '7')] });
    expect((await s.statusOf(redis)).status).toBe('resolved');
  });
});
