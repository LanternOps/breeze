import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Fake Drizzle executor (pattern: services/contacts/crud.test.ts). Statement
 * shapes and ORDER are asserted — the lock-before-write and supersede-before-
 * insert sequencing is the whole point of the service.
 */
interface SelectCall { table: unknown; where?: unknown; lockMode?: string; seq: number; limit?: number }
interface Capture {
  selects: SelectCall[];
  inserts: Array<{ table: unknown; values: Record<string, unknown>; seq: number }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; where?: unknown; seq: number }>;
}

function thenable(rows: Array<Record<string, unknown>>, call: SelectCall) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.limit = (n: number) => { call.limit = n; return thenable(rows.slice(0, n), call); };
  promise.for = (mode: string) => { call.lockMode = mode; return thenable(rows, call); };
  promise.orderBy = () => thenable(rows, call);
  return promise;
}

function makeExec(selectRows: Array<Array<Record<string, unknown>>> = [], updateReturningRows: Array<Array<Record<string, unknown>>> = []) {
  const queue = [...selectRows];
  // Consumed only by an update chain that actually calls `.returning(...)`
  // (restoreDeviceFunction's reactivate step); every other update in this
  // file never calls `.returning()`, so this queue stays untouched for them
  // and the pre-existing `[{ id: 'x' }]` fallback below is unchanged.
  const updateQueue = [...updateReturningRows];
  const calls: Capture = { selects: [], inserts: [], updates: [] };
  let seq = 0;
  let generated = 0;
  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const rows = queue.shift() ?? [];
        const entry: SelectCall = { table, seq: (seq += 1) };
        calls.selects.push(entry);
        const tail = {
          where: (condition: unknown) => { entry.where = condition; return thenable(rows, entry); },
          innerJoin: () => tail,
        };
        return tail;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.inserts.push({ table, values, seq: (seq += 1) });
        generated += 1;
        const row = { id: `generated-${generated}`, ...values };
        return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const entry = { table, set, seq: (seq += 1) } as Capture['updates'][number];
        calls.updates.push(entry);
        return {
          where: (condition: unknown) => {
            entry.where = condition;
            return Object.assign(Promise.resolve([]), {
              returning: () => Promise.resolve(updateQueue.length > 0 ? updateQueue.shift()! : [{ id: 'x' }]),
            });
          },
        };
      },
    }),
  };
  return { exec, calls };
}

const holder: { exec: ReturnType<typeof makeExec>['exec'] | null } = { exec: null };
const transactionSpy = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(holder.exec));

vi.mock('../db', () => ({
  db: {
    transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionSpy(cb),
    select: (...args: unknown[]) => (holder.exec as unknown as { select: (...a: unknown[]) => unknown }).select(...args),
  },
}));

import {
  DeviceFunctionError,
  applyDesignFunctions,
  clearDeviceFunction,
  getDeviceFunction,
  restoreDeviceFunction,
  upsertDeviceFunction,
} from './deviceFunction';
import { devices } from '../db/schema/devices';
import { deviceFunctionAssessments } from '../db/schema/deviceFunctionAssessments';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const OTHER_DEVICE = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const REPORT_RUN = '66666666-6666-4666-8666-666666666666';

const dialect = new PgDialect();
function compile(condition: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(condition as never);
  return { sql: q.sql, params: q.params };
}

const DEVICE_ROW = { id: DEVICE, orgId: ORG };
const ACTIVE_AI = {
  id: 'assess-ai', orgId: ORG, deviceId: DEVICE, functionKey: 'file_server', label: null,
  confidence: '0.80', evidence: ['smb open'], source: 'ai', runId: RUN, reportRunId: REPORT_RUN,
  active: true, supersededAt: null, createdByUserId: null, createdAt: new Date('2026-09-01T00:00:00Z'),
};
const ACTIVE_MANUAL = { ...ACTIVE_AI, id: 'assess-manual', source: 'manual', confidence: null, evidence: [], functionKey: 'print_server' };

