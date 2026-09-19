import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The phone's best estimate of the SERVER's clock.
 *
 * Why it exists: `createTimeEntrySchema.startedAt` is refined `notFarFuture`
 * with five minutes of tolerance, and the queue treats the resulting 400 as
 * permanent. A phone whose clock runs fast would therefore have every offline
 * entry parked for manual re-entry — the technician's minutes lost to a device
 * setting they never touched. Anchoring to the `Date` response header lets the
 * replay translate a future-dated span back into the past before sending it.
 *
 * The anchor is an OFFSET, not a timestamp, so it stays useful while the phone
 * is offline: `Date.now()` still advances, and the offset corrects it. Its
 * resolution is one second (RFC 9110 `Date`), which is far inside the five
 * minutes it protects.
 */
export const SERVER_CLOCK_KEY = 'breeze.serverClock.v1';

let offsetMs = 0;
let trusted = false;

/**
 * Records the offset from one response's `Date` header. Never throws and never
 * awaits storage: this runs on every API response and must not add latency or
 * turn a working request into a failed one.
 */
export function noteServerDate(header: string | null): void {
  if (header === null) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;

  offsetMs = serverMs - Date.now();
  trusted = true;
  void AsyncStorage.setItem(SERVER_CLOCK_KEY, JSON.stringify({ offsetMs })).catch(() => undefined);
}

/**
 * `trusted: false` means no anchor has ever been seen (a cold install that has
 * been offline since launch). The caller gets the device clock unchanged, which
 * is the only thing available — but it knows not to present it as authoritative.
 */
export function serverNowMs(): { ms: number; trusted: boolean } {
  return { ms: Date.now() + (trusted ? offsetMs : 0), trusted };
}

/** Hydrates the offset persisted by a previous launch. Never throws. */
export async function loadServerClock(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(SERVER_CLOCK_KEY);
    if (stored === null) return;
    const parsed = JSON.parse(stored) as { offsetMs?: unknown };
    if (typeof parsed?.offsetMs !== 'number' || !Number.isFinite(parsed.offsetMs)) return;
    offsetMs = parsed.offsetMs;
    trusted = true;
  } catch {
    // An unreadable anchor is the same as never having had one.
  }
}

/** Drops the in-memory anchor. Exported for tests; the persisted value stays. */
export function resetServerClock(): void {
  offsetMs = 0;
  trusted = false;
}
