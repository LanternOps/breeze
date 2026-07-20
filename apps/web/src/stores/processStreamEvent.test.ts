import { describe, it, expect } from 'vitest';
import { processStreamEvent, type StreamableState } from './processStreamEvent';

function makeState(): StreamableState {
  return {
    messages: [], pendingApproval: null, pendingPlan: null, activePlan: null,
    approvalMode: 'per_step', isPaused: false, isStreaming: true,
    error: null, sessionId: 's1', sessions: [],
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
