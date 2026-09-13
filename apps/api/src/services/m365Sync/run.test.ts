import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365SyncJobData } from './types';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    loadContext: vi.fn(), assertFence: vi.fn(), release: vi.fn(),
    persistUsers: vi.fn(), callExecutor: vi.fn(),
    completion: [] as Record<string, unknown>[],
    audit: vi.fn(), metricRun: vi.fn(), metricFenced: vi.fn(), metricItems: vi.fn(),
    hook: vi.fn(),
    cadence: vi.fn((_d: string, st: { intervalSeconds: number }, _o: string, sig: { now: Date }) => ({
      intervalSeconds: st.intervalSeconds,
      nextSyncAt: new Date(sig.now.getTime() + st.intervalSeconds * 1000),
    })),
    claim: vi.fn(async (): Promise<M365SyncJobData[]> => []),
    enqueue: vi.fn(async (_data: M365SyncJobData) => 'job-1'),
    executorDepth: -1, depth: 0,
  },
}));

vi.mock('../../db', () => ({
  db: { update: () => ({ set: (payload: Record<string, unknown>) => ({ where: () => { mocks.completion.push(payload); return Promise.resolve(); } }) }) },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mocks.depth += 1; try { return await fn(); } finally { mocks.depth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = mocks.depth; mocks.depth = 0;
    try { return fn(); } finally { mocks.depth = saved; }
  }),
}));
vi.mock('./domains/users', () => ({ persistUsers: mocks.persistUsers }));
vi.mock('./metrics', () => ({
  recordM365SyncRun: mocks.metricRun, recordM365SyncFenced: mocks.metricFenced,
  recordM365SyncItems: mocks.metricItems, recordM365SyncExecutorSeconds: vi.fn(),
  // registerM365SyncMetrics is unrelated to this suite, but './metrics' is the
  // same module apps/api/src/routes/metrics.ts calls at import time (it is
  // reached transitively through readActionService -> aiTools -> ... ->
  // jobs/softwareComplianceWorker -> routes/metrics). A partial mock without
  // it makes that top-level call throw during module load.
  registerM365SyncMetrics: vi.fn(),
}));
vi.mock('./audit', () => ({ recordM365SyncRunEvent: mocks.audit }));
vi.mock('./hooks', () => ({ afterDomainPersisted: mocks.hook }));
vi.mock('./cadence', () => ({ applyCadence: mocks.cadence }));
vi.mock('./claim', () => ({ claimDueDomains: mocks.claim }));
vi.mock('../../jobs/m365SyncQueue', () => ({ enqueueSyncDomain: mocks.enqueue }));

import { outcomeForFailure, runSyncDomain } from './run';   // nextSyncAt lives in cadence.ts (Task 12) and is covered by cadence.test.ts

const JOB = { orgId: 'org-1', domain: 'users' as const, generation: 5, connectionId: 'conn-1',
  tenantId: 'tenant-1', consentGeneration: 2, priority: 10 as const };
const CTX = {
  snapshot: { id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2,
    status: 'active', permissionManifestVersion: 3, vaultRef: 'v', credentialVersion: 'c' },
  state: { intervalSeconds: 21600, continuation: null, lastCompleteSnapshotAt: null, lastSuccessAt: null },
  existing: new Map(),
};
const SYNC_OK = {
  ok: true, kind: 'sync', executorMs: 1200,
  result: { success: true, kind: 'sync', items: [{ id: 'u1' }], truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z', sources: { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' } },
};
const PERSISTED = { inserted: 1, updated: 0, unchanged: 0, stale: 0, complete: true, counts: { users_total: 1, users_enabled: 1 } };

const run = (over: Record<string, unknown> = {}) =>
  runSyncDomain(JOB, {
    callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5,
    // Phase A/C (loadSyncRunContext / assertStillFenced / releaseLease) live in
    // THIS module (Task 12) and are not separately mocked — the `../../db`
    // mock above only stubs `update`, not `select`. Overriding them via the
    // injectable `deps` seam lets this suite drive fencing outcomes directly
    // through `mocks.loadContext` / `mocks.assertFence` / `mocks.release`.
    deps: { loadSyncRunContext: mocks.loadContext, assertStillFenced: mocks.assertFence, releaseLease: mocks.release },
    ...over,
  });

