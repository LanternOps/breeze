/**
 * Real-Postgres integration coverage for the EDR-aware Incidents feed
 * (`buildIncidentFeed`). Runs under vitest.integration.config.ts: code-under-
 * test reaches Postgres through the production `db` pool as the unprivileged
 * `breeze_app` role, so RLS org-isolation is genuinely enforced (the feed
 * calls are wrapped in `withDbAccessContext` to set the `breeze.*` GUCs the
 * org-scoped caller would carry in production).
 *
 * Seeding uses the superuser pool (`getTestDb()`), which bypasses RLS. Per
 * setup.ts cleanupDatabase() TRUNCATEs tenant tables on beforeEach, so each
 * test re-seeds fresh — no module-scope fixtures (see memory:
 * rls-forge-test-memoized-fixture-vacuous).
 *
 * Fixture topology (two tenants):
 *   partnerA → orgA   — carries the feed rows under test
 *   partnerB → orgB   — cross-tenant noise that must be excluded
 *
 * Coverage:
 *   (a) buildIncidentFeed executes against the real union query (this is the
 *       exact path that threw at query-build time before the `.as()` alias /
 *       ORDER BY fixes).
 *   (b) ordering is rank-asc (p1 first) then detectedAt-desc.
 *   (c) orgB rows are excluded for an orgA-scoped caller (RLS + app filter).
 *   (d) a huntress finding already promoted to an incident (matching
 *       source_type/source_ref) is suppressed from the finding legs.
 *
 * DEFERRED locally when no integration Postgres is reachable — `it.runIf`
 * gates every case on DATABASE_URL so the suite no-ops instead of failing.
 */
import './setup';
import { describe, expect, it, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';
import { withDbAccessContext } from '../../db';
import {
  devices,
  incidents,
  huntressIncidents,
  huntressIntegrations,
  s1Threats,
  s1Integrations,
} from '../../db/schema';
import { buildIncidentFeed, type IncidentFeedParams } from '../../routes/incidents.helpers';
import type { AuthContext } from '../../middleware/auth';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const FEED_PARAMS: IncidentFeedParams = { limit: 50, offset: 0, hasDevicesRead: true, allowedDeviceIds: null };

// Minimal org-scoped auth. buildIncidentFeed only reads scope/orgId via
// resolveOrgFilter; the rest of AuthContext is never touched on this path.
function orgAuth(orgId: string): AuthContext {
  return { scope: 'organization', orgId } as unknown as AuthContext;
}

// Run the feed with the same RLS GUCs an org-scoped caller carries in prod.
async function runFeed(orgId: string, params: IncidentFeedParams = FEED_PARAMS) {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: null,
      userId: null,
      currentPartnerId: null,
    },
    () => buildIncidentFeed(orgAuth(orgId), params)
  );
}

type Tenant = { partnerId: string; orgId: string; huntressIntegrationId: string; s1IntegrationId: string };

async function seedTenant(): Promise<Tenant> {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const [hInt] = await db
    .insert(huntressIntegrations)
    .values({ partnerId: partner.id, name: 'huntress', apiKeyEncrypted: 'enc' })
    .returning({ id: huntressIntegrations.id });
  const [sInt] = await db
    .insert(s1Integrations)
    .values({
      partnerId: partner.id,
      name: 's1',
      apiTokenEncrypted: 'enc',
      managementUrl: 'https://example.sentinelone.net',
    })
    .returning({ id: s1Integrations.id });

  return {
    partnerId: partner.id,
    orgId: org.id,
    huntressIntegrationId: hInt!.id,
    s1IntegrationId: sInt!.id,
  };
}

