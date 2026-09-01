import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { SoftwareInventoryObservationV2 } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  softwareInventory,
  vulnerabilities,
} from '../../db/schema';
import {
  ingestSoftwareInventoryReport,
  SoftwareInventoryObservationConflictError,
} from '../../services/softwareInventoryObservations';
import { deleteDeviceCascade } from '../../services/deviceDeletion';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seedFixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [deviceA, deviceB] = await getTestDb().insert(devices).values([
    { orgId: orgA.id, siteId: siteA.id, agentId: `inventory-a-${randomUUID()}`, hostname: 'inventory-a', osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.105.1', status: 'online' },
    { orgId: orgB.id, siteId: siteB.id, agentId: `inventory-b-${randomUUID()}`, hostname: 'inventory-b', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '0.105.1', status: 'online' },
  ]).returning({ id: devices.id, orgId: devices.orgId, agentVersion: devices.agentVersion });
  return { orgA, orgB, siteA, siteB, deviceA: deviceA!, deviceB: deviceB! };
}

function report(items: Array<{ name: string; version?: string; vendor?: string }>, overrides: Partial<SoftwareInventoryObservationV2> = {}): SoftwareInventoryObservationV2 {
  return {
    schemaVersion: 2,
    observationId: randomUUID(),
    collectorVersion: '0.105.1',
    observedAt: '2026-08-24T12:00:00.000Z',
    completeness: 'complete',
    expectedSources: ['windows:registry:hklm64'],
    succeededSources: ['windows:registry:hklm64'],
    failedSources: [],
    truncated: false,
    itemCount: items.length,
    items,
    ...overrides,
  };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try { await work(); return undefined; } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause ?? (error as { code?: string; message?: string });
  }
}

