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
// #5221 B5: the parent claim is mocked; the preference functions stay real.
vi.mock('../services/flows/conversion/claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/flows/conversion/claims')>()),
  claimOccurrence: vi.fn(),
  newestParentScheduleClaim: vi.fn(),
}));

import { legacyPrefers, claimOccurrence, newestParentScheduleClaim } from '../services/flows/conversion/claims';
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
  vi.mocked(claimOccurrence).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(newestParentScheduleClaim).mockReset().mockResolvedValue(null);
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

/**
 * #5221 B5 (plan Decision 6) — converted-flow schedule mode. A flow converted
 * from a Job (its generation switched or reverted) keys occurrences by the UTC
 * minute, claims the PARENT occurrence before fanning out, leaves occurrences
 * before switch_at to legacy, and a reverted generation's flow attempts
 * nothing. Every other flow is the W04 tick above, unchanged.
 */
describe('processFlowScheduleTick — converted flows (#5221 B5)', () => {
  const AUTOMATION = '44444444-4444-4444-8444-444444444444';
  const CONVERSION = '55555555-5555-4555-8555-555555555555';
  const LEGACY_RUN = '66666666-6666-4666-8666-666666666666';

  /** A flow whose generation is switched (switch_at 60 s after the enable). */
  function convertedFlow(over: Record<string, unknown> = {}): ReturnType<typeof flow> & { conversionSwitchAt: Date } {
    const enabledAt = (over.enabledAt as Date | undefined) ?? new Date('2026-10-01T00:00:00Z');
    const partnerWide = over.orgId === null;
    const conversionSwitchAt = new Date(enabledAt.getTime() + 60_000);
    return {
      ...flow({
        conversionId: CONVERSION,
        conversionState: 'switched',
        conversionAutomationId: AUTOMATION,
        conversionOrgId: partnerWide ? null : ORG_A,
        conversionPartnerId: partnerWide ? PARTNER : null,
        ...over,
      }),
      conversionSwitchAt,
    };
  }
  const claimKeys = () => vi.mocked(claimOccurrence).mock.calls.map(([, i]) => i.keys.join(','));

  it('a plain flow keeps the local wall-clock key and never claims', async () => {
    selects.push([flow({ trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'Europe/Berlin' } })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-10-25T11:00@Europe/Berlin`]);
    expect(vi.mocked(createFlowRun).mock.calls[0]![0]).not.toHaveProperty('occurrence');
    expect(setOf(cas()[0]!)).toEqual({ scheduleLastOccurrenceKey: '2026-10-25T11:00@Europe/Berlin' });
    expect(claimOccurrence).not.toHaveBeenCalled();
  });

  it('DST repeated hour fires twice for a converted flow and once for a plain flow', async () => {
    const tz = 'America/New_York';
    const daily = { type: 'schedule', cron: '30 1 * * *', timezone: tz };
    // Converted: 01:30 EDT (05:30Z) and 01:30 EST (06:30Z) are two UTC minutes.
    selects.push([convertedFlow({ trigger: daily })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-11-01T05:30:10Z'));
    const stamped = setOf(cas()[0]!).scheduleLastOccurrenceKey as string;
    expect(stamped).toBe('2026-11-01T05:30Z');
    selects.push([convertedFlow({ trigger: daily, scheduleLastOccurrenceKey: stamped })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-11-01T06:30:10Z'));
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-11-01T05:30Z`, `${ORG_A}|schedule:2026-11-01T06:30Z`]);
    expect(claimKeys()).toEqual(['schedule:2026-11-01T05:30Z', 'schedule:2026-11-01T06:30Z']);

    // Plain: the same two instants are ONE local occurrence.
    vi.mocked(createFlowRun).mockClear();
    vi.mocked(claimOccurrence).mockClear();
    calls.length = 0;
    selects.push([flow({ trigger: daily })], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-11-01T05:30:10Z'));
    const local = setOf(cas()[0]!).scheduleLastOccurrenceKey as string;
    selects.push([flow({ trigger: daily, scheduleLastOccurrenceKey: local })]);
    await processFlowScheduleTick(new Date('2026-11-01T06:30:10Z'));
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-11-01T01:30@${tz}`]);
    expect(claimOccurrence).not.toHaveBeenCalled();
  });

  it('occurrence claimed by legacy is consumed without a run', async () => {
    vi.mocked(claimOccurrence).mockResolvedValue({ ok: false, existing: { engine: 'legacy', legacyRunId: LEGACY_RUN, flowRunId: null } });
    selects.push([convertedFlow()]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(r).toEqual({ fired: 0, skipped: 0 });
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(1);
    expect(setOf(cas()[0]!)).toEqual({ scheduleLastOccurrenceKey: '2026-10-25T10:00Z' });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('partner-wide parent claim lets every org\'s child run', async () => {
    selects.push([convertedFlow({ orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    // ONE parent claim: engine flow, no flow run, the automation's owner axis, the UTC minute.
    expect(claimOccurrence).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimOccurrence).mock.calls[0]![1]).toEqual({
      automationId: AUTOMATION,
      owner: { orgId: null, partnerId: PARTNER },
      keys: ['schedule:2026-10-25T10:00Z'],
      engine: 'flow',
      conversionId: CONVERSION,
      occurrenceAt: new Date('2026-10-25T10:00:00Z'),
    });
    // Before any child, and every child runs under W04's per-org dedupe without re-claiming.
    expect(vi.mocked(claimOccurrence).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(createFlowRun).mock.invocationCallOrder[0]!);
    expect(runKeys()).toEqual([ORG_A, ORG_B, ORG_C].map((o) => `${o}|schedule:2026-10-25T10:00Z`));
    for (const [i] of vi.mocked(createFlowRun).mock.calls) {
      expect(i).not.toHaveProperty('occurrence');
      expect(i.scope).toEqual({ firedAt: '2026-10-25T10:00:00.000Z' });
    }
    expect(r.fired).toBe(3);
    expect(setOf(cas()[0]!)).toEqual({ scheduleLastOccurrenceKey: '2026-10-25T10:00Z' });
  });

  it('a failed child org retries without a second parent claim', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([convertedFlow({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(createFlowRun).mockImplementation(async (i) =>
      i.orgId === ORG_B ? Promise.reject(new Error('deadlock')) : { created: true, runId: RUN, preApprovalsHonored: true });
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(cas()).toHaveLength(0);

    // Retry: the parent claim is already this tick's own (engine flow, no run) — the fan-out continues.
    vi.mocked(claimOccurrence).mockResolvedValue({ ok: false, existing: { engine: 'flow', legacyRunId: null, flowRunId: null } });
    vi.mocked(createFlowRun).mockReset().mockImplementation(async (i) =>
      i.orgId === ORG_B ? { created: true, runId: RUN, preApprovalsHonored: true } : { created: false, reason: 'duplicate', runId: RUN, preApprovalsHonored: true });
    selects.push([convertedFlow({ orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:01:20Z'));
    expect(runKeys()).toEqual([ORG_A, ORG_B, ORG_C].map((o) => `${o}|schedule:2026-10-25T10:00Z`));
    expect(r.fired).toBe(1);
    expect(cas()).toHaveLength(1);
    expect(claimKeys()).toEqual(['schedule:2026-10-25T10:00Z', 'schedule:2026-10-25T10:00Z']);
    err.mockRestore();
  });

  it('a flow-engine claim that names a run is not this tick\'s parent: consumed without a run', async () => {
    vi.mocked(claimOccurrence).mockResolvedValue({ ok: false, existing: { engine: 'flow', legacyRunId: null, flowRunId: RUN } });
    // LIVE is queued so a tick that wrongly fanned out would reach createFlowRun.
    selects.push([convertedFlow()], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(claimOccurrence).toHaveBeenCalledTimes(1);
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(1);
  });

  it('enable stamping never consumes an occurrence at or after switch_at', async () => {
    const tz = 'America/New_York';
    const daily = { type: 'schedule', cron: '30 1 * * *', timezone: tz };
    // Switched at 01:30:20 EDT: enable stamped the LOCAL key of 05:30Z; switch_at is 05:31:20Z.
    const enabledAt = new Date('2026-11-01T05:30:20Z');
    const switched = convertedFlow({ trigger: daily, enabledAt, scheduleLastOccurrenceKey: `2026-11-01T01:30@${tz}` });
    expect(switched.conversionSwitchAt).toEqual(new Date('2026-11-01T05:31:20Z'));

    // The stamped occurrence (05:30Z) is before switch_at: legacy's, never attempted here.
    selects.push([switched]);
    expect(await processFlowScheduleTick(new Date('2026-11-01T05:31:30Z'))).toEqual({ fired: 0, skipped: 1 });
    expect(claimOccurrence).not.toHaveBeenCalled();

    // 01:30 EST (06:30Z) has the same LOCAL key the enable stamped, but it is
    // after switch_at, and legacy does not prefer it: the flow must run it.
    expect(legacyPrefers({ state: 'switched', switchAt: switched.conversionSwitchAt }, new Date('2026-11-01T06:30:00Z'), false)).toBe(false);
    selects.push([switched], LIVE);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-11-01T06:30:10Z'));
    expect(r.fired).toBe(1);
    expect(claimKeys()).toEqual(['schedule:2026-11-01T06:30Z']);
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-11-01T06:30Z`]);
  });

  it('an occurrence 30 s before switch_at is left to legacy: no claim, no run, no stamp', async () => {
    // Hourly; switch_at 10:00:30Z; the tick runs after switch_at, its latest occurrence is 10:00Z.
    const switched = convertedFlow({ enabledAt: new Date('2026-10-25T09:59:30Z') });
    expect(switched.conversionSwitchAt).toEqual(new Date('2026-10-25T10:00:30Z'));
    // The two engines agree: legacy attempts it (it is before switch_at)…
    expect(legacyPrefers({ state: 'switched', switchAt: switched.conversionSwitchAt }, new Date('2026-10-25T10:00:00Z'), false)).toBe(true);
    selects.push([switched]);
    // …and the flow does not, not even to claim it.
    expect(await processFlowScheduleTick(new Date('2026-10-25T10:00:50Z'))).toEqual({ fired: 0, skipped: 1 });
    expect(claimOccurrence).not.toHaveBeenCalled();
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(0);

    // The next occurrence (11:00Z) is the flow's.
    selects.push([switched], LIVE);
    updates.push([{ id: FLOW }]);
    await processFlowScheduleTick(new Date('2026-10-25T11:00:10Z'));
    expect(claimKeys()).toEqual(['schedule:2026-10-25T11:00Z']);
    expect(runKeys()).toEqual([`${ORG_A}|schedule:2026-10-25T11:00Z`]);
  });

  it('a reverted generation\'s flow with no unfinished parent claim attempts nothing and reports nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([convertedFlow({ conversionState: 'reverted', orgId: null, partnerId: PARTNER })]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(r).toEqual({ fired: 0, skipped: 1 });
    // It looked for its own parent claim within the 24 h lookback, on this generation.
    expect(newestParentScheduleClaim).toHaveBeenCalledWith(
      expect.anything(), { id: CONVERSION, automationId: AUTOMATION }, new Date('2026-10-24T10:00:20Z'),
    );
    expect(claimOccurrence).not.toHaveBeenCalled();
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(loadPartnerOrgIds).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('a reverted flow finishes an occurrence it parent-claimed before the revert, without claiming again', async () => {
    // Claimed and half fanned out at 10:00 (switched); reverted since; the tick is past the next hour.
    vi.mocked(newestParentScheduleClaim).mockResolvedValue({ key: 'schedule:2026-10-25T10:00Z', at: new Date('2026-10-25T10:00:00Z') });
    vi.mocked(createFlowRun).mockImplementation(async (i) =>
      i.orgId === ORG_B ? { created: true, runId: RUN, preApprovalsHonored: true } : { created: false, reason: 'duplicate', runId: RUN, preApprovalsHonored: true });
    selects.push([convertedFlow({ conversionState: 'reverted', orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW }]);
    const r = await processFlowScheduleTick(new Date('2026-10-25T11:00:20Z'));
    expect(r.fired).toBe(1);
    expect(claimOccurrence).not.toHaveBeenCalled();
    expect(runKeys()).toEqual([ORG_A, ORG_B, ORG_C].map((o) => `${o}|schedule:2026-10-25T10:00Z`));
    for (const [i] of vi.mocked(createFlowRun).mock.calls) {
      expect(i).not.toHaveProperty('occurrence');
      expect(i.scope).toEqual({ firedAt: '2026-10-25T10:00:00.000Z' });
    }
    expect(setOf(cas()[0]!)).toEqual({ scheduleLastOccurrenceKey: '2026-10-25T10:00Z' });
  });

  it('a reverted flow whose parent-claimed occurrence is already stamped does nothing', async () => {
    vi.mocked(newestParentScheduleClaim).mockResolvedValue({ key: 'schedule:2026-10-25T10:00Z', at: new Date('2026-10-25T10:00:00Z') });
    selects.push([convertedFlow({ conversionState: 'reverted', scheduleLastOccurrenceKey: '2026-10-25T10:00Z' })]);
    expect(await processFlowScheduleTick(new Date('2026-10-25T11:00:20Z'))).toEqual({ fired: 0, skipped: 1 });
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(claimOccurrence).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(0);
  });

  it('a child refused flow_conversion_reverted despite the parent claim is an error and leaves the key unadvanced', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selects.push([convertedFlow({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(createFlowRun).mockImplementation(async (i) =>
      i.orgId === ORG_A ? { created: true, runId: RUN, preApprovalsHonored: true } : { created: false, reason: 'flow_conversion_reverted' });
    const r = await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(r.fired).toBe(1);
    // Every org is still attempted; nothing is stamped, so the next tick retries the missing ones.
    expect(runKeys()).toHaveLength(3);
    expect(cas()).toHaveLength(0);
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ flow_id: FLOW, org_id: ORG_B, flow_site: 'schedule_tick.child_refused_reverted' });
    err.mockRestore();
  });

  it('a claim that cannot be written leaves the occurrence unconsumed for the next tick', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(claimOccurrence).mockRejectedValue(new Error('connection reset'));
    selects.push([convertedFlow()]);
    await processFlowScheduleTick(new Date('2026-10-25T10:00:20Z'));
    expect(createFlowRun).not.toHaveBeenCalled();
    expect(cas()).toHaveLength(0);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ flow_id: FLOW, flow_site: 'schedule_tick.fire_flow' });
    err.mockRestore();
  });
});
