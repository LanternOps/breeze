/**
 * #11737 — observation retention against real Postgres, through the
 * unprivileged `breeze_app` pool (forced RLS). The first test proves the pool
 * really is subject to RLS, so a batch that forgot to elect system scope would
 * match zero rows here and fail every deletion assertion below.
 *
 * Both targets are loaded with `_ENFORCE=true` (set before import, hoisted), so
 * the enforce path deletes. The report path is the same run with
 * `forceReport: true`: it must delete nothing and count exactly the rows the
 * enforcing run then removes (one predicate, two modes).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.AGENT_HEALTH_OBSERVATION_RETENTION_ENFORCE = 'true';
  process.env.SOFTWARE_INVENTORY_OBSERVATION_RETENTION_ENFORCE = 'true';
});

import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

import { db, withDbAccessContext } from '../../db';
import {
  agentHealthObservations,
  deviceAgentHealthLatest,
  deviceSoftwareInventoryState,
  deviceVulnerabilities,
  softwareInventory,
  softwareInventoryObservations,
  vulnerabilities,
} from '../../db/schema';
import { runObservationRetention } from '../../jobs/observationRetention';
import type { RetentionTargetResult } from '../../jobs/retentionTarget';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();
const WINDOW = 90;
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS);
/** One hour either side of the cutoff: pins the strict `<`. */
const justPast = new Date(NOW - WINDOW * DAY_MS - HOUR_MS);
const justInside = new Date(NOW - WINDOW * DAY_MS + HOUR_MS);

function result(results: RetentionTargetResult[], table: string): RetentionTargetResult {
  const r = results.find((x) => x.table === table);
  if (!r) throw new Error(`no result for ${table}`);
  return r;
}
function eligible(r: RetentionTargetResult): number {
  if (r.mode !== 'report') throw new Error(`expected a report run, got ${r.mode}`);
  return r.eligible;
}
function enforced(r: RetentionTargetResult) {
  if (r.mode !== 'enforce') throw new Error(`expected an enforce run, got ${r.mode}`);
  return r;
}

