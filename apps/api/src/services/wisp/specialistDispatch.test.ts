/**
 * Wisp W07 Task 5 — `dispatchSpecialistRequests`, the post-run step that hands
 * an assessment's recorded `request_specialist` calls to the coordinator.
 * The coordinator is mocked (its gates are unit-tested in coordinator.test.ts)
 * but `deriveRequestId` stays real: the request ids are the durable contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { WISP_SPECIALIST_KINDS, type RequestSpecialistInput } from '@breeze/shared';

const RUN_ID = '00000000-0000-4000-8000-0000000000a1';
const ORG_ID = '00000000-0000-4000-8000-0000000000a2';
const GRANT_ID = '00000000-0000-4000-8000-0000000000a3';
const REVISION_ID = '00000000-0000-4000-8000-0000000000a4';

const dbState = vi.hoisted(() => ({
  status: 'running' as string | null,
  updates: [] as Array<{ set: Record<string, unknown> }>,
  contexts: [] as string[],
}));

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => (dbState.status ? [{ status: dbState.status }] : [])),
    };
    return builder;
  });
  const update = vi.fn(() => ({
    set: vi.fn((set: Record<string, unknown>) => ({
      where: vi.fn(async () => {
        dbState.updates.push({ set });
      }),
    })),
  }));
  return {
    db: { select, update },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      dbState.contexts.push('system');
      return fn();
    }),
  };
});

const wispEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  wispEnabled,
}));

const captureException = vi.hoisted(() => vi.fn());
vi.mock('../sentry', () => ({ captureException }));

const requestSpecialist = vi.hoisted(() => vi.fn());
vi.mock('./coordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./coordinator')>()),
  requestSpecialist,
}));

import { deriveRequestId } from './coordinator';
import { dispatchSpecialistRequests } from './specialistDispatch';
import { MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT, SPECIALIST_KINDS } from './specialistPolicy';
import type { LoopResult, RunContext } from '../aiAgents/runLoopTypes';

function ctxFor(run: Partial<{ profile: string; grantId: string | null; grantRevisionId: string | null }> = {}): RunContext {
  return {
    run: {
      id: RUN_ID, orgId: ORG_ID, profile: 'assessment', grantId: GRANT_ID, grantRevisionId: REVISION_ID, ...run,
    },
  } as unknown as RunContext;
}

function resultWith(requests: RequestSpecialistInput[]): LoopResult {
  return {
    outcome: {
      executedActions: [], proposedActions: [], deniedActions: [],
      assessment: {
        concernsRaised: [], concernsUpdated: [], nudges: [], proposedActions: [], specialistRequests: requests,
      },
    },
  } as unknown as LoopResult;
}

const req = (kind: RequestSpecialistInput['kind'], reason = `Needs a ${kind} specialist now`, params: Record<string, unknown> = {}) =>
  ({ kind, params, reason });

function persistedQuery(): { sql: string; params: unknown[] } {
  expect(dbState.updates).toHaveLength(1);
  return new PgDialect().sqlToQuery(dbState.updates[0]!.set.outcome as SQL);
}

function persistedResults(): unknown {
  const { params } = persistedQuery();
  const json = params.find((p) => typeof p === 'string' && p.startsWith('['));
  return JSON.parse(String(json));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.status = 'running';
  dbState.updates = [];
  dbState.contexts = [];
  wispEnabled.mockReturnValue(true);
  requestSpecialist.mockResolvedValue({ admitted: true, runId: '00000000-0000-4000-8000-0000000000c1' });
});

describe('dispatchSpecialistRequests (Wisp W07)', () => {
  it('dispatches captured requests in order with deterministic request ids, the run as requester and the reason', async () => {
    const result = resultWith([req('sweep', 'Backups failed twice at Greenwood'), req('patch_plan', 'Patch backlog grew', { a: 1 })]);
    await dispatchSpecialistRequests(ctxFor(), result);

    expect(requestSpecialist).toHaveBeenCalledTimes(2);
    expect(requestSpecialist.mock.calls[0]).toEqual([
      { grantId: GRANT_ID, grantRevisionId: REVISION_ID, orgId: ORG_ID, kind: 'sweep', params: {}, requestedByRunId: RUN_ID },
      { requester: { kind: 'run' }, requestId: deriveRequestId(RUN_ID, 0), reason: 'Backups failed twice at Greenwood' },
    ]);
    expect(requestSpecialist.mock.calls[1]).toEqual([
      { grantId: GRANT_ID, grantRevisionId: REVISION_ID, orgId: ORG_ID, kind: 'patch_plan', params: { a: 1 }, requestedByRunId: RUN_ID },
      { requester: { kind: 'run' }, requestId: deriveRequestId(RUN_ID, 1), reason: 'Patch backlog grew' },
    ]);
    expect(deriveRequestId(RUN_ID, 0)).not.toBe(deriveRequestId(RUN_ID, 1));
  });

  it('caps at MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT and records too_many_requests for the rest without calling the coordinator', async () => {
    expect(MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT).toBe(3);
    const result = resultWith([req('sweep'), req('analysis'), req('patch_plan'), req('operator_recipe'), req('sweep')]);
    await dispatchSpecialistRequests(ctxFor(), result);

    expect(requestSpecialist).toHaveBeenCalledTimes(3);
    const results = result.outcome.assessment!.specialistResults!;
    expect(results).toHaveLength(5);
    expect(results[3]).toEqual({ requestId: deriveRequestId(RUN_ID, 3), kind: 'operator_recipe', refused: 'too_many_requests' });
    expect(results[4]).toEqual({ requestId: deriveRequestId(RUN_ID, 4), kind: 'sweep', refused: 'too_many_requests' });
  });

  it('is a no-op for a non-assessment run', async () => {
    const result = resultWith([req('sweep')]);
    await dispatchSpecialistRequests(ctxFor({ profile: 'triage' }), result);
    expect(requestSpecialist).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
    expect(result.outcome.assessment!.specialistResults).toBeUndefined();
  });

  it('is a no-op for a grant-less run or one missing its pinned revision', async () => {
    await dispatchSpecialistRequests(ctxFor({ grantId: null, grantRevisionId: null }), resultWith([req('sweep')]));
    await dispatchSpecialistRequests(ctxFor({ grantRevisionId: null }), resultWith([req('sweep')]));
    expect(requestSpecialist).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('is a no-op with Wisp disabled', async () => {
    wispEnabled.mockReturnValue(false);
    const result = resultWith([req('sweep')]);
    await dispatchSpecialistRequests(ctxFor(), result);
    expect(requestSpecialist).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('is a no-op when nothing was requested', async () => {
    await dispatchSpecialistRequests(ctxFor(), resultWith([]));
    expect(requestSpecialist).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('dispatches nothing under a run that has already left `running` (cancelled / reaped)', async () => {
    dbState.status = 'cancelled';
    await dispatchSpecialistRequests(ctxFor(), resultWith([req('sweep')]));
    expect(requestSpecialist).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('persists specialistResults on the outcome — admissions, approval cards, refusals and a dispatch_failed — in system context', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    requestSpecialist
      .mockResolvedValueOnce({ admitted: true, runId: 'run-child', report: { sent: 3 } })
      .mockResolvedValueOnce({ needsApproval: true, intentId: 'intent-1' })
      .mockRejectedValueOnce(new Error('launcher exploded'));
    const result = resultWith([req('sweep'), req('patch_plan'), req('operator_recipe')]);
    await dispatchSpecialistRequests(ctxFor(), result);

    const expected = [
      { requestId: deriveRequestId(RUN_ID, 0), kind: 'sweep', admitted: true, runId: 'run-child' },
      { requestId: deriveRequestId(RUN_ID, 1), kind: 'patch_plan', needsApproval: true, intentId: 'intent-1' },
      { requestId: deriveRequestId(RUN_ID, 2), kind: 'operator_recipe', refused: 'dispatch_failed' },
    ];
    // In memory (finishRun serializes `result.outcome` after this) …
    expect(result.outcome.assessment!.specialistResults).toEqual(expected);
    // … and a targeted jsonb merge of just that key onto the persisted row.
    expect(persistedResults()).toEqual(expected);
    expect(persistedQuery().sql).toContain('specialistResults');
    expect(dbState.contexts.length).toBeGreaterThan(0);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a coordinator refusal is recorded with its detail; a throw for one request never stops the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    requestSpecialist
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ refused: 'budget_exhausted' })
      .mockResolvedValueOnce({ refused: 'admission_skipped', detail: 'analysis_not_available' });
    const result = resultWith([req('sweep'), req('analysis'), req('analysis')]);
    await expect(dispatchSpecialistRequests(ctxFor(), result)).resolves.toBeUndefined();

    expect(requestSpecialist).toHaveBeenCalledTimes(3);
    expect(result.outcome.assessment!.specialistResults).toEqual([
      { requestId: deriveRequestId(RUN_ID, 0), kind: 'sweep', refused: 'dispatch_failed' },
      { requestId: deriveRequestId(RUN_ID, 1), kind: 'analysis', refused: 'budget_exhausted' },
      { requestId: deriveRequestId(RUN_ID, 2), kind: 'analysis', refused: 'admission_skipped', detail: 'analysis_not_available' },
    ]);
  });

  it('a failed persist is reported and swallowed; the in-memory results stay for finishRun', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db } = await import('../../db');
    vi.mocked(db.update).mockImplementationOnce(() => { throw new Error('db down'); });
    const result = resultWith([req('sweep')]);
    await expect(dispatchSpecialistRequests(ctxFor(), result)).resolves.toBeUndefined();
    expect(result.outcome.assessment!.specialistResults).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('specialist kind parity (shared ↔ API)', () => {
  it('WISP_SPECIALIST_KINDS (shared) equals SPECIALIST_KINDS (specialistPolicy.ts)', () => {
    expect([...WISP_SPECIALIST_KINDS]).toEqual([...SPECIALIST_KINDS]);
  });
});
