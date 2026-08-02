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
  });

  it('stops the monitor on graceful shutdown', () => {
    expect(indexSource).toMatch(/stopEventLoopMonitor\s*\(/);
  });

  it('reports event-loop lag on /health/ready without gating readiness on it', () => {
    // Readiness must NOT flip on starvation: pulling a loaded instance out of
    // rotation pushes its traffic onto its peers and starves them in turn.
    expect(indexSource).toMatch(/getEventLoopLagStats\s*\(/);
    const readyBlock = indexSource.slice(
      indexSource.indexOf("app.get('/health/ready'"),
      indexSource.indexOf("app.get('/ready'"),
    );
    expect(readyBlock.length).toBeGreaterThan(0);
    expect(readyBlock).toContain('eventLoop');
    // `allOk` must be computed from `checks` alone, and the lag stats must be
    // read AFTER it — so no future edit can fold starvation into `checks`
    // (e.g. `checks.eventLoop = stats.starved ? 'error' : 'ok'`) and silently
    // start shedding traffic from a merely-busy instance. Ordering is the
    // structural guarantee; a keyword blocklist is not.
    const allOkAt = readyBlock.indexOf('const allOk = Object.values(checks)');
    const statsAt = readyBlock.indexOf('getEventLoopLagStats(');
    expect(allOkAt).toBeGreaterThan(-1);
    expect(statsAt).toBeGreaterThan(allOkAt);
    expect(readyBlock).not.toMatch(/checks\.\w*[eE]vent[lL]oop/);
    expect(readyBlock).not.toMatch(/starved/);
  });
});
