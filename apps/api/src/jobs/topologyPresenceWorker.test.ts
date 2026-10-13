import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), evaluate: vi.fn(), capture: vi.fn(), contexts: [] as number[], nextContext: 0 }));
vi.mock('../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<number>();
  return {
    db: { execute: (...args: unknown[]) => { mocks.contexts.push(context.getStore() ?? -1); return mocks.execute(...args); } },
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => context.run(++mocks.nextContext, fn),
    runOutsideDbContext: (fn: () => unknown) => context.exit(fn),
  };
});
vi.mock('../services/topology/presenceEvaluator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/topology/presenceEvaluator')>()),
  evaluateOrgPresence: mocks.evaluate,
}));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));

import { initializeTopologyPresenceWorker, runTopologyPresenceTick, shutdownTopologyPresenceWorker } from './topologyPresenceWorker';
import { TOPOLOGY_PRESENCE_INTERVAL_MS } from '../services/topology/presenceEvaluator';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

beforeEach(() => {
  vi.clearAllMocks(); mocks.contexts.length = 0; mocks.nextContext = 0;
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = JSON.stringify(query);
    if (text.includes('INSERT INTO topology_org_presence_state')) return [{ org_id: ORG_B }];
    if (text.includes('SELECT org_id FROM topology_org_presence_state')) return [{ org_id: ORG_A }, { org_id: ORG_B }];
    return [];
  });
  mocks.evaluate.mockResolvedValue({ status: 'evaluated', version: 1n, devices: 3, coverage: 'complete' });
});
afterEach(async () => { await shutdownTopologyPresenceWorker(); vi.useRealTimers(); });

describe('topology presence worker', () => {
  it('enrols, then evaluates each due org in its own system context', async () => {
    const now = new Date('2026-12-26T12:00:00Z');
    const result = await runTopologyPresenceTick(now);
    expect(result).toEqual({ enrolled: 1, evaluated: 2, busy: 0, notConfigured: 0, failed: 0 });
    expect(mocks.evaluate.mock.calls).toEqual([[ORG_A, now], [ORG_B, now]]);
    expect(mocks.contexts.every((id) => id > 0)).toBe(true);
  });

  it('counts busy and not_configured outcomes', async () => {
    mocks.evaluate.mockResolvedValueOnce({ status: 'busy', version: 0n, devices: 0, coverage: 'not_configured' })
      .mockResolvedValueOnce({ status: 'not_configured', version: 2n, devices: 0, coverage: 'not_configured' });
    expect(await runTopologyPresenceTick(new Date())).toMatchObject({ evaluated: 0, busy: 1, notConfigured: 1 });
  });

  it('keeps going when one org fails, backs it off and reports it', async () => {
    mocks.evaluate.mockRejectedValueOnce(new Error('boom'));
    const result = await runTopologyPresenceTick(new Date());
    expect(result).toMatchObject({ evaluated: 1, failed: 1 });
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls.some(([q]) => JSON.stringify(q).includes('SET dirty_at = now()'))).toBe(true);
  });

  it('still evaluates when enrolment fails', async () => {
    mocks.execute.mockImplementationOnce(async () => { throw new Error('enrol'); });
    const result = await runTopologyPresenceTick(new Date());
    expect(result).toMatchObject({ enrolled: 0, evaluated: 2 });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it('coalesces ticks and waits for the in-flight tick on shutdown', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    mocks.evaluate.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ status: 'evaluated', version: 1n, devices: 0, coverage: 'complete' });
    }));
    initializeTopologyPresenceWorker();
    initializeTopologyPresenceWorker(); // idempotent
    await vi.advanceTimersByTimeAsync(TOPOLOGY_PRESENCE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(TOPOLOGY_PRESENCE_INTERVAL_MS); // second interval while the first tick is in flight
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    const done = shutdownTopologyPresenceWorker();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await done;
    expect(mocks.evaluate.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
