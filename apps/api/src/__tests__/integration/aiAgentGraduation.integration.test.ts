/**
 * End-to-end live-Postgres proof for P2-5 graduation (#4192, Task A2-9 of
 * `docs/superpowers/plans/ai-mcp/2026-09-01-ai-agents-p2-5-graduation.md`).
 *
 * Tasks 11-18 each proved their own piece against mocks or compiled SQL. This
 * file is the only place the pieces are wired to each other and to a real
 * server, as ONE ordered narrative:
 *
 *   partner ceiling grants nothing (C3)
 *     -> `promoteThreshold` verified executions earned through the REAL
 *        writers (release an intent, then reach `held_qualified` on its
 *        intent-anchored watch)
 *     -> `refreshGraduationRow` says `eligible`
 *     -> POST /ai/agents/graduation/promote raises a four-eyes intent
 *     -> a DIFFERENT human approves it
 *     -> the release runs `authorizeSupervisedKey`: an org row is CLONED from
 *        the effective policy and holds the key; `ai_agent_graduation` is
 *        `promoted` with `promoted_intent_id`
 *     -> the effective policy now reports the key (what `attemptPolicyDecision`
 *        would consult)
 *     -> a second intent for the same key fails `execution_error`: the `failed`
 *        evidence row, the org-row revoke and the `demoted` graduation row
 *        commit together, the PARTNER row is untouched, and exactly one
 *        high-priority notification is queued
 *     -> the evidence window is re-bounded at `demoted_at`, so the clean
 *        history that earned the key stops counting.
 *
 * Nothing below can be proven by a unit suite. Every module on this path
 * mocks `../db` wholesale or asserts compiled SQL, so none of them ever
 * executes an advisory lock, a SAVEPOINT, an `ON CONFLICT` against a partial
 * unique index, `GREATEST(now() - interval, demoted_at)` against real
 * `timestamptz`, or an RLS policy. Four properties in particular were
 * explicitly deferred here by earlier review rounds and are called out at
 * their assertions:
 *
 *  - Task 16 fix round, carried item (1): advisory-lock-through-SAVEPOINT
 *    semantics. A revoke that FAILS inside `demoteRecurredKeys`' savepoint
 *    must leave the `recurred` verdict AND its evidence committed. Only a
 *    real Postgres subtransaction can show that; a `mockRejectedValue`
 *    throws in JS and never touches a transaction scope.
 *  - Task 18 review, carried items (1) and (2): evidence rows are keyed on
 *    the PARTNER baseline agent id (never the org override), and the read
 *    route's two direct queries behave correctly under real RLS.
 *
 * Lives under `src/__tests__/integration/`, so `vitest.integration.config.ts`'s
 * wholesale `src/__tests__/integration/**` include already covers it and the
 * unit runner's identical exclude drops it. A file placed anywhere else runs
 * in ZERO CI jobs.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

/**
 * The ONLY fake in this file: the tool-execution boundary, and only for
 * `manage_services` (there is no real device behind the fixture). It is a
 * PARTIAL mock through `importOriginal` for the same reason
 * `aiAgentOpEvidence.integration.test.ts` gives — mocking the module wholesale
 * makes every tool look unregistered and the release worker false-fails
 * `session_required` before it reaches a terminal CAS.
 *
 * `manage_ai_agents` is deliberately NOT faked: the whole point of the
 * narrative is that the real governance handler runs under the real release
 * context, so the implementation is delegated back to the genuine
 * `executeTool` captured in the factory below.
 */
const h = vi.hoisted(() => ({
  executeTool: vi.fn(),
  /** The genuine `executeTool`, captured at mock-factory time. */
  real: null as unknown,
  /** Flipped for the one release that must fail with `execution_error`. */
  failManageServices: false,
}));
vi.mock('../../services/aiTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiTools')>();
  h.real = actual.executeTool;
  return { ...actual, executeTool: h.executeTool };
});

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  actionIntents,
  aiAgentFixWatches,
  aiAgentGraduation,
  aiAgentOpEvidence,
  aiAgentRuns,
  aiAgents,
  alerts,
  approvalRequests,
  devices,
  userNotifications,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { canonicalPolicyKey } from '../../services/actionIntents/canonicalPolicyKey';