beforeEach(() => {
  holder.exec = null;
  transactionSpy.mockClear();
});

function seed(rows: Array<Array<Record<string, unknown>>>, updateReturningRows: Array<Array<Record<string, unknown>>> = []) {
  const made = makeExec(rows, updateReturningRows);
  holder.exec = made.exec;
  return made.calls;
}

describe('upsertDeviceFunction', () => {
  it("locks the device row FOR UPDATE in the device's org before writing", async () => {
    const calls = seed([[DEVICE_ROW], []]);
    await upsertDeviceFunction({ deviceId: DEVICE, orgId: ORG, functionKey: 'file_server', source: 'manual', userId: USER });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const first = calls.selects[0]!;
    expect(first.table).toBe(devices);
    expect(first.lockMode).toBe('update');
    const { sql, params } = compile(first.where);
    expect(sql).toMatch(/"id" = \$1/);
    expect(sql).toMatch(/"org_id" = \$2/);
    expect(params).toEqual([DEVICE, ORG]);
    // Every write happens AFTER the lock.
    for (const w of [...calls.inserts, ...calls.updates]) expect(w.seq).toBeGreaterThan(first.seq);
  });

  it('throws device_not_found when the device is not in the org and writes nothing', async () => {
    const calls = seed([[]]);
    await expect(
      upsertDeviceFunction({ deviceId: DEVICE, orgId: ORG, functionKey: 'file_server', source: 'manual' }),
    ).rejects.toMatchObject({ code: 'device_not_found' });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it('keeps a manual row when an ai write arrives (kept_manual, no insert, projection unchanged)', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_MANUAL]]);
    const result = await upsertDeviceFunction({
      deviceId: DEVICE, orgId: ORG, functionKey: 'file_server', source: 'ai', confidence: 0.9, runId: RUN,
    });
    expect(result).toEqual({ outcome: 'kept_manual', assessmentId: null });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it('supersedes an active ai row, inserts, then rewrites the projection in one transaction', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]]);
    const result = await upsertDeviceFunction({
      deviceId: DEVICE, orgId: ORG, functionKey: 'domain_controller', source: 'ai', confidence: 0.75,
      evidence: ['ntds present'], runId: RUN, reportRunId: REPORT_RUN,
    });
    expect(result.outcome).toBe('written');
    expect(result.assessmentId).toBe('generated-1');

    const supersede = calls.updates.find((u) => u.table === deviceFunctionAssessments)!;
    expect(supersede.set.active).toBe(false);
    expect(supersede.set.supersededAt).toBeInstanceOf(Date);
    const { params: supersedeParams } = compile(supersede.where);
    expect(supersedeParams).toEqual(['assess-ai', ORG]);

    const insert = calls.inserts[0]!;
    expect(insert.table).toBe(deviceFunctionAssessments);
    expect(insert.values).toMatchObject({
      orgId: ORG, deviceId: DEVICE, functionKey: 'domain_controller', source: 'ai', confidence: '0.75',
      evidence: ['ntds present'], runId: RUN, reportRunId: REPORT_RUN, createdByUserId: null,
    });

    const projection = calls.updates.find((u) => u.table === devices)!;
    expect(projection.set).toMatchObject({ deviceFunction: 'domain_controller', deviceFunctionSource: 'ai' });
    const { params: projParams } = compile(projection.where);
    expect(projParams).toEqual([DEVICE, ORG]);

    expect(supersede.seq).toBeLessThan(insert.seq);
    expect(insert.seq).toBeLessThan(projection.seq);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('a manual write supersedes an ai row and stores confidence NULL with the actor', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]]);
    const result = await upsertDeviceFunction({
      deviceId: DEVICE, orgId: ORG, functionKey: 'custom:pos', label: 'POS terminal', source: 'manual',
      confidence: 0.5, userId: USER,
    });
    expect(result.outcome).toBe('written');
    expect(calls.updates.find((u) => u.table === deviceFunctionAssessments)).toBeDefined();
    expect(calls.inserts[0]!.values).toMatchObject({
      functionKey: 'custom:pos', label: 'POS terminal', source: 'manual', confidence: null, evidence: [],
      createdByUserId: USER, runId: null, reportRunId: null,
    });
    expect(calls.updates.find((u) => u.table === devices)!.set).toMatchObject({
      deviceFunction: 'custom:pos', deviceFunctionSource: 'manual',
    });
  });

  it('bounds evidence to 20 strings of 400 chars', async () => {
    const calls = seed([[DEVICE_ROW], []]);
    const evidence = Array.from({ length: 25 }, (_, i) => `e${i}-` + 'x'.repeat(500));
    await upsertDeviceFunction({ deviceId: DEVICE, orgId: ORG, functionKey: 'kiosk', source: 'ai', confidence: 1, evidence });
    const stored = calls.inserts[0]!.values.evidence as string[];
    expect(stored).toHaveLength(20);
    for (const e of stored) expect(e.length).toBeLessThanOrEqual(400);
  });

  it('rejects an unknown function key and a custom key without a label before touching the db', async () => {
    const calls = seed([[DEVICE_ROW], []]);
    await expect(
      upsertDeviceFunction({ deviceId: DEVICE, orgId: ORG, functionKey: 'nonsense', source: 'manual' }),
    ).rejects.toBeInstanceOf(DeviceFunctionError);
    await expect(
      upsertDeviceFunction({ deviceId: DEVICE, orgId: ORG, functionKey: 'custom:pos', source: 'manual' }),
    ).rejects.toMatchObject({ code: 'label_required' });
    expect(calls.selects).toHaveLength(0);
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

describe('clearDeviceFunction', () => {
  it('supersedes whatever is active (manual included) and nulls the projection', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_MANUAL]]);
    const result = await clearDeviceFunction({ deviceId: DEVICE, orgId: ORG, userId: USER });
    expect(result).toEqual({ outcome: 'cleared', supersededAssessmentId: 'assess-manual' });
    expect(calls.selects[0]!.lockMode).toBe('update');
    const supersede = calls.updates.find((u) => u.table === deviceFunctionAssessments)!;
    expect(supersede.set.active).toBe(false);
    expect(calls.inserts).toHaveLength(0);
    const projection = calls.updates.find((u) => u.table === devices)!;
    expect(projection.set).toMatchObject({ deviceFunction: null, deviceFunctionSource: null });
  });

  it('is a no-op write when nothing is active', async () => {
    const calls = seed([[DEVICE_ROW], []]);
    const result = await clearDeviceFunction({ deviceId: DEVICE, orgId: ORG, userId: USER });
    expect(result).toEqual({ outcome: 'cleared', supersededAssessmentId: null });
    expect(calls.updates.filter((u) => u.table === deviceFunctionAssessments)).toHaveLength(0);
    // The projection is still normalised to NULL so a drifted column cannot survive.
    expect(calls.updates.find((u) => u.table === devices)!.set).toMatchObject({ deviceFunction: null, deviceFunctionSource: null });
  });
});

