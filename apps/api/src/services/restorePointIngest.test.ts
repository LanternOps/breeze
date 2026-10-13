import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
const { state, dbMock, contextCalls, captureMock } = vi.hoisted(() => {
  const state = {
    updateReturning: [] as Array<{ id: string }>,
    updateError: null as Error | null,
    selectRows: [] as Array<Record<string, unknown>>,
    sets: [] as Array<Record<string, unknown>>,
    updateWheres: [] as unknown[],
    selects: 0,
  };
  const contextCalls: string[] = [];
  const dbMock = {
    update: vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => ({
          returning: vi.fn(async () => {
            contextCalls.push('update');
            state.sets.push(set);
            state.updateWheres.push(where);
            if (state.updateError) throw state.updateError;
            return state.updateReturning;
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            state.selects += 1;
            return state.selectRows;
          }),
        })),
      })),
    })),
  };
  return { state, dbMock, contextCalls, captureMock: vi.fn() };
});

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: (fn: () => unknown) => {
    contextCalls.push('runOutsideDbContext');
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    contextCalls.push('withSystemDbAccessContext');
    return fn();
  },
}));
vi.mock('./sentry', () => ({ captureException: captureMock, captureMessage: captureMessageMock }));

import { ingestRestorePointOutcome } from './restorePointIngest';
import { RESTORE_POINT_SUPERSEDED_MESSAGE } from './restorePointRequest';

const REQUEST_ID = '3f1d1a0e-0000-4000-8000-000000000001';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const ctx = { orgId: ORG_ID, deviceId: DEVICE_ID, deviceCommandId: COMMAND_ID };

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    requestId: REQUEST_ID,
    sequenceNumber: '42',
    description: 'Breeze: install 3 updates',
    attemptedAt: '2026-09-02T18:03:11Z',
    durationMs: 1234,
    ...overrides,
  };
}

function renderWhere(where: unknown) {
  return new PgDialect().sqlToQuery(where as SQL);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.updateReturning = [{ id: 'row-1' }];
  state.updateError = null;
  state.selectRows = [];
  state.sets.length = 0;
  state.updateWheres.length = 0;
  state.selects = 0;
  contextCalls.length = 0;
  captureMock.mockReset();
  captureMessageMock.mockReset();
  dbMock.update.mockClear();
  dbMock.select.mockClear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('ingestRestorePointOutcome — terminalisation', () => {
  it('UPDATEs the requested row in a fresh system context and reports terminalised', async () => {
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'terminalised' });
    expect(contextCalls.slice(0, 3)).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext', 'update']);
    expect(state.sets[0]).toMatchObject({
      status: 'created',
      sequenceNumber: 42n,
      description: 'Breeze: install 3 updates',
      message: null,
      acceptedExistingPoint: false,
      existingPointAgeMinutes: null,
      frequencyMinutes: null,
      durationMs: 1234,
      attemptedAt: new Date('2026-09-02T18:03:11Z'),
      receivedAt: expect.any(Date),
      deviceCommandId: COMMAND_ID,
    });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is an UPDATE-only, tenant-guarded compare-and-set on status = requested', async () => {
    await ingestRestorePointOutcome(outcome(), ctx);
    const { sql, params } = renderWhere(state.updateWheres[0]);
    expect(sql).toContain('"request_id" = $');
    expect(sql).toContain('"org_id" = $');
    expect(sql).toContain('"device_id" = $');
    expect(sql).toContain('"status" = $');
    // A row already linked to a DIFFERENT command is not claimable.
    expect(sql).toMatch(/"device_command_id" is null or .*"device_command_id" = \$/);
    expect(params).toEqual(expect.arrayContaining([REQUEST_ID, ORG_ID, DEVICE_ID, 'requested', COMMAND_ID]));
  });

  it('sets acceptedExistingPoint and the age/frequency fields on the throttle path', async () => {
    await ingestRestorePointOutcome(
      outcome({ status: 'existing_accepted', existingPointAgeMinutes: 240, frequencyMinutes: 1440 }),
      ctx,
    );
    expect(state.sets[0]).toMatchObject({
      status: 'existing_accepted', acceptedExistingPoint: true, existingPointAgeMinutes: 240, frequencyMinutes: 1440,
    });
  });

  it('stores an int64 sequence number without loss', async () => {
    await ingestRestorePointOutcome(outcome({ sequenceNumber: '9223372036854775807' }), ctx);
    expect(state.sets[0]!.sequenceNumber).toBe(9223372036854775807n);
  });

  it('stores a null sequence number when the agent sent none', async () => {
    await ingestRestorePointOutcome(outcome({ sequenceNumber: undefined, status: 'unsupported' }), ctx);
    expect(state.sets[0]!.sequenceNumber).toBeNull();
  });

  it.each(['', 'not a date', '2026-13-45T99:99:99Z', '0000-01-01T00:00:00Z', '+275760-09-13T00:00:00.000Z'])('stores attemptedAt null for an unparseable agent timestamp %j', async (attemptedAt) => {
    const res = await ingestRestorePointOutcome(outcome({ attemptedAt }), ctx);
    expect(res.outcome).toBe('terminalised');
    expect(state.sets[0]!.attemptedAt).toBeNull();
  });

  it('does not touch device_command_id when no command id is known', async () => {
    await ingestRestorePointOutcome(outcome(), { orgId: ORG_ID, deviceId: DEVICE_ID, deviceCommandId: null });
    expect(state.sets[0]).not.toHaveProperty('deviceCommandId');
    const { sql } = renderWhere(state.updateWheres[0]);
    expect(sql).not.toContain('device_command_id');
  });
});

