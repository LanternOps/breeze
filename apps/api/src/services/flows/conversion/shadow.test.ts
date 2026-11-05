import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Tool Catalog W06 (#5221) Task B4 — the shadow hooks' service side (plan
 * Decision 3): the counter write is ONE conditional UPDATE (never a
 * read-modify-write), it never throws into the legacy path, the fan-out's
 * trigger comparison runs in both directions, and the after-run observation
 * compares the target set, the over-cap rule and the steps that would park.
 * The concurrent increments are proven on real Postgres in
 * flowConversionRevert.integration.test.ts.
 */
const h = vi.hoisted(() => ({
  queries: [] as string[],
  params: [] as unknown[][],
  responses: [] as Array<unknown[] | Error>,
  capture: vi.fn(),
  resolveTargetsOnce: vi.fn(),
  resolveDeviceIdsInRunOrg: vi.fn(),
}));

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

vi.mock('../../../db', () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      const r = render(q);
      h.queries.push(r.sql.replace(/\s+/g, ' '));
      h.params.push(r.params);
      if (/^\s*SET LOCAL/i.test(r.sql)) return [];
      const next = h.responses.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));
vi.mock('../../sentry', () => ({ captureException: (...a: unknown[]) => h.capture(...a) }));
vi.mock('../builtins/fleetTargets', () => ({
  resolveTargetsOnce: (...a: unknown[]) => h.resolveTargetsOnce(...a),
  resolveDeviceIdsInRunOrg: (...a: unknown[]) => h.resolveDeviceIdsInRunOrg(...a),
}));

import { observeShadowRun, recordShadow, shadowTriggerVerdict } from './shadow';

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'd'.repeat(64);
const D = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

const updates = () => h.queries.filter((q) => q.startsWith('UPDATE'));

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.params.length = 0;
  h.responses.length = 0;
});

describe('recordShadow', () => {
  it('counters increment atomically: one conditional UPDATE, never a read-modify-write', async () => {
    h.responses.push([{ id: CONV }]);
    expect(await recordShadow(CONV, { divergent: true, kind: 'would_park', detail: 'steps a0 would wait', documentDigest: DIGEST })).toBe(true);

    expect(h.queries.some((q) => q.startsWith('SELECT'))).toBe(false);
    const [update, ...more] = updates();
    expect(more).toEqual([]);
    expect(update).toContain('shadow_runs = shadow_runs + 1');
    expect(update).toContain('shadow_divergences = shadow_divergences + 1');
    expect(update).toContain("state = 'shadow'");
    expect(update).toContain('document_digest =');
    expect(update).toContain('shadow_last_divergence = jsonb_build_object');
    expect(h.params.flat()).toEqual(expect.arrayContaining([CONV, DIGEST, 'would_park', 'steps a0 would wait']));
  });

  it('an agreeing observation counts a run and leaves the divergence fields alone', async () => {
    h.responses.push([{ id: CONV }]);
    expect(await recordShadow(CONV, { divergent: false, kind: null, detail: '' })).toBe(true);
    const [update] = updates();
    expect(update).toContain('shadow_runs = shadow_runs + 1');
    expect(update).not.toContain('shadow_divergences = shadow_divergences + 1');
    expect(update).not.toContain('shadow_last_divergence');
    // No digest given: no digest predicate.
    expect(update).not.toContain('document_digest =');
  });

  it('a generation that is no longer shadow matches nothing and reports false', async () => {
    h.responses.push([]);
    expect(await recordShadow(CONV, { divergent: false, kind: null, detail: '' })).toBe(false);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('a DB failure goes to Sentry and is never thrown', async () => {
    h.responses.push(new Error('deadlock detected'));
    await expect(recordShadow(CONV, { divergent: true, kind: 'over_cap', detail: 'x' })).resolves.toBe(false);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0]![2]).toMatchObject({ flow_site: 'conversion.shadow_record' });
  });

  it('the stored detail is bounded', async () => {
    h.responses.push([{ id: CONV }]);
    await recordShadow(CONV, { divergent: true, kind: 'would_park', detail: 'x'.repeat(5000) });
    const detail = h.params.flat().find((p) => typeof p === 'string' && p.startsWith('xxx')) as string;
    expect(detail.length).toBeLessThanOrEqual(500);
  });
});

