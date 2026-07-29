import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, defineMappingTag, defineScalarTag, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as envComposeParity.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * Docker creates a MISSING bind-mount source as an empty **directory** on the
 * host. When the source was meant to be a file, that phantom directory litters
 * the working tree and — because the dev Dockerfiles `COPY apps/web ./apps/web`
 * wholesale — lands inside the image, where Vite/PostCSS config discovery dies
 * on it (`EISDIR: illegal operation on a directory`). `breeze-web` then never
 * passes its healthcheck on a fresh clone.
 *
 * The trigger is always the same: a config file gets deleted and nobody sweeps
 * the Compose mounts that referenced it. It has shipped three times:
 *   #1999 — postcss.config.mjs, after the Tailwind 4 migration
 *   #2208 — tailwind.config.mjs, but only in docker-compose.override.yml.dev
 *   #2012 — the two tailwind.config.mjs mounts #2208 missed
 *
 * The guard: every **file-shaped**, **repo-relative** bind-mount source in a
 * tracked Compose file must exist as a file. This lives in the required
 * `test-api` job so a fourth recurrence cannot go green.
 */

// Compose's own merge tags. js-yaml throws on unknown tags, so declare them as
// pass-throughs — we never inspect their values, we just need the file to parse.
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

/**
 * Sources whose basename contains a dot but which are legitimately
 * DIRECTORIES (e.g. `certs/live.d`, `assets.v2`). Empty today. Add an entry —
 * repo-root-relative, with a reason — rather than weakening the heuristic. A
 * stale entry fails the suite below, so this list cannot rot.
 */
const DOTTED_DIRECTORY_SOURCES: Record<string, string> = {};

interface Mount {
  composeFile: string; // repo-root-relative
  rawSource: string; // exactly as written in the YAML
  resolved: string; // absolute
}

function trackedComposeFiles(): string[] {
  // Tracked files only: a developer's untracked `docker-compose.override.yml.mine`
  // is their business, and this skips vendored compose files under node_modules.
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '*docker-compose*.yml*', '*docker-compose*', '*compose.yml', '*compose.yaml'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const files = out.split('\0').filter(Boolean);
  // Note the optional trailing suffix: the mode overrides are named
  // `docker-compose.override.yml.dev` / `.worktree` / `.ci` / … — anchoring on a
  // `.yml` *ending* would silently skip the very files that carried #2012.
  return [...new Set(files)]
    .filter((f) => /(^|\/)(docker-)?compose[^/]*\.(yml|yaml)(\.[A-Za-z0-9_-]+)?$/.test(f))
    // `git ls-files` also lists files staged-but-deleted, or absent under a
    // sparse checkout. Skip those rather than throwing ENOENT.
    .filter((f) => existsSync(path.join(REPO_ROOT, f)))
    .sort();
}

/** Extract the host side of a short-syntax volume entry (`SOURCE:TARGET[:MODE]`). */
function shortSyntaxSource(entry: string): string | null {
  const colon = entry.indexOf(':', 1);
  if (colon === -1) return null; // anonymous volume — target only, no source
  return entry.slice(0, colon);
}

function collectMounts(composeFile: string): Mount[] {
  const abs = path.join(REPO_ROOT, composeFile);
  const composeDir = path.dirname(abs);
  const doc = load(readFileSync(abs, 'utf8'), { schema: COMPOSE_SCHEMA }) as {
    services?: Record<string, { volumes?: unknown }>;
  } | null;

  const mounts: Mount[] = [];
  for (const service of Object.values(doc?.services ?? {})) {
    const volumes = service?.volumes;
    if (!Array.isArray(volumes)) continue;

    for (const volume of volumes) {
      let source: string | null = null;

      if (typeof volume === 'string') {
        source = shortSyntaxSource(volume);
      } else if (volume && typeof volume === 'object') {
        const long = volume as { type?: unknown; source?: unknown };
        // Long syntax. `type` defaults to `volume`; only binds have a host path.
        if (long.type === 'bind' && typeof long.source === 'string') source = long.source;
      }

      if (!source) continue;
      // Interpolated paths aren't knowable statically.
      if (source.includes('$')) continue;
      // Only repo-relative sources. Named volumes (`caddy_data`) and absolute
      // host paths (`/var/run/docker.sock`) are not ours to validate.
      if (!source.startsWith('./') && !source.startsWith('../')) continue;

      mounts.push({ composeFile, rawSource: source, resolved: path.resolve(composeDir, source) });
    }
  }
  return mounts;
}

