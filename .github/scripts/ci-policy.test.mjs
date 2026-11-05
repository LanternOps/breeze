// W02a (#10746): one policy manifest closed over every input CI selection reads.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { POLICY_FILES, isPolicyPath } from './ci-policy.mjs';
import * as queue from './queue-selection.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const read = path => readFileSync(join(REPO_ROOT, path), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const W4_FILES = [
  '.github/scripts/classify-pr-paths.sh', '.github/scripts/integration-floor-paths.txt',
  '.github/scripts/path-reader-map.txt', '.github/scripts/qemu-gate-paths.txt',
  '.github/scripts/queue-selection.mjs', '.github/flaky-tests.json', '.github/workflows/ci.yml',
];
// Every Playwright config CI runs routes own tests (queue-selection configRoutes).
const playwrightConfigs = () => [...new Set([...workflow.matchAll(/--config=([\w.-]+)/g)].map(m => `e2e-tests/${m[1]}`))];

test('isPolicyPath covers the policy directories and every listed file, nothing else', () => {
  for (const path of ['.github/workflows/new.yml', '.github/scripts/new.mjs', '.github/actions/a/action.yml', ...POLICY_FILES]) {
    assert.equal(isPolicyPath(path), true, path);
  }
  for (const path of ['apps/web/src/x.ts', 'docs/a.md', '.github/ISSUE_TEMPLATE/a.md', '.github/workflowsx/a.yml',
    'x/.github/workflows/ci.yml', 'apps/api/vitest.config.ts', '', undefined, null, 42]) {
    assert.equal(isPolicyPath(path), false, String(path));
  }
});

test('POLICY_FILES is W4\'s seven plus the gate, mobile closure, integration and Playwright configs', () => {
  const configs = playwrightConfigs();
  // A parse miss (or a new --config= job) must fail here, not silently shrink the list.
  assert.deepEqual(configs.sort(), ['e2e-tests/playwright.auth-browser-transition.config.ts',
    'e2e-tests/playwright.topology-worker.config.ts']);
  for (const path of [...W4_FILES, '.github/scripts/ci-policy.mjs', '.github/scripts/ci-gate.mjs',
    '.github/workflows/ci-gate.yml', '.github/scripts/mobile-lockfile-closure.mjs',
    'apps/api/vitest.integration.config.ts', ...configs]) {
    assert.ok(POLICY_FILES.includes(path), `POLICY_FILES is missing ${path}`);
  }
  assert.equal(new Set(POLICY_FILES).size, POLICY_FILES.length, 'no duplicate entries');
  assert.ok(Object.isFrozen(POLICY_FILES), 'the manifest cannot be mutated at runtime');
  assert.equal(queue.POLICY_FILES, POLICY_FILES, 'queue-selection re-exports the one manifest');
});

test('every script and local action ci.yml names is a policy path and exists', () => {
  const named = new Set([
    ...[...workflow.matchAll(/\.github\/scripts\/[\w-]+(?:\.[\w-]+)*/g)].map(m => m[0]),
    ...[...workflow.matchAll(/\.\/(\.github\/actions\/[\w-]+)/g)].map(m => m[1]),
  ]);
  assert.ok(named.size > 20, `scan found only ${named.size} references`);
  for (const path of named) {
    assert.ok(isPolicyPath(path), path);
    assert.ok(existsSync(join(REPO_ROOT, path)), `ci.yml names missing ${path}`);
  }
});

