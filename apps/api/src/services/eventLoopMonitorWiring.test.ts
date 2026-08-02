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
    expect(indexSource).toMatch(/setConnectTimeoutClassifier\s*\(\s*diagnoseConnectTimeout\s*\)/);
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
    // `allOk` is computed from `checks` only.
    expect(readyBlock).toMatch(/const allOk = Object\.values\(checks\)/);
    expect(readyBlock).not.toMatch(/allOk\s*&&\s*.*starved/);
  });
});
