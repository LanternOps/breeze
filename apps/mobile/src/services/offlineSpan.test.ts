import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end through the pure modules: tap Start offline, tap Stop, reconnect,
 * drain. This is the plan's Task-3 scenario and the one the previous design
 * could not express — a queued start had no local running timer, so no surface
 * ever offered Stop, and the offline span was lost.
 *
 * Every clock here is `vi.setSystemTime` plus explicit UTC ISO strings, so no
 * ambient timezone is involved. Elapsed time is advanced with
 * `vi.advanceTimersByTime`, which moves the faked `performance.now()` as well
 * as `Date.now()` — a bare `setSystemTime` would move only the wall clock,
 * which is exactly the clock-jump case `closeLocalSpan` refuses to bill.
 */

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./api', () => ({ coreRequest: vi.fn() }));

import {
  clearLocalTimer,
  readLocalTimer,
  stampNow,
  writeLocalTimer,
} from './localTimer';
import {
  drain,
  enqueue,
  parkNeedsAttention,
  readNeedsAttention,
  readQueue,
  QUEUE_KEY,
} from './timeEntryQueue';
import { makeReplaySender } from './timeEntryReplay';
import { makeReconciledSender, needsReconciliation, planReconciliation } from './timerReconcile';
import { startForTicket, stopRunningTimer } from '../screens/tickets/timerActions';
import { startOutcomeEffects, stopOutcomeEffects } from '../screens/tickets/timerOutcomeEffects';
import type { RunningTimer } from './timeEntries';

const startTimer = vi.fn();
const stopTimer = vi.fn();
const createTimeEntry = vi.fn().mockResolvedValue({ id: 'created' });
const updateTimeEntry = vi.fn().mockResolvedValue({ id: 'updated' });

function startDeps(connected: boolean) {
  return {
    startTimer,
    writeLocalTimer,
    clearLocalTimer,
    isConnected: () => connected,
    stamp: stampNow,
  };
}

function stopDeps(connected: boolean) {
  return {
    stopTimer,
    enqueue,
    readLocalTimer,
    clearLocalTimer,
    parkNeedsAttention,
    isConnected: () => connected,
    stamp: stampNow,
  };
}

