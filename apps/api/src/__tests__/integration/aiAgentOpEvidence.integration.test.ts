/**
 * Live-Postgres proof for the P2-5 graduation evidence ledger (#4192,
 * Task 10 of `docs/superpowers/plans/ai-mcp/2026-09-01-ai-agents-p2-5-graduation.md`).
 *
 * The six properties below are the ones that CANNOT be proven anywhere else
 * in this PR. Every unit suite on this path either mocks `../db` wholesale or
 * asserts compiled SQL, so none of them ever executes an `ON CONFLICT`, a
 * SAVEPOINT, an RLS policy, a composite FK, a cascade order or a merge
 * policy against a real server:
 *
 *  1. EXACTLY-ONCE. `ai_agent_op_evidence_source_metric_uq` is the only thing
 *     standing between BullMQ redelivery and a double-counted graduation
 *     metric. A compiled-SQL test proves the clause was WRITTEN; only a real
 *     index proves it ARBITRATES.
 *  2. ATOMICITY, IN BOTH DIRECTIONS (see the section header for why this is
 *     not the direction the plan's Task 10 bullet named — Task 4's fix round
 *     deliberately reversed which side yields).
 *  3. WATCH FAN-OUT. One watch, N `op_keys`, N rows — the whole reason
 *     `watchEvidenceSourceId` puts the op key IN the source id (Deviation #3).
 *     A bare watch id would collide on the unique tuple and `ON CONFLICT DO
 *     NOTHING` would silently drop every key but the first.
 *  4. RLS. Both tables are Shape 1 and are auto-discovered by
 *     `rls-coverage.integration.test.ts` — but that suite reads pg_catalog,
 *     so it proves the policies EXIST, never that they REJECT. And the two
 *     composite same-org FKs are the tenancy invariant that holds even under
 *     a system context, where RLS passes unconditionally.
 *  5. ERASURE. Missing a cascade list is a latent GDPR bug that has shipped
 *     or reddened main five times (CLAUDE.md). `tenantCascade.integration.
 *     test.ts` proves membership + ordering statically; this proves the
 *     delete actually runs to completion with rows present.
 *  6. ORG MERGE. `leave-for-erasure` is the one merge policy whose bug mode
 *     is silence — a wrong classification repoints derived history onto an
 *     org whose runs stayed behind, and nothing errors.
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

// The ONLY fake in this file: the tool-execution boundary, partially mocked
// through `importOriginal` so the registry lookups the release worker makes
// around it (`requiresLiveSession`, the guardrail re-checks) stay genuine —
// mocking the module wholesale makes `manage_services` look unregistered and
// the worker false-fails `session_required` before it ever reaches a terminal
// CAS. Same fake, same reason, as `effectDigestToctou.integration.test.ts`.
const h = vi.hoisted(() => ({
  executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));
vi.mock('../../services/aiTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiTools')>();
  return { ...actual, executeTool: h.executeTool };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
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
  organizations,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { canonicalPolicyKey } from '../../services/actionIntents/canonicalPolicyKey';
import { insertOpEvidence, watchEvidenceSourceId } from '../../services/aiAgents/opEvidence';
import { checkFixWatchPhase2 } from '../../services/aiAgents/fixWatch';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { approvalRoutes } from '../../routes/approvals';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import * as orgMergeModule from '../../services/orgMerge';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'spooler';
const DEVICES_EXECUTE = { resource: 'devices', action: 'execute' } as const;

/** `canonicalPolicyKey('manage_services', {action:'restart'})`. Asserted against
 *  the real resolver in the first test rather than trusted, so a change to
 *  `resolveActionForTool` cannot silently re-key the whole ledger. */
const EXPECTED_OP_KEY = 'manage_services:restart';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** The effective policy the fixture agent runs under: shadow mode (proposes,
 *  never executes unilaterally) with manage_services allowlisted. Mirrors
 *  `agentIntentLifecycle.integration.test.ts` — the release gate checks the
 *  run's immutable snapshot AND the agent row's current policy, so the two
 *  must agree. */
function effectivePolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  runId: string;
  creatorId: string;
  eligible: { id: string; email: string };
  eligibleRoleId: string;
}

/**
 * Partner-owned baseline agent (`org_id IS NULL` — `resolveEffectiveAgent`
 * has no baseline to resolve for an org-owned row, and the release gate
 * requires `resolved.agentId === run.agentId`), one org-scoped run bound to a
 * real online device, and the ONE action-and-target-eligible human the
 * supervised fan-out will land on.
 */
