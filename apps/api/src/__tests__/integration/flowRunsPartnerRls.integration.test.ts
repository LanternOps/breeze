/**
 * Tool Catalog W04 (#5219), plan Task A12 — flow publications, runs, steps and
 * flow-originated intents against REAL Postgres as breeze_app under FORCE RLS:
 * the policies, CHECKs, composite FKs and immutability triggers of
 * migrations/2027-01-06-130000-flow-runs.sql, the flow principal's DB context,
 * and three service paths whose SQL the unit mocks cannot prove (the dispatch
 * claim after a re-enable and after an org merge, and the delegation ceiling
 * against real permission rows).
 *
 * Covered elsewhere and NOT repeated here: lease / fenced checkpoint / run
 * slot (flowRunLease), dedupe and the partner-wide event + schedule fan-out
 * (flowTriggers), the four-eyes decide/claim/release path, `lost_race` after
 * completion, `delegator_inactive` and `run_leased` (intentSupervisedFourEyes).
 * The runner end to end lives in flowRunnerEndToEnd.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, devices, flowRuns, flowRunSteps, flows, flowVersions, organizationUsers } from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildFlowAuthContext, flowDbAccessContext } from '../../services/flows/flowAuthContext';
import { claimFlowLinkedIntentForDispatch } from '../../services/flows/intentClaim';
import { enableFlow, pauseFlow } from '../../services/flows/versions';
import { CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import { buildRepoint } from '../../services/orgMergeExecutors';
import { pgErrorConstraint } from '../../utils/pgErrors';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { parkFlowRunOnIntent, readFlowRunState, seedEnabledFlow, seedEnabledFlowRun, type SeededFlowRun } from './helpers/flowSeed';
import { expectSqlState, interactiveOrgAuth, orgContext, partnerContext, pgMessage, SYSTEM_CTX } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const SET_DOC = {
  version: 1, name: 'Greeter', trigger: { type: 'manual' }, inputs: [],
  steps: [{ id: 'greet', tool: 'set', input: { values: { greeting: 'hello' } } }],
};

interface Tenant {
  partnerId: string;
  orgA: string;
  orgB: string;
  delegatorId: string;
}

async function tenant(): Promise<Tenant> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `delegator-${randomUUID()}@flowruns.test` });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, delegatorId: delegator.id };
}

function seedRun(t: Tenant, opts: { orgId?: string; owner?: 'org' | 'partner' } = {}): Promise<SeededFlowRun> {
  return seedEnabledFlowRun({
    orgId: opts.orgId ?? t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId,
    owner: opts.owner, stepId: PIN.stepId, tool: PIN.tool, pin: PIN,
  });
}

/** A second run of an already-seeded flow, in `orgId` (a partner-wide flow runs in every org of its partner). */
function runValues(s: Pick<SeededFlowRun, 'flowId' | 'publicationId'>, orgId: string) {
  return {
    orgId,
    flowId: s.flowId,
    flowVersionId: s.publicationId,
    definitionVersion: 1,
    triggerKind: 'schedule' as const,
    triggeredVia: 'scheduler' as const,
    triggerPayload: {},
    inputs: {},
    status: 'queued' as const,
    preApprovalsHonored: false,
    dedupeKey: `schedule:${randomUUID()}`,
  };
}

async function insertRun(s: Pick<SeededFlowRun, 'flowId' | 'publicationId'>, orgId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() => db.insert(flowRuns).values(runValues(s, orgId)).returning({ id: flowRuns.id }));
  return row!.id;
}

/** A flow-origin action_intents row with every NOT NULL column filled; `over` replaces any of it. */
function flowIntentValues(orgId: string, partnerId: string, runId: string | null, over: Partial<NewActionIntent> = {}): NewActionIntent {
  return {
    orgId,
    partnerId,
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: null,
    requestingFlowRunId: runId,
    source: 'flow',
    originPrincipalKind: 'flow',
    originPrincipalId: null,
    actionName: 'list_devices',
    actionVersion: 1,
    arguments: {},
    argumentDigest: 'b'.repeat(64),
    targetSummary: 'Flow step',
    impactSummary: 'Flow step impact',
    reason: 'Flow run',
    riskTier: 3,
    idempotencyKey: `flow-${randomUUID()}`,
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...over,
  };
}

