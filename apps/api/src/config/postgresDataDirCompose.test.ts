// Render contract for the Postgres data directory in the compose files that
// run a postgres service with persistent storage (#11416 W2, #11418).
//
// The Postgres 18 images moved their default PGDATA from
// /var/lib/postgresql/data to /var/lib/postgresql/18/docker and declare
// `VOLUME /var/lib/postgresql`. These compose files mount their named volume
// at /var/lib/postgresql/data, so without a pinned PGDATA a pg18 image sees
// that mount as unused and refuses to start (lab-verified on pgvector:pg18,
// 18.6). Pinning PGDATA to the mount target keeps one layout for every major
// and leaves existing 16 volumes exactly where they are (same path as the 16
// default). A per-worktree stack swaps the volume for a tmpfs at the same path.
//
// docker-compose.test.yml (tmpfs) has the same contract, checked by
// scripts/dev/test-stack/composePostgres.test.ts.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// The first `docker compose` spawn on a cold CI runner bootstraps the plugin
// (observed at 5.3 s, over vitest's 5 s default); see
// apps/api/src/db/requestDatabaseCompose.test.ts.
const DOCKER_SPAWN_TIMEOUT_MS = 60_000;

beforeAll(() => {
  execFileSync('docker', ['compose', 'version'], { cwd: REPO_ROOT, encoding: 'utf8' });
}, DOCKER_SPAWN_TIMEOUT_MS);

type Mount = { type: string; source?: string; target: string };
type RenderedService = {
  image: string;
  environment?: Record<string, string | null>;
  volumes?: Mount[] | null;
  tmpfs?: string[] | null;
};

// Variables that would change what the shipped files render. They are removed
// from the inherited environment so a developer's shell cannot flip a result.
const SCRUBBED = ['POSTGRES_IMAGE_REF', 'POSTGRES_DATA_VOLUME', 'PGDATA', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'];

/**
 * `docker compose config` for the given files, with .env.example as the env
 * file (it carries a value for every required variable) and `overrides`
 * layered on top. Process env wins over --env-file in compose interpolation.
 */
function renderConfig(files: string[], overrides: Record<string, string> = {}): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUBBED.includes(k)) env[k] = v;
  }
  Object.assign(env, overrides);
  const rendered = execFileSync('docker', [
    'compose', '--project-directory', REPO_ROOT,
    ...files.flatMap((f) => ['-f', path.join(REPO_ROOT, f)]),
    '--env-file', path.join(REPO_ROOT, '.env.example'),
    'config', '--format', 'json',
  ], { cwd: REPO_ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return rendered;
}

function renderPostgres(files: string[], overrides: Record<string, string> = {}): RenderedService {
  return (JSON.parse(renderConfig(files, overrides)) as { services: Record<string, RenderedService> }).services.postgres!;
}

const namedVolumeTargets = (svc: RenderedService) =>
  (svc.volumes ?? []).filter((m) => m.type === 'volume' && m.source).map((m) => m.target);
const tmpfsTargets = (svc: RenderedService) => (svc.tmpfs ?? []).map((t) => t.split(':')[0]);

const IMAGES = ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'];

describe('docker-compose.yml postgres data directory', () => {
  it.each(IMAGES)('pins PGDATA to the named-volume mount on %s', (image) => {
    const svc = renderPostgres(['docker-compose.yml'], { POSTGRES_IMAGE_REF: image });
    expect(svc.image).toBe(image);
    const pgdata = svc.environment?.PGDATA;
    expect(pgdata, 'PGDATA must be set: pg18 images default it outside the named volume').toBeTruthy();
    expect(namedVolumeTargets(svc)).toContain(pgdata);
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('keeps the existing 16 layout: PGDATA is the 16 default and the mount is unchanged', () => {
    // An existing install must come back on the same directory of the same
    // volume after the container is recreated with this file.
    const svc = renderPostgres(['docker-compose.yml'], { POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg16' });
    expect(svc.environment?.PGDATA).toBe('/var/lib/postgresql/data');
    expect(svc.volumes).toEqual([
      expect.objectContaining({ type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' }),
    ]);
  }, DOCKER_SPAWN_TIMEOUT_MS);

  // POSTGRES_DATA_VOLUME selects which declared volume holds the data, so the
  // PostgreSQL 16 -> 18 runbook can restore into a second volume while the old
  // one stays untouched as the rollback. It is read by every path that starts
  // the stack (guided-setup.sh and its boot service pass -f docker-compose.yml
  // --env-file .env, which never loads docker-compose.override.yml).
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('mounts postgres_data when POSTGRES_DATA_VOLUME is %s', (_label, value) => {
    const overrides: Record<string, string> = { POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg16' };
    if (value !== undefined) overrides.POSTGRES_DATA_VOLUME = value;
    const svc = renderPostgres(['docker-compose.yml'], overrides);
    expect(svc.volumes?.map((m) => m.source)).toEqual(['postgres_data']);
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('mounts the alternate slot, at the same PGDATA, when POSTGRES_DATA_VOLUME=postgres_data_alt', () => {
    const svc = renderPostgres(['docker-compose.yml'], {
      POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg18',
      POSTGRES_DATA_VOLUME: 'postgres_data_alt',
    });
    expect(svc.volumes).toEqual([
      expect.objectContaining({ type: 'volume', source: 'postgres_data_alt', target: '/var/lib/postgresql/data' }),
    ]);
    expect(svc.environment?.PGDATA).toBe('/var/lib/postgresql/data');
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('refuses to render when POSTGRES_DATA_VOLUME names an undeclared volume', () => {
    // Fail closed: a typo must stop `docker compose`, never start Postgres on
    // a new empty volume.
    expect(() => renderConfig(['docker-compose.yml'], {
      POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg18',
      POSTGRES_DATA_VOLUME: 'postgres_data_typo',
    })).toThrow(/undefined volume postgres_data_typo/);
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('keeps PGDATA on the tmpfs in the per-worktree stack (dev + worktree overrides)', () => {
    // docker-compose.override.yml.worktree resets the volumes and mounts a
    // tmpfs at /var/lib/postgresql/data; the inherited PGDATA must name it,
    // or a pg18 worktree stack writes to the container filesystem.
    const svc = renderPostgres(
      ['docker-compose.yml', 'docker-compose.override.yml.dev', 'docker-compose.override.yml.worktree'],
      { POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg18' },
    );
    expect(namedVolumeTargets(svc)).toEqual([]);
    expect(svc.environment?.PGDATA).toBeTruthy();
    expect(tmpfsTargets(svc)).toContain(svc.environment?.PGDATA);
  }, DOCKER_SPAWN_TIMEOUT_MS);
});

describe('docker-compose.dev.yml postgres data directory', () => {
  it('pins PGDATA to the named-volume mount', () => {
    // The image is hard-coded here (the default bump is a separate, gated
    // change), so only the layout is asserted.
    const svc = renderPostgres(['docker-compose.dev.yml']);
    const pgdata = svc.environment?.PGDATA;
    expect(pgdata).toBe('/var/lib/postgresql/data');
    expect(namedVolumeTargets(svc)).toContain(pgdata);
  }, DOCKER_SPAWN_TIMEOUT_MS);
});
