/**
 * The task fence inside `createAgentRunPreToolUse` (#5205 W06, spec §7.3).
 *
 * `taskFence.test.ts` proves the PREDICATE. This file proves the WIRING: that
 * the pre-tool hook actually consults it on every call, refuses when it says
 * so, fails CLOSED when the read itself fails, and leaves a legacy run
 * completely untouched.
 *
 * Its own file rather than more cases in `runLoop.test.ts` (2.4k lines) or
 * `redTeam.contract.test.ts`: the fence returns BEFORE `checkAgentGuardrails`
 * and before the outcome-tool branch, so it needs almost none of those
 * suites' harness — one module mock and the same minimal db/permissions stubs.
 *
 * WHY FAIL-CLOSED IS A TEST AND NOT A COMMENT. `loadTaskFence` reads the
 * database on the model's critical path. A transient failure there is
 * ordinary. If that path failed OPEN, then a database blip during a
 * cancellation would let a task the operator believes they stopped keep
 * executing effects — and, worse, the blip is exactly when nobody is watching.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { AgentRunOutcome } from './runLoopTypes';

const ORG_ID = '00000000-0000-4000-8000-00000000f001';
const AGENT_ID = '00000000-0000-4000-8000-00000000f002';
const RUN_ID = '00000000-0000-4000-8000-00000000f003';
const TASK_ID = '00000000-0000-4000-8000-00000000f004';
const DEVICE_ID = '00000000-0000-4000-8000-00000000f005';

const loadTaskFence = vi.hoisted(() => vi.fn());
vi.mock('../aiOperator/taskService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadTaskFence,
}));

// The fence returns before any of these are reached on a fenced call; they
// exist so the module graph loads and so the UNFENCED control can proceed far
// enough to prove the fence let it through.
vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    },
    withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
    runOutsideDbContext: async (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  };
});

vi.mock('../permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => null) };
});

import { createAgentRunPreToolUse } from './runLoop';

function makeOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

function makeHook(args: {
  taskId: string | null;
  outcome: AgentRunOutcome;
}) {
  return createAgentRunPreToolUse({
    run: {
      id: RUN_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      profile: 'full',
      taskId: args.taskId,
      taskStepKey: args.taskId ? 'investigate' : null,
      taskAttemptOrdinal: args.taskId ? 0 : null,
    },
    agentName: 'Operator',
    agentAuth: { user: { id: AGENT_ID } } as unknown as AuthContext,
    agentKind: 'triage',
    guardrailPolicy: {
      enabled: true,
      mode: 'shadow',
      toolAllowlist: [],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: DEVICE_ID,
    } as never,
    outcome: args.outcome,
    intentIds: [],
    allowedPending: new Map(),
    sessionId: null,
    executionIdPending: new Map(),
    actPinPending: new Map(),
    actReservation: { count: 0 },
    deadlineMs: Date.now() + 600_000,
  });
}


/** Narrows the pre-hook's union to the denied arm, failing loudly if it
 *  allowed — `expect(result.allowed).toBe(false)` alone does not narrow, and
 *  a non-narrowing cast would hide a genuine "it allowed the call" regression
 *  behind a TypeError. */
function denied(
  result: Awaited<ReturnType<ReturnType<typeof createAgentRunPreToolUse>>>,
): { allowed: false; error: string } {
  if (result.allowed) {
    throw new Error('expected the pre-tool hook to DENY the call, but it allowed it');
  }
  return result;
}

const CLEAR_FENCE = {
  state: 'running',
  revision: 3,
  leaseEpoch: 1,
  deadlineAt: new Date(Date.now() + 600_000),
  targetDetachedAt: null,
  fenced: false,
};

beforeEach(() => {
  loadTaskFence.mockReset();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});

