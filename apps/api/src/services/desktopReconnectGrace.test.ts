import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value;
  }),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
};
let redisAvailable = true;

vi.mock('./redis', () => ({
  getRedis: () => (redisAvailable ? redisMock : null),
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('./jwt', () => ({
  VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS: 7200,
}));

const revokeViewerSessionMock = vi.fn(async (_sessionId: string) => undefined);
vi.mock('./viewerTokenRevocation', () => ({
  revokeViewerSession: (sessionId: string) => revokeViewerSessionMock(sessionId),
}));

type CommitInput = { sessionId: string; write: Record<string, unknown>; phase: string; where?: unknown[] };
const commitMock = vi.fn(async (_input: CommitInput): Promise<{ ok: boolean }> => ({ ok: true }));
vi.mock('./remoteDesktopTerminalIntent', () => ({
  commitDesktopTerminalIntent: (input: CommitInput) => commitMock(input),
}));

type SessionRow = { status: string; endReason: string | null; terminationPhase: string; desktopStartGeneration: bigint };
let sessionRows: SessionRow[] = [];
const selectWhereMock = vi.fn((..._args: unknown[]) => ({ limit: vi.fn(async () => sessionRows) }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhereMock })) })),
  },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remote_sessions.id',
    endReason: 'remote_sessions.end_reason',
    terminationPhase: 'remote_sessions.termination_phase',
    deviceId: 'remote_sessions.device_id',
    status: 'remote_sessions.status',
    desktopStartGeneration: 'remote_sessions.desktop_start_generation',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
}));

import {
  DESKTOP_RECONNECT_END_RETRY_MS,
  DESKTOP_RECONNECT_GRACE_MS,
  DESKTOP_RECONNECT_INTENT_WINDOW_MS,
  __resetDesktopReconnectGraceForTest,
  consumeDesktopViewerReconnectIntent,
  endDesktopSessionAfterReconnectGrace,
  endHeldDesktopSessionNow,
  enforceExpiredDesktopReconnectHold,
  holdDesktopPeerDropForReconnect,
  holdDesktopSessionForReconnect,
  isDesktopSessionHeldForReconnect,
  markDesktopViewerReconnectIntent,
} from './desktopReconnectGrace';

const SESSION = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const HOLD_KEY = `desktop-reconnect-hold:${SESSION}`;

function hold(startGeneration: bigint, graceMs?: number) {
  return holdDesktopSessionForReconnect({ sessionId: SESSION, deviceId: DEVICE, startGeneration, graceMs });
}

function committedWhere(callIndex = 0): unknown[] {
  return commitMock.mock.calls[callIndex]![0].where ?? [];
}

beforeEach(() => {
  redisAvailable = true;
  sessionRows = [];
  store.clear();
  vi.clearAllMocks();
  commitMock.mockResolvedValue({ ok: true });
  __resetDesktopReconnectGraceForTest();
});

afterEach(() => {
  vi.useRealTimers();
  __resetDesktopReconnectGraceForTest();
});

describe('reconnect grace constants (#10542)', () => {
  it("matches the agent's 20 s ICE-disconnected grace and keeps the intent window shorter", () => {
    expect(DESKTOP_RECONNECT_GRACE_MS).toBe(20_000);
    expect(DESKTOP_RECONNECT_INTENT_WINDOW_MS).toBeGreaterThan(0);
    expect(DESKTOP_RECONNECT_INTENT_WINDOW_MS).toBeLessThanOrEqual(DESKTOP_RECONNECT_GRACE_MS);
  });
});

