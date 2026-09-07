import './setup';

import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  deviceEventLogs,
  devices,
  logCorrelationRules,
  logCorrelations,
  logSearchQueries,
  organizationUsers,
  partnerUsers,
  permissions,
  rolePermissions,
  users,
} from '../../db/schema';
import { getLogCorrelationQueue, processLogCorrelationJob, shutdownLogCorrelationWorker } from '../../jobs/logCorrelation';
import { logsRoutes } from '../../routes/logs';
import type { AuthContext } from '../../middleware/auth';
import { registerEventLogTools } from '../../services/aiToolsEventLogs';
import type { AiTool } from '../../services/aiTools';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { detectPatternCorrelation, getLogAggregation, getLogTrends, searchFleetLogs } from '../../services/logSearch';
import { resolveCurrentLogReadDeviceIds } from '../../services/logReadAuthority';
import { clearPermissionCache } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createRole,
  createSite,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null,
  accessiblePartnerIds: null, userId: null,
};

afterAll(async () => {
  await shutdownLogCorrelationWorker();
});

describe('fleet log current-site boundary — real PostgreSQL and Redis', () => {
  it('projects raw/aggregate/correlation/saved data and rejects stale async authority', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
      ],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden logs' });
    const suffix = randomUUID().slice(0, 8);
    const insertedDevices = await withDbAccessContext(SYSTEM_CTX, () => db.insert(devices).values([
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `log-visible-${suffix}`,
        hostname: `log-visible-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
      {
        orgId: env.organization.id, siteId: hiddenSite.id, agentId: `log-hidden-${suffix}`,
        hostname: `log-hidden-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
    ]).returning({ id: devices.id }));
    const visibleDeviceId = insertedDevices[0]!.id;
    const hiddenDeviceId = insertedDevices[1]!.id;
    await withDbAccessContext(SYSTEM_CTX, () => db.update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);

    const now = new Date();
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(deviceEventLogs).values([
      {
        orgId: env.organization.id, deviceId: visibleDeviceId, timestamp: now,
        level: 'info', category: 'system', source: `visible-${suffix}`, message: 'allowed synthetic log',
      },
      {
        orgId: env.organization.id, deviceId: hiddenDeviceId, timestamp: now,
        level: 'critical', category: 'security', source: `hidden-${suffix}`, message: 'denied synthetic log',
      },
    ]));
    const [rule] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(logCorrelationRules).values({
      orgId: env.organization.id, name: `rule-${suffix}`, pattern: 'synthetic',
    }).returning({ id: logCorrelationRules.id }));
    const visibleCorrelationId = randomUUID();
    const deletedDeviceId = randomUUID();
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(logCorrelations).values([
      {
        id: visibleCorrelationId, orgId: env.organization.id, ruleId: rule!.id, pattern: 'visible',
        firstSeen: new Date(now.getTime() - 10_000), lastSeen: new Date(now.getTime() - 5_000), occurrences: 1,
        affectedDevices: [{ deviceId: visibleDeviceId, hostname: 'visible', count: 1 }], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'mixed-newer',
        firstSeen: now, lastSeen: now, occurrences: 2,
        affectedDevices: [
          { deviceId: visibleDeviceId, hostname: 'visible', count: 1 },
          { deviceId: hiddenDeviceId, hostname: 'hidden', count: 1 },
        ], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'hidden-only-newer',
        firstSeen: now, lastSeen: new Date(now.getTime() + 500), occurrences: 1,
        affectedDevices: [{ deviceId: hiddenDeviceId, hostname: 'hidden', count: 1 }], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'deleted-newest',
        firstSeen: now, lastSeen: new Date(now.getTime() + 1_000), occurrences: 1,
        affectedDevices: [{ deviceId: deletedDeviceId, hostname: 'deleted', count: 1 }], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'malformed-newest',
        firstSeen: now, lastSeen: new Date(now.getTime() + 2_000), occurrences: 1,
        affectedDevices: [{ deviceId: 'not-a-uuid', hostname: 'malformed', count: 1 }], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'device-less-newest',
        firstSeen: now, lastSeen: new Date(now.getTime() + 3_000), occurrences: 1,
        affectedDevices: [], sampleLogs: [],
      },
      {
        orgId: env.organization.id, ruleId: rule!.id, pattern: 'hidden-sample-newest',
        firstSeen: now, lastSeen: new Date(now.getTime() + 4_000), occurrences: 1,
        affectedDevices: [{ deviceId: visibleDeviceId, hostname: 'visible', count: 1 }],
        sampleLogs: [{
          id: randomUUID(), deviceId: hiddenDeviceId, timestamp: now.toISOString(),
          level: 'critical', source: 'hidden', message: 'hidden sample',
        }],
      },
    ]));
    const [hiddenSaved] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(logSearchQueries).values({
      orgId: env.organization.id, name: `saved-${suffix}`, createdBy: env.user.id,
      filters: { deviceIds: [hiddenDeviceId], siteIds: [hiddenSite.id] },
    }).returning({ id: logSearchQueries.id }));

    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: env.organization.id, partnerId: env.partner.id, scope: 'organization',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);
    const app = new Hono();
    app.route('/logs', logsRoutes);
    const request = (path: string, init?: RequestInit) => app.request(`/logs${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });

    const search = await request('/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20, countMode: 'exact' }),
    });
    expect(search.status, await search.clone().text()).toBe(200);
    const searchBody = await search.json() as { results: Array<{ log: { deviceId: string } }>; total: number };
    expect(searchBody.results.map((row) => row.log.deviceId)).toEqual([visibleDeviceId]);
    expect(searchBody.total).toBe(1);

    const aggregation = await request('/aggregation?groupBy=device');
    expect(aggregation.status, await aggregation.clone().text()).toBe(200);
    const aggregationJson = JSON.stringify(await aggregation.json());
    expect(aggregationJson).toContain(`log-visible-${suffix}`);
    expect(aggregationJson).not.toContain(`log-hidden-${suffix}`);
    const trends = await request('/trends');
    expect(trends.status, await trends.clone().text()).toBe(200);
    expect(JSON.stringify(await trends.json())).not.toContain(hiddenDeviceId);

    // Hidden/deleted/mixed rows are removed before total and LIMIT, so the
    // older visible correlation fills page one.
    const correlations = await request('/correlation?limit=1');
    expect(correlations.status, await correlations.clone().text()).toBe(200);
    await expect(correlations.json()).resolves.toMatchObject({
      data: [{ id: visibleCorrelationId }], total: 1, limit: 1, offset: 0,
    });
    const saved = await request('/queries');
    expect(saved.status, await saved.clone().text()).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ data: [{ filters: {
      deviceIds: [], siteIds: [],
    } }] });
    const hiddenSavedSearch = await request('/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ savedQueryId: hiddenSaved!.id, countMode: 'exact' }),
    });
    expect(hiddenSavedSearch.status, await hiddenSavedSearch.clone().text()).toBe(200);
    await expect(hiddenSavedSearch.json()).resolves.toMatchObject({ results: [], total: 0 });

    const queued = await request('/correlation/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'allowed synthetic log', minDevices: 1, minOccurrences: 1 }),
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    const queuedBody = await queued.json() as { jobId: string };
    expect((await request(`/correlation/detect/${queuedBody.jobId}`)).status).toBe(200);
    const queue = getLogCorrelationQueue();
    const queuedJob = await queue.getJob(queuedBody.jobId);
    await expect(processLogCorrelationJob(queuedJob!.data)).resolves.toMatchObject({
      mode: 'pattern', detected: true,
      result: { affectedDevices: [{ deviceId: visibleDeviceId }] },
    });

    // Poll authorization is bound to both the job org and the current request
    // ceiling, not merely to the requester id stored in the envelope.
    const otherOrg = await createOrganization({ partnerId: env.partner.id });
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(organizationUsers).values({
      orgId: otherOrg.id, userId: env.user.id, roleId: env.role.id,
    }));
    const otherOrgToken = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: otherOrg.id, partnerId: env.partner.id, scope: 'organization',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);
    expect((await app.request(`/logs/correlation/detect/${queuedBody.jobId}`, {
      headers: { Authorization: `Bearer ${otherOrgToken}` },
    })).status).toBe(404);
    await withDbAccessContext(SYSTEM_CTX, () => db.update(organizationUsers)
      .set({ siteIds: [] })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);
    expect((await request(`/correlation/detect/${queuedBody.jobId}`)).status).toBe(404);
    await withDbAccessContext(SYSTEM_CTX, () => db.update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);

    const legacy = await queue.add('pattern-detect', {
      type: 'pattern', orgId: env.organization.id, pattern: 'legacy', isRegex: false,
      queuedAt: now.toISOString(),
    } as never, { jobId: `legacy-log-${suffix}` });
    expect((await request(`/correlation/detect/${legacy.id}`)).status).toBe(404);

    // Deterministic post-snapshot move: prove the old pre-query snapshot saw
    // the device, commit its move, then require the correlation statement's
    // own device/org/site EXISTS to reject the formerly-visible row.
    const staleAuth = {
      scope: 'organization', orgId: env.organization.id,
      allowedSiteIds: [env.site.id], canAccessOrg: (id: string) => id === env.organization.id,
      canAccessSite: (id: string | null | undefined) => id === env.site.id,
      orgCondition: (column: Parameters<AuthContext['orgCondition']>[0]) => eq(column, env.organization.id),
    } as unknown as AuthContext;
    const staleCtx: DbAccessContext = {
      scope: 'organization', orgId: env.organization.id,
      accessibleOrgIds: [env.organization.id], accessiblePartnerIds: [], userId: env.user.id,
      currentPartnerId: env.partner.id,
    };
    await expect(withDbAccessContext(staleCtx, () => resolveCurrentLogReadDeviceIds(
      staleAuth, env.organization.id,
    ))).resolves.toContain(visibleDeviceId);

    // Historical raw logs follow the device's CURRENT site.
    await withDbAccessContext(SYSTEM_CTX, () => db.update(devices)
      .set({ siteId: hiddenSite.id }).where(eq(devices.id, visibleDeviceId)));
    const afterMove = await request('/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(afterMove.status).toBe(200);
    expect((await afterMove.json() as { results: unknown[] }).results).toHaveLength(0);
    await expect((await request('/correlation?limit=1')).json()).resolves.toMatchObject({
      data: [], total: 0, limit: 1, offset: 0,
    });

    // Deterministic TOCTOU regression: carry the pre-move device-id snapshot
    // into each data-bearing service after the committed move. The correlated
    // device/org/site predicate in the SQL statement must still exclude it.
    const staleCeiling = { allowedDeviceIds: [visibleDeviceId], allowedSiteIds: [env.site.id] };
    await expect(withDbAccessContext(staleCtx, () => searchFleetLogs(
      staleAuth, { ...staleCeiling, countMode: 'exact' },
    )))
      .resolves.toMatchObject({ results: [], total: 0 });
    expect(JSON.stringify(await withDbAccessContext(staleCtx, () => getLogAggregation(
      staleAuth, { ...staleCeiling, groupBy: 'device' },
    ))))
      .not.toContain(visibleDeviceId);
    expect(JSON.stringify(await withDbAccessContext(staleCtx, () => getLogTrends(staleAuth, staleCeiling))))
      .not.toContain(visibleDeviceId);
    await expect(withDbAccessContext(staleCtx, () => detectPatternCorrelation({
      orgId: env.organization.id, pattern: 'allowed synthetic', minDevices: 1, minOccurrences: 1,
      ...staleCeiling,
    }))).resolves.toBeNull();

    // AI/MCP callers take the same services through a pre-query device-id
    // snapshot. Every tool must also carry the live site ceiling so the SQL
    // predicate, not that stale snapshot, decides visibility after a move.
    const eventLogTools = new Map<string, AiTool>();
    registerEventLogTools(eventLogTools);
    const runTool = (name: string, input: Record<string, unknown>) => withDbAccessContext(
      staleCtx,
      () => eventLogTools.get(name)!.handler(input, staleAuth),
    );
    const aiSearch = JSON.parse(await runTool('search_logs', {
      query: 'allowed synthetic', countMode: 'exact',
    }));
    expect(aiSearch.logs).toEqual([]);
    expect(aiSearch.total).toBe(0);
    const aiTrends = JSON.parse(await runTool('get_log_trends', {
      groupBy: 'device', source: `visible-${suffix}`,
    }));
    expect(JSON.stringify(aiTrends)).not.toContain(visibleDeviceId);
    const aiCorrelation = JSON.parse(await runTool('detect_log_correlations', {
      pattern: 'allowed synthetic', minDevices: 1, minOccurrences: 1,
    }));
    expect(aiCorrelation.detected).toBe(false);

    // Removing execute authority invalidates the durable queued envelope
    // before any pattern query is evaluated.
    const [executePermission] = await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: permissions.id })
      .from(permissions).where(and(eq(permissions.resource, 'devices'), eq(permissions.action, 'execute'))).limit(1));
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(rolePermissions).where(and(
      eq(rolePermissions.roleId, env.role.id), eq(rolePermissions.permissionId, executePermission!.id),
    )));
    await clearPermissionCache(env.user.id);
    const revokedJob = await queue.getJob(queuedBody.jobId);
    await expect(processLogCorrelationJob(revokedJob!.data)).rejects.toThrow('authority is no longer valid');
    const [liveUser] = await withDbAccessContext(SYSTEM_CTX, () => db.select({ status: users.status })
      .from(users).where(eq(users.id, env.user.id)).limit(1));
    expect(liveUser?.status).toBe('active');
  });

  it('preserves partner all/selected and live platform-system fleet reads on their exact authority axes', async () => {
    const env = await setupTestEnvironment({
      scope: 'partner',
      rolePermissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
      ],
    });
    const suffix = randomUUID().slice(0, 8);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(devices).values({
      orgId: env.organization.id, siteId: env.site.id, agentId: `log-partner-${suffix}`,
      hostname: `log-partner-${suffix}`, osType: 'linux', osVersion: '1',
      architecture: 'x64', agentVersion: '1', status: 'online',
    }).returning({ id: devices.id }));
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(deviceEventLogs).values({
      orgId: env.organization.id, deviceId: device!.id, timestamp: new Date(),
      level: 'warning', category: 'system', source: `partner-${suffix}`,
      message: `partner-axis-${suffix}`,
    }));
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(logSearchQueries).values({
      orgId: env.organization.id, name: `partner-saved-${suffix}`, createdBy: env.user.id,
      filters: { deviceIds: [device!.id], siteIds: [env.site.id] },
    }));

    const app = new Hono();
    app.route('/logs', logsRoutes);
    const mint = (scope: 'partner' | 'system') => createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id,
      orgId: null, partnerId: env.partner.id, scope,
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);
    const exercise = async (token: string) => {
      const headers = { Authorization: `Bearer ${token}` };
      const search = await app.request('/logs/search', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `partner-axis-${suffix}`, countMode: 'exact' }),
      });
      expect(search.status, await search.clone().text()).toBe(200);
      expect(JSON.stringify(await search.json())).toContain(device!.id);
      for (const path of ['/logs/aggregation?groupBy=device', '/logs/trends', '/logs/queries']) {
        const response = await app.request(path, { headers });
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
        const payload = JSON.stringify(await response.json());
        expect(payload).toContain(path === '/logs/queries' ? device!.id : suffix);
      }
    };

    const partnerToken = await mint('partner');
    await exercise(partnerToken); // orgAccess=all from setupTestEnvironment

    // A lower organization membership must not replace the captured partner
    // axis when the queued worker revalidates authority.
    const lowerRole = await createRole({
      scope: 'organization', orgId: env.organization.id, partnerId: env.partner.id,
    });
    await grantRolePermissions(lowerRole.id, [{ resource: 'devices', action: 'read' }]);
    await assignUserToOrganization(env.user.id, env.organization.id, lowerRole.id);
    await clearPermissionCache(env.user.id);
    const queued = await app.request('/logs/correlation/detect', {
      method: 'POST', headers: {
        Authorization: `Bearer ${partnerToken}`, 'content-type': 'application/json',
      },
      body: JSON.stringify({
        orgId: env.organization.id, pattern: `partner-axis-${suffix}`,
        minDevices: 1, minOccurrences: 1,
      }),
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    const queuedBody = await queued.json() as { jobId: string };
    const queuedJob = await getLogCorrelationQueue().getJob(queuedBody.jobId);
    await expect(processLogCorrelationJob(queuedJob!.data)).resolves.toMatchObject({
      mode: 'pattern', detected: true,
      result: { affectedDevices: [{ deviceId: device!.id }] },
    });

    await withDbAccessContext(SYSTEM_CTX, () => db.update(partnerUsers).set({
      orgAccess: 'selected', orgIds: [env.organization.id],
    }).where(and(eq(partnerUsers.userId, env.user.id), eq(partnerUsers.partnerId, env.partner.id))));
    await clearPermissionCache(env.user.id);
    await exercise(partnerToken);

    await withDbAccessContext(SYSTEM_CTX, () => db.update(users)
      .set({ isPlatformAdmin: true }).where(eq(users.id, env.user.id)));
    await clearPermissionCache(env.user.id);
    await exercise(await mint('system'));
  });
});
