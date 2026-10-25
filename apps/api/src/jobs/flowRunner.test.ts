import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';

/**
 * Tool catalog W04 (#5219), plan Task A8 — the flow runner state machine.
 *
 * The SQL boundary (services/flows/runStore.ts) is replaced by an in-memory
 * model that enforces the flow_runs / flow_run_steps CHECKs the runner must
 * respect (terminal ⇔ finished_at, waiting ⇔ wake_at, awaiting ⇒ cursor, the
 * lease fence, the attempt unique key) and rolls back on a throw like the
 * real transaction. runLease.ts and runAdmission.ts run FOR REAL on top of it,
 * so a slot/lease/resume interaction bug shows up here, not only in the
 * integration suite. The step executor, the delegator check, pauseFlow,
 * events and notifications are mocked.
 */
type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    run: null as Row | null,
    steps: [] as Row[],
    intents: new Map<string, Row>(),
    publication: null as Row | null,
    flow: null as Row | null,
    orgPartnerId: 'dddddddd-0000-4000-8000-000000000001' as string | null,
    otherRunning: false,
    ownerRunning: 0,
  };
  return {
    state,
    log: [] as string[],
    execute: vi.fn(),
    assertDelegatorAuthority: vi.fn(async () => true),
    pauseFlow: vi.fn(async () => {}),
    publishEvent: vi.fn(async () => 'evt'),
    createNotification: vi.fn(async () => 'n1'),
    enqueueFlowRunSlice: vi.fn(async () => 'job'),
    flowsEnabled: vi.fn(() => true),
    maxRunning: 20,
    uuidSeq: 0,
  };
});

const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'];
const STEP_TERMINAL = ['completed', 'failed', 'skipped', 'unknown_outcome', 'cancelled'];

function clone<T>(v: T): T {
  return structuredClone(v);
}
function newUuid(): string {
  h.uuidSeq += 1;
  return `99999999-0000-4000-8000-${String(h.uuidSeq).padStart(12, '0')}`;
}
function assertRunChecks(run: Row): void {
  if ((run.status === 'waiting') !== (run.wakeAt != null)) throw new Error(`flow_runs_waiting_chk (${run.status})`);
  if (TERMINAL.includes(run.status) !== (run.finishedAt != null)) throw new Error(`flow_runs_finished_chk (${run.status})`);
  if (run.status === 'awaiting_approval' && run.currentStepId == null) throw new Error('flow_runs_awaiting_chk');
  if ((run.leaseToken == null) !== (run.leaseExpiresAt == null)) throw new Error('flow_runs_lease_pair_chk');
}
function assertStepChecks(step: Row): void {
  if ((step.approvalMode === 'intent') !== (step.actionIntentId != null)) throw new Error('flow_run_steps_intent_pair_chk');
  if (step.status === 'awaiting_approval' && step.approvalMode !== 'intent') throw new Error('flow_run_steps_awaiting_chk');
  if (STEP_TERMINAL.includes(step.status) !== (step.finishedAt != null)) throw new Error(`flow_run_steps_finished_chk (${step.status})`);
}

