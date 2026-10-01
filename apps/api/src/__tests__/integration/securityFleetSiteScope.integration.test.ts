/**
 * Fleet security reads honour the caller's site ceiling against real Postgres.
 *
 * Organization RLS (enforced here by `breeze_app`) bounds the tenant; the site
 * axis is app-layer only. A same-org device in a site the caller cannot see
 * must not reach any fleet row or aggregate: status and threat lists, the
 * firewall/encryption/password-policy/local-admin views, latest posture, score
 * breakdown, dashboard, recommendations, trends, and the AI posture and
 * findings summaries. `allowedSiteIds` undefined = unrestricted; `[]` = nothing.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  organizationUsers,
  securityPostureOrgSnapshots,
  securityPostureSnapshots,
  securityStatus,
  securityThreats,
  vulnerabilities,
} from '../../db/schema';
import { authMiddleware, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { securityRoutes } from '../../routes/security';
import { registerSecurityTools } from '../../services/aiToolsSecurity';
import { registerVulnerabilityTools } from '../../services/aiToolsVulnerability';
import type { AiTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app(): Hono {
  const instance = new Hono();
  instance.use(authMiddleware);
  instance.route('/security', securityRoutes);
  return instance;
}

async function setSiteScope(userId: string, orgId: string, siteIds: string[] | null) {
  await withSystemDbAccessContext(async () => {
    await db.update(organizationUsers).set({ siteIds }).where(and(
      eq(organizationUsers.userId, userId),
      eq(organizationUsers.orgId, orgId),
    ));
  });
  await clearPermissionCache(userId);
}

function tool(registrar: (tools: Map<string, AiTool>) => void, name: string): AiTool {
  const tools = new Map<string, AiTool>();
  registrar(tools);
  const found = tools.get(name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

const deviceIdsOf = (rows: Array<{ deviceId: string }>) => rows.map((row) => row.deviceId).sort();

async function seed() {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const other = await setupTestEnvironment({ scope: 'organization' });
  const hiddenSite = await createSite({ orgId: env.organization.id, name: 'hidden-site' });
  const suffix = randomUUID().slice(0, 8);
  const device = (orgId: string, siteId: string, label: string) => ({
    orgId, siteId, agentId: `${label}-${suffix}`, hostname: `${label}-${suffix}`,
    osType: 'windows' as const, osVersion: '11', architecture: 'x86_64', agentVersion: 'test',
    status: 'online' as const,
  });
  const [visible, hidden, foreign] = await getTestDb().insert(devices).values([
    device(env.organization.id, env.site.id, 'visible-device'),
    device(env.organization.id, hiddenSite.id, 'hidden-device'),
    device(other.organization.id, other.site.id, 'other-org-device'),
  ]).returning({ id: devices.id });
  if (!visible || !hidden || !foreign) throw new Error('device fixture insert failed');

  const capturedAt = new Date();
  await getTestDb().insert(securityStatus).values([
    {
      orgId: env.organization.id, deviceId: visible.id, provider: 'windows_defender',
      realTimeProtection: true, firewallEnabled: true, encryptionStatus: 'encrypted',
      localAdminSummary: { accounts: [] }, passwordPolicySummary: { checks: [{ rule: 'ok', pass: true }] },
    },
    {
      orgId: env.organization.id, deviceId: hidden.id, provider: 'windows_defender',
      realTimeProtection: false, firewallEnabled: false, encryptionStatus: 'unencrypted',
      localAdminSummary: { accounts: [{ username: 'hidden-admin', isDefault: true }] },
      passwordPolicySummary: { checks: [{ rule: 'hidden-policy', pass: false }] },
    },
    {
      orgId: other.organization.id, deviceId: foreign.id, provider: 'windows_defender',
      realTimeProtection: false, firewallEnabled: false, encryptionStatus: 'unencrypted',
    },
  ]);
  await getTestDb().insert(securityThreats).values([
    {
      orgId: env.organization.id, deviceId: visible.id, provider: 'windows_defender',
      threatName: 'visible-resolved', severity: 'low', status: 'removed',
      filePath: '/visible/path', detectedAt: capturedAt,
    },
    {
      orgId: env.organization.id, deviceId: hidden.id, provider: 'windows_defender',
      threatName: 'hidden-active', severity: 'critical', status: 'detected',
      filePath: '/hidden/site/path', detectedAt: capturedAt,
    },
  ]);
  const posture = (deviceId: string, score: number, riskLevel: 'low' | 'critical') => ({
    orgId: env.organization.id, deviceId, capturedAt, overallScore: score, riskLevel,
    patchComplianceScore: score, encryptionScore: score, avHealthScore: score,
    firewallScore: score, openPortsScore: score, passwordPolicyScore: score,
    osCurrencyScore: score, adminExposureScore: score, factorDetails: {}, recommendations: [],
  });
  await getTestDb().insert(securityPostureSnapshots).values([
    posture(visible.id, 100, 'low'),
    posture(hidden.id, 0, 'critical'),
  ]);
  // The stored org snapshot of the same run: an unrestricted trend reads this.
  await getTestDb().insert(securityPostureOrgSnapshots).values({
    orgId: env.organization.id, capturedAt, overallScore: 50, devicesAudited: 2,
    lowRiskDevices: 1, criticalRiskDevices: 1, patchComplianceScore: 50,
    encryptionScore: 50, avHealthScore: 50, firewallScore: 50, openPortsScore: 50,
    passwordPolicyScore: 50, osCurrencyScore: 50, adminExposureScore: 50,
  });
  const [catalog] = await getTestDb().insert(vulnerabilities).values({
    cveId: `CVE-2099-${suffix}`, source: 'test', description: 'hidden-site finding',
    severity: 'critical', cvssScore: '9.8', rawPayload: {},
  }).returning({ id: vulnerabilities.id });
  if (!catalog) throw new Error('catalog fixture insert failed');
  await getTestDb().insert(deviceVulnerabilities).values({
    orgId: env.organization.id, deviceId: hidden.id, vulnerabilityId: catalog.id,
    status: 'open', riskScore: '9.8', detectedAt: capturedAt,
  });

  const headers = { headers: { Authorization: `Bearer ${env.token}` } };
  const get = async (path: string) => {
    const res = await app().request(`/security${path}`, headers);
    return { status: res.status, body: await res.json() };
  };
  return { env, visible, hidden, foreign, get };
}

describe('security fleet reads — site ceiling', () => {
  runDb('a selected-site caller sees only visible-site rows in every fleet projection and aggregate', async () => {
    const { env, visible, hidden, get } = await seed();
    await setSiteScope(env.user.id, env.organization.id, [env.site.id]);

    const status = await get('/status');
    expect(status.status).toBe(200);
    expect(deviceIdsOf(status.body.data)).toEqual([visible.id]);

    const threats = await get('/threats');
    expect(deviceIdsOf(threats.body.data)).toEqual([visible.id]);
    expect(JSON.stringify(threats.body)).not.toContain('/hidden/site/path');
    expect(threats.body.summary).toMatchObject({ total: 1, active: 0, critical: 0 });

    const latest = await get('/posture');
    expect(deviceIdsOf(latest.body.data)).toEqual([visible.id]);
    expect(latest.body.summary).toMatchObject({
      totalDevices: 1, averageScore: 100, lowRiskDevices: 1, criticalRiskDevices: 0,
    });

    const dashboard = await get('/dashboard');
    expect(dashboard.body.data).toMatchObject({
      totalDevices: 1, securityScore: 100, totalThreatsDetected: 1, activeThreats: 0,
    });
    expect(dashboard.body.data.adminAudit).toMatchObject({ defaultAccounts: 0, deviceCount: 1 });
    expect(dashboard.body.data.trend.map((p: { score: number }) => p.score)).toEqual([100]);
    expect(JSON.stringify(dashboard.body)).not.toContain(hidden.id);

    const score = await get('/score-breakdown');
    expect(score.body.data).toMatchObject({ overallScore: 100, devicesAudited: 1 });

    const recommendations = await get('/recommendations');
    expect(recommendations.status).toBe(200);
    expect(recommendations.body.data).toEqual([]);

    for (const endpoint of ['/firewall', '/encryption', '/password-policy', '/admin-audit']) {
      const body = (await get(endpoint)).body;
      expect(deviceIdsOf(body.data), endpoint).toEqual([visible.id]);
      expect(JSON.stringify(body), endpoint).not.toContain('hidden-admin');
      expect(JSON.stringify(body), endpoint).not.toContain('hidden-policy');
    }

    // Rebuilt from the visible device's snapshot, not the stored org snapshot (50).
    const trends = await get('/trends?period=7d');
    expect(trends.body.data.dataPoints).toHaveLength(1);
    expect(trends.body.data.dataPoints[0].overall).toBe(100);

    // Point reads of the hidden device stay denied.
    for (const path of [`/status/${hidden.id}`, `/threats/${hidden.id}`, `/posture/${hidden.id}`]) {
      const res = await get(path);
      expect([403, 404], path).toContain(res.status);
      expect(JSON.stringify(res.body), path).not.toContain('hidden-device');
    }
  });

  runDb('an empty site list yields no fleet rows, aggregates or trend points', async () => {
    const { env, get } = await seed();
    await setSiteScope(env.user.id, env.organization.id, []);

    expect((await get('/status')).body.data).toEqual([]);
    expect((await get('/threats')).body.data).toEqual([]);
    expect((await get('/posture')).body.data).toEqual([]);
    expect((await get('/dashboard')).body.data).toMatchObject({
      totalDevices: 0, totalThreatsDetected: 0, securityScore: 0, trend: [],
    });
    expect((await get('/score-breakdown')).body.data).toMatchObject({ overallScore: 0, devicesAudited: 0 });
    expect((await get('/trends?period=7d')).body.data.dataPoints).toEqual([]);
  });

  runDb('an unrestricted caller keeps both same-org devices, the stored org trend and RLS isolation', async () => {
    const { env, visible, hidden, foreign, get } = await seed();
    await setSiteScope(env.user.id, env.organization.id, null);

    const status = await get('/status');
    expect(deviceIdsOf(status.body.data)).toEqual([visible.id, hidden.id].sort());
    expect(JSON.stringify(status.body)).not.toContain(foreign.id);

    const latest = await get('/posture');
    expect(deviceIdsOf(latest.body.data)).toEqual([visible.id, hidden.id].sort());

    const trends = await get('/trends?period=7d');
    expect(trends.body.data.dataPoints.map((p: { overall: number }) => p.overall)).toEqual([50]);
  });

  runDb('AI posture and findings summaries apply the same ceiling', async () => {
    const { env, visible, hidden } = await seed();
    const auth: AuthContext = {
      principal: { kind: 'user_session' }, user: env.user, token: {} as never,
      partnerId: env.partner.id, orgId: env.organization.id, scope: 'organization',
      accessibleOrgIds: [env.organization.id], orgCondition: (column) => eq(column, env.organization.id),
      canAccessOrg: (id) => id === env.organization.id, allowedSiteIds: [env.site.id],
      canAccessSite: (id) => id === env.site.id,
    };
    const unrestricted: AuthContext = { ...auth, allowedSiteIds: undefined, canAccessSite: () => true };
    const posture = tool(registerSecurityTools, 'get_security_posture');
    const findings = tool(registerVulnerabilityTools, 'get_vulnerability_report');

    await withDbAccessContext(dbAccessContextFromAuth(auth), async () => {
      const restrictedPosture = JSON.parse(await posture.handler({}, auth));
      expect(deviceIdsOf(restrictedPosture.devices)).toEqual([visible.id]);
      expect(restrictedPosture.summary).toMatchObject({ totalDevices: 1, criticalRiskDevices: 0 });
      expect(JSON.parse(await findings.handler({}, auth))).toMatchObject({ totalFindings: 0, affectedCves: 0 });

      const openPosture = JSON.parse(await posture.handler({}, unrestricted));
      expect(deviceIdsOf(openPosture.devices)).toEqual([visible.id, hidden.id].sort());
      expect(JSON.parse(await findings.handler({}, unrestricted))).toMatchObject({ totalFindings: 1, affectedCves: 1 });
    });
  });
});