describe('buildIncidentFeed (real Postgres)', () => {
  let orgA: Tenant;
  let orgB: Tenant;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    orgA = await seedTenant();
    orgB = await seedTenant();
  });

  runDb('orders rank-asc then detectedAt-desc and excludes cross-tenant rows', async () => {
    const db = getTestDb();
    const T1 = new Date('2026-06-01T00:00:00Z'); // tracked (p3, rank 3)
    const T2 = new Date('2026-06-02T00:00:00Z'); // huntress critical (rank 1)
    const T3 = new Date('2026-06-03T00:00:00Z'); // s1 high (rank 2)

    // orgA rows across all three legs.
    await db.insert(incidents).values({
      orgId: orgA.orgId,
      title: 'Tracked A',
      classification: 'malware',
      severity: 'p3',
      status: 'detected',
      detectedAt: T1,
    });
    await db.insert(huntressIncidents).values({
      orgId: orgA.orgId,
      integrationId: orgA.huntressIntegrationId,
      huntressIncidentId: 'H-A-1',
      severity: 'critical',
      title: 'Huntress A',
      status: 'sent',
      reportedAt: T2,
      details: { portalUrl: 'https://huntress.io/a1' },
    });
    await db.insert(s1Threats).values({
      orgId: orgA.orgId,
      integrationId: orgA.s1IntegrationId,
      s1ThreatId: 'S-A-1',
      severity: 'high',
      threatName: 'S1 A',
      status: 'mitigated',
      detectedAt: T3,
    });

    // orgB cross-tenant noise (must never surface for an orgA caller).
    await db.insert(huntressIncidents).values({
      orgId: orgB.orgId,
      integrationId: orgB.huntressIntegrationId,
      huntressIncidentId: 'H-B-1',
      severity: 'critical',
      title: 'Huntress B',
      status: 'sent',
      reportedAt: T2,
    });

    const { rows, total } = await runFeed(orgA.orgId);

    // (a)+(b): three orgA rows, ordered by rank asc then detectedAt desc.
    expect(total).toBe(3);
    expect(rows.map((r) => r.source)).toEqual(['huntress', 's1', 'breeze']);
    expect(rows.map((r) => r.severity)).toEqual(['p1', 'p2', 'p3']);

    // (c): no orgB row leaks in.
    expect(rows.some((r) => r.sourceId === 'H-B-1')).toBe(false);
    expect(rows.every((r) => r.title !== 'Huntress B')).toBe(true);
  });

  runDb('suppresses a finding already promoted to an incident', async () => {
    const db = getTestDb();

    await db.insert(huntressIncidents).values({
      orgId: orgA.orgId,
      integrationId: orgA.huntressIntegrationId,
      huntressIncidentId: 'H-A-PROMOTED',
      severity: 'high',
      title: 'Promoted finding',
      status: 'sent',
      reportedAt: new Date('2026-06-05T00:00:00Z'),
    });
    // A tracked incident promoted FROM that finding (matching source link).
    await db.insert(incidents).values({
      orgId: orgA.orgId,
      title: 'Promoted incident',
      classification: 'malware',
      severity: 'p2',
      status: 'analyzing',
      detectedAt: new Date('2026-06-05T01:00:00Z'),
      sourceType: 'huntress_incident',
      sourceRef: 'H-A-PROMOTED',
    });

    const { rows } = await runFeed(orgA.orgId);

    // The huntress finding is suppressed; only the tracked incident remains.
    expect(rows.some((r) => r.kind === 'finding' && r.sourceId === 'H-A-PROMOTED')).toBe(false);
    expect(rows.some((r) => r.kind === 'tracked' && r.title === 'Promoted incident')).toBe(true);
  });

  // FIX 1 (CRITICAL): site-level RBAC on the EDR legs. A finding bound to a
  // device in a site OUTSIDE the caller's allowlist must be excluded, while a
  // provider-level (null-device) finding stays visible. Site is an app-layer
  // authz axis RLS does not defend, so the feed pushes the allowed-device-id
  // predicate (resolved by the route via resolveSiteAllowedDeviceIds) onto the
  // huntress/s1 legs. Here the caller is restricted to a site with no devices
  // (allowedDeviceIds = []), so only the null-device finding survives.
  runDb('excludes EDR findings on devices outside the caller site allowlist', async () => {
    const db = getTestDb();

    // A device in orgA's site that the site-restricted caller may NOT see.
    const site = await createSite({ orgId: orgA.orgId, name: 'Disallowed Site' });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: orgA.orgId,
        siteId: site!.id,
        agentId: `agent-${Date.now()}`,
        hostname: 'secret-host',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x64',
        agentVersion: '1.0.0',
      })
      .returning({ id: devices.id });

    // Device-bound finding (must be excluded) + provider-level finding (kept).
    await db.insert(huntressIncidents).values({
      orgId: orgA.orgId,
      integrationId: orgA.huntressIntegrationId,
      huntressIncidentId: 'H-A-DEVICE',
      severity: 'critical',
      title: 'Finding on secret-host',
      status: 'sent',
      deviceId: device!.id,
      reportedAt: new Date('2026-06-06T00:00:00Z'),
    });
    await db.insert(huntressIncidents).values({
      orgId: orgA.orgId,
      integrationId: orgA.huntressIntegrationId,
      huntressIncidentId: 'H-A-NODEVICE',
      severity: 'high',
      title: 'Provider-level finding',
      status: 'sent',
      reportedAt: new Date('2026-06-06T01:00:00Z'),
    });

    // Site-restricted caller with an empty allowed-device set.
    const { rows } = await runFeed(orgA.orgId, {
      ...FEED_PARAMS,
      hasDevicesRead: true,
      allowedDeviceIds: [],
    });

    expect(rows.some((r) => r.sourceId === 'H-A-DEVICE')).toBe(false);
    expect(rows.some((r) => r.sourceId === 'H-A-NODEVICE')).toBe(true);
  });
});
