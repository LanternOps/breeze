import { describe, it, expect, vi } from 'vitest';
import { getKeyboardLockApi, shouldLockKeyboard, createKeyboardLockController, type KeyboardLockApi } from './keyboardLock';

function fakeApi(lockImpl: () => Promise<void> = async () => {}) {
  return { lock: vi.fn(lockImpl), unlock: vi.fn() } satisfies KeyboardLockApi;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('getKeyboardLockApi', () => {
  it('feature-detects navigator.keyboard.lock (absent on WKWebView and WebKitGTK)', () => {
    expect(getKeyboardLockApi({} as Navigator)).toBeNull();
    expect(getKeyboardLockApi({ keyboard: {} } as unknown as Navigator)).toBeNull();
    const keyboard = { lock: async () => {}, unlock: () => {} };
    expect(getKeyboardLockApi({ keyboard } as unknown as Navigator)).not.toBeNull();
  });
});

describe('shouldLockKeyboard', () => {
  const on = { fullscreen: true, focused: true, connected: true, viewOnly: false };
  it('locks only in fullscreen, focused, connected, sending input', () => {
    expect(shouldLockKeyboard(on)).toBe(true);
    expect(shouldLockKeyboard({ ...on, fullscreen: false })).toBe(false);
    expect(shouldLockKeyboard({ ...on, focused: false })).toBe(false);
    expect(shouldLockKeyboard({ ...on, connected: false })).toBe(false);
    // View-only would swallow Alt-Tab/Win and send them nowhere.
    expect(shouldLockKeyboard({ ...on, viewOnly: true })).toBe(false);
  });
});

describe('keyboard lock controller', () => {
  it('locks once and unlocks once as the condition flips', async () => {
    const api = fakeApi();
    const c = createKeyboardLockController(api);
    c.sync(true);
    c.sync(true);
    await flush();
    expect(api.lock).toHaveBeenCalledTimes(1);
    expect(c.locked()).toBe(true);
    c.sync(false);
    c.sync(false);
    expect(api.unlock).toHaveBeenCalledTimes(1);
    expect(c.locked()).toBe(false);
  });

  it('without the API it is a silent no-op (the Send Keys menu remains the way in)', () => {
    const c = createKeyboardLockController(null);
    expect(() => { c.sync(true); c.sync(false); c.release(); }).not.toThrow();
    expect(c.locked()).toBe(false);
  });

  it('a refused lock leaves it unlocked and does not throw', async () => {
    const log = vi.fn();
    const api = fakeApi(async () => { throw new Error('not fullscreen'); });
    const c = createKeyboardLockController(api, log);
    c.sync(true);
    await flush();
    expect(c.locked()).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('a lock that resolves after the condition already ended is undone', async () => {
    let resolveLock: () => void = () => {};
    const api = fakeApi(() => new Promise<void>((r) => { resolveLock = r; }));
    const c = createKeyboardLockController(api);
    c.sync(true);
    c.sync(false);
    resolveLock();
    await flush();
    expect(c.locked()).toBe(false);
    expect(api.unlock).toHaveBeenCalled();
  });

  it('release() always unlocks (session end)', async () => {
    const api = fakeApi();
    const c = createKeyboardLockController(api);
    c.sync(true);
    await flush();
    c.release();
    expect(api.unlock).toHaveBeenCalledTimes(1);
    expect(c.locked()).toBe(false);
  });
});
