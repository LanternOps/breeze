import { describe, expect, it, vi } from 'vitest';
import { createSessionHangUp, hangUpThenClose } from './sessionHangUp';

const AUTH = {
  apiUrl: 'https://example.com',
  accessToken: 'viewer-tok',
  sessionId: '11111111-1111-4111-8111-111111111111',
};

describe('createSessionHangUp (#11931)', () => {
  it('ends the session through the viewer-token End route', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await expect(hangUp(AUTH)).resolves.toBe('ended');
    expect(end).toHaveBeenCalledWith(AUTH.apiUrl, AUTH.accessToken, AUTH.sessionId);
  });

  it('sends End once per session: the hang-up and the window close share one request', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    const first = hangUp(AUTH);
    const second = hangUp({ ...AUTH });
    expect(second).toBe(first);
    await first;
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends a new session after a transport switch minted a new one', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await hangUp(AUTH);
    await hangUp({ ...AUTH, sessionId: '22222222-2222-4222-8222-222222222222' });
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('skips a connection with no desktop session (VNC tunnel, not yet authenticated)', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await expect(hangUp(null)).resolves.toBe('skipped');
    await expect(hangUp({ ...AUTH, sessionId: '' })).resolves.toBe('skipped');
    await expect(hangUp({ ...AUTH, accessToken: '' })).resolves.toBe('skipped');
    expect(end).not.toHaveBeenCalled();
  });

  it('never rejects, so a close handler awaiting it always lets the window close', async () => {
    const end = vi.fn(async () => { throw new Error('boom'); });
    const hangUp = createSessionHangUp(end as never);

    await expect(hangUp(AUTH)).resolves.toBe('failed');
  });

  it('never rejects even when End throws synchronously', async () => {
    const end = vi.fn(() => { throw new Error('sync boom'); });
    const hangUp = createSessionHangUp(end as never);

    await expect(hangUp(AUTH)).resolves.toBe('failed');
  });
});

// #12129: the hang-up sequence handleDisconnect runs, tested by behaviour
// (the source-order test it replaces passed by construction).
describe('hangUpThenClose (#12129)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('closes nothing and keeps the window until End has settled', async () => {
    const end = deferred<'ended'>();
    const calls: string[] = [];
    const done = hangUpThenClose({
      hangUp: () => end.promise,
      closers: [
        ['WebSocket session', () => { calls.push('ws'); }],
        ['WebRTC session', () => { calls.push('rtc'); }],
      ],
      isCurrent: () => true,
      onDone: () => { calls.push('window'); },
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls).toEqual([]);

    end.resolve('ended');
    await done;
    expect(calls).toEqual(['ws', 'rtc', 'window']);
  });

  it('runs every close and still closes the window when one close throws', async () => {
    const calls: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await hangUpThenClose({
        hangUp: async () => 'failed',
        closers: [
          ['WebSocket session', () => { throw new Error('boom'); }],
          ['VNC session', () => { calls.push('vnc'); }],
        ],
        isCurrent: () => true,
        onDone: () => { calls.push('window'); },
      });
      expect(calls).toEqual(['vnc', 'window']);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('does not close a window that a newer session reused while End was in flight', async () => {
    const end = deferred<'ended'>();
    let current = true;
    const calls: string[] = [];
    const done = hangUpThenClose({
      hangUp: () => end.promise,
      closers: [['WebRTC session', () => { calls.push('old-rtc'); }]],
      isCurrent: () => current,
      onDone: () => { calls.push('window'); },
    });

    current = false; // a new deep link reused the window
    end.resolve('ended');
    await done;
    // The old session's own transports are still closed; the window is not.
    expect(calls).toEqual(['old-rtc']);
  });

  it('closes the window even if the hang-up itself rejects', async () => {
    const calls: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await hangUpThenClose({
        hangUp: () => Promise.reject(new Error('unexpected')),
        closers: [['WebRTC session', () => { calls.push('rtc'); }]],
        isCurrent: () => true,
        onDone: () => { calls.push('window'); },
      });
      expect(calls).toEqual(['rtc', 'window']);
    } finally {
      errors.mockRestore();
    }
  });
});
