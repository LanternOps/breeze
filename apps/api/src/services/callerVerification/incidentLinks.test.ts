import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateSet: vi.fn(),
  withSystem: vi.fn(),
  forCalls: [] as string[],
}));

function selectChain(): unknown {
  const result = h.selectQueue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain.for = (mode: string) => {
    h.forCalls.push(mode);
    return chain;
  };
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return chain;
}

vi.mock('../../db', () => ({
  db: {
    select: () => selectChain(),
    update: () => ({
      set: (v: unknown) => {
        h.updateSet(v);
        return { where: async () => undefined };
      },
    }),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => {
    h.withSystem(label);
    return fn();
  },
}));

import { linkCallerIncidentIntents, linkCallerIntentTerminal } from './incidentLinks';

const ORG = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';

const incident = (timeline: unknown[] = []) => ({ id: 'inc-1', orgId: ORG, timeline });

describe('incidentLinks', () => {
  beforeEach(() => {
    h.selectQueue.length = 0;
    h.forCalls.length = 0;
    h.updateSet.mockReset();
    h.withSystem.mockReset();
  });

  it('appends one entry per intent under a row lock', async () => {
    h.selectQueue.push([{ id: 'inc-1' }]); // incident lookup by sourceRef
    h.selectQueue.push([incident()]); // locked incident
    h.selectQueue.push([
      { id: 'i1', status: 'cancelled', dispatchStartedAt: null, errorCode: null },
    ]);

    await linkCallerIncidentIntents(ORG, VID, ['i1']);

    expect(h.forCalls).toEqual(['update']);
    const { timeline } = h.updateSet.mock.calls[0]![0] as { timeline: Array<Record<string, any>> };
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.summary).toBe('Related intent cancelled');
    expect(timeline[0]!.metadata.callerIntentKey).toBe('i1:cancelled');
    expect(timeline[0]!.actor).toBe('system');
  });

  it('uses the confirm-in-Entra wording when dispatch had started', async () => {
    h.selectQueue.push([{ id: 'inc-1' }]);
    h.selectQueue.push([incident()]);
    h.selectQueue.push([
      { id: 'i1', status: 'executing', dispatchStartedAt: new Date('2026-10-17T00:00:00Z'), errorCode: null },
    ]);

    await linkCallerIncidentIntents(ORG, VID, ['i1']);

    const { timeline } = h.updateSet.mock.calls[0]![0] as { timeline: Array<Record<string, any>> };
    expect(timeline[0]!.summary).toBe('Dispatch started before rejection; confirm the outcome in Entra');
    expect(timeline[0]!.metadata.dispatchStartedAt).toBe('2026-10-17T00:00:00.000Z');
  });

  it('is idempotent per intentId:status and appends when the status changes', async () => {
    const existing = {
      at: 'x', type: 'caller_verification.intent', actor: 'system', summary: 's',
      metadata: { callerIntentKey: 'i1:executing', intentId: 'i1' },
    };
    // Same status again -> no write.
    h.selectQueue.push([{ id: 'inc-1' }], [incident([existing])], [
      { id: 'i1', status: 'executing', dispatchStartedAt: null, errorCode: null },
    ]);
    await linkCallerIncidentIntents(ORG, VID, ['i1']);
    expect(h.updateSet).not.toHaveBeenCalled();

    // Terminal status -> appended after the existing entry.
    h.selectQueue.push([{ id: 'inc-1' }], [incident([existing])], [
      { id: 'i1', status: 'completed', dispatchStartedAt: null, errorCode: null },
    ]);
    await linkCallerIncidentIntents(ORG, VID, ['i1']);
    const { timeline } = h.updateSet.mock.calls[0]![0] as { timeline: Array<Record<string, any>> };
    expect(timeline.map((e) => e.metadata.callerIntentKey)).toEqual(['i1:executing', 'i1:completed']);
  });

  it('does nothing without intents or without a matching incident', async () => {
    await linkCallerIncidentIntents(ORG, VID, []);
    h.selectQueue.push([]); // no incident
    await linkCallerIncidentIntents(ORG, VID, ['i1']);
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.forCalls).toEqual([]);
  });

  it('linkCallerIntentTerminal skips intents that are not caller-gated without scanning incidents', async () => {
    h.selectQueue.push([{ orgId: ORG, actionName: 'run_script' }]);
    h.selectQueue.push([{ id: 'inc-1' }]);
    await linkCallerIntentTerminal('i1');
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.selectQueue).toHaveLength(1); // the incident scan never ran
  });

  it('linkCallerIntentTerminal updates every incident already referencing the intent', async () => {
    h.selectQueue.push([{ orgId: ORG, actionName: 'm365_disable_user' }]); // the intent
    h.selectQueue.push([{ id: 'inc-1' }]); // referencing incidents
    h.selectQueue.push([incident()]);
    h.selectQueue.push([{ id: 'i1', status: 'completed', dispatchStartedAt: null, errorCode: null }]);

    await linkCallerIntentTerminal('i1');

    expect(h.withSystem).toHaveBeenCalledWith('callerVerification.incidentLinks');
    expect(h.updateSet).toHaveBeenCalledTimes(1);
  });

  it('linkCallerIntentTerminal is a no-op when no incident references the intent', async () => {
    h.selectQueue.push([{ orgId: ORG, actionName: 'm365_reset_password' }]);
    h.selectQueue.push([]);
    await linkCallerIntentTerminal('i1');
    expect(h.updateSet).not.toHaveBeenCalled();
  });
});