import { checkFixWatchPhase1, checkFixWatchPhase2 } from '../../services/aiAgents/fixWatch';
import {
  evaluateGraduation,
  refreshGraduationRow,
} from '../../services/aiAgents/graduationService';
import { resolveEffectiveAgentSystem } from '../../services/aiAgents/effectivePolicy';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { aiAgentsRoutes } from '../../routes/aiAgents';
import { approvalRoutes } from '../../routes/approvals';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const AGENT_KIND = 'triage' as const;
const TOOL_NAME = 'manage_services';
const GOVERNANCE_TOOL = 'manage_ai_agents';
const SERVICE_NAME = 'spooler';
const CONFIG_ITEM = 'cpu_high';

/** `canonicalPolicyKey('manage_services', { action: 'restart' })`. Asserted
 *  against the real resolver in the narrative rather than trusted. */
const OP_KEY = 'manage_services:restart';

/**
 * The partner baseline's `limits.promoteThreshold`, and therefore the number
 * of REAL released-and-verified executions this narrative has to earn.
 * `aiAgentLimitsSchema` floors the limit at 5, so this is the smallest honest
 * value — the default 20 would mean 20 full release + watch cycles for no
 * additional coverage.
 */
const PROMOTE_THRESHOLD = 5;

/** How far back the earned evidence is dated. Must be > the 14-day
 *  `AI_AGENT_GRADUATION_MIN_AGE_DAYS` floor and < the 30-day window. */
const EVIDENCE_AGE_DAYS = 20;

const DEVICES_EXECUTE = { resource: 'devices', action: 'execute' } as const;

/**
 * A deliberately NON-UNIFORM policy: every field carries a value distinct
 * from both the schema default and its neighbours, so the clone assertion
 * ("the org row is built from the EFFECTIVE policy, not from schema
 * defaults") fails on a wrong-field bug instead of passing by coincidence.
 * `mode: 'shadow'` is also load-bearing — `resolvePolicyDecisionState`
 * requires `act` for a policy-decided release, so every agent intent below
 * takes the deterministic human-fanout path and nothing races the narrative.
 */
function baselinePolicyFields(recipientUserId: string) {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [TOOL_NAME, 'get_device_details'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { promoteThreshold: PROMOTE_THRESHOLD, maxActionsPerRun: 7 },
    triggers: {},
    recipients: { userIds: [recipientUserId], roleIds: [] },
    instructions: null,
    cooldownSeconds: 777,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  alertId: string;
  /** The PARTNER baseline agent — the EFFECTIVE agent id every evidence and
   *  graduation row is keyed by. */
  agentId: string;
  /** Raises the promotion. Holds ai_agents:read/write, never approvals:decide. */
  requester: { id: string; email: string };
  requesterRoleId: string;
  /** The SECOND human. Holds approvals:decide — four-eyes needs a different
   *  person than the requester. */
  promoteApprover: { id: string; email: string };
  promoteApproverRoleId: string;
  /** Decides the agent's own supervised manage_services proposals (the live
   *  action-and-target re-check wants devices:execute), and is the demote
   *  notification's recipient. */
  agentApprover: { id: string; email: string };
  agentApproverRoleId: string;
}

let s: Scenario;

/**
 * One partner, one org, one online device, one already-RESOLVED triggering
 * alert (so a fix watch reaches phase 1 as `recovered` without a second
 * state flip), a PARTNER-OWNED baseline agent holding `manage_services:restart`
 * in its ceiling, and NO org override at all — the C3 starting state.
 */
async function seedScenario(): Promise<Scenario> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [
    { resource: PERMISSIONS.AI_AGENTS_READ.resource, action: PERMISSIONS.AI_AGENTS_READ.action },
    { resource: PERMISSIONS.AI_AGENTS_WRITE.resource, action: PERMISSIONS.AI_AGENTS_WRITE.action },
  ]);
  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@graduation.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const promoteApproverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(promoteApproverRole.id, [
    { resource: PERMISSIONS.APPROVALS_DECIDE.resource, action: PERMISSIONS.APPROVALS_DECIDE.action },
  ]);
  const promoteApprover = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@graduation.test`,
  });
  await assignUserToOrganization(promoteApprover.id, org.id, promoteApproverRole.id);

  const agentApproverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(agentApproverRole.id, [DEVICES_EXECUTE]);
  const agentApprover = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `agent-approver-${randomUUID()}@graduation.test`,
  });
  await assignUserToOrganization(agentApprover.id, org.id, agentApproverRole.id);

  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `graduation-agent-${unique}`,
      hostname: `graduation-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });

  // Already `resolved`: phase 1 of every fix watch below reads this row and
  // observes recovery immediately. Rule-less on purpose — the recurrence
  // query then matches on device + config_item_name, the shape
  // `checkFixWatchPhase2` uses for an `actVerify`-style alert.
  const [alert] = await adminDb
    .insert(alerts)
    .values({
      orgId: org.id,
      deviceId: device!.id,
      ruleId: null,
      configItemName: CONFIG_ITEM,
      severity: 'high',
      title: 'CPU high',
      status: 'resolved',
      triggeredAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    })
    .returning({ id: alerts.id });

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: AGENT_KIND,
        name: 'Graduation Triage',
        ...baselinePolicyFields(agentApprover.id),
        // THE CEILING. Not a grant: with no org row, the effective
        // supervisedActionKeys is `[]` (C3, Task 11).
        actAssets: { supervisedActionKeys: [OP_KEY] },
        createdBy: requester.id,
      })
      .returning({ id: aiAgents.id }),
  );

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    alertId: alert!.id,
    agentId: agent!.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: requesterRole.id,
    promoteApprover: { id: promoteApprover.id, email: promoteApprover.email },
    promoteApproverRoleId: promoteApproverRole.id,
    agentApprover: { id: agentApprover.id, email: agentApprover.email },
    agentApproverRoleId: agentApproverRole.id,
  };
}