async function insertIntent(values: NewActionIntent): Promise<string> {
  const [row] = await withSystemDbAccessContext(() => db.insert(actionIntents).values(values).returning({ id: actionIntents.id }));
  return row!.id;
}

const visibleRunIds = (ctx: Parameters<typeof withDbAccessContext>[0], ids: string[]) =>
  withDbAccessContext(ctx, async () =>
    (await db.select({ id: flowRuns.id }).from(flowRuns).where(inArray(flowRuns.id, ids))).map((r) => r.id).sort());

// ───────────────────────────────────────────────────────────────────────────
// RLS + constraints on flow_runs / flow_run_steps / flow_versions
// ───────────────────────────────────────────────────────────────────────────

describe('flow_runs / flow_run_steps RLS + constraints (real Postgres)', () => {
  runDb("org B inserting a flow_runs row with org A's org_id is rejected (42501); its own org_id is admitted", async () => {
    const t = await tenant();
    const s = await seedRun(t, { owner: 'partner' });
    await expectSqlState(
      () => withDbAccessContext(orgContext(t.orgB, t.partnerId), () => db.insert(flowRuns).values(runValues(s, t.orgA))),
      '42501',
    );
    // Control: the identical row in its OWN org is admitted, so the refusal above is the org axis.
    const [own] = await withDbAccessContext(orgContext(t.orgB, t.partnerId), () =>
      db.insert(flowRuns).values(runValues(s, t.orgB)).returning({ id: flowRuns.id }));
    expect(own?.id).toBeDefined();
  });

  runDb("a flow_run_steps row whose org_id differs from its run's violates the composite FK (23503)", async () => {
    const t = await tenant();
    const s = await seedRun(t);
    const raised = await expectSqlState(() => withSystemDbAccessContext(() => db.insert(flowRunSteps).values({
      runId: s.runId, orgId: t.orgB, stepId: 'other', tool: PIN.tool, toolSource: 'core', tier: 1, status: 'running',
    })), '23503');
    expect(pgErrorConstraint(raised)).toBe('flow_run_steps_run_fk');
  });

  runDb('an org token sees its own runs (a partner-wide flow\'s included) and none of a sibling org', async () => {
    const t = await tenant();
    const pw = await seedRun(t, { owner: 'partner' }); // partner-wide flow, run in org A
    const own = await seedRun(t); // org A's own flow
    const sibling = await insertRun(pw, t.orgB); // the partner-wide flow's run in org B
    const all = [pw.runId, own.runId, sibling];

    expect(await visibleRunIds(orgContext(t.orgA, t.partnerId), all)).toEqual([pw.runId, own.runId].sort());
    expect(await visibleRunIds(orgContext(t.orgB, t.partnerId), all)).toEqual([sibling]);

    const steps = await withDbAccessContext(orgContext(t.orgB, t.partnerId), () =>
      db.select({ id: flowRunSteps.id }).from(flowRunSteps).where(inArray(flowRunSteps.runId, [pw.runId, own.runId])));
    expect(steps).toHaveLength(0);
    // An org token's write never reaches a sibling org's run.
    const updated = await withDbAccessContext(orgContext(t.orgB, t.partnerId), () =>
      db.update(flowRuns).set({ cancelRequestedAt: new Date() }).where(eq(flowRuns.id, pw.runId)).returning({ id: flowRuns.id }));
    expect(updated).toHaveLength(0);
  });

  runDb('a partner token with selected org access sees only those orgs\' runs', async () => {
    const t = await tenant();
    const pw = await seedRun(t, { owner: 'partner' });
    const inB = await insertRun(pw, t.orgB);
    const other = await tenant();
    const foreign = await seedRun(other);
    const all = [pw.runId, inB, foreign.runId];

    expect(await visibleRunIds(partnerContext(t.partnerId, [t.orgA]), all)).toEqual([pw.runId]);
    expect(await visibleRunIds(partnerContext(t.partnerId, [t.orgA, t.orgB]), all)).toEqual([pw.runId, inB].sort());
  });

  runDb('UPDATE flow_runs SET org_id raises (flow_runs_immutable_trg), even in system scope', async () => {
    const t = await tenant();
    const s = await seedRun(t, { owner: 'partner' });
    const raised = await withSystemDbAccessContext(() =>
      db.update(flowRuns).set({ orgId: t.orgB }).where(eq(flowRuns.id, s.runId))).then(() => null, (err: unknown) => err);
    expect(pgMessage(raised)).toMatch(/flow_runs: immutable column changed/);
    expect((await readFlowRunState(s)).run.orgId).toBe(t.orgA);
  });

  runDb('flowDbAccessContext(org A) sees no org-B device or flow_runs row, and its own of both', async () => {
    const t = await tenant();
    const pw = await seedRun(t, { owner: 'partner' });
    const inB = await insertRun(pw, t.orgB);
    const siteA = await createSite({ orgId: t.orgA });
    const siteB = await createSite({ orgId: t.orgB });
    const deviceA = await createDevice({ orgId: t.orgA, siteId: siteA!.id });
    const deviceB = await createDevice({ orgId: t.orgB, siteId: siteB!.id });

    const seen = await withDbAccessContext(flowDbAccessContext(t.orgA, t.partnerId), async () => ({
      devices: (await db.select({ id: devices.id }).from(devices).where(inArray(devices.id, [deviceA.id, deviceB.id]))).map((r) => r.id),
      runs: (await db.select({ id: flowRuns.id }).from(flowRuns).where(inArray(flowRuns.id, [pw.runId, inB]))).map((r) => r.id),
    }));
    expect(seen).toEqual({ devices: [deviceA.id], runs: [pw.runId] });
  });
});

