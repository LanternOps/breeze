import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Boot-wiring guards for the #3022 instrumentation.
 *
 * These read `index.ts` as text for the same reason the existing
 * "sentry bootstrap wiring" suite does: `index.ts` starts servers, workers and
 * migrations on import, so it cannot be imported in a unit test, and it is
 * excluded from coverage. That combination is exactly how `initSentry` once sat
 * defined-but-never-called while every `captureException` in the codebase
 * silently no-op'd in production.
 *
 * The same failure mode is available here and would be quieter still: an
 * unstarted monitor reports `monitored: false`, which every consumer correctly
 * treats as "unknown". Nothing breaks, no test fails — the API just goes
 * permanently blind to the condition this work exists to surface.
 */
describe('event-loop monitor bootstrap wiring (index.ts)', () => {
  const indexSource = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf-8',
  );

  it('starts the event-loop monitor during startup', () => {
    expect(indexSource).toMatch(/startEventLoopMonitor\s*\(/);
  });

  it('feeds samples to the starvation reporter', () => {
    // Without this the monitor still answers queries, but a stall produces no
    // log line and no Sentry event of its own — leaving starvation visible only
    // as a tag on some *other* error, which is the gap #3022 describes.
    expect(indexSource).toMatch(/createStarvationReporter\s*\(/);
  });

  it('injects the CONNECT_TIMEOUT classifier into the Sentry layer', () => {
    // services/sentry.ts deliberately does not import the classifier (it would
    // drag the event-loop monitor into the graph of every error-reporting
    // module). That inversion only works if boot actually performs the
    // injection — otherwise the tags are silently never set.
    // The SAFE variant specifically: this classifier runs on error paths, and
    // in Hono's onError a throw would cost the request its 500 and stop the
    // original error reaching Sentry.
    expect(indexSource).toMatch(
      /setConnectTimeoutClassifier\s*\(\s*safeDiagnoseConnectTimeout\s*\)/,
    );
    expect(indexSource).not.toMatch(/setConnectTimeoutClassifier\s*\(\s*diagnoseConnectTimeout\s*\)/);
  });

  it('uses the never-throwing classifier inside app.onError', () => {
    expect(indexSource).toMatch(/const connectTimeout = safeDiagnoseConnectTimeout\(err\)/);
  });

  it('announces at boot whether the monitor is running', () => {
    // A monitor that never starts is otherwise completely silent: diagnoses
    // degrade to "unknown" and nothing says why. The log also prints the
    // effective interval, which is what makes a misparsed env var visible.
    expect(indexSource).toMatch(/\[event-loop\] Lag monitor started/);
    expect(indexSource).toMatch(/\[event-loop\] Lag monitor DISABLED/);
    // Both thresholds: the warn knob and the capped attribution threshold can
    // differ, and printing only the former advertises a value diagnosis does
    // not use.
    expect(indexSource).toMatch(/getConnectTimeoutStarvationThresholdMs\(\)/);
  });

  it('warns when the sampling interval is coarser than the starvation threshold', () => {
    // That configuration leaves a blind spot one sampling interval wide, in
    // which a stall is unobservable and every diagnosis degrades to "unknown".
    expect(indexSource).toMatch(/EVENT_LOOP_MONITOR_INTERVAL_MS \(\$\{eventLoopMonitor\.intervalMs\}ms\) exceeds/);
  });

  it('stops the monitor on graceful shutdown', () => {
    expect(indexSource).toMatch(/stopEventLoopMonitor\s*\(/);
  });

  it('keeps event-loop telemetry off the unauthenticated /health/ready', () => {
    // /health/ready is in HEALTH_CHECK_PATHS (middleware/security.ts) — it
    // answers without auth. The lag stats are a live load gradient plus the
    // starvation threshold itself, so publishing them there hands an
    // unauthenticated prober a readout of whether its own load is starving the
    // instance. Binary availability is what belongs on this endpoint; the
    // numbers live on the auth-gated /metrics, and the starvation reporter
    // logs to the console regardless.
    //
    // Asserting absence (rather than deleting the test with the code) is the
    // point: the block reads as harmless diagnostics, so the obvious future
    // edit is to add it back.
    const start = indexSource.indexOf('const readinessHandler = createReadinessHandler');
    const readyBlock = indexSource.slice(start, indexSource.indexOf('// Metrics endpoint', start));
    expect(readyBlock.length).toBeGreaterThan(0);
    expect(readyBlock).toContain("app.get('/ready', readinessHandler)");
    expect(readyBlock).toContain("app.get('/health/ready', readinessHandler)");
    expect(readyBlock).not.toMatch(/getEventLoopLagStats/);
    expect(readyBlock).not.toMatch(/[eE]vent[lL]oop\s*[,:}]/);
    expect(readyBlock).not.toMatch(/starved/);
  });
});
