// Path-set coverage contract: every repository input a binary/signing job in
// release.yml reads must be covered by scripts/release/binary-affecting-paths.txt.
// If a binary job starts reading a new path that the policy does not protect,
// a server-only release could ship without rebuilding the binary that path
// feeds — this test fails first.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as workflowSecurity from '../../.github/scripts/check-workflow-security.mjs';
import { isMatched, loadPolicy } from './release-path-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const policy = loadPolicy(readFileSync(join(HERE, 'binary-affecting-paths.txt'), 'utf8'));
const releaseText = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const jobs = new Map(
  workflowSecurity.workflowJobs(workflowSecurity.activeLines(releaseText)).map((job) => [job.name, job]),
);

const BINARY_JOBS = [
  'build-agent', 'build-recovery-media', 'build-windows-unsigned', 'build-macos-agent',
  'build-macos-installer-app', 'build-viewer', 'build-helper', 'build-viewer-macos', 'build-helper-macos',
  'resolve-windows-signing-provider', 'sign-windows-tauri-azure', 'sign-windows-tauri-sslcom',
  'sign-windows-tauri', 'package-windows-updater', 'merge-viewer-update-manifest', 'build-binaries-image',
];

// Paths that are not repository inputs.
const NON_REPOSITORY = [
  /^staging\//u, // build-binaries-image assembles the image context from downloaded artifacts
];

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const trackedFiles = tracked.stdout.split('\0').filter(Boolean);

function referencedPaths(job) {
  const text = job.lines.map((line) => line.content).join('\n');
  const found = new Set();
  const add = (value, key) => {
    const cleaned = value.trim().replace(/^['"]|['"]$/gu, '').replace(/\/$/u, '');
    if (!cleaned || cleaned.includes('${{') || cleaned.startsWith('$')) return;
    found.add(`${key}\t${cleaned}`);
  };
  for (const match of text.matchAll(/^\s*(working-directory|node-version-file|cache-dependency-path|context|file|go-version-file|workspaces):\s*(.+)$/gmu)) {
    for (const part of match[2].split(/\s*->\s*|\s+/u)) add(part, match[1]);
  }
  for (const match of text.matchAll(/hashFiles\(([^)]*)\)/gu)) {
    for (const argument of match[1].split(',')) add(argument, 'hashFiles');
  }
  for (const match of text.matchAll(/(?<![\w./-])((?:agent|apps|docker|scripts|\.github|selfhost-signing-template|deploy|patches)\/[\w./-]+)/gu)) {
    add(match[1], 'run');
  }
  return [...found].map((entry) => {
    const [key, path] = entry.split('\t');
    return { key, path };
  });
}

function covered(path) {
  if (isMatched(policy, path)) return true;
  // A directory is covered when every tracked file under it is.
  const prefix = `${path}/`;
  const under = trackedFiles.filter((file) => file.startsWith(prefix));
  return under.length > 0 && under.every((file) => isMatched(policy, file));
}

test('every repository input of a binary job is a protected path', () => {
  let checked = 0;
  const gaps = [];
  for (const name of BINARY_JOBS) {
    const job = jobs.get(name);
    assert.ok(job, `release.yml must define ${name}`);
    for (const { key, path } of referencedPaths(job)) {
      if (path === '.' && key === 'context') continue; // root context: covered by the lockfile/workspace manifests
      if (NON_REPOSITORY.some((pattern) => pattern.test(path))) continue;
      // Relative paths inside a working-directory (src-tauri/target/...) and
      // paths that do not exist in the repository are build outputs, not inputs.
      if (!existsSync(join(REPO_ROOT, path)) && !trackedFiles.some((file) => file.startsWith(`${path}/`))) continue;
      checked += 1;
      if (!covered(path)) gaps.push(`${name}: ${key} ${path}`);
    }
  }
  assert.deepEqual(gaps, [], `binary-job inputs not covered by binary-affecting-paths.txt:\n${gaps.join('\n')}`);
  assert.ok(checked >= 10, `path extraction went stale (${checked} inputs checked)`);
});

test('the Go module cannot reach outside agent/ through a replace directive', () => {
  const goMod = readFileSync(join(REPO_ROOT, 'agent', 'go.mod'), 'utf8');
  for (const match of goMod.matchAll(/^\s*replace\s+.*=>\s*(\S+)/gmu)) {
    const target = match[1];
    if (target.startsWith('.')) {
      const resolved = resolve(REPO_ROOT, 'agent', target);
      assert.ok(resolved.startsWith(join(REPO_ROOT, 'agent')), `agent/go.mod replace escapes agent/: ${target}`);
    }
  }
  const blocks = goMod.match(/^replace\s*\(([\s\S]*?)^\)/gmu) ?? [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const target = /=>\s*(\.\S*)/u.exec(line)?.[1];
      if (target) {
        assert.ok(resolve(REPO_ROOT, 'agent', target).startsWith(join(REPO_ROOT, 'agent')), `agent/go.mod replace escapes agent/: ${target}`);
      }
    }
  }
});

test('the Viewer and Helper take no workspace dependencies (their closure stays inside the protected set)', () => {
  for (const app of ['viewer', 'helper']) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', app, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        assert.ok(!String(spec).startsWith('workspace:'), `apps/${app} ${field}.${name} is a workspace dependency (${spec})`);
        assert.ok(!/^(?:file|link):/u.test(String(spec)), `apps/${app} ${field}.${name} points at a local path (${spec})`);
      }
    }
  }
});

test('the extraction sees the obvious inputs (guards against a vacuous pass)', () => {
  const agent = referencedPaths(jobs.get('build-agent')).map((entry) => entry.path);
  assert.ok(agent.includes('agent'), 'build-agent working-directory');
  assert.ok(agent.includes('agent/go.sum'), 'build-agent cache-dependency-path');
  const image = referencedPaths(jobs.get('build-binaries-image')).map((entry) => entry.path);
  assert.ok(image.includes('docker/Dockerfile.binaries'));
  assert.ok(statSync(join(REPO_ROOT, 'docker', 'Dockerfile.binaries')).isFile());
});