describe('observation retention (#11737, real Postgres)', () => {
  let orgId: string;
  let deviceId: string;
  let otherDeviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Observation Retention Org' })).id;
    const site = await createSite({ orgId });
    deviceId = (await createDevice({ orgId, siteId: site.id })).id;
    otherDeviceId = (await createDevice({ orgId, siteId: site.id })).id;
  });

  it('control: the job pool is subject to forced RLS, so only a system-scoped batch can see these rows', async () => {
    const [role] = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    await health(deviceId, daysAgo(200));
    const outsideTenant = await withDbAccessContext(
      { scope: 'organization', orgId: randomUUID(), accessibleOrgIds: [] },
      () => db.select({ id: agentHealthObservations.id }).from(agentHealthObservations)
        .where(eq(agentHealthObservations.deviceId, deviceId)),
    );
    expect(outsideTenant).toHaveLength(0);
  });

  // ── agent_health_observations ────────────────────────────────────────────

  async function health(device: string, receivedAt: Date): Promise<string> {
    const [row] = await getTestDb().insert(agentHealthObservations).values({
      orgId,
      deviceId: device,
      schemaVersion: 1,
      agentVersion: '0.128.0',
      overall: 'healthy',
      metricsAvailable: true,
      components: {},
      // Unique per (device_id, observed_at); the agent clock is not what ages a row.
      observedAt: new Date(receivedAt.getTime() - 1000),
      receivedAt,
    }).returning({ id: agentHealthObservations.id });
    return row!.id;
  }

  async function pointLatest(device: string, observationId: string, receivedAt: Date) {
    await getTestDb().insert(deviceAgentHealthLatest).values({ deviceId: device, orgId, observationId, receivedAt });
  }

  async function survivingHealth(ids: string[]): Promise<Set<string>> {
    const rows = await getTestDb().select({ id: agentHealthObservations.id }).from(agentHealthObservations)
      .where(inArray(agentHealthObservations.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  describe('agent_health_observations', () => {
    it('deletes rows past the window in bounded batches, keeps rows inside it, and never the latest projection\'s row', async () => {
      const ids = {
        old300: await health(deviceId, daysAgo(300)),
        old200: await health(deviceId, daysAgo(200)),
        old120: await health(deviceId, daysAgo(120)),
        old95: await health(deviceId, daysAgo(95)),
        justPast: await health(deviceId, justPast),
        justInside: await health(deviceId, justInside),
        recent: await health(deviceId, daysAgo(1)),
        // A device that went offline long ago: its only (latest) row is past the
        // window and must survive, or the health tab and the AI tool lose it.
        offlineLatest: await health(otherDeviceId, daysAgo(200)),
        offlineOlder: await health(otherDeviceId, daysAgo(250)),
      };
      await pointLatest(deviceId, ids.recent, daysAgo(1));
      await pointLatest(otherDeviceId, ids.offlineLatest, daysAgo(200));
      const all = Object.values(ids);

      const report = result(await runObservationRetention({ batchSize: 2, maxBatches: 50, forceReport: true }), 'agent_health_observations');
      expect((await survivingHealth(all)).size).toBe(all.length);

      const run = enforced(result(await runObservationRetention({ batchSize: 2, maxBatches: 50 }), 'agent_health_observations'));
      const left = await survivingHealth(all);
      const deleted = ['old300', 'old200', 'old120', 'old95', 'justPast', 'offlineOlder'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      const kept = ['justInside', 'recent', 'offlineLatest'] as const;
      for (const k of kept) expect(left.has(ids[k]), `${k} should survive`).toBe(true);

      // Bounded: 6 rows at 2 per batch is 3 full batches plus the empty one that ends the loop.
      expect(run.affected).toBe(deleted.length);
      expect(run.batches).toBe(4);
      expect(run.hasMore).toBe(false);
      expect(eligible(report)).toBe(run.affected);

      // The projections still point at live rows.
      const latest = await getTestDb().select().from(deviceAgentHealthLatest)
        .where(inArray(deviceAgentHealthLatest.deviceId, [deviceId, otherDeviceId]));
      expect(new Map(latest.map((r) => [r.deviceId, r.observationId]))).toEqual(
        new Map([[deviceId, ids.recent], [otherDeviceId, ids.offlineLatest]]),
      );
    });

    it('stops at maxBatches and reports hasMore; the next run takes the rest', async () => {
      const old = [];
      for (let i = 0; i < 5; i += 1) old.push(await health(deviceId, daysAgo(100 + i)));

      const first = enforced(result(await runObservationRetention({ batchSize: 2, maxBatches: 1 }), 'agent_health_observations'));
      expect(first).toMatchObject({ affected: 2, batches: 1, hasMore: true });
      expect((await survivingHealth(old)).size).toBe(3);

      const second = enforced(result(await runObservationRetention({ batchSize: 2, maxBatches: 10 }), 'agent_health_observations'));
      expect(second.affected).toBe(3);
      expect(second.hasMore).toBe(false);
      expect((await survivingHealth(old)).size).toBe(0);
    });
  });

  // ── software_inventory_observations ──────────────────────────────────────

  async function softwareObservation(device: string, receivedAt: Date): Promise<string> {
    const id = randomUUID();
    await getTestDb().insert(softwareInventoryObservations).values({
      id,
      orgId,
      deviceId: device,
      schemaVersion: 2,
      collectorVersion: '0.128.0',
      agentVersion: '0.128.0',
      observedAt: receivedAt,
      receivedAt,
      completeness: 'complete',
      truncated: false,
      claimedItemCount: 0,
      actualItemCount: 0,
      expectedSources: ['windows:registry:hklm64'],
      succeededSources: ['windows:registry:hklm64'],
      failedSources: [],
      items: [],
      reportDigest: randomUUID().replaceAll('-', ''),
      acceptedForInventory: true,
      absenceResolutionEligible: true,
      reasonCode: 'accepted_complete',
      visibleItemCount: 0,
    });
    return id;
  }

  async function survivingSoftware(ids: string[]): Promise<Set<string>> {
    const rows = await getTestDb().select({ id: softwareInventoryObservations.id }).from(softwareInventoryObservations)
      .where(inArray(softwareInventoryObservations.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  describe('software_inventory_observations', () => {
    it('deletes unreferenced rows past the window and keeps every row another table still points at', async () => {
      const ids = {
        oldUnreferenced: await softwareObservation(deviceId, daysAgo(200)),
        oldUnreferenced2: await softwareObservation(deviceId, daysAgo(150)),
        justPast: await softwareObservation(deviceId, justPast),
        justInside: await softwareObservation(deviceId, justInside),
        // Each pointer of the device's state row, on a row past the window.
        stateLatest: await softwareObservation(deviceId, daysAgo(120)),
        stateAccepted: await softwareObservation(deviceId, daysAgo(130)),
        stateVisible: await softwareObservation(deviceId, daysAgo(140)),
        // Projection lineage and vulnerability resolution evidence.
        projectionLineage: await softwareObservation(otherDeviceId, daysAgo(300)),
        vulnResolution: await softwareObservation(otherDeviceId, daysAgo(310)),
        otherOld: await softwareObservation(otherDeviceId, daysAgo(320)),
      };
      await getTestDb().insert(deviceSoftwareInventoryState).values({
        deviceId,
        orgId,
        latestObservationId: ids.stateLatest,
        latestAcceptedObservationId: ids.stateAccepted,
        visibleObservationId: ids.stateVisible,
        hasAcceptedV2: true,
        visibleItemCount: 0,
      });
      await getTestDb().insert(softwareInventory).values({
        deviceId: otherDeviceId,
        orgId,
        name: 'Retention Test App',
        observationId: ids.projectionLineage,
      });
      const [catalog] = await getTestDb().insert(vulnerabilities).values({
        cveId: `CVE-2099-${randomUUID().slice(0, 8)}`,
        source: 'test',
        description: 'observation retention',
        rawPayload: {},
      }).returning({ id: vulnerabilities.id });
      await getTestDb().insert(deviceVulnerabilities).values({
        orgId,
        deviceId: otherDeviceId,
        vulnerabilityId: catalog!.id,
        status: 'resolved',
        detectedAt: daysAgo(400),
        resolvedAt: daysAgo(310),
        resolvedObservationId: ids.vulnResolution,
      });
      const all = Object.values(ids);

      const report = result(await runObservationRetention({ batchSize: 2, maxBatches: 50, forceReport: true }), 'software_inventory_observations');
      expect((await survivingSoftware(all)).size).toBe(all.length);

      const run = enforced(result(await runObservationRetention({ batchSize: 2, maxBatches: 50 }), 'software_inventory_observations'));
      const left = await survivingSoftware(all);
      const deleted = ['oldUnreferenced', 'oldUnreferenced2', 'justPast', 'otherOld'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      const kept = ['justInside', 'stateLatest', 'stateAccepted', 'stateVisible', 'projectionLineage', 'vulnResolution'] as const;
      for (const k of kept) expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      expect(run.affected).toBe(deleted.length);
      expect(eligible(report)).toBe(run.affected);

      // No ON DELETE SET NULL fired: every pointer is intact.
      const [state] = await getTestDb().select().from(deviceSoftwareInventoryState)
        .where(eq(deviceSoftwareInventoryState.deviceId, deviceId));
      expect(state).toMatchObject({
        latestObservationId: ids.stateLatest,
        latestAcceptedObservationId: ids.stateAccepted,
        visibleObservationId: ids.stateVisible,
      });
      const [projection] = await getTestDb().select({ observationId: softwareInventory.observationId })
        .from(softwareInventory).where(eq(softwareInventory.deviceId, otherDeviceId));
      expect(projection!.observationId).toBe(ids.projectionLineage);
      const [finding] = await getTestDb().select({ resolvedObservationId: deviceVulnerabilities.resolvedObservationId })
        .from(deviceVulnerabilities).where(eq(deviceVulnerabilities.deviceId, otherDeviceId));
      expect(finding!.resolvedObservationId).toBe(ids.vulnResolution);
    });

    it('a state row with NULL pointers shields only the row it does point at', async () => {
      // A device whose every report was rejected: latest set, accepted and visible NULL.
      const pointed = await softwareObservation(deviceId, daysAgo(200));
      const unpointed = await softwareObservation(deviceId, daysAgo(210));
      await getTestDb().insert(deviceSoftwareInventoryState).values({
        deviceId,
        orgId,
        latestObservationId: pointed,
        latestAcceptedObservationId: null,
        visibleObservationId: null,
        hasAcceptedV2: false,
        visibleItemCount: 0,
      });

      const run = enforced(result(await runObservationRetention({ batchSize: 2, maxBatches: 10 }), 'software_inventory_observations'));
      const left = await survivingSoftware([pointed, unpointed]);
      expect(left.has(pointed), 'the latest pointer should survive').toBe(true);
      expect(left.has(unpointed), 'an unpointed row on a NULL-pointer device should be deleted').toBe(false);
      expect(run.affected).toBe(1);
    });
  });
});
