// Render contract for docker-compose.test.yml's postgres service (#11417).
//
// The image is parameterized (BREEZE_TEST_PG_IMAGE) so CI's scheduled
// Postgres 17/18 workflow and a local `BREEZE_TEST_PG_IMAGE=... pnpm
// test-stack up` run the same stack on another major. The Postgres 18 images
// moved their default PGDATA to /var/lib/postgresql/18/docker, OUTSIDE the
// tmpfs this service mounts — so without a pinned PGDATA a pg18 stack writes
// to the container filesystem and the "throwaway tmpfs" claim silently stops
// being true. PGDATA must name the tmpfs mount for every image.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// The first `docker compose` spawn on a cold CI runner bootstraps the plugin
// (observed at 5.3 s, over vitest's 5 s default); see
// apps/api/src/db/requestDatabaseCompose.test.ts.
const DOCKER_SPAWN_TIMEOUT_MS = 60_000;

beforeAll(() => {
  execFileSync('docker', ['compose', 'version'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
}, DOCKER_SPAWN_TIMEOUT_MS);

type RenderedService = {
  image: string;
  environment?: Record<string, string>;
  tmpfs?: string[];
};

function renderPostgresTest(overrides: Record<string, string | undefined>): RenderedService {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  // An unset override means "not in the environment at all", not "empty".
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
  const rendered = execFileSync('docker', [
    'compose', '--project-directory', REPOSITORY_ROOT,
    '-f', path.join(REPOSITORY_ROOT, 'docker-compose.test.yml'),
    'config', '--format', 'json',
  ], { cwd: REPOSITORY_ROOT, encoding: 'utf8', env });
  return (JSON.parse(rendered) as { services: Record<string, RenderedService> }).services['postgres-test']!;
}

/** tmpfs entries render as `path` or `path:options`; keep the path. */
const tmpfsTargets = (svc: RenderedService) => (svc.tmpfs ?? []).map((t) => t.split(':')[0]);

describe('docker-compose.test.yml postgres-test service', () => {
  it('defaults to the pgvector pg16 image when BREEZE_TEST_PG_IMAGE is unset', () => {
    expect(renderPostgresTest({ BREEZE_TEST_PG_IMAGE: undefined }).image).toBe('pgvector/pgvector:pg16');
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('takes its image from BREEZE_TEST_PG_IMAGE', () => {
    expect(renderPostgresTest({ BREEZE_TEST_PG_IMAGE: 'pgvector/pgvector:pg18' }).image)
      .toBe('pgvector/pgvector:pg18');
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it.each([
    ['pgvector/pgvector:pg16'],
    ['pgvector/pgvector:pg18'],
  ])('pins PGDATA to the tmpfs mount on %s', (image) => {
    const svc = renderPostgresTest({ BREEZE_TEST_PG_IMAGE: image });
    const pgdata = svc.environment?.PGDATA;
    expect(pgdata, 'PGDATA must be set: pg18 images default it outside the tmpfs').toBeTruthy();
    expect(tmpfsTargets(svc)).toContain(pgdata);
  }, DOCKER_SPAWN_TIMEOUT_MS);
});
