/**
 * #4442 W04 Task 7 — the release-time schedule brake.
 *
 * Every unresolved lookup must answer "not armed": this is the operator's
 * ordinary way to stop unattended sweep execution that is already authorized
 * but not yet released, so a failed read must never read as permission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectCount: 0,
  ambientContext: undefined as { scope: string } | undefined,
  selectScopes: [] as Array<string | undefined>,
}));

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.selectScopes.push(state.ambientContext?.scope);
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }
  return {
    db: { select: vi.fn(() => selectBuilder()) },
    getCurrentDbAccessContext: vi.fn(() => state.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = state.ambientContext;
      state.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        state.ambientContext = previous;
      }
    }),
  };
});

import { checkSweepScheduleBrake, resolveEffectiveScheduleActMode } from './sweepActMode';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000a9';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a4';

const PRIOR = process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;

beforeEach(() => {
  state.selectQueue = [];
  state.selectCount = 0;
  state.selectScopes = [];
  state.ambientContext = undefined;
  process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
});

afterEach(() => {
  if (PRIOR === undefined) delete process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;
  else process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = PRIOR;
});

describe('resolveEffectiveScheduleActMode', () => {
  it('an armed partner baseline with no org override is ARMED, and both reads run in a system context', async () => {
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([]);

    await expect(resolveEffectiveScheduleActMode(SCHEDULE_ID, ORG_ID)).resolves.toBe(true);
    expect(state.selectScopes).toEqual(['system', 'system']);
  });

  it('an org override with act_mode false disarms an armed baseline', async () => {
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([{ id: 'override-1', actMode: false }]);

    await expect(resolveEffectiveScheduleActMode(SCHEDULE_ID, ORG_ID)).resolves.toBe(false);
  });

  it('an org override CANNOT arm what the partner baseline did not', async () => {
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: null }]);
    state.selectQueue.push([{ id: 'override-1', actMode: true }]);

    await expect(resolveEffectiveScheduleActMode(SCHEDULE_ID, ORG_ID)).resolves.toBe(false);
  });

  it('a DELETED baseline is not armed, and the override is never read', async () => {
    state.selectQueue.push([]);

    await expect(resolveEffectiveScheduleActMode(SCHEDULE_ID, ORG_ID)).resolves.toBe(false);
    expect(state.selectCount).toBe(1);
  });

  it('no schedule id, or the sub-flag off, resolves false without querying at all', async () => {
    await expect(resolveEffectiveScheduleActMode(null, ORG_ID)).resolves.toBe(false);
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';
    await expect(resolveEffectiveScheduleActMode(SCHEDULE_ID, ORG_ID)).resolves.toBe(false);
    expect(state.selectCount).toBe(0);
  });
});

describe('checkSweepScheduleBrake', () => {
  const intent = { requestingAgentRunId: RUN_ID, orgId: ORG_ID };

  it('releases while the schedule is still armed', async () => {
    state.selectQueue.push([{ scheduleId: SCHEDULE_ID, orgId: ORG_ID }]);
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([]);

    await expect(checkSweepScheduleBrake(intent)).resolves.toEqual({ ok: true });
  });

  it('refuses once the partner baseline is turned off between decide and release', async () => {
    state.selectQueue.push([{ scheduleId: SCHEDULE_ID, orgId: ORG_ID }]);
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: false }]);
    state.selectQueue.push([]);

    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });
  });

  it('refuses when the ORG override sets act_mode false', async () => {
    state.selectQueue.push([{ scheduleId: SCHEDULE_ID, orgId: ORG_ID }]);
    state.selectQueue.push([{ id: SCHEDULE_ID, actMode: true }]);
    state.selectQueue.push([{ id: 'override-1', actMode: false }]);

    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });
  });

  it('refuses when the schedule row was DELETED — fail closed, not "no schedule, no objection"', async () => {
    state.selectQueue.push([{ scheduleId: SCHEDULE_ID, orgId: ORG_ID }]);
    state.selectQueue.push([]);

    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });
  });

  it('refuses when the run is gone, carries no schedule, or belongs to another org', async () => {
    state.selectQueue.push([]);
    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });

    state.selectQueue.push([{ scheduleId: null, orgId: ORG_ID }]);
    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });

    state.selectQueue.push([{ scheduleId: SCHEDULE_ID, orgId: OTHER_ORG_ID }]);
    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });
  });

  it('refuses immediately when the sub-flag is off — an operator flipping it must stop an authorized intent', async () => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';

    await expect(checkSweepScheduleBrake(intent)).resolves.toMatchObject({ ok: false });
    expect(state.selectCount).toBe(0);
  });

  it('refuses an intent with no originating run', async () => {
    await expect(checkSweepScheduleBrake({ requestingAgentRunId: null, orgId: ORG_ID }))
      .resolves.toMatchObject({ ok: false });
    expect(state.selectCount).toBe(0);
  });
});
