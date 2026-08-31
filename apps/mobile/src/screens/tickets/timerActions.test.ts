import { describe, it, expect, vi, type Mock } from 'vitest';

// `timeEntries` pulls in `../../services/api`, which imports
// @sentry/react-native — Flow syntax Vitest's node environment cannot parse.
vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { startForTicket, stopRunningTimer, type Stamp } from './timerActions';
import { TimeEntryError, type RunningTimer } from '../../services/timeEntries';
import type { LocalTimer } from '../../services/localTimer';

const START_MS = Date.parse('2026-08-30T09:00:00.000Z');
const STOP_MS = Date.parse('2026-08-30T09:40:00.000Z');
const EPOCH = 'launch-1';

const entry = {
  id: 'e1',
  ticketId: 'k1',
  startedAt: '2026-08-30T09:00:03.000Z',
  endedAt: null,
  durationMinutes: null,
  isBillable: true,
  billingStatus: 'not_billed' as const,
  isApproved: false,
  description: null,
};

function stampAt(wallMs: number, monoMs: number | null = wallMs): () => Stamp {
  return () => ({ localId: 'l1', wallMs, monoMs, monoEpochId: EPOCH });
}

interface StartMocks {
  startTimer: Mock;
  writeLocalTimer: Mock;
  clearLocalTimer: Mock;
  isConnected: () => boolean;
  stamp: () => Stamp;
}

function startDeps(overrides: Record<string, unknown> = {}): StartMocks {
  return {
    startTimer: vi.fn().mockResolvedValue(entry),
    writeLocalTimer: vi.fn().mockResolvedValue(undefined),
    clearLocalTimer: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    stamp: stampAt(START_MS),
    ...overrides,
  } as StartMocks;
}

function localTimer(overrides: Partial<LocalTimer> = {}): LocalTimer {
  return {
    localId: 'l1',
    ticketId: 'k1',
    serverEntryId: null,
    startedAtWall: '2026-08-30T09:00:00.000Z',
    startedAtMono: START_MS,
    monoEpochId: EPOCH,
    startConfirmed: true,
    description: null,
    ...overrides,
  };
}

interface StopMocks {
  stopTimer: Mock;
  enqueue: Mock;
  readLocalTimer: Mock;
  clearLocalTimer: Mock;
  parkNeedsAttention: Mock;
  isConnected: () => boolean;
  stamp: () => Stamp;
}

function stopDeps(overrides: Record<string, unknown> = {}): StopMocks {
  return {
    stopTimer: vi.fn().mockResolvedValue({ ...entry, endedAt: '2026-08-30T09:40:00.000Z' }),
    enqueue: vi.fn().mockResolvedValue(undefined),
    readLocalTimer: vi.fn().mockResolvedValue(null),
    clearLocalTimer: vi.fn().mockResolvedValue(undefined),
    parkNeedsAttention: vi.fn().mockResolvedValue(true),
    isConnected: () => true,
    stamp: stampAt(STOP_MS),
    ...overrides,
  } as StopMocks;
}

const serverRunning: RunningTimer = {
  id: 'E',
  localId: null,
  ticketId: 'k1',
  startedAt: '2026-08-30T09:00:03.000Z',
  description: null,
};