describe('shadowTriggerVerdict (the fan-out, both directions)', () => {
  const flowTrigger = { type: 'event', event: 'device.offline', filter: { 'device.siteId': 'site-1' } };

  it('shadow fan-out records a flow-only match', () => {
    expect(shadowTriggerVerdict({ flowTrigger, eventType: 'device.offline', payload: { device: { siteId: 'site-1' } }, legacyMatched: false }))
      .toMatchObject({ divergent: true, kind: 'trigger_mismatch', detail: expect.stringContaining('flow trigger matched') });
  });

  it('a legacy-only match is a mismatch too', () => {
    expect(shadowTriggerVerdict({ flowTrigger, eventType: 'device.offline', payload: { device: { siteId: 'site-2' } }, legacyMatched: true }))
      .toMatchObject({ divergent: true, kind: 'trigger_mismatch' });
  });

  it('agreement in either direction records nothing at the fan-out (a matched run is observed after creation)', () => {
    expect(shadowTriggerVerdict({ flowTrigger, eventType: 'device.offline', payload: { device: { siteId: 'site-1' } }, legacyMatched: true })).toBeNull();
    expect(shadowTriggerVerdict({ flowTrigger, eventType: 'device.offline', payload: { device: { siteId: 'site-2' } }, legacyMatched: false })).toBeNull();
    expect(shadowTriggerVerdict({ flowTrigger, eventType: 'device.online', payload: { device: { siteId: 'site-1' } }, legacyMatched: false })).toBeNull();
  });

  it('flows compare strictly: a string expectation never matches a number', () => {
    const t = { type: 'event', event: 'alert.triggered', filter: { severity: '3' } };
    expect(shadowTriggerVerdict({ flowTrigger: t, eventType: 'alert.triggered', payload: { severity: 3 }, legacyMatched: true }))
      .toMatchObject({ kind: 'trigger_mismatch' });
  });

  it('a non-event flow trigger never matches an event', () => {
    expect(shadowTriggerVerdict({ flowTrigger: { type: 'schedule', cron: '0 3 * * *', timezone: 'UTC' }, eventType: 'device.offline', payload: {}, legacyMatched: true }))
      .toMatchObject({ kind: 'trigger_mismatch' });
  });
});

