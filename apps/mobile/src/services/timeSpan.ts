/**
 * Turns a locally-ticking timer into a closed span with explicit bounds.
 *
 * This is where the money logic lives, so it is pure: no storage, no network,
 * no React. Every offline minute a technician bills passes through
 * `closeLocalSpan`, and every span that could be rejected for being in the
 * future passes through `shiftIntoPast`.
 *
 * Why a monotonic anchor at all: `Date.now()` on a phone is not monotonic. NTP
 * corrections, a manual clock change and a timezone-driven jump all move it,
 * and a shift that moved the wall clock forward three hours mid-job would bill
 * three extra hours if the duration were measured wall-to-wall.
 * `performance.now()` is immune to that but resets on every JS launch, so it is
 * only comparable within one `monoEpochId`.
 */

export interface SpanTimer {
  /** Wall-clock ISO of the tap that started the timer. */
  startedAtWall: string;
  /** `performance.now()` at that tap, or null if unavailable. */
  startedAtMono: number | null;
  /** The JS-launch epoch the mono anchor belongs to. */
  monoEpochId: string | null;
}

export interface SpanStop {
  wallMs: number;
  monoMs: number | null;
  monoEpochId: string | null;
}

export interface ClosedSpan {
  startedAt: string;
  endedAt: string;
  /**
   * True when the duration had to fall back to the wall clock, because the app
   * was relaunched mid-timer (or the platform has no `performance.now()`). The
   * span is still the best available answer; the flag is what lets the UI say
   * so rather than presenting a possibly-shifted duration as fact.
   */
  clockUnverified: boolean;
}

export type SpanResult = ClosedSpan | { unusable: 'clock-went-backwards' };

/**
 * A tap-tap on the same second is a mis-tap, not a clock error. The server
 * requires `endedAt > startedAt`, so the span is floored to one second — which
 * invoices as 0 minutes, the honest answer.
 */
const MIN_SPAN_MS = 1000;

export function closeLocalSpan(timer: SpanTimer, stop: SpanStop): SpanResult {
  const startWallMs = Date.parse(timer.startedAtWall);
  if (Number.isNaN(startWallMs)) return { unusable: 'clock-went-backwards' };

  const monoComparable =
    timer.monoEpochId !== null &&
    stop.monoEpochId !== null &&
    timer.monoEpochId === stop.monoEpochId &&
    timer.startedAtMono !== null &&
    stop.monoMs !== null;

  const durationMs = monoComparable
    ? (stop.monoMs as number) - (timer.startedAtMono as number)
    : stop.wallMs - startWallMs;

  // Only a clock that ran backwards can produce this. Inventing a duration
  // would be inventing a bill, so the caller parks it for manual entry.
  if (durationMs <= 0) return { unusable: 'clock-went-backwards' };

  const spanMs = Math.max(durationMs, MIN_SPAN_MS);
  return {
    startedAt: new Date(startWallMs).toISOString(),
    endedAt: new Date(startWallMs + spanMs).toISOString(),
    clockUnverified: !monoComparable,
  };
}

/**
 * Translates a span that ends after the server's clock back into the past.
 *
 * `createTimeEntrySchema.startedAt` is refined `notFarFuture` with 5 minutes of
 * tolerance, and the drain treats the resulting 400 as permanent — so a phone
 * running three hours fast would have every offline entry parked for manual
 * re-entry. BOTH bounds move by the same amount: clamping one alone would
 * silently rewrite the duration, which is the exact class of bug this whole
 * design exists to make unrepresentable.
 */
export function shiftIntoPast(
  startedAt: string,
  endedAt: string,
  serverNowMs: number
): { startedAt: string; endedAt: string } {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { startedAt, endedAt };
  if (!Number.isFinite(serverNowMs) || endMs <= serverNowMs) return { startedAt, endedAt };

  const delta = endMs - serverNowMs;
  return {
    startedAt: new Date(startMs - delta).toISOString(),
    endedAt: new Date(endMs - delta).toISOString(),
  };
}
