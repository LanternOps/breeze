import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, defineMappingTag, defineScalarTag, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Worker-split compose contract (#4144 items 3 and 4).
 *
 *  - The `worker` service must not pin `container_name`: a fixed name makes
 *    `docker compose up --scale worker=N` fail on the second replica.
 *  - The local-build and dev overrides must define `worker`, otherwise
 *    `--profile worker-split` in those modes silently runs the registry image
 *    instead of the code being developed.
 */
const passthrough = (tag: string) => [
  defineScalarTag<string>(tag, { identify: () => false, resolve: (v) => v }),
  defineSequenceTag<unknown[]>(tag, {
    identify: () => false,
    create: () => [],
    addItem: (items, value) => { items.push(value); },
  }),
  defineMappingTag<Map<unknown, unknown>>(tag, {
    identify: () => false,
    create: () => new Map(),
    addPair: (map, key, value) => { map.set(key, value); return ''; },
    has: (map, key) => map.has(key),
    keys: (map) => map.keys(),
    get: (map, key) => map.get(key),
  }),
];
const SCHEMA = CORE_SCHEMA.withTags([...passthrough('!reset'), ...passthrough('!override')]);

type Service = Record<string, unknown>;

function services(rel: string): Record<string, Service> {
  const doc = load(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), { schema: SCHEMA }) as {
    services?: Record<string, Service>;
  };
  return doc.services ?? {};
}

describe('worker-split compose service (#4144)', () => {
  it.each(['docker-compose.yml', 'deploy/docker-compose.prod.yml'])(
    '%s worker has no fixed container_name (scale-out) and stays opt-in',
    (rel) => {
      const worker = services(rel).worker!;
      expect(worker).toBeDefined();
      expect(worker).not.toHaveProperty('container_name');
      expect(worker.profiles).toEqual(['worker-split']);
    },
  );

  it.each([
    'docker-compose.override.yml.dev',
    'docker-compose.override.yml.local-build',
    'docker-compose.override.yml.ghcr',
    'docker-compose.override.yml.ci',
    'docker-compose.override.yml.worktree',
    'docker-compose.override.yml.billing',
    'docker-compose.override.yml.topology-ai-e2e',
    'docker-compose.dev.yml',
    'docker-compose.test.yml',
  ])('%s does not re-pin a worker container_name', (rel) => {
    expect(services(rel).worker ?? {}).not.toHaveProperty('container_name');
  });

  it('local-build override runs the local image for worker', () => {
    const worker = services('docker-compose.override.yml.local-build').worker!;
    expect(worker).toBeDefined();
    expect(worker.image).toBe('breeze-api:local');
  });

  it('dev override runs the source-mounted image for worker', () => {
    const worker = services('docker-compose.override.yml.dev').worker!;
    expect(worker).toBeDefined();
    expect(worker.image).toBe('breeze-api:dev');
    expect(JSON.stringify(worker.command)).toContain('src/worker.ts');
    expect(JSON.stringify(worker.volumes)).toContain('./apps/api/src:/app/apps/api/src');
  });
});