vi.mock('../db', () => ({
  db: {},
  getCurrentDbAccessContext: () => undefined,
  withSystemDbAccessContext: async (fn: () => unknown) => {
    const snapshot = clone({ run: h.state.run, steps: h.state.steps });
    try {
      const out = await fn();
      h.log.push('tx:commit');
      return out;
    } catch (err) {
      h.state.run = snapshot.run;
      h.state.steps = snapshot.steps;
      h.log.push('tx:rollback');
      throw err;
    }
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: (_label: string, fn: () => unknown) => { void fn(); },
}));

vi.mock('../services/flows/runStore', () => {
  const now = () => Date.now();
  const lease = () => new Date(now() + 360_000);
  return {
    TERMINAL_FLOW_RUN_STATUSES: ['completed', 'failed', 'cancelled', 'expired'],
    ACTIVE_FLOW_RUN_STATUSES: ['queued', 'running', 'waiting', 'awaiting_approval'],
    flowOwnerKey: (o: { orgId: string | null; partnerId: string }) => (o.orgId ? `org:${o.orgId}` : `partner:${o.partnerId}`),
    loadSliceSnapshot: async () => {
      const run = h.state.run;
      if (!run) return null;
      return {
        run: structuredClone(run),
        publication: structuredClone(h.state.publication),
        flow: structuredClone(h.state.flow),
        orgPartnerId: h.state.orgPartnerId,
        wakePending: run.wakeAt != null && run.wakeAt.getTime() > now(),
      };
    },
    loadStepRows: async () => structuredClone(h.state.steps)
      .sort((a: Row, b: Row) => a.attempt - b.attempt),
    loadParkedIntent: async (_runId: string, id: string) => structuredClone(h.state.intents.get(id) ?? null),
    readRunControl: async () => {
      const run = h.state.run;
      return run ? { status: run.status, cancelRequestedAt: run.cancelRequestedAt ?? null, leaseToken: run.leaseToken ?? null } : null;
    },
    casAcquireLease: async (_runId: string, expect: string[]) => {
      const run = h.state.run;
      if (!run || !expect.includes(run.status)) return null;
      if (run.leaseToken && run.leaseExpiresAt.getTime() >= now()) return null;
      run.leaseToken = `aaaaaaaa-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
      run.leaseExpiresAt = lease();
      h.log.push('lease:acquire');
      return structuredClone(run);
    },
    fencedRunUpdate: async (_runId: string, token: string, patch: Row, mode: 'renew' | 'release') => {
      const run = h.state.run;
      if (!run || run.leaseToken !== token || TERMINAL.includes(run.status)) return false;
      Object.assign(run, patch);
      if (mode === 'release') { run.leaseToken = null; run.leaseExpiresAt = null; } else { run.leaseExpiresAt = lease(); }
      assertRunChecks(run);
      h.log.push(`run:${run.status}`);
      return true;
    },
    renewLease: async (_runId: string, token: string) => {
      const run = h.state.run;
      if (!run || run.leaseToken !== token || TERMINAL.includes(run.status)) return false;
      run.leaseExpiresAt = lease();
      run.lastHeartbeatAt = new Date(now());
      return true;
    },
    releaseLease: async (_runId: string, token: string) => {
      const run = h.state.run;
      if (run && run.leaseToken === token) { run.leaseToken = null; run.leaseExpiresAt = null; }
      h.log.push('lease:release');
    },
    insertStepRow: async (values: Row) => {
      const key = (r: Row) => `${r.runId}|${r.stepId}|${r.itemIndex ?? -1}|${r.attempt ?? 1}`;
      const row: Row = { approvalMode: 'none', attempt: 1, itemIndex: null, actionIntentId: null, output: null, renderedInput: null,
        errorCode: null, error: null, finishedAt: null, outputTruncated: false, approvedByUserId: null, startedAt: new Date(now()), ...values };
      if (h.state.steps.some((s) => key(s) === key(row))) throw Object.assign(new Error('duplicate key flow_run_steps_attempt_uq'), { code: '23505' });
      assertStepChecks(row);
      h.state.steps.push(row);
      h.log.push(`step+:${row.stepId}${row.itemIndex === null ? '' : `[${row.itemIndex}]`}#${row.attempt}:${row.status}`);
    },
    updateStepRow: async (_runId: string, id: string, values: Row) => {
      const row = h.state.steps.find((s) => s.id === id);
      if (!row) return;
      Object.assign(row, values);
      assertStepChecks(row);
      h.log.push(`step=:${row.stepId}${row.itemIndex === null ? '' : `[${row.itemIndex}]`}#${row.attempt}:${row.status}`);
    },
    lockOwnerSlots: async () => {},
    loadSlotSnapshot: async () => {
      const run = h.state.run;
      return {
        self: run ? { status: run.status, leaseToken: run.leaseToken ?? null } : null,
        otherRunningForFlowOrg: h.state.otherRunning,
        ownerRunning: h.state.ownerRunning,
      };
    },
    casRunToRunning: async (_runId: string, token: string) => {
      const run = h.state.run;
      if (!run || run.leaseToken !== token || !['queued', 'waiting', 'awaiting_approval'].includes(run.status)) return false;
      run.status = 'running';
      run.wakeAt = null;
      run.startedAt = run.startedAt ?? new Date(now());
      run.leaseExpiresAt = lease();
      assertRunChecks(run);
      h.log.push('run:running(slot)');
      return true;
    },
    countActiveRunsForOwner: async () => 0,
  };
});

vi.mock('../services/flows/stepExecutor', () => ({ executeFlowStep: (...args: unknown[]) => h.execute(...args) }));
vi.mock('../services/flows/versions', () => ({
  assertDelegatorAuthority: (...args: unknown[]) => (h.assertDelegatorAuthority as (...a: unknown[]) => Promise<boolean>)(...args),
  pauseFlow: (...args: unknown[]) => { h.log.push(`pause:${String(args[1])}`); return (h.pauseFlow as (...a: unknown[]) => Promise<void>)(...args); },
}));
vi.mock('../services/eventBus', () => ({
  publishEvent: (...args: unknown[]) => { h.log.push(`publish:${String(args[0])}`); return (h.publishEvent as (...a: unknown[]) => Promise<string>)(...args); },
}));
vi.mock('../services/userNotifications', () => ({ createNotification: (...a: unknown[]) => (h.createNotification as (...x: unknown[]) => Promise<string>)(...a) }));
vi.mock('./flowRunQueue', () => ({
  FLOW_RUNS_QUEUE: 'flow-runs',
  FLOW_RUN_SLICE_JOB_NAME: 'flow-run-slice',
  enqueueFlowRunSlice: (...a: unknown[]) => (h.enqueueFlowRunSlice as (...x: unknown[]) => Promise<string>)(...a),
  getFlowRunQueue: vi.fn(),
  closeFlowRunQueue: vi.fn(async () => {}),
}));
vi.mock('../config/env', () => ({
  flowsEnabled: () => h.flowsEnabled(),
  flowMaxRunningPerOwner: () => h.maxRunning,
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/flowValidator', async () => {
  const { z } = await import('zod');
  const tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
  const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
  return {
    flowStepPinSchema: z.union([
      z.object({
        stepId, tool: z.string(), source: z.literal('tenant'), tier,
        approvalScope: z.literal('supervised').nullable(), tenantToolId: z.string(), tenantRevision: z.string(),
      }).strict(),
      z.object({
        stepId, tool: z.string(), source: z.enum(['core', 'builtin']), tier,
        approvalScope: z.enum(['supervised', 'four_eyes']).nullable(),
      }).strict(),
    ]),
    flowPreApprovalBindingSchema: z.object({
      stepId, lane: z.literal('act_asset'), assetKind: z.literal('script'), scriptId: z.string().uuid(),
      contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
  };
});

import { processFlowRunJob } from './flowRunner';

const RUN_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG_ID = 'cccccccc-0000-4000-8000-000000000001';
const PARTNER_ID = 'dddddddd-0000-4000-8000-000000000001';
const FLOW_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const PUB_ID = 'ffffffff-0000-4000-8000-000000000001';
const DELEGATOR = '11111111-0000-4000-8000-000000000001';
const APPROVER = '22222222-0000-4000-8000-000000000001';
const INTENT_1 = '33333333-0000-4000-8000-000000000001';
const INTENT_2 = '33333333-0000-4000-8000-000000000002';

interface StepDef {
  id: string;
  tool?: string;
  input?: Record<string, unknown>;
  onFailure?: 'stop' | 'continue';
  forEach?: { items: string; maxItems?: number };
  timeoutSec?: number;
}

function seed(opts: {
  steps: StepDef[];
  tiers?: Record<string, 1 | 2 | 3>;
  run?: Row;
  flow?: Row;
  publication?: Row;
  inputs?: Record<string, unknown>;
}): void {
  const steps = opts.steps.map((s) => ({
    id: s.id,
    tool: s.tool ?? `tool_${s.id}`,
    input: s.input ?? {},
    ...(s.onFailure ? { onFailure: s.onFailure } : {}),
    ...(s.forEach ? { forEach: { items: s.forEach.items, ...(s.forEach.maxItems ? { maxItems: s.forEach.maxItems } : {}) } } : {}),
    ...(s.timeoutSec ? { timeoutSec: s.timeoutSec } : {}),
  }));
  const definition = {
    version: 1,
    name: 'Disk cleanup',
    trigger: { type: 'manual' },
    inputs: [{ name: 'hosts', type: 'string' }],
    steps,
  };
  const pins = steps.map((s) => (s.tool === 'wait' || s.tool === 'set'
    ? { stepId: s.id, tool: s.tool, source: 'builtin', tier: 1, approvalScope: null }
    : {
      stepId: s.id, tool: s.tool, source: 'core', tier: opts.tiers?.[s.id] ?? 1,
      approvalScope: (opts.tiers?.[s.id] ?? 1) === 3 ? 'supervised' : null,
    }));
  h.state.publication = {
    id: PUB_ID, flowId: FLOW_ID, orgId: ORG_ID, partnerId: null, publicationSeq: 1, definitionVersion: 1,
    definition, effectiveTier: 1, stepPins: pins, preApprovals: [], enabledByUserId: DELEGATOR, createdAt: new Date(),
    ...opts.publication,
  };
  h.state.flow = { id: FLOW_ID, orgId: ORG_ID, partnerId: null, status: 'enabled', name: 'Disk cleanup', enabledPublicationSeq: 1, ...opts.flow };
  h.state.run = {
    id: RUN_ID, orgId: ORG_ID, flowId: FLOW_ID, flowVersionId: PUB_ID, definitionVersion: 1,
    triggerKind: 'manual', triggeredVia: 'ui', triggerPayload: { kind: 'manual', orgId: ORG_ID, firedAt: '2026-10-25T00:00:00.000Z' },
    inputs: opts.inputs ?? {}, status: 'queued', preApprovalsHonored: false, currentStepId: null, currentItemIndex: null,
    resumeSeq: 0, leaseToken: null, leaseExpiresAt: null, wakeAt: null, dedupeKey: 'manual:x', chainDepth: 1,
    causedByRunId: 'bbbbbbbb-0000-4000-8000-0000000000ff', triggeredByUserId: null, aiSessionId: null, activeMs: 0,
    lastHeartbeatAt: null, cancelRequestedAt: null, bodiesPrunedAt: null, errorCode: null, error: null,
    startedAt: null, finishedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...opts.run,
  };
}

/** A ledger row as the runner (or the claim) would have written it. */
function ledger(row: Row): void {
  h.state.steps.push({
    id: newUuid(), runId: RUN_ID, orgId: ORG_ID, itemIndex: null, attempt: 1, toolSource: 'core', tier: 1,
    approvalMode: 'none', renderedInput: {}, output: null, outputTruncated: false, errorCode: null, error: null,
    actionIntentId: null, approvedByUserId: null, startedAt: new Date(), finishedAt: null, durationMs: null,
    tool: `tool_${row.stepId}`,
    ...row,
  });
}

function makeJob() {
  return {
    id: `flow-run-${RUN_ID}-0`,
    name: 'flow-run-slice',
    data: { runId: RUN_ID },
    token: 'job-lock-token',
    moveToDelayed: vi.fn(async (_ts: number, _token?: string) => { h.log.push('job:moveToDelayed'); }),
  };
}

async function run(job = makeJob()) {
  await processFlowRunJob(job as never, job.token);
  return job;
}

const completed = (output: unknown = { ok: true }) => ({ kind: 'completed', output, truncated: false, renderedInput: {} });
const execOrder = () => h.execute.mock.calls.map(([i]) => {
  const input = i as { step: { id: string }; itemIndex: number | null };
  return input.itemIndex === null ? input.step.id : `${input.step.id}[${input.itemIndex}]`;
});
const stepRow = (stepId: string, itemIndex: number | null = null, attempt?: number) => {
  const rows = h.state.steps.filter((s) => s.stepId === stepId && (s.itemIndex ?? null) === itemIndex);
  return attempt === undefined ? rows.sort((a, b) => b.attempt - a.attempt)[0] : rows.find((r) => r.attempt === attempt);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.log.length = 0;
  h.state.steps = [];
  h.state.intents = new Map();
  h.state.otherRunning = false;
  h.state.ownerRunning = 0;
  h.state.orgPartnerId = PARTNER_ID;
  h.maxRunning = 20;
  h.flowsEnabled.mockReturnValue(true);
  h.assertDelegatorAuthority.mockResolvedValue(true);
  h.execute.mockImplementation(async (i: { step: { id: string } }) => completed({ from: i.step.id }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('processFlowRunJob — the happy path', () => {
  it('three tier-1 steps complete in order', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    await run();
    expect(execOrder()).toEqual(['a', 'b', 'c']);
    // each step sees the earlier outputs in scope
    const bInput = h.execute.mock.calls[1]![0] as { scope: { steps: Record<string, unknown> } };
    expect(bInput.scope.steps).toEqual({ a: { output: { from: 'a' }, status: 'completed' } });
    expect(h.state.run!.status).toBe('completed');
    expect(h.state.run!.finishedAt).toBeInstanceOf(Date);
    expect(h.state.run!.leaseToken).toBeNull();
    expect(h.state.steps.map((s) => [s.stepId, s.status])).toEqual([['a', 'completed'], ['b', 'completed'], ['c', 'completed']]);
    expect(h.state.steps.every((s) => s.output !== null && s.finishedAt instanceof Date)).toBe(true);
  });

  it('skipped step leaves status skipped and output null', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }] });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (i.step.id === 'a' ? { kind: 'skipped' } : completed()));
    await run();
    expect(stepRow('a')).toMatchObject({ status: 'skipped', output: null });
    expect(h.state.run!.status).toBe('completed');
  });

  it('completion publishes flow.run.completed after commit', async () => {
    seed({ steps: [{ id: 'a' }] });
    await run();
    expect(h.publishEvent).toHaveBeenCalledTimes(1);
    expect(h.publishEvent).toHaveBeenCalledWith(
      'flow.run.completed',
      ORG_ID,
      { flowId: FLOW_ID, runId: RUN_ID, chainDepth: 1, status: 'completed' },
      'flow-runner',
      { flowRunId: RUN_ID, flowChainDepth: 1 },
    );
    const commit = h.log.lastIndexOf('run:completed');
    expect(h.log.indexOf('tx:commit', commit)).toBeGreaterThan(commit);
    expect(h.log.indexOf('publish:flow.run.completed')).toBeGreaterThan(h.log.indexOf('tx:commit', commit));
  });
});

