// Short two-note chime for the header bell, synthesised with Web Audio so
// there is no asset to ship or preload.

const LAST_CHIME_KEY = 'breeze-notification-last-chime';
const LOCK_NAME = 'breeze-notification-chime';
const NOTES: Array<{ frequency: number; start: number }> = [
  { frequency: 880, start: 0 },
  { frequency: 1174.66, start: 0.14 },
];
const NOTE_SECONDS = 0.32;
const PEAK_GAIN = 0.12;
/** How long to wait for a suspended context to start before giving up on this chime. */
const RESUME_WAIT_MS = 250;
/** Covers the spread in when open tabs finish refetching after the shared live nudge. */
const LOCK_HOLD_MS = 1500;

let sharedContext: AudioContext | null = null;
let warned = false;

const warnOnce = (err: unknown): void => {
  if (warned) return;
  warned = true;
  console.warn('[notificationChime] audio unavailable; the bell stays silent', err);
};

const getContext = (): AudioContext | null => {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedContext ??= new Ctor();
  return sharedContext;
};

/**
 * Play the chime now. Resolves true only when the notes were scheduled.
 *
 * A page the person has not interacted with may not start audio: the context
 * stays suspended and `resume()` does not settle until a later gesture.
 * Waiting on it would play the chime late, on an unrelated click, so a tab
 * that cannot play right now gives up instead.
 */
const ring = async (): Promise<boolean> => {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
  const context = getContext();
  if (!context) return false;
  if (context.state === 'suspended') {
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
    ]);
  }
  if (context.state !== 'running') return false;

  const now = context.currentTime;
  for (const note of NOTES) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = now + note.start;
    oscillator.type = 'sine';
    oscillator.frequency.value = note.frequency;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + NOTE_SECONDS);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + NOTE_SECONDS);
  }
  return true;
};

// Storage blocked reads as "not chimed yet": every tab chimes rather than none.
const lastChimed = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_CHIME_KEY);
  } catch {
    return null;
  }
};

const markChimed = (dedupeKey: string): void => {
  try {
    window.localStorage.setItem(LAST_CHIME_KEY, dedupeKey);
  } catch {
    // Storage blocked: nothing to record.
  }
};

/** Chime unless some tab already did for this key; claim the key only once it has sounded. */
const playOnce = async (dedupeKey: string): Promise<void> => {
  if (lastChimed() === dedupeKey) return;
  try {
    if (await ring()) markChimed(dedupeKey);
  } catch (err) {
    warnOnce(err);
  }
};

/**
 * Play the chime at most once per `dedupeKey` across open Breeze tabs.
 *
 * localStorage remembers the last key that sounded. The lock closes the race
 * where tabs check it at the same moment, and a tab that cannot play (never
 * interacted with) leaves the key unclaimed for one that can. A chime
 * requested while another tab holds the lock is dropped, whatever its key: one
 * chime per burst.
 */
export const playNotificationChime = (dedupeKey: string): void => {
  if (typeof window === 'undefined') return;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    void playOnce(dedupeKey);
    return;
  }
  void locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await playOnce(dedupeKey);
      await new Promise((resolve) => setTimeout(resolve, LOCK_HOLD_MS));
    })
    // No lock to be had (a sandboxed frame): better every tab than none.
    .catch(() => playOnce(dedupeKey));
};
