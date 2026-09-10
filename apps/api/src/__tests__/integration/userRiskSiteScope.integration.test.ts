import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  mlFeedbackEvents,
  organizationUsers,
  userRiskEvents,
  userRiskScores,
} from '../../db/schema';
import { userRiskRoutes } from '../../routes/userRisk';
import { clearPermissionCache } from '../../services/permissions';
import {
  createOrganization,
  createRole,
  createSite,
  createUser,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/user-risk', userRiskRoutes);
  return app;
}

async function get(token: string, path: string): Promise<{ status: number; body: any }> {
  const response = await buildApp().request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

async function setCallerSites(userId: string, orgId: string, siteIds: string[] | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgId)));
  });
  await clearPermissionCache(userId);
}

describe('user-risk current-membership site visibility', () => {
  runDb('filters before paging, grouping, detail enrichment, and evaluation as breeze_app', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'users', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden risk site' });
    const database = getTestDb();
    const suffix = crypto.randomUUID().slice(0, 8);

    const visible = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `risk-visible-${suffix}@example.test`,
    });
    const hidden = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `risk-hidden-${suffix}@example.test`,
    });
    const nullSite = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `risk-null-${suffix}@example.test`,
    });
    const foreignOrg = await createOrganization({ partnerId: env.partner.id, name: `Foreign risk org ${suffix}` });
    const foreignRole = await createRole({
      scope: 'organization',
      partnerId: env.partner.id,
      orgId: foreignOrg.id,
    });
    const foreign = await createUser({
      partnerId: env.partner.id,
      orgId: foreignOrg.id,
      email: `risk-foreign-${suffix}@example.test`,
    });

    await database.insert(organizationUsers).values([
      { orgId: env.organization.id, userId: visible.id, roleId: env.role.id, siteIds: [env.site.id] },
      // A duplicate current membership must not duplicate score/event rows.
      { orgId: env.organization.id, userId: visible.id, roleId: env.role.id, siteIds: [env.site.id] },
      { orgId: env.organization.id, userId: hidden.id, roleId: env.role.id, siteIds: [hiddenSite.id] },
      { orgId: env.organization.id, userId: nullSite.id, roleId: env.role.id, siteIds: null },
      { orgId: foreignOrg.id, userId: foreign.id, roleId: foreignRole.id, siteIds: null },
    ]);

    const now = new Date();
    await database.insert(userRiskScores).values([
      { orgId: env.organization.id, userId: visible.id, score: 10, factors: {}, trendDirection: 'stable', calculatedAt: now },
      { orgId: env.organization.id, userId: hidden.id, score: 99, factors: {}, trendDirection: 'up', calculatedAt: now },
      { orgId: env.organization.id, userId: nullSite.id, score: 98, factors: {}, trendDirection: 'up', calculatedAt: now },
      { orgId: foreignOrg.id, userId: foreign.id, score: 100, factors: {}, trendDirection: 'up', calculatedAt: now },
    ]);
    await database.insert(userRiskEvents).values([
      { orgId: env.organization.id, userId: visible.id, eventType: 'visible_signal', severity: 'low', scoreImpact: 1, description: 'visible', occurredAt: now },
      { orgId: env.organization.id, userId: hidden.id, eventType: 'hidden_signal', severity: 'critical', scoreImpact: 50, description: 'hidden', occurredAt: now },
      { orgId: env.organization.id, userId: nullSite.id, eventType: 'null_signal', severity: 'critical', scoreImpact: 50, description: 'null', occurredAt: now },
    ]);
    await database.insert(mlFeedbackEvents).values([
      { orgId: env.organization.id, sourceType: 'user_risk', sourceId: visible.id, eventType: 'user_risk.true_positive', outcome: 'true_positive', metadata: {}, occurredAt: now },
      { orgId: env.organization.id, sourceType: 'user_risk', sourceId: hidden.id, eventType: 'user_risk.false_positive', outcome: 'false_positive', metadata: {}, occurredAt: now },
      { orgId: env.organization.id, sourceType: 'user_risk', sourceId: nullSite.id, eventType: 'user_risk.false_positive', outcome: 'false_positive', metadata: {}, occurredAt: now },
    ]);

    // Unrestricted remains org-wide, including a membership whose site_ids is NULL.
    const unrestricted = await get(env.token, '/api/v1/user-risk/scores?limit=10');
    expect(unrestricted.status).toBe(200);
    expect(unrestricted.body.pagination.total).toBe(3);
    expect(JSON.stringify(unrestricted.body)).not.toContain(foreign.id);

    await setCallerSites(env.user.id, env.organization.id, [env.site.id]);

    // Hidden high scores cannot consume LIMIT before the visible low score is selected.
    const scores = await get(env.token, '/api/v1/user-risk/scores?limit=1');
    expect(scores.status).toBe(200);
    expect(scores.body.pagination.total).toBe(1);
    expect(scores.body.data.map((row: any) => row.userId)).toEqual([visible.id]);
    expect(JSON.stringify(scores.body)).not.toContain(hidden.id);
    expect(JSON.stringify(scores.body)).not.toContain(nullSite.id);

    const visibleDetail = await get(env.token, `/api/v1/user-risk/users/${visible.id}`);
    expect(visibleDetail.status).toBe(200);
    expect(visibleDetail.body.data.recentEvents.map((row: any) => row.eventType)).toEqual(['visible_signal']);
    expect((await get(env.token, `/api/v1/user-risk/users/${hidden.id}`)).status).toBe(404);
    expect((await get(env.token, `/api/v1/user-risk/users/${nullSite.id}`)).status).toBe(404);

    const events = await get(env.token, '/api/v1/user-risk/events?limit=10');
    expect(events.status).toBe(200);
    expect(events.body.pagination.total).toBe(1);
    expect(events.body.data.map((row: any) => row.userId)).toEqual([visible.id]);

    const evaluation = await get(env.token, '/api/v1/user-risk/evaluation?days=30');
    expect(evaluation.status).toBe(200);
    expect(evaluation.body.data).toMatchObject({
      totalLabels: 1,
      truePositives: 1,
      falsePositives: 0,
      riskSignals: 1,
      usersWithRiskSignals: 1,
    });

    // Current membership is authoritative: moving the target out removes all history.
    await database
      .update(organizationUsers)
      .set({ siteIds: [hiddenSite.id] })
      .where(and(eq(organizationUsers.userId, visible.id), eq(organizationUsers.orgId, env.organization.id)));
    expect((await get(env.token, `/api/v1/user-risk/users/${visible.id}`)).status).toBe(404);
    expect((await get(env.token, '/api/v1/user-risk/scores?limit=10')).body.pagination.total).toBe(0);

    await setCallerSites(env.user.id, env.organization.id, []);
    expect((await get(env.token, '/api/v1/user-risk/events?limit=10')).body.pagination.total).toBe(0);
    expect((await get(env.token, '/api/v1/user-risk/evaluation?days=30')).body.data.riskSignals).toBe(0);
  });

  runDb('stops showing a target after their current membership moves to a hidden site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'users', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Move destination' });
    const target = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `risk-move-${crypto.randomUUID().slice(0, 8)}@example.test`,
    });
    const database = getTestDb();
    const [membership] = await database.insert(organizationUsers).values({
      orgId: env.organization.id,
      userId: target.id,
      roleId: env.role.id,
      siteIds: [env.site.id],
    }).returning({ id: organizationUsers.id });
    await database.insert(userRiskScores).values({
      orgId: env.organization.id,
      userId: target.id,
      score: 42,
      factors: {},
      trendDirection: 'stable',
      calculatedAt: new Date(),
    });
    await setCallerSites(env.user.id, env.organization.id, [env.site.id]);

    // Visible while the target's CURRENT membership overlaps the caller ceiling.
    const before = await get(env.token, `/api/v1/user-risk/users/${target.id}`);
    expect(before.status).toBe(200);

    // Visibility follows the current membership, not the site the retained
    // history was recorded under: once the row moves out of the ceiling the
    // whole projection disappears, identity fields included.
    await database
      .update(organizationUsers)
      .set({ siteIds: [hiddenSite.id] })
      .where(eq(organizationUsers.id, membership!.id));

    const after = await get(env.token, `/api/v1/user-risk/users/${target.id}`);
    expect(after.status).toBe(404);
    expect(JSON.stringify(after.body)).not.toContain(target.email);
  });
});