describe('processFlowRunJob — approvals', () => {
  it('tier-3 step parks and job returns', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], tiers: { b: 3 } });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (
      i.step.id === 'b' ? { kind: 'park_approval', intentId: INTENT_1, renderedInput: { scriptId: 'x' } } : completed()));
    await run();
    expect(execOrder()).toEqual(['a', 'b']);
    expect(stepRow('b')).toMatchObject({ status: 'awaiting_approval', approvalMode: 'intent', actionIntentId: INTENT_1, finishedAt: null });
    expect(h.state.run).toMatchObject({ status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1, leaseToken: null, finishedAt: null });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('approve wake copies intent result and continues', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1, startedAt: new Date() } });
    ledger({ stepId: 'a', status: 'completed', output: { from: 'a' }, finishedAt: new Date() });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'completed', result: { cleaned: 12 }, errorCode: null, executedAt: new Date(), decidedByUserId: APPROVER });
    await run();
    expect(execOrder()).toEqual(['c']);
    expect(stepRow('b')).toMatchObject({ status: 'completed', output: { cleaned: 12 }, approvedByUserId: APPROVER });
    const cInput = h.execute.mock.calls[0]![0] as { scope: { steps: Record<string, { output: unknown }> } };
    expect(cInput.scope.steps.b!.output).toEqual({ cleaned: 12 });
    expect(h.state.run!.status).toBe('completed');
  });

  it('approved wake from awaiting_approval reaches running and completes (runAdmission NOT mocked)', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }], tiers: { a: 3 }, run: { status: 'awaiting_approval', currentStepId: 'a', resumeSeq: 1 } });
    ledger({ stepId: 'a', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'completed', result: {}, errorCode: null, executedAt: new Date(), decidedByUserId: APPROVER });
    await run();
    expect(h.log).toContain('run:running(slot)');
    expect(h.log.indexOf('run:running(slot)')).toBeLessThan(h.log.indexOf('step=:a#1:completed'));
    expect(h.state.run!.status).toBe('completed');
  });

  it('deny fails the run rejected', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b', onFailure: 'continue' }, { id: 'c' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'a', status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'rejected', result: null, errorCode: null, executedAt: null, decidedByUserId: APPROVER });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('b')).toMatchObject({ status: 'failed', errorCode: 'rejected' });
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'rejected' });
    expect(h.publishEvent).toHaveBeenCalledWith('flow.run.failed', ORG_ID, expect.objectContaining({ status: 'failed' }), 'flow-runner', expect.anything());
  });

  it('expired intent expires the run', async () => {
    seed({ steps: [{ id: 'b' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'expired', result: null, errorCode: null, executedAt: null, decidedByUserId: null });
    await run();
    expect(h.state.run!.status).toBe('expired');
    expect(h.state.run!.finishedAt).toBeInstanceOf(Date);
    expect(stepRow('b')!.status).toBe('cancelled');
  });

  it('an intent cancelled no_eligible_approvers fails the run with that code', async () => {
    seed({ steps: [{ id: 'b' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'cancelled', result: null, errorCode: 'no_eligible_approvers', executedAt: null, decidedByUserId: null });
    await run();
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'no_eligible_approvers' });
  });

  it('release execution_lost becomes unknown_outcome despite onFailure continue', async () => {
    seed({ steps: [{ id: 'b', onFailure: 'continue' }, { id: 'c' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'failed', result: null, errorCode: 'execution_lost', executedAt: null, decidedByUserId: APPROVER });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('b')!.status).toBe('unknown_outcome');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'unknown_outcome' });
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: DELEGATOR, orgId: ORG_ID }));
  });

  it('release execution_error with executed: true is unknown_outcome; without it the step fails and onFailure applies', async () => {
    seed({ steps: [{ id: 'b', onFailure: 'continue' }, { id: 'c' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'failed', result: null, errorCode: 'revalidation_failed', executedAt: null, decidedByUserId: APPROVER });
    await run();
    expect(stepRow('b')).toMatchObject({ status: 'failed', errorCode: 'step_failed' });
    expect(execOrder()).toEqual(['c']);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'step_failed' });
  });

  it('a spurious wake (intent still pending) releases the lease and returns', async () => {
    seed({ steps: [{ id: 'b' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'pending_approval', result: null, errorCode: null, executedAt: null, decidedByUserId: null });
    await run();
    expect(h.state.run).toMatchObject({ status: 'awaiting_approval', leaseToken: null });
    expect(h.log).not.toContain('run:running(slot)');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('approval wake on for-each item 1 of 3 continues at item 2 (one intent per item, item 0 executed once)', async () => {
    seed({
      steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }],
      tiers: { fix: 3 },
      inputs: { hosts: ['h1', 'h2', 'h3'] },
      run: { status: 'awaiting_approval', currentStepId: 'fix', currentItemIndex: 1, resumeSeq: 2 },
    });
    ledger({ stepId: 'fix', itemIndex: 0, tier: 3, status: 'completed', approvalMode: 'intent', actionIntentId: INTENT_1, output: { host: 'h1' }, finishedAt: new Date() });
    ledger({ stepId: 'fix', itemIndex: 1, tier: 3, status: 'awaiting_approval', approvalMode: 'intent', actionIntentId: INTENT_2 });
    h.state.intents.set(INTENT_2, { id: INTENT_2, status: 'completed', result: { host: 'h2' }, errorCode: null, executedAt: new Date(), decidedByUserId: APPROVER });
    h.execute.mockImplementation(async () => completed({ host: 'h3' }));
    await run();
    expect(execOrder()).toEqual(['fix[2]']);
    expect((h.execute.mock.calls[0]![0] as { item: unknown }).item).toBe('h3');
    expect(stepRow('fix', 1)).toMatchObject({ status: 'completed', output: { host: 'h2' } });
    expect(h.state.run!.status).toBe('completed');
  });
});