async function seedScenario(): Promise<Scenario> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const creator = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `creator-${randomUUID()}@opevidence.test`,
  });

  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [DEVICES_EXECUTE]);
  const eligible = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `eligible-${randomUUID()}@opevidence.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `opevidence-agent-${unique}`,
      hostname: `opevidence-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Evidence Triage',
        ...effectivePolicyFields(),
        createdBy: creator.id,
      })
      .returning({ id: aiAgents.id }),
  );

  const [run] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        deviceId: device!.id,
        triggerKind: 'alert',
        dedupeKey: `op-evidence-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: {
          schemaVersion: 1,
          agentId: agent!.id,
          kind: 'triage',
          effective: effectivePolicyFields(),
          resolvedAt: new Date().toISOString(),
        } as never,
      })
      .returning({ id: aiAgentRuns.id }),
  );

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId: agent!.id,
    runId: run!.id,
    creatorId: creator.id,
    eligible: { id: eligible.id, email: eligible.email },
    eligibleRoleId: eligibleRole.id,
  };
}

async function accessTokenFor(s: Scenario): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.eligible.id,
    email: s.eligible.email,
    roleId: s.eligibleRoleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

/** Agent proposes -> the eligible human approves through the REAL route. The
 *  returned intent is `approved` and ready for `releaseApprovedIntent`. */
async function createAndApproveAgentIntent(s: Scenario): Promise<string> {
  const auth = buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Evidence Triage', kind: 'triage' },
    { id: s.runId, orgId: s.orgId, deviceId: s.deviceId, deviceSiteId: s.siteId },
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

  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  const res = await app.request(`/approvals/${rows[0]!.id}/approve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessTokenFor(s)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  expect((await readIntent(snapshot.id)).status).toBe('approved');
  return snapshot.id;
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1),
  );
  return row!;
}

/** Every evidence row for an org, ordered so assertions can compare whole
 *  arrays instead of cherry-picking — an UNEXPECTED extra row is exactly as
 *  interesting as a missing one for a ledger whose purpose is counting. */
async function evidenceFor(orgId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({
        namespace: aiAgentOpEvidence.namespace,
        opKey: aiAgentOpEvidence.opKey,
        sourceKind: aiAgentOpEvidence.sourceKind,
        sourceId: aiAgentOpEvidence.sourceId,
        metric: aiAgentOpEvidence.metric,
        runId: aiAgentOpEvidence.runId,
        agentId: aiAgentOpEvidence.agentId,
      })
      .from(aiAgentOpEvidence)
      .where(eq(aiAgentOpEvidence.orgId, orgId))
      .orderBy(asc(aiAgentOpEvidence.sourceId), asc(aiAgentOpEvidence.metric)),
  );
}

let s: Scenario;