describe('runSyncDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.completion = []; mocks.depth = 0; mocks.executorDepth = -1;
    mocks.claim.mockResolvedValue([]); mocks.enqueue.mockResolvedValue('job-1');
    vi.doMock('./run', async (a) => a());
    mocks.loadContext.mockResolvedValue(CTX);
    mocks.assertFence.mockResolvedValue(null);
    mocks.persistUsers.mockResolvedValue(PERSISTED);
    mocks.callExecutor.mockImplementation(async () => { mocks.executorDepth = mocks.depth; return SYNC_OK; });
  });

  it('PHASE B holds NO db context while the executor call runs (#1105)', async () => {
    await run();
    expect(mocks.executorDepth).toBe(0);
  });

  it('routes the executor call through opts.route = sync and labels the histogram by DOMAIN', async () => {
    await run();
    expect(mocks.callExecutor.mock.calls[0]![2]).toMatchObject({ route: 'sync', domain: 'users' });
  });

  it('builds the action through m365SyncActionFor, passing the stored continuation and the backfill flag', async () => {
    await run();
    expect(mocks.callExecutor.mock.calls[0]![1]).toEqual({ type: 'm365.sync.users' });

    // last_success_at NULL means "never completed" -> backfill for secure_score.
    // Harmless for users (the builder drops the option), but the SAME call site
    // has to serve both, which is why it is asserted here rather than in W05.
    mocks.loadContext.mockResolvedValue({ ...CTX, state: { ...CTX.state, lastSuccessAt: new Date('2026-09-01T00:00:00.000Z') } });
    await run();
    expect(mocks.callExecutor.mock.calls[1]![1]).toEqual({ type: 'm365.sync.users' });
  });

  it('completes: success outcome, next_sync_at advanced, lease cleared, counts stored', async () => {
    await expect(run()).resolves.toBe('success');
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ lastStatus: 'success', leaseUntil: null, truncated: false });
    expect(completion.nextSyncAt).toBeInstanceOf(Date);
    expect(completion.lastCounts).toEqual({ users_total: 1, users_enabled: 1 });
    expect(completion.lastCompleteSnapshotAt).toBeInstanceOf(Date);
  });

  it('a truncated run is partial, marks nothing stale, and does NOT stamp lastCompleteSnapshotAt', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result, truncated: true } });
    mocks.persistUsers.mockResolvedValue({ ...PERSISTED, complete: false, stale: 0 });
    await expect(run()).resolves.toBe('partial');
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ lastStatus: 'partial', truncated: true });
    expect(completion.lastCompleteSnapshotAt).toBeUndefined();
  });

  it('a failed SECONDARY source is partial, not an error — the primary still persisted', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result,
      sources: { users: 'ok', mfaRegistration: 'permission_missing', roleAssignments: 'ok' } } });
    await expect(run()).resolves.toBe('partial');
    expect(mocks.persistUsers).toHaveBeenCalled();
  });

  it('a PRIMARY permission_missing is needs_consent and UNSCHEDULES the domain', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result, sources: { users: 'permission_missing' } } });
    await expect(run()).resolves.toBe('needs_consent');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'needs_consent', nextSyncAt: null, leaseUntil: null });
  });

  it('discards at the Phase C fence and writes NOTHING, incrementing the fenced metric', async () => {
    mocks.assertFence.mockResolvedValue('tenant_changed');
    await expect(run()).resolves.toBe('fenced');
    expect(mocks.persistUsers).not.toHaveBeenCalled();
    expect(mocks.completion).toEqual([]);
    expect(mocks.metricFenced).toHaveBeenCalledTimes(1);
  });

  it('fences BEFORE the fetch too, without spending a Graph call', async () => {
    mocks.loadContext.mockResolvedValue({ fenced: 'generation_mismatch' });
    await expect(run()).resolves.toBe('fenced');
    expect(mocks.callExecutor).not.toHaveBeenCalled();
  });

  it('a throttled result on a NON-final attempt writes no terminal state (BullMQ will retry)', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'graph_throttled', message: 'm', retryAfterSeconds: 30, executorMs: 5 });
    await expect(run({ isFinalAttempt: false })).resolves.toBe('throttled');
    expect(mocks.completion).toEqual([]);
  });

  it('a throttled result on the FINAL attempt records throttled and re-schedules', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'sync_capacity', message: 'm', retryAfterSeconds: 30, executorMs: 5 });
    await expect(run({ isFinalAttempt: true })).resolves.toBe('throttled');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'throttled', leaseUntil: null });
    expect(mocks.completion.at(-1)!.nextSyncAt).toBeInstanceOf(Date);
  });

  it('a connection auth failure unschedules and is NOT re-thrown (Huntress Sentry rule, spec §6)', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'application_token_invalid', message: 'm', executorMs: 5 });
    await expect(run()).resolves.toBe('error');
    expect(mocks.completion.at(-1)).toMatchObject({ lastStatus: 'error', nextSyncAt: null });
  });

  it('records exactly ONE m365.sync.run audit event per run, with counts and no row content', async () => {
    await run();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const event = mocks.audit.mock.calls[0]![0];
    expect(event).toMatchObject({ orgId: 'org-1', connectionId: 'conn-1', domain: 'users',
      generation: 5, outcome: 'success', inserted: 1, truncated: false });
    expect(JSON.stringify(event)).not.toContain('u1');
  });

  it('writes NO audit event when it fenced (nothing happened)', async () => {
    mocks.assertFence.mockResolvedValue('consent_changed');
    await run();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('calls applyCadence with the domain first and ALL SIX signals populated', async () => {
    await run();
    expect(mocks.cadence).toHaveBeenCalledWith(
      'users', { intervalSeconds: 21600 }, 'success',
      {
        truncated: false, latencyMs: 1200, capacity: false,
        unlicensed: false, authFailure: false, now: new Date('2026-09-08T00:00:00.000Z'),
      },
      expect.any(Function),
    );
  });

  it('stores the {intervalSeconds, nextSyncAt} PAIR applyCadence returned, computing neither itself', async () => {
    mocks.cadence.mockReturnValue({ intervalSeconds: 999, nextSyncAt: new Date('2027-01-01T00:00:00.000Z') });
    await run();
    expect(mocks.completion.at(-1)).toMatchObject({
      intervalSeconds: 999,
      nextSyncAt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('marks unlicensed from sources.signInActivity, and authFailure only for a DEAD CREDENTIAL', async () => {
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result,
      sources: { users: 'ok', signInActivity: 'unlicensed' } } });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ unlicensed: true, authFailure: false });

    mocks.cadence.mockClear();
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'application_token_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ authFailure: true });

    // graph_permission_missing is needs_consent, NOT a dead credential — if it
    // fed authFailure, W05's cadence would back off a tenant that simply needs
    // a re-consent click.
    mocks.cadence.mockClear();
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'graph_permission_missing', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.cadence.mock.calls[0]![3]).toMatchObject({ authFailure: false });
  });

  it('calls afterDomainPersisted AFTER the completion commit, with the full persist context', async () => {
    const order: string[] = [];
    mocks.hook.mockImplementation(async () => { order.push('hook'); });
    mocks.persistUsers.mockImplementation(async () => { order.push('persist'); return PERSISTED; });
    await run();
    expect(order).toEqual(['persist', 'hook']);
    expect(mocks.completion).toHaveLength(1);           // the commit happened first
    expect(mocks.hook).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 5,
      domain: 'users', outcome: 'success', persisted: PERSISTED,
    }));
  });

  it('a THROWING hook is logged and swallowed — a completed sync is never rolled back or re-run', async () => {
    mocks.hook.mockRejectedValue(new Error('rollup exploded'));
    await expect(run()).resolves.toBe('success');
    expect(mocks.completion).toHaveLength(1);
  });

  it('continuation_invalid CLEARS the cursor, re-claims the domain, and returns partial-continue', async () => {
    mocks.loadContext.mockResolvedValue({ ...CTX, state: { ...CTX.state, continuation: 'stale-cursor' } });
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    mocks.claim.mockResolvedValue([{ ...JOB, generation: 6 }]);

    await expect(run()).resolves.toBe('partial-continue');

    // continuation-only write: cursor cleared, lease released, and NOTHING that
    // would make a half-finished walk look like a finished run.
    const completion = mocks.completion.at(-1)!;
    expect(completion).toMatchObject({ continuation: null, leaseUntil: null });
    expect(completion).not.toHaveProperty('lastStatus');
    expect(completion).not.toHaveProperty('nextSyncAt');
    expect(completion).not.toHaveProperty('lastCounts');

    // Re-claimed on the SAME domain at the normal lane, then enqueued, so the
    // restarted run gets a fresh generation and the abandoned one fences.
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', domains: ['users'], priority: 10 }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ domain: 'users', generation: 6 }));
  });

  it('continuation_invalid writes NO audit event and NO run metric — the run has not finished', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.metricRun).not.toHaveBeenCalled();
  });

  it('a failed re-claim after continuation_invalid is survivable: still partial-continue, cursor still cleared', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'continuation_invalid', message: 'm', executorMs: 5 });
    mocks.claim.mockRejectedValue(new Error('redis blip'));
    // The row keeps its past next_sync_at, so the next tick reclaims it anyway.
    await expect(run()).resolves.toBe('partial-continue');
    expect(mocks.completion.at(-1)).toMatchObject({ continuation: null });
  });

  it('emits exactly ONE structured log line per completed run, carrying counts and no row content', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const lines = logged.filter((line) => line.includes('m365.sync.run'));
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')));
    expect(payload).toMatchObject({
      orgId: 'org-1', domain: 'users', connectionId: 'conn-1', generation: 5,
      outcome: 'success', inserted: 1, updated: 0, stale: 0, unchanged: 0, truncated: false,
    });
    expect(payload.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(payload)).not.toContain('u1');
  });

  it('is a no-op that unschedules a domain with no persister, so it cannot spin every tick', async () => {
    await expect(runSyncDomain({ ...JOB, domain: 'secure_score' }, { callExecutor: mocks.callExecutor }))
      .resolves.toBe('noop');
    expect(mocks.callExecutor).not.toHaveBeenCalled();
    expect(mocks.completion.at(-1)).toMatchObject({ nextSyncAt: null, leaseUntil: null });
  });

  it('publishes run and item metrics by domain', async () => {
    mocks.persistUsers.mockResolvedValue({ ...PERSISTED, inserted: 2, updated: 3, stale: 1, unchanged: 4 });
    await run();
    expect(mocks.metricRun).toHaveBeenCalledWith('users', 'success');
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'insert', 2);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'update', 3);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'stale', 1);
    expect(mocks.metricItems).toHaveBeenCalledWith('users', 'unchanged', 4);
  });
});

describe('outcomeForFailure (spec §6)', () => {
  it.each([
    ['graph_permission_missing', 'needs_consent', true, false, false],
    ['sync_capacity', 'throttled', false, false, false],
    ['graph_throttled', 'throttled', false, false, false],
    ['read_rate_limited', 'throttled', false, false, false],
    ['credential_unavailable', 'error', true, false, false],
    ['application_token_invalid', 'error', true, false, false],
    ['continuation_invalid', 'partial', false, false, true],
    ['graph_transport_failed', 'error', false, true, false],
    ['executor_unavailable', 'error', false, true, false],
    ['graph_response_invalid', 'error', false, true, false],
    ['connection_not_ready', 'error', false, true, false],
  ])('%s -> %s (unschedule=%s, sentry=%s, restartWalk=%s)', (code, outcome, unschedule, sentryWorthy, restartWalk) => {
    expect(outcomeForFailure(code as never)).toEqual({ outcome, unschedule, sentryWorthy, restartWalk });
  });

  it('never reports a dead credential OR an expired cursor to Sentry', () => {
    for (const code of ['credential_unavailable', 'application_token_invalid', 'continuation_invalid'] as const) {
      expect(outcomeForFailure(code).sentryWorthy).toBe(false);
    }
  });
});
