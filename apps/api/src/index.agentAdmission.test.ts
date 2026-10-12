import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level assertions on the W08 admission mount, for the same reason as
 * index.metricsMiddleware.test.ts: the behavioural suite mounts the middleware
 * on its own Hono app, so it proves the middleware works, never that index.ts
 * installs it in front of the costly global middleware.
 *
 * Every anchor is a regex for the STATEMENT at line start (optionally
 * indented), not a substring: index.ts comments name `agentAdmission()` and
 * `startAdmissionControl()` too, and a substring match would pass on a comment
 * with the real call missing.
 */
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const stmt = (pattern: RegExp): number => {
  const match = pattern.exec(indexSource);
  expect(match, String(pattern)).not.toBeNull();
  return match!.index;
};
const lineStart = (code: string): RegExp =>
  new RegExp(`^[ \\t]*${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');

describe('agent admission mount (index.ts)', () => {
  it('is mounted right after the request logger and before every costly global middleware', () => {
    const logger = stmt(lineStart("app.use('*', requestPathLogger());"));
    const admission = stmt(lineStart("app.use('*', agentAdmission());"));
    expect(admission).toBeGreaterThan(logger);
    // Nothing but comments and blank lines between the logger and the admission mount.
    const between = indexSource
      .slice(logger, admission)
      .split('\n')
      .slice(1, -1)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'));
    expect(between).toEqual([]);
    for (const later of [
      'secureHeaders({',
      'createGlobalBodyLimitMiddleware({',
      "app.use('*', globalRateLimit());",
      "app.route('/api/v1', api);",
    ]) {
      expect(admission, later).toBeLessThan(stmt(lineStart(later)));
    }
  });

  it('starts the controller before the server listens and stops it on shutdown', () => {
    expect(stmt(lineStart('startAdmissionControl();'))).toBeLessThan(stmt(lineStart('server = serve({')));
    const shutdownStart = stmt(/^async function shutdownRuntime/m);
    const shutdown = indexSource.slice(shutdownStart, shutdownStart + 4_000);
    expect(shutdown).toMatch(lineStart('stopAdmissionControl();'));
  });
});
