import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365SyncJobData } from './types';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    loadContext: vi.fn(), assertFence: vi.fn(), release: vi.fn(),
    persistUsers: vi.fn(), persistSignin: vi.fn(), persistSecureScore: vi.fn(), callExecutor: vi.fn(),
    persistSigninEvents: vi.fn(), signinEventsWindow: vi.fn(),
    completion: [] as Record<string, unknown>[],
    audit: vi.fn(), metricRun: vi.fn(), metricFenced: vi.fn(), metricItems: vi.fn(),
    hook: vi.fn(), captureException: vi.fn(),
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
vi.mock('./domains/signinActivity', () => ({ persistSigninActivity: mocks.persistSignin }));
vi.mock('./domains/secureScore', () => ({ persistSecureScore: mocks.persistSecureScore }));
vi.mock('./domains/signinEvents', () => ({
  persistSigninEvents: mocks.persistSigninEvents,
  signinEventsWindow: mocks.signinEventsWindow,
}));
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
vi.mock('../sentry', () => ({ captureException: mocks.captureException }));

import { M365_SYNC_DOMAINS } from '@breeze/shared/m365';
import { DOMAIN_PERSISTERS, outcomeForFailure, runSyncDomain } from './run';   // nextSyncAt lives in cadence.ts (Task 12) and is covered by cadence.test.ts
import { M365_SYNC_IMPLEMENTED_DOMAINS } from './types';
import { M365SyncRunFencedError } from './domains/persist';

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

  it('a persister that loses ownership mid-persist is FENCED: no completion, no audit, fenced metric', async () => {
    mocks.persistUsers.mockRejectedValue(new M365SyncRunFencedError('gone'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBe('fenced');
    } finally { spy.mockRestore(); }
    expect(mocks.completion).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.hook).not.toHaveBeenCalled();
    expect(mocks.metricFenced).toHaveBeenCalledTimes(1);
  });

  it('passes the owned domain into the persist context so every chunk re-proves ownership', async () => {
    await run();
    expect(mocks.persistUsers.mock.calls[0]![0]).toMatchObject({ domain: 'users', generation: 5, orgId: 'org-1' });
  });

  it('a non-fence persist error still propagates', async () => {
    mocks.persistUsers.mockRejectedValue(new Error('chunk exploded'));
    await expect(run()).rejects.toThrow('chunk exploded');
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

  it('a BENIGN failure code (sentryWorthy: false) is never reported to Sentry', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'application_token_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('a genuinely unexpected Graph failure (sentryWorthy: true) IS reported to Sentry exactly once', async () => {
    mocks.callExecutor.mockResolvedValue({ ok: false, code: 'graph_response_invalid', message: 'm', executorMs: 5 });
    await run();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({
        org_id: 'org-1',
        m365_sync_domain: 'users',
        m365_sync_failure_code: 'graph_response_invalid',
      }),
    );
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

  // As of W05 every contracted domain has a persister, so the no-persister
  // branch is only reachable if a future domain is added without one. It is
  // still a live safety net, so it is exercised by unregistering one domain.
  async function withoutPersister<T>(domain: 'secure_score', body: () => Promise<T>): Promise<T> {
    const saved = DOMAIN_PERSISTERS[domain];
    DOMAIN_PERSISTERS[domain] = undefined;
    try { return await body(); } finally { DOMAIN_PERSISTERS[domain] = saved; }
  }

  it('is a no-op that unschedules a domain with no persister, so it cannot spin every tick', async () => {
    await withoutPersister('secure_score', async () => {
      await expect(runSyncDomain({ ...JOB, domain: 'secure_score' }, { callExecutor: mocks.callExecutor }))
        .resolves.toBe('noop');
    });
    expect(mocks.callExecutor).not.toHaveBeenCalled();
    expect(mocks.completion.at(-1)).toMatchObject({ nextSyncAt: null, leaseUntil: null });
  });

  it('a domain with no persister still writes the ONE audit event and run metric (spec §7)', async () => {
    await withoutPersister('secure_score', () =>
      runSyncDomain({ ...JOB, domain: 'secure_score' }, { callExecutor: mocks.callExecutor }));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({
      orgId: 'org-1', connectionId: 'conn-1', domain: 'secure_score', generation: 5, outcome: 'error',
    });
    expect(mocks.metricRun).toHaveBeenCalledWith('secure_score', 'error');
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

const SIGNIN_JOB = { ...JOB, domain: 'signin_activity' as const };
const SIGNIN_PAGE = (continuation?: string) => ({
  ok: true, kind: 'sync', executorMs: 900,
  result: {
    success: true, kind: 'sync', items: [{ id: 'u1', lastSuccessfulSignInAt: null }], truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z', sources: { signInActivity: 'ok' },
    ...(continuation ? { continuation } : {}),
  },
});
const SIGNIN_PERSISTED = (continuation: string | null) => ({
  inserted: 0, updated: 5, stale: 0, unchanged: 1, counts: {},
  complete: continuation === null, continuation, unlicensed: false,
});

describe('W05: every domain has a persister', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.completion = []; mocks.depth = 0;
    mocks.claim.mockResolvedValue([]); mocks.enqueue.mockResolvedValue('job-1');
    mocks.loadContext.mockResolvedValue(CTX);
    mocks.assertFence.mockResolvedValue(null);
  });

  it('has a function for all seven contracted domains', () => {
    expect(Object.keys(DOMAIN_PERSISTERS).sort()).toEqual([...M365_SYNC_DOMAINS].sort());
    for (const domain of M365_SYNC_DOMAINS) expect(DOMAIN_PERSISTERS[domain]).toBeTypeOf('function');
  });

  it('#5784 W05: signin_events runs its persister and carries the Phase A delta window', async () => {
    const WINDOW = { since: '2026-09-01T00:00:00.000Z', until: '2026-09-08T00:00:00.000Z' };
    mocks.loadContext.mockResolvedValue({
      ...CTX, state: { ...CTX.state, signinEventsWindow: WINDOW },
    });
    mocks.callExecutor.mockResolvedValue({
      ok: true, kind: 'sync', executorMs: 800,
      result: {
        success: true, kind: 'sync', items: [{ id: 'e1' }], truncated: false,
        fetchedAt: '2026-09-08T00:00:00.000Z', sources: { signinEvents: 'ok' },
      },
    });
    mocks.persistSigninEvents.mockResolvedValue({
      inserted: 1, updated: 0, unchanged: 0, stale: 0, complete: true,
      counts: { signin_events: 1 }, continuation: null, unlicensed: false,
    });
    await expect(runSyncDomain({ ...JOB, domain: 'signin_events' as const }, {
      callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5,
      deps: { loadSyncRunContext: mocks.loadContext, assertStillFenced: mocks.assertFence, releaseLease: mocks.release },
    })).resolves.toBe('success');
    expect(mocks.persistSigninEvents).toHaveBeenCalled();
    // The window is what keeps this an incremental pull rather than a re-scan.
    expect(mocks.callExecutor.mock.calls.at(-1)![1])
      .toEqual({ type: 'm365.sync.signin_events', since: WINDOW.since, until: WINDOW.until });
  });

  it('M365_SYNC_IMPLEMENTED_DOMAINS is the full contracted set', () => {
    expect([...M365_SYNC_IMPLEMENTED_DOMAINS].sort()).toEqual([...M365_SYNC_DOMAINS].sort());
  });

  it('runs signin_activity instead of returning noop', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED(null));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE());
    await expect(runSyncDomain(SIGNIN_JOB, {
      callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5,
      deps: { loadSyncRunContext: mocks.loadContext, assertStillFenced: mocks.assertFence, releaseLease: mocks.release },
    })).resolves.toBe('success');
    expect(mocks.persistSignin).toHaveBeenCalled();
  });

  it('runs secure_score with backfill on a never-succeeded state row', async () => {
    mocks.persistSecureScore.mockResolvedValue({ ...PERSISTED, counts: { secure_score: 1 } });
    mocks.callExecutor.mockResolvedValue({ ...SYNC_OK, result: { ...SYNC_OK.result, sources: { secureScores: 'ok' } } });
    await expect(runSyncDomain({ ...JOB, domain: 'secure_score' }, {
      callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5,
      deps: { loadSyncRunContext: mocks.loadContext, assertStillFenced: mocks.assertFence, releaseLease: mocks.release },
    })).resolves.toBe('success');
    expect(mocks.callExecutor.mock.calls[0]![1]).toEqual({ type: 'm365.sync.secure_score', backfill: true });
    expect(mocks.persistSecureScore).toHaveBeenCalled();
  });
});

