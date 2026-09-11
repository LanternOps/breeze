import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceSessions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerPerformanceTools } from '../../services/aiToolsPerformance';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL_APP);

function handlerFor(name: 'get_active_users' | 'get_user_experience_metrics'): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerPerformanceTools(registry);
  return registry.get(name)!.handler;
}

function authFor(orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'operator@example.test', name: 'Operator', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: (candidate) => candidate === orgId,
    allowedSiteIds,
    canAccessSite: (siteId) => allowedSiteIds === undefined
      || (!!siteId && allowedSiteIds.includes(siteId)),
  } as AuthContext;
}

function dbContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId] };
}

async function seedDevice(orgId: string, siteId: string, hostname: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-${randomUUID()}`,
    hostname,
    osType: 'linux',
    osVersion: '1.0',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  return device!;
}

async function seedSession(
  orgId: string,
  deviceId: string,
  username: string,
  loginAt: Date,
) {
  await getTestDb().insert(deviceSessions).values({
    orgId,
    deviceId,
    username,
    sessionType: 'console',
    osSessionId: `session-${randomUUID()}`,
    loginAt,
    durationSeconds: 600,
    idleMinutes: 2,
    activityState: 'active',
    loginPerformanceSeconds: 3,
    isActive: true,
    lastActivityAt: loginAt,
  });
}

describe.skipIf(!SHOULD_RUN)('performance AI fleet user-session site scope', () => {
  it('filters on the current device site before LIMIT and follows a later site move', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const visibleSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const visible = await seedDevice(org.id, visibleSite.id, 'visible-host');
    const hidden = await seedDevice(org.id, hiddenSite.id, 'hidden-host');
    const crossOrg = await seedDevice(otherOrg.id, otherSite.id, 'cross-org-host');
    const now = Date.now();
    // The hidden row is newer than the visible row. A post-LIMIT filter would
    // return no visible result at limit=1.
    await seedSession(org.id, hidden.id, 'hidden-user', new Date(now - 1_000));
    await seedSession(org.id, visible.id, 'visible-user', new Date(now - 2_000));
    await seedSession(otherOrg.id, crossOrg.id, 'cross-org-user', new Date(now));

    const selected = authFor(org.id, [visibleSite.id]);
    const context = dbContext(org.id);
    const active = JSON.parse(await withDbAccessContext(context, () =>
      handlerFor('get_active_users')({ limit: 1 }, selected)));
    expect(active.totalActiveSessions).toBe(1);
    expect(active.devices).toHaveLength(1);
    expect(active.devices[0]).toMatchObject({ hostname: 'visible-host' });
    expect(active.devices[0].sessions[0]).toMatchObject({ username: 'visible-user' });

    const experience = JSON.parse(await withDbAccessContext(context, () =>
      handlerFor('get_user_experience_metrics')({ limit: 1 }, selected)));
    expect(experience.totalSessions).toBe(1);
    expect(experience.perUser).toEqual([expect.objectContaining({ username: 'visible-user' })]);
    expect(experience.trend).toEqual([expect.objectContaining({ hostname: 'visible-host' })]);

    // Visibility is based on the device's current site, not a historical
    // session stamp or the authority snapshot at initial enrollment.
    await getTestDb().update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, visible.id));
    const movedActive = JSON.parse(await withDbAccessContext(context, () =>
      handlerFor('get_active_users')({ limit: 10 }, selected)));
    const movedExperience = JSON.parse(await withDbAccessContext(context, () =>
      handlerFor('get_user_experience_metrics')({ limit: 10 }, selected)));
    expect(movedActive).toMatchObject({ totalActiveSessions: 0, devices: [] });
    expect(movedExperience).toMatchObject({ totalSessions: 0 });

    // Undefined remains the established all-sites behavior for this org;
    // FORCE RLS still excludes the other org.
    const unrestricted = JSON.parse(await withDbAccessContext(context, () =>
      handlerFor('get_active_users')({ limit: 10 }, authFor(org.id))));
    expect(unrestricted.totalActiveSessions).toBe(2);
    expect(unrestricted.devices.map((entry: { hostname: string }) => entry.hostname).sort())
      .toEqual(['hidden-host', 'visible-host']);
  });
});
