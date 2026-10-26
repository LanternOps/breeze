/**
 * Tool Catalog W04 (#5219), plan Task A12 — the flow runner end to end on REAL
 * Postgres: the real enableFlow → startManualRun → processFlowRunJob slices →
 * stepExecutor → executeTool / createActionIntent → approval route →
 * releaseApprovedIntent chain, the real event-dispatch queue, and the
 * reconciler / retention SQL. These are the review-round cases the unit mocks
 * cannot prove (plan Task A12 "Real-DB cases").
 *
 * Mocked, and only these: the BullMQ producer of the flow-runs queue (each
 * slice is driven by calling `processFlowRunJob` with a fake job), the agent
 * socket send (`sendCommandToAgent` ⇒ delivered) and the device result wait
 * (`waitForCommandResult` ⇒ a completed result). Everything that writes a
 * row — the device_commands / script_executions dispatch included — is real.
 *
 * The whole file runs with DB_CONTEXTLESS_WRITE_STRICT=true, so any
 * contextless write on these paths throws instead of warning.
 */
import './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';

const h = vi.hoisted(() => ({
  enqueueFlowRunSlice: vi.fn(async (_runId: string, _opts?: { delayMs?: number }) => 'job'),
  sendCommandToAgent: vi.fn(() => true),
}));

vi.mock('../../jobs/flowRunQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/flowRunQueue')>();
  return { ...actual, enqueueFlowRunSlice: h.enqueueFlowRunSlice };
});
vi.mock('../../routes/agentWs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agentWs')>();
  return { ...actual, sendCommandToAgent: h.sendCommandToAgent };
});
vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return {
    ...actual,
    waitForCommandResult: vi.fn(async (commandId: string) => ({
      id: commandId,
      status: 'completed',
      result: { status: 'completed', exitCode: 0, stdout: 'flow-it-ok', stderr: '' },
    })),
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  deviceCommands,
  eventDeliveryReceipts,
  flowRuns,
  flowRunSteps,
  flows,
  scriptExecutions,
} from '../../db/schema';
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { processFlowRunJob } from '../../jobs/flowRunner';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { reconcileFlowRuns } from '../../jobs/flowRunReconciler';
import { pruneFlowRunBodies } from '../../jobs/flowRunRetention';
import { eventDispatchProcessor } from '../../jobs/eventDispatchWorker';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { approvalRoutes } from '../../routes/approvals';
import { flowRunRetentionDays } from '../../config/env';
import { publishEvent } from '../../services/eventBus';
import { getEventDispatchQueue, shutdownEventDispatchQueue } from '../../services/eventDispatchQueue';
import { _resetEventSubscriberRegistryForTests, registerEventSubscriber } from '../../services/eventSubscriberRegistry';
import { flowDbAccessContext } from '../../services/flows/flowAuthContext';
import { withFlowExecutionContext } from '../../services/flows/flowExecutionContext';
import { flowEventTriggerSubscriber } from '../../services/flows/eventTrigger';
import { cancelFlowRun, startManualRun } from '../../services/flows/runService';
import { disableFlow, enableFlow } from '../../services/flows/versions';
import { createAccessToken } from '../../services/jwt';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { seedEnabledFlow, seedEnabledFlowRun } from './helpers/flowSeed';
import { interactiveOrgAuth, orgContext, pgMessage } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED', 'DB_CONTEXTLESS_WRITE_STRICT', 'EVENT_DISPATCH_MODE', 'EVENT_DISPATCH_QUEUE_SUBSCRIBERS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
  process.env.DB_CONTEXTLESS_WRITE_STRICT = 'true';
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await shutdownEventDispatchQueue();
});
beforeEach(() => {
  h.enqueueFlowRunSlice.mockClear();
  h.sendCommandToAgent.mockClear();
});

// ── fixture ─────────────────────────────────────────────────────────────────

interface Fixture {
  partnerId: string;
  orgId: string;
  deviceId: string;
  scriptId: string;
  admin: { id: string; email: string };
  roleId: string;
}

/**
 * One org with an ONLINE device, an org script, and an admin who holds every
 * permission the steps below need (rule 7 at enable and at run start) plus
 * approvals:decide — a supervised flow intent's pool may include the delegator.
 */
