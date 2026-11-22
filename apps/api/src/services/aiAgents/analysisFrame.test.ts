/**
 * Wisp analysis sessions W02 — `resolveAnalysisFrame` (spec §4.3, W00 C6/C7).
 *
 * `../../db` is the FIFO-by-table select stub `analysisProfile.admission.test.ts`
 * uses, extended so `limit(n)` records `n`: the frame query must never load
 * more than `maxFrameDevices + 1` ids. Real-Postgres coverage of the filters
 * (org, site, decommissioned, allowlist) is in
 * `__tests__/integration/analysisFrame.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  limits: [] as number[],
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) throw new Error(`No queued rows for table ${table}`);
  return queue.shift() as unknown[];
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const builder: Record<string, unknown> = {
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn((n: number) => { dbMockState.limits.push(n); return builder; }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });
  return { db: { select: vi.fn(() => makeSelect()) } };
});

import { db } from '../../db';
import { resolveAnalysisFrame } from './analysisFrame';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const SITE_1 = '00000000-0000-4000-8000-0000000000b1';
const SITE_2 = '00000000-0000-4000-8000-0000000000b2';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const D3 = '00000000-0000-4000-8000-0000000000d3';
const D4 = '00000000-0000-4000-8000-0000000000d4';

const base = {
  orgId: ORG, deviceIds: [] as string[], siteId: null as string | null,
  allowedSiteIds: null as string[] | null, maxInputDevices: 50, maxFrameDevices: 3,
};

function queue(table: string, rows: unknown[]) {
  (dbMockState.rowQueues[table] ??= []).push(rows);
}

beforeEach(() => {
  dbMockState.rowQueues = {};
  dbMockState.limits = [];
  vi.mocked(db.select).mockClear();
});

describe('resolveAnalysisFrame — org', () => {
  it('expands to the org devices, records the scope, loads at most max + 1 ids', async () => {
    queue('devices', [{ id: D1 }, { id: D2 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'org' })).resolves.toEqual({
      ok: true, deviceIds: [D1, D2], scope: { kind: 'org', siteId: null, deviceCount: 2 },
    });
    expect(dbMockState.limits).toEqual([4]);
  });

  it('admits exactly maxFrameDevices', async () => {
    queue('devices', [{ id: D1 }, { id: D2 }, { id: D3 }]);
    const r = await resolveAnalysisFrame({ ...base, scope: 'org' });
    expect(r.ok).toBe(true);
  });

  it('refuses one more than maxFrameDevices with frame_too_large', async () => {
    queue('devices', [{ id: D1 }, { id: D2 }, { id: D3 }, { id: D4 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'org' })).resolves.toEqual({ ok: false, refusal: 'frame_too_large' });
  });

  it('refuses an org with no eligible devices with frame_empty (never freezes [])', async () => {
    queue('devices', []);
    await expect(resolveAnalysisFrame({ ...base, scope: 'org' })).resolves.toEqual({ ok: false, refusal: 'frame_empty' });
  });

  it('an empty site allowlist is frame_empty with no query', async () => {
    await expect(resolveAnalysisFrame({ ...base, scope: 'org', allowedSiteIds: [] })).resolves.toEqual({ ok: false, refusal: 'frame_empty' });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('resolveAnalysisFrame — site', () => {
  it('a site that is not in the org is site_not_in_scope', async () => {
    queue('sites', []);
    await expect(resolveAnalysisFrame({ ...base, scope: 'site', siteId: SITE_1 })).resolves.toEqual({ ok: false, refusal: 'site_not_in_scope' });
  });

  it('a site outside the grant site allowlist is site_not_in_scope', async () => {
    queue('sites', [{ id: SITE_1 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'site', siteId: SITE_1, allowedSiteIds: [SITE_2] }))
      .resolves.toEqual({ ok: false, refusal: 'site_not_in_scope' });
  });

  it('expands to the site devices and records the site id', async () => {
    queue('sites', [{ id: SITE_1 }]);
    queue('devices', [{ id: D1 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'site', siteId: SITE_1 })).resolves.toEqual({
      ok: true, deviceIds: [D1], scope: { kind: 'site', siteId: SITE_1, deviceCount: 1 },
    });
    expect(dbMockState.limits).toContain(4);
  });

  it('site scope without a siteId is site_not_in_scope (never the whole org)', async () => {
    await expect(resolveAnalysisFrame({ ...base, scope: 'site', siteId: null })).resolves.toEqual({ ok: false, refusal: 'site_not_in_scope' });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('resolveAnalysisFrame — devices', () => {
  it('an empty list is frame_empty', async () => {
    await expect(resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [] })).resolves.toEqual({ ok: false, refusal: 'frame_empty' });
  });

  it('more than maxInputDevices is too_many_input_devices', async () => {
    await expect(resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [D1, D2, D3], maxInputDevices: 2 }))
      .resolves.toEqual({ ok: false, refusal: 'too_many_input_devices' });
  });

  it('a device outside the org is device_not_in_org', async () => {
    queue('devices', [{ id: D1, siteId: SITE_1 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [D1, D2] }))
      .resolves.toEqual({ ok: false, refusal: 'device_not_in_org' });
  });

  it('dedupes in first-occurrence order', async () => {
    queue('devices', [{ id: D1, siteId: SITE_1 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [D1, D1] })).resolves.toEqual({
      ok: true, deviceIds: [D1], scope: { kind: 'devices', siteId: null, deviceCount: 1 },
    });
  });

  it('keeps the caller order, not the row order', async () => {
    queue('devices', [{ id: D1, siteId: SITE_1 }, { id: D2, siteId: SITE_1 }]);
    const r = await resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [D2, D1] });
    expect(r).toMatchObject({ ok: true, deviceIds: [D2, D1] });
  });

  it('a listed device outside the grant site allowlist is site_not_in_scope', async () => {
    queue('devices', [{ id: D1, siteId: SITE_1 }]);
    await expect(resolveAnalysisFrame({ ...base, scope: 'devices', deviceIds: [D1], allowedSiteIds: [SITE_2] }))
      .resolves.toEqual({ ok: false, refusal: 'site_not_in_scope' });
  });
});
