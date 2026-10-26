import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BreezeEvent } from '../eventBus';

/**
 * Tool catalog W04 (#5219), plan Task A9 — the durable event trigger.
 * The candidate-flow read is a fake select queue; run creation and the
 * trigger scope are mocked. The owner predicate against real rows is
 * flowTriggers.integration.test.ts.
 */

const { selects, selectCalls } = vi.hoisted(() => ({
  selects: [] as unknown[],
  selectCalls: [] as Array<Array<{ op: string; args: unknown[] }>>,
}));

vi.mock('../../db', () => {
  function chain() {
    const ops: Array<{ op: string; args: unknown[] }> = [];
    selectCalls.push(ops);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = selects.shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        return (...args: unknown[]) => { ops.push({ op: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  }
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  flowsEnabled: vi.fn(() => true),
}));
vi.mock('./runService', () => ({ createFlowRun: vi.fn() }));
vi.mock('./triggerScope', () => ({ buildTriggerScope: vi.fn() }));
vi.mock('./flowTriggerMetrics', () => ({
  recordFlowChainDepthRefused: vi.fn(), recordFlowScheduleAdmissionRefused: vi.fn(), recordFlowEventAdmissionRefused: vi.fn(),
}));

import { flowsEnabled } from '../../config/env';
import { createFlowRun } from './runService';
import { buildTriggerScope } from './triggerScope';
import { recordFlowChainDepthRefused, recordFlowEventAdmissionRefused } from './flowTriggerMetrics';
import { eventMatchesFilter, flowEventTriggerSubscriber } from './eventTrigger';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW_A = '33333333-3333-4333-8333-333333333333';
const FLOW_B = '33333333-3333-4333-8333-444444444444';
const RUN_X = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
/** The org-owned-flow liveness read (organizations: active/trial, not deleted) — the event's org is live. */
const LIVE = [{ id: ORG }];

function event(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: EVENT_ID, type: 'alert.triggered', orgId: ORG, source: 'test', priority: 'normal',
    payload: { severity: 'critical', alert: { ruleId: 'r1' } },
    metadata: { timestamp: '2026-10-25T10:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}
function candidate(over: Record<string, unknown> = {}) {
  return {
    id: FLOW_A, orgId: ORG, partnerId: null,
    trigger: { type: 'event', event: 'alert.triggered', filter: { severity: 'critical' } },
    inputs: [{ name: 'note', type: 'string', required: false }],
    ...over,
  };
}
const handle = (e: BreezeEvent) => flowEventTriggerSubscriber.handler(e);

/** Every bound value in a drizzle where clause. */
function sqlValues(v: unknown, out: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (v === null || v === undefined) return out;
  if (typeof v !== 'object') { out.push(v); return out; }
  if (seen.has(v as object)) return out;
  seen.add(v as object);
  const name = (v as { constructor?: { name?: string } }).constructor?.name;
  if (name === 'StringChunk') return out;
  if (name === 'Param') { out.push((v as { value: unknown }).value); return out; }
  if (Array.isArray(v)) { for (const c of v) sqlValues(c, out, seen); return out; }
  const chunks = (v as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) sqlValues(c, out, seen);
  return out;
}

beforeEach(() => {
  selects.length = 0;
  selectCalls.length = 0;
  vi.mocked(flowsEnabled).mockReset().mockReturnValue(true);
  vi.mocked(createFlowRun).mockReset().mockResolvedValue({ created: true, runId: RUN_X, preApprovalsHonored: true });
  vi.mocked(buildTriggerScope).mockReset().mockImplementation(async ({ kind, orgId, event: e }) => ({
    kind, orgId, firedAt: '2026-10-25T10:00:00.000Z', event: { id: e!.id, type: e!.type }, payload: e!.payload as never,
  }));
  vi.mocked(recordFlowChainDepthRefused).mockReset();
  vi.mocked(recordFlowEventAdmissionRefused).mockReset();
});

describe('flowEventTriggerSubscriber', () => {
  it('is the durable subscriber the enable gate looks for', () => {
    expect(flowEventTriggerSubscriber.id).toBe('flow-event-trigger');
    expect(flowEventTriggerSubscriber.eventTypes).toBe('*');
    expect(flowEventTriggerSubscriber.retry).toEqual({ attempts: 5, backoffMs: 30_000 });
  });

  it('matching filter creates a run', async () => {
    selects.push([candidate()], LIVE);
    await handle(event());
    expect(createFlowRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).toEqual({
      triggerKind: 'event', flowId: FLOW_A, orgId: ORG, dedupeKey: `event:${EVENT_ID}`, chainDepth: 0, causedByRunId: null,
      inputs: { note: null },
      scope: { firedAt: '2026-10-25T10:00:00.000Z', event: { id: EVENT_ID, type: 'alert.triggered' }, payload: event().payload },
    });
    expect(buildTriggerScope).toHaveBeenCalledWith({ kind: 'event', orgId: ORG, event: event() });
  });

  it('non-matching filter creates none', async () => {
    selects.push([candidate({ trigger: { type: 'event', event: 'alert.triggered', filter: { severity: 'low' } } })]);
    await handle(event());
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(buildTriggerScope).not.toHaveBeenCalled();
  });

  it('partner-wide flow matches events of its partner\'s orgs only', async () => {
    selects.push([candidate({ orgId: null, partnerId: PARTNER })]);
    await handle(event());
    // The owner predicate is in the candidate read: the event's own org, or a
    // partner-wide flow of the event org's partner (resolved in SQL from
    // organizations — never from the event).
    const where = selectCalls[0]!.find((o) => o.op === 'where')!.args[0];
    const values = sqlValues(where);
    expect(values).toContain(ORG);
    expect(values).toContain('alert.triggered');
    expect(values).not.toContain(PARTNER);
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).toMatchObject({ flowId: FLOW_A, orgId: ORG });
  });

  it('partner-wide flows only match events from orgs the schedule fan-out would reach (one shared predicate)', async () => {
    selects.push([]);
    await handle(event());
    // The candidate read (and its organizations subquery): every where clause built.
    const values = selectCalls.flatMap((ops) => ops.filter((o) => o.op === 'where').flatMap((o) => sqlValues(o.args[0])));
    expect(values).toContain(ORG);
    // loadPartnerOrgIds' live-org rule: not quick_support, not the holding
    // (unassigned_pool) org, not deleted, status active/trial.
    expect(values).toEqual(expect.arrayContaining(['quick_support', 'unassigned_pool', 'active', 'trial']));
  });

  it('redelivered event creates no second run', async () => {
    selects.push([candidate()], LIVE, [candidate()], LIVE);
    vi.mocked(createFlowRun)
      .mockResolvedValueOnce({ created: true, runId: RUN_X, preApprovalsHonored: true })
      .mockResolvedValueOnce({ created: false, reason: 'duplicate', runId: RUN_X, preApprovalsHonored: true });
    await handle(event());
    await expect(handle(event())).resolves.toBeUndefined();
    const keys = vi.mocked(createFlowRun).mock.calls.map(([i]) => i.dedupeKey);
    expect(keys).toEqual([`event:${EVENT_ID}`, `event:${EVENT_ID}`]);
  });

  it('own flow.run event is ignored', async () => {
    selects.push(
      [candidate({ trigger: { type: 'event', event: 'flow.run.completed', filter: {} } })],
      [{ flowId: FLOW_A, chainDepth: 0 }],
    );
    await handle(event({
      type: 'flow.run.completed' as BreezeEvent['type'],
      payload: { flowId: FLOW_A, runId: RUN_X, chainDepth: 0, status: 'completed' },
      metadata: { timestamp: '2026-10-25T10:00:00.000Z', flowRunId: RUN_X, flowChainDepth: 0 },
    }));
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('another flow listening for flow.run.* inherits depth + 1 from the payload when metadata is absent', async () => {
    selects.push(
      [candidate({ id: FLOW_B, trigger: { type: 'event', event: 'flow.run.failed', filter: { status: 'failed' } } })],
      [{ flowId: FLOW_A, chainDepth: 1 }],
      LIVE,
    );
    await handle(event({
      type: 'flow.run.failed' as BreezeEvent['type'],
      payload: { flowId: FLOW_A, runId: RUN_X, chainDepth: 1, status: 'failed' },
      metadata: { timestamp: '2026-10-25T10:00:00.000Z' },
    }));
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).toMatchObject({ flowId: FLOW_B, chainDepth: 2, causedByRunId: RUN_X });
  });

  it('chain depth 4 is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selects.push([candidate({ id: FLOW_B })], [{ flowId: FLOW_A, chainDepth: 3 }]);
    await handle(event({ metadata: { timestamp: '2026-10-25T10:00:00.000Z', flowRunId: RUN_X, flowChainDepth: 3 } }));
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(recordFlowChainDepthRefused).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('alert event published by a flow step inherits its depth', async () => {
    selects.push([candidate({ id: FLOW_B, trigger: { type: 'event', event: 'alert.resolved', filter: {} } })], [{ flowId: FLOW_A, chainDepth: 1 }], LIVE);
    await handle(event({
      type: 'alert.resolved',
      metadata: { timestamp: '2026-10-25T10:00:00.000Z', flowRunId: RUN_X, flowChainDepth: 1 },
    }));
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).toMatchObject({ flowId: FLOW_B, chainDepth: 2, causedByRunId: RUN_X });
  });

  it('event from the flow\'s own run is ignored whatever its type', async () => {
    selects.push([candidate({ trigger: { type: 'event', event: 'alert.resolved', filter: {} } })], [{ flowId: FLOW_A, chainDepth: 0 }]);
    await handle(event({
      type: 'alert.resolved',
      metadata: { timestamp: '2026-10-25T10:00:00.000Z', flowRunId: RUN_X, flowChainDepth: 0 },
    }));
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('ancestry with a depth but no run id is refused (never reset to 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selects.push([candidate()]);
    await handle(event({ metadata: { timestamp: '2026-10-25T10:00:00.000Z', flowChainDepth: 2 } }));
    expect(createFlowRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('DB failure throws for retry', async () => {
    selects.push(new Error('connection terminated'));
    await expect(handle(event())).rejects.toThrow('connection terminated');
  });

  it('a createFlowRun failure throws after the other flows were tried', async () => {
    selects.push([candidate(), candidate({ id: FLOW_B })], LIVE);
    vi.mocked(createFlowRun).mockRejectedValueOnce(new Error('insert failed')).mockResolvedValueOnce({ created: true, runId: RUN_X, preApprovalsHonored: true });
    await expect(handle(event())).rejects.toThrow('insert failed');
    expect(createFlowRun).toHaveBeenCalledTimes(2);
  });

  it('a full queue is logged, counted, not retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selects.push([candidate()], LIVE);
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'flow_queue_full' });
    await expect(handle(event())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(recordFlowEventAdmissionRefused).toHaveBeenCalledTimes(1);
    expect(recordFlowEventAdmissionRefused).toHaveBeenCalledWith('flow_queue_full');
    warn.mockRestore();
  });

  it.each(['flow_monthly_cap_reached', 'owner_monthly_cap_reached'] as const)(
    'monthly cap refusal (%s) is handled, not retried (W5)',
    async (reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      selects.push([candidate()], LIVE);
      vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason });
      await expect(handle(event())).resolves.toBeUndefined();
      expect(recordFlowEventAdmissionRefused).toHaveBeenCalledWith(reason);
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(reason);
      warn.mockRestore();
    },
  );

  it('a malformed trigger filter is skipped with a warn naming the flow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    selects.push([candidate({ trigger: { type: 'event', event: 'alert.triggered', filter: ['severity'] } })]);
    await handle(event());
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(FLOW_A);
    warn.mockRestore();
  });

  // Review finding: liveness applies to the org of EVERY flow, org-owned included.
  it('a suspended (or deleted) org\'s own event flow does not fire', async () => {
    selects.push([candidate()], []);
    await expect(handle(event())).resolves.toBeUndefined();
    expect(createFlowRun).not.toHaveBeenCalled();
    // The liveness read is the event org under the shared live-org predicate,
    // without the partner-wide type exclusions.
    // (selectCalls[1] is the candidate read's organizations subquery.)
    const where = selectCalls.at(-1)!.find((o) => o.op === 'where')!.args[0];
    const values = sqlValues(where);
    expect(values).toEqual(expect.arrayContaining([ORG, 'active', 'trial']));
    expect(values).not.toContain('quick_support');
  });

  it('a non-live org skips its own flows but a partner-wide candidate is decided by the candidate read alone', async () => {
    selects.push([candidate(), candidate({ id: FLOW_B, orgId: null, partnerId: PARTNER })], []);
    await handle(event());
    expect(vi.mocked(createFlowRun).mock.calls.map(([i]) => i.flowId)).toEqual([FLOW_B]);
  });

  it('a liveness read failure throws for retry', async () => {
    selects.push([candidate()], new Error('connection terminated'));
    await expect(handle(event())).rejects.toThrow('connection terminated');
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('flag off returns without reading', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    await handle(event());
    expect(selectCalls).toHaveLength(0);
    expect(createFlowRun).not.toHaveBeenCalled();
  });
});

describe('eventMatchesFilter', () => {
  const payload = { severity: 'critical', count: 3, ok: false, nested: { a: { b: 'x' } }, nul: null };

  it('matches own-property dot paths with strict equality', () => {
    expect(eventMatchesFilter({}, payload)).toBe(true);
    expect(eventMatchesFilter({ severity: 'critical', 'nested.a.b': 'x', count: 3, ok: false }, payload)).toBe(true);
    expect(eventMatchesFilter({ count: '3' }, payload)).toBe(false);
    expect(eventMatchesFilter({ 'nested.a.b': 'y' }, payload)).toBe(false);
    expect(eventMatchesFilter({ 'nested.a': 'x' }, payload)).toBe(false);
  });

  it('null matches a missing or null value only', () => {
    expect(eventMatchesFilter({ missing: null }, payload)).toBe(true);
    expect(eventMatchesFilter({ 'nested.zz.q': null }, payload)).toBe(true);
    expect(eventMatchesFilter({ nul: null }, payload)).toBe(true);
    expect(eventMatchesFilter({ severity: null }, payload)).toBe(false);
    expect(eventMatchesFilter({ missing: 'x' }, payload)).toBe(false);
  });

  it('eventMatchesFilter never resolves inherited properties', () => {
    const own = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}');
    for (const filter of [
      { '__proto__.x': 1 }, { constructor: null }, { constructor: 'c' }, { toString: null }, { 'severity.length': 8 },
      { 'nested.constructor': null }, { 'nested.a.hasOwnProperty': null }, { 'a.prototype': null },
    ]) {
      expect(eventMatchesFilter(filter as unknown as Record<string, null>, payload), JSON.stringify(filter)).toBe(false);
      expect(eventMatchesFilter(filter as unknown as Record<string, null>, own), JSON.stringify(filter)).toBe(false);
    }
    expect(eventMatchesFilter({ toString: 'x' }, {})).toBe(false);
  });

  it('a non-object payload matches only an empty or all-null filter', () => {
    expect(eventMatchesFilter({}, null)).toBe(true);
    expect(eventMatchesFilter({ a: null }, 'str')).toBe(true);
    expect(eventMatchesFilter({ a: 1 }, [1])).toBe(false);
  });
});
