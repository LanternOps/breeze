import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('production readiness wiring', () => {
  // Compose exposes ONE dependency condition, `service_healthy`, and it gates
  // startup — so whatever the healthcheck probes also decides whether
  // dependents may start. Probing /ready here would promote an admission
  // signal into a hard startup dependency for ingress: on a first boot or a
  // full recreation, a required consumer that cannot attach leaves the API
  // unhealthy, Compose abandons the operation, and caddy never starts. An
  // internal worker fault would become loss of ingress for the whole fleet.
  it.each([
    ['docker-compose.yml', '40s'],
    ['docker-compose.override.yml.dev', '60s'],
    ['deploy/docker-compose.prod.yml', '40s'],
  ])('%s healthchecks the API on LIVENESS, never readiness', (path, startPeriod) => {
    const document = load(read(path)) as {
      services: { api: { healthcheck: { test: string[]; start_period: string } } };
    };
    const healthcheck = document.services.api.healthcheck;
    const probe = healthcheck.test.join(' ');

    expect(probe).toContain('http://127.0.0.1:3001/health');
    expect(probe).not.toContain('/ready');
    expect(healthcheck.start_period).toBe(startPeriod);
  });

  // The reason the rule above is load-bearing rather than stylistic. If these
  // dependencies are ever dropped, revisit it deliberately — do not let a
  // readiness probe drift back into `healthcheck:` because "nothing depends on
  // it any more" turned out to be temporarily true.
  it.each([
    ['docker-compose.yml', ['caddy', 'web', 'portal']],
    ['deploy/docker-compose.prod.yml', ['caddy', 'web', 'portal']],
  ])('%s gates %s startup on the API healthcheck', (path, dependents) => {
    const document = load(read(path)) as {
      services: Record<string, { depends_on?: Record<string, { condition: string }> }>;
    };

    for (const name of dependents) {
      expect(document.services[name]?.depends_on?.api?.condition).toBe('service_healthy');
    }
  });

  it('uses readiness, not liveness, for the post-deploy admission gate', () => {
    const deploy = read('scripts/prod/deploy.sh');
    expect(deploy).toContain('https://${BREEZE_DOMAIN}/ready');
    expect(deploy).not.toMatch(/curl[^\n]+https:\/\/\$\{BREEZE_DOMAIN\}\/health/);
  });

  // `curl --fail` only fails at >= 400, so an authenticating proxy answering
  // /ready with a 302 to its identity provider exits 0 and the gate proves
  // nothing — measured against a live Cloudflare Access instance, where the
  // Access policy covered /health but not /ready. Assert the unredirected
  // status is exactly 200 and that the body carries Breeze's own verdict.
  it('asserts an exact 200 and a ready body, not merely a non-4xx response', () => {
    const deploy = read('scripts/prod/deploy.sh');

    expect(deploy).toContain("--write-out '%{http_code}'");
    expect(deploy).toContain('"ready":true');
    // -L can follow the redirect onto a 200 login page, which passes for the
    // same reason the bare --fail check does.
    expect(deploy).not.toMatch(/curl[^\n]*\s-L\b/);
    // The smoke loop and its final check must both go through the helper.
    expect(deploy).not.toMatch(/curl[^\n]+--fail[^\n]+\/ready/);
  });

  it('keeps both liveness routes mounted independently of readiness', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain("app.get('/health',");
    expect(index).toContain("app.get('/health/live',");
  });

  it('invalidates the single readiness evaluator on registry transitions', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain('setWorkerReadinessTransitionHandler(() => readiness.invalidate())');
  });

  // Track C's initializeDeclaredWorkerGroup was deleted when index.ts moved
  // onto the worker registry's onResult seam; this is where its behavior
  // lives now (registry entries via onResult, plus the two out-of-registry
  // starters). A source pin, because no test on either side exercises
  // initializeWorkers()' body.
  it('records initialization failure for every consumer of a failed initializer', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain('for (const consumer of consumersForInitializer(name))');
    expect(index).toContain("for (const consumer of consumersForInitializer('eventDispatch'))");
    expect(index).toContain("for (const consumer of consumersForInitializer('agentCommandRelay'))");
    expect(index.match(/workerReadinessRegistry\.recordInitializationFailure\(consumer, error\)/g)).toHaveLength(3);
    expect(index).not.toContain('initializeDeclaredWorkerGroup');
  });

  // Task 3's declare-time rules only hold if index.ts hands the manifest the
  // live role and the three real flag expressions. Nothing else exercises
  // initializeWorkers()' body, so pin the call site's arguments as text —
  // a hardcoded `role: 'all'` or `eventDispatchEnabled: true` would silently
  // re-require every socket-owner / flag-gated consumer on a worker-only box.
  it('declares expected consumers from the live role and the three feature-flag expressions', () => {
    const index = read('apps/api/src/index.ts');
    const call = index.slice(
      index.indexOf('declareExpectedConsumers({'),
      index.indexOf('});', index.indexOf('declareExpectedConsumers({')),
    );
    expect(call).toContain('role: breezeRole()');
    expect(call).toContain("eventDispatchEnabled: eventDispatchMode() !== 'off'");
    expect(call).toContain('aiAgentsEnabled: AI_AGENTS_ENABLED');
    expect(call).toContain('abuseSignalsEnabled: abuseSignalsEnabled()');
    expect(call).toContain('registry: workerReadinessRegistry');
  });

  // D5: the worker container (profile worker-split) DOES healthcheck
  // readiness, and that is safe only because nothing depends_on it: an
  // unhealthy worker only shows `unhealthy` in `docker compose ps` (Compose
  // does not restart on unhealthy), gates no other service's startup, and
  // deploy.sh runs `compose up -d` without --wait. The zero-dependents
  // assertion is what makes the api rule above and this one consistent.
  it.each([
    ['docker-compose.yml'],
    ['deploy/docker-compose.prod.yml'],
  ])('%s healthchecks the worker service on READINESS because no service depends on it', (path) => {
    const document = load(read(path)) as {
      services: Record<string, { healthcheck?: { test: string[] }; depends_on?: Record<string, unknown> }>;
    };
    const probe = document.services.worker?.healthcheck?.test.join(' ') ?? '';
    expect(probe).toContain('http://127.0.0.1:3001/health/ready');
    const dependents = Object.entries(document.services)
      .filter(([, service]) => service.depends_on !== undefined && 'worker' in service.depends_on)
      .map(([name]) => name);
    expect(dependents).toEqual([]);
  });

  it('deploy.sh never waits on container health (so an unhealthy worker cannot block a deploy)', () => {
    const deploy = read('scripts/prod/deploy.sh');
    expect(deploy).not.toMatch(/compose[^\n]*\bup\b[^\n]*--wait\b/);
  });
});