async function fixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site!.id });
  await getTestDb().execute(sql`UPDATE devices SET status = 'online' WHERE id = ${device.id}::uuid`);
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [
    { resource: 'scripts', action: 'read' },
    { resource: 'scripts', action: 'execute' },
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'execute' },
    { resource: 'approvals', action: 'decide' },
    { resource: 'automations', action: 'read' },
    { resource: 'automations', action: 'write' },
  ]);
  const admin = await createUser({ partnerId: partner.id, orgId: org.id, email: `flow-admin-${randomUUID()}@flowe2e.test` });
  await assignUserToOrganization(admin.id, org.id, role.id);
  const rows = (await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO scripts (org_id, partner_id, name, os_types, language, content)
    VALUES (${org.id}, ${partner.id}, ${`flow-it-${randomUUID().slice(0, 8)}`}, ARRAY['windows'], 'powershell', 'Write-Output "flow"')
    RETURNING id`))) as unknown as Array<{ id: string }>;
  return { partnerId: partner.id, orgId: org.id, deviceId: device.id, scriptId: rows[0]!.id, admin: { id: admin.id, email: admin.email }, roleId: role.id };
}

const authFor = (f: Fixture) => interactiveOrgAuth(f.orgId, f.partnerId, f.admin, f.roleId);
const inCaller = <T>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId, f.partnerId, f.admin.id), fn);

/** A draft flow of `doc`, enabled by the admin through the real enableFlow. */
async function enabledFlow(f: Fixture, doc: Record<string, unknown>, preApprovedStepIds: string[] = []): Promise<string> {
  const [draft] = await withSystemDbAccessContext(() => db.insert(flows).values({
    orgId: f.orgId, slug: `e2e_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name: String(doc.name), definition: doc, effectiveTier: 1,
  }).returning({ id: flows.id }));
  const enabled = await inCaller(f, () => enableFlow(authFor(f), draft!.id, { expectedVersion: 1, preApprovedStepIds }));
  if (!enabled.ok) throw new Error(`enableFlow refused: ${JSON.stringify(enabled)}`);
  return draft!.id;
}

async function startRun(f: Fixture, flowId: string): Promise<{ runId: string; preApprovalsHonored: boolean }> {
  const started = await inCaller(f, () => startManualRun(authFor(f), flowId, { inputs: {} }, 'ui'));
  if (!started.ok) throw new Error(`startManualRun refused: ${JSON.stringify(started)}`);
  return { runId: started.runId, preApprovalsHonored: started.preApprovalsHonored };
}

/** One slice, exactly as the flow-runs worker runs it (a fake job; the processor owns every DB context). */
function slice(runId: string): Promise<void> {
  return processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);
}

async function readRun(runId: string): Promise<FlowRunRow> {
  const [run] = await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.id, runId)));
  return run!;
}

async function readSteps(runId: string) {
  return withSystemDbAccessContext(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId)).orderBy(flowRunSteps.startedAt));
}

/** `wake_at` is set exactly while the run is `waiting` (flow_runs_waiting_chk, asserted from the outside too). */
function expectWakeInvariant(run: FlowRunRow): void {
  if (run.status === 'waiting') expect(run.wakeAt).not.toBeNull();
  else expect(run.wakeAt).toBeNull();
}

async function commandsFor(deviceId: string) {
  return getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId));
}

const RUN_SCRIPT_STEP = (f: Fixture) => ({ id: 'script', tool: 'run_script', input: { scriptId: f.scriptId, deviceIds: [f.deviceId] } });

// ── enable → start → slice ─────────────────────────────────────────────────