describe('processFlowRunJob — worker death', () => {
  it('stalled tier-3 step becomes unknown_outcome', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], tiers: { b: 3 }, run: {
      status: 'running', currentStepId: 'b', startedAt: new Date(),
      leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() - 1000),
    } });
    ledger({ stepId: 'a', status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'b', status: 'running', tier: 3, approvalMode: 'pre_approved' });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('b')).toMatchObject({ status: 'unknown_outcome', errorCode: 'unknown_outcome' });
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'unknown_outcome' });
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: DELEGATOR }));
    expect(h.publishEvent).toHaveBeenCalledWith('flow.run.failed', ORG_ID, expect.objectContaining({ runId: RUN_ID }), 'flow-runner', expect.anything());
  });

  it('stalled tier-1 step retries', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }], run: {
      status: 'running', currentStepId: 'b', startedAt: new Date(),
      leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() - 1000),
    } });
    ledger({ stepId: 'a', status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'b', status: 'running', tier: 1 });
    await run();
    expect(execOrder()).toEqual(['b']);
    expect(stepRow('b', null, 1)).toMatchObject({ status: 'failed', errorCode: 'worker_lost' });
    expect(stepRow('b', null, 2)).toMatchObject({ status: 'completed' });
    expect(h.state.run!.status).toBe('completed');
  });

  it('a live lease is never taken over (another slice owns the run)', async () => {
    seed({ steps: [{ id: 'a' }], run: { status: 'running', leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() + 60_000) } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run!.leaseToken).toBe('aaaaaaaa-0000-4000-8000-0000000000dd');
  });

  it('stalled run is re-claimed by its own slot and not delayed forever', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }], run: {
      status: 'running', currentStepId: 'a', startedAt: new Date(),
      leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() - 1000),
    } });
    ledger({ stepId: 'a', status: 'completed', finishedAt: new Date() });
    h.state.ownerRunning = 20; // the owner is at its cap; the stalled run IS one of those
    const job = await run();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(execOrder()).toEqual(['b']);
    expect(h.state.run!.status).toBe('completed');
  });

  it('stalled redelivery on item 2 only retries item 2 (tier 1)', async () => {
    seed({
      steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }], inputs: { hosts: ['h1', 'h2', 'h3'] },
      run: { status: 'running', currentStepId: 'fix', currentItemIndex: 2, leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() - 1) },
    });
    ledger({ stepId: 'fix', itemIndex: 0, status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'fix', itemIndex: 1, status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'fix', itemIndex: 2, status: 'running' });
    await run();
    expect(execOrder()).toEqual(['fix[2]']);
    expect(stepRow('fix', 2, 1)).toMatchObject({ status: 'failed', errorCode: 'worker_lost' });
    expect(stepRow('fix', 2, 2)!.status).toBe('completed');
    expect(h.state.run!.status).toBe('completed');
  });

  it('stalled redelivery on item 2 only unknowns item 2 (tier 3)', async () => {
    seed({
      steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }], tiers: { fix: 3 }, inputs: { hosts: ['h1', 'h2', 'h3'] },
      run: { status: 'running', currentStepId: 'fix', currentItemIndex: 2, leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000dd', leaseExpiresAt: new Date(Date.now() - 1) },
    });
    ledger({ stepId: 'fix', itemIndex: 0, tier: 3, status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'fix', itemIndex: 1, tier: 3, status: 'completed', finishedAt: new Date() });
    ledger({ stepId: 'fix', itemIndex: 2, tier: 3, status: 'running', approvalMode: 'pre_approved' });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('fix', 0)!.status).toBe('completed');
    expect(stepRow('fix', 1)!.status).toBe('completed');
    expect(stepRow('fix', 2)!.status).toBe('unknown_outcome');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'unknown_outcome' });
  });

  it('a 900 s step keeps its lease (fake timers) and reconciler (c) does not enqueue', async () => {
    vi.useFakeTimers();
    seed({ steps: [{ id: 'slow', timeoutSec: 3600 }] });
    let leaseHeldThroughout = true;
    h.execute.mockImplementation(async () => {
      for (let t = 0; t < 900; t += 30) {
        await new Promise((r) => setTimeout(r, 30_000));
        // reconciler clause (c): status = 'running' AND lease_expires_at < now()
        const run = h.state.run!;
        if (run.status === 'running' && run.leaseExpiresAt.getTime() < Date.now()) leaseHeldThroughout = false;
      }
      return completed();
    });
    const job = makeJob();
    const done = processFlowRunJob(job as never, job.token);
    await vi.advanceTimersByTimeAsync(901_000);
    await done;
    expect(leaseHeldThroughout).toBe(true);
    expect(h.state.run!.status).toBe('completed');
    expect(h.state.run!.activeMs).toBeGreaterThanOrEqual(900_000);
  });
});

