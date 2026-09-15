/**
 * AI patch agent W01 — the patch plan membership gate, persistence and safe
 * projection. W01 mints ZERO action intents: `patchPlan.ts` does not import
 * `createActionIntent` at all (asserted on the source below, not only on a
 * mock that could be bypassed).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PatchPlanOutcome, PatchPlanOutcomeRefs } from '@breeze/shared';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
  selects: 0,
  fail: null as Error | null,
  scopes: [] as Array<string | undefined>,
  ambient: undefined as { scope: string } | undefined,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      state.scopes.push(state.ambient?.scope);
      const builder: Record<string, unknown> = {
        from: vi.fn(() => builder),
        where: vi.fn((w: unknown) => { state.wheres.push(w); return builder; }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => {
            if (state.fail) throw state.fail;
            return state.rows.shift() ?? [];
          }).then(resolve, reject),
      };
      return builder;
    }),
  },
  getCurrentDbAccessContext: vi.fn(() => state.ambient),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const prev = state.ambient;
    state.ambient = { scope: 'system' };
    try { return await fn(); } finally { state.ambient = prev; }
  }),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { patchPlanDeviceIds, persistPatchPlan, projectPatch } from './patchPlan';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const GHOST = '00000000-0000-4000-8000-0000000000d9';
const P1 = '00000000-0000-4000-8000-0000000000e1';
const P9 = '00000000-0000-4000-8000-0000000000e9';
const WIN = '00000000-0000-4000-8000-0000000000f1';
const JR = '00000000-0000-4000-8000-0000000000f2';

const refs: PatchPlanOutcomeRefs = {
  deviceIds: new Set([D1, D2]),
  patchIdsByDevice: new Map([[D1, new Set([P1])]]),
  windowIds: new Set(),
  jobResultIds: new Set(),
};

function plan(items: PatchPlanOutcome['items']): PatchPlanOutcome {
  return {
    schemaVersion: 1,
    summary: 'Plan.',
    posture: { compliancePct: 80, devicesAtRisk: 1, oldestOutstandingDays: 10 },
    items,
    dispositions: [],
    evidenceTruncated: false,
    generatedAt: '2026-09-14T02:00:00.000Z',
  };
}
const base = { severity: 'high' as const, title: 't', detail: 'd', evidenceRef: 'e' };
const run = { id: 'run-1', orgId: ORG };
const dialect = new PgDialect();

beforeEach(() => {
  state.rows = [];
  state.wheres = [];
  state.selects = 0;
  state.fail = null;
  state.scopes = [];
  state.ambient = undefined;
});

describe('persistPatchPlan', () => {
  it('refuses a device absent from the evidence BEFORE any DB work', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'install', deviceId: GHOST, patchIds: [P1] }]), refs);
    expect(dispositions).toEqual([{ index: 0, class: 'install', deviceId: GHOST, disposition: 'refused', reason: 'device_not_in_evidence' }]);
    expect(state.selects).toBe(0);
  });

  it('refuses a patch that is not outstanding on that device in the evidence', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'install', deviceId: D1, patchIds: [P9] }]), refs);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'patch_not_in_evidence' });
  });

  it('refuses every reboot_plan (no window resolves in W01) and every chase (no failure evidence in W01)', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN },
      { ...base, class: 'chase', deviceId: D1, patchIds: [P1], jobResultIds: [JR] },
    ]), refs);
    expect(dispositions.map((d) => d.reason)).toEqual(['window_not_resolved', 'job_result_not_in_evidence']);
  });

  it('records a valid install and a device-less advisory, checking org membership in ONE batched, org-pinned read', async () => {
    state.rows = [[{ id: D1 }, { id: D2 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D2 },
      { ...base, class: 'approval_advisory', patchIds: [P1] },
    ]), refs);
    expect(dispositions.map((d) => d.disposition)).toEqual(['recorded', 'recorded', 'recorded']);
    expect(state.selects).toBe(1);
    expect(state.scopes).toEqual(['system']);
    const compiled = dialect.sqlToQuery(state.wheres[0] as SQL);
    expect(compiled.sql).toContain('"org_id" = ');
    expect(compiled.sql).toContain('"is_ephemeral" = ');
    expect(compiled.params).toContain(ORG);
  });

  it('refuses a device that cleared gate 1 but is no longer in the org (moved / ephemeral)', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D2 },
    ]), refs);
    expect(dispositions[1]).toMatchObject({ disposition: 'refused', reason: 'device_not_in_org' });
  });

  it('propagates a membership-read failure so the finalizer can report it', async () => {
    state.fail = new Error('db down');
    await expect(persistPatchPlan(run, plan([{ ...base, class: 'escalation', deviceId: D1 }]), refs)).rejects.toThrow('db down');
  });

  it('mints ZERO action intents — the module does not even import the intent service', () => {
    const src = readFileSync(join(__dirname, 'patchPlan.ts'), 'utf8');
    expect(src).not.toMatch(/createActionIntent|intentService|action_intents|actionIntents/);
  });
});

describe('projectPatch', () => {
  it('returns null when there is no patchPlan at all', () => {
    expect(projectPatch({ scheduleId: null, triggerRef: {} }, {}, new Map())).toBeNull();
    expect(projectPatch({ scheduleId: null, triggerRef: {} }, { patchPlan: 'nope' } as never, new Map())).toBeNull();
  });

  it('tolerates a maximally corrupt outcome', () => {
    const out = projectPatch({ scheduleId: null, triggerRef: {} }, { patchPlan: { items: 7, summary: 3, dispositions: 'x' } } as never, new Map());
    expect(out).toMatchObject({ summary: '', items: [], posture: null, recordedCount: 0, refusedCount: 0 });
  });

  it('projects items with hostname, disposition and refusal reason — never the raw ids list', () => {
    const outcome = plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'reboot_plan', deviceId: D2, windowId: WIN },
    ]);
    outcome.dispositions = [
      { index: 0, class: 'install', deviceId: D1, disposition: 'recorded' },
      { index: 1, class: 'reboot_plan', deviceId: D2, disposition: 'refused', reason: 'window_not_resolved' },
    ];
    const dto = projectPatch(
      { scheduleId: 'sched-1', triggerRef: { occurrenceKey: '2026-09-14T02:00:00Z' } },
      { patchPlan: outcome },
      new Map([[D1, 'WS-01']]),
    )!;
    expect(dto).toMatchObject({ scheduleId: 'sched-1', occurrenceKey: '2026-09-14T02:00:00Z', recordedCount: 1, refusedCount: 1 });
    expect(dto.items[0]).toMatchObject({ index: 0, deviceHostname: 'WS-01', patchCount: 1, disposition: 'recorded', reason: null });
    expect(dto.items[1]).toMatchObject({ deviceHostname: null, disposition: 'refused', reason: 'window_not_resolved' });
    expect(JSON.stringify(dto)).not.toContain(P1);
  });
});

describe('patchPlanDeviceIds', () => {
  it('collects the distinct device ids a plan names, tolerating garbage', () => {
    expect(patchPlanDeviceIds({ patchPlan: plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D1 },
      { ...base, class: 'approval_advisory', patchIds: [P1] },
    ]) }).sort()).toEqual([D1]);
    expect(patchPlanDeviceIds({})).toEqual([]);
    expect(patchPlanDeviceIds({ patchPlan: { items: 'x' } })).toEqual([]);
  });
});
