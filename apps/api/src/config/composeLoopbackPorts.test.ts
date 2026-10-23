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
 */

// Compose's own merge tags. js-yaml throws on unknown tags, so declare them as
// pass-throughs (same approach as composeBindMounts.test.ts).
const passthroughTag = (tag: string) => [
  defineScalarTag(tag, { resolve: (source: string) => source }),
  defineSequenceTag<unknown[]>(tag, {
    create: () => [],
    addItem: (items, value) => {
      items.push(value);
    },
  }),
  defineMappingTag<Map<unknown, unknown>>(tag, {
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