/** A real org-scoped access token, minted exactly like the sibling
 *  decide-path integration suites' helpers. */
async function accessTokenFor(
  user: { id: string; email: string },
  roleId: string,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function agentApp(): Hono {
  const app = new Hono();
  app.route('/ai/agents', aiAgentsRoutes);
  return app;
}

function approvalsApp(): Hono {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

/** One agent run bound to the fixture device and the triggering alert. Each
 *  released intent gets its own run so nothing about this narrative depends
 *  on a per-run action budget. */
async function seedRun(): Promise<string> {
  const [run] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: s.agentId,
        orgId: s.orgId,
        deviceId: s.deviceId,
        alertId: s.alertId,
        triggerKind: 'alert',
        dedupeKey: `graduation-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: {
          schemaVersion: 9,
          agentId: s.agentId,
          kind: AGENT_KIND,
          effective: {
            ...baselinePolicyFields(s.agentApprover.id),
            actAssets: { supervisedActionKeys: [] },
          },
          resolvedAt: new Date().toISOString(),
        } as never,
      })
      .returning({ id: aiAgentRuns.id }),
  );
  return run!.id;
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1),
  );
  return row!;
}

/** The agent proposes a `manage_services:restart`; the one action-and-target
 *  eligible human approves it through the REAL decide route. */
async function proposeAndApproveAgentIntent(runId: string): Promise<string> {
  const auth = buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Graduation Triage', kind: AGENT_KIND },
    { id: runId, orgId: s.orgId, deviceId: s.deviceId, deviceSiteId: s.siteId },
    { id: s.orgId, partnerId: s.partnerId },
  );
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: { deviceId: s.deviceId, action: 'restart', serviceName: SERVICE_NAME },
    source: 'ai_agent',
  });
  expect(snapshot.status).toBe('pending_approval');

  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, snapshot.id)),
  );
  expect(rows).toHaveLength(1);

  const res = await approvalsApp().request(`/approvals/${rows[0]!.id}/approve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessTokenFor(s.agentApprover, s.agentApproverRoleId)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  expect((await readIntent(snapshot.id)).status).toBe('approved');
  return snapshot.id;
}

/** The intent-anchored fix watch this release opened. */
async function watchForIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiAgentFixWatches).where(eq(aiAgentFixWatches.intentId, intentId)).limit(1),
  );
  return row ?? null;
}

/**
 * ONE earned verified execution, entirely through the real writers:
 * propose -> human approve -> `releaseApprovedIntent` (writes `executed`)
 * -> phase 1 observes recovery -> phase 2 finds no recurrence and grades the
 * operation `verified`.
 */
async function earnOneVerifiedExecution(): Promise<{ intentId: string; runId: string }> {
  const runId = await seedRun();
  const intentId = await proposeAndApproveAgentIntent(runId);

  await releaseApprovedIntent(intentId);
  const released = await readIntent(intentId);
  expect(released.status, `release of ${intentId} did not complete`).toBe('completed');

  const watch = await watchForIntent(intentId);
  expect(watch, 'a released intent whose run carries a triggering alert must open a fix watch').not.toBeNull();
  expect(watch!.opKeys).toEqual([OP_KEY]);
  expect(watch!.sourceKind).toBe('intent');

  expect((await checkFixWatchPhase1(watch!.id)).action).toBe('recovered');
  expect((await checkFixWatchPhase2(watch!.id)).action).toBe('held_qualified');

  return { intentId, runId };
}

