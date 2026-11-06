/**
 * #11203, the service half of caughtQueryRequestTransaction.integration.test.ts:
 * services that catch a statement failure and hand back a result. Inside a held
 * context the transaction still rethrows that failure when it ends, so these
 * assert the commit, not only the returned value. A follow-up read and the
 * resolved context are what a poisoned transaction cannot deliver.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { canonicalizeUnifiResource, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import { currentUnifiCollectorTopology, loadUnifiCollector } from '../../services/topology/unifiAuthority';
import { contacts, manualAssets } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerFleetTools } from '../../services/aiToolsFleet';
import { registerPolicyPrereqTools } from '../../services/aiToolsPolicyPrereqs';
import { createManualAsset, updateManualAsset } from '../../services/manualAssetOps';
import { unifiTopologyAdvertisement } from '../../services/topology/unifiAuthority';
import { getTestDb } from './setup';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function toolsAuth(userId: string, partnerId: string, orgId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn): SQL => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'caught-query' },
  } as unknown as AuthContext;
}

describe('AI tool safeHandler maps a statement failure and the tool transaction still commits', () => {
  const TOO_LONG = 'x'.repeat(300);

  async function toolFixture() {
    const tenant = await createTopologyTenant();
    const user = await createUser({ partnerId: tenant.partnerId, orgId: tenant.orgId });
    return { tenant, auth: toolsAuth(user.id, tenant.partnerId, tenant.orgId) };
  }

  const runTool = async (register: (reg: Map<string, AiTool>) => void, name: string, orgId: string, input: Record<string, unknown>, auth: AuthContext) => {
    const reg = new Map<string, AiTool>();
    register(reg);
    return withDbAccessContext(orgContext(orgId), async () => {
      const raw = await reg.get(name)!.handler(input, auth);
      // A poisoned transaction fails this read with 25P02.
      const [check] = await db.execute(sql`SELECT 42 AS v`);
      return { out: JSON.parse(raw as string) as Record<string, unknown>, check };
    });
  };

  runDb('manage_backup_profiles: an over-long name answers an error envelope, not a thrown commit', async () => {
    const { tenant, auth } = await toolFixture();
    const { out, check } = await runTool(registerPolicyPrereqTools, 'manage_backup_profiles', tenant.orgId, {
      action: 'create', orgId: tenant.orgId, name: TOO_LONG, selections: { file: { enabled: true, paths: ['/data'] } },
    }, auth);
    // The sanitized thrown-error answer: the failure came from the insert, not validation.
    expect(String(out.error)).toMatch(/could not complete/i);
    expect(check).toMatchObject({ v: 42 });
  });

  runDb('manage_groups: an over-long name answers an error envelope, not a thrown commit', async () => {
    const { tenant, auth } = await toolFixture();
    const { out, check } = await runTool(registerFleetTools, 'manage_groups', tenant.orgId, {
      action: 'create', orgId: tenant.orgId, name: TOO_LONG, type: 'static',
    }, auth);
    // The sanitized thrown-error answer: an early refusal would read differently.
    expect(String(out.error)).toMatch(/could not complete/i);
    expect(check).toMatchObject({ v: 42 });
  });
});

describe('manual assets: a foreign assigned contact answers 400 through the commit', () => {
  async function contactInOtherOrg() {
    const tenant = await createTopologyTenant();
    const other = await createTopologyTenant();
    const [foreign] = await getTestDb().insert(contacts).values({ orgId: other.orgId, name: 'Foreign' }).returning({ id: contacts.id });
    return { tenant, foreignContactId: foreign!.id };
  }
  const access = (orgId: string) => ({ canAccessOrg: (id: string) => id === orgId });

  runDb('create', async () => {
    const { tenant, foreignContactId } = await contactInOtherOrg();
    const result = await withDbAccessContext(orgContext(tenant.orgId), () => createManualAsset({
      auth: access(tenant.orgId),
      actorUserId: null,
      data: { orgId: tenant.orgId, siteId: tenant.siteId, name: 'Printer', assignedContactId: foreignContactId } as never,
      siteAllowed: () => true,
      audit: () => {},
    }));
    expect(result).toMatchObject({ status: 400 });
    await expect(getTestDb().select().from(manualAssets).where(eq(manualAssets.orgId, tenant.orgId))).resolves.toHaveLength(0);
  });

  runDb('update', async () => {
    const { tenant, foreignContactId } = await contactInOtherOrg();
    const [asset] = await getTestDb().insert(manualAssets).values({ orgId: tenant.orgId, siteId: tenant.siteId, name: 'Printer', assetType: 'unknown' }).returning();
    const result = await withDbAccessContext(orgContext(tenant.orgId), () => updateManualAsset({
      auth: access(tenant.orgId),
      actorUserId: null,
      id: asset!.id,
      data: { assignedContactId: foreignContactId } as never,
      siteAllowed: () => true,
      audit: () => {},
    } as never));
    expect(result).toMatchObject({ status: 400 });
    const [row] = await getTestDb().select().from(manualAssets).where(eq(manualAssets.id, asset!.id));
    expect(row!.assignedContactId).toBeNull();
  });
});

describe('unifiTopologyAdvertisement degrades inside its savepoint', () => {
  runDb('a failed lookup answers "not advertised" and the agent request still commits', async () => {
    const tenant = await createTopologyTenant();
    const out = await withDbAccessContext(orgContext(tenant.orgId), async () => {
      // Drizzle's table names are unqualified, so with `public` off the search
      // path the collector lookup is a real statement failure (42P01).
      await db.execute(sql`SET LOCAL search_path TO pg_catalog`);
      const advert = await unifiTopologyAdvertisement(randomUUID(), randomUUID());
      const [check] = await db.execute(sql`SELECT 42 AS v`);
      return { advert, check };
    });
    expect(out.advert).toBeNull();
    expect(out.check).toMatchObject({ v: 42 });
  });
});

describe('adaptUnifiTopology maps lock contention to producer_busy inside its savepoint', () => {
  runDb('a locked device row rejects the resource and the ingest request still commits', async () => {
    const f = await topologyIngestFixture();
    const integrationId = randomUUID(), collectorId = randomUUID();
    const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
    await sys(async () => {
      await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${f.partnerId}::uuid, 'k')`);
      await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
        VALUES (${collectorId}::uuid, ${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'host:1', ${f.deviceId}::uuid, 'https://host-1', 'k')`);
      await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
        VALUES (${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'host:1', 'site-h')`);
    });
    const collector = (await sys(() => loadUnifiCollector(collectorId)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(f.deviceId, collector)))!;
    const resource = { ...structuredClone(vectors.vectors[0]!.report.resources.find(r => r.kind === 'device_list')!), controllerSiteId: 'site-h' } as UnifiResource;
    resource.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, resource)).digest('hex');
    const report = { ...structuredClone(vectors.vectors[0]!.report), producerEpoch: current.producerEpoch, snapshotId: randomUUID(), sequence: '1',
      capturedAt: new Date(Date.now() - 1000).toISOString(), captureAgeAtSendMs: 0, resources: [resource] } as UnifiTopologyV1;

    // A second connection holds the device row, so the ingest's FOR KEY SHARE NOWAIT fails with 55P03.
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const competitor = runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async () => {
      await db.execute(sql`SELECT id FROM devices WHERE id=${f.deviceId}::uuid FOR UPDATE`);
      locked();
      await held;
    })));
    await lockTaken;
    try {
      const out = await sys(async () => {
        const receipt = await adaptUnifiTopology(f.deviceId, collector, report);
        // A poisoned transaction fails this read with 25P02.
        const [check] = await db.execute(sql`SELECT 42 AS v`);
        return { receipt, check };
      });
      expect(out.receipt).toMatchObject({ accepted: false, resources: [{ controllerSiteId: 'site-h', accepted: false, reason: 'producer_busy' }] });
      expect(out.check).toMatchObject({ v: 42 });
    } finally {
      release();
      await competitor;
    }
  });
});
