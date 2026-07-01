/**
 * Real-DB regression test for upsertCollector's ON CONFLICT arbiter.
 *
 * The 2026-06-29 self-hosted-controllers migration replaced the plain unique
 * index on unifi_collectors(integration_id, unifi_host_id) with a PARTIAL one
 * (WHERE unifi_host_id IS NOT NULL). Postgres cannot infer a partial unique
 * index from a bare column-list conflict target, so an upsert without the
 * matching index predicate fails at plan time with "there is no unique or
 * exclusion constraint matching the ON CONFLICT specification" — which broke
 * enabling deep telemetry for cloud collectors on every v0.88.0 install
 * (PUT /api/v1/unifi/collectors → 500).
 *
 * Drizzle-mocked unit tests can never catch this class of bug: arbiter-index
 * inference only happens inside a real Postgres planner. Hence this file.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';
import { devices } from '../../db/schema';
import { unifiIntegrations, unifiCollectors } from '../../db/schema/unifi';
import { upsertCollector, upsertSelfHostedController } from '../../services/unifi/unifiCollectorService';

async function seedCollectorFixture() {
  const db = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const unique = Math.random().toString(36).slice(2, 8);
  const [device] = await db
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `unifi-collector-agent-${unique}`,
      hostname: `unifi-collector-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  const [integration] = await db
    .insert(unifiIntegrations)
    .values({ partnerId: partner.id, apiKeyEncrypted: 'test-cloud-key' })
    .returning({ id: unifiIntegrations.id });
  return { org, site, device, integration };
}

describe('upsertCollector (cloud path, partial unique index arbiter)', () => {
  it('inserts a cloud collector row and updates it on re-upsert of the same (integration, host)', async () => {
    const { org, site, device, integration } = await seedCollectorFixture();

    const created = await upsertCollector(getTestDb(), {
      integrationId: integration.id,
      orgId: org.id,
      siteId: site.id,
      unifiHostId: 'host-abc',
      collectorDeviceId: device.id,
      controllerUrl: 'https://10.0.0.1',
      apiKey: 'local-api-key',
    });
    expect(created.unifiHostId).toBe('host-abc');
    expect(created.status).toBe('pending');

    // Re-enabling with changed settings must UPDATE the existing row, not
    // duplicate it — proving the partial index is actually used as arbiter.
    const updated = await upsertCollector(getTestDb(), {
      integrationId: integration.id,
      orgId: org.id,
      siteId: site.id,
      unifiHostId: 'host-abc',
      collectorDeviceId: device.id,
      controllerUrl: 'https://10.0.0.2',
      apiKey: 'rotated-key',
      pollIntervalSeconds: 120,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.controllerUrl).toBe('https://10.0.0.2');
    expect(updated.pollIntervalSeconds).toBe(120);

    const rows = await getTestDb()
      .select()
      .from(unifiCollectors)
      .where(eq(unifiCollectors.integrationId, integration.id));
    expect(rows).toHaveLength(1);
  });

  it('coexists with a self-hosted (null host id) collector on the same integration', async () => {
    const { org, site, device, integration } = await seedCollectorFixture();

    const selfHosted = await upsertSelfHostedController(getTestDb(), {
      integrationId: integration.id,
      orgId: org.id,
      siteId: site.id,
      collectorDeviceId: device.id,
      controllerUrl: 'https://192.168.1.1',
      apiKey: 'self-hosted-key',
    });
    expect(selfHosted.unifiHostId).toBeNull();

    const cloud = await upsertCollector(getTestDb(), {
      integrationId: integration.id,
      orgId: org.id,
      siteId: site.id,
      unifiHostId: 'host-xyz',
      collectorDeviceId: device.id,
      controllerUrl: 'https://192.168.1.1',
      apiKey: 'local-api-key',
    });
    expect(cloud.id).not.toBe(selfHosted.id);

    const rows = await getTestDb()
      .select()
      .from(unifiCollectors)
      .where(eq(unifiCollectors.integrationId, integration.id));
    expect(rows).toHaveLength(2);
  });
});
