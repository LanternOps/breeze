/**
 * Turns event-loop samples into an operator-visible signal (#3022).
 *
 * The point of reporting starvation on its own — rather than only as an
 * annotation on some other error — is that starvation does not reliably produce
 * an error at all. In the #3022 incident it surfaced through three different
 * signatures (a Postgres CONNECT_TIMEOUT, a `nextWrite` TypeError from the
 * driver's teardown race, and a patch-scheduler sweep failure), none of which
 * names the loop, and it can equally produce nothing but slow responses. A
 * direct "the loop was blocked for N ms" line is the only signal that appears
 * in every one of those cases.
 *
 * Throttling is not optional here. This repo has twice had a recurring
 * warning exhaust the Sentry event quota and silently drop ALL error reporting
 * org-wide (#1894 for the held-context warning, BREEZE-H for the tripwire), and
 * a starvation event is by nature a burst — one stall produces a run of
 * consecutive breaching samples. So the Sentry capture is rate-limited while
 * `console.warn` stays unthrottled, matching `shouldCaptureHeldContext` in
 * `db/index.ts`.
 */

import { bucketEventLoopLag, type EventLoopLagSample } from './eventLoopMonitor';

const DEFAULT_CAPTURE_THROTTLE_MS = 5 * 60_000;

export interface StarvationReporterOptions {
  /** Lag at or above which a sample is reported. */
  thresholdMs: () => number;
  /** Minimum gap between Sentry captures; 0 disables throttling. */
  throttleMs?: () => number;
  now?: () => number;
  warn?: (message: string) => void;
  capture?: (message: string, tags: Record<string, string>) => void;
}

export interface StarvationReporter {
  (sample: EventLoopLagSample): void;
  /** TEST ONLY — clears the throttle state. */
  reset(): void;
}

export function getStarvationCaptureThrottleMs(): number {
  const raw = Number.parseInt(process.env.EVENT_LOOP_STARVATION_THROTTLE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CAPTURE_THROTTLE_MS;
  }
  return raw;
}

/**
 * Build a sample consumer that warns on every breaching sample and captures a
 * throttled subset to Sentry. Every dependency is injectable so the throttle
 * arithmetic is unit-testable without real timers or a live Sentry client.
 */
export function createStarvationReporter(options: StarvationReporterOptions): StarvationReporter {
  const {
    thresholdMs,
    throttleMs = getStarvationCaptureThrottleMs,
    now = Date.now,
    warn = (message) => console.warn(message),
    capture,
  } = options;

  let lastCaptureAtMs: number | null = null;

  const report = ((sample: EventLoopLagSample): void => {
    const threshold = thresholdMs();
    if (sample.maxLagMs < threshold) return;

    const lagMs = Math.round(sample.maxLagMs);
    const message =
      `[event-loop] Main thread blocked for up to ${lagMs}ms (>= ${threshold}ms). While blocked, `
      + `no socket callback and no timer runs — in-flight Postgres handshakes can exceed `
      + `connect_timeout and be reported as CONNECT_TIMEOUT even though the database and the `
      + `network are healthy (#3022).`;

    warn(message);

    if (!capture) return;
    const gap = throttleMs();
    const at = now();
    if (gap > 0 && lastCaptureAtMs !== null && at - lastCaptureAtMs < gap) {
      return;
    }
    lastCaptureAtMs = at;
    capture(message, { event_loop_lag_bucket: bucketEventLoopLag(lagMs) });
  }) as StarvationReporter;

  report.reset = () => {
    lastCaptureAtMs = null;
  };

  return report;
}