describe('software inventory observation storage', () => {
  runDb('forces direct-org RLS and prevents cross-tenant observation/state construction', async () => {
    const { orgA, orgB, deviceA, deviceB } = await seedFixture();
    const accepted = await ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'A' }]), receivedAt: new Date('2026-08-24T12:00:01Z') });
    const hidden = await withDbAccessContext(orgContext(orgB.id), () => db.execute(sql`SELECT id FROM software_inventory_observations WHERE id = ${accepted.observationId}::uuid`));
    expect(hidden).toHaveLength(0);

    const forged = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      INSERT INTO device_software_inventory_state (device_id, org_id)
      VALUES (${deviceB.id}::uuid, ${orgB.id}::uuid)
    `)));
    expect(forged?.code).toBe('42501');

    const policies = await getTestDb().execute(sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             array_agg(DISTINCT p.cmd ORDER BY p.cmd) AS commands
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relname IN ('software_inventory_observations', 'device_software_inventory_state')
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity ORDER BY c.relname
    `) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; commands: string[] }>;
    expect(policies).toHaveLength(2);
    for (const row of policies) {
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, commands: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] });
    }
  });

  runDb('keeps retained observation evidence immutable to the application role', async () => {
    const privileges = await getTestDb().execute(sql`
      SELECT
        has_table_privilege('breeze_app', 'public.software_inventory_observations', 'UPDATE') AS can_update,
        has_table_privilege('breeze_app', 'public.software_inventory_observations', 'TRUNCATE') AS can_truncate
    `) as unknown as Array<{ can_update: boolean; can_truncate: boolean }>;
    expect(privileges[0]).toEqual({ can_update: false, can_truncate: false });
  });

  runDb('is exact-retry idempotent, rejects collisions, and retains rejected evidence byte-identically', async () => {
    const { deviceA, deviceB } = await seedFixture();
    const racingReport = report([{ name: 'Race' }]);
    const collisionRace = await Promise.allSettled([
      ingestSoftwareInventoryReport({ device: deviceA, report: racingReport, receivedAt: new Date('2026-08-24T12:00:01Z') }),
      ingestSoftwareInventoryReport({ device: deviceB, report: racingReport, receivedAt: new Date('2026-08-24T12:00:01Z') }),
    ]);
    expect(collisionRace.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejectedRace = collisionRace.find((outcome) => outcome.status === 'rejected');
    expect(rejectedRace).toMatchObject({ reason: expect.any(SoftwareInventoryObservationConflictError) });

    const firstReport = report([{ name: 'Chrome', vendor: 'Google' }, { name: '7-Zip' }]);
    const first = await ingestSoftwareInventoryReport({ device: deviceA, report: firstReport, receivedAt: new Date('2026-08-24T12:01:00Z') });
    expect(first).toMatchObject({ acceptedForInventory: true, reasonCode: 'accepted_complete', visibleItemCount: 2 });
    const [chrome] = await getTestDb().select({ id: softwareInventory.id })
      .from(softwareInventory).where(and(
        eq(softwareInventory.deviceId, deviceA.id),
        eq(softwareInventory.name, 'Chrome'),
      )).limit(1);
    const [vulnerability] = await getTestDb().insert(vulnerabilities).values({
      cveId: `CVE-2099-${randomUUID().slice(0, 8)}`,
      source: 'test', description: 'inventory lineage test', rawPayload: {},
    }).returning({ id: vulnerabilities.id });
    const [finding] = await getTestDb().insert(deviceVulnerabilities).values({
      orgId: deviceA.orgId, deviceId: deviceA.id, vulnerabilityId: vulnerability!.id,
      softwareInventoryId: chrome!.id, detectedAt: new Date('2026-08-24T12:00:00Z'),
    }).returning({ id: deviceVulnerabilities.id });
    const retry = await ingestSoftwareInventoryReport({ device: deviceA, report: firstReport, receivedAt: new Date('2026-08-24T12:02:00Z') });
    expect(retry).toEqual(first);
    await expect(ingestSoftwareInventoryReport({ device: deviceA, report: { ...firstReport, items: [{ name: 'Different' }], itemCount: 1 }, receivedAt: new Date('2026-08-24T12:03:00Z') }))
      .rejects.toBeInstanceOf(SoftwareInventoryObservationConflictError);

    const before = await getTestDb().execute(sql`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text AS snapshot FROM software_inventory s WHERE device_id = ${deviceA.id}::uuid`) as unknown as Array<{ snapshot: string }>;
    const linkBefore = await getTestDb().execute(sql`SELECT software_inventory_id FROM device_vulnerabilities WHERE id = ${finding!.id}::uuid`) as unknown as Array<{ software_inventory_id: string | null }>;
    const partial = report([], { completeness: 'partial', expectedSources: ['a', 'b'], succeededSources: ['a'], failedSources: [{ source: 'b', code: 'command_failed' }] });
    const rejected = await ingestSoftwareInventoryReport({ device: deviceA, report: partial, receivedAt: new Date('2026-08-24T12:04:00Z') });
    expect(rejected.reasonCode).toBe('rejected_partial');
    const legacyEmpty = await ingestSoftwareInventoryReport({ device: deviceA, report: { software: [] }, receivedAt: new Date('2026-08-24T12:05:00Z') });
    expect(legacyEmpty.reasonCode).toBe('retained_legacy_empty');
    const after = await getTestDb().execute(sql`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text AS snapshot FROM software_inventory s WHERE device_id = ${deviceA.id}::uuid`) as unknown as Array<{ snapshot: string }>;
    expect(after[0]!.snapshot).toBe(before[0]!.snapshot);
    const linkAfter = await getTestDb().execute(sql`SELECT software_inventory_id FROM device_vulnerabilities WHERE id = ${finding!.id}::uuid`) as unknown as Array<{ software_inventory_id: string | null }>;
    expect(linkAfter[0]).toEqual(linkBefore[0]);

    const replacement = await ingestSoftwareInventoryReport({
      device: deviceA,
      report: report([{ name: 'Chrome', vendor: 'Google', version: '128' }]),
      receivedAt: new Date('2026-08-24T12:06:00Z'),
    });
    const relinked = await getTestDb().execute(sql`
      SELECT i.observation_id
      FROM device_vulnerabilities dv
      JOIN software_inventory i ON i.id = dv.software_inventory_id
      WHERE dv.id = ${finding!.id}::uuid
    `) as unknown as Array<{ observation_id: string }>;
    expect(relinked[0]!.observation_id).toBe(replacement.observationId);

    const erased = await ingestSoftwareInventoryReport({
      device: deviceA, report: report([]), receivedAt: new Date('2026-08-24T12:07:00Z'),
    });
    expect(erased).toMatchObject({ acceptedForInventory: true, visibleItemCount: 0 });
    const erasedState = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM software_inventory WHERE device_id = ${deviceA.id}::uuid) AS inventory_count,
        (SELECT software_inventory_id FROM device_vulnerabilities WHERE id = ${finding!.id}::uuid) AS link
    `) as unknown as Array<{ inventory_count: number; link: string | null }>;
    expect(erasedState[0]).toEqual({ inventory_count: 0, link: null });

    const evidence = await getTestDb().execute(sql`
      SELECT count(*)::int AS count FROM software_inventory_observations
      WHERE device_id IN (${deviceA.id}::uuid, ${deviceB.id}::uuid)
    `) as unknown as Array<{ count: number }>;
    expect(evidence[0]!.count).toBe(6);
  });

  runDb('uses receipt ordering and exact collapse threshold while allowing a source-set change', async () => {
    const { deviceA } = await seedFixture();
    const fifty = Array.from({ length: 50 }, (_, index) => ({ name: `App ${index}` }));
    await ingestSoftwareInventoryReport({ device: deviceA, report: report(fifty, { expectedSources: ['a'], succeededSources: ['a'] }), receivedAt: new Date('2026-08-24T13:00:00Z') });
    const collapsed = await ingestSoftwareInventoryReport({ device: deviceA, report: report(Array.from({ length: 4 }, (_, index) => ({ name: `Small ${index}` })), { expectedSources: ['a'], succeededSources: ['a'] }), receivedAt: new Date('2026-08-24T13:01:00Z') });
    expect(collapsed.reasonCode).toBe('rejected_count_collapse');
    const exact = await ingestSoftwareInventoryReport({ device: deviceA, report: report(Array.from({ length: 5 }, (_, index) => ({ name: `Ten ${index}` })), { expectedSources: ['a'], succeededSources: ['a'] }), receivedAt: new Date('2026-08-24T13:02:00Z') });
    expect(exact.reasonCode).toBe('accepted_complete');

    const sourceChanged = await ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'Only' }], { expectedSources: ['a', 'b'], succeededSources: ['a', 'b'] }), receivedAt: new Date('2026-08-24T13:03:00Z') });
    expect(sourceChanged.reasonCode).toBe('accepted_complete');
    const outOfOrder = await ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'Future observedAt is irrelevant' }], { observedAt: '2030-01-01T00:00:00Z' }), receivedAt: new Date('2026-08-24T12:59:59Z') });
    expect(outOfOrder.reasonCode).toBe('rejected_out_of_order');
  });

  runDb('permits org-only evidence restamp, rejects evidence mutation, and cascades device erasure', async () => {
    const { orgB, siteB, deviceA } = await seedFixture();
    const accepted = await ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'A' }]), receivedAt: new Date('2026-08-24T14:00:00Z') });
    const mutation = await causeOf(() => withSystemDbAccessContext(() => db.execute(sql`UPDATE software_inventory_observations SET reason_code = 'tampered' WHERE id = ${accepted.observationId}::uuid`)));
    expect(mutation?.code).toBe('42501');

    await withSystemDbAccessContext(() => db.execute(sql`UPDATE devices SET org_id = ${orgB.id}::uuid, site_id = ${siteB.id}::uuid WHERE id = ${deviceA.id}::uuid`));
    const moved = await getTestDb().execute(sql`
      SELECT o.org_id AS observation_org, s.org_id AS state_org, i.org_id AS inventory_org
      FROM software_inventory_observations o
      JOIN device_software_inventory_state s ON s.device_id = o.device_id
      JOIN software_inventory i ON i.device_id = o.device_id
      WHERE o.id = ${accepted.observationId}::uuid LIMIT 1
    `) as unknown as Array<{ observation_org: string; state_org: string; inventory_org: string }>;
    expect(moved[0]).toEqual({ observation_org: orgB.id, state_org: orgB.id, inventory_org: orgB.id });

    await getTestDb().transaction((tx) => deleteDeviceCascade(tx, deviceA.id));
    const remaining = await getTestDb().execute(sql`
      SELECT id FROM software_inventory_observations WHERE device_id = ${deviceA.id}::uuid
      UNION ALL SELECT device_id AS id FROM device_software_inventory_state WHERE device_id = ${deviceA.id}::uuid
      UNION ALL SELECT id FROM software_inventory WHERE device_id = ${deviceA.id}::uuid
    `);
    expect(remaining).toHaveLength(0);
  });

  runDb('serializes concurrent state decisions and coexists with a device update', async () => {
    const { deviceA } = await seedFixture();
    const outcomes = await Promise.allSettled([
      ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'First' }]), receivedAt: new Date('2026-08-24T15:00:00Z') }),
      ingestSoftwareInventoryReport({ device: deviceA, report: report([{ name: 'Second' }]), receivedAt: new Date('2026-08-24T15:00:01Z') }),
      withSystemDbAccessContext(() => db.execute(sql`UPDATE devices SET agent_version = '0.105.2', updated_at = now() WHERE id = ${deviceA.id}::uuid`)),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const state = await getTestDb().execute(sql`
      SELECT s.visible_item_count, o.received_at
      FROM device_software_inventory_state s
      JOIN software_inventory_observations o ON o.id = s.latest_observation_id
      WHERE s.device_id = ${deviceA.id}::uuid
    `) as unknown as Array<{ visible_item_count: number; received_at: Date }>;
    expect(state[0]!.visible_item_count).toBe(1);
    expect(new Date(state[0]!.received_at).toISOString()).toBe('2026-08-24T15:00:01.000Z');
  });
});
