/**
 * Real-PostgreSQL proof for discovered-asset monitoring mutation site scope.
 * The route runs as breeze_app inside an organization request context. The
 * deterministic move case holds the asset row in another transaction, moves it
 * from an allowed to a hidden site, then releases the route's SELECT FOR UPDATE.
 * A plain pre-check would read the stale allowed site and mutate the monitor;
 * the locked current-row check must instead deny with no monitor change.
 */
import './setup';

import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const orgId = c.req.header('x-org-id');
    const encodedSites = c.req.header('x-site-ceiling');
    c.set('auth', {
      user: { id: 'synthetic-site-actor' },
      scope: 'organization',
      partnerId: null,
      orgId,
      accessibleOrgIds: orgId ? [orgId] : [],
      canAccessOrg: (candidate: string) => candidate === orgId,
    });
    c.set('permissions', {
      allowedSiteIds: encodedSites === '__empty__' ? [] : (encodedSites?.split(',') ?? undefined),
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/redis', () => ({ isRedisAvailable: vi.fn(() => true) }));

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { discoveredAssets, networkMonitors, snmpDevices } from '../../db/schema';
import { monitoringRoutes } from '../../routes/monitoring';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const app = new Hono();
app.route('/monitoring', monitoringRoutes);

let fixture: Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const adminDb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const allowedSite = await createSite({ orgId: org.id });
  const hiddenSite = await createSite({ orgId: org.id });
  const [asset] = await adminDb.insert(discoveredAssets).values({
    orgId: org.id,
    siteId: allowedSite.id,
    ipAddress: '192.0.2.110',
    hostname: `monitor-${randomUUID().slice(0, 8)}`,
    approvalStatus: 'approved',
  }).returning();
  const [snmp] = await adminDb.insert(snmpDevices).values({
    orgId: org.id,
    assetId: asset.id,
    name: 'Synthetic monitor',
    ipAddress: '192.0.2.110',
    snmpVersion: 'v2c',
    community: 'synthetic-not-a-secret',
    isActive: true,
  }).returning();
  await adminDb.insert(networkMonitors).values({
    orgId: org.id,
    assetId: asset.id,
    name: 'Synthetic ping',
    monitorType: 'icmp_ping',
    target: '192.0.2.110',
    isActive: true,
  });

  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: null,
  };
  return { adminDb, org, allowedSite, hiddenSite, asset, snmp, context };
}

beforeEach(async () => {
  fixture = await seedFixture();
});

function patchMonitor(siteCeiling: string) {
  return withDbAccessContext(fixture.context, async () => app.request(
    `/monitoring/assets/${fixture.asset.id}/snmp`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-org-id': fixture.org.id,
        'x-site-ceiling': siteCeiling,
      },
      body: JSON.stringify({ isActive: false }),
    },
  ));
}

describe('monitoring asset mutations enforce current site as breeze_app', () => {
  it('allows the visible site, denies empty scope, and denies a concurrent move before mutation', async () => {
    const allowed = await patchMonitor(fixture.allowedSite.id);
    expect(allowed.status).toBe(200);

    await fixture.adminDb.update(snmpDevices)
      .set({ isActive: true })
      .where(eq(snmpDevices.id, fixture.snmp.id));
    const empty = await patchMonitor('__empty__');
    expect(empty.status).toBe(403);

    let releaseMove!: () => void;
    let movedAndLocked!: () => void;
    const releasePromise = new Promise<void>((resolve) => { releaseMove = resolve; });
    const lockedPromise = new Promise<void>((resolve) => { movedAndLocked = resolve; });
    const mover = fixture.adminDb.transaction(async (tx: any) => {
      await tx.select({ id: discoveredAssets.id })
        .from(discoveredAssets)
        .where(and(
          eq(discoveredAssets.id, fixture.asset.id),
          eq(discoveredAssets.orgId, fixture.org.id),
        ))
        .limit(1)
        .for('update');
      await tx.update(discoveredAssets)
        .set({ siteId: fixture.hiddenSite.id })
        .where(eq(discoveredAssets.id, fixture.asset.id));
      movedAndLocked();
      await releasePromise;
    });
    await lockedPromise;

    let requestSettled = false;
    const movedRequest = patchMonitor(fixture.allowedSite.id).finally(() => {
      requestSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(requestSettled, 'the route must wait for the current asset row').toBe(false);

    releaseMove();
    await mover;
    const deniedAfterMove = await movedRequest;
    expect(deniedAfterMove.status).toBe(403);

    const [monitor] = await fixture.adminDb.select({ isActive: snmpDevices.isActive })
      .from(snmpDevices)
      .where(eq(snmpDevices.id, fixture.snmp.id));
    expect(monitor?.isActive).toBe(true);
  });
});