/** Every `policy_key` evidence row for the fixture org, oldest first. */
async function policyKeyEvidence() {
  return withSystemDbAccessContext(() =>
    db
      .select({
        opKey: aiAgentOpEvidence.opKey,
        metric: aiAgentOpEvidence.metric,
        agentId: aiAgentOpEvidence.agentId,
        sourceKind: aiAgentOpEvidence.sourceKind,
        occurredAt: aiAgentOpEvidence.occurredAt,
      })
      .from(aiAgentOpEvidence)
      .where(and(
        eq(aiAgentOpEvidence.orgId, s.orgId),
        eq(aiAgentOpEvidence.namespace, 'policy_key'),
      ))
      .orderBy(asc(aiAgentOpEvidence.occurredAt)),
  );
}

async function graduationRow() {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(aiAgentGraduation)
      .where(and(
        eq(aiAgentGraduation.orgId, s.orgId),
        eq(aiAgentGraduation.agentId, s.agentId),
        eq(aiAgentGraduation.opKey, OP_KEY),
      ))
      .limit(1),
  );
  return row ?? null;
}

async function orgAgentRow() {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(aiAgents)
      .where(and(eq(aiAgents.orgId, s.orgId), eq(aiAgents.kind, AGENT_KIND)))
      .limit(1),
  );
  return row ?? null;
}

async function partnerAgentRow() {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiAgents).where(eq(aiAgents.id, s.agentId)).limit(1),
  );
  return row!;
}

/** Only the demote pages — the approval fan-out queues notifications of its
 *  own and an unfiltered count would grade the wrong thing. */
async function demoteNotifications() {
  const rows = await withSystemDbAccessContext(() =>
    db.select().from(userNotifications).where(eq(userNotifications.orgId, s.orgId)),
  );
  return rows.filter((row) => row.dedupeKey?.startsWith('graduation-demote-'));
}

/**
 * Ages every earned evidence row by `EVIDENCE_AGE_DAYS`. The real writers
 * always stamp `occurred_at = now()`, so "≥ 14 days of clean history" can
 * only be established by moving the rows — the same direct-timestamp
 * manipulation `intentSupervisedFourEyes.integration.test.ts` uses to reach
 * t+30min of a real approval window. Predicated on the fixture org, never
 * table-wide.
 */
async function ageEarnedEvidence(): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(aiAgentOpEvidence)
      .set({ occurredAt: sql`now() - ${sql.raw(`interval '${EVIDENCE_AGE_DAYS} days'`)}` })
      .where(eq(aiAgentOpEvidence.orgId, s.orgId)),
  );
}