describe('getDeviceFunction', () => {
  it('maps the active row to the DTO with a numeric confidence', async () => {
    seed([[ACTIVE_AI]]);
    const dto = await getDeviceFunction(DEVICE, ORG);
    expect(dto).toEqual({
      deviceId: DEVICE, functionKey: 'file_server', label: null, source: 'ai', confidence: 0.8,
      evidence: ['smb open'], assessedAt: '2026-09-01T00:00:00.000Z', runId: RUN, reportRunId: REPORT_RUN,
    });
  });

  it('returns the null DTO when nothing is active', async () => {
    const calls = seed([[]]);
    const dto = await getDeviceFunction(DEVICE, ORG);
    expect(dto).toEqual({
      deviceId: DEVICE, functionKey: null, label: null, source: null, confidence: null,
      evidence: [], assessedAt: null, runId: null, reportRunId: null,
    });
    const { params } = compile(calls.selects[0]!.where);
    expect(params).toContain(ORG);
    expect(params).toContain(DEVICE);
  });
});

describe('applyDesignFunctions', () => {
  it('skips device ids outside the org (skippedForeign) and never throws for them', async () => {
    // 1: org device-id set; then per accepted device: lock + active read.
    const calls = seed([[{ id: DEVICE }], [DEVICE_ROW], []]);
    const result = await applyDesignFunctions({
      orgId: ORG, reportRunId: REPORT_RUN, runId: RUN, userId: USER,
      functions: [{ functionKey: 'file_server', deviceIds: [DEVICE, OTHER_DEVICE], confidence: 0.9, evidence: ['smb'] }],
    });
    expect(result).toEqual({ written: 1, keptManual: 0, skippedForeign: 1 });
    expect(calls.inserts).toHaveLength(1);
    const { params } = compile(calls.selects[0]!.where);
    expect(params).toContain(ORG);
  });

  it('writes one ai row per approved device with the run and report ids, tallying kept_manual', async () => {
    const calls = seed([
      [{ id: DEVICE }, { id: OTHER_DEVICE }],
      [DEVICE_ROW], [],                       // DEVICE: no active row → written
      [{ id: OTHER_DEVICE, orgId: ORG }], [{ ...ACTIVE_MANUAL, deviceId: OTHER_DEVICE }], // manual → kept
    ]);
    const result = await applyDesignFunctions({
      orgId: ORG, reportRunId: REPORT_RUN, runId: RUN, userId: USER,
      functions: [{ functionKey: 'file_server', deviceIds: [DEVICE, OTHER_DEVICE], confidence: 0.9, evidence: ['smb'] }],
    });
    expect(result).toEqual({ written: 1, keptManual: 1, skippedForeign: 0 });
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]!.values).toMatchObject({
      deviceId: DEVICE, source: 'ai', runId: RUN, reportRunId: REPORT_RUN, confidence: '0.90', createdByUserId: USER,
    });
  });

  it('counts a device that vanished between the membership read and its lock as skippedForeign', async () => {
    // Membership says both are ours; DEVICE's FOR UPDATE read then finds no row
    // (deleted / moved concurrently) → counted, not thrown; OTHER_DEVICE still written.
    const calls = seed([
      [{ id: DEVICE }, { id: OTHER_DEVICE }],
      [],                                       // DEVICE: lock finds nothing
      [{ id: OTHER_DEVICE, orgId: ORG }], [],   // OTHER_DEVICE: written
    ]);
    const result = await applyDesignFunctions({
      orgId: ORG, reportRunId: REPORT_RUN, runId: RUN, userId: USER,
      functions: [{ functionKey: 'file_server', deviceIds: [DEVICE, OTHER_DEVICE], confidence: 0.9, evidence: [] }],
    });
    expect(result).toEqual({ written: 1, keptManual: 0, skippedForeign: 1 });
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]!.values).toMatchObject({ deviceId: OTHER_DEVICE });
  });

  it('rejects an invalid function key up front', async () => {
    seed([[{ id: DEVICE }]]);
    await expect(
      applyDesignFunctions({
        orgId: ORG, reportRunId: REPORT_RUN, runId: null, userId: USER,
        functions: [{ functionKey: 'custom:pos', deviceIds: [DEVICE], confidence: 0.9, evidence: [] }],
      }),
    ).rejects.toMatchObject({ code: 'label_required' });
  });
});

