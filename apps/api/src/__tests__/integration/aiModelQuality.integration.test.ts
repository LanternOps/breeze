/**
 * AI model registry W11 (#7609): the model quality view against real ledger
 * rows. Proves what the unit suite (rendered SQL) cannot: the attribution
 * rules, the resolution proxy, tenancy under RLS, and that the statement runs
 * on the real schema with the optional W05/W09 sources on and forced off.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { closeRegistryFixtures, fixtureSql, partnerContext, seedAgent, seedOffering } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel } from './helpers/aiModelRegistrySeed';
import { buildQualityQuery, queryAiQuality, queryAiQualityBreakdown } from '../../services/aiModels/qualityQueries';
import { detectQualitySources } from '../../services/aiModels/qualitySources';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const DAY = '2026-09-15';
const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;
/** Long before "now": an active session last touched then is idle-finished. */
const LONG_AGO = '2026-09-01T00:00:00Z';
const RANGE = { from: DAY, to: DAY, orgId: null };
const SOURCES = detectQualitySources();
const inSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const asPartner = <T>(p: string, orgs: string[], fn: () => Promise<T>) => withDbAccessContext(partnerContext(p, orgs), fn);

interface World { pA: string; pB: string; orgA: string; orgB: string; offS: string; offO: string; offB: string; userA: string; agentA?: string }

async function seedWorld(): Promise<World> {
  const pA = (await createPartner()).id;
  const pB = (await createPartner()).id;
  const orgA = (await createOrganization({ partnerId: pA })).id;
  const orgB = (await createOrganization({ partnerId: pB })).id;
  const pmS = await seedPricedPlatformModel();
  const pmO = await seedPricedPlatformModel();
  return {
    pA, pB, orgA, orgB,
    offS: await seedOffering({ partnerId: pA, platformModelId: pmS, enabled: true }),
    offO: await seedOffering({ partnerId: pA, platformModelId: pmO, enabled: true }),
    offB: await seedOffering({ partnerId: pB, platformModelId: pmS, enabled: true }),
    userA: (await createUser({ partnerId: pA })).id,
  };
}

async function seedSession(orgId: string, o: {
  status?: 'active' | 'closed' | 'expired'; lastActivity?: string; flagReason?: string | null; userTurns?: number;
} = {}): Promise<string> {
  const flagged = o.flagReason !== undefined && o.flagReason !== null;
  const [row] = await fixtureSql`
    INSERT INTO ai_sessions (org_id, model, status, last_activity_at, flagged_at, flag_reason)
    VALUES (${orgId}, 'model-x', ${o.status ?? 'closed'}, ${o.lastActivity ?? LONG_AGO},
            ${flagged ? LONG_AGO : null}, ${o.flagReason ?? null})
    RETURNING id`;
  const id = String(row!.id);
  for (let i = 0; i < (o.userTurns ?? 0); i++) {
    await fixtureSql`INSERT INTO ai_messages (session_id, role, content) VALUES (${id}, 'user', 'q')`;
  }
  return id;
}

async function seedRun(w: World, status: string, turnCount: number): Promise<string> {
  // ai_agents is unique per (org, kind): every run in a world belongs to one agent.
  const agentId = (w.agentA ??= await seedAgent({ orgId: w.orgA, createdBy: w.userA }));
  const [row] = await fixtureSql`
    INSERT INTO ai_agent_runs (agent_id, org_id, trigger_kind, dedupe_key, mode_at_start, policy_snapshot, status, turn_count)
    VALUES (${agentId}, ${w.orgA}, 'manual', ${`w11-${randomUUID()}`}, 'act', '{}'::jsonb, ${status}, ${turnCount})
    RETURNING id`;
  return String(row!.id);
}

/** One authoritative ledger row (platform-funded; the offering's partner owns the org). */
async function call(orgId: string, offeringId: string | null, over: Record<string, unknown> = {}): Promise<void> {
  await fixtureSql`INSERT INTO ai_invocations ${fixtureSql({
    org_id: orgId, surface: 'chat', funding_source: 'platform', requested_model: 'model-x', served_model: 'model-x',
    ledger_mode: 'authoritative', rate_snapshot: fixtureSql.json({}), cost_cents: 10, offering_id: offeringId,
    created_at: at('12:00'), ...over,
  })}`;
}

const byKey = <T extends { key: string }>(rows: T[]) => new Map(rows.map((r) => [r.key, r]));

