import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, defineMappingTag, defineScalarTag, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * The local dev/test stacks publish throwaway services to the host: the
 * integration-test Postgres (fixed password) and Redis (no auth) from
 * docker-compose.test.yml, and the per-worktree api/web/caddy (a seeded admin)
 * from docker-compose.override.yml.worktree. A short-syntax mapping with no
 * host address (`"5433:5432"`, `"0:3001"`) binds every interface, so anyone on
 * the same network can reach them. Every client of these stacks (CI, vitest,
 * Playwright, `pnpm test-stack`, `pnpm wt-stack`) connects via localhost, so
 * the default host address is loopback; BREEZE_TEST_BIND_ADDR /
 * BREEZE_WT_BIND_ADDR opt back in to another address.
 *
 * #9382 brought the two dev stacks under the same rule, via
 * BREEZE_DEV_BIND_ADDR: docker-compose.override.yml.dev (the documented
 * quickstart, whose Postgres password comes from .env, where .env.example
 * ships a placeholder) and docker-compose.dev.yml (the legacy stack, with
 * fixed breeze/breeze Postgres and minioadmin MinIO credentials). Both are
 * checked with no per-service exceptions, so adding a published port to either
 * file without a host address fails here.
 */

// Compose's own merge tags. js-yaml throws on unknown tags, so declare them as
// pass-throughs (same approach as composeBindMounts.test.ts).
const passthroughTag = (tag: string) => [
  defineScalarTag(tag, { resolve: (source: string) => source, identify: () => false }),
  defineSequenceTag<unknown[]>(tag, {
    identify: () => false,
    create: () => [],
    addItem: (items, value) => {
      items.push(value);
    },
  }),
  defineMappingTag<Map<unknown, unknown>>(tag, {
    identify: () => false,
    create: () => new Map(),
    addPair: (map, key, value) => {
      map.set(key, value);
      return '';
    },
    has: (map, key) => map.has(key),
    keys: (map) => map.keys(),
    get: (map, key) => map.get(key),
  }),
];

const COMPOSE_SCHEMA = CORE_SCHEMA.withTags([
  ...passthroughTag('!reset'),
  ...passthroughTag('!override'),
]);

/** Published port entries per service, exactly as written in the YAML. */
function portEntries(composeFile: string): Record<string, unknown[]> {
  const doc = load(readFileSync(path.join(REPO_ROOT, composeFile), 'utf8'), { schema: COMPOSE_SCHEMA }) as {
    services?: Record<string, { ports?: unknown }>;
  } | null;
  const out: Record<string, unknown[]> = {};
  for (const [name, service] of Object.entries(doc?.services ?? {})) {
    if (Array.isArray(service?.ports) && service.ports.length > 0) out[name] = service.ports;
  }
  return out;
}

/** Compose's `${VAR}` / `${VAR:-default}` interpolation (unset or empty -> default). */
function interpolate(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, fallback = '') => env[name] || fallback);
}

function renderedMappings(composeFile: string, env: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [service, entries] of Object.entries(portEntries(composeFile))) {
    out[service] = entries.map((entry) => {
      // Long-syntax entries would need their own host_ip check; none exist today.
      expect(typeof entry, `${composeFile} ${service}: expected a short-syntax port string`).toBe('string');
      return interpolate(entry as string, env);
    });
  }
  return out;
}

const LOOPBACK_MAPPING = /^127\.0\.0\.1:\d+:\d+$/;

describe('docker-compose.test.yml publishes on loopback', () => {
  // {} is plain `docker compose -f docker-compose.test.yml up` (CI); the
  // ephemeral-port env mirrors stackEnv() in scripts/dev/test-stack/project.ts.
  it.each([
    ['fixed default ports', {}],
    ['pnpm test-stack ephemeral ports', { BREEZE_TEST_PG_PORT: '0', BREEZE_TEST_REDIS_PORT: '0' }],
  ])('binds every published port to 127.0.0.1 (%s)', (_label, env: Record<string, string>) => {
    const mappings = renderedMappings('docker-compose.test.yml', env);
    expect(Object.keys(mappings).sort()).toEqual(['postgres-test', 'redis-test']);
    for (const [service, rendered] of Object.entries(mappings)) {
      for (const mapping of rendered) expect(mapping, service).toMatch(LOOPBACK_MAPPING);
    }
  });

  it('honours BREEZE_TEST_BIND_ADDR as an explicit opt-out', () => {
    const mappings = renderedMappings('docker-compose.test.yml', { BREEZE_TEST_BIND_ADDR: '0.0.0.0' });
    expect(mappings['postgres-test']).toEqual(['0.0.0.0:5433:5432']);
    expect(mappings['redis-test']).toEqual(['0.0.0.0:6380:6379']);
  });
});