describe('viewer reconnect intent marker', () => {
  it('marks the intent, naming the start generation, with the bounded window as its TTL', async () => {
    await expect(markDesktopViewerReconnectIntent(SESSION, 5n)).resolves.toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      `desktop-viewer-reconnect:${SESSION}`,
      '5',
      'PX',
      DESKTOP_RECONNECT_INTENT_WINDOW_MS,
    );
  });

  it('consumes the marker atomically, so one ICE-server fetch buys at most one grace', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    await expect(consumeDesktopViewerReconnectIntent(SESSION)).resolves.toBe(5n);
    await expect(consumeDesktopViewerReconnectIntent(SESSION)).resolves.toBeNull();
  });

  it('fails closed (no grace) when Redis is unavailable or errors', async () => {
    redisAvailable = false;
    await expect(markDesktopViewerReconnectIntent(SESSION, 5n)).resolves.toBe(false);
    await expect(consumeDesktopViewerReconnectIntent(SESSION)).resolves.toBeNull();

    redisAvailable = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redisMock.getdel.mockRejectedValueOnce(new Error('boom'));
    await expect(consumeDesktopViewerReconnectIntent(SESSION)).resolves.toBeNull();
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(markDesktopViewerReconnectIntent(SESSION, 5n)).resolves.toBe(false);
    store.set(`desktop-viewer-reconnect:${SESSION}`, 'garbage');
    await expect(consumeDesktopViewerReconnectIntent(SESSION)).resolves.toBeNull();
    errSpy.mockRestore();
  });
});

describe('endDesktopSessionAfterReconnectGrace', () => {
  it('ends the session only while it is still on the start the drop interrupted, then revokes the viewer token', async () => {
    await expect(endDesktopSessionAfterReconnectGrace({ sessionId: SESSION, deviceId: DEVICE, startGeneration: 7n }))
      .resolves.toBe('ended');

    expect(commitMock).toHaveBeenCalledTimes(1);
    const input = commitMock.mock.calls[0]![0];
    expect(input.sessionId).toBe(SESSION);
    expect(input.phase).toBe('confirmed');
    expect(input.write.status).toBe('disconnected');
    expect(input.write.endedAt).toBeInstanceOf(Date);
    expect(committedWhere()).toEqual(expect.arrayContaining([
      { eq: ['remote_sessions.device_id', DEVICE] },
      { eq: ['remote_sessions.status', 'active'] },
      { eq: ['remote_sessions.desktop_start_generation', 7n] },
    ]));
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
  });

  it('leaves a session a reconnect has already restarted (or that ended another way) alone', async () => {
    commitMock.mockResolvedValueOnce({ ok: false });
    await expect(endDesktopSessionAfterReconnectGrace({ sessionId: SESSION, deviceId: DEVICE, startGeneration: 7n }))
      .resolves.toBe('superseded');
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
  });

  it('clears the durable hold record either way', async () => {
    store.set(HOLD_KEY, 'x');
    await endDesktopSessionAfterReconnectGrace({ sessionId: SESSION, deviceId: DEVICE, startGeneration: 7n });
    expect(store.has(HOLD_KEY)).toBe(false);
  });
});

