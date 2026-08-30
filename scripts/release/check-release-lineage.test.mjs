import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'check-release-lineage.sh');
const REGISTRY = '.github/release-provenance/candidate-tags.tsv';
const scratch = mkdtempSync(join(tmpdir(), 'release-lineage-test-'));
let fixtureNumber = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function command(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    ...options,
  });
}

function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function write(repo, path, contents) {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function commit(repo, message, files = { 'fixture.txt': `${message}\n` }) {
  for (const [path, contents] of Object.entries(files)) {
    write(repo, path, contents);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function initRepo() {
  const repo = join(scratch, `repo-${fixtureNumber++}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Release Lineage Test');
  git(repo, 'config', 'user.email', 'release-lineage@example.invalid');
  commit(repo, 'initial', {
    [REGISTRY]: '# tag\tcommit\tintegration-ref\tnote\n',
    'fixture.txt': 'initial\n',
  });
  return repo;
}

function registryRow(tag, sha, ref = '#4227', note = 'test candidate') {
  return `${tag}\t${sha}\t${ref}\t${note}\n`;
}

function setRegistry(repo, contents) {
  commit(repo, 'update candidate registry', {
    [REGISTRY]: `# tag\tcommit\tintegration-ref\tnote\n${contents}`,
  });
}

function makeCandidate(repo, tag = 'v1.1.0-rc.1') {
  git(repo, 'switch', '-c', 'candidate');
  const sha = commit(repo, 'candidate change', { 'candidate.txt': `${tag}\n` });
  git(repo, 'tag', tag);
  git(repo, 'switch', 'main');
  return { sha, tag };
}

function run(repo, args, options = {}) {
  return command(repo, 'bash', [SCRIPT, ...args], options);
}

function standardArgs(tag, registryRef = 'main') {
  return [
    '--tag', tag,
    '--main-ref', 'main',
    '--candidate-registry-ref', registryRef,
  ];
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, `expected failure\nstdout: ${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

test('annotated reachable tag is mainline and reports the peeled commit', () => {
  const repo = initRepo();
  const commitSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', '-a', 'v1.0.0', '-m', 'release v1.0.0');
  const tagObjectSha = git(repo, 'rev-parse', 'v1.0.0');
  assert.notEqual(tagObjectSha, commitSha);

  const result = run(repo, standardArgs('v1.0.0'));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=mainline/);
  assert.match(result.stdout, new RegExp(`tag_sha=${commitSha}`));
  assert.doesNotMatch(result.stdout, new RegExp(`tag_sha=${tagObjectSha}`));
});

test('successful classification writes exact GitHub Actions outputs', () => {
  const repo = initRepo();
  const commitSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'v1.0.0');
  const outputPath = join(repo, 'github-output.txt');
  writeFileSync(outputPath, '');

  const result = run(repo, standardArgs('v1.0.0'), {
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(outputPath, 'utf8'),
    `channel=mainline\ntag=v1.0.0\ntag_sha=${commitSha}\n`,
  );
});

test('exact registered non-main prerelease is a candidate', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  setRegistry(repo, registryRow(tag, sha));

  const result = run(repo, standardArgs(tag));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=candidate/);
  assert.match(result.stdout, new RegExp(`tag_sha=${sha}`));
});

test('stable non-main and unregistered prerelease tags fail closed', async (t) => {
  await t.test('stable non-main tag', () => {
    const repo = initRepo();
    const { tag } = makeCandidate(repo, 'v1.1.0');
    assertFailure(run(repo, standardArgs(tag)), /stable.*not.*main|unclassified/is);
  });

  await t.test('unregistered prerelease tag', () => {
    const repo = initRepo();
    const { tag } = makeCandidate(repo);
    assertFailure(run(repo, standardArgs(tag)), /not registered|unclassified/is);
  });
});

test('duplicate and malformed registry rows fail before classification', async (t) => {
  const cases = [
    {
      name: 'duplicate tag',
      rows: (tag, sha) => registryRow(tag, sha) + registryRow(tag, sha, '#other'),
      pattern: /duplicate/i,
    },
    {
      name: 'malformed tag',
      rows: (_tag, sha) => registryRow('candidate-one', sha),
      pattern: /invalid.*tag|malformed/i,
    },
    {
      name: 'malformed sha',
      rows: (tag) => registryRow(tag, 'ABC123'),
      pattern: /invalid.*sha|malformed/i,
    },
    {
      name: 'missing integration ref',
      rows: (tag, sha) => registryRow(tag, sha, ''),
      pattern: /integration|field|malformed/i,
    },
    {
      name: 'missing note',
      rows: (tag, sha) => registryRow(tag, sha, '#4227', ''),
      pattern: /note|field|malformed/i,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const repo = initRepo();
      const { sha, tag } = makeCandidate(repo);
      setRegistry(repo, entry.rows(tag, sha));
      assertFailure(run(repo, standardArgs(tag)), entry.pattern);
    });
  }
});

test('registry SHA must equal the peeled tag commit', () => {
  const repo = initRepo();
  const { tag } = makeCandidate(repo);
  const wrongSha = git(repo, 'rev-parse', 'main');
  setRegistry(repo, registryRow(tag, wrongSha));

  assertFailure(run(repo, standardArgs(tag)), /does not match|mismatch/i);
});

test('candidate branch cannot authorize itself through a branch-only ledger', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  git(repo, 'switch', 'candidate');
  setRegistry(repo, registryRow(tag, sha));

  assertFailure(run(repo, standardArgs(tag, 'main')), /not registered|unclassified/is);
});

test('--allow-unclassified reports an explicit unclassified channel', () => {
  const repo = initRepo();
  const { tag } = makeCandidate(repo, 'v1.1.0');

  const result = run(repo, [...standardArgs(tag), '--allow-unclassified']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-lineage: channel=unclassified/);
});

test('--require-mainline rejects an otherwise valid candidate', () => {
  const repo = initRepo();
  const { sha, tag } = makeCandidate(repo);
  setRegistry(repo, registryRow(tag, sha));

  assertFailure(
    run(repo, [...standardArgs(tag), '--require-mainline']),
    /mainline.*required|candidate.*cannot.*promot/is,
  );
});

test('shallow clone fails before tag classification', () => {
  const source = initRepo();
  git(source, 'tag', '-a', 'v1.0.0', '-m', 'release v1.0.0');
  const clone = join(scratch, `shallow-${fixtureNumber++}`);
  const cloneResult = command(scratch, 'git', [
    'clone',
    '--depth=1',
    '--branch=main',
    pathToFileURL(source).href,
    clone,
  ]);
  assert.equal(cloneResult.status, 0, cloneResult.stderr);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');

  const result = run(clone, [
    '--tag', 'v-does-not-exist',
    '--main-ref', 'HEAD',
    '--candidate-registry-ref', 'HEAD',
  ]);

  assertFailure(result, /shallow repository/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cannot resolve tag/i);
});
