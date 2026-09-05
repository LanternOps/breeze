import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Boot-wiring guards for the #3214 pool-health watchdog.
 *
 * Same rationale as `services/eventLoopMonitorWiring.test.ts`: `index.ts` starts
 * servers, workers and migrations on import, so it cannot be imported in a unit
 * test and is excluded from coverage. A watchdog that is defined but never
 * started fails completely silently — `getLastDbPoolHealthAssessment()` returns
 * null, every Prometheus verdict series stays at 0, and no test goes red. The
 * API would simply be blind to the exact condition this work exists to surface,
 * which is precisely how #3214 went unnoticed for hours in production.
 */
describe('db pool-health watchdog bootstrap wiring (index.ts)', () => {
  const indexSource = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf-8',
  );

  it('starts the watchdog during startup', () => {
    expect(indexSource).toMatch(/startDbPoolHealthMonitor\s*\(/);
  });

  it('starts it AFTER the connect-timeout classifier is injected', () => {
    // The watchdog alerts on the CONNECT_TIMEOUT rate, and nothing is counted
    // until safeDiagnoseConnectTimeout is wired into the Sentry layer. Started
    // first, it would evaluate an empty window and report a healthy pool.
    const classifierAt = indexSource.indexOf('setConnectTimeoutClassifier(safeDiagnoseConnectTimeout)');
    const watchdogAt = indexSource.indexOf('startDbPoolHealthMonitor(');
    expect(classifierAt).toBeGreaterThan(-1);
    expect(watchdogAt).toBeGreaterThan(classifierAt);
  });

  it('announces at boot whether the watchdog is running', () => {
    // A disabled watchdog is otherwise indistinguishable from a healthy one:
    // both publish no verdict at all.
    expect(indexSource).toMatch(/\[db-pool-health\] Watchdog started/);
    expect(indexSource).toMatch(/\[db-pool-health\] Watchdog DISABLED/);
  });

  it('stops the watchdog on graceful shutdown', () => {
    // Not just tidiness: left running, it can open a fresh probe connection
    // while the pool drains and report `database-unreachable` about a process
    // that is merely shutting down.
    expect(indexSource).toMatch(/stopDbPoolHealthMonitor\s*\(/);
  });

  it('keeps pool-health telemetry off the unauthenticated /health/ready', () => {
    // /health/ready answers without auth. The verdict plus the connect-timeout
    // rate is a live readout of how close the instance is to falling over, for
    // the same reason event-loop lag was deliberately kept off this endpoint.
    // The numbers belong on the auth-gated /metrics; the watchdog logs to the
    // console regardless.
    const start = indexSource.indexOf("app.get('/health/ready'");
    expect(start).toBeGreaterThan(-1);
    // Bound the alias registration at the next route. The detailed response is
    // constructed by the shared readiness handler, not inline in index.ts.
    const next = indexSource.slice(start + 1).search(/\napp\.(get|post|route|use)\(/);
    const readyBlock = indexSource.slice(start, next === -1 ? undefined : start + 1 + next);

    expect(readyBlock).toContain("app.get('/health/ready', readinessHandler)");
    expect(readyBlock).not.toMatch(/DbPoolHealth/);
    expect(readyBlock).not.toMatch(/poolHealth/i);
    expect(readyBlock).not.toMatch(/connectTimeout/i);
  });
});