describe('observeShadowRun (after legacy run creation)', () => {
  const doc = (steps: unknown[], trigger: unknown = { type: 'schedule', cron: '0 3 * * *', timezone: 'UTC' }) =>
    ({ version: 1, name: 'Converted', trigger, inputs: [], steps });
  const fleetStep = (input: Record<string, unknown>) =>
    ({ id: 'a0_run_script', tool: 'run_script_on_targets', input: { scriptId: D(99), whenOffline: 'queue', ...input }, approval: 'default', onFailure: 'stop', timeoutSec: 300 });
  const ledger = (definition: unknown, orgId: string | null = ORG) =>
    [{ document_digest: DIGEST, definition, org_id: orgId, run_partner_id: orgId ? PARTNER : null }];
  const base = {
    conversionId: CONV,
    automation: { id: AUTO, orgId: ORG, partnerId: null },
    run: { kind: 'schedule' as const, at: new Date('2027-01-09T03:00:00Z') },
    legacyTargetIds: [D(1), D(2)],
  };
  const recorded = () => {
    const u = updates().find((q) => q.includes('shadow_runs = shadow_runs + 1'));
    return u ? { update: u, params: h.params[h.queries.indexOf(u)]! } : null;
  };

  it('resolves the first fleet step in the run org and records a target-set divergence', async () => {
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })])));
    h.resolveTargetsOnce.mockResolvedValue({ deviceIds: [D(1)], devices: [], warnings: [], problems: [] });
    h.responses.push([{ id: CONV }]);
    await observeShadowRun(base);
    expect(h.resolveTargetsOnce).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER }, { target: { type: 'all' } });
    const r = recorded()!;
    expect(r.update).toContain('shadow_divergences = shadow_divergences + 1');
    expect(r.params).toEqual(expect.arrayContaining(['target_set_mismatch', DIGEST]));
  });

  it('the same set records would_park under the switch defaults (no pre-approval ticked)', async () => {
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })])));
    h.resolveTargetsOnce.mockResolvedValue({ deviceIds: [D(2), D(1)], devices: [], warnings: [], problems: [] });
    h.responses.push([{ id: CONV }]);
    await observeShadowRun(base);
    expect(recorded()!.params).toEqual(expect.arrayContaining(['would_park']));
  });

  it('over the fleet cap is over_cap', async () => {
    h.responses.push(ledger(doc([fleetStep({ conditions: [] })])));
    const many = Array.from({ length: 501 }, (_, i) => D(i));
    h.resolveTargetsOnce.mockResolvedValue({ deviceIds: many, devices: [], warnings: [], problems: [] });
    h.responses.push([{ id: CONV }]);
    await observeShadowRun({ ...base, legacyTargetIds: many });
    expect(recorded()!.params).toEqual(expect.arrayContaining(['over_cap']));
  });

  it('an event run binds the triggering device and agrees when nothing parks', async () => {
    const t = { type: 'event', event: 'device.offline', filter: {} };
    const notifyOnly = doc([{ id: 'a0_targets', tool: 'resolve_targets', input: { deviceIds: ['{{trigger.device.id}}'] }, approval: 'default', onFailure: 'stop', timeoutSec: 300 }], t);
    h.responses.push(ledger(notifyOnly));
    h.resolveDeviceIdsInRunOrg.mockResolvedValue([{ id: D(1), hostname: 'h', name: 'h' }]);
    h.responses.push([{ id: CONV }]);
    await observeShadowRun({ ...base, run: { kind: 'event', eventType: 'device.offline', payload: { deviceId: D(1) } }, legacyTargetIds: [D(1)] });
    expect(h.resolveDeviceIdsInRunOrg).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER }, [D(1)]);
    const r = recorded()!;
    expect(r.update).not.toContain('shadow_divergences = shadow_divergences + 1');
  });

  it('an event the flow trigger does not match was already recorded by the fan-out: nothing more', async () => {
    const t = { type: 'event', event: 'device.offline', filter: { 'device.siteId': 'other' } };
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })], t)));
    await observeShadowRun({ ...base, run: { kind: 'event', eventType: 'device.offline', payload: { device: { siteId: 'site-1' } } } });
    expect(recorded()).toBeNull();
    expect(h.resolveTargetsOnce).not.toHaveBeenCalled();
  });

  it('a schedule the flow cron would not fire at this minute is a trigger mismatch', async () => {
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })], { type: 'schedule', cron: '0 4 * * *', timezone: 'UTC' })));
    h.responses.push([{ id: CONV }]);
    await observeShadowRun(base);
    expect(recorded()!.params).toEqual(expect.arrayContaining(['trigger_mismatch']));
  });

  it('a partner-wide Job compares trigger and would-park only (its legacy run spans orgs, its flow runs per org)', async () => {
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })]), null));
    h.responses.push([{ id: CONV }]);
    await observeShadowRun({ ...base, automation: { id: AUTO, orgId: null, partnerId: PARTNER } });
    expect(h.resolveTargetsOnce).not.toHaveBeenCalled();
    expect(recorded()!.params).toEqual(expect.arrayContaining(['would_park']));
  });

  it('a generation no longer in shadow is not observed', async () => {
    h.responses.push([]);
    await observeShadowRun(base);
    expect(recorded()).toBeNull();
  });

  it('shadow never executes anything and never throws: a resolver failure goes to Sentry', async () => {
    h.responses.push(ledger(doc([fleetStep({ target: { type: 'all' } })])));
    h.resolveTargetsOnce.mockRejectedValue(new Error('pool exhausted'));
    await expect(observeShadowRun(base)).resolves.toBeUndefined();
    expect(recorded()).toBeNull();
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0]![2]).toMatchObject({ flow_site: 'conversion.shadow_observe' });
    // Only reads and the (absent) counter write: no INSERT anywhere.
    expect(h.queries.some((q) => q.startsWith('INSERT'))).toBe(false);
  });
});
