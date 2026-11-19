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
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  entrypoint?: string[] | null;
  command?: string[] | null;
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

// The PGDATA pin above is right for every install that takes the whole
// postgres service block. One population it would hurt: an install already on
// Postgres 18 with the upstream layout (volume mounted at /var/lib/postgresql,
// cluster in /var/lib/postgresql/18/docker) that takes the pin but keeps its
// mount. PGDATA then names an empty directory and the image's entrypoint
// initdb's a new, EMPTY cluster; the API migrates it and Breeze looks freshly
// installed (lab-verified on pgvector:pg18, 18.6). The service's entrypoint
// wraps the image's to refuse that start. These cases run the rendered wrapper
// under sh against a temp directory standing in for /var/lib/postgresql, with
// a stub docker-entrypoint.sh on PATH.
describe('docker-compose.yml postgres empty-cluster guard', () => {
  let svc: RenderedService;
  beforeAll(() => {
    svc = renderPostgres(['docker-compose.yml'], { POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg18' });
  }, DOCKER_SPAWN_TIMEOUT_MS);

  let root: string;
  let stubDir: string;
  let marker: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'pgdata-guard-'));
    stubDir = path.join(root, 'bin');
    marker = path.join(root, 'exec-args');
    mkdirSync(stubDir);
    const stub = path.join(stubDir, 'docker-entrypoint.sh');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
    chmodSync(stub, 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function cluster(dir: string, version: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'PG_VERSION'), `${version}\n`);
  }

  /** Runs the rendered entrypoint + command as the container would. */
  function runGuard(command: string[] = svc.command ?? [], pgdata = path.join(root, 'data')) {
    const entrypoint = svc.entrypoint ?? [];
    expect(entrypoint.length, 'postgres must set an entrypoint that wraps the image entrypoint').toBeGreaterThan(0);
    // Compose turns `$$` into `$` when it creates the container; `config` keeps it.
    const argv = [...entrypoint, ...command].map((a) => a.replaceAll('$$', '$'));
    const r = spawnSync(argv[0]!, argv.slice(1), {
      encoding: 'utf8',
      env: { PATH: `${stubDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, PGDATA: pgdata },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      execArgs: existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : null,
    };
  }

  it('keeps the image default command, so an overlay command still reaches postgres', () => {
    expect(svc.command).toEqual(['postgres']);
    const worktree = renderPostgres(
      ['docker-compose.yml', 'docker-compose.override.yml.dev', 'docker-compose.override.yml.worktree'],
      { POSTGRES_IMAGE_REF: 'pgvector/pgvector:pg18' },
    );
    expect(worktree.entrypoint).toEqual(svc.entrypoint);
    expect(worktree.command?.[0]).toBe('postgres');
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('hands a fresh install (empty PGDATA) to the image entrypoint', () => {
    mkdirSync(path.join(root, 'data'));
    // What a fresh 18 image leaves behind: its default data dir, with no cluster.
    mkdirSync(path.join(root, '18', 'docker'), { recursive: true });
    const r = runGuard();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.execArgs).toEqual(['postgres']);
  });

  it('hands a PGDATA that does not exist yet to the image entrypoint', () => {
    const r = runGuard();
    expect(r.status).toBe(0);
    expect(r.execArgs).toEqual(['postgres']);
  });

  it('starts an existing cluster in PGDATA, passing the command through', () => {
    cluster(path.join(root, 'data'), '16');
    const r = runGuard(['postgres', '-c', 'fsync=off']);
    expect(r.status).toBe(0);
    expect(r.execArgs).toEqual(['postgres', '-c', 'fsync=off']);
  });

  it('refuses the upstream 18 layout (cluster in 18/docker beside an empty PGDATA)', () => {
    mkdirSync(path.join(root, 'data'));
    const existing = path.join(root, '18', 'docker');
    cluster(existing, '18');
    const r = runGuard();
    expect(r.status).not.toBe(0);
    expect(r.execArgs, 'the image entrypoint (and initdb) must not run').toBeNull();
    expect(existsSync(path.join(root, 'data', 'PG_VERSION'))).toBe(false);
    expect(r.stderr).toContain('refusing to start');
    expect(r.stderr).toContain(`PGDATA: ${existing}`);
    expect(r.stderr).toContain('EMPTY');
  });

  it('refuses a whole-file upgrade over an upstream-layout volume (cluster in PGDATA/18/docker)', () => {
    const existing = path.join(root, 'data', '18', 'docker');
    cluster(existing, '18');
    const r = runGuard();
    expect(r.status).not.toBe(0);
    expect(r.execArgs).toBeNull();
    expect(r.stderr).toContain(`PGDATA: ${existing}`);
  });

  it('refuses a cluster at the parent of PGDATA (a 16-style volume mounted one level up)', () => {
    cluster(root, '16');
    const r = runGuard();
    expect(r.status).not.toBe(0);
    expect(r.execArgs).toBeNull();
    expect(r.stderr).toContain(`PGDATA: ${root}`);
  });

  it('does not block a one-off non-server command', () => {
    cluster(path.join(root, '18', 'docker'), '18');
    const r = runGuard(['psql', '--version']);
    expect(r.status).toBe(0);
    expect(r.execArgs).toEqual(['psql', '--version']);
  });
});