describe('startForTicket', () => {
  it('never enqueues anything, on any path', async () => {
    // The invariant this whole design buys: a queued write always carries its
    // own timestamps, and a start has no end yet, so a start is never queued.
    const offline = startDeps({ isConnected: () => false, startTimer: vi.fn() });
    await startForTicket('k1', offline);
    const dropped = startDeps({
      startTimer: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await startForTicket('k1', dropped);
    for (const deps of [offline, dropped]) {
      expect(Object.prototype.hasOwnProperty.call(deps, 'enqueue')).toBe(false);
    }
  });

  it('returns the entry on success and records the server identity locally', async () => {
    const deps = startDeps();
    await expect(startForTicket('k1', deps)).resolves.toEqual({ ok: true, entry });
    const saved = deps.writeLocalTimer.mock.calls.at(-1)?.[0] as LocalTimer;
    expect(saved).toMatchObject({
      serverEntryId: 'e1',
      startConfirmed: true,
      startedAtWall: entry.startedAt,
    });
  });

  it('persists the local timer BEFORE the network call', async () => {
    const order: string[] = [];
    const deps = startDeps({
      writeLocalTimer: vi.fn().mockImplementation(async () => {
        order.push('write');
      }),
      startTimer: vi.fn().mockImplementation(async () => {
        order.push('network');
        return entry;
      }),
    });
    await startForTicket('k1', deps);
    expect(order[0]).toBe('write');
  });

  it('ticks locally when offline, with the start confirmed absent', async () => {
    const deps = startDeps({ isConnected: () => false, startTimer: vi.fn() });
    const outcome = await startForTicket('k1', deps);
    expect(deps.startTimer).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: 'local' });
    // No request was made, so no server entry can exist — as certain as a
    // confirmed one, and it saves a reconciliation round-trip.
    expect((outcome as { timer: LocalTimer }).timer).toMatchObject({
      startConfirmed: true,
      serverEntryId: null,
      startedAtWall: '2026-08-30T09:00:00.000Z',
    });
  });

  it('keeps ticking locally, UNconfirmed, when the transport failed with no status', async () => {
    const deps = startDeps({ startTimer: vi.fn().mockRejectedValue(new Error('network down')) });
    const outcome = await startForTicket('k1', deps);
    expect(outcome).toMatchObject({ ok: 'local' });
    // A start may have landed; the reconciler resolves that, not a guess here.
    expect((outcome as { timer: LocalTimer }).timer.startConfirmed).toBe(false);
    expect(deps.clearLocalTimer).not.toHaveBeenCalled();
  });

  it('reports a failed local save instead of pretending the timer started', async () => {
    const deps = startDeps({ writeLocalTimer: vi.fn().mockRejectedValue(new Error('SQLITE_FULL')) });
    expect(await startForTicket('k1', deps)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('reports an existing timer as a recoverable outcome, not a crash', async () => {
    const deps = startDeps({
      startTimer: vi.fn().mockRejectedValue(new TimeEntryError('conflict', 'ENTRY_RUNNING', 409)),
    });
    expect(await startForTicket('k1', deps)).toMatchObject({ ok: false, reason: 'already-running' });
    expect(deps.clearLocalTimer).toHaveBeenCalled();
  });

  it('clears the local timer on a verdict, so nothing ticks for an entry that does not exist', async () => {
    const deps = startDeps({
      startTimer: vi.fn().mockRejectedValue(new TimeEntryError('nope', undefined, 403)),
    });
    expect(await startForTicket('k1', deps)).toMatchObject({ ok: false, reason: 'denied' });
    expect(deps.clearLocalTimer).toHaveBeenCalled();
  });

  it('carries the classified denial so the screen can name the reason', async () => {
    // The W02 gate: an org-scoped login is walled off by requireScope, a
    // default technician by the missing time_entries:write permission. Those
    // need different copy — one is unfixable in-app, the other is one admin
    // grant away.
    const deps = startDeps({
      startTimer: vi
        .fn()
        .mockRejectedValue(new TimeEntryError('Permission denied: time_entries:write', undefined, 403)),
    });
    const outcome = await startForTicket('k1', deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'denied' });
    expect((outcome as { denial?: { reason: string } }).denial?.reason).toBe('permission');
  });
});

describe('stopRunningTimer — a timer the server does not have', () => {
  it('enqueues ONE create carrying the real offline span, online or offline', async () => {
    for (const connected of [true, false]) {
      const deps = stopDeps({
        isConnected: () => connected,
        readLocalTimer: vi.fn().mockResolvedValue(localTimer()),
      });
      const outcome = await stopRunningTimer(
        { running: { id: null, localId: 'l1', ticketId: 'k1', startedAt: '2026-08-30T09:00:00.000Z', description: null } },
        deps
      );
      expect(outcome).toEqual({ ok: 'queued' });
      // `/stop` cannot close an entry the server never created.
      expect(deps.stopTimer).not.toHaveBeenCalled();
      expect(deps.enqueue).toHaveBeenCalledTimes(1);
      expect(deps.enqueue).toHaveBeenCalledWith({
        kind: 'create',
        payload: {
          startedAt: '2026-08-30T09:00:00.000Z',
          endedAt: '2026-08-30T09:40:00.000Z',
          ticketId: 'k1',
        },
      });
      expect(deps.clearLocalTimer).toHaveBeenCalled();
    }
  });

  it('flags the create as unconfirmed when the start may have landed', async () => {
    const deps = stopDeps({
      readLocalTimer: vi.fn().mockResolvedValue(localTimer({ startConfirmed: false })),
    });
    await stopRunningTimer({ running: null }, deps);
    expect(deps.enqueue.mock.calls[0][0].payload).toMatchObject({ unconfirmedStart: true });
  });

  it('does NOT flag a confirmed offline start, so no needless reconciliation round-trip', async () => {
    const deps = stopDeps({ readLocalTimer: vi.fn().mockResolvedValue(localTimer()) });
    await stopRunningTimer({ running: null }, deps);
    expect(
      Object.prototype.hasOwnProperty.call(deps.enqueue.mock.calls[0][0].payload, 'unconfirmedStart')
    ).toBe(false);
  });

  it('parks the work instead of inventing a duration when the clock ran backwards', async () => {
    const deps = stopDeps({
      readLocalTimer: vi.fn().mockResolvedValue(localTimer({ startedAtMono: null, monoEpochId: null })),
      stamp: stampAt(Date.parse('2026-08-30T08:00:00.000Z'), null),
    });
    const outcome = await stopRunningTimer({ running: null }, deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'unusable-clock' });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.parkNeedsAttention).toHaveBeenCalledTimes(1);
    expect(deps.parkNeedsAttention.mock.calls[0][0]).toMatchObject({ code: 'CLOCK_WENT_BACKWARDS' });
  });

  it('reports a failed enqueue instead of rejecting into a silent no-op', async () => {
    // Removing the try/catch around `enqueue` turns this into an unhandled
    // rejection out of a `void onStop()` call site: the busy flag clears, no
    // toast appears, and the technician works the job believing it was saved.
    const deps = stopDeps({
      readLocalTimer: vi.fn().mockResolvedValue(localTimer()),
      enqueue: vi.fn().mockRejectedValue(new Error('time-entry queue storage is unreadable')),
    });
    const outcome = await stopRunningTimer({ running: null }, deps);
    expect(outcome).toMatchObject({ ok: false, reason: 'unknown' });
    expect((outcome as { message: string }).message).toMatch(/re-enter it from the timesheet/i);
    // The local timer survives a failed save, so the minutes are still on screen.
    expect(deps.clearLocalTimer).not.toHaveBeenCalled();
  });

  it('says nothing is running when there is no local timer and no running state', async () => {
    const deps = stopDeps();
    expect(await stopRunningTimer({ running: null }, deps)).toMatchObject({
      ok: false,
      reason: 'not-running',
    });
  });
});

