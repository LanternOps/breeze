// Short two-note chime for the header bell, synthesised with Web Audio so
// there is no asset to ship or preload.

const LAST_CHIME_KEY = 'breeze-notification-last-chime';
const LOCK_NAME = 'breeze-notification-chime';
const NOTES: Array<{ frequency: number; start: number }> = [
  { frequency: 880, start: 0 },
  { frequency: 1174.66, start: 0.14 }
];
const NOTE_SECONDS = 0.32;
const PEAK_GAIN = 0.12;

let sharedContext: AudioContext | null = null;

const getContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedContext ??= new Ctor();
  return sharedContext;
};

const ring = async (): Promise<void> => {
  const context = getContext();
  if (!context) return;
  // Browsers keep the context suspended until the page has had a user
  // gesture. resume() then rejects or stays suspended; stay silent.
  if (context.state === 'suspended') await context.resume();
  if (context.state !== 'running') return;

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
};

const alreadyChimed = (dedupeKey: string): boolean => {
  try {
    if (window.localStorage.getItem(LAST_CHIME_KEY) === dedupeKey) return true;
    window.localStorage.setItem(LAST_CHIME_KEY, dedupeKey);
  } catch {
    // Storage blocked: chime in every tab instead of in none.
  }
  return false;
};

/**
 * Play the chime once per `dedupeKey` across every open Breeze tab. Each tab
 * receives the same live nudge, so without the lock they would all sound.
 */
export const playNotificationChime = (dedupeKey: string): void => {
  if (typeof window === 'undefined') return;
  const play = () => {
    if (alreadyChimed(dedupeKey)) return;
    void ring().catch(() => undefined);
  };

  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    play();
    return;
  }
  void locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      play();
      // Hold the lock past the other tabs' refetch debounce.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    })
    .catch(() => undefined);
};