describe('processFlowRunJob — failures', () => {
  it('onFailure continue proceeds and run ends failed', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b', onFailure: 'continue' }, { id: 'c' }] });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (
      i.step.id === 'b' ? { kind: 'failed', code: 'step_failed', message: 'boom', policy: false, renderedInput: {} } : completed()));
    await run();
    expect(execOrder()).toEqual(['a', 'b', 'c']);
    expect(stepRow('b')).toMatchObject({ status: 'failed', errorCode: 'step_failed', error: 'boom' });
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'step_failed' });
    expect(h.publishEvent).toHaveBeenCalledWith('flow.run.failed', ORG_ID, expect.objectContaining({ status: 'failed' }), 'flow-runner', expect.anything());
  });

  it('onFailure stop fails the run', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (
      i.step.id === 'b' ? { kind: 'failed', code: 'step_timeout', message: 'slow', policy: false } : completed()));
    await run();
    expect(execOrder()).toEqual(['a', 'b']);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'step_timeout' });
  });

  it('policy failure ignores onFailure continue', async () => {
    seed({ steps: [{ id: 'a', onFailure: 'continue' }, { id: 'b' }] });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (
      i.step.id === 'a' ? { kind: 'failed', code: 'reference_not_owned', message: 'nope', policy: true } : completed()));
    await run();
    expect(execOrder()).toEqual(['a']);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'reference_not_owned' });
    expect(h.pauseFlow).not.toHaveBeenCalled();
  });

  it('binding_drift pauses the flow', async () => {
    seed({ steps: [{ id: 'a' }], tiers: { a: 3 } });
    h.execute.mockResolvedValue({ kind: 'failed', code: 'binding_drift', message: 'changed', policy: true, approvalMode: 'pre_approved' });
    await run();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'binding_drift');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'binding_drift' });
    expect(stepRow('a')).toMatchObject({ status: 'failed', approvalMode: 'pre_approved' });
  });

  it.each(['drift', 'tool_unavailable', 'tool_blocked'] as const)('tool revision drift pauses the flow (%s)', async (code) => {
    seed({ steps: [{ id: 'a' }] });
    h.execute.mockResolvedValue({ kind: 'failed', code, message: 'moved', policy: true });
    await run();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: code });
    expect(h.createNotification).not.toHaveBeenCalled(); // pauseFlow notifies; the runner does not double up
  });

  it('a tier ≥ 2 unknown_outcome from the executor fails the run and notifies', async () => {
    seed({ steps: [{ id: 'a', onFailure: 'continue' }, { id: 'b' }], tiers: { a: 2 } });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => (
      i.step.id === 'a' ? { kind: 'unknown_outcome', message: 'timed out', renderedInput: {} } : completed()));
    await run();
    expect(execOrder()).toEqual(['a']);
    expect(stepRow('a')!.status).toBe('unknown_outcome');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'unknown_outcome' });
    expect(h.createNotification).toHaveBeenCalledTimes(1);
  });

  it('run_timeout after 3600 s active', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    seed({ steps: [{ id: 'a' }, { id: 'b' }] });
    h.execute.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 3_600_001);
      return completed();
    });
    await run();
    expect(execOrder()).toEqual(['a']);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'run_timeout' });
  });

  it('for-each items over maxItems fails too_many_items', async () => {
    seed({ steps: [{ id: 'fix', forEach: { items: 'inputs.hosts', maxItems: 2 } }], inputs: { hosts: ['h1', 'h2', 'h3'] } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('fix')).toMatchObject({ status: 'failed', errorCode: 'too_many_items', itemIndex: null });
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'too_many_items' });
  });

  it('non-array items fails', async () => {
    seed({ steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }], inputs: { hosts: 'h1,h2' } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stepRow('fix')!.status).toBe('failed');
    expect(h.state.run!.status).toBe('failed');
  });

  it('a for-each item failing under continue runs the rest and fails the step', async () => {
    seed({ steps: [{ id: 'fix', onFailure: 'continue', forEach: { items: 'inputs.hosts' } }, { id: 'after' }], inputs: { hosts: ['h1', 'h2', 'h3'] } });
    h.execute.mockImplementation(async (i: { itemIndex: number | null }) => (
      i.itemIndex === 1 ? { kind: 'failed', code: 'step_failed', message: 'x', policy: false } : completed()));
    await run();
    expect(execOrder()).toEqual(['fix[0]', 'fix[1]', 'fix[2]', 'after']);
    const afterScope = (h.execute.mock.calls[3]![0] as { scope: { steps: Record<string, { status: string; output: unknown }> } }).scope.steps.fix!;
    expect(afterScope.status).toBe('failed');
    expect(afterScope.output).toEqual([{ ok: true }, null, { ok: true }]);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'step_failed' });
  });

  it('a for-each item failing under stop ends the step there', async () => {
    seed({ steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }], inputs: { hosts: ['h1', 'h2', 'h3'] } });
    h.execute.mockImplementation(async (i: { itemIndex: number | null }) => (
      i.itemIndex === 1 ? { kind: 'failed', code: 'step_failed', message: 'x', policy: false } : completed()));
    await run();
    expect(execOrder()).toEqual(['fix[0]', 'fix[1]']);
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'step_failed' });
  });
});