describe('stopRunningTimer — a timer the server owns', () => {
  it('stops through the API when connected, so the server stamps the tap moment', async () => {
    const deps = stopDeps();
    const outcome = await stopRunningTimer({ running: serverRunning, isBillable: true }, deps);
    expect(outcome).toMatchObject({ ok: true });
    expect(deps.stopTimer).toHaveBeenCalledWith({ isBillable: true });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('queues a closeEntry at the TAP time when offline, never a stop', async () => {
    const deps = stopDeps({ isConnected: () => false });
    const outcome = await stopRunningTimer({ running: serverRunning, isBillable: false }, deps);
    expect(outcome).toEqual({ ok: 'queued' });
    expect(deps.stopTimer).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledWith({
      kind: 'closeEntry',
      payload: { id: 'E', endedAt: '2026-08-30T09:40:00.000Z', isBillable: false },
    });
  });

  it('queues a closeEntry when the stop request failed with no status', async () => {
    const deps = stopDeps({ stopTimer: vi.fn().mockRejectedValue(new Error('network down')) });
    expect(await stopRunningTimer({ running: serverRunning }, deps)).toEqual({ ok: 'queued' });
    expect(deps.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'closeEntry',
      payload: { id: 'E', endedAt: '2026-08-30T09:40:00.000Z' },
    });
  });

  it('reports a failed offline enqueue instead of rejecting into a silent no-op', async () => {
    const deps = stopDeps({
      isConnected: () => false,
      enqueue: vi.fn().mockRejectedValue(new Error('time-entry queue storage is unreadable')),
    });
    expect(await stopRunningTimer({ running: serverRunning }, deps)).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  });

  it('treats NO_RUNNING_TIMER as routine, not an error state', async () => {
    const deps = stopDeps({
      stopTimer: vi.fn().mockRejectedValue(new TimeEntryError('nope', 'NO_RUNNING_TIMER', 404)),
    });
    expect(await stopRunningTimer({ running: serverRunning }, deps)).toMatchObject({
      ok: false,
      reason: 'not-running',
    });
  });

  it('classifies a 403 on stop the same way start does', async () => {
    const deps = stopDeps({
      stopTimer: vi
        .fn()
        .mockRejectedValue(new TimeEntryError('Permission denied: time_entries:write', undefined, 403)),
    });
    expect(await stopRunningTimer({ running: serverRunning }, deps)).toMatchObject({
      ok: false,
      reason: 'denied',
    });
  });

  it('falls back to the local record\'s server id when the store has no running timer', async () => {
    const deps = stopDeps({
      isConnected: () => false,
      readLocalTimer: vi.fn().mockResolvedValue(localTimer({ serverEntryId: 'E2' })),
    });
    await stopRunningTimer({ running: null }, deps);
    expect(deps.enqueue.mock.calls[0][0]).toMatchObject({ kind: 'closeEntry', payload: { id: 'E2' } });
  });
});