beforeEach(async () => {
  h.failManageServices = false;
  h.executeTool.mockReset();
  h.executeTool.mockImplementation(
    async (toolName: string, input: unknown, auth: unknown, opts?: unknown) => {
      if (toolName === GOVERNANCE_TOOL) {
        // The REAL governance handler, under the real release context — this
        // is the code the whole narrative exists to exercise.
        return (h.real as (
          t: string, i: unknown, a: unknown, o?: unknown,
        ) => Promise<string>)(toolName, input, auth, opts);
      }
      if (h.failManageServices) throw new Error('device unreachable');
      return JSON.stringify({ ok: true });
    },
  );
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  // ON for the whole narrative: the promote route 409s while it is dark and
  // the executor re-reads it live before granting. Agent intents are still
  // never policy-decided here, because the runs are `shadow` mode and
  // `resolvePolicyDecisionState` requires `act`.
  vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
  s = await seedScenario();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ===========================================================================
// The narrative
// ===========================================================================

describe('P2-5 graduation — ceiling, promote, grant, demote (real Postgres)', () => {
  it(
    'earns a key, promotes it through four-eyes, and loses it on the next attempted failure',
    async () => {
      // -------------------------------------------------------------------
      // 1. THE CEILING. A partner baseline naming the key grants an org with
      //    no override exactly nothing (C3, Task 11).
      // -------------------------------------------------------------------
      const before = await resolveEffectiveAgentSystem(s.orgId, AGENT_KIND);
      expect(before, 'the partner baseline must resolve for an org with no override').not.toBeNull();
      expect(before!.agentId, 'the EFFECTIVE agent is always the partner baseline row').toBe(s.agentId);
      expect(
        before!.effective.actAssets.supervisedActionKeys,
        'partner supervisedActionKeys are a CEILING, never an inherited grant',
      ).toEqual([]);
      expect(before!.effective.limits.promoteThreshold).toBe(PROMOTE_THRESHOLD);

      // -------------------------------------------------------------------
      // 2. EARN THE EVIDENCE, through the real writers only.
      // -------------------------------------------------------------------
      const earned: string[] = [];
      for (let i = 0; i < PROMOTE_THRESHOLD; i += 1) {
        const { intentId } = await earnOneVerifiedExecution();
        earned.push(intentId);
      }

      // The op key really is what the SHARED resolver produces — not a value
      // this test invented, and not a second ad hoc parse of `arguments`.
      expect(canonicalPolicyKey(TOOL_NAME, (await readIntent(earned[0]!)).arguments)).toBe(OP_KEY);

      const evidence = await policyKeyEvidence();
      expect(evidence).toHaveLength(PROMOTE_THRESHOLD * 2);
      expect(evidence.filter((row) => row.metric === 'executed')).toHaveLength(PROMOTE_THRESHOLD);
      expect(evidence.filter((row) => row.metric === 'verified')).toHaveLength(PROMOTE_THRESHOLD);
      // Task 18 review, carried item (1): every row is keyed on the PARTNER
      // baseline id. An org override appears later in this narrative; if any
      // writer keyed on it instead, the graduation window would split in two
      // and a promoted key would grade evidence nobody is counting.
      expect(new Set(evidence.map((row) => row.agentId))).toEqual(new Set([s.agentId]));
      expect(new Set(evidence.map((row) => row.opKey))).toEqual(new Set([OP_KEY]));

      // Fresh evidence is `too_recent`, whatever the count.
      const fresh = await evaluateGraduation(s.orgId, s.agentId, OP_KEY);
      expect(fresh.state).toBe('tracking');
      expect(fresh.blockedReason).toBe('too_recent');

      await ageEarnedEvidence();

      // -------------------------------------------------------------------
      // 3. ELIGIBLE.
      // -------------------------------------------------------------------
      const eligible = await refreshGraduationRow(s.orgId, s.agentId, OP_KEY);
      expect(eligible.state).toBe('eligible');
      expect(eligible.blockedReason).toBeNull();
      expect(eligible.window.verified).toBe(PROMOTE_THRESHOLD);
      expect(eligible.window.failed).toBe(0);
      expect(eligible.window.recurred).toBe(0);
      expect((await graduationRow())?.state).toBe('eligible');

      // The read route agrees, over real RLS, with the agent id resolved
      // SERVER-side (Task 18 review, carried item (2)).
      const readToken = await accessTokenFor(s.requester, s.requesterRoleId);
      const readBefore = await agentApp().request(
        `/ai/agents/graduation?orgId=${s.orgId}&kind=${AGENT_KIND}`,
        { headers: { Authorization: `Bearer ${readToken}` } },
      );
      expect(readBefore.status).toBe(200);
      const dtoBefore = await readBefore.json() as {
        agentId: string; ownerScope: string; promoteThreshold: number; policyDecideEnabled: boolean;
        rows: Array<{ opKey: string; state: string }>;
      };
      expect(dtoBefore.agentId).toBe(s.agentId);
      expect(dtoBefore.ownerScope, 'no org override exists yet').toBe('partner');
      expect(dtoBefore.promoteThreshold).toBe(PROMOTE_THRESHOLD);
      expect(dtoBefore.policyDecideEnabled).toBe(true);
      expect(dtoBefore.rows.find((row) => row.opKey === OP_KEY)?.state).toBe('eligible');

      // -------------------------------------------------------------------
      // 4. RAISE THE PROMOTION. The route grants nothing — it creates a
      //    Tier-3 four-eyes intent.
      // -------------------------------------------------------------------
      const promoteRes = await agentApp().request('/ai/agents/graduation/promote', {
        method: 'POST',
        headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: s.orgId, kind: AGENT_KIND, opKey: OP_KEY }),
      });
      expect(promoteRes.status, JSON.stringify(await promoteRes.clone().json())).toBe(201);
      const { intentId: promoteIntentId } = await promoteRes.json() as { intentId: string };

      const promoteIntent = await readIntent(promoteIntentId);
      expect(promoteIntent.actionName).toBe(GOVERNANCE_TOOL);
      expect(promoteIntent.approvalScope).toBe('four_eyes');
      expect(promoteIntent.requestingAgentRunId, 'a promotion is human-originated by construction').toBeNull();
      expect(promoteIntent.arguments).toMatchObject({
        action: 'authorize_supervised_key',
        kind: AGENT_KIND,
        opKey: OP_KEY,
        orgId: s.orgId,
      });

      // -------------------------------------------------------------------
      // 5. A DIFFERENT HUMAN APPROVES. Four-eyes as built: the requester is
      //    never fanned out to, and the first eligible approval wins.
      // -------------------------------------------------------------------
      const promoteApprovals = await withSystemDbAccessContext(() =>
        db
          .select({ id: approvalRequests.id, userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, promoteIntentId)),
      );
      expect(promoteApprovals).toHaveLength(1);
      expect(promoteApprovals[0]!.userId).toBe(s.promoteApprover.id);
      expect(promoteApprovals[0]!.userId).not.toBe(s.requester.id);

      const decideRes = await approvalsApp().request(
        `/approvals/${promoteApprovals[0]!.id}/approve`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await accessTokenFor(s.promoteApprover, s.promoteApproverRoleId)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      );
      expect(decideRes.status, JSON.stringify(await decideRes.clone().json())).toBe(200);
      expect((await readIntent(promoteIntentId)).status).toBe('approved');

      // -------------------------------------------------------------------
      // 6. RELEASE runs the REAL grant executor.
      // -------------------------------------------------------------------
      await releaseApprovedIntent(promoteIntentId);
      const releasedPromote = await readIntent(promoteIntentId);
      expect(
        releasedPromote.status,
        `promote release failed: ${releasedPromote.errorCode ?? ''} ${JSON.stringify(releasedPromote.result ?? {})}`,
      ).toBe('completed');

      // The org row was CLONED from the effective policy — a row of schema
      // defaults would have landed disabled, `off`, and empty-allowlisted,
      // i.e. promoting a key would have silently turned the agent off.
      const cloned = await orgAgentRow();
      expect(cloned, 'the grant must create the org override when none exists').not.toBeNull();
      expect(cloned!.partnerId).toBeNull();
      expect(cloned!.enabled).toBe(true);
      expect(cloned!.mode).toBe('shadow');
      expect(cloned!.toolAllowlist).toEqual([TOOL_NAME, 'get_device_details']);
      expect(cloned!.cooldownSeconds).toBe(777);
      expect(cloned!.limits).toMatchObject({ promoteThreshold: PROMOTE_THRESHOLD, maxActionsPerRun: 7 });
      expect(cloned!.recipients).toMatchObject({ userIds: [s.agentApprover.id] });
      expect(
        cloned!.instructions,
        'the rendered [partner guidance] block must not become the org row\'s own instructions',
      ).toBeNull();
      expect(cloned!.actAssets?.supervisedActionKeys).toEqual([OP_KEY]);

      const promoted = await graduationRow();
      expect(promoted?.state).toBe('promoted');
      expect(promoted?.promotedIntentId).toBe(promoteIntentId);
      expect(promoted?.promotedAt).not.toBeNull();
      expect(promoted?.demotedAt).toBeNull();

      // -------------------------------------------------------------------
      // 7. THE GRANT IS NOW EFFECTIVE — what `attemptPolicyDecision` reads.
      // -------------------------------------------------------------------
      const afterGrant = await resolveEffectiveAgentSystem(s.orgId, AGENT_KIND);
      expect(afterGrant!.agentId, 'the effective agent id is still the partner baseline').toBe(s.agentId);
      expect(afterGrant!.effective.actAssets.supervisedActionKeys).toEqual([OP_KEY]);

      const readAfter = await agentApp().request(
        `/ai/agents/graduation?orgId=${s.orgId}&kind=${AGENT_KIND}`,
        { headers: { Authorization: `Bearer ${readToken}` } },
      );
      const dtoAfter = await readAfter.json() as {
        agentId: string; ownerScope: string; rows: Array<{ opKey: string; state: string }>;
      };
      expect(dtoAfter.agentId).toBe(s.agentId);
      expect(dtoAfter.ownerScope, 'the org now has its own row').toBe('organization');
      expect(dtoAfter.rows.find((row) => row.opKey === OP_KEY)?.state).toBe('promoted');

      // -------------------------------------------------------------------
      // 8. THE NEXT ATTEMPT FAILS. `execution_error` is an ATTEMPTED
      //    failure — the tool really ran — so it grades, and grading it
      //    revokes the key.
      // -------------------------------------------------------------------
      const failingRunId = await seedRun();
      const failingIntentId = await proposeAndApproveAgentIntent(failingRunId);
      h.failManageServices = true;
      await releaseApprovedIntent(failingIntentId);
      h.failManageServices = false;

      const failed = await readIntent(failingIntentId);
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('execution_error');
      expect(failed.executedAt, 'execution_error stamps executedAt — the attempt really happened').not.toBeNull();

      // All three landed together.
      const afterFailure = await policyKeyEvidence();
      expect(afterFailure.filter((row) => row.metric === 'failed')).toHaveLength(1);
      expect(afterFailure.filter((row) => row.metric === 'failed')[0]!.agentId).toBe(s.agentId);

      const revoked = await orgAgentRow();
      expect(revoked!.id, 'the revoke edits the row the grant created').toBe(cloned!.id);
      expect(revoked!.actAssets?.supervisedActionKeys).toEqual([]);
      expect(revoked!.enabled, 'a demote never touches `enabled`').toBe(true);
      expect(revoked!.mode, 'a demote never touches `mode`').toBe('shadow');

      const demoted = await graduationRow();
      expect(demoted?.state).toBe('demoted');
      expect(demoted?.demoteReason).toBe('attempted_failure');
      expect(demoted?.demoteRunId).toBe(failingRunId);
      expect(demoted?.demoteWatchId).toBeNull();
      expect(demoted?.demotedAt).not.toBeNull();
      expect(
        demoted?.promotedIntentId,
        'a demotion does not un-happen the approval that granted the key',
      ).toBe(promoteIntentId);

      // The PARTNER ceiling is untouched: narrowing it is a partner-level
      // decision no automated signal from one org may make.
      const partnerAfter = await partnerAgentRow();
      expect(partnerAfter.actAssets?.supervisedActionKeys).toEqual([OP_KEY]);
      expect(partnerAfter.enabled).toBe(true);

      // Exactly one high-priority page, carrying identifiers only.
      const pages = await demoteNotifications();
      expect(pages).toHaveLength(1);
      expect(pages[0]!.userId).toBe(s.agentApprover.id);
      expect(pages[0]!.type).toBe('ai');
      expect(pages[0]!.priority).toBe('high');
      expect(pages[0]!.title).toBe('Unattended approval revoked: Graduation Triage');
      expect(pages[0]!.message).toContain(OP_KEY);
      expect(pages[0]!.dedupeKey).toBe(
        `graduation-demote-${cloned!.id}-${OP_KEY}-${failingRunId}`,
      );
      expect(pages[0]!.metadata).toMatchObject({
        agentId: s.agentId, orgAgentId: cloned!.id, opKey: OP_KEY, reason: 'attempted_failure',
      });

      // -------------------------------------------------------------------
      // 9. THE WINDOW IS RE-BOUNDED AT `demoted_at`. Everything the key
      //    earned before the demotion is outside it — including the `failed`
      //    row itself, which is stamped at or before `demoted_at`.
      // -------------------------------------------------------------------
      const afterDemote = await refreshGraduationRow(s.orgId, s.agentId, OP_KEY);
      expect(afterDemote.window).toEqual({
        executed: 0, verified: 0, failed: 0, recurred: 0, firstVerifiedAt: null,
      });
      // The stored `demoted` survives a refresh while the re-bounded window
      // holds no `verified` row — `refreshGraduationRow` never writes
      // `promoted`/`demoted`, and never clears one either.
      expect(afterDemote.state).toBe('demoted');
      expect(afterDemote.blockedReason).toBe('below_threshold');
      expect((await graduationRow())?.state).toBe('demoted');

      // One clean execution AFTER the demotion — through the same real
      // writers — walks the tuple back to `tracking`. This is the state the
      // plan's Task 19 narrative names; it is reached the way the state
      // machine actually defines it (Task 12: `demoted` holds only while the
      // re-bounded window has no `verified` row), not by the demote alone.
      await earnOneVerifiedExecution();
      const recovering = await refreshGraduationRow(s.orgId, s.agentId, OP_KEY);
      expect(recovering.state).toBe('tracking');
      expect(recovering.window.verified).toBe(1);
      expect(recovering.window.executed).toBe(1);
      expect(
        recovering.window.firstVerifiedAt,
        'the window\'s first verified is the first one AFTER the demotion',
      ).not.toBeNull();
      expect(new Date(recovering.window.firstVerifiedAt!).getTime()).toBeGreaterThan(
        demoted!.demotedAt!.getTime(),
      );
      expect((await graduationRow())?.state).toBe('tracking');
    },
    180_000,
  );
});