describe('holdDesktopSessionForReconnect', () => {
  it('writes a durable hold record that outlives any viewer token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await expect(hold(3n)).resolves.toBe('held');

    const call = redisMock.set.mock.calls.find((c) => c[0] === HOLD_KEY);
    expect(call).toBeDefined();
    expect(JSON.parse(call![1])).toEqual({
      deviceId: DEVICE,
      startGeneration: '3',
      deadlineMs: 1_000_000 + DESKTOP_RECONNECT_GRACE_MS,
    });
    expect(call!.slice(2)).toEqual(['EX', 7200]);
  });

  it('refuses to hold (caller ends at once) when the durable record cannot be written', async () => {
    redisAvailable = false;
    await expect(hold(3n)).resolves.toBe('unavailable');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);

    redisAvailable = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(hold(3n)).resolves.toBe('unavailable');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);
    errSpy.mockRestore();
  });

  it('ends the session only once the grace has fully elapsed', async () => {
    vi.useFakeTimers();
    await hold(3n);
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(true);

    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS - 1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(committedWhere()).toContainEqual({ eq: ['remote_sessions.desktop_start_generation', 3n] });
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);
  });

  it('does not extend a hold on a repeated drop for the same start', async () => {
    vi.useFakeTimers();
    await hold(3n);
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS / 2);
    await expect(hold(3n)).resolves.toBe('already_held');

    // The original deadline still applies.
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS / 2);
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a hold for an older start with the newer start’s hold', async () => {
    vi.useFakeTimers();
    await hold(3n);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(hold(4n)).resolves.toBe('held');

    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS);
    // Only the newer start's end runs; the superseded hold is cancelled.
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(committedWhere()).toContainEqual({ eq: ['remote_sessions.desktop_start_generation', 4n] });
  });

  it('endHeldDesktopSessionNow cuts the grace short for the reporting device only', async () => {
    vi.useFakeTimers();
    await hold(1n);

    await expect(endHeldDesktopSessionNow(SESSION, 'some-other-device')).resolves.toBe(false);
    expect(commitMock).not.toHaveBeenCalled();
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(true);

    await expect(endHeldDesktopSessionNow(SESSION, DEVICE)).resolves.toBe(true);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);

    // The cancelled timer never ends it a second time.
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS);
    expect(commitMock).toHaveBeenCalledTimes(1);
    await expect(endHeldDesktopSessionNow(SESSION, DEVICE)).resolves.toBe(false);
  });

  it('reports a failing end and retries it a bounded number of times', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { captureException } = await import('./sentry');
    commitMock.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
    await hold(1n);

    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ desktopSessionId: SESSION }),
    );
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
    // The durable record stays until an attempt succeeds.
    expect(store.has(HOLD_KEY)).toBe(true);

    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_END_RETRY_MS);
    expect(commitMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_END_RETRY_MS);
    expect(commitMock).toHaveBeenCalledTimes(3);
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
    expect(store.has(HOLD_KEY)).toBe(false);

    // Bounded: nothing more is scheduled.
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_END_RETRY_MS * 5);
    expect(commitMock).toHaveBeenCalledTimes(3);
    errSpy.mockRestore();
  });

  it('gives up after the last attempt', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    commitMock.mockRejectedValue(new Error('db down'));
    await hold(1n);
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS + DESKTOP_RECONNECT_END_RETRY_MS * 10);
    expect(commitMock).toHaveBeenCalledTimes(3);
    errSpy.mockRestore();
  });

  it('two drops handled concurrently leave the record naming the newer start', async () => {
    vi.useFakeTimers();
    // Older drop's write resolves last.
    let releaseOlder!: () => void;
    redisMock.set.mockImplementationOnce(async (key: string, value: string) => {
      await new Promise<void>((resolve) => { releaseOlder = resolve; });
      store.set(key, value);
      return 'OK';
    });
    const older = hold(3n);
    const newer = hold(4n);
    await expect(newer).resolves.toBe('held');
    releaseOlder();
    await older;

    // The durable record names the newer start, even though the older write
    // landed last...
    expect(JSON.parse(store.get(HOLD_KEY)!).startGeneration).toBe('4');
    // ...and so does the local hold.
    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(committedWhere()).toContainEqual({ eq: ['remote_sessions.desktop_start_generation', 4n] });
  });
});