beforeEach(async () => {
  h.executeTool.mockClear();
  h.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  // The kill switch defaults OFF; the release path re-reads it at dispatch
  // time for every agent-originated intent.
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  s = await seedScenario();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Exactly-once under redelivery
// ===========================================================================

describe('ai_agent_op_evidence — exactly-once under redelivery (real unique index)', () => {
  it('releaseApprovedIntent twice leaves exactly ONE executed row', async () => {
    const intentId = await createAndApproveAgentIntent(s);

    await releaseApprovedIntent(intentId);

    const afterFirst = await readIntent(intentId);
    expect(afterFirst.status).toBe('completed');
    expect(afterFirst.executedAt).not.toBeNull();
    expect(h.executeTool).toHaveBeenCalledTimes(1);

    // The op key really is what the SHARED resolver produces — not a second
    // ad hoc parse, and not a value this test invented.
    expect(canonicalPolicyKey(TOOL_NAME, afterFirst.arguments)).toBe(EXPECTED_OP_KEY);

    // `executed` for the terminal CAS, plus `verified` because this run
    // carries no triggering alert, so no fix watch can ever grade it
    // (intentReleaseWorker's `watchReleasedIntent`) — an operation no watch
    // will look at must not sit un-gradeable forever.
    expect(await evidenceFor(s.orgId)).toEqual([
      {
        namespace: 'policy_key',
        opKey: EXPECTED_OP_KEY,
        sourceKind: 'intent',
        sourceId: intentId,
        metric: 'executed',
        runId: s.runId,
        agentId: s.agentId,
      },
      {
        namespace: 'policy_key',
        opKey: EXPECTED_OP_KEY,
        sourceKind: 'intent',
        sourceId: intentId,
        metric: 'verified',
        runId: s.runId,
        agentId: s.agentId,
      },
    ]);

    // THE REDELIVERY. The claim CAS `approved -> executing` loses because the
    // row is already terminal, so the whole body is skipped: no second
    // execution, no second evidence row, no state change.
    await releaseApprovedIntent(intentId);

    expect(h.executeTool).toHaveBeenCalledTimes(1);
    const afterSecond = await readIntent(intentId);
    expect(afterSecond.status).toBe('completed');
    expect(afterSecond.executedAt?.getTime()).toBe(afterFirst.executedAt?.getTime());
    expect(await evidenceFor(s.orgId)).toHaveLength(2);
  });

  it('insertOpEvidence with identical inputs inserts once and returns 0 the second time', async () => {
    const row = {
      orgId: s.orgId,
      agentId: s.agentId,
      namespace: 'act_op' as const,
      opKey: 'service:restart',
      ruleId: null,
      sourceKind: 'act_execution' as const,
      sourceId: `${s.runId}:0`,
      metric: 'executed' as const,
      runId: s.runId,
      occurredAt: new Date(),
    };

    const first = await withSystemDbAccessContext(() => insertOpEvidence([row]));
    expect(first).toBe(1);

    // A REDELIVERED job recomputes the same deterministic source id and a
    // NEW occurredAt — the unique tuple is (source_kind, source_id, metric),
    // so the differing timestamp must not create a second row.
    const second = await withSystemDbAccessContext(() =>
      insertOpEvidence([{ ...row, occurredAt: new Date(Date.now() + 60_000) }]),
    );
    expect(second, 'a redelivered write must report 0 new rows, not throw and not insert').toBe(0);

    expect(await evidenceFor(s.orgId)).toEqual([
      {
        namespace: 'act_op',
        opKey: 'service:restart',
        sourceKind: 'act_execution',
        sourceId: `${s.runId}:0`,
        metric: 'executed',
        runId: s.runId,
        agentId: s.agentId,
      },
    ]);
  });
});

// ===========================================================================
// 2. Atomicity
// ===========================================================================

/**
 * The plan's Task 10 bullet asks to "force the evidence insert to throw inside
 * `terminalizeIntent` and assert the intent stays `executing`". Task 4's fix
 * round REVERSED which side yields, and that ruling is binding (SDD ledger,
 * "Task 4: fix round 1/5"): the evidence write now runs in its own SAVEPOINT
 * and a failure there is captured to Sentry, never rethrown — because rolling
 * a `completed` action back to `executing` to protect a counter buys a
 * permanent, silent `failed:execution_lost` for an action that ALREADY RAN.
 * Spec §4.5 only requires the row be inserted inside the terminalizing
 * transaction (the happy path is still one commit); it never asks the terminal
 * write to lose.
 *
 * So the contract has two directions and both are asserted here:
 *
 *   (a) a FAILING evidence insert leaves the terminal state intact — and does
 *       NOT poison the outer transaction. This is the only test anywhere that
 *       can catch un-threading the savepoint's executor: postgres-js records
 *       the first failed query of a scope in that scope's `uncaughtError` and
 *       rethrows it at scope end EVEN IF the caller caught the rejection, so a
 *       statement issued through the ambient `db` proxy instead of `tx` aborts
 *       the OUTER transaction and the CAS is lost. Every unit test passes
 *       either way, because a `vi.fn().mockRejectedValue()` throws in JS and
 *       never touches a real transaction scope.
 *
 *   (b) the writer JOINS the caller's transaction rather than opening its own
 *       connection — which is what makes "an evidence row can only exist for
 *       an outcome that actually became terminal" true. A rolled-back CAS
 *       leaves no phantom row behind.
 */
describe('ai_agent_op_evidence — atomicity against a real transaction scope', () => {
  it('a FAILING evidence insert keeps the terminal state and writes no row', async () => {
    const intentId = await createAndApproveAgentIntent(s);

    // A real statement-level failure, not a JS throw: this is the only shape
    // that reproduces postgres-js's scope poisoning. NOT VALID so existing
    // rows are not re-checked; it still applies to every new INSERT.
    await getTestDb().execute(sql`
      ALTER TABLE ai_agent_op_evidence
        ADD CONSTRAINT tmp_p2_5_block_evidence CHECK (metric <> 'executed') NOT VALID
    `);
    try {
      await releaseApprovedIntent(intentId);
    } finally {
      await getTestDb().execute(sql`
        ALTER TABLE ai_agent_op_evidence DROP CONSTRAINT IF EXISTS tmp_p2_5_block_evidence
      `);
    }

    const released = await readIntent(intentId);
    expect(
      released.status,
      'the terminal CAS must survive a failed evidence write — an action that already ran '
      + 'must never be rolled back to `executing` for the stale-executing reaper to find',
    ).toBe('completed');
    expect(released.executedAt).not.toBeNull();
    expect(h.executeTool).toHaveBeenCalledTimes(1);

    // No `verified` row either: `recordIntentTerminalEvidence` returns a null
    // anchor on failure, and a null anchor suppresses the watch/verified
    // branch entirely — a `verified` whose `executed` counterpart never
    // landed would read to the graduation service as a verification of an
    // operation that never happened.
    expect(await evidenceFor(s.orgId)).toEqual([]);
  });

  it('an evidence row written inside a rolled-back transaction never commits', async () => {
    const row = {
      orgId: s.orgId,
      agentId: s.agentId,
      namespace: 'policy_key' as const,
      opKey: EXPECTED_OP_KEY,
      ruleId: null,
      sourceKind: 'intent' as const,
      sourceId: randomUUID(),
      metric: 'executed' as const,
      runId: s.runId,
      occurredAt: new Date(),
    };

    class Rollback extends Error {}
    await expect(
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const inserted = await insertOpEvidence([row], tx);
          // It really did insert inside the transaction — otherwise the
          // rollback assertion below would pass for the wrong reason.
          expect(inserted).toBe(1);
          throw new Rollback('simulated terminal-CAS failure');
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);

    expect(await evidenceFor(s.orgId)).toEqual([]);
  });
});

// ===========================================================================
// 3. Watch fan-out
// ===========================================================================

describe('ai_agent_op_evidence — fix-watch fan-out over op_keys', () => {
  interface RecurrenceEpisode {
    triggeringAlertId: string;
    recurrenceAlertId: string;
    recoveryObservedAt: Date;
  }

  /** One alert that fired, recovered, and then recurred — the single
   *  real-world event every watch of the run is grading. */
  async function seedRecurrenceEpisode(): Promise<RecurrenceEpisode> {
    const adminDb = getTestDb();
    const recoveryObservedAt = new Date(Date.now() - 60 * 60 * 1000);

    const [triggering] = await adminDb
      .insert(alerts)
      .values({
        orgId: s.orgId,
        deviceId: s.deviceId,
        ruleId: null,
        configItemName: 'cpu_high',
        severity: 'high',
        title: 'CPU high',
        status: 'resolved',
        triggeredAt: new Date(recoveryObservedAt.getTime() - 60 * 60 * 1000),
      })
      .returning({ id: alerts.id });

    // The recurrence: same device, same rule-less + config_item_name shape,
    // triggered strictly AFTER recovery was observed.
    const [recurrence] = await adminDb
      .insert(alerts)
      .values({
        orgId: s.orgId,
        deviceId: s.deviceId,
        ruleId: null,
        configItemName: 'cpu_high',
        severity: 'high',
        title: 'CPU high again',
        status: 'active',
        triggeredAt: new Date(recoveryObservedAt.getTime() + 10 * 60 * 1000),
      })
      .returning({ id: alerts.id });

    return {
      triggeringAlertId: triggering!.id,
      recurrenceAlertId: recurrence!.id,
      recoveryObservedAt,
    };
  }

  /** A `watching` watch on an already-recurred episode, so phase 2 takes the
   *  `recurred` branch on its first call. */
  async function insertWatch(
    episode: RecurrenceEpisode,
    opts: { opKeys: string[]; sourceKind: 'act_run' | 'intent'; intentId?: string },
  ): Promise<string> {
    const [watch] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentFixWatches)
        .values({
          orgId: s.orgId,
          partnerId: s.partnerId,
          agentId: s.agentId,
          runId: s.runId,
          alertId: episode.triggeringAlertId,
          ruleId: null,
          deviceId: s.deviceId,
          configItemName: 'cpu_high',
          state: 'watching',
          recoveryObservedAt: episode.recoveryObservedAt,
          dueAt: new Date(Date.now() - 30 * 60 * 1000),
          sourceKind: opts.sourceKind,
          intentId: opts.intentId ?? null,
          opKeys: opts.opKeys,
        })
        .returning({ id: aiAgentFixWatches.id }),
    );
    return watch!.id;
  }

  async function seedRecurringWatch(opKeys: string[]): Promise<string> {
    return insertWatch(await seedRecurrenceEpisode(), { opKeys, sourceKind: 'act_run' });
  }

  /** Every rule-less "fix did not hold" alert this org has, newest last. */
  async function attentionAlertsFor(orgId: string) {
    return withSystemDbAccessContext(() =>
      db
        .select({ id: alerts.id, context: alerts.context })
        .from(alerts)
        .where(and(eq(alerts.orgId, orgId), eq(alerts.configItemName, 'ai_agent_fix_watch')))
        .orderBy(asc(alerts.triggeredAt)),
    );
  }

  it('a two-key watch reaching recurred writes exactly two rows, and a replay writes no third', async () => {
    const opKeys = ['service:restart', 'disk:cleanup'];
    const watchId = await seedRecurringWatch(opKeys);

    expect((await checkFixWatchPhase2(watchId)).action).toBe('recurred');

    // ONE ROW PER KEY — the property `watchEvidenceSourceId` exists for. With
    // a bare watch id as the source id, both keys would collide on
    // (source_kind, source_id, metric) and the second would be silently
    // absorbed by ON CONFLICT DO NOTHING.
    expect(await evidenceFor(s.orgId)).toEqual([
      {
        namespace: 'act_op',
        opKey: 'disk:cleanup',
        sourceKind: 'watch',
        sourceId: watchEvidenceSourceId(watchId, 'disk:cleanup'),
        metric: 'recurred',
        runId: s.runId,
        agentId: s.agentId,
      },
      {
        namespace: 'act_op',
        opKey: 'service:restart',
        sourceKind: 'watch',
        sourceId: watchEvidenceSourceId(watchId, 'service:restart'),
        metric: 'recurred',
        runId: s.runId,
        agentId: s.agentId,
      },
    ]);

    // A redelivered phase-2 job: the watch is no longer `watching`, so the
    // CAS finds nothing and the whole branch stands down.
    expect((await checkFixWatchPhase2(watchId)).action).toBe('not_found');
    expect(await evidenceFor(s.orgId)).toHaveLength(2);
  });

  // Review fix (P2-5, #4192). Before this wave a run had exactly ONE watch,
  // so "one attention alert per watch" and "one per recurrence" were the same
  // sentence. `createIntentFixWatchRow` broke that: N released intents give
  // one run N watches, every one of them denormalizing the SAME triggering
  // alert, so ONE recurrence wins N separate CAS races and reaches the
  // notify/alert fan-out N times. The evidence ledger is deliberately
  // per-watch (each grades its own op keys); the operator-facing alert must
  // not be.
  it('N sibling watches of one run raise exactly ONE attention alert for a single recurrence', async () => {
    const episode = await seedRecurrenceEpisode();
    const intentId = await createAndApproveAgentIntent(s);
    const actWatchId = await insertWatch(episode, { opKeys: ['service:restart'], sourceKind: 'act_run' });
    const intentWatchId = await insertWatch(episode, {
      opKeys: [EXPECTED_OP_KEY], sourceKind: 'intent', intentId,
    });

    expect((await checkFixWatchPhase2(actWatchId)).action).toBe('recurred');
    expect((await checkFixWatchPhase2(intentWatchId)).action).toBe('recurred');

    // Both watches DID grade their own key — the collapse is on the alert,
    // not on the ledger.
    // Sorted in JS on BOTH sides — the DB's own text collation must not be
    // what decides whether this assertion holds.
    const graded = (await evidenceFor(s.orgId)).map((r) => `${r.sourceId}|${r.metric}`).sort();
    expect(graded).toEqual([
      `${watchEvidenceSourceId(actWatchId, 'service:restart')}|recurred`,
      `${watchEvidenceSourceId(intentWatchId, EXPECTED_OP_KEY)}|recurred`,
    ].sort());

    // ...and the org gets ONE alert, stamped with the episode both watches
    // observed, not one alert per released intent.
    const attention = await attentionAlertsFor(s.orgId);
    expect(attention).toHaveLength(1);
    expect(attention[0]!.context).toMatchObject({
      source: 'ai_agent_fix_watch',
      runId: s.runId,
      recurrenceAlertId: episode.recurrenceAlertId,
    });
  });
});

