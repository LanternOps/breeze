import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiStreamEvent } from '@breeze/shared';

const sessionGet = vi.hoisted(() => vi.fn());
const readRunForDelivery = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());

vi.mock('../streamingSessionManager', () => ({
  streamingSessionManager: { get: sessionGet },
}));
vi.mock('../sentry', () => ({ captureException }));
const incChatRunDelivery = vi.hoisted(() => vi.fn());
vi.mock('../aiWorkspaceMetrics', () => ({ incChatRunDelivery }));
// The Redis client is never constructed in this suite: `deliverRunEvent` is the
// pure half, and `watchRunForSession` is exercised through the exported registry.
vi.mock('../redis', () => ({ resolveRedisUrl: () => 'redis://127.0.0.1:6379' }));
const redisInstances = vi.hoisted(() => [] as Array<{
  channels: string[];
  unsubscribed: number;
  quit: number;
}>);
vi.mock('ioredis', () => ({
  default: class {
    private readonly rec = { channels: [] as string[], unsubscribed: 0, quit: 0 };

    constructor() {
      redisInstances.push(this.rec);
    }

    subscribe(channel: string) {
      this.rec.channels.push(channel);
    }

    on() {}

    unsubscribe() {
      this.rec.unsubscribed += 1;
      return Promise.resolve();
    }

    quit() {
      this.rec.quit += 1;
      return Promise.resolve();
    }
  },
}));

import {
  shutdownChatRunBridge,
  deliverRunEvent,
  drainPendingRunResults,
  unwatchRun,
  watchRunForSession,
  __setRunReaderForTests,
} from './chatRunBridge';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';

/**
 * `orgId` and `breezeSessionId` are the two fields `deliverRunEvent` re-asserts
 * against the watch, so they are overridable — the mismatch tests below depend
 * on being able to hand back a session that is LIVE but belongs to someone else.
 */
function fakeSession(overrides: { orgId?: string; breezeSessionId?: string } = {}) {
  const published: AiStreamEvent[] = [];
  return {
    published,
    session: {
      breezeSessionId: overrides.breezeSessionId ?? SESSION,
      orgId: overrides.orgId ?? ORG,
      eventBus: {
        publish: (e: AiStreamEvent) => {
          published.push(e);
        },
      },
      pendingRunResults: [] as unknown[],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisInstances.length = 0;
  unwatchRun(RUN);
  __setRunReaderForTests(readRunForDelivery);
  readRunForDelivery.mockResolvedValue({
    status: 'completed',
    summary: 'Three accounts failed logon from outside the office.',
    artifacts: [
      {
        handle: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'failed-logons.csv',
        bytes: 40_112,
        contentType: 'text/csv',
      },
    ],
  });
});

describe('chatRunBridge (spec §5.5)', () => {
  it('publishes run_progress on the watched session', async () => {
    const { session, published } = fakeSession();
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({
      type: 'ai.agent.run.progress',
      payload: { runId: RUN, step: 'export_dataset', label: 'Exported 12,400 rows', ordinal: 2 },
    });

    expect(published).toEqual([
      { type: 'run_progress', runId: RUN, step: 'export_dataset', label: 'Exported 12,400 rows', ordinal: 2 },
    ]);
  });

  it('publishes run_result with artifacts and queues the summary for the SDK session', async () => {
    const { session, published } = fakeSession();
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'run_result', runId: RUN, status: 'completed' });
    expect(session.pendingRunResults).toHaveLength(1);

    const injected = drainPendingRunResults(session as never);
    expect(injected).toContain('Three accounts failed logon');
    expect(injected).toContain('failed-logons.csv');
    expect(session.pendingRunResults).toHaveLength(0);
    expect(drainPendingRunResults(session as never)).toBeNull();
  });

  it('stops watching a run once its result has been delivered', async () => {
    const { session } = fakeSession();
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });
    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });

    expect(readRunForDelivery).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the session is gone, and unwatches', async () => {
    sessionGet.mockReturnValue(undefined);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await expect(
      deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } }),
    ).resolves.toBeUndefined();

    // The run row was never read: with nowhere to deliver, the bridge does no work.
    expect(readRunForDelivery).not.toHaveBeenCalled();
    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });
    expect(readRunForDelivery).not.toHaveBeenCalled();
  });

  it('ignores an event for a run this process never launched', async () => {
    const { session, published } = fakeSession();
    sessionGet.mockReturnValue(session);

    await deliverRunEvent({
      type: 'ai.agent.run.completed',
      payload: { runId: '99999999-9999-4999-8999-999999999999' },
    });

    expect(published).toEqual([]);
    expect(sessionGet).not.toHaveBeenCalled();
  });

  it('refuses to publish into a session that belongs to a different org', async () => {
    // The session id was reused after an eviction and now resolves to a LIVE
    // session in ANOTHER tenant. Publishing would put this org's summary and
    // file names into that org's conversation — nothing downstream would catch
    // it, because an SSE frame never passes through RLS.
    const { session, published } = fakeSession({ orgId: '77777777-7777-4777-8777-777777777777' });
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });

    expect(published).toEqual([]);
    expect(session.pendingRunResults).toHaveLength(0);
    // The run row is never even read: nothing is fetched for a delivery that
    // cannot be made.
    expect(readRunForDelivery).not.toHaveBeenCalled();
    // Loud, not silent: this is a registry bug, unlike the no-session drop.
    expect(captureException).toHaveBeenCalledTimes(1);

    // …and the watch is gone, so a redelivery does not retry the same mistake.
    await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: RUN } });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('refuses to publish progress into a session whose identity does not match the watch', async () => {
    const { session, published } = fakeSession({
      breezeSessionId: '88888888-8888-4888-8888-888888888888',
    });
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({
      type: 'ai.agent.run.progress',
      payload: { runId: RUN, step: 'export_dataset', label: 'Exported 12,400 rows', ordinal: 2 },
    });

    expect(published).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('maps a failed run to a run_result the card can render', async () => {
    const { session, published } = fakeSession();
    sessionGet.mockReturnValue(session);
    readRunForDelivery.mockResolvedValue({ status: 'failed', summary: null, artifacts: [] });
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({
      type: 'ai.agent.run.failed',
      payload: { runId: RUN, errorCode: 'workspace_unavailable' },
    });

    expect(published[0]).toEqual({
      type: 'run_result',
      runId: RUN,
      status: 'failed',
      summary: null,
      artifacts: [],
    });
  });
});

