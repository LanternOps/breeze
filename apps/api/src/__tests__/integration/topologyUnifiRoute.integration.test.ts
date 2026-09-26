import './setup';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, type UnifiResource } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';

// Count every partner-axis flag read that actually reaches the database path.
// The #6671 wedge shape is this read running on a second pooled connection
// while the ingest transaction holds topology_site_state row locks.
const partnerAxisReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../db/partnerAxisRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/partnerAxisRead')>();
  return {
    ...actual,
    readWithPartnerAxisVisibility: async <T>(fn: () => Promise<T>) => {
      partnerAxisReads.count += 1;
      return actual.readWithPartnerAxisVisibility(fn);
    },
  };
});
vi.mock('../../jobs/unifiTelemetryWorker', () => ({ enqueueUnifiTelemetry: vi.fn(async () => undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { unifiTelemetryRoutes } from '../../routes/agents/unifiTelemetry';
import { currentUnifiCollectorTopology, loadUnifiCollector } from '../../services/topology/unifiAuthority';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
const vector = vectors.vectors[0]!;

describe('UniFi telemetry route topology companion (self-managed DB context)', () => {
  it('ingests a two-site report with one pre-transaction flag read and no nested partner-axis read', async () => {
    const f = await topologyIngestFixture();
    const siteB = (await createSite({ orgId: f.orgId })).id;
    const integrationId = crypto.randomUUID(), c1 = crypto.randomUUID(), c2 = crypto.randomUUID();
    await sys(async () => {
      await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${f.partnerId}::uuid, 'k')`);
      for (const [id, host] of [[c1, 'host:1'], [c2, 'host:2']] as const) {
        await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
          VALUES (${id}::uuid, ${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${host}, ${f.deviceId}::uuid, ${`https://${host.replace(':', '-')}`}, 'k')`);
      }
      await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
        VALUES (${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'host:1', 'site-a'),
               (${integrationId}::uuid, ${f.orgId}::uuid, ${siteB}::uuid, 'host:1', 'site-b'),
               (${integrationId}::uuid, ${f.orgId}::uuid, ${siteB}::uuid, 'host:2', 'site-c')`);
    });
    const current = (await sys(async () => currentUnifiCollectorTopology(f.deviceId, (await loadUnifiCollector(c1))!)))!;
    const deviceList = vector.report.resources.find(r => r.kind === 'device_list')!;
    const resources = (['site-a', 'site-b'] as const).map(controllerSiteId => ({ ...structuredClone(deviceList), controllerSiteId })) as UnifiResource[];
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, r)).digest('hex');
    const topologyV1 = { ...structuredClone(vector.report), producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence: '1',
      capturedAt: new Date(Date.now() - 1000).toISOString(), captureAgeAtSendMs: 0, resources };

    // Self-managed route: agentAuth opens NO request-long context (asserted in
    // agentAuth.test.ts), so the app below carries only the agent identity.
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: f.deviceId, agentId: 'agent-1', orgId: f.orgId, siteId: f.siteId, partnerId: f.partnerId, role: 'agent' } as never);
      return next();
    });
    app.route('/agents', unifiTelemetryRoutes);

    partnerAxisReads.count = 0;
    const res = await app.request('/agents/agent-1/unifi-telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectorId: c1, polledAt: new Date().toISOString(), firmwareOk: true, devices: [], clients: [], topologyV1 }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { topology: { accepted: boolean; resources: Array<{ controllerSiteId: string; accepted: boolean }> } };
    expect(body.topology.accepted).toBe(true);
    expect(body.topology.resources.map(r => [r.controllerSiteId, r.accepted])).toEqual([['site-a', true], ['site-b', true]]);
    // One flag resolution for the whole report, not one per resource plus the epoch check.
    expect(partnerAxisReads.count).toBe(1);
    const sites = await sys(() => db.execute(sql`SELECT site_id::text AS site_id FROM topology_collection_sources
      WHERE org_id=${f.orgId}::uuid AND producer_kind='unifi' AND revoked_at IS NULL ORDER BY site_id`));
    expect(sites.map(r => r.site_id).sort()).toEqual([f.siteId, siteB].sort());

    partnerAxisReads.count = 0;
    const list = await app.request('/agents/agent-1/unifi-collectors', { method: 'GET' });
    expect(list.status).toBe(200);
    const collectors = (await list.json() as { collectors: Array<{ collectorId: string; topologyProducerEpoch?: string }> }).collectors;
    expect(collectors).toHaveLength(2);
    expect(collectors.every(c => typeof c.topologyProducerEpoch === 'string')).toBe(true);
    // One flag resolution for every collector's advertisement.
    expect(partnerAxisReads.count).toBe(1);
  });
});
