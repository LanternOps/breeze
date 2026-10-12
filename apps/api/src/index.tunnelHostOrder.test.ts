import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Static contract (like caddyWebBillingCarveouts.test.ts): importing index.ts
// boots the world, so pin the middleware ORDER from source instead.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
const at = (needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `${needle} not found in index.ts`).toBeGreaterThan(-1);
  return i;
};

describe('tunnel host middleware order (spec §3)', () => {
  it('classifies after metrics/logging and dispatches after body limit + rate limit, before CORS', () => {
    const metrics = at("app.use('*', metricsMiddleware)");
    const logger = at("app.use('*', requestPathLogger())");
    const classifier = at("app.use('*', tunnelHostClassifier())");
    const bodyLimit = at('createGlobalBodyLimitMiddleware(');
    const rateLimit = at("app.use('*', globalRateLimit())");
    const dispatch = at("app.use('*', tunnelHostDispatch(tunnelHostRoutes))");
    const cors = at('cors({');
    expect(metrics).toBeLessThan(classifier);
    expect(logger).toBeLessThan(classifier);
    expect(classifier).toBeLessThan(bodyLimit);
    expect(bodyLimit).toBeLessThan(dispatch);
    expect(rateLimit).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(cors);
  });

  it('exempts tunnel surfaces from the app security-header stack', () => {
    expect(src).toMatch(/exceptPathPrefix\(TUNNEL_HTTP_PATH_PREFIX, exceptTunnelSurface\(mw\)\)/);
    expect(src).toMatch(/skipHeadersWhen: isTunnelSurface/);
  });
});