test('the classifier reads only sidecar files that are listed policy files', () => {
  const classifier = read('.github/scripts/classify-pr-paths.sh');
  const sidecars = Object.fromEntries([...classifier.matchAll(/^(\w+)="\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/([\w.-]+)"$/gm)]
    .map(([, name, file]) => [name, `.github/scripts/${file}`]));
  assert.deepEqual(Object.values(sidecars).sort(), ['.github/scripts/integration-floor-paths.txt',
    '.github/scripts/path-reader-map.txt', '.github/scripts/qemu-gate-paths.txt']);
  for (const file of Object.values(sidecars)) assert.ok(POLICY_FILES.includes(file), file);
  // Every file redirection reads one of those variables; a new input must be added here first.
  // Input redirections are ` < target` with spaces; `i<n` in (( )) arithmetic is not one.
  const code = classifier.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  const redirects = [...code.matchAll(/\s<(?![<(])\s+("?)([^\s"]+)\1/g)].map(m => m[2]);
  assert.ok(redirects.length >= 3, `found ${redirects.length} redirections`);
  for (const target of redirects) {
    const variable = target.match(/^\$\{(\w+)\}$/)?.[1];
    assert.ok(variable && variable in sidecars, `classifier reads ${target}, which is not a listed sidecar`);
  }
  // Other ways bash reads a file. None is used today; one appearing needs this test extended first.
  assert.doesNotMatch(code, /\bcat\b|\$\(<|\bmapfile\b|\breadarray\b|\bsource\b|^\s*\.\s+\S/m);
});

test('queue-selection reads only listed files and imports only listed modules', () => {
  for (const [file, source] of [['.github/scripts/queue-selection.mjs', read('.github/scripts/queue-selection.mjs')],
    ['.github/scripts/ci-policy.mjs', read('.github/scripts/ci-policy.mjs')]]) {
    const local = [...source.matchAll(/^import [^;]*? from '(\.[^']+)'/gm)].map(m => join(dirname(file), m[1]));
    for (const path of local) assert.ok(POLICY_FILES.includes(path), `${file} imports unlisted ${path}`);
    for (const [, path] of source.matchAll(/io\.read\('([^']+)'\)/g)) {
      assert.ok(POLICY_FILES.includes(path), `${file} reads unlisted ${path}`);
    }
    // The only computed read of a repo file is a Playwright config, pinned above.
    for (const [, template] of source.matchAll(/io\.read\(`([^`]+)`\)/g)) assert.equal(template, 'e2e-tests/${name}');
  }
});

test('selection reads only policy files and execs only the listed classifier', () => {
  const fixtureDir = join(REPO_ROOT, '.github/scripts/fixtures/queue-selection');
  const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8')));
  assert.ok(fixtures.length >= 7, `found ${fixtures.length} fixtures`);
  const reads = new Set(), execs = new Set();
  const io = {
    read: path => { reads.add(path); return read(path); },
    exec: (command, args, input) => {
      execs.add([command, args[0]].join(' '));
      return execFileSync(command, args, { cwd: REPO_ROOT, input, encoding: 'utf8' });
    },
  };
  const context = queue.selectionContext(io, io.read('.github/workflows/ci.yml'));
  for (const f of fixtures) {
    const out = queue.computeSelection({ ...context, P: f.P, delta: f.delta, full: context.classify(f.P) });
    assert.equal(out.mode, 'shadow', `${f.name}: ${out.reason}`);
  }
  assert.ok(reads.size >= 5, [...reads].join(', '));
  for (const path of reads) assert.ok(POLICY_FILES.includes(path), `selection read unlisted ${path}`);
  assert.deepEqual([...execs], ['bash .github/scripts/classify-pr-paths.sh']);
});

test('lint runs this suite', () => {
  const lint = workflow.match(/^  lint:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(lint, 'lint job not found');
  assert.match(lint, /^        run: node --test \.github\/scripts\/ci-policy\.test\.mjs$/m);
});

test('policyDigest tolerates listed files that do not exist yet, and stays stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-policy-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'CI'); git('config', 'user.email', 'ci@example.com');
    const put = (path, body) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), body); };
    const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    const absent = ['.github/scripts/ci-gate.mjs', '.github/workflows/ci-gate.yml'];
    for (const path of POLICY_FILES.filter(p => !absent.includes(p))) put(path, `${path}\n`);
    const before = commit('policy without the gate');
    const io = queue.createIO({ cwd: dir, env: {} });
    const digest = queue.policyDigest(io, before);
    assert.match(digest, /^[a-f\d]{64}$/);
    assert.equal(queue.policyDigest(io, before), digest);
    put('docs/note.md', 'not policy'); const docs = commit('docs');
    assert.equal(queue.policyDigest(io, docs), digest, 'a non-policy commit keeps the digest');
    put('.github/scripts/ci-gate.mjs', 'export {};\n'); const gate = commit('gate lands');
    assert.notEqual(queue.policyDigest(io, gate), digest, 'a listed file appearing changes the digest');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