describe('task fence in createAgentRunPreToolUse', () => {
  it('denies every tool call when the task is fenced', async () => {
    const outcome = makeOutcome();
    loadTaskFence.mockResolvedValue({ ...CLEAR_FENCE, state: 'stopping', fenced: true });
    const pre = makeHook({ taskId: TASK_ID, outcome });

    const result = denied(await pre('query_devices', {}));

    expect(result.error).toMatch(/fenced/i);
    expect(result.error).toMatch(/do not retry/i);
    expect(outcome.deniedActions).toHaveLength(1);
    expect(outcome.deniedActions[0]!.reason).toContain('stopping');
  });

  it('denies an OUTCOME tool too — a fenced task must not record a checkpoint either', async () => {
    // The fence sits AHEAD of the outcome-tool branch on purpose:
    // `submit_task_step` is the one call whose result would otherwise be
    // persisted into a checkpoint the task must no longer accept.
    const outcome = makeOutcome();
    loadTaskFence.mockResolvedValue({ ...CLEAR_FENCE, state: 'cancelled', fenced: true });
    const pre = makeHook({ taskId: TASK_ID, outcome });

    const result = denied(await pre('submit_task_step', {
      version: 1, findings: [], nextStep: { kind: 'handoff', reason: 'x', summary: 'y' },
    }));

    expect(result.error).toMatch(/fenced/i);
  });

  it('FAILS CLOSED when the fence read itself rejects', async () => {
    const outcome = makeOutcome();
    loadTaskFence.mockRejectedValue(new Error('connection terminated'));
    const pre = makeHook({ taskId: TASK_ID, outcome });

    const result = denied(await pre('query_devices', {}));

    expect(result.error).toMatch(/could not be read/i);
    expect(outcome.deniedActions).toHaveLength(1);
  });

  it('FAILS CLOSED when the task row is missing entirely', async () => {
    // An erased or never-committed task is not permission either.
    const outcome = makeOutcome();
    loadTaskFence.mockResolvedValue(null);
    const pre = makeHook({ taskId: TASK_ID, outcome });

    const result = denied(await pre('query_devices', {}));

    expect(result.error).toMatch(/could not be read/i);
  });

  it('consults the fence on EVERY call, not once per run', async () => {
    // A task cancelled between turn 3 and turn 4 has to be caught at turn 4.
    // Caching the first read would defeat the entire mechanism.
    const outcome = makeOutcome();
    loadTaskFence
      .mockResolvedValueOnce(CLEAR_FENCE)
      .mockResolvedValueOnce(CLEAR_FENCE)
      .mockResolvedValueOnce({ ...CLEAR_FENCE, state: 'stopping', fenced: true });
    const pre = makeHook({ taskId: TASK_ID, outcome });

    await pre('query_devices', {});
    await pre('query_devices', {});
    const third = await pre('query_devices', {});

    expect(loadTaskFence).toHaveBeenCalledTimes(3);
    expect(third.allowed).toBe(false);
  });

  it('does not consult the fence at all for a legacy (non-task) run', async () => {
    // The fence is scoped by `run.taskId`. A legacy run paying for a DB read
    // on every tool call would be a real regression for every existing agent.
    const outcome = makeOutcome();
    const pre = makeHook({ taskId: null, outcome });

    await pre('query_devices', {}).catch(() => undefined);

    expect(loadTaskFence).not.toHaveBeenCalled();
  });

  it('lets an unfenced task proceed past the fence', async () => {
    // The control. Without it, every assertion above would pass just as
    // happily against a fence that denied unconditionally.
    const outcome = makeOutcome();
    loadTaskFence.mockResolvedValue(CLEAR_FENCE);
    const pre = makeHook({ taskId: TASK_ID, outcome });

    const result = await pre('query_devices', {});

    expect(loadTaskFence).toHaveBeenCalledWith(ORG_ID, TASK_ID);
    // It may still be denied further down (the allowlist is empty here) — what
    // matters is that the refusal is NOT the fence's.
    if (!result.allowed) {
      expect(result.error).not.toMatch(/fenced|could not be read/i);
    }
  });
});
