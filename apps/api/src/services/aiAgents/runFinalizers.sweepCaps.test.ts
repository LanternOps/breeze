/**
 * #4442 W05 review fix — `finalizeSweep` threads THREE caps out of the run's
 * stored policy snapshot into `persistSweepFindings`, each with a `??`
 * fallback for a pre-v13 snapshot that predates them.
 *
 * All three are plain `number`s, so a swapped field (e.g.
 * `maxPolicyDecisionsPerDay` accidentally sourced from
 * `maxFleetPercentPerDay`) type-checks cleanly and silently changes a safety
 * cap. Nothing else covers this seam: the integration suite calls
 * `persistSweepFindings` directly, and `runLoop.sweep.test.ts` deliberately
 * defers per-gate behaviour to `sweepFindings.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';

const state = vi.hoisted(() => ({
  runStatus: 'running' as string,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const builder: Record<string, unknown> = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => Promise.resolve([{ status: state.runStatus }])),
      };
      return builder;
    }),
  },
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const persistSweepFindings = vi.hoisted(() =>
  vi.fn(async () => ({ proposals: [], intentIds: [] as string[] })));
vi.mock('./sweepFindings', () => ({ persistSweepFindings }));

vi.mock('./sweepEvidence', () => ({ indexEvidenceSubjects: vi.fn(() => new Map()) }));
vi.mock('./sweepProfile', () => ({ isSweepProfile: vi.fn(() => true) }));

const { finalizeSweep } = await import('./runFinalizers');

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';

function ctxWith(limits: Record<string, number>) {
  return {
    run: {
      id: RUN_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      scheduleId: null,
      policySnapshot: { effective: { toolAllowlist: ['manage_services'], limits } },
    },
    sweep: { evidence: { kinds: {}, truncated: false } },
  } as never;
}

function resultWith() {
  return {
    outcome: { sweepFindings: { summary: 's', findings: [] } } as Record<string, unknown>,
    intentIds: [] as string[],
    agentAuth: {} as never,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.runStatus = 'running';
});

describe('finalizeSweep — the W05 cap wiring (#4442)', () => {
  it('threads each cap from its OWN snapshot field, never a sibling', async () => {
    // Deliberately distinct values: a swapped field would surface as the
    // wrong number rather than as a coincidental match.
    await finalizeSweep(ctxWith({
      maxActionsPerRun: 7,
      maxFleetPercentPerDay: 11,
      maxPolicyDecisionsPerDay: 23,
      maxUnattendedDevicesPerSweep: 5,
    }), resultWith());

    expect(persistSweepFindings).toHaveBeenCalledTimes(1);
    const [runInput] = (persistSweepFindings.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]!;
    expect(runInput).toMatchObject({
      maxActionsPerRun: 7,
      maxFleetPercentPerDay: 11,
      maxPolicyDecisionsPerDay: 23,
      maxUnattendedDevicesPerSweep: 5,
    });
  });

  it('falls back to AI_AGENT_LIMIT_DEFAULTS for a pre-v13 snapshot that lacks the W05 keys', async () => {
    await finalizeSweep(ctxWith({
      maxActionsPerRun: 3,
      maxFleetPercentPerDay: 5,
      maxPolicyDecisionsPerDay: 10,
      // no maxUnattendedDevicesPerSweep — a v12 in-flight run
    }), resultWith());

    const [runInput] = (persistSweepFindings.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]!;
    expect(runInput.maxUnattendedDevicesPerSweep)
      .toBe(AI_AGENT_LIMIT_DEFAULTS.maxUnattendedDevicesPerSweep);
  });

  it('persists nothing when the run has already left `running`', async () => {
    state.runStatus = 'cancelled';

    await finalizeSweep(ctxWith({ maxActionsPerRun: 3 }), resultWith());

    expect(persistSweepFindings).not.toHaveBeenCalled();
  });
});
