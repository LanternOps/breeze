/**
 * Integration tests — monitoring, incident, analytics, device, integration
 * and script AI read tools.
 *
 * Real-Postgres, real-RLS proof (as the unprivileged `breeze_app` role via
 * `withDbAccessContext`) for the site- and org-scope behaviour of:
 *   - get_incident_timeline / generate_incident_report (aiToolsIncident.ts)
 *   - query_analytics action capacity_predictions (aiToolsAnalytics.ts)
 *   - get_executive_summary (aiToolsAnalytics.ts) — site-restricted refusal
 *     (`auth.allowedDeviceIds || auth.allowedSiteIds` both refuse)
 *   - list_remote_sessions (aiToolsRemote.ts)
 *   - query_agent_versions action check_upgrades (aiToolsAgentMgmt.ts)
 *   - query_custom_fields action get_device_values (aiToolsDevice.ts), plus a
 *     partner-scope caller exercising the partner branch of
 *     `customFieldDefinitionConditions` (action list_definitions)
 *   - get_script_details, execution-stats path, as a site-restricted caller
 *     (aiToolsScripts.ts)
 *
 * Pattern mirrors aiToolsAuditDetailsSiteScope.integration.test.ts: each tool
 * family registers into a local Map, seeds real rows as `breeze_app` so org
 * RLS is genuinely enforced, and asserts:
 *   (i)   a site-restricted caller gets no row / not-found for an
 *         out-of-site object;
 *   (ii)  the same caller sees the in-site object (non-vacuous control);
 *   (iii) a cross-org id/row is not found / not returned;
 *   (iv)  an unrestricted caller sees both.
 *
 * `get_executive_summary` has no site axis at all — it is a flat refusal
 * for any site- or device-scoped caller, not a narrowing, so that
 * case asserts "refused" vs "succeeds" rather than the (i)-(iv) shape.
 * `query_agent_versions:check_upgrades` and the `get_script_details`
 * execution-stats path are org-wide AGGREGATES (a count, not a row-by-id
 * lookup), so their (i)-(iv) analogue is the aggregate narrowing the count
 * rather than a not-found — each case is called out in its own comment.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import {
  devices,
  incidents,
  remoteSessions,
  agentVersions,
  customFieldDefinitions,
  scripts,
  scriptExecutions,
  capacityPredictions,
  executiveSummaries,
} from '../../db/schema';
import { createPartner, createOrganization, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { registerIncidentTools } from '../../services/aiToolsIncident';
import { registerAnalyticsTools } from '../../services/aiToolsAnalytics';
import { registerRemoteTools } from '../../services/aiToolsRemote';
import { registerAgentMgmtTools } from '../../services/aiToolsAgentMgmt';
import { registerDeviceTools } from '../../services/aiToolsDevice';
import { registerScriptTools } from '../../services/aiToolsScripts';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

function handlerFor(register: (m: Map<string, AiTool>) => void, name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  register(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool "${name}" not registered`);
  return tool.handler;
}

// Org-scope AuthContext. `allowedSiteIds` makes the caller site-restricted;
// omit it for an unrestricted caller. Optional `userId` lets a caller match a
// seeded row's ownership (list_remote_sessions is per-user-scoped).
function makeOrgAuth(
  orgId: string,
  opts: { allowedSiteIds?: string[]; userId?: string } = {},
): AuthContext {
  const { allowedSiteIds, userId } = opts;
  return {
    user: { id: userId ?? randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    // Real RLS (breeze_app, org-scoped db context) enforces the org axis; the
    // app-layer condition mirrors the pattern file and stays a no-op so the
    // test proves the REAL gate, not a mocked one.
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

// Partner-scope AuthContext for the query_custom_fields partner case: a
// partner user with "selected" org access (accessibleOrgIds narrower than
// every org the partner's RLS grant would otherwise admit).
function makePartnerAuth(partnerId: string, accessibleOrgIds: string[]): AuthContext {
  return {
    user: { id: randomUUID(), email: 'partner-op@example.com', name: 'Partner Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

async function seedDevice(
  orgId: string,
  siteId: string,
  overrides: Partial<typeof devices.$inferInsert> = {},
) {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      ...overrides,
    })
    .returning();
  return d!;
}

// ============================================================
// get_incident_timeline / generate_incident_report
// ============================================================

async function seedIncidentFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const org2 = await createOrganization({ partnerId: partner.id });
  const siteAllowed = await createSite({ orgId: org.id });
  const siteForbidden = await createSite({ orgId: org.id });
  const siteOther = await createSite({ orgId: org2.id });

  const devIn = await seedDevice(org.id, siteAllowed.id);
  const devOut = await seedDevice(org.id, siteForbidden.id);
  const devCrossOrg = await seedDevice(org2.id, siteOther.id);

  const now = new Date();
  const [incidentOut] = await getTestDb()
    .insert(incidents)
    .values({
      orgId: org.id,
      title: 'Out-of-site incident',
      classification: 'malware',
      severity: 'p2',
      status: 'detected',
      detectedAt: now,
      affectedDevices: [devOut.id],
    })
    .returning();
  const [incidentIn] = await getTestDb()
    .insert(incidents)
    .values({
      orgId: org.id,
      title: 'In-site incident',
      classification: 'phishing',
      severity: 'p3',
      status: 'detected',
      detectedAt: now,
      affectedDevices: [devIn.id],
    })
    .returning();
  const [incidentCrossOrg] = await getTestDb()
    .insert(incidents)
    .values({
      orgId: org2.id,
      title: 'Cross-org incident',
      classification: 'other',
      severity: 'p4',
      status: 'detected',
      detectedAt: now,
      affectedDevices: [devCrossOrg.id],
    })
    .returning();

  return { org, org2, siteAllowed, siteForbidden, devIn, devOut, incidentOut: incidentOut!, incidentIn: incidentIn!, incidentCrossOrg: incidentCrossOrg! };
}

describe('get_incident_timeline — site and cross-org scope', () => {
  it('denies out-of-site, allows in-site, denies cross-org; unrestricted sees both in-org incidents', async () => {
    const fx = await seedIncidentFixture();
    const handler = handlerFor(registerIncidentTools, 'get_incident_timeline');

    const restricted = makeOrgAuth(fx.org.id, { allowedSiteIds: [fx.siteAllowed.id] });
    const unrestricted = makeOrgAuth(fx.org.id);

    const call = (auth: AuthContext, incidentId: string) =>
      withDbAccessContext(
        { scope: 'organization', orgId: fx.org.id, accessibleOrgIds: [fx.org.id] },
        async () => handler({ incidentId }, auth),
      );

    // (i) out-of-site incident: denied for the site-restricted caller
    const outResult = JSON.parse(await call(restricted, fx.incidentOut.id));
    expect(outResult.error).toBeDefined();

    // (ii) in-site incident: visible to the same caller (non-vacuous control)
    const inResult = JSON.parse(await call(restricted, fx.incidentIn.id));
    expect(inResult.error).toBeUndefined();
    expect(inResult.incident.id).toBe(fx.incidentIn.id);

    // (iii) cross-org incident id: not found regardless of site restriction
    const crossOrgResultRestricted = JSON.parse(await call(restricted, fx.incidentCrossOrg.id));
    expect(crossOrgResultRestricted.error).toBeDefined();
    const crossOrgResultUnrestricted = JSON.parse(await call(unrestricted, fx.incidentCrossOrg.id));
    expect(crossOrgResultUnrestricted.error).toBeDefined();

    // (iv) unrestricted caller sees both in-org incidents
    const unrestrictedOut = JSON.parse(await call(unrestricted, fx.incidentOut.id));
    expect(unrestrictedOut.error).toBeUndefined();
    expect(unrestrictedOut.incident.id).toBe(fx.incidentOut.id);
    const unrestrictedIn = JSON.parse(await call(unrestricted, fx.incidentIn.id));
    expect(unrestrictedIn.error).toBeUndefined();
    expect(unrestrictedIn.incident.id).toBe(fx.incidentIn.id);
  });
});

describe('generate_incident_report — site and cross-org scope', () => {
  it('denies out-of-site, allows in-site, denies cross-org; unrestricted sees both in-org incidents', async () => {
    const fx = await seedIncidentFixture();
    const handler = handlerFor(registerIncidentTools, 'generate_incident_report');

    const restricted = makeOrgAuth(fx.org.id, { allowedSiteIds: [fx.siteAllowed.id] });
    const unrestricted = makeOrgAuth(fx.org.id);

    const call = (auth: AuthContext, incidentId: string) =>
      withDbAccessContext(
        { scope: 'organization', orgId: fx.org.id, accessibleOrgIds: [fx.org.id] },
        async () => handler({ incidentId }, auth),
      );

    // (i) out-of-site: denied
    const outResult = JSON.parse(await call(restricted, fx.incidentOut.id));
    expect(outResult.error).toBeDefined();

    // (ii) in-site: visible (non-vacuous control)
    const inResult = JSON.parse(await call(restricted, fx.incidentIn.id));
    expect(inResult.error).toBeUndefined();
    expect(inResult.report.incidentId).toBe(fx.incidentIn.id);

    // (iii) cross-org: not found
    const crossOrgResult = JSON.parse(await call(restricted, fx.incidentCrossOrg.id));
    expect(crossOrgResult.error).toBeDefined();

    // (iv) unrestricted sees both in-org incidents
    const unrestrictedOut = JSON.parse(await call(unrestricted, fx.incidentOut.id));
    expect(unrestrictedOut.error).toBeUndefined();
    expect(unrestrictedOut.report.incidentId).toBe(fx.incidentOut.id);
    const unrestrictedIn = JSON.parse(await call(unrestricted, fx.incidentIn.id));
    expect(unrestrictedIn.error).toBeUndefined();
    expect(unrestrictedIn.report.incidentId).toBe(fx.incidentIn.id);
  });
});

// ============================================================
// query_analytics action capacity_predictions
// ============================================================

describe('query_analytics action capacity_predictions — site and cross-org scope', () => {
  it('narrows to in-site device rows, excludes cross-org rows; unrestricted sees every in-org row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const siteOther = await createSite({ orgId: org2.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devCrossOrg = await seedDevice(org2.id, siteOther.id);

    const now = new Date();
    await getTestDb().insert(capacityPredictions).values([
      {
        orgId: org.id, deviceId: devIn.id, metricType: 'disk', metricName: 'disk_percent',
        currentValue: 50, predictedValue: 90, predictionDate: now, daysToThreshold: 10,
      },
      {
        orgId: org.id, deviceId: devOut.id, metricType: 'disk', metricName: 'disk_percent',
        currentValue: 55, predictedValue: 92, predictionDate: now, daysToThreshold: 20,
      },
      {
        orgId: org2.id, deviceId: devCrossOrg.id, metricType: 'disk', metricName: 'disk_percent',
        currentValue: 60, predictedValue: 95, predictionDate: now, daysToThreshold: 5,
      },
    ]);

    const handler = handlerFor(registerAnalyticsTools, 'query_analytics');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [siteAllowed.id] });
    const unrestricted = makeOrgAuth(org.id);

    const call = (auth: AuthContext) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({ action: 'capacity_predictions', limit: 100 }, auth),
      );

    const restrictedResult = JSON.parse(await call(restricted));
    const restrictedDeviceIds = (restrictedResult.capacityPredictions ?? []).map((r: any) => r.deviceId);
    // (i) out-of-site row excluded
    expect(restrictedDeviceIds).not.toContain(devOut.id);
    // (ii) in-site row included (non-vacuous control)
    expect(restrictedDeviceIds).toContain(devIn.id);
    // (iii) cross-org row never appears
    expect(restrictedDeviceIds).not.toContain(devCrossOrg.id);

    const unrestrictedResult = JSON.parse(await call(unrestricted));
    const unrestrictedDeviceIds = (unrestrictedResult.capacityPredictions ?? []).map((r: any) => r.deviceId);
    // (iv) unrestricted caller sees every in-org row, still no cross-org row
    expect(unrestrictedDeviceIds).toContain(devIn.id);
    expect(unrestrictedDeviceIds).toContain(devOut.id);
    expect(unrestrictedDeviceIds).not.toContain(devCrossOrg.id);
  });
});

// ============================================================
// get_executive_summary — no site axis; site-restricted callers are refused
// outright, not narrowed. Org-only otherwise.
// ============================================================

describe('get_executive_summary — site-restricted callers refused', () => {
  it('refuses a site-restricted caller and succeeds for an unrestricted one', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    const now = new Date();
    await getTestDb().insert(executiveSummaries).values({
      orgId: org.id,
      periodType: 'weekly',
      periodStart: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      periodEnd: now,
      generatedAt: now,
    });

    const handler = handlerFor(registerAnalyticsTools, 'get_executive_summary');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [site.id] });
    const unrestricted = makeOrgAuth(org.id);

    const call = (auth: AuthContext) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({}, auth),
      );

    // Refused outright — org-wide aggregate, no site axis to narrow by.
    const restrictedResult = JSON.parse(await call(restricted));
    expect(restrictedResult.error).toBeDefined();
    expect(restrictedResult.summary).toBeUndefined();

    // Unrestricted caller succeeds and sees the seeded summary.
    const unrestrictedResult = JSON.parse(await call(unrestricted));
    expect(unrestrictedResult.error).toBeUndefined();
    expect(unrestrictedResult.summary).toBeDefined();
    expect(unrestrictedResult.summary.periodType).toBe('weekly');
  });
});

// ============================================================
// list_remote_sessions
// ============================================================

describe('list_remote_sessions — site and cross-org scope', () => {
  it('narrows to in-site sessions, excludes cross-org sessions; unrestricted sees every in-org session', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const siteOther = await createSite({ orgId: org2.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devCrossOrg = await seedDevice(org2.id, siteOther.id);

    // list_remote_sessions restricts to the CALLER'S OWN sessions
    // (`auth.user.id`) for non-system scope, so every session here is owned
    // by the same caller identity used for both restricted and unrestricted
    // auth below.
    const caller = await createUser({ partnerId: partner.id, orgId: org.id });

    const [sessIn] = await getTestDb().insert(remoteSessions).values({
      deviceId: devIn.id, orgId: org.id, userId: caller.id, type: 'terminal', status: 'active',
    }).returning();
    const [sessOut] = await getTestDb().insert(remoteSessions).values({
      deviceId: devOut.id, orgId: org.id, userId: caller.id, type: 'terminal', status: 'active',
    }).returning();
    const [sessCrossOrg] = await getTestDb().insert(remoteSessions).values({
      deviceId: devCrossOrg.id, orgId: org2.id, userId: caller.id, type: 'terminal', status: 'active',
    }).returning();

    const handler = handlerFor(registerRemoteTools, 'list_remote_sessions');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [siteAllowed.id], userId: caller.id });
    const unrestricted = makeOrgAuth(org.id, { userId: caller.id });

    const call = (auth: AuthContext) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({ limit: 100 }, auth),
      );

    const restrictedResult = JSON.parse(await call(restricted));
    const restrictedIds = (restrictedResult.sessions ?? []).map((s: any) => s.id);
    // (i) out-of-site session excluded
    expect(restrictedIds).not.toContain(sessOut!.id);
    // (ii) in-site session included (non-vacuous control)
    expect(restrictedIds).toContain(sessIn!.id);
    // (iii) cross-org session never appears
    expect(restrictedIds).not.toContain(sessCrossOrg!.id);

    const unrestrictedResult = JSON.parse(await call(unrestricted));
    const unrestrictedIds = (unrestrictedResult.sessions ?? []).map((s: any) => s.id);
    // (iv) unrestricted caller sees every in-org session of its own, no cross-org row
    expect(unrestrictedIds).toContain(sessIn!.id);
    expect(unrestrictedIds).toContain(sessOut!.id);
    expect(unrestrictedIds).not.toContain(sessCrossOrg!.id);
  });
});

// ============================================================
// query_agent_versions action check_upgrades
//
// This is an org-wide AGGREGATE (a count grouped by version), not a row-by-id
// lookup, so its (i)-(iv) analogue narrows the count rather than returning
// not-found. `agent_versions` is a GLOBAL table never truncated between
// tests/runs (see __tests__/integration/setup.ts CLEANUP_TABLES — it carries
// no org_id and is deliberately absent from that list), so any pre-existing
// `is_latest` row elsewhere in the shared test database could win the
// handler's `LIMIT 1` pick over the row seeded here. To stay correct
// regardless of which row wins, every seeded device below carries a
// per-test-run marker as its `agentVersion` (a fresh UUID), which can never
// equal ANY real release version string — so each device counts as
// "outdated" against whichever `effectiveTarget` resolves, without this test
// depending on its own seeded row being the one picked.
// ============================================================

describe('query_agent_versions action check_upgrades — site and cross-org scope', () => {
  it('narrows the outdated-device count to in-site devices, excludes cross-org devices', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const siteOther = await createSite({ orgId: org2.id });

    // Guarantee at least one `is_latest` row exists; see the comment above on
    // why its exact identity doesn't matter to this test.
    await getTestDb().insert(agentVersions).values({
      version: `9.9.9-test-${randomUUID().slice(0, 8)}`,
      platform: 'linux',
      architecture: 'amd64',
      downloadUrl: 'https://example.test/agent',
      checksum: 'a'.repeat(64),
      isLatest: true,
    });

    // Never equal to any real release version, so each device is "outdated"
    // no matter which is_latest row the handler's LIMIT 1 happens to pick.
    // agent_version is varchar(50); a full UUID marker plus prefix overflows it.
    const staleVersionMarker = `zz-${randomUUID().slice(0, 8)}`;
    await seedDevice(org.id, siteAllowed.id, { agentVersion: staleVersionMarker });
    await seedDevice(org.id, siteForbidden.id, { agentVersion: staleVersionMarker });
    await seedDevice(org2.id, siteOther.id, { agentVersion: staleVersionMarker });

    const handler = handlerFor(registerAgentMgmtTools, 'query_agent_versions');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [siteAllowed.id] });
    const unrestricted = makeOrgAuth(org.id);

    const call = (auth: AuthContext) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({ action: 'check_upgrades' }, auth),
      );

    // (i)+(ii) site-restricted caller counts only the in-site device (devOut
    // excluded, devIn included: 1, not 2 — the non-vacuous control).
    const restrictedResult = JSON.parse(await call(restricted));
    expect(restrictedResult.error).toBeUndefined();
    expect(restrictedResult.totalOutdated).toBe(1);

    // (iii)+(iv) unrestricted caller counts both in-org devices (devIn +
    // devOut = 2), and the cross-org device in org2 never contributes,
    // because the query is scoped to org.id throughout.
    const unrestrictedResult = JSON.parse(await call(unrestricted));
    expect(unrestrictedResult.error).toBeUndefined();
    expect(unrestrictedResult.totalOutdated).toBe(2);
  });
});

// ============================================================
// query_custom_fields action get_device_values
// ============================================================

describe('query_custom_fields action get_device_values — site and cross-org scope', () => {
  it('denies out-of-site, allows in-site, denies cross-org; unrestricted sees both devices', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const siteOther = await createSite({ orgId: org2.id });

    const devIn = await seedDevice(org.id, siteAllowed.id, { customFields: { assetOwner: 'in-site' } as any });
    const devOut = await seedDevice(org.id, siteForbidden.id, { customFields: { assetOwner: 'out-of-site' } as any });
    const devCrossOrg = await seedDevice(org2.id, siteOther.id);

    await getTestDb().insert(customFieldDefinitions).values({
      orgId: org.id, partnerId: null, name: 'Asset Owner', fieldKey: 'assetOwner', type: 'text',
    });

    const handler = handlerFor(registerDeviceTools, 'query_custom_fields');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [siteAllowed.id] });
    const unrestricted = makeOrgAuth(org.id);

    const call = (auth: AuthContext, deviceId: string) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({ action: 'get_device_values', deviceId }, auth),
      );

    // (i) out-of-site device: denied
    const outResult = JSON.parse(await call(restricted, devOut.id));
    expect(outResult.error).toBeDefined();

    // (ii) in-site device: visible (non-vacuous control)
    const inResult = JSON.parse(await call(restricted, devIn.id));
    expect(inResult.error).toBeUndefined();
    expect(inResult.deviceId).toBe(devIn.id);
    expect(inResult.customFields.assetOwner).toBe('in-site');

    // (iii) cross-org device: not found
    const crossOrgResult = JSON.parse(await call(restricted, devCrossOrg.id));
    expect(crossOrgResult.error).toBeDefined();

    // (iv) unrestricted caller sees both in-org devices
    const unrestrictedOut = JSON.parse(await call(unrestricted, devOut.id));
    expect(unrestrictedOut.error).toBeUndefined();
    expect(unrestrictedOut.deviceId).toBe(devOut.id);
    const unrestrictedIn = JSON.parse(await call(unrestricted, devIn.id));
    expect(unrestrictedIn.error).toBeUndefined();
    expect(unrestrictedIn.deviceId).toBe(devIn.id);
  });
});

// ============================================================
// query_custom_fields action list_definitions — partner-scope caller
// (customFieldDefinitionConditions: the partner branch matches REST's
// `partnerId = P OR orgId IN accessibleOrgIds`.)
//
// In a real request, `dbAccessContextFromAuth` derives the RLS context's
// `accessibleOrgIds` from the SAME auth object the app-layer condition reads,
// so the two never diverge and RLS alone would already narrow correctly.
// The app condition must still not rely on RLS happening to be narrower,
// so this test isolates the APP-LAYER predicate
// from RLS by deliberately giving the DB context BROADER access than the
// AuthContext claims (`accessibleOrgIds: [org.id, orgOther.id]` at the RLS
// layer vs `[org.id]` on the auth object) — the shape a genuine partner-axis
// or system-scope read can legitimately produce (CLAUDE.md "Partner-Wide
// First" §3). The condition (`partnerId = P OR orgId IN accessibleOrgIds`)
// must exclude `orgOther`'s row even though RLS itself would allow it.
// ============================================================

describe('query_custom_fields action list_definitions — partner-scope caller', () => {
  it('the app-layer partner branch narrows to accessibleOrgIds even when RLS access is broader', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgOther = await createOrganization({ partnerId: partner.id });

    const marker = randomUUID().slice(0, 8);
    await getTestDb().insert(customFieldDefinitions).values({
      orgId: orgOther.id, partnerId: null, name: `Other Org Field ${marker}`, fieldKey: `other_org_field_${marker}`, type: 'text',
    });
    const [inScopeDef] = await getTestDb().insert(customFieldDefinitions).values({
      orgId: org.id, partnerId: null, name: `In Scope Field ${marker}`, fieldKey: `in_scope_field_${marker}`, type: 'text',
    }).returning();

    const handler = handlerFor(registerDeviceTools, 'query_custom_fields');
    // App-layer auth: "selected" org access, narrower than the RLS grant below.
    const partnerAuth = makePartnerAuth(partner.id, [org.id]);

    const result = JSON.parse(
      await withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          // Deliberately BROADER than partnerAuth.accessibleOrgIds, so RLS by
          // itself would admit both orgs' rows — isolating the app condition.
          accessibleOrgIds: [org.id, orgOther.id],
          accessiblePartnerIds: [partner.id],
          currentPartnerId: partner.id,
        },
        async () => handler({ action: 'list_definitions' }, partnerAuth),
      ),
    );

    expect(result.error).toBeUndefined();
    const fieldKeys = (result.definitions ?? []).map((d: any) => d.fieldKey);
    expect(fieldKeys).toContain(inScopeDef!.fieldKey);
    expect(fieldKeys).not.toContain(`other_org_field_${marker}`);
  });
});

// ============================================================
// get_script_details — execution-stats path, as a site-restricted caller.
//
// Execution stats are an org-wide AGGREGATE (counts/avg duration), not a
// row-by-id lookup, so this narrows the count rather than returning
// not-found — the same shape as query_agent_versions:check_upgrades above.
// ============================================================

describe('get_script_details — execution stats, site-restricted caller', () => {
  it('narrows execution-stats counts to in-site devices; unrestricted caller sees both', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);

    const [script] = await getTestDb().insert(scripts).values({
      orgId: org.id, name: 'Test Script', osTypes: ['linux'], language: 'bash', content: 'echo hi',
    }).returning();

    await getTestDb().insert(scriptExecutions).values([
      { scriptId: script!.id, deviceId: devIn.id, orgId: org.id, status: 'completed' },
      { scriptId: script!.id, deviceId: devOut.id, orgId: org.id, status: 'completed' },
    ]);

    const handler = handlerFor(registerScriptTools, 'get_script_details');
    const restricted = makeOrgAuth(org.id, { allowedSiteIds: [siteAllowed.id] });
    const unrestricted = makeOrgAuth(org.id);

    const call = (auth: AuthContext) =>
      withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        async () => handler({ scriptId: script!.id, includeExecutionStats: true }, auth),
      );

    // (i)+(ii) site-restricted caller: only the in-site execution counts (1,
    // not 2 — the non-vacuous control that devOut's row was excluded, not
    // that the table is simply empty).
    const restrictedResult = JSON.parse(await call(restricted));
    expect(restrictedResult.error).toBeUndefined();
    expect(restrictedResult.executionStats.totalExecutions).toBe(1);
    expect(restrictedResult.executionStatsScopeNote).toBeDefined();

    // (iv) unrestricted caller sees both executions.
    const unrestrictedResult = JSON.parse(await call(unrestricted));
    expect(unrestrictedResult.error).toBeUndefined();
    expect(unrestrictedResult.executionStats.totalExecutions).toBe(2);
  });
});
