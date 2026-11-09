/**
 * #10402 — the first-look post and the brief timezone against real Postgres.
 * The unit suites cover the wording and the delivery shape; what only SQL can
 * prove is here:
 *   - exactly one post + one notification per grant, whatever retries or races;
 *   - the counts come from the grant's real runs and the org's real concerns;
 *   - an unsettled org holds the post until the grace limit, and the reconciler
 *     sweep then finds the grant, posts it once and stops finding it;
 *   - a grant past its first day or a paused grant posts nothing;
 *   - #11145: a batch nothing finished posts one couldn't-look post, which a later
 *     look does not block;
 *   - the browser zone lands in its own column and the resolver reads it;
 *   - #11428: the brief's Overnight counts split the grant's real runs into ran
 *     and skipped-because-nothing-changed.
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
  aiAgentRuns, aiAgents, organizations, partners, userNotifications, wispCheckIns, wispConcerns, wispGrantRevisions, wispGrants, wispThreadPosts,
  wispWatches,
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
import { buildBrief } from '../../services/wisp/brief';
import { resolveGrantCeiling } from '../../services/wisp/grantAuthority';
import { buildHomeSections } from '../../services/wisp/home';
import { loadBriefSchedule, saveBrowserTimezone, upsertNudgePrefs } from '../../services/wisp/nudgePreferences';
import { couldntLookDedupeKey, firstLookPostTimes, firstLookStateFrom } from '../../services/wisp/threadPosts';
import { getOrCreateThread } from '../../services/wisp/threads';
import { STANDING_STATE_MAX_BYTES, loadStandingStateFacts, renderStandingStateBlock } from '../../services/wisp/standingLoop';
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

async function seedTenant(orgCount: number, opts: { createdAt?: Date; siteIds?: string[] } = {}) {
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
      version: 1, permissionKeys: PERMS.map((p) => `${p.resource}:${p.action}`), orgIds: orgs.map((o) => o.id), siteIds: opts.siteIds ?? null,
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

const seedRun = (t: Tenant, orgId: string, status: string, errorCode: string | null = null) => sys(() => db.insert(aiAgentRuns).values({
  agentId: t.agentId, orgId, triggerKind: 'schedule', dedupeKey: `seed:${randomUUID()}`, modeAtStart: 'shadow',
  policySnapshot: {} as never, profile: 'assessment', status, errorCode, finishedAt: status === 'queued' || status === 'running' ? null : new Date(),
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

    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'first_look' });
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
    await expect(firstLookPostTimes(thread.id)).resolves.toEqual({ firstLookAt: posts[0]!.createdAt.toISOString(), couldntLookAt: null });
  });

  it('two runs finishing at once still leave one post', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'completed');
    const results = await Promise.all([postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId)]);
    expect(await postsFor(t.grantId)).toHaveLength(1);
    // Only the caller that wrote the row reports it: the sweep's counts must not be inflated.
    expect(results.filter((r) => r.posted)).toHaveLength(1);
    const notes = await sys(() => db.select().from(userNotifications).where(eq(userNotifications.dedupeKey, firstLookDedupeKey(t.grantId))));
    expect(notes).toHaveLength(1);
  });

  it('holds while a batch org has no settled run, then posts once it settles', async () => {
    const t = await seedTenant(2);
    await seedRun(t, t.orgs[0]!, 'completed');
    await seedRun(t, t.orgs[1]!, 'running');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'in_progress' });
    expect(await postsFor(t.grantId)).toHaveLength(0);

    await seedRun(t, t.orgs[1]!, 'failed');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'first_look' });
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

    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'first_look' });
    const [post] = await postsFor(t.grantId);
    expect(post!.title).toBe('First look done: 10 of 11 organizations');
    expect(post!.body).toContain('1 more is still queued');
  });

  describe('nothing was looked at (#11145)', () => {
    it('every run failing writes one couldn\'t-look post + one notification; a second settle writes nothing', async () => {
      const t = await seedTenant(2);
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      await seedRun(t, t.orgs[1]!, 'failed', 'sdk_error');

      await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
      await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'couldnt_look_posted' });

      const posts = await postsFor(t.grantId);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ kind: 'first_look', orgId: null, dedupeKey: couldntLookDedupeKey(t.grantId), title: "I couldn't look yet: 0 of 2 organizations" });
      expect(posts[0]!.body).toContain("The AI model wasn't available or couldn't finish for 2 organizations.");
      expect(posts[0]!.body).toContain("I'll try again around");
      expect(posts[0]!.body).not.toContain('llm_unavailable');
      const notes = await sys(() => db.select().from(userNotifications).where(eq(userNotifications.dedupeKey, couldntLookDedupeKey(t.grantId))));
      expect(notes).toHaveLength(1);

      const thread = await getOrCreateThread(t.grantId);
      const times = await firstLookPostTimes(thread.id);
      expect(times).toEqual({ firstLookAt: null, couldntLookAt: posts[0]!.createdAt.toISOString() });
      expect(firstLookStateFrom(times)).toBe('couldnt_look');
    });

    it('concurrent settles still leave one post', async () => {
      const t = await seedTenant(1);
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      const results = await Promise.all([postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId), postFirstLookIfDone(t.grantId)]);
      expect(await postsFor(t.grantId)).toHaveLength(1);
      expect(results.filter((r) => r.posted)).toHaveLength(1);
    });

    it('holds while a run is still in flight, even past the grace limit: it may yet look', async () => {
      const t = await seedTenant(2);
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      await seedRun(t, t.orgs[1]!, 'running');
      const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
      await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: false, reason: 'in_progress' });
      expect(await postsFor(t.grantId)).toHaveLength(0);
    });

    it('one run that looked means the ordinary post, never this one', async () => {
      const t = await seedTenant(2);
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      await seedRun(t, t.orgs[1]!, 'completed');
      await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'first_look' });
      const posts = await postsFor(t.grantId);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.dedupeKey).toBe(firstLookDedupeKey(t.grantId));
    });

    it('no run at all past the grace limit, with no agent readiness concern: admission refused', async () => {
      const t = await seedTenant(1);
      const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
      await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
      const [post] = await postsFor(t.grantId);
      expect(post!.body).toContain("My check wasn't allowed to start for 1 organization");
    });

    it('a no-agent readiness concern names the missing agent', async () => {
      const t = await seedTenant(1);
      await sys(() => db.insert(wispConcerns).values({
        partnerId: t.partnerId, orgId: t.orgs[0]!, subjectKind: 'readiness', subjectId: t.orgs[0]!, summary: 'No Triage agent', severity: 'info',
        evidence: { reason: 'no_effective_agent' }, signature: `wisp-readiness:no-effective-agent:${t.orgs[0]!}`,
      }));
      const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
      await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
      const [post] = await postsFor(t.grantId);
      expect(post!.body).toContain('1 organization has no Triage agent switched on.');
    });

    it('a spent grant budget says so and retries at the reset', async () => {
      const t = await seedTenant(1);
      await sys(() => db.update(wispGrants).set({ budgetCentsPerDay: 0 }).where(eq(wispGrants.id, t.grantId)));
      const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
      await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
      const [post] = await postsFor(t.grantId);
      expect(post!.body).toContain('An AI budget limit stopped me for 1 organization.');
      expect(post!.body).toContain("I'll try again on my regular checks once the daily budget resets");
    });

    it('a grant with no org it may assess (site-restricted) posts nothing: nothing was attempted', async () => {
      const t = await seedTenant(1, { siteIds: [randomUUID()] });
      const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
      await expect(postFirstLookIfDone(t.grantId, later)).resolves.toEqual({ posted: false, reason: 'nothing_looked_at' });
      expect(await postsFor(t.grantId)).toHaveLength(0);
    });

    it('a retry that looks still gets the real first look, after the couldn\'t-look post and even past the first day', async () => {
      const t = await seedTenant(1, { createdAt: new Date(Date.now() - FIRST_LOOK_WINDOW_MS + 60_000) });
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });

      await seedRun(t, t.orgs[0]!, 'completed');
      const pastWindow = new Date(Date.now() + 120_000);
      await expect(postFirstLookIfDone(t.grantId, pastWindow)).resolves.toEqual({ posted: true, variant: 'first_look' });

      const posts = await postsFor(t.grantId);
      expect(posts.map((p) => p.dedupeKey).sort()).toEqual([couldntLookDedupeKey(t.grantId), firstLookDedupeKey(t.grantId)].sort());
      const thread = await getOrCreateThread(t.grantId);
      expect(firstLookStateFrom(await firstLookPostTimes(thread.id))).toBe('done');
    });

    it('a grant past its first day never gets the couldn\'t-look post', async () => {
      const t = await seedTenant(1, { createdAt: new Date(Date.now() - FIRST_LOOK_WINDOW_MS - 60_000) });
      await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
      await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: false, reason: 'past_window' });
      expect(await postsFor(t.grantId)).toHaveLength(0);
    });
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
    expect(first.couldntLook).toBe(0);
    const [post] = await postsFor(t.grantId);
    expect(post!.title).toBe('First look done: 1 of 2 organizations');
    expect(post!.body).toContain('1 more is still queued');

    // The NOT EXISTS must match the key notifyUser wrote, or the grant is rescanned every tick for a day.
    const second = await resweepFirstLookPosts(later);
    expect(second.scanned).toBeLessThan(first.scanned);
    expect(second.posted).toBe(0);
    expect(await postsFor(t.grantId)).toHaveLength(1);
  });

  it('a revoked grant is not scanned at all', async () => {
    const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable'); // A couldn't-look post leaves it a candidate while active: a later look still owes the real one.
    const active = await resweepFirstLookPosts(later);
    await sys(() => db.update(wispGrants).set({ status: 'revoked' }).where(eq(wispGrants.id, t.grantId)));
    const revoked = await resweepFirstLookPosts(later);
    expect(revoked.scanned).toBeLessThan(active.scanned);
    expect(await postsFor(t.grantId)).toHaveLength(1);
  });

  it('a batch nothing finished posts once from the sweep, and is counted so it can be seen in the log (#11145)', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
    const later = new Date(Date.now() + FIRST_LOOK_GRACE_MS + 60_000);

    const first = await resweepFirstLookPosts(later);
    expect(first.posted).toBe(1);
    expect(first.couldntLook).toBe(1);
    const [post] = await postsFor(t.grantId);
    expect(post!.dedupeKey).toBe(couldntLookDedupeKey(t.grantId));

    const second = await resweepFirstLookPosts(later);
    expect(second.skipped.couldnt_look_posted).toBeGreaterThanOrEqual(1);
    expect(await postsFor(t.grantId)).toHaveLength(1);
  });
});

describe('resweepFirstLookPosts past the first day (#11145)', () => {
  const nearlyOld = () => new Date(Date.now() - FIRST_LOOK_WINDOW_MS + 60_000);
  const pastWindow = () => new Date(Date.now() + 120_000);

  it('a grant told it could not be looked at gets the real post from the sweep once a look lands, if finishRun missed it', async () => {
    const t = await seedTenant(1, { createdAt: nearlyOld() });
    await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
    await seedRun(t, t.orgs[0]!, 'completed');

    const swept = await resweepFirstLookPosts(pastWindow());
    expect(swept).toMatchObject({ scanned: 1, posted: 1, couldntLook: 0 });
    const keys = (await postsFor(t.grantId)).map((p) => p.dedupeKey);
    expect(keys).toContain(firstLookDedupeKey(t.grantId));

    await expect(resweepFirstLookPosts(pastWindow())).resolves.toMatchObject({ scanned: 0 });
  });

  it('past the first day with no look yet it is not scanned: no agent could otherwise keep it a candidate for good', async () => {
    const t = await seedTenant(1, { createdAt: nearlyOld() });
    await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
    await expect(postFirstLookIfDone(t.grantId)).resolves.toEqual({ posted: true, variant: 'couldnt_look' });
    await expect(resweepFirstLookPosts(pastWindow())).resolves.toMatchObject({ scanned: 0 });
  });

  it('a look on a grant never told it could not be looked at does not bring it back', async () => {
    const t = await seedTenant(1, { createdAt: nearlyOld() });
    await seedRun(t, t.orgs[0]!, 'completed');
    await expect(resweepFirstLookPosts(pastWindow())).resolves.toMatchObject({ scanned: 0 });
    expect(await postsFor(t.grantId)).toHaveLength(0);
  });
});

describe('first-look progress on the home (real Postgres, #11146)', () => {
  const home = async (t: Tenant, grantCreatedAt = new Date()) => {
    const thread = await getOrCreateThread(t.grantId);
    return buildHomeSections({
      auth: {} as never,
      partnerId: t.partnerId,
      grantId: t.grantId,
      grantorUserId: t.grantorId,
      threadId: thread.id,
      grantCreatedAt,
      ceiling: await resolveGrantCeiling(t.grantId, t.revisionId),
    });
  };

  it('counts an org once: failed then looked at is looked at, and a suspended org is in no count, as in the post', async () => {
    const t = await seedTenant(4);
    const [retried, failed, running, suspended] = t.orgs as [string, string, string, string];
    await seedRun(t, retried, 'failed', 'llm_unavailable');
    await seedRun(t, retried, 'completed');
    await seedRun(t, failed, 'failed', 'llm_unavailable');
    await seedRun(t, running, 'running');
    await seedRun(t, suspended, 'completed');
    await sys(() => db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, suspended)));

    expect((await home(t)).firstLookProgress).toEqual({ lookedAtOrgs: 1, failedOrgs: 1, queuedOrgs: 1, totalOrgs: 3 });
  });

  it('gone once the first look is posted', async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'completed');
    expect((await home(t)).firstLookProgress).toEqual({ lookedAtOrgs: 1, failedOrgs: 0, queuedOrgs: 0, totalOrgs: 1 });
    await postFirstLookIfDone(t.grantId);
    expect((await home(t)).firstLookProgress).toBeNull();
  });

  it("gone once the couldn't-look post is written, and that post is not a first look", async () => {
    const t = await seedTenant(1);
    await seedRun(t, t.orgs[0]!, 'failed', 'llm_unavailable');
    await postFirstLookIfDone(t.grantId);
    const sections = await home(t);
    expect(sections.firstLookProgress).toBeNull();
    expect(sections.firstLookAt).toBeNull();
  });

  it('gone past the grant\'s first day, with no post ever coming', async () => {
    const t = await seedTenant(1);
    expect((await home(t, new Date(Date.now() - FIRST_LOOK_WINDOW_MS - 60_000))).firstLookProgress).toBeNull();
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

describe('brief overnight assessment counts (real Postgres, #11428)', () => {
  it('splits the grant\'s runs since the last brief into ran and skipped-because-nothing-changed', async () => {
    const t = await seedTenant(2);
    const since = new Date(Date.now() - 60 * 60_000);
    await seedRun(t, t.orgs[0]!, 'completed');
    await seedRun(t, t.orgs[1]!, 'failed', 'model_error');
    // A skip with no error code is not #11423's nothing-changed gate (FILTER must not drop the NULL).
    await seedRun(t, t.orgs[0]!, 'skipped');
    await seedRun(t, t.orgs[0]!, 'skipped', 'no_changes');
    await seedRun(t, t.orgs[1]!, 'skipped', 'no_changes');
    await seedRun(t, t.orgs[0]!, 'queued'); // no finished_at: placed by its queued_at
    const run = (o: Record<string, unknown>) => sys(() => db.insert(aiAgentRuns).values({
      agentId: t.agentId, orgId: t.orgs[0]!, triggerKind: 'schedule', dedupeKey: `seed:${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: {} as never, profile: 'assessment', status: 'skipped', errorCode: 'no_changes', finishedAt: new Date(),
      grantId: t.grantId, grantRevisionId: t.revisionId, ...o,
    } as never));
    // None of these counts: before the last brief, not an assessment, an org outside the ceiling, another grant's run.
    await run({ queuedAt: new Date(since.getTime() - 120_000), finishedAt: new Date(since.getTime() - 60_000) });
    await run({ profile: 'full' });
    const outside = await createOrganization({ partnerId: t.partnerId });
    await run({ orgId: outside.id });
    const otherGrantor = await createUser({ partnerId: t.partnerId, email: `wisp-brief-other-${randomUUID()}@wisp.test` });
    const other = await sys(async () => {
      const [g] = await db.insert(wispGrants).values({
        partnerId: t.partnerId, orgId: null, grantorUserId: otherGrantor.id, status: 'active', expiresAt: new Date(Date.now() + 86_400_000),
      }).returning({ id: wispGrants.id });
      const [r] = await db.insert(wispGrantRevisions).values({
        grantId: g!.id, partnerId: t.partnerId, revision: 1,
        ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds: t.orgs, siteIds: null, toolAllowlist: null, deniedTools: [] },
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      return { grantId: g!.id, revisionId: r!.id };
    });
    await run({ grantId: other.grantId, grantRevisionId: other.revisionId });
    await run({ grantId: other.grantId, grantRevisionId: other.revisionId, status: 'completed', errorCode: null });

    const brief = await buildBrief(t.grantId, new Date(), { since });
    expect(brief.sections.find((s) => s.heading === 'Overnight')?.lines).toEqual([
      '4 assessments run',
      '2 assessments skipped — nothing had changed',
    ]);
  });
});

describe('standing-state facts (real Postgres, #10426)', () => {
  it('one read covers the grant, runs, concerns, watches, check-ins, alerts and the thread', async () => {
    const t = await seedTenant(2);
    await seedRun(t, t.orgs[0]!, 'completed');
    await seedRun(t, t.orgs[1]!, 'running');
    await seedConcern(t, t.orgs[0]!, 'high');
    await seedConcern(t, t.orgs[1]!, 'low');
    const thread = await getOrCreateThread(t.grantId);
    const dueAt = new Date(Date.now() + 3_600_000);
    await sys(async () => {
      await db.insert(wispWatches).values({
        partnerId: t.partnerId, orgId: t.orgs[0]!, grantId: t.grantId, ownerUserId: t.grantorId,
        kind: 'backup_health', cadenceMinutes: 60, nextDueAt: dueAt,
      });
      const checkInId = randomUUID();
      await db.insert(wispCheckIns).values({
        id: checkInId, partnerId: t.partnerId, orgId: null, grantId: t.grantId, threadId: thread.id,
        userId: t.grantorId, dueAt, instruction: 'Re-check the backups.', jobId: `wisp-check-in-${checkInId}`,
      });
    });

    const ceiling = await resolveGrantCeiling(t.grantId, t.revisionId);
    const facts = await loadStandingStateFacts(ceiling, { user: { id: t.grantorId }, accessibleOrgIds: null } as never);

    expect(facts).toMatchObject({
      status: 'active',
      firstLook: { assessedOrgs: 1, inFlight: 1, totalOrgs: 2 },
      scope: { partnerWide: ceiling.partnerWide, orgCount: 2, focusOrgName: null },
      concerns: { high: 1, medium: 0, low: 1 },
      watches: { active: 1 },
      checkIns: { scheduled: 1 },
      alerts: { critical: 0, high: 0 },
      spend: { totalCents: 0, budgetCentsPerDay: expect.any(Number) },
    });
    expect(facts!.checkIns.nextDueAt).toBeInstanceOf(Date);
    expect(Math.abs(facts!.checkIns.nextDueAt!.getTime() - dueAt.getTime())).toBeLessThan(1000);
    expect(facts!.concerns.top.map((c) => c.severity)).toEqual(['high', 'low']);
    expect(facts!.concerns.top[0]!.orgName).toEqual(expect.any(String));
    expect(facts!.recentAssessments).toHaveLength(1);
    expect(facts!.recentAssessments[0]!.at).toBeInstanceOf(Date);
    expect(Buffer.byteLength(renderStandingStateBlock(facts!, new Date()), 'utf8')).toBeLessThanOrEqual(STANDING_STATE_MAX_BYTES);
  });

  it('another grant\'s partner-level watches and check-ins, and settled check-ins, are not counted', async () => {
    const a = await seedTenant(1);
    const threadA = await getOrCreateThread(a.grantId);
    // A second grant of the SAME partner, with rows the org_id IS NULL branch would match if it were not grant-keyed.
    const otherGrantor = await createUser({ partnerId: a.partnerId, email: `wisp-standing-other-${randomUUID()}@wisp.test` });
    const otherGrantId = await sys(async () => {
      const [g] = await db.insert(wispGrants).values({
        partnerId: a.partnerId, orgId: null, grantorUserId: otherGrantor.id, status: 'active', expiresAt: new Date(Date.now() + 86_400_000),
      }).returning({ id: wispGrants.id });
      return g!.id;
    });
    const threadB = await getOrCreateThread(otherGrantId);
    const dueAt = new Date(Date.now() + 3_600_000);
    const checkIn = (grantId: string, threadId: string, userId: string, status: 'scheduled' | 'cancelled' = 'scheduled') => {
      const id = randomUUID();
      return db.insert(wispCheckIns).values({
        id, partnerId: a.partnerId, orgId: null, grantId, threadId, userId, dueAt, instruction: 'Look again.', jobId: `wisp-check-in-${id}`,
        status, ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      });
    };
    await sys(async () => {
      await db.insert(wispWatches).values({
        partnerId: a.partnerId, orgId: null, grantId: otherGrantId, ownerUserId: otherGrantor.id,
        kind: 'backup_health', cadenceMinutes: 60, nextDueAt: dueAt,
      });
      await checkIn(otherGrantId, threadB.id, otherGrantor.id);
      await checkIn(a.grantId, threadA.id, a.grantorId, 'cancelled');
      await checkIn(a.grantId, threadA.id, a.grantorId);
    });

    const ceiling = await resolveGrantCeiling(a.grantId, a.revisionId);
    const facts = await loadStandingStateFacts(ceiling, { user: { id: a.grantorId }, accessibleOrgIds: null } as never);
    expect(facts!.watches).toEqual({ active: 0 });
    expect(facts!.checkIns.scheduled).toBe(1);
  });
});