describe('processFlowRunJob — waits', () => {
  it('wait re-enqueues with delay and excludes waited time from active_ms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:00.000Z'));
    seed({ steps: [{ id: 'pause', tool: 'wait', input: { minutes: 10 } }, { id: 'b' }] });
    h.execute.mockImplementation(async (i: { step: { id: string } }) => {
      if (i.step.id === 'pause') {
        const resumeAt = new Date(Date.now() + 600_000);
        return { kind: 'park_wait', resumeAt, output: { waitUntil: resumeAt.toISOString() }, renderedInput: { minutes: 10 } };
      }
      vi.setSystemTime(Date.now() + 2_000);
      return completed();
    });
    await run();
    expect(h.state.run).toMatchObject({ status: 'waiting', resumeSeq: 1, leaseToken: null });
    expect(h.state.run!.wakeAt.toISOString()).toBe('2026-10-25T10:10:00.000Z');
    expect(stepRow('pause')).toMatchObject({ status: 'completed', output: { waitUntil: '2026-10-25T10:10:00.000Z' } });
    expect(h.enqueueFlowRunSlice).toHaveBeenCalledWith(RUN_ID, { delayMs: 600_000 });

    vi.setSystemTime(new Date('2026-10-25T10:10:00.500Z'));
    await run();
    expect(execOrder()).toEqual(['pause', 'b']);
    expect(h.state.run!.status).toBe('completed');
    expect(h.state.run!.wakeAt).toBeNull();
    expect(h.state.run!.activeMs).toBeLessThan(10_000);
  });

  it('wait step is completed at park and resume starts at the next step', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'pause', tool: 'wait', input: { minutes: 1 } }, { id: 'c' }], run: {
      status: 'waiting', wakeAt: new Date(Date.now() - 1000), currentStepId: 'pause', resumeSeq: 1, startedAt: new Date(),
    } });
    ledger({ stepId: 'a', status: 'completed', output: { from: 'a' }, finishedAt: new Date() });
    ledger({ stepId: 'pause', tool: 'wait', toolSource: 'builtin', status: 'completed', output: { waitUntil: 'x' }, finishedAt: new Date() });
    await run();
    expect(execOrder()).toEqual(['c']);
    expect(h.state.run!.status).toBe('completed');
  });

  it('early wake of a waiting run returns without work', async () => {
    seed({ steps: [{ id: 'a' }], run: { status: 'waiting', wakeAt: new Date(Date.now() + 60_000), currentStepId: 'a', resumeSeq: 1 } });
    await run();
    expect(h.log).not.toContain('lease:acquire');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run!.status).toBe('waiting');
  });
});