describe('restoreDeviceFunction', () => {
  it("locks the device row FOR UPDATE in the device's org before any write", async () => {
    const calls = seed([[DEVICE_ROW], []], [[{ functionKey: 'file_server', source: 'manual' }]]);
    await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: 'assess-x', userId: USER });
    const first = calls.selects[0]!;
    expect(first.table).toBe(devices);
    expect(first.lockMode).toBe('update');
    for (const w of [...calls.inserts, ...calls.updates]) expect(w.seq).toBeGreaterThan(first.seq);
  });

  it('throws device_not_found when the device is not in the org and writes nothing', async () => {
    const calls = seed([[]]);
    await expect(
      restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: null }),
    ).rejects.toMatchObject({ code: 'device_not_found' });
    expect(calls.updates).toHaveLength(0);
  });

  it("reactivates the given assessment, supersedes the previously-active row, and projects the REACTIVATED row's own functionKey/source", async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]], [[{ functionKey: 'print_server', source: 'manual' }]]);
    const result = await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: 'assess-prior', userId: USER });
    expect(result).toEqual({ outcome: 'restored', supersededAssessmentId: 'assess-ai' });

    const supersede = calls.updates.find((u) => u.table === deviceFunctionAssessments && u.set.active === false)!;
    expect(supersede.set.supersededAt).toBeInstanceOf(Date);
    const { params: supersedeParams } = compile(supersede.where);
    expect(supersedeParams).toEqual(['assess-ai', ORG]);

    const reactivate = calls.updates.find((u) => u.table === deviceFunctionAssessments && u.set.active === true)!;
    expect(reactivate.set.supersededAt).toBeNull();
    const { params: reactivateParams } = compile(reactivate.where);
    expect(reactivateParams).toEqual(['assess-prior', DEVICE, ORG]);

    // The projection comes from the REACTIVATED row, not from the input.
    const projection = calls.updates.find((u) => u.table === devices)!;
    expect(projection.set).toMatchObject({ deviceFunction: 'print_server', deviceFunctionSource: 'manual' });

    expect(supersede.seq).toBeLessThan(reactivate.seq);
    expect(reactivate.seq).toBeLessThan(projection.seq);
  });

  it('does not supersede when the assessment being restored is already the active row', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]], [[{ functionKey: 'file_server', source: 'ai' }]]);
    const result = await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: 'assess-ai', userId: USER });
    expect(result.supersededAssessmentId).toBeNull();
    expect(calls.updates.filter((u) => u.set.active === false)).toHaveLength(0);
  });

  it('clears the projection and supersedes the active row when assessmentId is null (the device had no function before the design ran)', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]]);
    const result = await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: null, userId: USER });
    expect(result).toEqual({ outcome: 'cleared', supersededAssessmentId: 'assess-ai' });
    const projection = calls.updates.find((u) => u.table === devices)!;
    expect(projection.set).toMatchObject({ deviceFunction: null, deviceFunctionSource: null });
    // No reactivate attempted when assessmentId is null.
    expect(calls.updates.filter((u) => u.set.active === true)).toHaveLength(0);
  });

  it('clears without a supersede update when nothing was active and assessmentId is null', async () => {
    const calls = seed([[DEVICE_ROW], []]);
    const result = await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: null, userId: USER });
    expect(result).toEqual({ outcome: 'cleared', supersededAssessmentId: null });
    expect(calls.updates.filter((u) => u.table === deviceFunctionAssessments)).toHaveLength(0);
  });

  it('falls back to a clear when the prior assessment row no longer exists (erased), still superseding whatever was active', async () => {
    const calls = seed([[DEVICE_ROW], [ACTIVE_AI]], [[]]); // reactivate update matches no row
    const result = await restoreDeviceFunction({ deviceId: DEVICE, orgId: ORG, assessmentId: 'assess-erased', userId: USER });
    expect(result).toEqual({ outcome: 'cleared', supersededAssessmentId: 'assess-ai' });
    const projection = calls.updates.find((u) => u.table === devices)!;
    expect(projection.set).toMatchObject({ deviceFunction: null, deviceFunctionSource: null });
  });
});
