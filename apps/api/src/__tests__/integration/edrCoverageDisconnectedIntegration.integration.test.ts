/**
 * #12726 — a device does not read as covered by a SentinelOne or Huntress
 * agent whose integration is disconnected, on real Postgres as the
 * unprivileged `breeze_app` role.
 *
 * Disconnect is soft (#12691): the integration row goes `is_active = false`
 * and its synced agent rows stay. The integration tables are partner-axis, so
 * an organization-scope or portal caller cannot read them; the readers learn
 * the state through a system-context lookup that only answers for integration
 * ids taken from agent rows the caller already read.
 *
 * Every fixture has two partners. Partner A's integrations are disconnected;
 * partner B's stay connected, so a reader that drops every agent fails the
 * "B still covered" half, and partner B's results must not move when A's
 * state changes.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/edrCoverageDisconnectedIntegration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  devices,
  huntressAgents,
  huntressIncidents,
  huntressIntegrations,
  huntressOrgMappings,
  incidents,
  s1Agents,
  s1Integrations,
  s1Threats,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerHuntressTools } from '../../services/aiToolsHuntress';
import { getEdrStatus } from '../../services/edrProviders/read';
import { buildIncidentFeed } from '../../routes/incidents.helpers';
import { enrichedDevicesForOrg } from '../../services/portal/deviceReadModel';
import { devicesProtectedTile, securityDevicesPage } from '../../services/portal/securityReadModel';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../../services/postureEvidence';
import { generateThreatDetectionReport } from '../../services/threatDetectionReport';
import { siteScopeFingerprint } from '../../services/siteScope';
import {
  activeAgentIntegrationIdsForOrg,
  activeIntegrationIdsOfReadableAgents,
} from '../../services/securityIntegrationDisconnect';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const admin = () => getTestDb() as typeof db;
const NOW = new Date();

const asCtx = <T>(ctx: DbAccessContext, fn: () => Promise<T>) =>
  runOutsideDbContext(() => withDbAccessContext(ctx, fn));
const asSystem = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
  deviceId: string;
  s1IntegrationId: string;
  huntressIntegrationId: string;
  orgCtx: DbAccessContext;
  portalCtx: DbAccessContext;
  partnerCtx: DbAccessContext;
}

/** One partner, one org, one device carrying an S1 agent and a Huntress agent. */
async function seedTenant(label: string): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `cov-${label}-${randomUUID().slice(0, 8)}@example.test` });
  const [device] = await admin().insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `cov-${label}-${randomUUID().slice(0, 6)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    lastSeenAt: NOW,
  }).returning({ id: devices.id });
  const [s1] = await admin().insert(s1Integrations).values({
    partnerId: partner.id,
    name: `S1 ${label}`,
    apiTokenEncrypted: 'enc:test',
    managementUrl: 'https://usea1-test.sentinelone.net',
    isActive: true,
  }).returning({ id: s1Integrations.id });
  await admin().insert(s1Agents).values({
    orgId: org.id,
    integrationId: s1!.id,
    s1AgentId: `s1-agent-${label}-${randomUUID().slice(0, 6)}`,
    deviceId: device!.id,
    status: 'online',
  });
  const [huntress] = await admin().insert(huntressIntegrations).values({
    partnerId: partner.id,
    name: `Huntress ${label}`,
    apiKeyEncrypted: 'enc:test',
    isActive: true,
    lastSyncAt: NOW,
    lastSyncStatus: 'success',
  }).returning({ id: huntressIntegrations.id });
  await admin().insert(huntressOrgMappings).values({
    integrationId: huntress!.id,
    partnerId: partner.id,
    huntressOrgId: `h-org-${label}-${randomUUID().slice(0, 6)}`,
    huntressOrgName: `Customer ${label}`,
    orgId: org.id,
  });
  await admin().insert(huntressAgents).values({
    orgId: org.id,
    integrationId: huntress!.id,
    huntressAgentId: `h-agent-${label}-${randomUUID().slice(0, 6)}`,
    deviceId: device!.id,
    hostname: 'WS-01',
    status: 'online',
  });
  return {
    partnerId: partner.id,
    orgId: org.id,
    userId: user.id,
    deviceId: device!.id,
    s1IntegrationId: s1!.id,
    huntressIntegrationId: huntress!.id,
    orgCtx: { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: user.id },
    // What portalAuthMiddleware opens: org scope, no partner branch, no user id.
    portalCtx: { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: null, currentPartnerId: null },
    partnerCtx: { scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: user.id },
  };
}

async function disconnect(t: Tenant): Promise<void> {
  await admin().update(s1Integrations).set({ isActive: false, apiTokenEncrypted: null }).where(eq(s1Integrations.id, t.s1IntegrationId));
  await admin().update(huntressIntegrations).set({ isActive: false, apiKeyEncrypted: null }).where(eq(huntressIntegrations.id, t.huntressIntegrationId));
}

/** Partner A disconnected, partner B connected. */
async function seed() {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  await disconnect(a);
  return { a, b };
}

function authFor(scope: 'organization' | 'partner', t: Tenant): AuthContext {
  return {
    user: { id: t.userId, email: 'op@example.test', name: 'Op', isPlatformAdmin: false },
    token: {} as never,
    scope,
    orgId: scope === 'organization' ? t.orgId : null,
    partnerId: t.partnerId,
    partnerOrgAccess: 'all',
    accessibleOrgIds: [t.orgId],
    canAccessOrg: (id: string) => id === t.orgId,
    orgCondition: (col: never) => inArray(col, [t.orgId]),
  } as unknown as AuthContext;
}

function huntressTool(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerHuntressTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler;
}

const PAGE = { page: 1, limit: 50, timezone: 'UTC' };

describe('portal read models (portal user, org scope)', () => {
  runDb('a disconnected integration\'s agents do not protect a device; a connected one\'s still do', async () => {
    const { a, b } = await seed();

    const tileA = await asCtx(a.portalCtx, () => devicesProtectedTile(a.orgId, NOW));
    expect(tileA).toMatchObject({ status: 'ok', protected: 0, unknown: 1, total: 1 });
    const tileB = await asCtx(b.portalCtx, () => devicesProtectedTile(b.orgId, NOW));
    expect(tileB).toMatchObject({ status: 'ok', protected: 1, total: 1 });

    const pageA = await asCtx(a.portalCtx, () => securityDevicesPage(a.orgId, { ...PAGE, now: NOW }));
    expect(pageA.data.find((row) => row.id === a.deviceId)).toMatchObject({ protection: 'unknown' });
    const pageB = await asCtx(b.portalCtx, () => securityDevicesPage(b.orgId, { ...PAGE, now: NOW }));
    expect(pageB.data.find((row) => row.id === b.deviceId)).toMatchObject({ protection: 'protected' });

    const devicesA = await asCtx(a.portalCtx, () => enrichedDevicesForOrg(a.orgId, PAGE));
    expect(devicesA.data.find((row) => row.id === a.deviceId)).toMatchObject({ protection: 'unknown' });
    const devicesB = await asCtx(b.portalCtx, () => enrichedDevicesForOrg(b.orgId, PAGE));
    expect(devicesB.data.find((row) => row.id === b.deviceId)).toMatchObject({ protection: 'protected' });
  });

  runDb('reconnecting the same integration restores the coverage', async () => {
    const { a } = await seed();
    await admin().update(s1Integrations).set({ isActive: true }).where(eq(s1Integrations.id, a.s1IntegrationId));
    const tileA = await asCtx(a.portalCtx, () => devicesProtectedTile(a.orgId, NOW));
    expect(tileA).toMatchObject({ status: 'ok', protected: 1, total: 1 });
  });
});

describe('posture evidence (portal user, org scope)', () => {
  runDb('a disconnected integration is not managed protection on the device', async () => {
    const { a, b } = await seed();
    const scopeA = { version: 1 as const, kind: 'unrestricted' as const, orgId: a.orgId };
    const evidenceA = await asCtx(a.portalCtx, () => loadPostureEvidence(scopeA, TRUST_PAGE_EVIDENCE_POLICY, NOW));
    const rowA = evidenceA.devices.find((d) => d.id === a.deviceId);
    expect(rowA?.managed).toEqual([]);
    expect(rowA?.protection).not.toBe('protected');

    const scopeB = { version: 1 as const, kind: 'unrestricted' as const, orgId: b.orgId };
    const evidenceB = await asCtx(b.portalCtx, () => loadPostureEvidence(scopeB, TRUST_PAGE_EVIDENCE_POLICY, NOW));
    const rowB = evidenceB.devices.find((d) => d.id === b.deviceId);
    expect(rowB?.managed).toEqual(['Huntress', 'SentinelOne']);
    expect(rowB?.protection).toBe('protected');
  });
});

describe('EDR status legacy coverage', () => {
  runDb('org-scope caller: agents of a disconnected integration are not counted', async () => {
    const { a, b } = await seed();
    const statusA = await asCtx(a.orgCtx, () =>
      getEdrStatus({ auth: authFor('organization', a), allowedDeviceIds: null, allowedSiteIds: null }, {}));
    expect(JSON.stringify(statusA.coverage)).not.toMatch(/SentinelOne|Huntress/);

    const statusB = await asCtx(b.orgCtx, () =>
      getEdrStatus({ auth: authFor('organization', b), allowedDeviceIds: null, allowedSiteIds: null }, {}));
    expect(JSON.stringify(statusB.coverage)).toMatch(/SentinelOne/);
    expect(JSON.stringify(statusB.coverage)).toMatch(/Huntress/);
  });

  runDb('partner caller: the same (the existing partner rule still holds)', async () => {
    const { a, b } = await seed();
    const statusA = await asCtx(a.partnerCtx, () =>
      getEdrStatus({ auth: authFor('partner', a), allowedDeviceIds: null, allowedSiteIds: null }, {}));
    expect(JSON.stringify(statusA.coverage)).not.toMatch(/SentinelOne|Huntress/);
    const statusB = await asCtx(b.partnerCtx, () =>
      getEdrStatus({ auth: authFor('partner', b), allowedDeviceIds: null, allowedSiteIds: null }, {}));
    expect(JSON.stringify(statusB.coverage)).toMatch(/SentinelOne/);
  });
});

describe('Huntress AI tools', () => {
  runDb('get_huntress_status (partner): the summary counts only a connected integration\'s agents', async () => {
    const { a, b } = await seed();
    const rawA = await asCtx(a.partnerCtx, () => huntressTool('get_huntress_status')({}, authFor('partner', a)));
    const outA = JSON.parse(rawA);
    expect(outA.summary).toMatchObject({ totalAgents: 0, mappedAgents: 0 });
    // History stays visible and labelled: the row is there, marked inactive.
    expect(outA.integrations).toEqual([
      expect.objectContaining({ id: a.huntressIntegrationId, isActive: false }),
    ]);

    const rawB = await asCtx(b.partnerCtx, () => huntressTool('get_huntress_status')({}, authFor('partner', b)));
    expect(JSON.parse(rawB).summary).toMatchObject({ totalAgents: 1, mappedAgents: 1 });
  });

  runDb('get_huntress_agents (org and partner): each agent says whether its integration is disconnected', async () => {
    const { a, b } = await seed();
    for (const [ctx, scope] of [[a.orgCtx, 'organization'], [a.partnerCtx, 'partner']] as const) {
      const out = JSON.parse(await asCtx(ctx, () => huntressTool('get_huntress_agents')({}, authFor(scope, a))));
      expect(out.agents).toHaveLength(1);
      expect(out.agents[0]).toMatchObject({ deviceId: a.deviceId, integrationDisconnected: true });
    }
    const outB = JSON.parse(await asCtx(b.orgCtx, () => huntressTool('get_huntress_agents')({}, authFor('organization', b))));
    expect(outB.agents[0]).toMatchObject({ deviceId: b.deviceId, integrationDisconnected: false });
  });
});

describe('threat detection report', () => {
  function authorityFor(t: Tenant) {
    const scope = { version: 1 as const, kind: 'unrestricted' as const, orgId: t.orgId };
    return {
      principalKind: 'user' as const,
      principalUserId: t.userId,
      scope,
      capturedAt: NOW,
      fingerprint: siteScopeFingerprint(scope),
    };
  }
  const evidence = () => ({
    periodStart: new Date(NOW.getTime() - 30 * 86_400_000).toISOString().slice(0, 10),
    periodEnd: NOW.toISOString().slice(0, 10),
    generatedAt: NOW.toISOString(),
    deliverableId: randomUUID(),
  });

  runDb('a disconnected SentinelOne integration does not fill the detection-agent device pair', async () => {
    const { a, b } = await seed();
    const resA = await asSystem(() => generateThreatDetectionReport(a.orgId, {}, authorityFor(a), evidence()));
    const coverageA = (resA.summary as { agentCoverage: Record<string, unknown> }).agentCoverage;
    expect(coverageA.devicesWithDetectionAgent).toBeUndefined();
    expect(JSON.stringify(coverageA)).not.toContain('sentinelone');

    const resB = await asSystem(() => generateThreatDetectionReport(b.orgId, {}, authorityFor(b), evidence()));
    const coverageB = (resB.summary as { agentCoverage: Record<string, unknown> }).agentCoverage;
    expect(coverageB).toMatchObject({ huntressAgents: 1, devicesWithDetectionAgent: 1 });
  });

  runDb('Huntress agents of an older, disconnected integration row do not count beside the connected one', async () => {
    const t = await seedTenant('c');
    // The org's agent belongs to the row that is now disconnected; a newer
    // row is the partner's connected integration and has no agents yet.
    await admin().update(huntressIntegrations).set({ isActive: false }).where(eq(huntressIntegrations.id, t.huntressIntegrationId));
    await admin().update(s1Integrations).set({ isActive: false }).where(eq(s1Integrations.id, t.s1IntegrationId));
    await admin().insert(huntressIntegrations).values({
      partnerId: t.partnerId, name: 'Huntress new', apiKeyEncrypted: 'enc:test', isActive: true,
      lastSyncAt: NOW, lastSyncStatus: 'success',
    });
    const res = await asSystem(() => generateThreatDetectionReport(t.orgId, {}, authorityFor(t), evidence()));
    const coverage = (res.summary as { agentCoverage: Record<string, unknown> }).agentCoverage;
    expect(coverage).toMatchObject({ huntressAgents: 0, devicesWithoutAgent: 1, devicesWithDetectionAgent: 0 });
  });
});

describe('the shared lookup answers only from agent rows the caller can read', () => {
  runDb('cross-partner negative: partner B learns nothing about partner A\'s integration, in either state', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    const probeFromB = async () => ({
      // Partner B, and org B's portal user, aim the lookup at org A's rows and at every row.
      partnerAimed: await asCtx(b.partnerCtx, () => activeIntegrationIdsOfReadableAgents('sentinelone', eq(s1Agents.orgId, a.orgId))),
      partnerAll: await asCtx(b.partnerCtx, () => activeIntegrationIdsOfReadableAgents('huntress', undefined)),
      portalAimed: await asCtx(b.portalCtx, () => activeAgentIntegrationIdsForOrg(a.orgId)),
      portalAll: await asCtx(b.portalCtx, () => activeIntegrationIdsOfReadableAgents('sentinelone', undefined)),
    });

    const whileConnected = await probeFromB();
    await disconnect(a);
    const whileDisconnected = await probeFromB();

    expect(whileConnected).toEqual({
      partnerAimed: [],
      partnerAll: [b.huntressIntegrationId],
      portalAimed: { sentinelone: [], huntress: [] },
      portalAll: [b.s1IntegrationId],
    });
    expect(whileDisconnected).toEqual(whileConnected);
  });

  runDb('org and partner callers of partner A see their own integration go from active to absent', async () => {
    const a = await seedTenant('a');
    expect(await asCtx(a.orgCtx, () => activeAgentIntegrationIdsForOrg(a.orgId)))
      .toEqual({ sentinelone: [a.s1IntegrationId], huntress: [a.huntressIntegrationId] });
    await disconnect(a);
    expect(await asCtx(a.orgCtx, () => activeAgentIntegrationIdsForOrg(a.orgId)))
      .toEqual({ sentinelone: [], huntress: [] });
    expect(await asCtx(a.partnerCtx, () => activeIntegrationIdsOfReadableAgents('sentinelone', undefined))).toEqual([]);
  });
});

describe('incident feed findings (history stays, labelled)', () => {
  async function seedFindings(t: Tenant) {
    await admin().insert(s1Threats).values({
      orgId: t.orgId, integrationId: t.s1IntegrationId, s1ThreatId: `threat-${randomUUID().slice(0, 8)}`,
      threatName: 'EICAR', status: 'active', severity: 'high', deviceId: t.deviceId, detectedAt: NOW,
    });
    await admin().insert(huntressIncidents).values({
      orgId: t.orgId, integrationId: t.huntressIntegrationId, huntressIncidentId: `inc-${randomUUID().slice(0, 8)}`,
      title: 'Footholds found', status: 'open', severity: 'high', deviceId: t.deviceId, reportedAt: NOW,
    });
    await admin().insert(incidents).values({
      orgId: t.orgId, title: 'Tracked', classification: 'malware', severity: 'p2', status: 'detected', detectedAt: NOW,
    } as typeof incidents.$inferInsert);
  }
  const params = { limit: 50, offset: 0, hasDevicesRead: true, allowedDeviceIds: null, allowedSiteIds: null };

  for (const scope of ['organization', 'partner'] as const) {
    runDb(`${scope} caller: findings of a disconnected integration stay listed and say so`, async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      await seedFindings(a);
      await seedFindings(b);
      await disconnect(a);
      const ctxOf = (t: Tenant) => (scope === 'organization' ? t.orgCtx : t.partnerCtx);

      const feedA = await asCtx(ctxOf(a), () => buildIncidentFeed(authFor(scope, a), params));
      const bySource = (rows: typeof feedA.rows) => Object.fromEntries(rows.map((r) => [r.source, r.integrationDisconnected]));
      expect(feedA.total).toBe(3);
      expect(bySource(feedA.rows)).toEqual({ s1: true, huntress: true, breeze: false });

      const feedB = await asCtx(ctxOf(b), () => buildIncidentFeed(authFor(scope, b), params));
      expect(bySource(feedB.rows)).toEqual({ s1: false, huntress: false, breeze: false });
    });
  }
});