describe('flow runner end to end (real Postgres)', () => {
  runDb('enableFlow + startManualRun + one executed set step, read back in the system and the flow principal\'s contexts', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Greeter', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'greet', tool: 'set', input: { values: { greeting: 'hello {{flow.name}}' } } }],
    });
    const { runId, preApprovalsHonored } = await startRun(f, flowId);
    expect(preApprovalsHonored).toBe(true);
    expect(h.enqueueFlowRunSlice).toHaveBeenCalledWith(runId);
    const queued = await readRun(runId);
    expect(queued).toMatchObject({ status: 'queued', triggerKind: 'manual', triggeredVia: 'ui', triggeredByUserId: f.admin.id, orgId: f.orgId });
    expectWakeInvariant(queued);

    await slice(runId);

    const run = await readRun(runId);
    expect(run).toMatchObject({ status: 'completed', errorCode: null, leaseToken: null, leaseExpiresAt: null });
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeInstanceOf(Date);
    expectWakeInvariant(run);
    const steps = await readSteps(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepId: 'greet', status: 'completed', toolSource: 'builtin', tier: 1, approvalMode: 'none', output: { greeting: 'hello Greeter' } });

    // The flow principal's org-scoped, user-less context reads the same rows the system wrote.
    const asFlow = await withDbAccessContext(flowDbAccessContext(f.orgId, f.partnerId), async () => ({
      runs: await db.select({ id: flowRuns.id, status: flowRuns.status }).from(flowRuns).where(eq(flowRuns.id, runId)),
      steps: await db.select({ output: flowRunSteps.output }).from(flowRunSteps).where(eq(flowRunSteps.runId, runId)),
    }));
    expect(asFlow).toEqual({ runs: [{ id: runId, status: 'completed' }], steps: [{ output: { greeting: 'hello Greeter' } }] });
  });

  runDb('flow run executes a real run_script step under buildFlowAuthContext: device_commands ai_initiator_kind=flow, created_by NULL', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Pre-approved script', trigger: { type: 'manual' }, inputs: [], steps: [RUN_SCRIPT_STEP(f)],
    }, ['script']);
    const { runId, preApprovalsHonored } = await startRun(f, flowId);
    expect(preApprovalsHonored).toBe(true);

    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'completed', errorCode: null });
    const [step] = await readSteps(runId);
    expect(step).toMatchObject({ stepId: 'script', status: 'completed', tier: 3, approvalMode: 'pre_approved', actionIntentId: null });

    const commands = await commandsFor(f.deviceId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'script', aiInitiatorKind: 'flow', aiAgentRunId: null, aiSessionId: null, createdBy: null });
    expect(h.sendCommandToAgent).toHaveBeenCalledTimes(1);
    const executions = await getTestDb().select().from(scriptExecutions).where(eq(scriptExecutions.deviceId, f.deviceId));
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ scriptId: f.scriptId, orgId: f.orgId, aiInitiatorKind: 'flow', triggeredBy: null });
    // No intent: the pre-approval lane executes without parking.
    expect(await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.requestingFlowRunId, runId)))).toHaveLength(0);
  });

  runDb('real run lifecycle queued→running→waiting→running→awaiting_approval→running→completed', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Lifecycle', trigger: { type: 'manual' }, inputs: [],
      steps: [
        { id: 'greet', tool: 'set', input: { values: { greeting: 'hi' } } },
        { id: 'pause', tool: 'wait', input: { minutes: 1 } },
        RUN_SCRIPT_STEP(f),
      ],
    });
    const { runId } = await startRun(f, flowId);
    const seen: FlowRunRow[] = [await readRun(runId)];
    expect(seen[0]!.status).toBe('queued');

    // Slice 1: set, then the wait parks the run.
    await slice(runId);
    const waiting = await readRun(runId);
    seen.push(waiting);
    expect(waiting).toMatchObject({ status: 'waiting', currentStepId: 'script', resumeSeq: 1, leaseToken: null });
    expect(waiting.wakeAt!.getTime()).toBeGreaterThan(Date.now());
    expect(h.enqueueFlowRunSlice).toHaveBeenCalledWith(runId, expect.objectContaining({ delayMs: expect.any(Number) }));
    let steps = await readSteps(runId);
    expect(steps.map((s) => [s.stepId, s.status])).toEqual([['greet', 'completed'], ['pause', 'completed']]);

    // An early wake does nothing.
    await slice(runId);
    expect(await readRun(runId)).toMatchObject({ status: 'waiting', resumeSeq: 1 });
    expect(await readSteps(runId)).toHaveLength(2);

    // Slice 2: past wake_at, the run resumes and the Tier-3 step parks on an intent.
    await withSystemDbAccessContext(() => db.update(flowRuns).set({ wakeAt: sql`now() - interval '1 second'` }).where(eq(flowRuns.id, runId)));
    await slice(runId);
    const parked = await readRun(runId);
    seen.push(parked);
    expect(parked, JSON.stringify({ error: parked.error })).toMatchObject({ status: 'awaiting_approval', currentStepId: 'script', resumeSeq: 2, leaseToken: null });
    steps = await readSteps(runId);
    const scriptStep = steps.find((s) => s.stepId === 'script')!;
    expect(scriptStep).toMatchObject({ status: 'awaiting_approval', approvalMode: 'intent', tier: 3 });
    const intentId = scriptStep.actionIntentId!;
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent).toMatchObject({ source: 'flow', originPrincipalKind: 'flow', requestingFlowRunId: runId, status: 'pending_approval', approvalScope: 'supervised', aiOriginKind: 'flow' });
    expect(await commandsFor(f.deviceId)).toHaveLength(0);

    // A human approves through the real decide route; the release worker executes it under the flow principal.
    const [approval] = await withSystemDbAccessContext(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, f.admin.id))));
    expect(approval, 'the delegator is in the supervised flow intent\'s approver pool').toBeDefined();
    const decided = await approveViaRoute(f, approval!.id);
    expect(decided.status, await decided.clone().text()).toBe(200);
    await releaseApprovedIntent(intentId);
    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released!.status, JSON.stringify({ errorCode: released!.errorCode })).toBe('completed');
    const commands = await commandsFor(f.deviceId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ aiInitiatorKind: 'flow', createdBy: null });
    // The release only wrote the intent: the run is still parked until its wake.
    expect((await readRun(runId)).status).toBe('awaiting_approval');

    // Slice 3: the wake maps the intent's outcome onto the step and the run completes.
    await slice(runId);
    const done = await readRun(runId);
    seen.push(done);
    expect(done, JSON.stringify({ error: done.error })).toMatchObject({ status: 'completed', errorCode: null, leaseToken: null });
    expect(done.finishedAt).toBeInstanceOf(Date);
    steps = await readSteps(runId);
    expect(steps.map((s) => [s.stepId, s.status])).toEqual([['greet', 'completed'], ['pause', 'completed'], ['script', 'completed']]);
    expect(steps.find((s) => s.stepId === 'script')!.approvedByUserId).toBe(f.admin.id);
    for (const r of seen) expectWakeInvariant(r);

    // A terminal run's status is final.
    const raised = await withSystemDbAccessContext(() => db.update(flowRuns).set({ status: 'running', finishedAt: null }).where(eq(flowRuns.id, runId)))
      .then(() => null, (err: unknown) => err);
    expect(pgMessage(raised)).toMatch(/flow_runs: terminal status is final/);
  });
});

