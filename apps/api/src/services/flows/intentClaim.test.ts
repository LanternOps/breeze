import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A5 / Decision 5 — the flow-aware dispatch
 * claim. Branch logic only: the DB is mocked at the module boundary
 * (`intentClaimStore`), so these tests pin WHICH reads decide WHAT and WHICH
 * writes each outcome makes. The FOR UPDATE / race semantics are proven on a
 * real database (flowIntentApproval.integration.test.ts, and Task A12).
 */
const h = vi.hoisted(() => {
  const store = {
    loadIntentForClaim: vi.fn(),
    lockRunForClaim: vi.fn(),
    lockStepForIntent: vi.fn(),
    loadFlowForClaim: vi.fn(),
    loadPublicationBySeq: vi.fn(),
    loadOrgPartnerId: vi.fn(),
    loadTenantToolLive: vi.fn(),
    casIntentApprovedToExecuting: vi.fn(),
    casIntentApprovedToCancelled: vi.fn(),
    closeStepForRefusal: vi.fn(),
    terminalizeRunForRefusal: vi.fn(),
  };
  return {
    store,
    assertDelegatorAuthority: vi.fn(),
    pauseFlow: vi.fn(async () => {}),
    publishIntentTerminalOutbox: vi.fn(async () => {}),
    publishFlowRunTerminalEvent: vi.fn(async () => {}),
    checkGuardrails: vi.fn(),
    flowsEnabled: vi.fn(() => true),
    order: [] as string[],
  };
});

