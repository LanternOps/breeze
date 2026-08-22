import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level assertions on the metrics middleware MOUNT.
 *
 * This suite exists because of the exact shape of the bug it guards. Before this
 * was written, `metricsMiddleware` was fully implemented and fully unit-tested —
 * and never mounted. Every test passed while a production scrape carried no
 * `http_requests_total` and no `http_request_duration_seconds` at all, so the
 * SOC 2 A1.1 capacity evidence, the "Request Rate by Method" and "Top Endpoints"
 * panels, and the `HighErrorRate` / `SlowResponseTime` / `EndpointLatencyHigh`
 * rules all evaluated against an empty vector for months. An empty vector never
 * fires an alert, so nothing complained.
 *
 * The behavioural tests in routes/metrics.test.ts mount the middleware on their
 * OWN `new Hono()`, which means they can only ever prove it works — never that it
 * is installed. Deleting the mount from index.ts left all of them green. Reading
 * the source is the only thing that closes that gap without booting the server.
 */
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('metricsMiddleware mount (index.ts)', () => {
  it('imports metricsMiddleware from the metrics route module', () => {
    expect(indexSource).toMatch(
      /import\s*\{[^}]*\bmetricsMiddleware\b[^}]*\}\s*from\s*'\.\/routes\/metrics'/,
    );
  });

  it('mounts it globally on every path', () => {
    expect(indexSource).toMatch(/app\.use\(\s*'\*'\s*,\s*metricsMiddleware\s*\)/);
  });

  it('mounts it ahead of rate limiting and the body-limit wrapper', () => {
    // The docstring on the mount claims the recorded duration covers "the whole
    // server-side cost of a request — rate limiting and body-limit rejections
    // included". That is only true while it is registered first; a reorder that
    // moves it below either one silently narrows what the histogram measures, and
    // a 429/413 stops being counted at all.
    const metricsAt = indexSource.indexOf("app.use('*', metricsMiddleware)");
    // The CALL site, not the import at the top of the file.
    // Main applies the global body limit via createGlobalBodyLimitMiddleware({...})
    // since #3660; the trailing '({' distinguishes the call from the import.
    const bodyLimitAt = indexSource.indexOf('createGlobalBodyLimitMiddleware({');
    const rateLimitAt = indexSource.indexOf("app.use('*', globalRateLimit())");

    expect(metricsAt).toBeGreaterThan(-1);
    expect(bodyLimitAt).toBeGreaterThan(-1);
    expect(rateLimitAt).toBeGreaterThan(-1);
    expect(metricsAt).toBeLessThan(bodyLimitAt);
    expect(metricsAt).toBeLessThan(rateLimitAt);
  });

  it('mounts it before any route is registered, so no route escapes instrumentation', () => {
    // Hono only applies a `use()` to handlers registered after it. A route
    // registered above the mount is invisible to the counter forever.
    const metricsAt = indexSource.indexOf("app.use('*', metricsMiddleware)");
    const firstRouteAt = indexSource.search(/^app\.(get|post|put|patch|delete|route)\(/m);

    expect(firstRouteAt).toBeGreaterThan(-1);
    expect(metricsAt).toBeLessThan(firstRouteAt);
  });
});
