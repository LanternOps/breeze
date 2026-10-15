import { describe, expect, it } from 'vitest';

import {
  applyPlanEvent,
  applyPlanToolResult,
  formatPlanToolName,
  isPlanTool,
  parsePlanSteps,
  planCardAction,
  planDecided,
  planDecisionFailure,
  planDecisionFromToolOutput,
  planGone,
  planStatusCaption,
  proposedPlan,
  type ChatPlan,
} from './planState';

const STEPS = [
  { toolName: 'manage_services', input: { action: 'restart', name: 'Spooler' }, reasoning: 'Restart the spooler', status: 'pending' },
  { toolName: 'run_script', input: { scriptId: 's1' }, reasoning: 'Clear the queue', status: 'pending' },
];

function awaiting(overrides: Partial<ChatPlan> = {}): ChatPlan {
  return {
    toolUseId: 'tu-1',
    planId: 'plan-1',
    title: null,
    steps: parsePlanSteps(STEPS),
    status: 'awaiting',
    ...overrides,
  };
}

describe('isPlanTool', () => {
  it('matches the bare and MCP-prefixed plan tool name only', () => {
    expect(isPlanTool('propose_action_plan')).toBe(true);
    expect(isPlanTool('mcp__breeze__propose_action_plan')).toBe(true);
    expect(isPlanTool('run_script')).toBe(false);
    expect(isPlanTool('propose_action_plan_v2')).toBe(false);
    expect(isPlanTool(null)).toBe(false);
    expect(isPlanTool(undefined)).toBe(false);
  });
});

describe('parsePlanSteps', () => {
  it('keeps the tool name and reasoning, and starts every step pending', () => {
    expect(parsePlanSteps(STEPS)).toEqual([
      { toolName: 'manage_services', reasoning: 'Restart the spooler', status: 'pending' },
      { toolName: 'run_script', reasoning: 'Clear the queue', status: 'pending' },
    ]);
  });

  it('drops malformed entries and tolerates non-arrays', () => {
    expect(parsePlanSteps([null, 3, { reasoning: 'no tool' }, { toolName: 'x' }])).toEqual([
      { toolName: 'x', reasoning: '', status: 'pending' },
    ]);
    expect(parsePlanSteps(undefined)).toEqual([]);
    expect(parsePlanSteps({ toolName: 'x' })).toEqual([]);
  });

  it('caps at the server maximum of 20 steps', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ toolName: `t${i}`, reasoning: '' }));
    expect(parsePlanSteps(many)).toHaveLength(20);
  });
});

describe('proposedPlan', () => {
  it('reads the title and steps from the tool input', () => {
    expect(proposedPlan('tu-1', { title: 'Fix printing', steps: STEPS })).toEqual({
      toolUseId: 'tu-1',
      planId: null,
      title: 'Fix printing',
      steps: parsePlanSteps(STEPS),
      status: 'awaiting',
    });
  });

  it('builds an empty awaiting stub when the input is missing (live tool_use_start sends {})', () => {
    expect(proposedPlan('tu-1', undefined)).toEqual({
      toolUseId: 'tu-1',
      planId: null,
      title: null,
      steps: [],
      status: 'awaiting',
    });
  });
});

describe('applyPlanEvent', () => {
  it('plan_approval_required fills planId and steps on the stub, keeping its toolUseId', () => {
    const next = applyPlanEvent(proposedPlan('tu-1', undefined), {
      type: 'plan_approval_required',
      planId: 'plan-1',
      steps: STEPS,
    });
    expect(next).toEqual(awaiting());
  });

  it('plan_approval_required with no stub creates the plan', () => {
    expect(
      applyPlanEvent(undefined, { type: 'plan_approval_required', planId: 'plan-1', steps: STEPS }),
    ).toEqual(awaiting({ toolUseId: null }));
  });

  it('step events advance the matching plan to executing and mark steps', () => {
    let plan: ChatPlan | undefined = planDecided(awaiting(), 'approved');
    plan = applyPlanEvent(plan, { type: 'plan_step_start', planId: 'plan-1', stepIndex: 0 });
    expect(plan?.status).toBe('executing');
    expect(plan?.steps[0]?.status).toBe('running');
    plan = applyPlanEvent(plan, { type: 'plan_step_complete', planId: 'plan-1', stepIndex: 0, isError: false });
    expect(plan?.steps[0]?.status).toBe('completed');
    plan = applyPlanEvent(plan, { type: 'plan_step_start', planId: 'plan-1', stepIndex: 1 });
    plan = applyPlanEvent(plan, { type: 'plan_step_complete', planId: 'plan-1', stepIndex: 1, isError: true });
    expect(plan?.steps[1]?.status).toBe('failed');
    plan = applyPlanEvent(plan, { type: 'plan_complete', planId: 'plan-1', status: 'completed' });
    expect(plan?.status).toBe('completed');
  });

  it('ignores step events for a different plan, out-of-range indexes and a missing plan', () => {
    const plan = planDecided(awaiting(), 'approved');
    expect(applyPlanEvent(plan, { type: 'plan_step_start', planId: 'other', stepIndex: 0 })).toBe(plan);
    expect(applyPlanEvent(plan, { type: 'plan_step_start', planId: 'plan-1', stepIndex: 9 })).toEqual(
      { ...plan, status: 'executing' },
    );
    expect(applyPlanEvent(undefined, { type: 'plan_complete', planId: 'plan-1', status: 'aborted' })).toBeUndefined();
  });

  it('a step event never revives a plan the user rejected', () => {
    const rejected = planDecided(awaiting(), 'rejected');
    expect(applyPlanEvent(rejected, { type: 'plan_step_start', planId: 'plan-1', stepIndex: 0 })).toBe(rejected);
  });

  it('plan_complete aborted marks the plan aborted', () => {
    const plan = applyPlanEvent(planDecided(awaiting(), 'approved'), {
      type: 'plan_complete',
      planId: 'plan-1',
      status: 'aborted',
    });
    expect(plan?.status).toBe('aborted');
  });

  it('a repeated plan_approval_required does not regress a decided plan', () => {
    const executing = planDecided(awaiting(), 'approved');
    expect(
      applyPlanEvent(executing, { type: 'plan_approval_required', planId: 'plan-1', steps: STEPS })?.status,
    ).toBe('executing');
  });
});