describe('flow_versions RLS + constraints (real Postgres)', () => {
  runDb('both owners or neither owner violate flow_versions_one_owner_chk (23514)', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: SET_DOC, pins: [PIN] });
    const base = { flowId, publicationSeq: 2, definitionVersion: 1, definition: SET_DOC, effectiveTier: 1 as const, stepPins: [] };
    for (const owner of [{ orgId: t.orgA, partnerId: t.partnerId }, { orgId: null, partnerId: null }]) {
      const raised = await expectSqlState(() => withSystemDbAccessContext(() => db.insert(flowVersions).values({ ...base, ...owner })), '23514');
      expect(pgErrorConstraint(raised)).toBe('flow_versions_one_owner_chk');
    }
  });

  runDb('an owner differing from the parent flow passes the INSERT and fails at COMMIT (deferred owner guard)', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: SET_DOC, pins: [PIN] });
    let insertReturned = false;
    const raised = await expectSqlState(() => withSystemDbAccessContext(async () => {
      await db.insert(flowVersions).values({
        flowId, orgId: t.orgB, partnerId: null, publicationSeq: 2, definitionVersion: 1, definition: SET_DOC, effectiveTier: 1, stepPins: [],
      });
      insertReturned = true;
    }), '23514');
    expect(insertReturned).toBe(true);
    expect(pgErrorConstraint(raised)).toBe('flow_versions_parent_owner_chk');
    const rows = await withSystemDbAccessContext(() => db.select().from(flowVersions).where(eq(flowVersions.flowId, flowId)));
    expect(rows.map((r) => r.publicationSeq)).toEqual([1]);
  });

  runDb('UPDATE of a publication\'s definition raises (flow_versions_immutable_trg)', async () => {
    const t = await tenant();
    const { publicationId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: SET_DOC, pins: [PIN] });
    const raised = await withSystemDbAccessContext(() =>
      db.update(flowVersions).set({ definition: { ...SET_DOC, name: 'Tampered' } }).where(eq(flowVersions.id, publicationId)))
      .then(() => null, (err: unknown) => err);
    expect(pgMessage(raised)).toMatch(/flow_versions: immutable column changed/);
  });

  runDb("an org token reads its partner's partner-wide publication but its UPDATE and DELETE touch 0 rows", async () => {
    const t = await tenant();
    const { publicationId } = await seedEnabledFlow({ owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: SET_DOC, pins: [PIN] });
    const ctx = orgContext(t.orgA, t.partnerId);
    const read = await withDbAccessContext(ctx, () => db.select({ id: flowVersions.id }).from(flowVersions).where(eq(flowVersions.id, publicationId)));
    expect(read).toHaveLength(1);
    // enabled_by_user_id -> NULL is the one write the immutable trigger lets
    // through, so a 0-row result here is RLS, not the trigger.
    const updated = await withDbAccessContext(ctx, () =>
      db.update(flowVersions).set({ enabledByUserId: null }).where(eq(flowVersions.id, publicationId)).returning({ id: flowVersions.id }));
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(ctx, () =>
      db.delete(flowVersions).where(eq(flowVersions.id, publicationId)).returning({ id: flowVersions.id }));
    expect(deleted).toHaveLength(0);
    const [row] = await withSystemDbAccessContext(() => db.select().from(flowVersions).where(eq(flowVersions.id, publicationId)));
    expect(row!.enabledByUserId).toBe(t.delegatorId);
  });

  runDb("an org token of another partner cannot SELECT a partner-wide publication", async () => {
    const t = await tenant();
    const other = await tenant();
    const { publicationId } = await seedEnabledFlow({ owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: SET_DOC, pins: [PIN] });
    const read = await withDbAccessContext(orgContext(other.orgA, other.partnerId), () =>
      db.select({ id: flowVersions.id }).from(flowVersions).where(eq(flowVersions.id, publicationId)));
    expect(read).toHaveLength(0);
  });

  runDb("org and partner tokens inserting a publication under another partner's partner_id are rejected (42501)", async () => {
    const t = await tenant();
    const other = await tenant();
    const { flowId } = await seedEnabledFlow({ owner: 'partner', partnerId: other.partnerId, delegatorUserId: other.delegatorId, definition: SET_DOC, pins: [PIN] });
    const forged = { flowId, orgId: null, partnerId: other.partnerId, publicationSeq: 2, definitionVersion: 1, definition: SET_DOC, effectiveTier: 1 as const, stepPins: [] };
    await expectSqlState(() => withDbAccessContext(orgContext(t.orgA, t.partnerId), () => db.insert(flowVersions).values(forged)), '42501');
    await expectSqlState(() => withDbAccessContext(partnerContext(t.partnerId, [t.orgA]), () => db.insert(flowVersions).values(forged)), '42501');
  });

  runDb('deleting the delegator user nulls flow_versions.enabled_by_user_id without the immutable trigger raising', async () => {
    const t = await tenant();
    const gone = await createUser({ partnerId: t.partnerId, email: `gone-${randomUUID()}@flowruns.test` });
    const { publicationId, flowId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: gone.id, definition: SET_DOC, pins: [PIN] });
    await getTestDb().execute(sql`DELETE FROM users WHERE id = ${gone.id}::uuid`);
    const [pub] = await withSystemDbAccessContext(() => db.select().from(flowVersions).where(eq(flowVersions.id, publicationId)));
    expect(pub!.enabledByUserId).toBeNull();
    expect(pub!.definition).toEqual(SET_DOC);
    const [flow] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, flowId)));
    expect(flow!.enabledByUserId).toBeNull();
  });
});

