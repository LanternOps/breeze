import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { createNativeSessionEnd } from './nativeSessionEnd';

const AUTH = {
  apiUrl: 'https://example.com',
  accessToken: 'viewer-tok',
  sessionId: '11111111-1111-4111-8111-111111111111',
};

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createNativeSessionEnd (#12129)', () => {
  it('arms the native close with the desktop session the window shows', async () => {
    const call = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => undefined);
    const native = createNativeSessionEnd(call);

    expect(native.track(AUTH)).toBe(AUTH);
    await flush();
    expect(call).toHaveBeenCalledWith('arm_session_end', {
      apiUrl: AUTH.apiUrl,
      accessToken: AUTH.accessToken,
      sessionId: AUTH.sessionId,
    });
  });

  it('re-arms with the new session after a transport switch mints one', async () => {
    const call = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => undefined);
    const native = createNativeSessionEnd(call);

    native.track(AUTH);
    native.track({ ...AUTH, sessionId: 's2', accessToken: 'tok2' });
    await flush();
    expect(call).toHaveBeenLastCalledWith('arm_session_end', { apiUrl: AUTH.apiUrl, accessToken: 'tok2', sessionId: 's2' });
    expect(call).not.toHaveBeenCalledWith('disarm_session_end', expect.anything());
  });

  it('disarms the previous session when the window no longer shows one (VNC tunnel, new deep link)', async () => {
    const call = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => undefined);
    const native = createNativeSessionEnd(call);

    native.track(AUTH);
    native.track({ ...AUTH, sessionId: '' });
    native.track(null);
    await flush();
    expect(call.mock.calls.filter(([cmd]) => cmd === 'disarm_session_end')).toEqual([
      ['disarm_session_end', { sessionId: AUTH.sessionId }],
    ]);
  });

  it('never arms a connection without a desktop session or token', async () => {
    const call = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => undefined);
    const native = createNativeSessionEnd(call);

    native.track(null);
    native.track({ ...AUTH, sessionId: '' });
    native.track({ ...AUTH, accessToken: '' });
    await flush();
    expect(call).not.toHaveBeenCalled();
  });

  it('disarm names the session it ended, so it cannot cancel a newer one', async () => {
    const call = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => undefined);
    const native = createNativeSessionEnd(call);

    native.track(AUTH);
    await native.disarm(AUTH.sessionId);
    expect(call).toHaveBeenLastCalledWith('disarm_session_end', { sessionId: AUTH.sessionId });
    await native.disarm('');
    await native.disarm(null);
    expect(call.mock.calls.filter(([cmd]) => cmd === 'disarm_session_end')).toHaveLength(1);
  });

  it('swallows a failed or throwing native call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rejecting = createNativeSessionEnd(vi.fn(async () => { throw new Error('no ipc'); }));
      rejecting.track(AUTH);
      await expect(rejecting.disarm(AUTH.sessionId)).resolves.toBeUndefined();

      const throwing = createNativeSessionEnd(vi.fn(() => { throw new Error('sync'); }));
      expect(() => throwing.track(AUTH)).not.toThrow();
      await flush();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});
