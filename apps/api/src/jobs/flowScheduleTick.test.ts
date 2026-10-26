import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A9 — the schedule tick. The flows read
 * and the key CAS go through a fake db; run creation and the partner org
 * enumeration are mocked. latestCronOccurrence is REAL (the DST and outage
 * cases depend on it). Real fan-out across partners is
 * flowTriggers.integration.test.ts.
 */

type Op = { op: string; args: unknown[] };
const { selects, updates, calls } = vi.hoisted(() => ({
  selects: [] as unknown[],
  updates: [] as unknown[],
  calls: [] as Array<{ kind: string; ops: Op[] }>,
}));

vi.mock('../db', () => {
  function chain(kind: 'select' | 'update', queue: unknown[]) {
    const rec = { kind, ops: [] as Op[] };
    calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = queue.shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        return (...args: unknown[]) => { rec.ops.push({ op: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  }
  return {
    db: { select: () => chain('select', selects), update: () => chain('update', updates) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env')>()),
  flowsEnabled: vi.fn(() => true),
}));
vi.mock('../services/flows/runService', () => ({ createFlowRun: vi.fn() }));
vi.mock('./aiAgentSweepScheduler', () => ({ loadPartnerOrgIds: vi.fn() }));
vi.mock('../services/flows/flowTriggerMetrics', () => ({ recordFlowScheduleAdmissionRefused: vi.fn(), recordFlowChainDepthRefused: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { flowsEnabled } from '../config/env';
import { createFlowRun } from '../services/flows/runService';
import { loadPartnerOrgIds } from './aiAgentSweepScheduler';
import { recordFlowScheduleAdmissionRefused } from '../services/flows/flowTriggerMetrics';
import { captureException } from '../services/sentry';
import { processFlowScheduleTick, __testOnly } from './flowScheduleTick';

const ORG_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = '11111111-1111-4111-8111-bbbbbbbbbbbb';
const ORG_C = '11111111-1111-4111-8111-cccccccccccc';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const RUN = '88888888-8888-4888-8888-888888888888';
/** The org-flow liveness read (organizations: active/trial, not deleted) — the org is live. */
const LIVE = [{ id: ORG_A }];

function flow(over: Record<string, unknown> = {}) {
  return {
    id: FLOW, orgId: ORG_A, partnerId: null,
    enabledAt: new Date('2026-10-01T00:00:00Z'), scheduleLastOccurrenceKey: null as string | null,
    trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' },
    inputs: [],
    ...over,
  };
}
const cas = () => calls.filter((c) => c.kind === 'update');
const setOf = (rec: { ops: Op[] }) => rec.ops.find((o) => o.op === 'set')!.args[0] as Record<string, unknown>;
const runKeys = () => vi.mocked(createFlowRun).mock.calls.map(([i]) => `${i.orgId}|${i.dedupeKey}`);

beforeEach(() => {
  selects.length = 0;
  updates.length = 0;
  calls.length = 0;
  vi.mocked(flowsEnabled).mockReset().mockReturnValue(true);
  vi.mocked(createFlowRun).mockReset().mockResolvedValue({ created: true, runId: RUN, preApprovalsHonored: true });
  vi.mocked(loadPartnerOrgIds).mockReset().mockResolvedValue({ orgIds: [ORG_A, ORG_B, ORG_C], capped: 0 });
  vi.mocked(recordFlowScheduleAdmissionRefused).mockReset();
  vi.mocked(captureException).mockReset();
});

describe('processFlowScheduleTick', () => {
  it('registers a 60 s repeatable under a colon-free job id', () => {
    expect(__testOnly.REPEAT_JOB_ID).toBe('flow-schedule-tick');
    expect(__testOnly.EVERY_MS).toBe(60_000);
  });

  it('due org flow fires once', async () => {
    selects.push([flow()], LIVE);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(r).toEqual({ fired: 1, skipped: 0 });
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).toEqual({
      triggerKind: 'schedule', flowId: FLOW, orgId: ORG_A, dedupeKey: 'schedule:2026-10-25T10:00@UTC',
      scope: { firedAt: '2026-10-25T10:00:00.000Z' }, inputs: {},
    });
    expect(cas()).toHaveLength(1);
    expect(setOf(cas()[0]!)).toEqual({ scheduleLastOccurrenceKey: '2026-10-25T10:00@UTC' });
  });

  it('second tick in the same minute fires nothing', async () => {
    selects.push([flow({ scheduleLastOccurrenceKey: '2026-10-25T10:00@UTC' })]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:50Z'));
    expect(r).toEqual({ fired: 0, skipped: 1 });
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(0);
  });

  it('partner-wide flow fans out one run per live org', async () => {
    selects.push([flow({ orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(loadPartnerOrgIds).toHaveBeenCalledWith(PARTNER);
    expect(runKeys()).toEqual([ORG_A, ORG_B, ORG_C].map((o) => `${o}|schedule:2026-10-25T10:00@UTC`));
    expect(r.fired).toBe(3);
    expect(cas()).toHaveLength(1);
  });

  it('occurrence before enabled_at is skipped', async () => {
    selects.push([flow({ enabledAt: new Date('2026-10-25T10:00:30Z') })]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:40Z'));
    expect(r).toEqual({ fired: 0, skipped: 1 });
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('a 3-hour outage fires only the latest occurrence', async () => {
    selects.push([flow({ scheduleLastOccurrenceKey: '2026-10-25T09:00@UTC' })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-10-25T12:30:00Z'));
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-10-25T12:00@UTC`]);
  });

  it('nothing older than 24 h is fired', async () => {
    selects.push([flow({ trigger: { type: 'schedule', cron: '0 3 1 1 *', timezone: 'UTC' } })]);
    expect(await processFlowScheduleTick(new Date('2026-10-25T12:30:00Z'))).toEqual({ fired: 0, skipped: 1 });
  });

  it('DST fall-back hour fires once', async () => {
    const tz = 'America/New_York';
    const daily = { type: 'schedule', cron: '30 1 * * *', timezone: tz };
    // 01:30 EDT (05:30Z) fires…
    selects.push([flow({ trigger: daily })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-11-01T05:30:10Z'));
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-11-01T01:30@${tz}`]);
    const stamped = setOf(cas()[0]!).scheduleLastOccurrenceKey as string;
    // …and 01:30 EST (06:30Z) is the same local occurrence.
    selects.push([flow({ trigger: daily, scheduleLastOccurrenceKey: stamped })]);
    const r = await processFlowScheduleTick(new Date('2026-11-01T06:30:10Z'));
    expect(r).toEqual({ fired: 0, skipped: 1 });
    expect(createFlowRun).toHaveBeenCalledTimes(1);
  });

  it('one org\'s insert failure leaves the key unadvanced and the next tick fills only that org', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([flow({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(createFlowRun).mockImplementation(async (i) =>
      i.orgId === ORG_B ? Promise.reject(new Error('deadlock')) : { created: true, runId: RUN, preApprovalsHonored: true });
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(runKeys()).toHaveLength(3);
    expect(cas()).toHaveLength(0);

    vi.mocked(createFlowRun).mockReset().mockImplementation(async (i) =>
      i.orgId === ORG_B ? { created: true, runId: RUN, preApprovalsHonored: true } : { created: false, reason: 'duplicate', runId: RUN, preApprovalsHonored: true });
    selects.push([flow({ orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:01:20Z'));
    expect(runKeys()).toEqual([ORG_A, ORG_B, ORG_C].map((o) => `${o}|schedule:2026-10-25T10:00@UTC`));
    expect(r.fired).toBe(1);
    expect(cas()).toHaveLength(1);
    err.mockRestore();
  });

  it('the CAS compares against the key that was read (IS NOT DISTINCT FROM)', async () => {
    selects.push([flow({ scheduleLastOccurrenceKey: '2026-10-25T09:00@UTC' })], LIVE);
    updates.push([]);
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    const where = cas()[0]!.ops.find((o) => o.op === 'where')!.args[0];
    const text: string[] = [];
    const values: unknown[] = [];
    const walk = (v: unknown, seen = new WeakSet<object>()): void => {
      if (v === null || typeof v !== 'object' || seen.has(v)) { if (typeof v === 'string') values.push(v); return; }
      seen.add(v);
      const name = (v as { constructor?: { name?: string } }).constructor?.name;
      if (name === 'StringChunk') { text.push(...((v as { value: string[] }).value)); return; }
      if (name === 'Param') { values.push((v as { value: unknown }).value); return; }
      for (const c of (v as { queryChunks?: unknown[] }).queryChunks ?? []) walk(c, seen);
    };
    walk(where);
    expect(text.join('')).toMatch(/IS NOT DISTINCT FROM/);
    expect(values).toContain('2026-10-25T09:00@UTC');
  });

  it('a full queue counts as handled and is recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    selects.push([flow()], LIVE);
    updates.push([{ id: FLOW }]);
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'flow_queue_full' });
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(recordFlowScheduleAdmissionRefused).toHaveBeenCalledTimes(1);
    expect(recordFlowScheduleAdmissionRefused).toHaveBeenCalledWith('flow_queue_full');
    expect(cas()).toHaveLength(1);
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain(FLOW);
    expect(line).toContain(ORG_A);
    expect(captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(['flow_monthly_cap_reached', 'owner_monthly_cap_reached'] as const)(
    'monthly cap refusal (%s) counts as handled and advances the key (W5)',
    async (reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      selects.push([flow()], LIVE);
      updates.push([{ id: FLOW }]);
      vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason });
      await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
      expect(recordFlowScheduleAdmissionRefused).toHaveBeenCalledWith(reason);
      expect(cas()).toHaveLength(1);
      const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(line).toContain(reason);
      expect(line).toContain(FLOW);
      expect(captureException).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it('a flow disabled mid-tick is not stamped, and the abort is logged at error with the flow and org', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([flow({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'not_enabled' });
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(cas()).toHaveLength(0);
    // The remaining orgs are not attempted (nothing more to fire)…
    expect(runKeys()).toHaveLength(1);
    // …and that is visible: error log naming the flow and the org, one capture.
    const line = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain(FLOW);
    expect(line).toContain(ORG_A);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ flow_id: FLOW, org_id: ORG_A, flow_site: 'schedule_tick.not_enabled_mid_fanout' });
    expect(vi.mocked(captureException).mock.calls[0]![3]).toEqual({ fingerprint: ['flow', 'schedule_tick.not_enabled_mid_fanout'] });
    err.mockRestore();
  });

  it('an insert failure is captured with the flow tags and a bounded fingerprint', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([flow()], LIVE);
    vi.mocked(createFlowRun).mockRejectedValue(new Error('deadlock'));
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error), undefined,
      { flow_id: FLOW, org_id: ORG_A, flow_site: 'schedule_tick.create_run' },
      { fingerprint: ['flow', 'schedule_tick.create_run'] },
    );
    err.mockRestore();
  });

  it('a flow whose schedule cannot be evaluated is logged at error with its ids and captured once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const BAD = '33333333-3333-4333-8333-0000000000b1';
    const broken = flow({ id: BAD, trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'Not/A_Zone' } });
    selects.push([broken]);
    expect(await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'))).toEqual({ fired: 0, skipped: 1 });
    const line = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain(BAD);
    expect(line).toContain(ORG_A);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ flow_id: BAD, org_id: ORG_A, flow_site: 'schedule_tick.cron_unevaluable' });
    expect(vi.mocked(captureException).mock.calls[0]![3]).toEqual({ fingerprint: ['flow', 'schedule_tick.cron_unevaluable'] });
    // The next tick logs again but does not re-capture the same broken schedule.
    selects.push([broken]);
    await processFlowScheduleTick(new Date('2026-10-25T10:01:20Z'));
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  // Review finding: org liveness applies to EVERY flow, not only partner-wide fan-out.
  it('a suspended (or deleted) org\'s own schedule flow does not fire; the occurrence is stamped', async () => {
    selects.push([flow()], []);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(r.fired).toBe(0);
    // The org read carries the shared live-org predicate (active/trial, not deleted)…
    const orgRead = calls.filter((c) => c.kind === 'select')[1]!;
    const where = orgRead.ops.find((o) => o.op === 'where')!.args[0];
    const values: unknown[] = [];
    const walk = (v: unknown, seen = new WeakSet<object>()): void => {
      if (v === null || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if ((v as { constructor?: { name?: string } }).constructor?.name === 'Param') { values.push((v as { value: unknown }).value); return; }
      if (Array.isArray(v)) { for (const c of v) walk(c, seen); return; }
      for (const c of (v as { queryChunks?: unknown[] }).queryChunks ?? []) walk(c, seen);
    };
    walk(where);
    expect(values).toEqual(expect.arrayContaining([ORG_A, 'active', 'trial']));
    // …but NOT the partner-wide type exclusions: an org's own flow in its own org.
    expect(values).not.toContain('quick_support');
    // Not retried every tick: the occurrence is consumed.
    expect(cas()).toHaveLength(1);
  });

  it('a malformed trigger is skipped, the others still fire', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([flow({ id: 'bad', trigger: { type: 'schedule' } }), flow()], LIVE);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(r).toEqual({ fired: 1, skipped: 1 });
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('bad');
    err.mockRestore();
  });

  it('flag off fires nothing', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'))).toEqual({ fired: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
  });
});