describe('ingestRestorePointOutcome — invalid outcomes never write (decision 2)', () => {
  it.each([
    ['unknown_status', outcome({ status: 'probably_fine' })],
    ['unknown_status', outcome({ status: 'requested' })],
    ['malformed', outcome({ sequenceNumber: 9223372036854775807 })],
    ['malformed', outcome({ message: 'x'.repeat(10_001) })],
    ['malformed', outcome({ requestId: 'not-a-uuid' })],
    ['malformed', null],
  ])('%s: no DB access, no throw, a structured warning without agent free text', async (reason, raw) => {
    const res = await ingestRestorePointOutcome(raw, ctx);
    expect(res).toEqual({ outcome: 'invalid', reason });
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnSpy.mock.calls[0]);
    expect(logged).toContain(reason);
    expect(logged).toContain(DEVICE_ID);
    expect(logged).not.toContain('xxxxxxxxxx');
  });
});

describe('ingestRestorePointOutcome — alertable signals', () => {
  it('reports an unknown status (version skew) to Sentry by event code only', async () => {
    await ingestRestorePointOutcome(outcome({ status: 'probably_fine' }), ctx);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]![1]).toEqual({ eventCode: 'restore_point_outcome_unknown_status' });
  });

  it('does not report a merely malformed outcome to Sentry', async () => {
    await ingestRestorePointOutcome(outcome({ sequenceNumber: 42 }), ctx);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('reports an outcome for an unrecorded request, but not the expected skipped_disabled case', async () => {
    state.updateReturning = [];
    await ingestRestorePointOutcome(outcome({ status: 'skipped_disabled' }), ctx);
    expect(captureMessageMock).not.toHaveBeenCalled();
    await ingestRestorePointOutcome(outcome(), ctx);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]![1]).toEqual({ eventCode: 'restore_point_outcome_unrequested' });
  });

  it('tags the write-failure capture with a bounded label', async () => {
    state.updateError = new Error('connection reset');
    await ingestRestorePointOutcome(outcome(), ctx);
    expect(captureMock.mock.calls[0]![2]).toEqual({ restore_point_ingest: 'write_failed' });
  });
});

describe('ingestRestorePointOutcome — discarded with a reason (decision 3)', () => {
  beforeEach(() => {
    state.updateReturning = [];
  });

  it('no_requested_row: a forged or stale requestId creates nothing', async () => {
    state.selectRows = [];
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'no_requested_row' });
    expect(state.selects).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain('no_requested_row');
  });

  it('no_requested_row for skipped_disabled is expected (enabled:false patch block) and logs at info', async () => {
    const res = await ingestRestorePointOutcome(outcome({ status: 'skipped_disabled', sequenceNumber: undefined }), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'no_requested_row' });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('tenant_mismatch: a row owned by another org/device is left alone and reported', async () => {
    state.selectRows = [{ orgId: 'org-OTHER', deviceId: 'dev-OTHER', status: 'requested', message: null, deviceCommandId: null }];
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'tenant_mismatch' });
    expect(captureMock).toHaveBeenCalledTimes(1);
    // The other tenant's identifiers never reach the log.
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('org-OTHER');
  });

  it('command_mismatch: a requested row bound to a different command', async () => {
    state.selectRows = [{ orgId: ORG_ID, deviceId: DEVICE_ID, status: 'requested', message: null, deviceCommandId: 'other-cmd' }];
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'command_mismatch' });
  });

  it('superseded: the row was failed by the delivery-time supersede', async () => {
    state.selectRows = [{ orgId: ORG_ID, deviceId: DEVICE_ID, status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE, deviceCommandId: COMMAND_ID }];
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'superseded' });
  });

  it('already_terminal: a replayed frame does not rewrite the row', async () => {
    state.selectRows = [{ orgId: ORG_ID, deviceId: DEVICE_ID, status: 'created', message: null, deviceCommandId: COMMAND_ID }];
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'discarded', reason: 'already_terminal' });
    expect(state.sets).toHaveLength(1); // the one guarded UPDATE that matched nothing
  });
});

describe('ingestRestorePointOutcome — failure isolation (decision 5)', () => {
  it('a ledger write failure is logged + captured and never throws', async () => {
    state.updateError = new Error('connection reset');
    const res = await ingestRestorePointOutcome(outcome(), ctx);
    expect(res).toEqual({ outcome: 'failed' });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