describe.skipIf(!RUN)('AI model quality view (#7609 W11)', () => {
  describe('attribution', () => {
    it('refusal-fallback legs count toward the model that was chosen; a switch counts toward the model left', async () => {
      const w = await seedWorld();
      const s1 = await seedSession(w.orgA, { userTurns: 2 });
      // Turn 1 refused on S, served by its fallback: two legs, both bound to offS (W03).
      await call(w.orgA, w.offS, { session_id: s1, stop_reason: 'refusal', cost_cents: 5 });
      await call(w.orgA, w.offS, { session_id: s1, served_model: 'model-fallback', fallback_used: true, stop_reason: 'end_turn', cost_cents: 11 });
      await call(w.orgA, w.offS, { session_id: s1, created_at: at('12:05') });
      const s2 = await seedSession(w.orgA, { userTurns: 3 });
      await call(w.orgA, w.offS, { session_id: s2 });
      await call(w.orgA, w.offO, { session_id: s2, created_at: at('12:10') });
      await call(w.orgA, w.offO, { session_id: s2, created_at: at('12:20') });

      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      const rows = byKey(r.rows);
      expect(rows.get(w.offS)).toMatchObject({
        invocations: 4, costCents: 36, refusals: 1, refusalRate: 0.25,
        conversations: 1, switchedAway: 1, leftRate: 0.5, costPerConversationCents: 18,
      });
      expect(rows.get(w.offO)).toMatchObject({ invocations: 2, conversations: 1, switchedAway: 0, leftRate: 0 });
      expect(rows.get(w.offS)!.label).toEqual(expect.any(String));
      expect(rows.get(w.offS)!.connectionName).toBeNull();
      expect(r.totals).toMatchObject({ invocations: 6, conversations: 2, switchedAway: 1 });
    });

    it('orders a conversation by turn time: a deferred replay inserted last is not the last turn', async () => {
      const w = await seedWorld();
      const s = await seedSession(w.orgA);
      // Turn 1 on S settled late (deferred, replayed at 12:30); turn 2 on O settled at 12:10.
      await call(w.orgA, w.offS, { session_id: s, occurred_at: at('12:00'), created_at: at('12:30') });
      await call(w.orgA, w.offO, { session_id: s, occurred_at: at('12:10'), created_at: at('12:10') });
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      expect(byKey(r.rows).get(w.offS)).toMatchObject({ conversations: 0, switchedAway: 1 });
      expect(byKey(r.rows).get(w.offO)).toMatchObject({ conversations: 1, switchedAway: 0 });
    });

    it.runIf(SOURCES.failover)('a failover hop counts toward the origin offering (W09)', async () => {
      const w = await seedWorld();
      const s = await seedSession(w.orgA);
      await call(w.orgA, w.offO, { session_id: s, failover_from_offering_id: w.offS, failover_hop: 1, failover_cause: 'overloaded' });
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      expect(byKey(r.rows).get(w.offS)).toMatchObject({ invocations: 1, failovers: 1, failoverRate: 1, conversations: 1, switchedAway: 0 });
      expect(byKey(r.rows).has(w.offO)).toBe(false);
    });
  });

  describe('resolution', () => {
    it('only finished, unflagged-by-a-person, uncontinued sessions resolve; auto flags are counted apart', async () => {
      const w = await seedWorld();
      const ok = await seedSession(w.orgA, { status: 'closed', userTurns: 2 });
      const idle = await seedSession(w.orgA, { status: 'active', lastActivity: LONG_AGO, userTurns: 6 });
      const open = await seedSession(w.orgA, { status: 'active', lastActivity: new Date().toISOString(), userTurns: 9 });
      const human = await seedSession(w.orgA, { status: 'closed', flagReason: 'Wrong device', userTurns: 1 });
      const auto = await seedSession(w.orgA, { status: 'closed', flagReason: 'Tool failed: query_devices — boom', userTurns: 4 });
      for (const s of [ok, idle, open, human, auto]) await call(w.orgA, w.offS, { session_id: s });

      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      expect(byKey(r.rows).get(w.offS)).toMatchObject({
        conversations: 5, sessions: 5, flagged: 1, autoFlagged: 1, flagRate: 0.2,
        resolvedSessions: 3, medianTurnsToResolution: 4, // [2, 4, 6]; the open session's 9 never counts
        agentRuns: 0, agentCompletionRate: null,
      });
    });

    it('agent runs report completion, not turns', async () => {
      const w = await seedWorld();
      const done = await seedRun(w, 'completed', 7);
      const blocked = await seedRun(w, 'blocked', 2);
      const running = await seedRun(w, 'running', 1);
      for (const run of [done, blocked, running]) await call(w.orgA, w.offO, { surface: 'ai_agents', agent_run_id: run });
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'surface', accessibleOrgIds: [w.orgA] }));
      expect(byKey(r.rows).get('ai_agents')).toMatchObject({
        conversations: 3, sessions: 0, agentRuns: 2, agentRunsCompleted: 1, agentCompletionRate: 0.5,
        resolvedSessions: 0, medianTurnsToResolution: null, flagRate: null,
      });
    });

    it.runIf(SOURCES.continuation)('a continued session is not resolved; its continuation resolves with the chain\'s turns (W05)', async () => {
      const w = await seedWorld();
      const src = await seedSession(w.orgA, { status: 'closed', userTurns: 3 });
      const cont = await seedSession(w.orgA, { status: 'closed', userTurns: 2 });
      await fixtureSql`UPDATE ai_sessions SET continued_from_session_id = ${src} WHERE id = ${cont}`;
      await call(w.orgA, w.offS, { session_id: src, created_at: at('11:00') });
      await call(w.orgA, w.offO, { session_id: cont });
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      expect(byKey(r.rows).get(w.offS)).toMatchObject({ continued: 1, resolvedSessions: 0, leftRate: 1 });
      expect(byKey(r.rows).get(w.offO)).toMatchObject({ continued: 0, resolvedSessions: 1, medianTurnsToResolution: 5 });
    });

    it.runIf(SOURCES.continuation)('a conversation that switched and then continued leaves once', async () => {
      const w = await seedWorld();
      const both = await seedSession(w.orgA);
      await call(w.orgA, w.offS, { session_id: both, created_at: at('11:00') });
      await call(w.orgA, w.offO, { session_id: both, created_at: at('11:10') });
      const next = await seedSession(w.orgA);
      await fixtureSql`UPDATE ai_sessions SET continued_from_session_id = ${both} WHERE id = ${next}`;
      await call(w.orgA, w.offO, { session_id: next, created_at: at('12:00') });
      const stays = await seedSession(w.orgA);
      await call(w.orgA, w.offS, { session_id: stays, created_at: at('12:00') });
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'surface', accessibleOrgIds: [w.orgA] }));
      // chat: 3 conversations touched; `both` switched AND was continued — one leaver, not two.
      expect(byKey(r.rows).get('chat')).toMatchObject({ switchedAway: 1, continued: 1 });
      expect(byKey(r.rows).get('chat')!.leftRate).toBeCloseTo(1 / 3);
    });
  });

  describe('prompt provenance groupings', () => {
    it('groups by prompt profile, with pre-W11 rows as unrecorded', async () => {
      const w = await seedWorld();
      await call(w.orgA, w.offS, { prompt_profile: 'claude-small' });
      await call(w.orgA, w.offS, { prompt_profile: 'claude-small', prompt_variant: 'chat/claude-small@1' });
      await call(w.orgA, w.offS, {});
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'prompt_profile', accessibleOrgIds: [w.orgA] }));
      expect(r.rows.map((x) => [x.key, x.invocations]).sort()).toEqual([['claude-small', 2], ['unrecorded', 1]]);
    });

    it('groups by prompt variant (base keyed surface/profile@base) and honours the surface filter', async () => {
      const w = await seedWorld();
      await call(w.orgA, w.offS, { prompt_profile: 'claude-small' });
      await call(w.orgA, w.offS, { prompt_profile: 'claude-small', prompt_variant: 'chat/claude-small@1' });
      await call(w.orgA, w.offS, { surface: 'script_reviewer', prompt_profile: 'claude-small' });
      const r = await inSystem(() => queryAiQuality({ ...RANGE, groupBy: 'prompt_variant', accessibleOrgIds: null, surfaces: ['chat'] }));
      expect(r.rows.map((x) => x.key).sort()).toEqual(['chat/claude-small@1', 'chat/claude-small@base']);
    });
  });

  describe('tenancy', () => {
    async function twoPartners() {
      const w = await seedWorld();
      await call(w.orgA, w.offS, { cost_cents: 3 });
      await call(w.orgB, w.offB, { cost_cents: 7 });
      return w;
    }
    it('the caller\'s org list bounds a partner query', async () => {
      const w = await twoPartners();
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }));
      expect(r.rows.map((x) => x.key)).toEqual([w.offS]);
      expect(r.totals.costCents).toBe(3);
    });
    it('RLS alone bounds it too: an unrestricted list under partner A never sees partner B', async () => {
      const w = await twoPartners();
      const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'model', accessibleOrgIds: null }));
      expect(r.rows.map((x) => x.key)).toEqual([w.offS]);
      const forged = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, orgId: w.orgB, groupBy: 'model', accessibleOrgIds: null }));
      expect(forged.totals.invocations).toBe(0);
    });
    it('system scope with an unrestricted list is platform-wide by design (the admin report)', async () => {
      const w = await twoPartners();
      const r = await inSystem(() => queryAiQuality({ ...RANGE, groupBy: 'total', accessibleOrgIds: null }));
      expect(r.rows[0]).toMatchObject({ key: 'total', invocations: 2, costCents: 10 });
    });
  });

  it('forced-off sources still execute against the real schema and report null', async () => {
    const w = await seedWorld();
    await call(w.orgA, w.offS, { session_id: await seedSession(w.orgA) });
    const off = { failover: false, continuation: false };
    await expect(inSystem(() => db.execute(buildQualityQuery({ ...RANGE, groupBy: 'model', accessibleOrgIds: null }, off)))).resolves.toBeTruthy();
    const r = await inSystem(() => queryAiQuality({ ...RANGE, groupBy: 'model', accessibleOrgIds: [w.orgA] }, off));
    expect(r.sources).toEqual({ failovers: false, continuations: false });
    expect(r.rows[0]).toMatchObject({ failovers: null, failoverRate: null, continued: null });
  });

  it('an empty range returns no rows and zero totals', async () => {
    const w = await seedWorld();
    const r = await asPartner(w.pA, [w.orgA], () => queryAiQualityBreakdown({ ...RANGE, groupBy: 'surface', accessibleOrgIds: [w.orgA] }));
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ invocations: 0, conversations: 0, flagRate: null, medianTurnsToResolution: null });
  });
});