vi.mock('../../db', () => ({
  db: { __tx: true },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    h.order.push('tx:begin');
    const out = await fn();
    h.order.push('tx:commit');
    return out;
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./intentClaimStore', () => h.store);
vi.mock('./versions', () => ({
  assertDelegatorAuthority: h.assertDelegatorAuthority,
  pauseFlow: (...args: unknown[]) => {
    h.order.push('pauseFlow');
    return (h.pauseFlow as (...a: unknown[]) => Promise<void>)(...args);
  },
}));
vi.mock('../aiOperator/taskOutbox', () => ({ publishIntentTerminalOutbox: h.publishIntentTerminalOutbox }));
vi.mock('./runEvents', () => ({
  publishFlowRunTerminalEvent: (...args: unknown[]) => {
    h.order.push('publish:flow.run');
    return (h.publishFlowRunTerminalEvent as (...a: unknown[]) => Promise<void>)(...args);
  },
}));
vi.mock('../aiGuardrails', () => ({ checkGuardrails: h.checkGuardrails }));
vi.mock('../../config/env', () => ({ flowsEnabled: () => h.flowsEnabled() }));
vi.mock('../flowValidator', async () => {
  const { z } = await import('zod');
  const tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
  return {
    flowStepPinSchema: z.union([
      z.object({
        stepId: z.string(), tool: z.string(), source: z.literal('tenant'), tier,
        approvalScope: z.literal('supervised').nullable(), tenantToolId: z.string(), tenantRevision: z.string(),
      }).strict(),
      z.object({
        stepId: z.string(), tool: z.string(), source: z.enum(['core', 'builtin']), tier,
        approvalScope: z.enum(['supervised', 'four_eyes']).nullable(),
      }).strict(),
    ]),
  };
});

import { claimFlowLinkedIntentForDispatch } from './intentClaim';

const INTENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG_ID = 'cccccccc-0000-4000-8000-000000000001';
const PARTNER_ID = 'dddddddd-0000-4000-8000-000000000001';
const FLOW_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const PUB_ID = 'ffffffff-0000-4000-8000-000000000001';
const STEP_ROW_ID = '99999999-0000-4000-8000-000000000001';
const DELEGATOR = '11111111-0000-4000-8000-000000000001';
const TOOL_ID = '22222222-0000-4000-8000-000000000001';

function intent(over: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID, orgId: ORG_ID, status: 'approved', releaseLive: true, requestingFlowRunId: RUN_ID,
    actionName: 'run_script', arguments: { scriptId: 's', deviceIds: ['d'] }, approvalScope: 'supervised',
    toolSourceToolId: null, toolRevision: null, taskId: null, ...over,
  };
}
function run(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID, orgId: ORG_ID, flowId: FLOW_ID, flowVersionId: PUB_ID, status: 'awaiting_approval',
    leaseLive: false, cancelRequestedAt: null, chainDepth: 1, ...over,
  };
}
const corePin = { stepId: 'cleanup', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' };
const DEFINITION = {
  version: 1, name: 'Disk cleanup', trigger: { type: 'manual' }, inputs: [],
  steps: [{ id: 'cleanup', tool: 'run_script', input: { scriptId: 's', deviceIds: ['d'] }, approval: 'default', onFailure: 'stop', timeoutSec: 300 }],
};
function publication(over: Record<string, unknown> = {}) {
  return { id: PUB_ID, flowId: FLOW_ID, publicationSeq: 2, enabledByUserId: DELEGATOR, definition: DEFINITION, stepPins: [corePin], ...over };
}

function untouched(): void {
  h.store.loadIntentForClaim.mockResolvedValue(intent());
  h.store.lockRunForClaim.mockResolvedValue(run());
  h.store.lockStepForIntent.mockResolvedValue({ id: STEP_ROW_ID, stepId: 'cleanup', status: 'awaiting_approval' });
  h.store.loadFlowForClaim.mockResolvedValue({ id: FLOW_ID, orgId: ORG_ID, partnerId: null, status: 'enabled', enabledPublicationSeq: 2 });
  h.store.loadPublicationBySeq.mockResolvedValue(publication());
  h.store.loadOrgPartnerId.mockResolvedValue(PARTNER_ID);
  h.store.loadTenantToolLive.mockResolvedValue(null);
  h.store.casIntentApprovedToExecuting.mockResolvedValue(true);
  h.store.casIntentApprovedToCancelled.mockResolvedValue(true);
  h.store.closeStepForRefusal.mockResolvedValue(undefined);
  h.store.terminalizeRunForRefusal.mockResolvedValue(true);
  h.assertDelegatorAuthority.mockResolvedValue(true);
  h.flowsEnabled.mockReturnValue(true);
  h.checkGuardrails.mockReturnValue({ allowed: true, tier: 3, approvalScope: 'supervised', requiresApproval: true, readOnly: false });
}

function expectNoWrites(): void {
  expect(h.store.casIntentApprovedToExecuting).not.toHaveBeenCalled();
  expect(h.store.casIntentApprovedToCancelled).not.toHaveBeenCalled();
  expect(h.store.closeStepForRefusal).not.toHaveBeenCalled();
  expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
  expect(h.publishIntentTerminalOutbox).not.toHaveBeenCalled();
  expect(h.pauseFlow).not.toHaveBeenCalled();
}

function expectIntentCancelledWithWake(): void {
  expect(h.store.casIntentApprovedToCancelled).toHaveBeenCalledWith(INTENT_ID, 'flow_drift', expect.any(Object));
  expect(h.publishIntentTerminalOutbox).toHaveBeenCalledTimes(1);
  expect(h.publishIntentTerminalOutbox).toHaveBeenCalledWith(
    expect.anything(),
    { id: INTENT_ID, orgId: ORG_ID, taskId: null, requestingFlowRunId: RUN_ID },
    'intent_cancelled',
  );
  expect(h.store.casIntentApprovedToExecuting).not.toHaveBeenCalled();
}

describe('claimFlowLinkedIntentForDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    untouched();
  });

  it('claim succeeds on an untouched run', async () => {
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: true, runId: RUN_ID, chainDepth: 1 });
    expect(h.store.casIntentApprovedToExecuting).toHaveBeenCalledWith(INTENT_ID);
    expect(h.store.casIntentApprovedToCancelled).not.toHaveBeenCalled();
    expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
    expect(h.publishIntentTerminalOutbox).not.toHaveBeenCalled();
    // Delegator re-checked against the flow OWNER scope (Decision 7), with
    // the PARSED publication so rule 7 is re-applied (review finding 6).
    expect(h.assertDelegatorAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ enabledByUserId: DELEGATOR }),
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      {
        doc: expect.objectContaining({ steps: [expect.objectContaining({ id: 'cleanup', tool: 'run_script' })] }),
        pins: [corePin],
      },
    );
  });

  // Review finding 6: a delegator demoted since enable (rule 7 now fails) is refused.
  it('a demoted-but-active delegator (rule 7) refuses delegator_inactive and pauses the flow', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'delegator_inactive' });
    expectIntentCancelledWithWake();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'delegator_inactive', { expectedPublicationSeq: 2 });
  });

  it('an unreadable publication definition is pin_invalid (drift + pause), never a delegator check on garbage', async () => {
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ definition: { version: 1, steps: 'nope' } }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'pin_invalid' });
    expectIntentCancelledWithWake();
    expect(h.assertDelegatorAuthority).not.toHaveBeenCalled();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift', { expectedPublicationSeq: 2 });
  });

  // Review finding 2: with FLOWS_ENABLED off an approved flow step must never
  // execute. The run fails flows_disabled (the runner's own flag-off ending);
  // the flow is NOT paused (the deployment flag, not the flow, changed).
  it('FLOWS_ENABLED off refuses the claim: intent cancelled, run failed flows_disabled, no pause', async () => {
    h.flowsEnabled.mockReturnValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'flows_disabled' });
    expectIntentCancelledWithWake();
    expect(h.store.casIntentApprovedToCancelled).toHaveBeenCalledWith(
      INTENT_ID, 'flow_drift', expect.objectContaining({ flowClaimRefusal: 'flows_disabled', error: expect.any(String) }),
    );
    expect(h.store.closeStepForRefusal).toHaveBeenCalledWith(STEP_ROW_ID, expect.objectContaining({ status: 'cancelled', errorCode: 'cancelled' }));
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'failed', errorCode: 'flows_disabled' }));
    expect(h.pauseFlow).not.toHaveBeenCalled();
    expect(h.publishFlowRunTerminalEvent).toHaveBeenCalledWith({ id: RUN_ID, orgId: ORG_ID, flowId: FLOW_ID, chainDepth: 1 }, 'failed');
  });

  it('FLOWS_ENABLED off still returns lost_race for a duplicate delivery (no writes)', async () => {
    h.flowsEnabled.mockReturnValue(false);
    h.store.loadIntentForClaim.mockResolvedValue(intent({ status: 'executing' }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expectNoWrites();
  });

  it('locks the run before re-reading the intent FOR UPDATE (disableFlow lock order: run → intent)', async () => {
    await claimFlowLinkedIntentForDispatch(INTENT_ID);
    const lockRun = h.store.lockRunForClaim.mock.invocationCallOrder[0]!;
    const lockedIntentRead = h.store.loadIntentForClaim.mock.invocationCallOrder[1]!;
    expect(h.store.loadIntentForClaim.mock.calls[1]).toEqual([INTENT_ID, { lock: true }]);
    expect(lockRun).toBeLessThan(lockedIntentRead);
  });

  it('duplicate delivery after a won claim is lost_race and cancels nothing', async () => {
    h.store.loadIntentForClaim.mockResolvedValue(intent({ status: 'executing' }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expect(h.store.lockRunForClaim).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('an intent past its release lease is lost_race (the expiry reaper owns it), writing nothing', async () => {
    h.store.loadIntentForClaim.mockResolvedValueOnce(intent()).mockResolvedValueOnce(intent({ releaseLive: false }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expectNoWrites();
  });

  it('a decision that moved the intent between the pre-read and the lock is lost_race', async () => {
    h.store.loadIntentForClaim.mockResolvedValueOnce(intent()).mockResolvedValueOnce(intent({ status: 'cancelled' }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expectNoWrites();
  });

  it('claim on a merge-cancelled run is run_terminal and leaves the run cancelled', async () => {
    h.store.lockRunForClaim.mockResolvedValue(run({ status: 'cancelled', cancelRequestedAt: new Date() }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'run_terminal' });
    expectIntentCancelledWithWake();
    expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
    expect(h.store.closeStepForRefusal).not.toHaveBeenCalled();
    // Checked FIRST: nothing about the flow was even read.
    expect(h.store.loadFlowForClaim).not.toHaveBeenCalled();
    expect(h.assertDelegatorAuthority).not.toHaveBeenCalled();
  });

  it('a run held under a live slice lease is run_leased: no intent, step or run write (the release job retries)', async () => {
    h.store.lockRunForClaim.mockResolvedValue(run({ leaseLive: true }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'run_leased' });
    expectNoWrites();
  });

  it('claim refuses a cancelled run and marks it cancelled', async () => {
    h.store.lockRunForClaim.mockResolvedValue(run({ cancelRequestedAt: new Date() }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'run_cancel_requested' });
    expectIntentCancelledWithWake();
    expect(h.store.closeStepForRefusal).toHaveBeenCalledWith(STEP_ROW_ID, expect.objectContaining({ status: 'cancelled', errorCode: 'cancelled' }));
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'cancelled', errorCode: 'cancelled' }));
    expect(h.pauseFlow).not.toHaveBeenCalled();
  });

  it('a run not waiting on THIS intent is run_not_waiting: the intent is cancelled, the run is not written', async () => {
    h.store.lockStepForIntent.mockResolvedValue(null);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'run_not_waiting' });
    expectIntentCancelledWithWake();
    expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
  });

  it('claim refuses when the flow is disabled (run cancelled flow_disabled)', async () => {
    h.store.loadFlowForClaim.mockResolvedValue({ id: FLOW_ID, orgId: ORG_ID, partnerId: null, status: 'disabled', enabledPublicationSeq: null });
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'flow_not_enabled' });
    expectIntentCancelledWithWake();
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'cancelled', errorCode: 'flow_disabled' }));
  });

  it('claim refuses when the flow moved to a new version (new publication)', async () => {
    h.store.loadFlowForClaim.mockResolvedValue({ id: FLOW_ID, orgId: ORG_ID, partnerId: null, status: 'enabled', enabledPublicationSeq: 3 });
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ id: 'ffffffff-0000-4000-8000-000000000002', publicationSeq: 3 }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'publication_moved' });
    expectIntentCancelledWithWake();
    expect(h.store.closeStepForRefusal).toHaveBeenCalledWith(STEP_ROW_ID, expect.objectContaining({ status: 'failed', errorCode: 'drift' }));
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'failed', errorCode: 'drift' }));
    expect(h.pauseFlow).not.toHaveBeenCalled();
    expect(h.assertDelegatorAuthority).not.toHaveBeenCalled();
  });

  it('claim refuses when the delegator lost org membership', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'delegator_inactive' });
    expectIntentCancelledWithWake();
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'failed', errorCode: 'delegator_inactive' }));
  });

  it('claim refuses and pauses on an inactive delegator — the pause runs after the claim transaction', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    await claimFlowLinkedIntentForDispatch(INTENT_ID);
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'delegator_inactive', { expectedPublicationSeq: 2 });
    // flows-row lock taken outside the run/intent locks: no AB-BA with disableFlow.
    expect(h.order.indexOf('pauseFlow')).toBeGreaterThan(h.order.indexOf('tx:commit'));
  });

  it('a publication with no delegator left (user deleted ⇒ SET NULL) is delegator_inactive', async () => {
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ enabledByUserId: null }));
    h.assertDelegatorAuthority.mockResolvedValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toMatchObject({ reason: 'delegator_inactive' });
  });

  it('claim refuses on tenant revision change (and pauses the flow drift)', async () => {
    const tenantPin = { stepId: 'cleanup', tool: 'acme__restart', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: TOOL_ID, tenantRevision: 'rev-1' };
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [tenantPin] }));
    h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'acme__restart', toolSourceToolId: TOOL_ID, toolRevision: 'rev-1' }));
    h.store.loadTenantToolLive.mockResolvedValue({ revision: 'rev-2', enabled: true, removedAt: null, sourceStatus: 'active' });
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'tool_revision_changed' });
    expectIntentCancelledWithWake();
    expect(h.store.terminalizeRunForRefusal).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({ status: 'failed', errorCode: 'drift' }));
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift', { expectedPublicationSeq: 2 });
  });

  it('a tenant step whose live revision still matches the pin is claimed', async () => {
    const tenantPin = { stepId: 'cleanup', tool: 'acme__restart', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: TOOL_ID, tenantRevision: 'rev-1' };
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [tenantPin] }));
    h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'acme__restart', toolSourceToolId: TOOL_ID, toolRevision: 'rev-1' }));
    h.store.loadTenantToolLive.mockResolvedValue({ revision: 'rev-1', enabled: true, removedAt: null, sourceStatus: 'active' });
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toMatchObject({ claimed: true });
    expect(h.checkGuardrails).not.toHaveBeenCalled();
  });

  // W5 PR B (#5220, Decision 12): an approved Tier-3 built-in step.
  describe('built-in steps', () => {
    const builtinPin = { stepId: 'cleanup', tool: 'http_request', source: 'builtin', tier: 3, approvalScope: 'supervised' };
    const POST = { method: 'POST', url: 'https://api.example.com/x' };

    it('a built-in still matching its Tier-3 supervised pin is claimed without the core classifier', async () => {
      h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [builtinPin] }));
      h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'http_request', arguments: POST }));
      await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toMatchObject({ claimed: true });
      expect(h.checkGuardrails).not.toHaveBeenCalled();
    });

    it('a built-in intent against a pin of another tool, source or scope is approval_scope_changed (drift + pause)', async () => {
      for (const pin of [
        { ...builtinPin, tool: 'notify' },
        { ...builtinPin, source: 'core' },
        { ...builtinPin, approvalScope: null, tier: 2 },
      ]) {
        vi.clearAllMocks();
        untouched();
        h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [pin] }));
        h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'http_request', arguments: POST }));
        await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'approval_scope_changed' });
        expectIntentCancelledWithWake();
      }
    });

    // W6 (#5221): the fleet built-in's scope is derived (it may be four_eyes);
    // the claim accepts it when the intent's scope equals the pin's.
    it('a run_script_on_targets intent matching its Tier-3 pin (same derived scope) is claimed', async () => {
      const FLEET = { scriptId: 's', whenOffline: 'queue', deviceIds: ['d'] };
      for (const scope of ['supervised', 'four_eyes'] as const) {
        vi.clearAllMocks();
        untouched();
        h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [{ ...builtinPin, tool: 'run_script_on_targets', approvalScope: scope }] }));
        h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'run_script_on_targets', arguments: FLEET, approvalScope: scope }));
        await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toMatchObject({ claimed: true });
      }
      vi.clearAllMocks();
      untouched();
      h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [{ ...builtinPin, tool: 'run_script_on_targets', approvalScope: 'four_eyes' }] }));
      h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'run_script_on_targets', arguments: FLEET, approvalScope: 'supervised' }));
      await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'approval_scope_changed' });
    });

    it('an ai or notify intent (never Tier 3) is refused', async () => {
      h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [{ ...builtinPin, tool: 'ai' }] }));
      h.store.loadIntentForClaim.mockResolvedValue(intent({ actionName: 'ai', arguments: { prompt: 'x', tools: [], output: { type: 'object' } } }));
      await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'approval_scope_changed' });
    });
  });

  it('claim refuses when supervised became four_eyes', async () => {
    h.checkGuardrails.mockReturnValue({ allowed: true, tier: 3, approvalScope: 'four_eyes', requiresApproval: true, readOnly: false });
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'approval_scope_changed' });
    expectIntentCancelledWithWake();
    expect(h.checkGuardrails).toHaveBeenCalledWith('run_script', { scriptId: 's', deviceIds: ['d'] });
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift', { expectedPublicationSeq: 2 });
  });

  it('unreadable pins on the publication are pin_invalid (drift + pause)', async () => {
    h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [{ stepId: 'cleanup', tool: 'run_script' }] }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'pin_invalid' });
    expectIntentCancelledWithWake();
    expect(h.pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'drift', { expectedPublicationSeq: 2 });
  });

  it('losing the final approved → executing CAS is lost_race (never a drift cancel)', async () => {
    h.store.casIntentApprovedToExecuting.mockResolvedValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expect(h.store.casIntentApprovedToCancelled).not.toHaveBeenCalled();
    expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
  });

  it.each([
    ['run_cancel_requested', () => h.store.lockRunForClaim.mockResolvedValue(run({ cancelRequestedAt: new Date() }))],
    ['run_not_waiting', () => h.store.lockStepForIntent.mockResolvedValue(null)],
    ['flow_not_enabled', () => h.store.loadFlowForClaim.mockResolvedValue(null)],
    ['publication_moved', () => h.store.loadPublicationBySeq.mockResolvedValue(null)],
    ['delegator_inactive', () => h.assertDelegatorAuthority.mockResolvedValue(false)],
    ['approval_scope_changed', () => h.checkGuardrails.mockReturnValue({ allowed: false, tier: 4 })],
    ['pin_invalid', () => h.store.loadPublicationBySeq.mockResolvedValue(publication({ stepPins: [] }))],
  ])('every other refusal (%s) cancels the intent and schedules a wake', async (reason, arrange) => {
    arrange();
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason });
    expectIntentCancelledWithWake();
  });

  // Plan Task A8: a claim-refused run is already terminal when the wake
  // reaches the runner (which then returns at its terminal check), so the
  // claim itself publishes flow.run.failed — after commit, once per run it
  // actually ended. Cancelled outcomes publish nothing (no flow.run.cancelled).
  it.each([
    ['publication_moved', () => h.store.loadPublicationBySeq.mockResolvedValue(null)],
    ['delegator_inactive', () => h.assertDelegatorAuthority.mockResolvedValue(false)],
    ['approval_scope_changed', () => h.checkGuardrails.mockReturnValue({ allowed: false, tier: 4 })],
  ])('a refusal that fails the run (%s) publishes flow.run.failed after commit', async (_reason, arrange) => {
    arrange();
    await claimFlowLinkedIntentForDispatch(INTENT_ID);
    expect(h.publishFlowRunTerminalEvent).toHaveBeenCalledTimes(1);
    expect(h.publishFlowRunTerminalEvent).toHaveBeenCalledWith(
      { id: RUN_ID, orgId: ORG_ID, flowId: FLOW_ID, chainDepth: 1 },
      'failed',
    );
    expect(h.order.indexOf('publish:flow.run')).toBeGreaterThan(h.order.indexOf('tx:commit'));
  });

  it.each([
    ['run_cancel_requested', () => h.store.lockRunForClaim.mockResolvedValue(run({ cancelRequestedAt: new Date() }))],
    ['run_not_waiting', () => h.store.lockStepForIntent.mockResolvedValue(null)],
    ['run_terminal', () => h.store.lockRunForClaim.mockResolvedValue(run({ status: 'failed' }))],
  ])('a refusal that does not fail the run (%s) publishes no flow.run event', async (_reason, arrange) => {
    arrange();
    await claimFlowLinkedIntentForDispatch(INTENT_ID);
    expect(h.publishFlowRunTerminalEvent).not.toHaveBeenCalled();
  });

  it('a refusal whose run write lost (already terminal) publishes nothing', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    h.store.terminalizeRunForRefusal.mockResolvedValue(false);
    await claimFlowLinkedIntentForDispatch(INTENT_ID);
    expect(h.publishFlowRunTerminalEvent).not.toHaveBeenCalled();
  });

  it('a lost cancel CAS (the intent moved under the lock — unreachable) writes no run state and publishes nothing', async () => {
    h.assertDelegatorAuthority.mockResolvedValue(false);
    h.store.casIntentApprovedToCancelled.mockResolvedValue(false);
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).resolves.toEqual({ claimed: false, reason: 'lost_race' });
    expect(h.store.terminalizeRunForRefusal).not.toHaveBeenCalled();
    expect(h.publishIntentTerminalOutbox).not.toHaveBeenCalled();
    expect(h.pauseFlow).not.toHaveBeenCalled();
  });

  it('refuses to claim a row that is not flow-originated (caller bug)', async () => {
    h.store.loadIntentForClaim.mockResolvedValue(intent({ requestingFlowRunId: null }));
    await expect(claimFlowLinkedIntentForDispatch(INTENT_ID)).rejects.toThrow(/not flow-originated/);
  });
});