// ===========================================================================
// Containment: a revoke that fails must not take the verdict with it
// ===========================================================================

/**
 * Task 16's fix round left this as its one open cannot-verify item, carried
 * here by name: the auto-demote runs in a SAVEPOINT nested inside the
 * phase-2 verdict transaction, and the claim that a failure there rolls back
 * to the savepoint — leaving the `recurred` CAS, the watch-verdict evidence
 * and the operator-facing attention alert committed — was documented-Postgres
 * inference only. Every unit test passes either way, because a
 * `vi.fn().mockRejectedValue()` throws in JS and never touches a real
 * transaction scope; postgres-js's scope poisoning (the first failed query of
 * a scope is rethrown at scope end even when the caller caught it) needs a
 * real statement-level failure to reproduce.
 *
 * A NOT VALID CHECK on `ai_agent_graduation` supplies exactly that: the
 * revoke's own `ai_agents` UPDATE succeeds, then the graduation upsert fails
 * inside the savepoint.
 */
describe('P2-5 auto-demote — a failing revoke is contained in its savepoint', () => {
  it('keeps the recurred verdict and its evidence, and leaves the key granted', async () => {
    // The org already holds the key (the promotion is not what is under test
    // here — the containment is).
    const [orgRow] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgents)
        .values({
          orgId: s.orgId,
          partnerId: null,
          kind: AGENT_KIND,
          name: 'Graduation Triage',
          ...baselinePolicyFields(s.agentApprover.id),
          actAssets: { supervisedActionKeys: [OP_KEY] },
          createdBy: s.requester.id,
        })
        .returning({ id: aiAgents.id }),
    );

    const runId = await seedRun();
    const intentId = await proposeAndApproveAgentIntent(runId);
    await releaseApprovedIntent(intentId);
    expect((await readIntent(intentId)).status).toBe('completed');

    const watch = await watchForIntent(intentId);
    expect(watch).not.toBeNull();
    expect((await checkFixWatchPhase1(watch!.id)).action).toBe('recovered');

    // A recurrence of the same episode: same device, same rule-less
    // config_item_name, triggered strictly AFTER recovery was observed.
    const recovery = (await withSystemDbAccessContext(() =>
      db
        .select({ recoveryObservedAt: aiAgentFixWatches.recoveryObservedAt })
        .from(aiAgentFixWatches)
        .where(eq(aiAgentFixWatches.id, watch!.id))
        .limit(1),
    ))[0]!.recoveryObservedAt!;
    await getTestDb().insert(alerts).values({
      orgId: s.orgId,
      deviceId: s.deviceId,
      ruleId: null,
      configItemName: CONFIG_ITEM,
      severity: 'high',
      title: 'CPU high again',
      status: 'active',
      triggeredAt: new Date(recovery.getTime() + 60_000),
    });

    // Break the demote's LAST statement, in the database, so the failure is a
    // real statement-level abort inside the savepoint.
    await getTestDb().execute(sql`
      ALTER TABLE ai_agent_graduation
        ADD CONSTRAINT tmp_p2_5_block_demote CHECK (state <> 'demoted') NOT VALID
    `);
    try {
      expect((await checkFixWatchPhase2(watch!.id)).action).toBe('recurred');
    } finally {
      await getTestDb().execute(sql`
        ALTER TABLE ai_agent_graduation DROP CONSTRAINT IF EXISTS tmp_p2_5_block_demote
      `);
    }

    // The verdict stands. A `watching` watch is NOT recoverable — the
    // stranded-watch sweep scans `state = 'pending'` only — so unwinding this
    // CAS would mean the recurrence is never reported to anyone at all.
    const [after] = await withSystemDbAccessContext(() =>
      db.select().from(aiAgentFixWatches).where(eq(aiAgentFixWatches.id, watch!.id)).limit(1),
    );
    expect(after!.state).toBe('recurred');
    expect(after!.recurrenceAlertId).not.toBeNull();

    // ...and so does its evidence, written in the same transaction as the CAS.
    const recurredRows = (await policyKeyEvidence()).filter((row) => row.metric === 'recurred');
    expect(recurredRows).toHaveLength(1);
    expect(recurredRows[0]!.opKey).toBe(OP_KEY);

    // The revoke rolled back WHOLE: the key is still granted and no
    // graduation row claims a demotion that never committed.
    const orgAfter = await orgAgentRow();
    expect(orgAfter!.id).toBe(orgRow!.id);
    expect(
      orgAfter!.actAssets?.supervisedActionKeys,
      'a key that outlives its revoke by one sweep is strictly better than a recurrence nobody hears about',
    ).toEqual([OP_KEY]);
    expect(await graduationRow()).toBeNull();

    // No page for an authority change that did not happen.
    expect(await demoteNotifications()).toEqual([]);
  }, 120_000);
});
