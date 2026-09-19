import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');
const routeSource = readFileSync(join(here, 'emailProvider.ts'), 'utf8');
const globalRateLimitSource = readFileSync(
  join(here, '..', '..', 'middleware', 'globalRateLimit.ts'),
  'utf8',
);

describe('index.ts mounts the delivery webhook', () => {
  it('imports and mounts resendWebhookRoutes', () => {
    expect(indexSource).toContain("import { resendWebhookRoutes } from './routes/webhooks/emailProvider';");
    expect(indexSource).toContain("api.route('/webhooks', resendWebhookRoutes);");
  });

  // Hono flattens .route() mounts, so a wildcard auth middleware on the
  // session-authenticated webhookRoutes would 401 this public sibling before
  // the signature handler ever ran (issue #2053).
  it('mounts it AFTER the CRUD webhookRoutes, like every other public webhook', () => {
    const crud = indexSource.indexOf("api.route('/webhooks', webhookRoutes);");
    const resend = indexSource.indexOf("api.route('/webhooks', resendWebhookRoutes);");
    expect(crud).toBeGreaterThan(-1);
    expect(resend).toBeGreaterThan(crud);
  });

  it('gives the endpoint its own global-rate-limit bucket', () => {
    expect(globalRateLimitSource).toContain("prefix: '/api/v1/webhooks/email-provider/'");
  });
});

describe('the delivery webhook never reaches the provider', () => {
  // Spec §2: request handlers write intent rows and enqueue; the worker owns
  // every provider call. A dynamic import would defeat a naive grep, so check
  // both forms.
  it.each(['providerRegistry', 'adapters/resend', 'adapters/static', 'adapters/fake', 'resend'])(
    'does not import %s, statically or dynamically',
    (moduleName) => {
      expect(routeSource).not.toMatch(new RegExp(`from\\s+['"][^'"]*${moduleName}['"]`));
      expect(routeSource).not.toMatch(new RegExp(`import\\s*\\(\\s*['"][^'"]*${moduleName}['"]`));
    },
  );

  it('does not use runOutsideDbContext — there is no outer transaction on a public route', () => {
    expect(routeSource).not.toContain('runOutsideDbContext');
    expect(routeSource).toContain('withSystemDbAccessContext');
  });
});