// ===========================================================================
// 4. RLS forge + composite same-org FKs
// ===========================================================================

describe('ai_agent_op_evidence / ai_agent_graduation — RLS forge as breeze_app', () => {
  interface Victim {
    orgId: string;
    evidenceId: string;
    graduationId: string;
    intentId: string;
    runId: string;
  }

  /** A SECOND org under the SAME partner, holding one row in each new table.
   *  Same partner on purpose: a cross-PARTNER forge would be rejected by the
   *  partner axis too, which would let an org-axis regression pass. */
  async function seedVictimOrg(): Promise<Victim> {
    const victimOrg = await createOrganization({ partnerId: s.partnerId });
    const [run] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId: s.agentId,
          orgId: victimOrg.id,
          triggerKind: 'alert',
          dedupeKey: `victim-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: {
            schemaVersion: 1,
            agentId: s.agentId,
            kind: 'triage',
            effective: effectivePolicyFields(),
            resolvedAt: new Date().toISOString(),
          } as never,
        })
        .returning({ id: aiAgentRuns.id }),
    );

    const [evidence] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentOpEvidence)
        .values({
          orgId: victimOrg.id,
          agentId: s.agentId,
          namespace: 'policy_key',
          opKey: EXPECTED_OP_KEY,
          ruleId: null,
          sourceKind: 'intent',
          sourceId: randomUUID(),
          metric: 'executed',
          runId: run!.id,
          occurredAt: new Date(),
        })
        .returning({ id: aiAgentOpEvidence.id }),
    );
    const [graduation] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentGraduation)
        .values({ orgId: victimOrg.id, agentId: s.agentId, opKey: EXPECTED_OP_KEY, state: 'tracking' })
        .returning({ id: aiAgentGraduation.id }),
    );

    // A real intent belonging to the victim org — the composite-FK forge
    // target below.
    const victimIntentId = await createIntentIn(victimOrg.id, run!.id);

    return {
      orgId: victimOrg.id,
      evidenceId: evidence!.id,
      graduationId: graduation!.id,
      intentId: victimIntentId,
      runId: run!.id,
    };
  }

  /** The victim org needs an `action_intents` row to point a forged
   *  `promoted_intent_id` at. A bare insert is enough — nothing about this
   *  row's lifecycle matters, only that `(id, org_id)` exists in the OTHER
   *  org. */
  async function createIntentIn(orgId: string, runId: string): Promise<string> {
    const [row] = await withSystemDbAccessContext(() =>
      db
        .insert(actionIntents)
        .values({
          orgId,
          partnerId: s.partnerId,
          requestingAgentRunId: runId,
          originPrincipalKind: 'ai_agent',
          originPrincipalId: s.agentId,
          source: 'ai_agent',
          actionName: TOOL_NAME,
          arguments: { deviceId: s.deviceId, action: 'restart', serviceName: SERVICE_NAME },
          argumentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          targetSummary: 'victim org service',
          impactSummary: 'restart a service',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'pending_approval',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning({ id: actionIntents.id }),
    );
    return row!.id;
  }

  it('an org-scoped INSERT naming another org is 42501 on both tables', async () => {
    const victim = await seedVictimOrg();
    const ctx = orgContext(s.orgId, s.partnerId);

    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db.insert(aiAgentOpEvidence).values({
            orgId: victim.orgId,
            agentId: s.agentId,
            namespace: 'policy_key',
            opKey: EXPECTED_OP_KEY,
            ruleId: null,
            sourceKind: 'intent',
            sourceId: randomUUID(),
            metric: 'executed',
            runId: null,
            occurredAt: new Date(),
          }),
        ),
      '42501',
    );

    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db
            .insert(aiAgentGraduation)
            .values({ orgId: victim.orgId, agentId: s.agentId, opKey: 'other:key', state: 'tracking' }),
        ),
      '42501',
    );
  });

  it('an org-scoped UPDATE that re-tenants a row to another org is 42501 on both tables', async () => {
    const victim = await seedVictimOrg();
    const ctx = orgContext(s.orgId, s.partnerId);

    const [mine] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentOpEvidence)
        .values({
          orgId: s.orgId,
          agentId: s.agentId,
          namespace: 'policy_key',
          opKey: EXPECTED_OP_KEY,
          ruleId: null,
          sourceKind: 'intent',
          sourceId: randomUUID(),
          metric: 'executed',
          runId: null,
          occurredAt: new Date(),
        })
        .returning({ id: aiAgentOpEvidence.id }),
    );
    const [myGrad] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentGraduation)
        .values({ orgId: s.orgId, agentId: s.agentId, opKey: EXPECTED_OP_KEY, state: 'tracking' })
        .returning({ id: aiAgentGraduation.id }),
    );

    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db
            .update(aiAgentOpEvidence)
            .set({ orgId: victim.orgId })
            .where(eq(aiAgentOpEvidence.id, mine!.id)),
        ),
      '42501',
    );
    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db
            .update(aiAgentGraduation)
            .set({ orgId: victim.orgId })
            .where(eq(aiAgentGraduation.id, myGrad!.id)),
        ),
      '42501',
    );
  });

  it("an org-scoped SELECT cannot see another org's rows", async () => {
    const victim = await seedVictimOrg();
    const ctx = orgContext(s.orgId, s.partnerId);

    // SELECT is FILTERED, not rejected: a `USING` policy removes the row from
    // the result rather than raising 42501 (only INSERT/UPDATE `WITH CHECK`
    // raises). The security property is "zero rows", and it is asserted
    // against a row that provably EXISTS under a system context — otherwise
    // an empty result proves nothing at all.
    const systemVisible = await withSystemDbAccessContext(() =>
      db.select({ id: aiAgentOpEvidence.id }).from(aiAgentOpEvidence).where(eq(aiAgentOpEvidence.id, victim.evidenceId)),
    );
    expect(systemVisible).toHaveLength(1);
    const orgVisible = await withDbAccessContext(ctx, () =>
      db.select({ id: aiAgentOpEvidence.id }).from(aiAgentOpEvidence).where(eq(aiAgentOpEvidence.id, victim.evidenceId)),
    );
    expect(orgVisible).toHaveLength(0);

    const systemGrad = await withSystemDbAccessContext(() =>
      db.select({ id: aiAgentGraduation.id }).from(aiAgentGraduation).where(eq(aiAgentGraduation.id, victim.graduationId)),
    );
    expect(systemGrad).toHaveLength(1);
    const orgGrad = await withDbAccessContext(ctx, () =>
      db.select({ id: aiAgentGraduation.id }).from(aiAgentGraduation).where(eq(aiAgentGraduation.id, victim.graduationId)),
    );
    expect(orgGrad).toHaveLength(0);
  });

  it('a cross-tenant composite FK forge is 23503 EVEN UNDER a system context', async () => {
    const victim = await seedVictimOrg();

    // System context: RLS passes unconditionally here, so the composite
    // same-org FK is the ONLY thing left standing between a forged pointer
    // and a cross-tenant attribution. That is precisely why these FKs are
    // composite and not single-column.
    await expectSqlState(
      () =>
        withSystemDbAccessContext(() =>
          db.insert(aiAgentGraduation).values({
            orgId: s.orgId,
            agentId: s.agentId,
            opKey: 'forged:key',
            state: 'promoted',
            promotedIntentId: victim.intentId,
          }),
        ),
      '23503',
    );

    await expectSqlState(
      () =>
        withSystemDbAccessContext(() =>
          db.insert(aiAgentOpEvidence).values({
            orgId: s.orgId,
            agentId: s.agentId,
            namespace: 'policy_key',
            opKey: EXPECTED_OP_KEY,
            ruleId: null,
            sourceKind: 'intent',
            sourceId: randomUUID(),
            metric: 'executed',
            runId: victim.runId,
            occurredAt: new Date(),
          }),
        ),
      '23503',
    );
  });
});

// ===========================================================================
// 5. Erasure
// ===========================================================================

describe('ai_agent_op_evidence / ai_agent_graduation — org erasure', () => {
  /** A run + one row in each new table, in `orgId`. The evidence row's
   *  `run_id` is the point: the cascade has to delete evidence BEFORE
   *  `ai_agent_runs` or the run delete raises 23503 — the FK-direction
   *  property `CORE_ORG_CASCADE_DELETE_ORDER` encodes and a membership-only
   *  check cannot see. */
  async function seedBoth(orgId: string): Promise<void> {
    const [run] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId: s.agentId,
          orgId,
          triggerKind: 'alert',
          dedupeKey: `erasure-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: {
            schemaVersion: 1,
            agentId: s.agentId,
            kind: 'triage',
            effective: effectivePolicyFields(),
            resolvedAt: new Date().toISOString(),
          } as never,
        })
        .returning({ id: aiAgentRuns.id }),
    );
    await withSystemDbAccessContext(() =>
      db.insert(aiAgentOpEvidence).values({
        orgId,
        agentId: s.agentId,
        namespace: 'policy_key',
        opKey: EXPECTED_OP_KEY,
        ruleId: null,
        sourceKind: 'intent',
        sourceId: randomUUID(),
        metric: 'executed',
        runId: run!.id,
        occurredAt: new Date(),
      }),
    );
    await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentGraduation)
        .values({ orgId, agentId: s.agentId, opKey: EXPECTED_OP_KEY, state: 'tracking' }),
    );
  }

  it('cascadeDeleteOrg deletes both tables and leaves a control org untouched', async () => {
    // A PAIR of orgs seeded by this test rather than the shared fixture org:
    // `seedScenario` grants its role a permission, and `role_permissions` has
    // no org_id column, no cascade entry and no pre-clear, so `DELETE FROM
    // roles` aborts 23503 for any org holding one. That is a pre-existing
    // gap unrelated to P2-5 (see this task's report) — erasing a clean pair
    // keeps this test measuring the two NEW tables.
    const eraseOrg = await createOrganization({ partnerId: s.partnerId });
    const control = await createOrganization({ partnerId: s.partnerId });
    await seedBoth(eraseOrg.id);
    await seedBoth(control.id);

    const stats = await cascadeDeleteOrg(eraseOrg.id, s.creatorId, 'erasure@opevidence.test');
    expect(stats.tablesDeleted['ai_agent_op_evidence']).toBe(1);
    expect(stats.tablesDeleted['ai_agent_graduation']).toBe(1);

    const remaining = await withSystemDbAccessContext(async () => ({
      evidence: await db.select({ orgId: aiAgentOpEvidence.orgId }).from(aiAgentOpEvidence),
      graduation: await db.select({ orgId: aiAgentGraduation.orgId }).from(aiAgentGraduation),
      orgs: await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, eraseOrg.id)),
    }));
    expect(remaining.evidence.map((r) => r.orgId)).toEqual([control.id]);
    expect(remaining.graduation.map((r) => r.orgId)).toEqual([control.id]);
    expect(remaining.orgs).toHaveLength(0);
  });
});

