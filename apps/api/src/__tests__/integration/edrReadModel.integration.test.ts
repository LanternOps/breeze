/**
 * EDR provider framework W02 (#8166) — the shared read model against real
 * Postgres as the unprivileged `breeze_app` role.
 *
 * Pins the RLS reality the read model is designed around: an ORGANIZATION
 * token cannot read the partner-axis `edr_connections` / `edr_tenants`, so its
 * status comes from org-visible tables with an explicit partner-only note and
 * never errors; a PARTNER token sees tenant sync health, and a stale tenant
 * makes coverage partial. Also: the site rule and "empty is not clean".
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, edrConnections, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getEdrStatus, listEdrDetections, SYNC_HEALTH_PARTNER_ONLY_NOTE } from '../../services/edrProviders/read';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const admin = () => getTestDb() as typeof db;

function authFor(scope: 'organization' | 'partner', orgId: string, partnerId: string): AuthContext {
  return {
    scope,
    orgId: scope === 'organization' ? orgId : null,
    partnerId,
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: (col: never) => inArray(col, [orgId]),
  } as unknown as AuthContext;
}

async function seed() {
  const partner = await withSystemDbAccessContext(() => createPartner());
  return withSystemDbAccessContext(async () => {
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id });
    const siteB = await createSite({ orgId: org.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `edr-read-${randomUUID()}@example.com` });
    const mkDevice = async (siteId: string) => {
      const [d] = await admin().insert(devices).values({
        orgId: org.id, siteId, agentId: randomUUID(), hostname: `edr-read-${randomUUID().slice(0, 6)}`,
        osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
      }).returning({ id: devices.id });
      return d!.id;
    };
    const devA = await mkDevice(siteA!.id);
    const devB = await mkDevice(siteB!.id);
    const [conn] = await db.insert(edrConnections).values({
      partnerId: partner.id, provider: 'bitdefender', name: `GZ ${randomUUID().slice(0, 6)}`,
      credentialsEncrypted: 'enc:test', vendorRootId: 'root-1', vendorRootType: 'partner',
      effectiveDetectionIntervalMinutes: 15,
    }).returning({ id: edrConnections.id });
    const [tenant] = await db.insert(edrTenants).values({
      connectionId: conn!.id, partnerId: partner.id, vendorTenantId: `co-${randomUUID().slice(0, 8)}`,
      vendorTenantName: 'Vendor Tenant Name Must Not Leak', vendorTenantType: 'company', orgId: org.id, mappingSource: 'manual',
      // Stale: last detection sync 2 h ago with a 15 min interval.
      lastDetectionSyncAt: new Date(Date.now() - 2 * 3_600_000), lastDetectionSyncStatus: 'success',
    }).returning({ id: edrTenants.id });
    const mkEndpoint = async (deviceId: string | null) => {
      const [e] = await db.insert(edrEndpoints).values({
        connectionId: conn!.id, partnerId: partner.id, orgId: org.id, tenantId: tenant!.id, provider: 'bitdefender',
        vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`, hostname: 'WS', breezeDeviceId: deviceId, health: 'healthy',
      }).returning({ id: edrEndpoints.id });
      return e!.id;
    };
    await mkEndpoint(devA);
    await mkEndpoint(devB);
    const mkDetection = async (deviceId: string | null, title: string) => {
      const [d] = await db.insert(edrDetections).values({
        connectionId: conn!.id, partnerId: partner.id, orgId: org.id, tenantId: tenant!.id, provider: 'bitdefender',
        vendorDetectionId: `det-${randomUUID().slice(0, 8)}`, vendorKind: 'incident', severity: 'high', status: 'open',
        breezeDeviceId: deviceId, title, details: { secret: 'vendor-jsonb' },
      }).returning({ id: edrDetections.id });
      return d!.id;
    };
    const onA = await mkDetection(devA, 'on A');
    const onB = await mkDetection(devB, 'on B');
    const orgCtx: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: user.id };
    const partnerCtx: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: user.id };
    return { partner, org, siteA: siteA!, devA, onA, onB, orgCtx, partnerCtx, connectionId: conn!.id };
  });
}

describe('EDR read model (real Postgres, breeze_app)', () => {
  runDb('org token: status from org-visible tables only, no connection/tenant fields, partner-only note, no error', async () => {
    const fx = await seed();
    const status = await withDbAccessContext(fx.orgCtx, () =>
      getEdrStatus({ auth: authFor('organization', fx.org.id, fx.partner.id), allowedDeviceIds: null, allowedSiteIds: null }, {}));
    expect(status.providers).toHaveLength(1);
    expect(status.providers[0]).toMatchObject({ provider: 'bitdefender', endpoints: 2, linkedEndpoints: 2, openDetections: 2 });
    expect(status.providers[0]).not.toHaveProperty('connectionId');
    expect(status.providers[0]).not.toHaveProperty('tenantsStale');
    expect(status.coverage.notes).toContain(SYNC_HEALTH_PARTNER_ONLY_NOTE);
    expect(JSON.stringify(status)).not.toContain('Vendor Tenant Name');
  });

  runDb('partner token: sees tenant health; a stale tenant makes coverage partial', async () => {
    const fx = await seed();
    const status = await withDbAccessContext(fx.partnerCtx, () =>
      getEdrStatus({ auth: authFor('partner', fx.org.id, fx.partner.id), allowedDeviceIds: null, allowedSiteIds: null }, { orgId: fx.org.id }));
    expect(status.providers[0]).toMatchObject({ connectionId: fx.connectionId, tenantsMapped: 1, tenantsStale: 1 });
    expect(status.coverage.partial).toBe(true);
    expect(status.coverage.notes.join(' ')).toMatch(/not synced detections recently/);
    expect(JSON.stringify(status)).not.toContain('Vendor Tenant Name');
  });

  runDb('site-restricted list: only the allowed site; no vendor jsonb; org token omits connectionId', async () => {
    const fx = await seed();
    const out = await withDbAccessContext(fx.orgCtx, () => listEdrDetections(
      { auth: authFor('organization', fx.org.id, fx.partner.id), allowedDeviceIds: [fx.devA], allowedSiteIds: [fx.siteA.id] },
      { limit: 50, offset: 0 },
    ));
    expect(out.rows.map((r) => r.id)).toEqual([fx.onA]);
    expect(out.total).toBe(1);
    expect(out.rows[0]).not.toHaveProperty('connectionId');
    expect(JSON.stringify(out)).not.toContain('vendor-jsonb');
    expect(out.coverage).toBeDefined();
  });

  // #8166 review: status counts for a site-restricted caller exclude foreign-site linked rows.
  runDb('site-restricted status counts exclude another site\'s linked endpoints and detections', async () => {
    const fx = await seed();
    const status = await withDbAccessContext(fx.orgCtx, () => getEdrStatus(
      { auth: authFor('organization', fx.org.id, fx.partner.id), allowedDeviceIds: [fx.devA], allowedSiteIds: [fx.siteA.id] },
      {},
    ));
    expect(status.providers[0]).toMatchObject({ endpoints: 1, linkedEndpoints: 1, openDetections: 1 });
  });

  runDb('an empty result still carries coverage', async () => {
    const fx = await seed();
    const out = await withDbAccessContext(fx.orgCtx, () => listEdrDetections(
      { auth: authFor('organization', fx.org.id, fx.partner.id), allowedDeviceIds: null, allowedSiteIds: null },
      { status: 'resolved', limit: 50, offset: 0 },
    ));
    expect(out.rows).toEqual([]);
    expect(out.coverage.notes.length).toBeGreaterThan(0);
  });
});