describe('docker-compose.override.yml.worktree publishes on loopback', () => {
  it.each([
    ['random caddy port', {}],
    ['pinned caddy port', { BREEZE_WT_CADDY_PORT: '18080' }],
  ])('binds every published port to 127.0.0.1 (%s)', (_label, env: Record<string, string>) => {
    const mappings = renderedMappings('docker-compose.override.yml.worktree', env);
    expect(Object.keys(mappings).sort()).toEqual(['api', 'caddy', 'web']);
    for (const [service, rendered] of Object.entries(mappings)) {
      for (const mapping of rendered) expect(mapping, service).toMatch(LOOPBACK_MAPPING);
    }
  });

  it('keeps the pinned caddy port and honours BREEZE_WT_BIND_ADDR', () => {
    expect(renderedMappings('docker-compose.override.yml.worktree', { BREEZE_WT_CADDY_PORT: '18080' }).caddy)
      .toEqual(['127.0.0.1:18080:80']);
    expect(renderedMappings('docker-compose.override.yml.worktree', { BREEZE_WT_BIND_ADDR: '0.0.0.0' }).caddy)
      .toEqual(['0.0.0.0:0:80']);
  });
});

describe('the dev stacks publish on loopback (#9382)', () => {
  // Both files are checked whole: every service that publishes a port, not a
  // list of the data services. A new published port is then loopback-bound or
  // this test fails, which is the point of extending it here.
  it.each([
    ['docker-compose.override.yml.dev', ['api', 'portal', 'postgres', 'redis', 'web']],
    ['docker-compose.dev.yml', ['api', 'minio', 'postgres', 'redis', 'web']],
  ])('binds every published port in %s to 127.0.0.1', (composeFile, expectedServices: string[]) => {
    const mappings = renderedMappings(composeFile, {});
    // Pinned so a service that stops publishing — or starts — is noticed here
    // rather than silently dropping out of the loop below.
    expect(Object.keys(mappings).sort()).toEqual(expectedServices);
    for (const [service, rendered] of Object.entries(mappings)) {
      expect(rendered.length, `${composeFile} ${service}: expected at least one mapping`).toBeGreaterThan(0);
      for (const mapping of rendered) expect(mapping, `${composeFile} ${service}`).toMatch(LOOPBACK_MAPPING);
    }
  });

  it.each(['docker-compose.override.yml.dev', 'docker-compose.dev.yml'])(
    'honours BREEZE_DEV_BIND_ADDR as an explicit opt-out in %s',
    (composeFile) => {
      const mappings = renderedMappings(composeFile, { BREEZE_DEV_BIND_ADDR: '0.0.0.0' });
      const rendered = Object.values(mappings).flat();
      expect(rendered.length).toBeGreaterThan(0);
      // Every mapping moves, not just the data services: the opt-out is one
      // switch for the whole stack.
      for (const mapping of rendered) expect(mapping).toMatch(/^0\.0\.0\.0:\d+:\d+$/);
    },
  );

  it('publishes the data services on their canonical dev ports', () => {
    // The ports the quickstart, DEVELOPER_GUIDE and every local tool use. The
    // bind address must not have moved them.
    const override = renderedMappings('docker-compose.override.yml.dev', {});
    expect(override.postgres).toEqual(['127.0.0.1:5432:5432']);
    expect(override.redis).toEqual(['127.0.0.1:6379:6379']);
    const legacy = renderedMappings('docker-compose.dev.yml', {});
    expect(legacy.postgres).toEqual(['127.0.0.1:5432:5432']);
    expect(legacy.redis).toEqual(['127.0.0.1:6379:6379']);
    expect(legacy.minio).toEqual(['127.0.0.1:9000:9000', '127.0.0.1:9001:9001']);
  });
});