// ── a partner-wide flow never reaches a sibling org's device (spec §6.3 rule 6 at run time) ──

describe('partner-wide flow run: references are owned by the RUN org (real Postgres)', () => {
  /**
   * One partner, org A (an online device + a script) and sibling org B (an
   * online device); the delegator is a partner-scope, all-orgs user holding
   * every permission the steps need. The flow is partner-wide, so its run in
   * org A is the case where a templated id from the trigger can name org B.
   */
  async function partnerFixture() {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await createDevice({ orgId: orgA.id, siteId: siteA!.id });
    const deviceB = await createDevice({ orgId: orgB.id, siteId: siteB!.id });
    await getTestDb().execute(sql`UPDATE devices SET status = 'online' WHERE id IN (${deviceA.id}::uuid, ${deviceB.id}::uuid)`);
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [
      { resource: 'scripts', action: 'read' },
      { resource: 'scripts', action: 'execute' },
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'execute' },
      { resource: 'automations', action: 'read' },
      { resource: 'automations', action: 'write' },
    ]);
    const delegator = await createUser({ partnerId: partner.id, email: `pw-delegator-${randomUUID()}@flowe2e.test` });
    await assignUserToPartner(delegator.id, partner.id, role.id, 'all');
    // A partner-library script (org_id NULL): the only kind a partner-wide flow owns.
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO scripts (org_id, partner_id, name, os_types, language, content)
      VALUES (NULL, ${partner.id}, ${`flow-pw-${randomUUID().slice(0, 8)}`}, ARRAY['windows'], 'powershell', 'Write-Output "flow"')
      RETURNING id`))) as unknown as Array<{ id: string }>;
    return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, deviceA: deviceA.id, deviceB: deviceB.id, scriptId: rows[0]!.id, delegatorId: delegator.id };
  }

  type PartnerFixture = Awaited<ReturnType<typeof partnerFixture>>;

  /** A queued event run of the partner-wide flow in org A, carrying `payload` as the trigger payload. */
  async function queuedEventRun(pf: PartnerFixture, flow: { flowId: string; publicationId: string }, payload: Record<string, unknown>): Promise<string> {
    const [row] = await withSystemDbAccessContext(() => db.insert(flowRuns).values({
      orgId: pf.orgA, flowId: flow.flowId, flowVersionId: flow.publicationId, definitionVersion: 1,
      triggerKind: 'event', triggeredVia: 'event',
      triggerPayload: { kind: 'event', orgId: pf.orgA, firedAt: new Date().toISOString(), event: { id: randomUUID(), type: 'alert.triggered' }, payload },
      inputs: {}, status: 'queued', preApprovalsHonored: true, dedupeKey: `event:${randomUUID()}`,
    }).returning({ id: flowRuns.id }));
    return row!.id;
  }

  const eventDoc = (name: string, steps: unknown[]) => ({
    version: 1, name, trigger: { type: 'event', event: 'alert.triggered', filter: {} }, inputs: [], steps,
  });

  async function intentsOf(runId: string) {
    return withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.requestingFlowRunId, runId)));
  }

  runDb('get_device_details with {{trigger.payload.deviceId}} naming an org-B device fails reference_not_owned; nothing runs', async () => {
    const pf = await partnerFixture();
    const flow = await seedEnabledFlow({
      owner: 'partner', partnerId: pf.partnerId, delegatorUserId: pf.delegatorId,
      definition: eventDoc('Look up the alerting device', [
        { id: 'look', tool: 'get_device_details', input: { deviceId: '{{trigger.payload.deviceId}}' } },
      ]),
      pins: [{ stepId: 'look', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null }],
    });

    // Control: the same flow's run naming an org-A device completes.
    const okRun = await queuedEventRun(pf, flow, { deviceId: pf.deviceA });
    await slice(okRun);
    const ok = await readRun(okRun);
    expect(ok, JSON.stringify({ error: ok.error })).toMatchObject({ status: 'completed', errorCode: null });

    const runId = await queuedEventRun(pf, flow, { deviceId: pf.deviceB });
    await slice(runId);
    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'failed', errorCode: 'reference_not_owned', leaseToken: null });
    const steps = await readSteps(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepId: 'look', status: 'failed', errorCode: 'reference_not_owned', output: null });
    expect(await commandsFor(pf.deviceB)).toHaveLength(0);
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
    expect(await intentsOf(runId)).toHaveLength(0);
  });

  runDb('run_script whose deviceIds mix an org-A and an org-B device is refused as a whole: no intent, no command on either device', async () => {
    const pf = await partnerFixture();
    const flow = await seedEnabledFlow({
      owner: 'partner', partnerId: pf.partnerId, delegatorUserId: pf.delegatorId,
      definition: eventDoc('Fix both', [
        { id: 'script', tool: 'run_script', input: { scriptId: pf.scriptId, deviceIds: ['{{trigger.payload.a}}', '{{trigger.payload.b}}'] } },
      ]),
      pins: [{ stepId: 'script', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' }],
    });
    // Control: the same step naming org-A devices only is accepted — it parks
    // on a supervised intent — so the refusal below is the org-B device alone.
    const okRun = await queuedEventRun(pf, flow, { a: pf.deviceA, b: pf.deviceA });
    await slice(okRun);
    const parked = await readRun(okRun);
    expect(parked, JSON.stringify({ error: parked.error })).toMatchObject({ status: 'awaiting_approval', errorCode: null });
    expect(await intentsOf(okRun)).toHaveLength(1);

    const runId = await queuedEventRun(pf, flow, { a: pf.deviceA, b: pf.deviceB });
    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'failed', errorCode: 'reference_not_owned' });
    const [step] = await readSteps(runId);
    expect(step).toMatchObject({ stepId: 'script', status: 'failed', errorCode: 'reference_not_owned', approvalMode: 'none', actionIntentId: null });
    // Refused before an intent is minted: the owned org-A device is not run either.
    expect(await intentsOf(runId)).toHaveLength(0);
    expect(await commandsFor(pf.deviceA)).toHaveLength(0);
    expect(await commandsFor(pf.deviceB)).toHaveLength(0);
    expect(h.sendCommandToAgent).not.toHaveBeenCalled();
  });
});

// ── cancel / disable on real rows (the COALESCE(cancel_requested_at, $now) writes) ──

describe('cancelling a run and disabling a flow (real Postgres)', () => {
  runDb('disableFlow on a flow with a run parked on approval: the intent is cancelled and the next slice ends the run cancelled', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Disable me', trigger: { type: 'manual' }, inputs: [], steps: [RUN_SCRIPT_STEP(f)],
    });
    const { runId } = await startRun(f, flowId);
    await slice(runId);
    const parked = await readRun(runId);
    expect(parked.status).toBe('awaiting_approval');
    const [step] = await readSteps(runId);

    const disabled = await inCaller(f, () => disableFlow(authFor(f), flowId));
    expect(disabled).toEqual({ ok: true, cancelledRuns: 0 });
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, step!.actionIntentId!)));
    expect(intent!.status).toBe('cancelled');
    expect((await readRun(runId)).cancelRequestedAt).toBeInstanceOf(Date);

    await slice(runId);
    const ended = await readRun(runId);
    expect(ended).toMatchObject({ status: 'cancelled', wakeAt: null, leaseToken: null });
    expect(await commandsFor(f.deviceId)).toHaveLength(0);
  });

  runDb('cancelFlowRun of a queued run ends it cancelled in the caller\'s transaction', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Cancel me', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'greet', tool: 'set', input: { values: { greeting: 'hi' } } }],
    });
    const { runId } = await startRun(f, flowId);
    const result = await inCaller(f, () => cancelFlowRun(authFor(f), runId));
    expect(result).toEqual({ ok: true, status: 'cancelled' });
    const run = await readRun(runId);
    expect(run).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', wakeAt: null });
    expect(run.cancelRequestedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeInstanceOf(Date);
  });
});

async function approveViaRoute(f: Fixture, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: f.admin.id, email: f.admin.email, roleId: f.roleId, orgId: f.orgId, partnerId: f.partnerId,
    scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ── the real event-dispatch queue ───────────────────────────────────────────

describe('event trigger through the real event-dispatch queue (enforce mode)', () => {
  const jobIds: string[] = [];
  beforeEach(() => {
    process.env.EVENT_DISPATCH_MODE = 'enforce';
    process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS = 'flow-event-trigger';
    _resetEventSubscriberRegistryForTests();
    registerEventSubscriber(flowEventTriggerSubscriber);
  });
  afterEach(async () => {
    _resetEventSubscriberRegistryForTests();
    delete process.env.EVENT_DISPATCH_MODE;
    delete process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS;
    const q = getEventDispatchQueue();
    for (const id of jobIds.splice(0)) await (await q.getJob(id))?.remove().catch(() => undefined);
  });

  runDb('an event published inside a flow frame is delivered with flowRunId/flowChainDepth intact and starts the listener at depth + 1', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const delegator = await createUser({ partnerId: partner.id, orgId: org.id, email: `delegator-${randomUUID()}@flowe2e.test` });
    const step = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
    const pin = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
    const listener = await seedEnabledFlow({
      orgId: org.id, partnerId: partner.id, delegatorUserId: delegator.id, pins: [pin],
      definition: { version: 1, name: 'On resolve', trigger: { type: 'event', event: 'alert.resolved', filter: {} }, inputs: [], steps: [step] },
    });
    const causing = await seedEnabledFlowRun({ orgId: org.id, partnerId: partner.id, delegatorUserId: delegator.id, stepId: 'look', tool: 'list_devices', pin });

    const eventId = await withFlowExecutionContext({ runId: causing.runId, chainDepth: 1 }, () =>
      publishEvent('alert.resolved', org.id, { alertId: randomUUID() }, 'flow-it'));

    const q = getEventDispatchQueue();
    const routeJob = await q.getJob(`event-route-${eventId}`);
    expect(routeJob, 'publish enqueued a durable route job').toBeDefined();
    jobIds.push(routeJob!.id!);
    expect(routeJob!.data).toMatchObject({ mode: 'enforce', queueSubscriberIds: ['flow-event-trigger'] });
    expect(routeJob!.data.event.metadata).toMatchObject({ flowRunId: causing.runId, flowChainDepth: 1 });
    // Enforce mode: no in-process delivery happened — nothing ran yet.
    expect(await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, listener.flowId)))).toHaveLength(0);

    await eventDispatchProcessor(routeJob!);
    const deliverJob = await q.getJob(`event-deliver-flow-event-trigger-${eventId}`);
    expect(deliverJob).toBeDefined();
    jobIds.push(deliverJob!.id!);
    await eventDispatchProcessor(deliverJob!);

    const runs = await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, listener.flowId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ orgId: org.id, triggerKind: 'event', triggeredVia: 'event', chainDepth: 2, causedByRunId: causing.runId, dedupeKey: `event:${eventId}` });
    const [receipt] = await withSystemDbAccessContext(() => db.select().from(eventDeliveryReceipts)
      .where(and(eq(eventDeliveryReceipts.eventId, eventId), eq(eventDeliveryReceipts.subscriberId, 'flow-event-trigger'))));
    expect(receipt).toMatchObject({ status: 'delivered', mode: 'enforce' });
  });
});

// ── reconciler + retention SQL on Postgres ──────────────────────────────────

describe('flow run reconciler and retention against Postgres', () => {
  async function seedBase() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const delegator = await createUser({ partnerId: partner.id, orgId: org.id, email: `delegator-${randomUUID()}@flowe2e.test` });
    const pin = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
    const seeded = await seedEnabledFlowRun({ orgId: org.id, partnerId: partner.id, delegatorUserId: delegator.id, stepId: 'look', tool: 'list_devices', pin });
    const extraRun = async (patch: Record<string, unknown>): Promise<string> => {
      const [row] = await withSystemDbAccessContext(() => db.insert(flowRuns).values({
        orgId: org.id, flowId: seeded.flowId, flowVersionId: seeded.publicationId, definitionVersion: 1,
        triggerKind: 'schedule', triggeredVia: 'scheduler', triggerPayload: { kind: 'schedule' }, inputs: { a: 1 },
        status: 'queued', preApprovalsHonored: true, dedupeKey: `schedule:${randomUUID()}`,
      }).returning({ id: flowRuns.id }));
      if (Object.keys(patch).length > 0) {
        await getTestDb().execute(sql`UPDATE flow_runs SET ${sql.raw(Object.entries(patch).map(([k, v]) => `${k} = ${v}`).join(', '))} WHERE id = ${row!.id}::uuid`);
      }
      return row!.id;
    };
    return { partnerId: partner.id, orgId: org.id, delegatorId: delegator.id, seeded, extraRun };
  }

  runDb('retention prunes the bodies of a terminal run older than the window, and deletes nothing', async () => {
    const b = await seedBase();
    const days = flowRunRetentionDays();
    // The seeded run: finished days+1 ago, with a step that has a body.
    await withSystemDbAccessContext(async () => {
      await db.update(flowRunSteps).set({ status: 'completed', output: { big: 'x' }, finishedAt: new Date() }).where(eq(flowRunSteps.id, b.seeded.stepRowId));
      await db.update(flowRuns).set({ status: 'completed', finishedAt: sql`now() - make_interval(days => ${days + 1})` }).where(eq(flowRuns.id, b.seeded.runId));
    });
    const recent = await b.extraRun({ status: `'completed'`, finished_at: `now() - interval '1 day'` });
    const active = await b.extraRun({});
    const counts = async () => (await getTestDb().execute(sql`
      SELECT (SELECT count(*) FROM flow_runs)::int AS runs, (SELECT count(*) FROM flow_run_steps)::int AS steps`)) as unknown as Array<{ runs: number; steps: number }>;
    const before = (await counts())[0];

    const summary = await pruneFlowRunBodies();
    expect(summary).toMatchObject({ runs: 1, steps: 1, hasMore: false });
    expect((await counts())[0]).toEqual(before);

    const [old] = await getTestDb().select().from(flowRuns).where(eq(flowRuns.id, b.seeded.runId));
    expect(old).toMatchObject({ status: 'completed', triggerPayload: null, inputs: null });
    expect(old!.bodiesPrunedAt).toBeInstanceOf(Date);
    const [oldStep] = await getTestDb().select().from(flowRunSteps).where(eq(flowRunSteps.id, b.seeded.stepRowId));
    expect(oldStep).toMatchObject({ status: 'completed', renderedInput: null, output: null });
    for (const id of [recent, active]) {
      const [r] = await getTestDb().select().from(flowRuns).where(eq(flowRuns.id, id));
      expect(r).toMatchObject({ inputs: { a: 1 }, bodiesPrunedAt: null });
    }
    // Idempotent.
    expect(await pruneFlowRunBodies()).toMatchObject({ runs: 0, steps: 0 });
  });

  runDb('reconciler clauses (a)–(e) select exactly the stranded rows on the DB clock', async () => {
    const b = await seedBase();
    // The seeded run is `running` with no lease: clause (c) treats a missing pair as expired.
    const staleQueued = await b.extraRun({ updated_at: `now() - interval '3 minutes'` });
    const freshQueued = await b.extraRun({});
    const overdueWait = await b.extraRun({ status: `'waiting'`, wake_at: `now() - interval '3 minutes'` });
    const pendingWait = await b.extraRun({ status: `'waiting'`, wake_at: `now() - interval '30 seconds'` });
    const liveLease = await b.extraRun({ status: `'running'`, started_at: 'now()', lease_token: 'gen_random_uuid()', lease_expires_at: `now() + interval '5 minutes'` });
    // (b): parked on an intent that already went terminal (a lost wake), next to one still pending.
    const parkedOn = async (intentStatus: 'completed' | 'pending_approval'): Promise<string> => {
      const runId = await b.extraRun({ status: `'awaiting_approval'`, current_step_id: `'gate'`, started_at: 'now()' });
      const [intent] = await withSystemDbAccessContext(() => db.insert(actionIntents).values({
        orgId: b.orgId, partnerId: b.partnerId, requestingFlowRunId: runId, source: 'flow', originPrincipalKind: 'flow',
        actionName: 'run_script', arguments: {}, argumentDigest: 'c'.repeat(64), targetSummary: 't', impactSummary: 'i', reason: 'r',
        riskTier: 3, idempotencyKey: `flow-${randomUUID()}`, correlationId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
        status: intentStatus,
      }).returning({ id: actionIntents.id }));
      await withSystemDbAccessContext(() => db.insert(flowRunSteps).values({
        runId, orgId: b.orgId, stepId: 'gate', tool: 'run_script', toolSource: 'core', tier: 3,
        status: 'awaiting_approval', approvalMode: 'intent', actionIntentId: intent!.id,
      }));
      return runId;
    };
    const lostWake = await parkedOn('completed');
    const stillPending = await parkedOn('pending_approval');
    const eventFlow = await seedEnabledFlow({
      orgId: b.orgId, partnerId: b.partnerId, delegatorUserId: b.delegatorId,
      pins: [{ stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null }],
      definition: { version: 1, name: 'On alert', trigger: { type: 'event', event: 'alert.triggered', filter: {} }, inputs: [], steps: [{ id: 'look', tool: 'list_devices', input: {} }] },
    });

    const summary = await reconcileFlowRuns();
    expect(summary).toMatchObject({ queued: 1, awaitingApproval: 1, leaseExpired: 1, overdueWaits: 1, pausedEventFlows: 1, enqueueFailures: 0 });
    const enqueued = h.enqueueFlowRunSlice.mock.calls.map((c) => c[0]);
    expect(enqueued.sort()).toEqual([staleQueued, lostWake, b.seeded.runId, overdueWait].sort());
    for (const id of [freshQueued, pendingWait, liveLease, stillPending]) expect(enqueued).not.toContain(id);
    // (e): event dispatch is `off` here, so the event flow pauses.
    const [paused] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, eventFlow.flowId)));
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'event_dispatch_not_durable' });
  });
});
