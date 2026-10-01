import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { closeDb, withDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import { devices, discoveredAssets, organizations, partners, topologyChangeOutbox, topologyManualNodes, topologyNodes, topologySiteState } from '../../db/schema';
import { readLegacyImportBootstrapFailure, readLegacyImportCheckpoint, LEGACY_CAPTURE_TABLES } from '../../services/topology/legacyImportState';
import { readTopologySiteSettings } from '../../services/topology/siteSettings';
import { runTopologyRepairTick } from '../../jobs/topologyOutboxWorker';
import { recordBootstrapFailure, resetTopologyBootstrapStateForTests, runTopologyBootstrapPass } from '../../jobs/topologyBootstrapPass';
import { createSite } from './db-utils';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

type Tenant = Awaited<ReturnType<typeof createTopologyTenant>>;
const ON = { topologyFeatureFlags: { materialization: true, ui: true } };

function context(t: Tenant, siteId = t.siteId) {
  return {
    scope: { orgId: t.orgId, siteId },
    auth: { user: { id: randomUUID(), email: 'topology@example.test' }, principal: { kind: 'user_session' }, token: { mfa: true },
      scope: 'organization', orgId: t.orgId, partnerId: t.partnerId, canAccessOrg: (id: string) => id === t.orgId } as AuthContext,
    permissions: { permissions: ['topology', 'devices'].flatMap(resource => ['read', 'write', 'execute'].map(action => ({ resource, action }))), scope: 'organization', orgId: t.orgId, partnerId: t.partnerId, roleId: randomUUID() } as UserPermissions,
  };
}
const uiCapability = (t: Tenant, siteId = t.siteId) =>
  withDbAccessContext(orgContext(t.orgId), async () => (await readTopologySiteSettings(context(t, siteId))).capabilities.ui);
const stateOf = async (scope: TopologyScope) =>
  (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)))[0];

async function seedLegacy(scope: TopologyScope) {
  const database = getTestDb();
  const [manual] = await database.insert(topologyManualNodes).values({ ...scope, label: 'Core', role: 'switch' }).returning();
  const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'managed', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
  await database.insert(discoveredAssets).values({ ...scope, ipAddress: '192.0.2.20', hostname: 'discovered', linkedDeviceId: device!.id, linkSource: 'manual' });
  return { manual: manual! };
}

/** The production cadence, compressed: bootstrap passes interleaved with repair ticks. */
async function runWorker(passes = 6) {
  for (let n = 0; n < passes; n++) {
    await runTopologyBootstrapPass();
    await runTopologyRepairTick();
  }
}

describe('automatic topology first-snapshot bootstrap (#7557)', () => {
  it('builds a site with legacy data once materialization is enabled, and never while it is off', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    const source = await seedLegacy(t);

    await runWorker(2);
    expect(readLegacyImportCheckpoint((await stateOf(t))?.effectiveSettings ?? {})).toBeNull();

    await getTestDb().update(organizations).set({ settings: ON }).where(eq(organizations.id, t.orgId));
    expect(await uiCapability(t)).toEqual({ available: false, reason: 'topology_preparing' });
    await runWorker();

    expect(readLegacyImportCheckpoint((await stateOf(t))!.effectiveSettings)?.status).toBe('complete');
    expect(await uiCapability(t)).toEqual({ available: true, reason: null });
    expect(await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id))).toHaveLength(1);
  });

  it('honors a partner-wide enable and covers a site created after the flag was turned on', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    await getTestDb().update(partners).set({ settings: ON }).where(eq(partners.id, t.partnerId));
    await runWorker(2);
    expect(await uiCapability(t)).toEqual({ available: true, reason: null });

    const later = await createSite({ orgId: t.orgId });
    await seedLegacy({ orgId: t.orgId, siteId: later.id });
    expect(await uiCapability(t, later.id)).toEqual({ available: false, reason: 'topology_preparing' });
    await runWorker();
    expect(await uiCapability(t, later.id)).toEqual({ available: true, reason: null });
  });

  it('an org-level off overrides a partner-level on', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    await getTestDb().update(partners).set({ settings: ON }).where(eq(partners.id, t.partnerId));
    await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: false } } }).where(eq(organizations.id, t.orgId));
    await runWorker(2);
    expect(await stateOf(t)).toBeUndefined();
  });

  it('treats incomplete capture as not yet eligible: no throw, no rows written, resumes after back-off', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    await getTestDb().update(organizations).set({ settings: ON }).where(eq(organizations.id, t.orgId));
    await getTestDb().execute(sql`ALTER TABLE topology_layout DISABLE TRIGGER topology_capture_legacy_change`);
    try {
      await expect(runTopologyBootstrapPass()).resolves.toBeUndefined();
      expect(await stateOf(t)).toBeUndefined();
      expect(await getTestDb().select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, t.siteId))).toHaveLength(0);
    } finally {
      await getTestDb().execute(sql`ALTER TABLE topology_layout ENABLE TRIGGER topology_capture_legacy_change`);
    }
    expect(LEGACY_CAPTURE_TABLES).toContain('topology_layout');
    resetTopologyBootstrapStateForTests(); // the in-process back-off elapsed
    await runWorker();
    expect(await uiCapability(t)).toEqual({ available: true, reason: null });
  });

  it('a recorded site failure backs off durably, surfaces as topology_import_failed, and never masks a staged import', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    await getTestDb().update(organizations).set({ settings: ON }).where(eq(organizations.id, t.orgId));
    await recordBootstrapFailure(t);
    await recordBootstrapFailure(t);
    const marker = readLegacyImportBootstrapFailure((await stateOf(t))!.effectiveSettings);
    expect(marker).toMatchObject({ status: 'failed', attempts: 2 });
    // second failure doubles the 15 min back-off
    expect(marker!.retryAfter - Date.now() / 1000).toBeGreaterThan(29 * 60);
    expect(await uiCapability(t)).toEqual({ available: false, reason: 'topology_import_failed' });

    await runWorker(2); // backed off: not selected
    expect(readLegacyImportCheckpoint((await stateOf(t))!.effectiveSettings)).toBeNull();

    // back-off elapsed → retried and built; the stale marker no longer matters
    await getTestDb().execute(sql`UPDATE topology_site_state SET effective_settings = jsonb_set(effective_settings, '{legacyImportBootstrap,retryAfter}', '0'::jsonb) WHERE site_id=${t.siteId}::uuid`);
    await runWorker();
    expect(await uiCapability(t)).toEqual({ available: true, reason: null });
    // a failure recorded after staging is ignored by the marker write
    await recordBootstrapFailure(t);
    expect(readLegacyImportBootstrapFailure((await stateOf(t))!.effectiveSettings)?.attempts).toBe(2);
  });

  it('a corrupt marker neither wedges the candidate query nor blocks the site', async () => {
    resetTopologyBootstrapStateForTests();
    const t = await createTopologyTenant();
    await getTestDb().update(organizations).set({ settings: ON }).where(eq(organizations.id, t.orgId));
    await getTestDb().insert(topologySiteState).values({ orgId: t.orgId, siteId: t.siteId, effectiveSettings: { legacyImportBootstrap: { retryAfter: 'soon', attempts: 'x' } } });
    await expect(runTopologyBootstrapPass()).resolves.toBeUndefined();
    await runWorker();
    expect(await uiCapability(t)).toEqual({ available: true, reason: null });
  });
});