describe('W05: sign-in continuation loop (spec §5.7, §6)', () => {
  const runSignin = () => runSyncDomain(SIGNIN_JOB, {
    callExecutor: mocks.callExecutor, now: new Date('2026-09-08T00:00:00.000Z'), rng: () => 0.5,
    deps: { loadSyncRunContext: mocks.loadContext, assertStillFenced: mocks.assertFence, releaseLease: mocks.release },
  });

  beforeEach(() => {
    vi.clearAllMocks(); mocks.completion = []; mocks.depth = 0;
    mocks.claim.mockResolvedValue([{ ...SIGNIN_JOB, generation: 6 }]); mocks.enqueue.mockResolvedValue('job-1');
    mocks.loadContext.mockResolvedValue({ ...CTX, state: { ...CTX.state, continuation: 'blob-1' } });
    mocks.assertFence.mockResolvedValue(null);
  });

  it('returns partial-continue and re-claims a NEW generation of the same domain at priority 10', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED('blob-2'));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));

    await expect(runSignin()).resolves.toBe('partial-continue');

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', domains: ['signin_activity'], priority: 10 }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ domain: 'signin_activity', generation: 6 }));
  });

  it('stores ONLY the cursor and clears the lease — the state is unchanged until exhausted', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED('blob-2'));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));

    await runSignin();

    expect(mocks.completion).toHaveLength(1);
    const set = mocks.completion[0]!;
    expect(set).toMatchObject({ continuation: 'blob-2', leaseUntil: null });
    for (const key of ['lastStatus', 'lastSuccessAt', 'nextSyncAt', 'lastCounts', 'lastCompleteSnapshotAt', 'intervalSeconds']) {
      expect(set).not.toHaveProperty(key);
    }
  });

  it('does not advance cadence, audit, meter a run, or run the post-commit hook on a continuation page', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED('blob-2'));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));

    await runSignin();

    expect(mocks.cadence).not.toHaveBeenCalled();
    expect(mocks.hook).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.metricRun).not.toHaveBeenCalled();
    // The page's writes are still real and still metered.
    expect(mocks.metricItems).toHaveBeenCalledWith('signin_activity', 'update', 5);
  });

  it('writes the cursor BEFORE re-claiming, so the new generation reads it', async () => {
    const order: string[] = [];
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED('blob-2'));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));
    mocks.claim.mockImplementation(async () => {
      order.push(`claim-after-${mocks.completion.length}-writes`);
      return [{ ...SIGNIN_JOB, generation: 6 }];
    });
    await runSignin();
    expect(order).toEqual(['claim-after-1-writes']);
  });

  it('a failed re-claim is survivable: still partial-continue, cursor still stored', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED('blob-2'));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));
    mocks.claim.mockRejectedValue(new Error('redis blip'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(runSignin()).resolves.toBe('partial-continue');
    } finally { spy.mockRestore(); }
    expect(mocks.completion.at(-1)).toMatchObject({ continuation: 'blob-2' });
  });

  it('passes the stored continuation into the executor action', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED(null));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE());
    await runSignin();
    expect(mocks.callExecutor.mock.calls[0]![1]).toEqual({ type: 'm365.sync.signin_activity', continuation: 'blob-1' });
  });

  it('asks for page 1 once the stored continuation is NULL', async () => {
    mocks.loadContext.mockResolvedValue(CTX);
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED(null));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE());
    await runSignin();
    expect(mocks.callExecutor.mock.calls[0]![1]).toEqual({ type: 'm365.sync.signin_activity' });
  });

  it('the last page completes normally: continuation cleared, cadence applied, hook run, no re-claim', async () => {
    mocks.persistSignin.mockResolvedValue(SIGNIN_PERSISTED(null));
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE());

    await expect(runSignin()).resolves.toBe('success');

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.completion.at(-1)).toMatchObject({ continuation: null, lastStatus: 'success' });
    expect(mocks.completion.at(-1)!.nextSyncAt).toBeInstanceOf(Date);
    expect(mocks.cadence).toHaveBeenCalledOnce();
    expect(mocks.hook).toHaveBeenCalledOnce();
  });

  it('does NOT re-claim from a fenced run — a late job must never resurrect the loop', async () => {
    mocks.assertFence.mockResolvedValue('generation_mismatch');
    mocks.callExecutor.mockResolvedValue(SIGNIN_PAGE('blob-2'));
    await expect(runSignin()).resolves.toBe('fenced');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.persistSignin).not.toHaveBeenCalled();
  });
});