describe('flow-origin action_intents constraints (real Postgres)', () => {
  runDb("source 'flow' with no requesting_flow_run_id violates action_intents_flow_origin_chk (23514)", async () => {
    const t = await tenant();
    // One actor root (a user) so only the flow pairing can fail.
    const raised = await expectSqlState(
      () => insertIntent(flowIntentValues(t.orgA, t.partnerId, null, { requestedByUserId: t.delegatorId })),
      '23514',
    );
    expect(pgErrorConstraint(raised)).toBe('action_intents_flow_origin_chk');
  });

  runDb('a flow intent with a second actor root violates action_intents_one_actor_chk (23514)', async () => {
    const t = await tenant();
    const s = await seedRun(t);
    const raised = await expectSqlState(
      () => insertIntent(flowIntentValues(t.orgA, t.partnerId, s.runId, { requestedByUserId: t.delegatorId })),
      '23514',
    );
    expect(pgErrorConstraint(raised)).toBe('action_intents_one_actor_chk');
  });

  runDb("a flow intent filed under a different org than its run violates the composite FK (23503)", async () => {
    const t = await tenant();
    const s = await seedRun(t);
    const raised = await expectSqlState(() => insertIntent(flowIntentValues(t.orgB, t.partnerId, s.runId)), '23503');
    expect(pgErrorConstraint(raised)).toBe('action_intents_requesting_flow_run_fk');
  });

  runDb('requesting_flow_run_id is immutable content (UPDATE raises)', async () => {
    const t = await tenant();
    const s = await seedRun(t);
    const second = await insertRun(s, t.orgA);
    const intentId = await insertIntent(flowIntentValues(t.orgA, t.partnerId, s.runId));
    const raised = await withSystemDbAccessContext(() =>
      db.update(actionIntents).set({ requestingFlowRunId: second }).where(eq(actionIntents.id, intentId)))
      .then(() => null, (err: unknown) => err);
    expect(pgMessage(raised)).toMatch(/action_intents content is immutable/);
    const [row] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(row!.requestingFlowRunId).toBe(s.runId);
  });

  runDb('deleting a run an intent references is refused (23503, ON DELETE RESTRICT)', async () => {
    const t = await tenant();
    const s = await seedRun(t);
    await insertIntent(flowIntentValues(t.orgA, t.partnerId, s.runId));
    const raised = await expectSqlState(() => withSystemDbAccessContext(() => db.delete(flowRuns).where(eq(flowRuns.id, s.runId))), '23503');
    expect(pgErrorConstraint(raised)).toBe('action_intents_requesting_flow_run_fk');
    expect((await readFlowRunState(s)).run.id).toBe(s.runId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The dispatch claim on real rows: re-enable, concurrency, org merge
// ───────────────────────────────────────────────────────────────────────────

const FOUR_EYES_TOOL = 'google_suspend_user';
const FOUR_EYES_PIN = { stepId: 'offboard', tool: FOUR_EYES_TOOL, source: 'core', tier: 3, approvalScope: 'four_eyes' } as const;
const FOUR_EYES_INPUT = { userEmail: 'target@customer.example', reason: 'offboarding' };

/**
 * A run parked on a real, flow-minted four-eyes intent (createActionIntent
 * under the flow principal), then approved at the DB level — the decide route
 * itself is intentSupervisedFourEyes' subject. admin1 is the delegator,
 * admin2 the only eligible approver.
 */
async function seedApprovedFlowIntent() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const adminRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(adminRole.id, [{ resource: 'approvals', action: 'decide' }, { resource: 'organizations', action: 'write' }]);
  const admin1 = await createUser({ partnerId: partner.id, orgId: org.id, email: `admin1-${randomUUID()}@flowruns.test` });
  const admin2 = await createUser({ partnerId: partner.id, orgId: org.id, email: `admin2-${randomUUID()}@flowruns.test` });
  await assignUserToOrganization(admin1.id, org.id, adminRole.id);
  await assignUserToOrganization(admin2.id, org.id, adminRole.id);

  const seed = await seedEnabledFlowRun({
    orgId: org.id, partnerId: partner.id, delegatorUserId: admin1.id,
    stepId: FOUR_EYES_PIN.stepId, tool: FOUR_EYES_TOOL, stepInput: FOUR_EYES_INPUT, pin: FOUR_EYES_PIN,
  });
  const flowAuth = buildFlowAuthContext(
    { id: seed.flowId, orgId: org.id, partnerId: null, status: 'enabled', name: seed.flowName },
    { id: seed.runId, orgId: org.id, flowId: seed.flowId },
    { id: org.id, partnerId: partner.id },
  );
  const snapshot = await createActionIntent(flowAuth, {
    toolName: FOUR_EYES_TOOL, input: FOUR_EYES_INPUT, source: 'flow',
    flowRun: {
      runId: seed.runId, stepRowId: seed.stepRowId, delegatorUserId: admin1.id, triggeredByUserId: null,
      flowName: seed.flowName, stepId: seed.stepId,
    },
  });
  expect(snapshot.status).toBe('pending_approval');
  await parkFlowRunOnIntent(seed, snapshot.id);
  await approveAtDb(snapshot.id);
  return { partnerId: partner.id, orgId: org.id, admin1, seed, intentId: snapshot.id };
}

async function approveAtDb(intentId: string): Promise<void> {
  await withSystemDbAccessContext(() => db.update(actionIntents)
    .set({ status: 'approved', releaseBy: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(actionIntents.id, intentId)));
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
  return row!;
}

describe('claimFlowLinkedIntentForDispatch on real rows', () => {
  runDb('after the flow is re-enabled (new publication) the claim refuses publication_moved: intent cancelled, run failed drift', async () => {
    const c = await seedApprovedFlowIntent();
    // The flow is edited and re-enabled while the step waits: a paused flow
    // keeps its intents (unlike disable), so only the publication moved.
    await withSystemDbAccessContext(() => db.update(flows).set({ definition: SET_DOC, definitionVersion: 2 }).where(eq(flows.id, c.seed.flowId)));
    await pauseFlow(c.seed.flowId, 'drift');
    const enabled = await withDbAccessContext(orgContext(c.orgId, c.partnerId, c.admin1.id), () =>
      enableFlow(interactiveOrgAuth(c.orgId, c.partnerId, c.admin1), c.seed.flowId, { expectedVersion: 2, preApprovedStepIds: [] }));
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.publication.publicationSeq).toBe(2);

    await expect(claimFlowLinkedIntentForDispatch(c.intentId)).resolves.toEqual({ claimed: false, reason: 'publication_moved' });
    const intent = await readIntent(c.intentId);
    expect(intent).toMatchObject({ status: 'cancelled', errorCode: 'flow_drift' });
    const { run, step, flow } = await readFlowRunState(c.seed);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'drift', wakeAt: null });
    expect(run.finishedAt).not.toBeNull();
    expect(step).toMatchObject({ status: 'failed', errorCode: 'drift' });
    expect(flow).toMatchObject({ status: 'enabled', enabledPublicationSeq: 2 });
  });

  runDb('two concurrent claims of one approved intent: exactly one claims, the other is lost_race; the run is untouched', async () => {
    const c = await seedApprovedFlowIntent();
    const results = await Promise.all([claimFlowLinkedIntentForDispatch(c.intentId), claimFlowLinkedIntentForDispatch(c.intentId)]);
    const won = results.filter((r) => r.claimed);
    expect(won).toEqual([{ claimed: true, runId: c.seed.runId, chainDepth: 0 }]);
    expect(results.filter((r) => !r.claimed)).toEqual([{ claimed: false, reason: 'lost_race' }]);
    expect((await readIntent(c.intentId)).status).toBe('executing');
    const { run, step } = await readFlowRunState(c.seed);
    expect(run).toMatchObject({ status: 'awaiting_approval', leaseToken: null });
    expect(step.status).toBe('awaiting_approval');
  });
});

describe('org merge of an org with flows, parked runs and intents (real Postgres, committed)', () => {
  // Committed rather than rolled back (the W03 merge case rolls back): the
  // deferred flow_versions owner guard only fires at COMMIT, and the later
  // dispatch claim runs on its own connection, which can only see a
  // committed merge. The per-test TRUNCATE cleans up.
  runDb('pauses the moved flow org_merged, repoints its publication, cancels the loser\'s parked runs in place; a later claim refuses', async () => {
    const partner = await createPartner();
    const L = (await createOrganization({ partnerId: partner.id })).id;
    const S = (await createOrganization({ partnerId: partner.id })).id;
    const delegator = await createUser({ partnerId: partner.id, orgId: L, email: `delegator-${randomUUID()}@flowmerge.test` });
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO tool_sources (org_id, slug, name, kind, endpoint_url, credential_origin)
      VALUES (${L}::uuid, 'hudu', 'L Hudu', 'mcp', 'https://l.example.test/mcp', 'https://l.example.test'),
             (${S}::uuid, 'hudu', 'S Hudu', 'mcp', 'https://s.example.test/mcp', 'https://s.example.test')`));

    // An enabled loser flow whose one step is the colliding tenant tool, parked on an approved intent.
    const tenantPin = { stepId: 'fetch', tool: 'hudu__get_asset', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: randomUUID(), tenantRevision: 'r1' } as const;
    const parked = await seedEnabledFlowRun({
      orgId: L, partnerId: partner.id, delegatorUserId: delegator.id, stepId: 'fetch', tool: 'hudu__get_asset', pin: tenantPin,
    });
    const intentId = await insertIntent(flowIntentValues(L, partner.id, parked.runId, {
      actionName: 'hudu__get_asset', approvalScope: 'supervised', status: 'approved', releaseBy: new Date(Date.now() + 60 * 60 * 1000),
    }));
    await parkFlowRunOnIntent(parked, intentId);
    // A queued run of a partner-wide flow in the loser, and one in the survivor.
    const pw = await seedEnabledFlow({ owner: 'partner', partnerId: partner.id, delegatorUserId: delegator.id, definition: SET_DOC, pins: [PIN] });
    const pwInLoser = await insertRun(pw, L);
    const pwInSurvivor = await insertRun(pw, S);

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await CUSTOM_RESOLVE_EXECUTORS.flows!(L, S);
      await CUSTOM_EXECUTORS.tool_sources!(L, S);
      await CUSTOM_EXECUTORS.flows!(L, S);
      await db.execute(buildRepoint('flow_versions', L, S));
    });

    const { run, step, flow } = await readFlowRunState(parked);
    expect(flow).toMatchObject({ orgId: S, status: 'paused', pausedReason: 'org_merged', enabledPublicationSeq: 1, definitionVersion: 2 });
    const rewrittenTool = (flow.definition as { steps: Array<{ tool: string }> }).steps[0]!.tool;
    expect(rewrittenTool).not.toBe('hudu__get_asset');
    expect(rewrittenTool).toMatch(/__get_asset$/);
    const [publication] = await withSystemDbAccessContext(() => db.select().from(flowVersions).where(eq(flowVersions.id, parked.publicationId)));
    expect(publication).toMatchObject({ orgId: S, partnerId: null });
    // The publication is immutable content: it still names the old tool.
    expect((publication!.definition as { steps: Array<{ tool: string }> }).steps[0]!.tool).toBe('hudu__get_asset');

    expect(run).toMatchObject({ orgId: L, status: 'cancelled', errorCode: 'org_merged', wakeAt: null, leaseToken: null });
    expect(run.finishedAt).not.toBeNull();
    expect(step).toMatchObject({ orgId: L, status: 'cancelled' });
    const runsByOrg = await withSystemDbAccessContext(() => db.select({ id: flowRuns.id, orgId: flowRuns.orgId, status: flowRuns.status, errorCode: flowRuns.errorCode })
      .from(flowRuns).where(inArray(flowRuns.id, [pwInLoser, pwInSurvivor])));
    expect(runsByOrg.find((r) => r.id === pwInLoser)).toMatchObject({ orgId: L, status: 'cancelled', errorCode: 'org_merged' });
    expect(runsByOrg.find((r) => r.id === pwInSurvivor)).toMatchObject({ orgId: S, status: 'queued', errorCode: null });

    // The intent stays with the loser org, still approved; the release's claim refuses it.
    expect(await readIntent(intentId)).toMatchObject({ orgId: L, status: 'approved' });
    await expect(claimFlowLinkedIntentForDispatch(intentId)).resolves.toEqual({ claimed: false, reason: 'run_terminal' });
    expect(await readIntent(intentId)).toMatchObject({ orgId: L, status: 'cancelled', errorCode: 'flow_drift' });
    expect((await readFlowRunState(parked)).run).toMatchObject({ status: 'cancelled', errorCode: 'org_merged' });
  });
});

describe('enableFlow delegation ceiling against real permission rows', () => {
  runDb('a user whose org membership carries a site allowlist is refused delegation_scope_restricted; an unrestricted peer enables', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    await grantRolePermissions(role.id, [{ resource: 'automations', action: 'write' }]);
    const limited = await createUser({ partnerId: partner.id, orgId: org.id, email: `limited-${randomUUID()}@flowruns.test` });
    const peer = await createUser({ partnerId: partner.id, orgId: org.id, email: `peer-${randomUUID()}@flowruns.test` });
    await assignUserToOrganization(limited.id, org.id, role.id);
    await assignUserToOrganization(peer.id, org.id, role.id);
    await getTestDb().update(organizationUsers).set({ siteIds: [site!.id] })
      .where(and(eq(organizationUsers.userId, limited.id), eq(organizationUsers.orgId, org.id)));

    const [draft] = await withSystemDbAccessContext(() => db.insert(flows).values({
      orgId: org.id, slug: `greeter_${randomUUID().slice(0, 8)}`, name: 'Greeter', definition: SET_DOC, effectiveTier: 1,
    }).returning({ id: flows.id }));

    // The token carries no site ceiling: only the live organization_users row can refuse.
    const refused = await withDbAccessContext(orgContext(org.id, partner.id, limited.id), () =>
      enableFlow(interactiveOrgAuth(org.id, partner.id, limited), draft!.id, { expectedVersion: 1, preApprovedStepIds: [] }));
    expect(refused).toEqual({ ok: false, error: 'delegation_scope_restricted' });
    const [still] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, draft!.id)));
    expect(still!.status).toBe('draft');
    expect(await withSystemDbAccessContext(() => db.select().from(flowVersions).where(eq(flowVersions.flowId, draft!.id)))).toHaveLength(0);

    const ok = await withDbAccessContext(orgContext(org.id, partner.id, peer.id), () =>
      enableFlow(interactiveOrgAuth(org.id, partner.id, peer), draft!.id, { expectedVersion: 1, preApprovedStepIds: [] }));
    expect(ok.ok).toBe(true);
  });
});