describe('enforceExpiredDesktopReconnectHold — the hold cannot outlive its deadline on any instance', () => {
  const liveSession = (generation: bigint) => ({
    id: SESSION,
    deviceId: DEVICE,
    status: 'active',
    desktopStartGeneration: generation,
  });

  it('does nothing when the session was never held', async () => {
    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('none');
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('lets the reconnect through while the grace is still running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await hold(3n);
    vi.setSystemTime(1_000_000 + DESKTOP_RECONNECT_GRACE_MS - 1);
    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('none');
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('ends a held session whose deadline passed without the end running (instance died mid-hold)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await hold(3n);
    // Simulate the holding instance going away: its timer never fires.
    __resetDesktopReconnectGraceForTest();
    vi.setSystemTime(1_000_000 + DESKTOP_RECONNECT_GRACE_MS);

    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('ended');
    expect(committedWhere()).toContainEqual({ eq: ['remote_sessions.desktop_start_generation', 3n] });
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
  });

  it('does not refuse when the end finds the session already moved on (superseded)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await hold(3n);
    __resetDesktopReconnectGraceForTest();
    vi.setSystemTime(1_000_000 + DESKTOP_RECONNECT_GRACE_MS);
    commitMock.mockResolvedValueOnce({ ok: false });

    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('none');
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
  });

  it('ignores a stale record once a reconnect has moved the session to a newer start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await hold(3n);
    __resetDesktopReconnectGraceForTest();
    vi.setSystemTime(1_000_000 + DESKTOP_RECONNECT_GRACE_MS * 5);

    await expect(enforceExpiredDesktopReconnectHold(liveSession(4n))).resolves.toBe('none');
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('reports unavailable (caller refuses) when the hold record cannot be read', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redisMock.get.mockRejectedValueOnce(new Error('boom'));
    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('unavailable');
    redisAvailable = false;
    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('unavailable');
    errSpy.mockRestore();
  });

  it('treats an unreadable record as expired', async () => {
    store.set(HOLD_KEY, 'not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(enforceExpiredDesktopReconnectHold(liveSession(3n))).resolves.toBe('ended');
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
    errSpy.mockRestore();
  });
});

describe('holdDesktopPeerDropForReconnect — which peer drops get the grace (#10542)', () => {
  const activeRow: SessionRow = { status: 'active', endReason: null, terminationPhase: 'none', desktopStartGeneration: 5n };
  const drop = (overrides: Partial<{ stopReason: string | null; relayOwned: boolean }> = {}) =>
    holdDesktopPeerDropForReconnect({
      sessionId: SESSION,
      deviceId: DEVICE,
      stopReason: null,
      relayOwned: false,
      ...overrides,
    });

  it('holds a drop that follows a viewer reconnect on a live session', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [activeRow];

    await expect(drop()).resolves.toBe('held');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(true);
    expect(store.has(HOLD_KEY)).toBe(true);
    expect(JSON.parse(store.get(HOLD_KEY)!).startGeneration).toBe('5');
    // The row is read bound to the reporting device.
    expect(selectWhereMock.mock.calls[0]![0]).toEqual({
      and: [{ eq: ['remote_sessions.id', SESSION] }, { eq: ['remote_sessions.device_id', DEVICE] }],
    });
    // Nothing ended yet.
    expect(commitMock).not.toHaveBeenCalled();
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
  });

  it('does not hold a late drop for the old peer once the reconnect committed a newer start', async () => {
    // Marked on start 5; the reconnect offer moved the row to 6 before the
    // old peer's drop report was handled.
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [{ ...activeRow, desktopStartGeneration: 6n }];
    await expect(drop()).resolves.toBe('end_now');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);
  });

  it('Finding #5 unchanged: a drop with no reconnect in flight ends at once', async () => {
    sessionRows = [activeRow];
    await expect(drop()).resolves.toBe('end_now');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);
  });

  it('ends at once when the agent gave a stop reason (a deliberate stop, e.g. the no-video watchdog)', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [activeRow];
    await expect(drop({ stopReason: 'capture failed' })).resolves.toBe('end_now');
  });

  it('ends at once for a WebSocket-relay stream (not a WebRTC reconnect)', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [activeRow];
    await expect(drop({ relayOwned: true })).resolves.toBe('end_now');
  });

  it('ends at once when the person at the device already ended the session', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [{ ...activeRow, endReason: 'ended_by_user' }];
    await expect(drop()).resolves.toBe('end_now');
  });

  it('ends at once when the row is not a live active session of this device', async () => {
    for (const rows of [[], [{ ...activeRow, status: 'connecting' }], [{ ...activeRow, terminationPhase: 'pending' }]]) {
      await markDesktopViewerReconnectIntent(SESSION, 5n);
      sessionRows = rows as SessionRow[];
      await expect(drop()).resolves.toBe('end_now');
    }
  });

  it('ends at once when the hold cannot be recorded durably', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [activeRow];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(drop()).resolves.toBe('end_now');
    expect(isDesktopSessionHeldForReconnect(SESSION)).toBe(false);
    errSpy.mockRestore();
  });

  it('ends at once when reading the session fails', async () => {
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    selectWhereMock.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(drop()).resolves.toBe('end_now');
    errSpy.mockRestore();
  });

  it('a held drop still ends when no reconnect arrives (grace expiry → end + revoke)', async () => {
    vi.useFakeTimers();
    await markDesktopViewerReconnectIntent(SESSION, 5n);
    sessionRows = [activeRow];
    await expect(drop()).resolves.toBe('held');

    await vi.advanceTimersByTimeAsync(DESKTOP_RECONNECT_GRACE_MS);
    expect(committedWhere()).toContainEqual({ eq: ['remote_sessions.desktop_start_generation', 5n] });
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(SESSION);
  });
});