// ===========================================================================
// 6. Org merge
// ===========================================================================

describe('ai_agent_op_evidence / ai_agent_graduation — org merge (leave-for-erasure)', () => {
  let priorDrain: string | undefined;

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });

  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('a merge with rows in both tables succeeds and leaves them on the loser shell', async () => {
    const survivor = await createOrganization({ partnerId: s.partnerId });

    const [evidence] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentOpEvidence)
        .values({
          orgId: s.orgId,
          agentId: s.agentId,
          namespace: 'policy_key',
          opKey: EXPECTED_OP_KEY,
          ruleId: null,
          sourceKind: 'intent',
          sourceId: randomUUID(),
          metric: 'executed',
          runId: s.runId,
          occurredAt: new Date(),
        })
        .returning({ id: aiAgentOpEvidence.id }),
    );
    const [graduation] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentGraduation)
        .values({ orgId: s.orgId, agentId: s.agentId, opKey: EXPECTED_OP_KEY, state: 'tracking' })
        .returning({ id: aiAgentGraduation.id }),
    );

    const result = await orgMergeModule.executeOrgMerge({
      loserOrgId: s.orgId,
      survivorOrgId: survivor.id,
      partnerId: s.partnerId,
      performedBy: s.creatorId,
      performedByEmail: 'merge@opevidence.test',
    });

    // Neither table appears in the per-table summary at all: the engine never
    // touches a `leave-for-erasure` table, so a row there is not "moved: 0" —
    // it is absent.
    expect(result.tables['ai_agent_op_evidence']).toBeUndefined();
    expect(result.tables['ai_agent_graduation']).toBeUndefined();

    const after = await withSystemDbAccessContext(async () => ({
      evidence: await db
        .select({ orgId: aiAgentOpEvidence.orgId })
        .from(aiAgentOpEvidence)
        .where(eq(aiAgentOpEvidence.id, evidence!.id)),
      graduation: await db
        .select({ orgId: aiAgentGraduation.orgId })
        .from(aiAgentGraduation)
        .where(eq(aiAgentGraduation.id, graduation!.id)),
    }));
    // STILL under the loser. Graduation state is derived from evidence tied
    // to runs that stay with the source org — repointing it would carry a
    // promotion story the evidence cannot follow.
    expect(after.evidence.map((r) => r.orgId)).toEqual([s.orgId]);
    expect(after.graduation.map((r) => r.orgId)).toEqual([s.orgId]);
  });
});
