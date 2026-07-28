import { describe, it, expect } from 'vitest';
import { processStreamEvent, type StreamableState, type ActivePlan } from './processStreamEvent';

function makeState(): StreamableState {
  return {
    messages: [], pendingApproval: null, pendingPlan: null, activePlan: null,
    approvalMode: 'per_step', isPaused: false, isStreaming: true,
    error: null, sessionId: 's1', sessions: [],
  };
}

function makeActivePlan(): ActivePlan {
  return {
    planId: 'plan-1',
    status: 'executing',
    currentStepIndex: 0,
    steps: [
      { toolName: 'file_operations', input: {}, reasoning: 'step 0', status: 'pending' },
      { toolName: 'run_script', input: {}, reasoning: 'step 1', status: 'pending' },
    ],
  };
}

describe('approval_required — selfApprovalRequestId passthrough', () => {
  it('carries selfApprovalRequestId into pendingApproval', () => {
    const state = makeState();
    let patch: Partial<StreamableState> = {};
    processStreamEvent(
      {
        type: 'approval_required', executionId: 'e1', toolName: 'file_operations',
        input: { action: 'read' }, description: 'Read a file',
        intentBacked: true, selfApprovalRequestId: 'ap-1',
      },
      (fn) => { patch = { ...patch, ...fn({ ...state, ...patch }) }; },
      () => ({ ...state, ...patch }),
      null,
    );
    expect(patch.pendingApproval).toMatchObject({
      executionId: 'e1', intentBacked: true, selfApprovalRequestId: 'ap-1',
    });
  });

  it('leaves selfApprovalRequestId undefined when the event omits it (four-eyes)', () => {
    // The store-layer half of the four-eyes property: in a multi-approver org
    // the server sends no selfApprovalRequestId, and nothing here may invent
    // one — AiApprovalDialog keys its self-approve buttons off exactly this
    // field, so an accidental default would hand a requester the ability to
    // approve their own Tier-3 action.
    const state = makeState();
    let patch: Partial<StreamableState> = {};
    processStreamEvent(
      {
        type: 'approval_required', executionId: 'e1', toolName: 'file_operations',
        input: { action: 'read' }, description: 'Read a file',
        intentBacked: true,
      },
      (fn) => { patch = { ...patch, ...fn({ ...state, ...patch }) }; },
      () => ({ ...state, ...patch }),
      null,
    );
    expect(patch.pendingApproval).toMatchObject({ executionId: 'e1', intentBacked: true });
    expect(patch.pendingApproval?.selfApprovalRequestId).toBeUndefined();
  });
});

describe('plan-mode step sequencing under approval-gated ordering', () => {
  // API sequence for an approval-gated step is now:
  //   approval_required -> (possibly multi-minute wait) -> plan_step_start -> execute -> plan_step_complete
  // or, on deny/timeout/failure:
  //   plan_complete { status: 'aborted' } with NO plan_step_start/plan_step_complete ever firing
  // for that step. These tests pin the properties of processStreamEvent that make that
  // ordering safe to render.

  it('plan_step_start is an absolute assignment of currentStepIndex, not an increment', () => {
    const state = { ...makeState(), activePlan: makeActivePlan() };
    let patch: Partial<StreamableState> = {};
    const set: Parameters<typeof processStreamEvent>[1] = (fn) => {
      patch = { ...patch, ...fn({ ...state, ...patch }) };
    };
    const get = () => ({ ...state, ...patch });

    processStreamEvent(
      { type: 'plan_step_start', planId: 'plan-1', stepIndex: 0, toolName: 'file_operations' },
      set, get, null,
    );
    expect(patch.activePlan?.currentStepIndex).toBe(0);

    // Dispatch the SAME event again (e.g. a duplicate/late delivery). If this were
    // an increment instead of an absolute assignment, the index would drift to 1
    // even though no new step has actually started.
    processStreamEvent(
      { type: 'plan_step_start', planId: 'plan-1', stepIndex: 0, toolName: 'file_operations' },
      set, get, null,
    );
    expect(patch.activePlan?.currentStepIndex).toBe(0);
  });

  it('plan_step_complete sets step status and advances currentStepIndex to stepIndex + 1', () => {
    const state = { ...makeState(), activePlan: makeActivePlan() };
    let patch: Partial<StreamableState> = {};
    const set: Parameters<typeof processStreamEvent>[1] = (fn) => {
      patch = { ...patch, ...fn({ ...state, ...patch }) };
    };
    const get = () => ({ ...state, ...patch });

    processStreamEvent(
      { type: 'plan_step_complete', planId: 'plan-1', stepIndex: 0, toolName: 'file_operations', isError: false },
      set, get, null,
    );

    expect(patch.activePlan?.steps[0]?.status).toBe('completed');
    // currentStepIndex must already point at the next (awaiting-approval) step
    // before any plan_step_start for it has arrived.
    expect(patch.activePlan?.currentStepIndex).toBe(1);
  });

  it('a plan_step_start that never arrives is inert — currentStepIndex already reflects the next step', () => {
    const state = { ...makeState(), activePlan: makeActivePlan() };
    let patch: Partial<StreamableState> = {};
    const set: Parameters<typeof processStreamEvent>[1] = (fn) => {
      patch = { ...patch, ...fn({ ...state, ...patch }) };
    };
    const get = () => ({ ...state, ...patch });

    processStreamEvent(
      { type: 'plan_step_complete', planId: 'plan-1', stepIndex: 0, toolName: 'file_operations', isError: false },
      set, get, null,
    );

    // No plan_step_start was ever dispatched for step 1 — the index must already
    // be correct without it.
    expect(patch.activePlan?.currentStepIndex).toBe(1);
  });

  it('plan_complete aborted sets activePlan.status to aborted and leaves an unstarted step pending', () => {
    const state = { ...makeState(), activePlan: makeActivePlan() };
    let patch: Partial<StreamableState> = {};
    const set: Parameters<typeof processStreamEvent>[1] = (fn) => {
      patch = { ...patch, ...fn({ ...state, ...patch }) };
    };
    const get = () => ({ ...state, ...patch });

    // Step 0 never got plan_step_start/plan_step_complete — approval was
    // denied/timed out/failed, so the API jumps straight to plan_complete.
    processStreamEvent(
      { type: 'plan_complete', planId: 'plan-1', status: 'aborted' },
      set, get, null,
    );

    expect(patch.activePlan?.status).toBe('aborted');
    expect(patch.activePlan?.status).not.toBe('completed');
    // The step that never ran must retain its seeded pending status — it must
    // not be marked completed or failed just because the plan ended.
    expect(patch.activePlan?.steps[0]?.status).toBe('pending');
  });

  it('approval_required populates pendingApproval while activePlan.status stays executing', () => {
    const state = { ...makeState(), activePlan: makeActivePlan() };
    let patch: Partial<StreamableState> = {};
    const set: Parameters<typeof processStreamEvent>[1] = (fn) => {
      patch = { ...patch, ...fn({ ...state, ...patch }) };
    };
    const get = () => ({ ...state, ...patch });

    processStreamEvent(
      {
        type: 'approval_required', executionId: 'e1', toolName: 'file_operations',
        input: { action: 'read' }, description: 'Read a file',
      },
      set, get, null,
    );

    // The two must coexist: pendingApproval renders the "awaiting approval" UI
    // while activePlan is still 'executing' rather than looking stalled.
    expect(patch.pendingApproval).toMatchObject({ executionId: 'e1' });
    expect(get().activePlan?.status).toBe('executing');
  });
});
