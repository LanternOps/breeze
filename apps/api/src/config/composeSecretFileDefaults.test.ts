import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, defineMappingTag, defineScalarTag, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * Docker Compose's standalone (non-swarm) file-secret support bind-mounts a
 * `secrets.<name>.file:` source into the container's overlay rootfs and
 * remounts it read-only. `docker-compose.yml` and `deploy/docker-compose.prod.yml`
 * default three optional M365 executor signing-key secrets'
 * `${..._SOURCE_FILE:-...}` to a source file when the operator leaves the var
 * unset — the common case, since these features are documented off-by-default
 * (`.env.example`).
 *
 * That default used to be the `/dev/null` character device. Bind-mounting
 * `/dev/null` and remounting it read-only inside overlayfs is rejected by the
 * kernel with EPERM on a number of host kernel/storage-driver combinations,
 * failing `docker compose up` with `remount-ro ... operation not permitted`
 * for anyone who never touched the M365 write-actions feature (#2991) — a
 * regular file has no such restriction. The fix points the default at a
 * tracked, always-empty regular file (`docker/secrets/.empty-jwk`) instead.
 *
 * The guard: every `secrets.<name>.file:` **default** value (the fallback in
 * `${VAR:-default}`, or a literal un-interpolated path) in a tracked Compose
 * file must resolve to an existing REGULAR file — not missing, not a
 * directory, and not a device node like `/dev/null`. This lives in the
 * required `test-api` job so a reintroduced `/dev/null` (or any other
 * non-regular-file default) cannot go green.
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

interface SecretFileEntry {
  composeFile: string; // repo-root-relative
  secretName: string;
  rawFile: string; // exactly as written in the YAML (may contain ${VAR:-default})
}

function trackedComposeFiles(): string[] {
  // Tracked files only, same discovery as composeBindMounts.test.ts.
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '*docker-compose*.yml*', '*docker-compose*', '*compose.yml', '*compose.yaml'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const files = out.split('\0').filter(Boolean);
  return [...new Set(files)]
    .filter((f) => /(^|\/)(docker-)?compose[^/]*\.(yml|yaml)(\.[A-Za-z0-9_-]+)?$/.test(f))
    .filter((f) => existsSync(path.join(REPO_ROOT, f)))
    .sort();
}

function collectSecretFileEntries(composeFile: string): SecretFileEntry[] {
  const abs = path.join(REPO_ROOT, composeFile);
  const doc = load(readFileSync(abs, 'utf8'), { schema: COMPOSE_SCHEMA }) as {
    secrets?: Record<string, { file?: unknown }>;
  } | null;

  const entries: SecretFileEntry[] = [];
  for (const [secretName, def] of Object.entries(doc?.secrets ?? {})) {
    const rawFile = def?.file;
    if (typeof rawFile !== 'string' || rawFile.length === 0) continue; // e.g. `environment:`-sourced secrets
    entries.push({ composeFile, secretName, rawFile });
  }
  return entries;
}

/** `${VAR:-default}` -> "default"; a literal (non-interpolated) path is returned as-is. */
function extractDefault(rawFile: string): string | null {
  const match = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$/.exec(rawFile);
  if (match) return match[1] ?? ''; // may be '' if the author wrote `${VAR:-}` (no default)
  if (rawFile.includes('$')) return null; // `${VAR}` / `${VAR:?msg}` — no static default to check
  return rawFile; // literal path, no interpolation at all
}

const composeFiles = trackedComposeFiles();
const allSecretFileEntries = composeFiles.flatMap(collectSecretFileEntries);

describe('Compose secret file: defaults', () => {
  // Fail closed: if discovery silently breaks, the suite must not pass vacuously.
  it('discovers the tracked compose files and their file-backed secrets', () => {
    expect(composeFiles).toContain('docker-compose.yml');
    expect(composeFiles).toContain('deploy/docker-compose.prod.yml');
    expect(allSecretFileEntries.length).toBeGreaterThanOrEqual(5);
    expect(allSecretFileEntries.some((e) => e.secretName.includes('m365'))).toBe(true);
  });

  it('resolves every file: secret default to an existing regular file', () => {
    const problems: string[] = [];

    for (const entry of allSecretFileEntries) {
      const defaultValue = extractDefault(entry.rawFile);
      if (defaultValue === null || defaultValue === '') continue; // no static default to check

      const composeDir = path.dirname(path.join(REPO_ROOT, entry.composeFile));
      const resolved = defaultValue.startsWith('/')
        ? defaultValue
        : path.resolve(composeDir, defaultValue);

      if (!existsSync(resolved)) {
        problems.push(
          `${entry.composeFile}: secret "${entry.secretName}" file: default "${defaultValue}" ` +
            `does not exist (looked for ${resolved}). Docker would fail to bind-mount it, or ` +
            `create a phantom directory in its place.`,
        );
        continue;
      }

      if (!statSync(resolved).isFile()) {
        problems.push(
          `${entry.composeFile}: secret "${entry.secretName}" file: default "${defaultValue}" ` +
            `(${resolved}) is not a regular file — Compose bind-mounts it and remounts it ` +
            `read-only, which the kernel rejects for device nodes like /dev/null (EPERM: ` +
            `"remount-ro ... operation not permitted", #2991) on some host kernel/storage-` +
            `driver combinations. Point the default at a tracked empty regular file instead ` +
            `(see docker/secrets/README.md).`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('never defaults a file: secret straight to /dev/null', () => {
    // Belt-and-suspenders: catches the literal regression even if some future
    // host made a device-node remount succeed and the generic isFile() check
    // above stopped firing for it.
    const devNullDefaults = allSecretFileEntries
      .map((e) => ({ ...e, defaultValue: extractDefault(e.rawFile) }))
      .filter((e) => e.defaultValue === '/dev/null');

    expect(devNullDefaults).toEqual([]);
  });
});