describe('processFlowRunJob — slice preconditions', () => {
  it('flag off fails the run flows_disabled without executing', async () => {
    h.flowsEnabled.mockReturnValue(false);
    seed({ steps: [{ id: 'a' }] });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'flows_disabled' });
  });

  it('inactive delegator pauses the flow', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    seed({ steps: [{ id: 'a' }] });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'delegator_inactive');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'delegator_inactive' });
  });

  it('delegator removed from the org pauses the flow (re-resolved in the owner scope)', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    seed({ steps: [{ id: 'a' }] });
    await run();
    expect(h.assertDelegatorAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ enabledByUserId: DELEGATOR }),
      { orgId: ORG_ID, partnerId: PARTNER_ID },
    );
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'delegator_inactive');
  });

  it('a partner-wide flow checks the delegator in the partner scope', async () => {
    seed({ steps: [{ id: 'a' }], flow: { orgId: null, partnerId: PARTNER_ID }, publication: { orgId: null, partnerId: PARTNER_ID } });
    await run();
    expect(h.assertDelegatorAuthority).toHaveBeenCalledWith(expect.anything(), { orgId: null, partnerId: PARTNER_ID });
    expect(h.state.run!.status).toBe('completed');
  });

  it('inactive delegator on resume pauses the flow', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    seed({ steps: [{ id: 'b' }, { id: 'c' }], tiers: { b: 3 }, run: { status: 'awaiting_approval', currentStepId: 'b', resumeSeq: 1 } });
    ledger({ stepId: 'b', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'completed', result: {}, errorCode: null, executedAt: new Date(), decidedByUserId: APPROVER });
    await run();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'delegator_inactive');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'delegator_inactive' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('disabled flow cancels a queued run', async () => {
    seed({ steps: [{ id: 'a' }], flow: { status: 'disabled', enabledPublicationSeq: null } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'cancelled', errorCode: 'flow_disabled' });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('version moved fails drift', async () => {
    seed({ steps: [{ id: 'a' }], flow: { enabledPublicationSeq: 2 } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'drift' });
  });

  it('an unparseable pin fails drift and pauses the flow', async () => {
    seed({ steps: [{ id: 'a' }], publication: { stepPins: [{ stepId: 'a', tool: 'tool_a', source: 'core', tier: 9 }] } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'drift' });
  });

  it('an unparseable pre-approval binding fails drift and pauses the flow', async () => {
    seed({ steps: [{ id: 'a' }], publication: { preApprovals: [{ stepId: 'a', lane: 'other' }] } });
    await run();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift');
    expect(h.state.run).toMatchObject({ status: 'failed', errorCode: 'drift' });
  });

  it('cancel_requested_at cancels the run before any step', async () => {
    seed({ steps: [{ id: 'a' }], run: { cancelRequestedAt: new Date() } });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
  });

  it('a parked run cancelled by the user ends cancelled, never drift', async () => {
    // cancelFlowRun (Task A9): cancel_requested_at first, then the intent is
    // cancelled and its terminal outbox row wakes the run.
    seed({
      steps: [{ id: 'a' }, { id: 'b' }], tiers: { a: 3 },
      run: { status: 'awaiting_approval', currentStepId: 'a', resumeSeq: 1, cancelRequestedAt: new Date() },
    });
    ledger({ stepId: 'a', status: 'awaiting_approval', tier: 3, approvalMode: 'intent', actionIntentId: INTENT_1 });
    h.state.intents.set(INTENT_1, { id: INTENT_1, status: 'cancelled', result: null, errorCode: null, executedAt: null, decidedByUserId: null });
    await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    expect(stepRow('a')!.status).toBe('cancelled');
    expect(h.pauseFlow).not.toHaveBeenCalled();
  });

  it('a terminal run is left alone', async () => {
    seed({ steps: [{ id: 'a' }], run: { status: 'cancelled', finishedAt: new Date() } });
    await run();
    expect(h.log).not.toContain('lease:acquire');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload without touching the run', async () => {
    seed({ steps: [{ id: 'a' }] });
    const job = { ...makeJob(), data: { runId: 'not-a-uuid' } };
    await expect(processFlowRunJob(job as never, job.token)).rejects.toThrow(/Malformed flow-runs job payload/);
    expect(h.log).not.toContain('lease:acquire');
  });
});

