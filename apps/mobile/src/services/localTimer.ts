import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The one timer that exists only on this device.
 *
 * A timer the technician starts offline has no server entry and no
 * server-stamped `startedAt`, so it cannot live in the queue: the queue holds
 * only writes with explicit bounds, and a start has no end yet. It lives here
 * instead, is what the TimerBar ticks, and becomes exactly one queued `create`
 * at the moment Stop is tapped.
 *
 * Session-owned, exactly like a queued write: cleared on sign-out.
 */
export const LOCAL_TIMER_KEY = 'breeze.localTimer.v1';

export interface LocalTimer {
  localId: string;
  ticketId: string | null;
  /** Set once the server owns this timer; null while it is device-only. */
  serverEntryId: string | null;
  startedAtWall: string;
  /** `performance.now()` at the tap, or null where it is unavailable. */
  startedAtMono: number | null;
  /** Which JS launch the mono anchor belongs to (see services/timeSpan.ts). */
  monoEpochId: string | null;
  /**
   * False means a start request MAY have landed on the server before the
   * transport failed. The reconciler resolves that against
   * `GET /time-entries/running` rather than guessing.
   */
  startConfirmed: boolean;
  description: string | null;
}

/**
 * Regenerated on every JS launch. `performance.now()` is measured from an
 * arbitrary per-launch origin, so two anchors are only comparable when they
 * carry the same epoch id.
 */
const MONO_EPOCH_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

export function currentMonoEpochId(): string {
  return MONO_EPOCH_ID;
}

function monoNow(): number | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : null;
}

/** Everything a tap needs to record about "now", captured in one place. */
export function stampNow(): {
  localId: string;
  wallMs: number;
  monoMs: number | null;
  monoEpochId: string;
} {
  return {
    localId: `${Date.now()}-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`,
    wallMs: Date.now(),
    monoMs: monoNow(),
    monoEpochId: MONO_EPOCH_ID,
  };
}

function asLocalTimer(value: unknown): LocalTimer | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<LocalTimer>;
  if (typeof candidate.localId !== 'string' || candidate.localId.length === 0) return null;
  if (typeof candidate.startedAtWall !== 'string') return null;
  if (Number.isNaN(Date.parse(candidate.startedAtWall))) return null;
  return {
    localId: candidate.localId,
    ticketId: typeof candidate.ticketId === 'string' ? candidate.ticketId : null,
    serverEntryId: typeof candidate.serverEntryId === 'string' ? candidate.serverEntryId : null,
    startedAtWall: candidate.startedAtWall,
    startedAtMono: typeof candidate.startedAtMono === 'number' ? candidate.startedAtMono : null,
    monoEpochId: typeof candidate.monoEpochId === 'string' ? candidate.monoEpochId : null,
    // Defaulting to FALSE is the safe direction: it costs one extra
    // `getRunningTimer()` call, where defaulting to true would leave a real
    // server timer running forever.
    startConfirmed: candidate.startConfirmed === true,
    description: typeof candidate.description === 'string' ? candidate.description : null,
  };
}

export async function readLocalTimer(): Promise<LocalTimer | null> {
  try {
    const stored = await AsyncStorage.getItem(LOCAL_TIMER_KEY);
    if (stored === null) return null;
    return asLocalTimer(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** Rejects on a storage failure — a timer the caller believes was saved but was not is a lost shift. */
export async function writeLocalTimer(timer: LocalTimer): Promise<void> {
  await AsyncStorage.setItem(LOCAL_TIMER_KEY, JSON.stringify(timer));
}

export async function clearLocalTimer(): Promise<void> {
  await AsyncStorage.removeItem(LOCAL_TIMER_KEY);
}
