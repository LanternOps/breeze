import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  commitMock: vi.fn(),
  exitMock: vi.fn(),
  requestMock: vi.fn(),
  captureMock: vi.fn(),
  results: [] as unknown[][],
}));

function chain() {
  const c: any = {};
  for (const m of ['from', 'where']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(h.results.shift() ?? []));
  return c;
}

vi.mock('../../db', () => ({
  db: { select: vi.fn(() => chain()) },
  runAfterDbContextCommit: h.commitMock,
  runAfterDbContextExit: h.exitMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../jobs/oemUpdatesWorker', () => ({ requestOemPolicySideRefresh: h.requestMock }));
vi.mock('../sentry', () => ({ captureException: h.captureMock }));

import { scheduleOemPolicySideRefresh } from './policySideRefreshTrigger';

/** Schedules, then runs the callback the trigger registered for after-commit. */
async function run(target: Parameters<typeof scheduleOemPolicySideRefresh>[0]) {
  scheduleOemPolicySideRefresh(target, 'test');
  const cb = h.commitMock.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
  expect(cb).toBeTypeOf('function');
  await cb!();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.results.length = 0;
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('scheduleOemPolicySideRefresh', () => {
  it('schedules nothing when the flag is off', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    scheduleOemPolicySideRefresh({ partnerId: 'p-1' }, 'test');
    expect(h.commitMock).not.toHaveBeenCalled();
    expect(h.requestMock).not.toHaveBeenCalled();
  });

  it('defers to commit, not to context exit, so a rolled-back write enqueues nothing', () => {
    scheduleOemPolicySideRefresh({ partnerId: 'p-1' }, 'test');
    expect(h.commitMock).toHaveBeenCalledTimes(1);
    expect(h.exitMock).not.toHaveBeenCalled();
    expect(h.requestMock).not.toHaveBeenCalled();
  });

  it('enqueues a partner or org target as given', async () => {
    await run({ partnerId: 'p-1' });
    expect(h.requestMock).toHaveBeenCalledWith({ partnerId: 'p-1' });
    h.commitMock.mockClear();
    await run({ orgId: 'o-1' });
    expect(h.requestMock).toHaveBeenLastCalledWith({ orgId: 'o-1' });
  });

  it('resolves a policy id to its org owner', async () => {
    h.results.push([{ orgId: 'o-1', partnerId: 'p-1' }]);
    await run({ configPolicyId: 'pol-1' });
    expect(h.requestMock).toHaveBeenCalledWith({ orgId: 'o-1' });
  });

  it('resolves a partner-wide policy to its partner', async () => {
    h.results.push([{ orgId: null, partnerId: 'p-1' }]);
    await run({ configPolicyId: 'pol-1' });
    expect(h.requestMock).toHaveBeenCalledWith({ partnerId: 'p-1' });
  });

  it('enqueues nothing for a missing policy', async () => {
    h.results.push([]);
    await run({ configPolicyId: 'gone' });
    expect(h.requestMock).not.toHaveBeenCalled();
  });

  it('onlyIfOemLinked: no effective oem_updates link enqueues nothing', async () => {
    h.results.push([{ orgId: 'o-1', partnerId: null }], []);
    await run({ configPolicyId: 'pol-1', onlyIfOemLinked: true });
    expect(h.requestMock).not.toHaveBeenCalled();
  });

  it('onlyIfOemLinked: an effective oem_updates link enqueues', async () => {
    h.results.push([{ orgId: 'o-1', partnerId: null }], [{ id: 'link-1' }]);
    await run({ configPolicyId: 'pol-1', onlyIfOemLinked: true });
    expect(h.requestMock).toHaveBeenCalledWith({ orgId: 'o-1' });
  });

  it('swallows an enqueue error and reports it', async () => {
    const boom = new Error('redis down');
    h.requestMock.mockRejectedValueOnce(boom);
    await expect(run({ partnerId: 'p-1' })).resolves.toBeUndefined();
    expect(h.captureMock).toHaveBeenCalledWith(boom, undefined, { stage: 'policy side trigger', trigger: 'test' });
  });
});
