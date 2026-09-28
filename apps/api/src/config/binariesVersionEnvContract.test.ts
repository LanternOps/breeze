import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// BREEZE_BINARIES_VERSION is the binaries release a server-only API image pairs
// with. It is baked into the image at build time (empty for full releases) and
// read by services/binarySource.ts getPairedBinariesVersion().
//
// It must NEVER be set from compose: `BREEZE_BINARIES_VERSION: ${BREEZE_BINARIES_VERSION:-}`
// in an `environment:` block would set it to the empty string at runtime and
// silently override the baked pairing, sending a server-only image back to
// syncing its own (asset-less) release. The check is on raw text, which covers
// map and list `environment:` forms, `x-` anchors and `env_file` comments alike.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VAR = 'BREEZE_BINARIES_VERSION';

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// Same discovery as composeBindMounts.test.ts (copied, not shared, per the
// repo's duplicate-small-helpers convention).
function trackedComposeFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '*docker-compose*.yml*', '*docker-compose*', '*compose.yml', '*compose.yaml'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => /(^|\/)(docker-)?compose[^/]*\.(yml|yaml)(\.[A-Za-z0-9_-]+)?$/.test(f))
    .filter((f) => existsSync(path.join(REPO_ROOT, f)))
    .sort();
}

/** Lines of the LAST `FROM` stage (the image that actually ships). */
function finalStage(dockerfile: string): string[] {
  const lines = dockerfile.split('\n');
  let start = -1;
  lines.forEach((line, i) => {
    if (/^FROM\s/i.test(line.trim())) start = i;
  });
  expect(start, 'Dockerfile has a FROM stage').toBeGreaterThanOrEqual(0);
  return lines.slice(start);
}

describe('BREEZE_BINARIES_VERSION env contract', () => {
  it.each(['apps/api/Dockerfile', 'docker/Dockerfile.api'])(
    '%s declares the ARG (empty default) and ENV in its final stage',
    (rel) => {
      const stage = finalStage(read(rel)).map((l) => l.trim());
      const argIdx = stage.indexOf(`ARG ${VAR}=""`);
      const envIdx = stage.indexOf(`ENV ${VAR}=\${${VAR}}`);
      expect(argIdx, `${rel}: ARG ${VAR}="" in the final stage`).toBeGreaterThanOrEqual(0);
      expect(envIdx, `${rel}: ENV ${VAR}=\${${VAR}} in the final stage`).toBeGreaterThan(argIdx);
      // Exactly one declaration each: a second ARG with a non-empty default
      // would make full-release images silently pair.
      expect(stage.filter((l) => l.startsWith(`ARG ${VAR}`))).toHaveLength(1);
      expect(stage.filter((l) => l.startsWith(`ENV ${VAR}`))).toHaveLength(1);
    },
  );

  it('discovers the tracked compose files (guards against a vacuous pass)', () => {
    const files = trackedComposeFiles();
    expect(files).toContain('docker-compose.yml');
    expect(files).toContain('deploy/docker-compose.prod.yml');
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('no tracked compose file mentions BREEZE_BINARIES_VERSION', () => {
    const offenders = trackedComposeFiles().filter((f) => read(f).includes(VAR));
    expect(offenders).toEqual([]);
  });

  it.each(['.env.example', 'deploy/.env.example'])(
    '%s has no uncommented BREEZE_BINARIES_VERSION assignment',
    (rel) => {
      const assignments = read(rel)
        .split('\n')
        .filter((line) => new RegExp(`^\\s*(export\\s+)?${VAR}\\s*=`).test(line));
      expect(assignments).toEqual([]);
    },
  );
});