describe('processFlowRunJob — slots', () => {
  it('no slot delays without consuming an attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:00.000Z'));
    seed({ steps: [{ id: 'a' }] });
    h.state.otherRunning = true;
    const job = makeJob();
    await expect(processFlowRunJob(job as never, job.token)).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse('2026-10-25T10:00:15.000Z'), 'job-lock-token');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.run).toMatchObject({ status: 'queued', leaseToken: null });
  });

  it('slot refusal releases the lease before delaying', async () => {
    seed({ steps: [{ id: 'a' }] });
    h.state.ownerRunning = 20;
    const job = makeJob();
    await expect(processFlowRunJob(job as never, job.token)).rejects.toBeInstanceOf(DelayedError);
    expect(h.log.indexOf('lease:release')).toBeGreaterThan(-1);
    expect(h.log.indexOf('lease:release')).toBeLessThan(h.log.indexOf('job:moveToDelayed'));
  });
});

describe('processFlowRunJob — cancellation and fencing', () => {
  it('cancel between for-each items', async () => {
    seed({ steps: [{ id: 'fix', forEach: { items: 'inputs.hosts' } }, { id: 'after' }], inputs: { hosts: ['h1', 'h2', 'h3'] } });
    h.execute.mockImplementation(async (i: { itemIndex: number | null }) => {
      if (i.itemIndex === 0) h.state.run!.cancelRequestedAt = new Date(); // an outside cancel lands mid-item
      return completed();
    });
    await run();
    expect(execOrder()).toEqual(['fix[0]']);
    expect(stepRow('fix', 0)!.status).toBe('completed');
    expect(h.state.run).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
  });

  it('outside cancel of a running run stops the slice at its next checkpoint', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }] });
    h.execute.mockImplementation(async () => {
      // An outside writer (org merge, disable) terminalizes the run while the step runs.
      Object.assign(h.state.run!, { status: 'cancelled', errorCode: 'org_merged', finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null });
      return completed({ late: true });
    });
    await run();
    expect(execOrder()).toEqual(['a']);
    // the late result is never written: the fenced checkpoint matched zero rows
    expect(stepRow('a')).toMatchObject({ status: 'running', output: null });
    expect(h.state.run).toMatchObject({ status: 'cancelled', errorCode: 'org_merged' });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('a superseded lease discards the late result', async () => {
    seed({ steps: [{ id: 'a' }, { id: 'b' }] });
    h.execute.mockImplementation(async () => {
      h.state.run!.leaseToken = 'aaaaaaaa-0000-4000-8000-0000000000ee'; // another slice took over
      return completed({ late: true });
    });
    await run();
    expect(execOrder()).toEqual(['a']);
    expect(stepRow('a')).toMatchObject({ status: 'running', output: null });
    expect(h.state.run!.status).toBe('running');
  });
});