/** The whole replay path the TimerBar composes, minus React. */
async function replay(serverNowMs: number, server: RunningTimer | null = null) {
  const queue = await readQueue();
  const localTimer = await readLocalTimer();
  const plan = needsReconciliation(localTimer, queue)
    ? planReconciliation({ localTimer, queue, server })
    : { adopt: null, substitute: null };
  const send = makeReconciledSender({
    base: makeReplaySender({
      createTimeEntry,
      updateTimeEntry,
      confirmSuggestion: vi.fn().mockResolvedValue({ entry: { id: 'e1' }, replay: false }),
      dismissSuggestion: vi.fn().mockResolvedValue(undefined),
      serverNow: () => serverNowMs,
    }),
    plan,
    updateTimeEntry,
    lookupWeekEntries: async () => null,
  });
  return drain(send);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  createTimeEntry.mockResolvedValue({ id: 'created' });
  updateTimeEntry.mockResolvedValue({ id: 'updated' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an offline shift', () => {
  it('records the real 40 minutes as ONE create, replayed hours later unchanged', async () => {
    vi.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    const started = await startForTicket('T', startDeps(false));
    expect(started).toMatchObject({ ok: 'local' });

    // The regression that made the whole span unrecordable: with no running
    // timer in the store, neither surface offers Stop.
    const running = startOutcomeEffects(started).startRunning;
    expect(running).not.toBeNull();
    expect(running?.id).toBeNull();

    vi.advanceTimersByTime(40 * 60_000);
    const stopped = await stopRunningTimer({ running }, stopDeps(false));
    expect(stopped).toEqual({ ok: 'queued' });
    expect(stopOutcomeEffects(stopped).clearRunning).toBe(true);

    const queued = await readQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('create');
    expect(queued[0].payload).toMatchObject({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      ticketId: 'T',
    });

    // Back at the office, three hours later.
    vi.advanceTimersByTime(2 * 3600_000 + 20 * 60_000);
    const result = await replay(Date.parse('2026-08-30T12:00:00.000Z'));
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
    expect(createTimeEntry).toHaveBeenCalledWith({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      ticketId: 'T',
    });
    // Either verb would have let the server stamp 12:00 over the real work.
    expect(startTimer).not.toHaveBeenCalled();
    expect(stopTimer).not.toHaveBeenCalled();
  });

  it('closes a SERVER timer at the tap time, not the reconnect time', async () => {
    // The over-billing defect: `/time-entries/stop` stamps endedAt = now, so a
    // 15:00 stop replayed at 18:00 billed three extra hours to the customer.
    const server: RunningTimer = {
      id: 'E',
      localId: null,
      ticketId: 'T',
      startedAt: '2026-08-30T14:00:00.000Z',
      description: null,
    };
    vi.setSystemTime(new Date('2026-08-30T15:00:00.000Z'));
    expect(await stopRunningTimer({ running: server }, stopDeps(false))).toEqual({ ok: 'queued' });

    vi.setSystemTime(new Date('2026-08-30T18:00:00.000Z'));
    const result = await replay(Date.parse('2026-08-30T18:00:00.000Z'));
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
    expect(updateTimeEntry).toHaveBeenCalledWith('E', { endedAt: '2026-08-30T15:00:00.000Z' });
    expect(stopTimer).not.toHaveBeenCalled();
    expect(createTimeEntry).not.toHaveBeenCalled();
  });

  it('sends a fast phone\'s span shifted into the past, with its duration exact', async () => {
    // Device clock is three hours ahead of the server. Unshifted, the create is
    // a permanent 400 (notFarFuture) and the technician's real work is parked.
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
    const started = await startForTicket('T', startDeps(false));
    vi.advanceTimersByTime(40 * 60_000);
    await stopRunningTimer({ running: startOutcomeEffects(started).startRunning }, stopDeps(false));

    const serverNow = Date.parse('2026-08-30T09:41:00.000Z');
    await replay(serverNow);

    const sent = createTimeEntry.mock.calls[0][0] as { startedAt: string; endedAt: string };
    expect(Date.parse(sent.startedAt)).toBeLessThanOrEqual(serverNow);
    expect(Date.parse(sent.endedAt) - Date.parse(sent.startedAt)).toBe(40 * 60_000);
  });

  it('parks a rejected create where it can be read back, and clears it from the queue', async () => {
    vi.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    const started = await startForTicket('T', startDeps(false));
    vi.advanceTimersByTime(40 * 60_000);
    await stopRunningTimer({ running: startOutcomeEffects(started).startRunning }, stopDeps(false));

    createTimeEntry.mockRejectedValue(
      Object.assign(new Error('startedAt must not be in the future'), { status: 400 })
    );
    const result = await replay(Date.parse('2026-08-30T09:41:00.000Z'));

    expect(result.needsAttentionTotal).toBe(1);
    await expect(readQueue()).resolves.toEqual([]);
    expect(JSON.parse(store.get(QUEUE_KEY) ?? '[]')).toEqual([]);
    const parked = await readNeedsAttention();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: 400, message: 'startedAt must not be in the future' });
    expect(parked[0].write.payload).toMatchObject({ ticketId: 'T' });
  });
});

describe('a start whose response was lost', () => {
  async function queueUnconfirmedSpan() {
    vi.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    startTimer.mockRejectedValue(new Error('network down'));
    const started = await startForTicket('T', startDeps(true));
    expect(started).toMatchObject({ ok: 'local' });

    vi.advanceTimersByTime(40 * 60_000);
    await stopRunningTimer({ running: startOutcomeEffects(started).startRunning }, stopDeps(false));
    const [queued] = await readQueue();
    expect(queued.payload).toMatchObject({ unconfirmedStart: true });
  }

  it('closes the phantom instead of posting a second entry for the same work', async () => {
    await queueUnconfirmedSpan();
    const server: RunningTimer = {
      id: 'E',
      localId: null,
      ticketId: 'T',
      startedAt: '2026-08-30T09:00:02.000Z',
      description: null,
    };

    vi.advanceTimersByTime(2 * 3600_000 + 20 * 60_000);
    const result = await replay(Date.parse('2026-08-30T12:00:00.000Z'), server);

    expect(result).toMatchObject({ sent: 1, remaining: 0 });
    expect(updateTimeEntry).toHaveBeenCalledWith('E', { endedAt: '2026-08-30T09:40:00.000Z' });
    expect(createTimeEntry).not.toHaveBeenCalled();
  });

  it('sends the create unchanged when the running timer is somebody else\'s work', async () => {
    await queueUnconfirmedSpan();
    const unrelated: RunningTimer = {
      id: 'OTHER',
      localId: null,
      ticketId: 'DIFFERENT',
      startedAt: '2026-08-30T09:00:02.000Z',
      description: null,
    };

    vi.advanceTimersByTime(2 * 3600_000 + 20 * 60_000);
    await replay(Date.parse('2026-08-30T12:00:00.000Z'), unrelated);

    expect(updateTimeEntry).not.toHaveBeenCalled();
    expect(createTimeEntry).toHaveBeenCalledWith({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      ticketId: 'T',
    });
  });
});