/**
 * The subscriber lifecycle — the half that holds process-lifetime state. A bug
 * here degrades silently in production: either a leaked Redis subscription per
 * org forever, or a subscription closed under a run still in flight, which
 * loses every remaining delivery for that org with nothing to show for it.
 */
describe('chatRunBridge subscriber lifecycle', () => {
  const RUN_B = '55555555-5555-4555-8555-555555555555';
  const ORG_B = '66666666-6666-4666-8666-666666666666';

  beforeEach(() => {
    unwatchRun(RUN);
    unwatchRun(RUN_B);
    redisInstances.length = 0;
  });

  it("opens ONE subscriber per org, on that org's live channel", () => {
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });
    watchRunForSession({ runId: RUN_B, sessionId: SESSION, orgId: ORG });

    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0]!.channels).toEqual([`breeze:events:live:${ORG}`]);
  });

  it('keeps the subscriber while another run in the same org is still watched', () => {
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });
    watchRunForSession({ runId: RUN_B, sessionId: SESSION, orgId: ORG });

    unwatchRun(RUN);
    // Refcount, not a flag: closing here would silently lose every delivery for
    // RUN_B, which is still in flight.
    expect(redisInstances[0]!.unsubscribed).toBe(0);
    expect(redisInstances[0]!.quit).toBe(0);

    unwatchRun(RUN_B);
    expect(redisInstances[0]!.unsubscribed).toBe(1);
    expect(redisInstances[0]!.quit).toBe(1);
  });

  it('opens a separate subscriber per org and closes them independently', () => {
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });
    watchRunForSession({ runId: RUN_B, sessionId: SESSION, orgId: ORG_B });
    expect(redisInstances).toHaveLength(2);

    unwatchRun(RUN);
    expect(redisInstances[0]!.quit).toBe(1);
    expect(redisInstances[1]!.quit).toBe(0);
  });

  it('unwatching a run that was never watched is a no-op', () => {
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });
    unwatchRun('99999999-9999-4999-8999-999999999999');
    expect(redisInstances[0]!.quit).toBe(0);
  });

  it('shutdown quits every subscriber', async () => {
    // A leaked ioredis subscriber keeps the process alive past SIGTERM — how a
    // rolling deploy becomes a stuck pod.
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });
    watchRunForSession({ runId: RUN_B, sessionId: SESSION, orgId: ORG_B });
    expect(redisInstances).toHaveLength(2);

    await shutdownChatRunBridge();

    expect(redisInstances.every((r) => r.quit === 1)).toBe(true);
    expect(redisInstances).toHaveLength(2);
  });

  it('caps the queued run results a walked-away technician can accumulate', async () => {
    // Without the cap, every finished run prepends another block to the next
    // message the technician sends — an unbounded prompt prefix.
    const { session } = fakeSession();
    sessionGet.mockReturnValue(session);

    for (let i = 0; i < 8; i++) {
      const id = `run-${i}`;
      watchRunForSession({ runId: id, sessionId: SESSION, orgId: ORG });
      // eslint-disable-next-line no-await-in-loop
      await deliverRunEvent({ type: 'ai.agent.run.completed', payload: { runId: id } });
    }

    expect(session.pendingRunResults).toHaveLength(5);
    // The OLDEST are dropped, so the most recent results are the ones the model
    // actually sees.
    const drained = drainPendingRunResults(session as never)!;
    expect(drained).toContain('run-7');
    expect(drained).not.toContain('run-0');
  });

  it('tags a malformed progress payload instead of dropping it with no signal', async () => {
    const { session, published } = fakeSession();
    sessionGet.mockReturnValue(session);
    watchRunForSession({ runId: RUN, sessionId: SESSION, orgId: ORG });

    await deliverRunEvent({
      type: 'ai.agent.run.progress',
      payload: { runId: RUN, step: 'export_dataset', label: 'x', ordinal: 'two' },
    });

    expect(published).toEqual([]);
    expect(incChatRunDelivery).toHaveBeenCalledWith('malformed_payload');
  });
});
