import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ContextState = 'running' | 'suspended';
const audio = { state: 'running' as ContextState, started: 0, resume: vi.fn<() => Promise<void>>() };

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  get state() { return audio.state; }
  resume() { return audio.resume(); }
  createOscillator() {
    return { type: 'sine', frequency: { value: 0 }, connect: (node: unknown) => node, start: () => { audio.started += 1; }, stop: () => undefined };
  }
  createGain() {
    const param = { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
    return { gain: param, connect: (node: unknown) => node };
  }
}

const NOTES_PER_CHIME = 2;
const setActivation = (hasBeenActive: boolean | undefined) => {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: hasBeenActive === undefined ? undefined : { hasBeenActive },
  });
};
const setLocks = (locks: unknown) => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
};

const load = async () => (await import('./notificationChime')).playNotificationChime;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  window.localStorage.clear();
  audio.state = 'running';
  audio.started = 0;
  audio.resume.mockReset().mockResolvedValue(undefined);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  setActivation(true);
  setLocks(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = async () => { await vi.advanceTimersByTimeAsync(2_000); };

describe('playNotificationChime', () => {
  it('plays once for the same notification, and again for a different one', async () => {
    const play = await load();
    play('n1'); await settle();
    play('n1'); await settle();
    expect(audio.started).toBe(NOTES_PER_CHIME);
    play('n2'); await settle();
    expect(audio.started).toBe(NOTES_PER_CHIME * 2);
  });

  // A tab the person has not touched cannot play sound. If it claimed the
  // chime, the tab they are actually using would stay silent too.
  it('a tab that cannot play does not claim the chime', async () => {
    setActivation(false);
    const play = await load();
    play('n1'); await settle();
    expect(audio.started).toBe(0);
    expect(audio.resume).not.toHaveBeenCalled();

    setActivation(true);
    play('n1'); await settle();
    expect(audio.started).toBe(NOTES_PER_CHIME);
  });

  it('gives up on a context that stays suspended instead of chiming late', async () => {
    audio.state = 'suspended';
    audio.resume.mockReturnValue(new Promise(() => {}));
    const play = await load();
    play('n1'); await settle();
    expect(audio.started).toBe(0);

    // The context wakes up later (a click): the stale request must not sound,
    // and the notification is still free for a tab that can play it.
    audio.state = 'running';
    await settle();
    expect(audio.started).toBe(0);
    audio.resume.mockResolvedValue(undefined);
    play('n1'); await settle();
    expect(audio.started).toBe(NOTES_PER_CHIME);
  });

  it('still plays when storage is blocked', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const play = await load();
    play('n1'); await settle();
    expect(audio.started).toBe(NOTES_PER_CHIME);
    getItem.mockRestore(); setItem.mockRestore();
  });

  it('does nothing, and throws nothing, without Web Audio', async () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
    const play = await load();
    expect(() => play('n1')).not.toThrow();
    await settle();
    expect(audio.started).toBe(0);
  });

  describe('with Web Locks', () => {
    it('plays under the lock, and stays silent when another tab holds it', async () => {
      setLocks({ request: (_name: string, _opts: unknown, run: (lock: unknown) => Promise<void>) => run({}) });
      const play = await load();
      play('n1'); await settle();
      expect(audio.started).toBe(NOTES_PER_CHIME);

      setLocks({ request: (_name: string, _opts: unknown, run: (lock: unknown) => Promise<void>) => run(null) });
      play('n2'); await settle();
      expect(audio.started).toBe(NOTES_PER_CHIME);
    });

    it('falls back to playing when the lock request itself fails', async () => {
      setLocks({ request: () => Promise.reject(new Error('SecurityError')) });
      const play = await load();
      play('n1'); await settle();
      expect(audio.started).toBe(NOTES_PER_CHIME);
    });
  });
});