const composeFiles = trackedComposeFiles();
const allMounts = composeFiles.flatMap(collectMounts);

/** Inside the repo? `../breeze-billing/...` (a sibling repo) is not. */
function isInsideRepo(abs: string): boolean {
  const rel = path.relative(REPO_ROOT, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Dot in the basename => meant to be a file. `./agent/bin` is a build output. */
function isFileShaped(source: string): boolean {
  return path.basename(source).includes('.');
}

describe('Compose bind-mount sources', () => {
  // Fail closed: if discovery silently breaks, the suite must not pass vacuously.
  it('discovers the tracked compose files and their mounts', () => {
    expect(composeFiles).toContain('docker-compose.yml');
    expect(composeFiles).toContain('docker-compose.dev.yml');
    expect(composeFiles).toContain('deploy/docker-compose.prod.yml');
    // The mode overrides must be in scope — #2012's two stale mounts lived in
    // docker-compose.dev.yml and docker-compose.override.yml.worktree.
    expect(composeFiles).toContain('docker-compose.override.yml.dev');
    expect(composeFiles).toContain('docker-compose.override.yml.worktree');
    expect(composeFiles.length).toBeGreaterThanOrEqual(10);
    expect(allMounts.length).toBeGreaterThanOrEqual(30);

    // Parent-relative sources must be in scope, resolved against the compose
    // file's own directory. deploy/docker-compose.prod.yml mounts
    // `../docker/Caddyfile.prod` — a repo file the production stack depends on.
    const caddyfile = path.join(REPO_ROOT, 'docker/Caddyfile.prod');
    expect(allMounts.map((m) => m.resolved)).toContain(caddyfile);
  });

  it('mounts every file-shaped source from a file that actually exists', () => {
    const problems: string[] = [];

    for (const mount of allMounts) {
      if (!isInsideRepo(mount.resolved)) continue; // sibling repo / outside checkout
      if (!isFileShaped(mount.rawSource)) continue; // directory mount, created on demand

      const relResolved = path.relative(REPO_ROOT, mount.resolved);
      if (DOTTED_DIRECTORY_SOURCES[relResolved]) continue;

      if (!existsSync(mount.resolved)) {
        problems.push(
          `${mount.composeFile}: bind-mount source "${mount.rawSource}" does not exist ` +
            `(looked for ${relResolved}). Docker would create it as an empty directory on ` +
            `\`docker compose up\`. Drop the mount if the file was deleted, or restore the file.`,
        );
        continue;
      }

      if (statSync(mount.resolved).isDirectory()) {
        problems.push(
          `${mount.composeFile}: bind-mount source "${mount.rawSource}" is a DIRECTORY but is ` +
            `mounted as a file. This is the phantom directory Docker created from a stale ` +
            `mount — remove it (\`rmdir ${relResolved}\`), or add it to ` +
            `DOTTED_DIRECTORY_SOURCES if it is a genuine directory.`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps DOTTED_DIRECTORY_SOURCES free of stale entries', () => {
    const stale = Object.keys(DOTTED_DIRECTORY_SOURCES).filter((rel) => {
      const abs = path.join(REPO_ROOT, rel);
      // Stale = no longer mounted anywhere, or no longer a directory.
      const stillMounted = allMounts.some((m) => m.resolved === abs);
      return !stillMounted || !existsSync(abs) || !statSync(abs).isDirectory();
    });

    expect(stale).toEqual([]);
  });
});