describe('planDecided / planGone', () => {
  it('approve moves an awaiting plan to executing; reject to rejected', () => {
    expect(planDecided(awaiting(), 'approved').status).toBe('executing');
    expect(planDecided(awaiting(), 'rejected').status).toBe('rejected');
  });

  it('only an awaiting plan takes a decision', () => {
    const done = { ...awaiting(), status: 'completed' as const };
    expect(planDecided(done, 'rejected')).toBe(done);
  });

  it('planGone expires an awaiting plan and leaves others alone', () => {
    expect(planGone(awaiting()).status).toBe('expired');
    const executing = planDecided(awaiting(), 'approved');
    expect(planGone(executing)).toBe(executing);
  });
});

describe('planDecisionFromToolOutput', () => {
  it('reads the tool result object', () => {
    expect(planDecisionFromToolOutput({ result: 'approved', planId: 'p' })).toBe('approved');
    expect(planDecisionFromToolOutput({ result: 'rejected' })).toBe('rejected');
  });

  it('reads a JSON string result and the dropped-call fallback error wrapper', () => {
    expect(planDecisionFromToolOutput('{"result":"approved"}')).toBe('approved');
    expect(
      planDecisionFromToolOutput({ error: '{"result":"rejected","message":"x"}', droppedBeforeExecution: true }),
    ).toBe('rejected');
  });

  it('returns null for anything else', () => {
    expect(planDecisionFromToolOutput({ error: 'No active session' })).toBeNull();
    expect(planDecisionFromToolOutput(undefined)).toBeNull();
    expect(planDecisionFromToolOutput('not json')).toBeNull();
    expect(planDecisionFromToolOutput({ result: 'maybe' })).toBeNull();
  });
});

describe('applyPlanToolResult', () => {
  it('settles an awaiting plan from the persisted decision (history replay)', () => {
    expect(applyPlanToolResult(awaiting(), { result: 'approved' }).status).toBe('approved');
    expect(applyPlanToolResult(awaiting(), { result: 'rejected' }).status).toBe('rejected');
  });

  it('expires an awaiting plan whose tool finished without a decision', () => {
    expect(applyPlanToolResult(awaiting(), { error: 'Failed to create action plan' }).status).toBe('expired');
  });

  it('does not regress a plan the live stream already moved past awaiting', () => {
    const executing = planDecided(awaiting(), 'approved');
    expect(applyPlanToolResult(executing, { result: 'approved' })).toBe(executing);
  });
});

describe('planCardAction', () => {
  it('offers approve/reject only on a live awaiting plan that has steps', () => {
    expect(planCardAction(awaiting(), true)).toBe('decide');
    expect(planCardAction(awaiting(), false)).toBe('none');
    expect(planCardAction(awaiting({ steps: [] }), true)).toBe('none');
  });

  it('offers stop only on a live executing plan', () => {
    const executing = planDecided(awaiting(), 'approved');
    expect(planCardAction(executing, true)).toBe('stop');
    expect(planCardAction(executing, false)).toBe('none');
  });

  it('offers nothing once the plan is settled', () => {
    for (const status of ['approved', 'completed', 'aborted', 'rejected', 'expired'] as const) {
      expect(planCardAction(awaiting({ status }), true)).toBe('none');
    }
  });
});

describe('planStatusCaption', () => {
  it('describes each state', () => {
    expect(planStatusCaption(awaiting({ steps: [] }), true)).toBe('Preparing plan');
    expect(planStatusCaption(awaiting(), true)).toBe('Waiting for your approval');
    expect(planStatusCaption(awaiting(), false)).toBe('No decision recorded');
    expect(planStatusCaption(awaiting({ status: 'approved' }), false)).toBe('Approved');
    expect(planStatusCaption(awaiting({ status: 'executing' }), true)).toBe('Running');
    expect(planStatusCaption(awaiting({ status: 'completed' }), false)).toBe('Completed');
    expect(planStatusCaption(awaiting({ status: 'aborted' }), false)).toBe('Stopped');
    expect(planStatusCaption(awaiting({ status: 'rejected' }), false)).toBe('Rejected');
    expect(planStatusCaption(awaiting({ status: 'expired' }), false)).toBe('No longer waiting for approval');
  });
});

describe('planDecisionFailure', () => {
  it('treats not-pending / not-active / conflict as the plan being gone', () => {
    expect(planDecisionFailure(400)).toBe('gone');
    expect(planDecisionFailure(404)).toBe('gone');
    expect(planDecisionFailure(409)).toBe('gone');
  });

  it('treats everything else as retryable', () => {
    expect(planDecisionFailure(500)).toBe('retry');
    expect(planDecisionFailure(0)).toBe('retry');
    expect(planDecisionFailure(401)).toBe('retry');
  });
});

describe('formatPlanToolName', () => {
  it('strips the MCP prefix and reads as a sentence', () => {
    expect(formatPlanToolName('mcp__breeze__manage_services')).toBe('Manage services');
    expect(formatPlanToolName('run_script')).toBe('Run script');
    expect(formatPlanToolName('')).toBe('Step');
  });
});
