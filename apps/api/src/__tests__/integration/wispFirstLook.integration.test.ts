/**
 * #10402 — the first-look post and the brief timezone against real Postgres.
 * The unit suites cover the wording and the delivery shape; what only SQL can
 * prove is here:
 *   - exactly one post + one notification per grant, whatever retries or races;
 *   - the counts come from the grant's real runs and the org's real concerns;
 *   - an unsettled org holds the post until the grace limit, and the reconciler
 *     sweep then finds the grant, posts it once and stops finding it;
 *   - a grant past its first day, a paused grant, or a batch nothing finished
 *     posts nothing;
 *   - the browser zone lands in its own column and the resolver reads it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentRuns, aiAgents, organizations, partners, userNotifications, wispConcerns, wispGrantRevisions, wispGrants, wispThreadPosts,
} from '../../db/schema';
import { wispNudgePreferences } from '../../db/schema/wispNudgePreferences';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import {
  FIRST_LOOK_GRACE_MS,
  FIRST_LOOK_WINDOW_MS,
  firstLookDedupeKey,
  postFirstLookIfDone,
  resweepFirstLookPosts,
} from '../../services/wisp/firstLook';
import { loadBriefSchedule, saveBrowserTimezone, upsertNudgePrefs } from '../../services/wisp/nudgePreferences';
import { firstLookPostedAt } from '../../services/wisp/threadPosts';
import { getOrCreateThread } from '../../services/wisp/threads';
import { onboardingBatch } from '../../services/wisp/wake';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const PERMS = [
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'alerts', action: 'read' },
  { resource: 'tickets', action: 'read' },
];

async function seedTenant(orgCount: number, opts: { createdAt?: Date } = {}) {
  const partner = await createPartner();
  const orgs: Array<{ id: string }> = [];
  for (let i = 0; i < orgCount; i += 1) orgs.push(await createOrganization({ partnerId: partner.id }));
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-first-look-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, PERMS);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');

  const grantId = await sys(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning({ id: wispGrants.id });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: PERMS.map((p) => `${p.resource}:${p.action}`), orgIds: orgs.map((o) => o.id), siteIds: null,
      toolAllowlist: null, deniedTools: [],
    };
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return g!.id;
  });
  const [{ revisionId }] = await sys(() => db.select({ revisionId: wispGrants.currentRevisionId }).from(wispGrants).where(eq(wispGrants.id, grantId))) as [{ revisionId: string }];
  const [agent] = await sys(() => db.insert(aiAgents).values({
    partnerId: partner.id, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: grantor.id,
  } as never).returning({ id: aiAgents.id }));
  return { partnerId: partner.id, orgs: orgs.map((o) => o.id), grantorId: grantor.id, grantId, revisionId, agentId: agent!.id };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

const seedRun = (t: Tenant, orgId: string, status: string) => sys(() => db.insert(aiAgentRuns).values({
  agentId: t.agentId, orgId, triggerKind: 'schedule', dedupeKey: `seed:${randomUUID()}`, modeAtStart: 'shadow',
  policySnapshot: {} as never, profile: 'assessment', status, finishedAt: status === 'queued' || status === 'running' ? null : new Date(),
  grantId: t.grantId, grantRevisionId: t.revisionId,
} as never));

const seedConcern = (t: Tenant, orgId: string, severity: 'high' | 'medium' | 'low') => sys(() => db.insert(wispConcerns).values({
  partnerId: t.partnerId, orgId, subjectKind: 'ticket', subjectId: randomUUID(), summary: `A ${severity} concern`, severity,
}));

const postsFor = (grantId: string) =>
  sys(() => db.select().from(wispThreadPosts).where(and(eq(wispThreadPosts.grantId, grantId), eq(wispThreadPosts.kind, 'first_look'))));

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('postFirstLookIfDone (real Postgres)', () => {
  it('the batch settling writes exactly one post + one notification with the counts; a retry writes nothing', async () => {
    const t = await seedTenant(2);
    await seedRun(t, t.orgs[0]!, 'completed');
    await seedRun(t, t.orgs[1]!, 'awaiting_approval');
    await seedConcern(t, t.orgs[0]!, 'high');
    await seedConcern(t, t.orgs[0]!, 'low');
    await seedConcern(t, t.orgs[1]!, 'low');

    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true });
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'already_posted' });

    const posts = await postsFor(t.grantId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'first_look', orgId: null, dedupeKey: firstLookDedupeKey(t.grantId), title: 'First look done: 2 of 2 organizations' });
    expect(posts[0]!.body).toContain('I looked at your 2 organizations.');
    expect(posts[0]!.body).toContain('Open concerns: 1 high, 2 low.');
    // Nothing is configured in these orgs, so the readiness inventory names real gaps.
    expect(posts[0]!.body).toContain("What I can't watch yet:");
    expect(posts[0]!.body).toContain('backups in 2 organizations');
    const notes = await sys(() => db.select().from(userNotifications).where(and(
      eq(userNotifications.userId, t.grantorId),
      eq(userNotifications.dedupeKey, firstLookDedupeKey(t.grantId)),
    )));
    expect(notes).toHaveLength(1);
    const thread = await getOrCreateThread(t.grantId);
    await expect(firstLookPostedAt(thread.id)).resolves.toBe(posts[0]!.createdAt.toISOString());
  });

  it('two runs finishing at once still leave one post', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'completed');
    await Promise.all([postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId)]);
    expect(await postsFor(t.grantId)).toHaveLength(1);
  });

  it('holds while a batch org has no settled run, then posts once it settles', async () => {
    const t = await seedTenant(2);
    await seedRun(t, t.orgs[0]!, 'completed');
    await seedRun(t, t.orgs[1]!, 'running');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'in_progress' });
    expect(await postsFor(t.grantId)).toHaveLength(0);

    await seedRun(t, t.orgs[1]!, 'failed');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true });
    const [post] = await postsFor(t.grantId);
    expect(post!.title).toBe('First look done: 1 of 2 organizations');
    expect(post!.body).toContain('I could not finish 1 organization');
    expect(post!.body).not.toContain('queued');
  });

  it('the orgs past the first ten are reported as still queued, and do not hold the post', async () => {
    const t = await seedTenant(11);
    // Org names are unique test values; the batch is the first ten by name, so settle whichever those are.
    const named = await sys(() => db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.partnerId, t.partnerId)));
    for (const o of onboardingBatch(named)) await seedRun(t, o.id, 'completed');

    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true });
    const [post] = await postsFor(t.grantId);
    expect(post!.title).toBe('First look done: 10 of 11 organizations');
    expect(post!.body).toContain('1 more is still queued');
  });

  it('nothing finished: no post, however long it has been (the readiness and budget notices speak for those)', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'failed');
    const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
    await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: false, reason: 'nothing_looked_at' });
    expect(await postsFor(t.grantId)).toHaveLength(0);
  });

  it('a grant past its first day never gets one (grants that predate this post)', async () => {
    const t = await seedTenant(1, { createdAt: new Date(Date.now() - FIRST_LOOK_WINDOW_MS - 60_000) });
    await seedRun(t, t.orgs[0]!, 'completed');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'past_window' });
    expect(await postsFor(t.grantId)).toHaveLength(0);
  });

  it('a paused grant posts nothing', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'completed');
    await sys(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused' }).where(eq(wispGrants.id, t.grantId)));
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'grant_inactive' });
    expect(await postsFor(t.grantId)).toHaveLength(0);
  });
});

describe('resweepFirstLookPosts (real Postgres)', () => {
  it('past the grace limit the sweep posts for an org that never got a run, then no longer finds the grant', async () => {
    const t = await seedTenant(2);
    await seedRun(t, t.orgs[0]!, 'completed');
    const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);

    const first = await resweepFirstLookPosts(later);
    expect(first.posted).toBeGreaterThanOrEqual(1);
    const [post] = await postsFor(t.grantId);
    expect(post!.title).toBe('First look done: 1 of 2 organizations');
    expect(post!.body).toContain('1 more is still queued');

    await resweepFirstLookPosts(later);
    expect(await postsFor(t.grantId)).toHaveLength(1);
  });

  it('a revoked grant is not scanned', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'completed');
    await sys(() => db.update(wispGrants).set({ status: 'revoked' }).where(eq(wispGrants.id, t.grantId)));
    await resweepFirstLookPosts(new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000));
    expect(await postsFor(t.grantId)).toHaveLength(0);
  });
});

describe('brief timezone (real Postgres)', () => {
  it('browser zone → partner zone → UTC, and a chosen zone stays ahead of the browser', async () => {
    const t = await seedTenant(1);
    await sys(() => db.update(partners).set({ timezone: 'America/New_York' }).where(eq(partners.id, t.partnerId)));
    await expect(loadBriefSchedule(t.grantorId, t.partnerId)).resolves.toEqual({
      timeLocal: '08:00', timezone: 'America/New_York', browserTimezone: null,
    });

    await expect(saveBrowserTimezone(t.grantorId, t.partnerId, 'America/Denver')).resolves.toBe(true);
    await expect(loadBriefSchedule(t.grantorId, t.partnerId)).resolves.toEqual({
      timeLocal: '08:00', timezone: 'America/Denver', browserTimezone: 'America/Denver',
    });

    await sys(() => upsertNudgePrefs(t.grantorId, t.partnerId, { briefTimezone: 'Asia/Tokyo' }));
    await saveBrowserTimezone(t.grantorId, t.partnerId, 'Europe/Berlin');
    const schedule = await loadBriefSchedule(t.grantorId, t.partnerId);
    expect(schedule).toEqual({ timeLocal: '08:00', timezone: 'Asia/Tokyo', browserTimezone: 'Europe/Berlin' });
    const [row] = await sys(() => db.select().from(wispNudgePreferences).where(eq(wispNudgePreferences.userId, t.grantorId)));
    expect(row!.briefTimezone).toBe('Asia/Tokyo');
  });
});
