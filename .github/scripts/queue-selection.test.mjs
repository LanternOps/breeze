import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as queue from './queue-selection.mjs';
// Imported only to pin the candidate-side consumer to the gate's definitions.
import * as thin from './ci-gate-thin.mjs';
import { FULL_SUITE_FLAGS, GATE_WORKFLOW, createGateIO, extractAggregator, runAggregator } from './ci-gate.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const classify = (paths, pr = false) => Object.fromEntries(execFileSync('bash', [
  join(REPO_ROOT, '.github/scripts/classify-pr-paths.sh'), ...(pr ? ['--pull-request'] : []),
], { encoding: 'utf8', input: paths.join('\n') + '\n' }).trim().split('\n').map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
const context = {
  workflow, classify,
  playwrightConfigs: Object.fromEntries([...workflow.matchAll(/--config=([\w.-]+)/g)].map(([, name]) =>
    [name, readFileSync(join(REPO_ROOT, 'e2e-tests', name), 'utf8')])),
  floor: readFileSync(join(REPO_ROOT, '.github/scripts/integration-floor-paths.txt'), 'utf8'),
  integrationConfig: readFileSync(join(REPO_ROOT, 'apps/api/vitest.integration.config.ts'), 'utf8'),
};
const select = (P, delta, full = classify(P)) => queue.computeSelection({ ...context, P, delta, full });
const fixtureDir = join(REPO_ROOT, '.github/scripts/fixtures/queue-selection');
const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8')));
const fixture = name => fixtures.find(f => f.name === name);
const NEVER = ['build-smoke-images', 'guided-setup-smoke', 'portal-dev-e2e', 'rust-check-windows', 'smoke-test', 'test-agent-race', 'workspace-runtime'];

test('fixtures: every real interaction is caught by the thin selection', () => {
  assert.equal(fixtures.length, 7);
  for (const f of fixtures) {
    const out = select(f.P, f.delta);
    assert.equal(out.mode, 'shadow', `${f.name}: ${out.reason}`);
    assert.ok(out.thin_jobs.includes(f.caught_by_job), f.name);
  }
});
test('fixture same-file-overlap: O is computed and its area runs its full unit suite', () => {
  const f = fixture('same-file-overlap');
  const out = select(f.P, f.delta);
  assert.deepEqual(out.overlap, f.expect_overlap);
  assert.ok(out.thin_jobs.includes('test-web'));
});
test('fixture docs-path-read: reader map applied to delta', () => {
  const f = fixture('docs-path-read');
  const out = select(f.P, f.delta);
  for (const reader of f.expect_reader_tests) assert.ok(out.reader_tests.includes(reader));
  assert.ok(out.thin_jobs.includes('path-read-contracts'));
});
test('own tests are routed to the job that runs them', () => {
  for (const [path, jobs] of [
    ['apps/api/src/__tests__/integration/x.integration.test.ts', ['integration-test']],
    ['apps/api/src/services/x.test.ts', ['test-api']],
    ['apps/web/src/x.test.tsx', ['test-web']],
    ['agent/internal/x/x_test.go', ['test-agent', 'test-agent-windows']],
  ]) assert.deepEqual(queue.routeOwnTest(path, context).jobs, jobs);
  assert.equal(select(['unknown/x.test.ts'], []).reason, 'unrouted_own_test');
});
test('floor applied to P ∪ delta', () => {
  for (const [P, delta] of [
    [['apps/web/src/x.ts'], ['apps/api/migrations/zzz.sql']],
    [['apps/api/migrations/zzz.sql'], ['apps/web/src/x.ts']],
  ]) assert.ok(select(P, delta).thin_jobs.includes('integration-test'));
});
test('never-thinned jobs keep the full value', () => {
  assert.deepEqual(queue.nonGatingJobs(workflow), NEVER);
  const P = ['docs/queue-notes.md'], delta = ['docs/another-note.md'];
  assert.equal(classify([...P, ...delta]).code, 'false');
  for (const value of ['true', 'false']) {
    const full = Object.fromEntries(Object.keys(classify(P)).map(key => [key, key === 'reader_tests' ? '' : value]));
    const out = select(P, delta, full);
    for (const name of NEVER) assert.equal(out.thin_jobs.includes(name), out.full_jobs.includes(name), name);
    assert.equal(out.thin_jobs.includes('smoke-test'), value === 'true');
  }
});
test('e2e specs: named → that job; config-selected → that job; otherwise unrun, not a fallback', () => {
  assert.deepEqual(queue.configRoutes(context).map(r => r.config).sort(), [
    'playwright.auth-browser-transition.config.ts', 'playwright.topology-worker.config.ts',
  ]);
  for (const [path, name] of [
    ['browser-contracts/auth-browser-transition.spec.ts', 'auth-browser-transition-browser-contract'],
    ['tests/topology-worker.spec.ts', 'topology-browser-gate'],
    ['tests/topology-baseline.spec.ts', 'topology-browser-gate'],
  ]) assert.deepEqual(queue.routeOwnTest(`e2e-tests/${path}`, context).jobs, [name]);
  assert.deepEqual(queue.routeOwnTest('e2e-tests/tests/multi-currency.spec.ts', context).jobs, ['portal-dev-e2e']);
  const path = 'e2e-tests/tests/document-renderer.spec.ts';
  const out = select([path], []);
  assert.deepEqual(out.unrun_own_tests, [path]);
  assert.equal(out.mode, 'shadow');
});

test('an unparseable CI Playwright config fails closed for every e2e own test', () => {
  for (const content of ["testDir: computedDir", "testDir: './tests', testMatch: computedMatch", "testDir: './tests', testMatch: /broken[/"]) {
    const broken = { ...context, playwrightConfigs: { ...context.playwrightConfigs, 'playwright.topology-worker.config.ts': content } };
    for (const path of ['e2e-tests/tests/document-renderer.spec.ts', 'e2e-tests/tests/multi-currency.spec.ts']) {
      assert.equal(queue.computeSelection({ ...broken, P: [path], delta: [], full: classify([path]) }).reason, 'unrouted_own_test');
    }
  }
});
test('empty delta selects no overlap unit suites or readers', () => {
  const out = select(['apps/api/src/services/x.ts'], []);
  assert.ok(!out.thin_jobs.includes('test-api'));
  assert.ok(!out.thin_jobs.includes('path-read-contracts'));
});

const H = 'a'.repeat(40), B = 'b'.repeat(40), BASE = 'c'.repeat(40), M = 'd'.repeat(40);
const validFacts = () => ({ event: 'merge_group', pr: 12, head: H, record: { files: ['apps/web/src/x.ts'], policy_digest: 'digest' },
  ageHours: 1, merges: 1, ancestor: true, diffOk: true, digest: 'digest', atBase: true,
  delta: [], entryCommits: 1, entryFiles: ['apps/web/src/x.ts'], unrouted: false });
for (const [reason, change] of [
  ['not_merge_group', { event: 'workflow_dispatch' }], ['no_pr_number', { pr: null }],
  ['no_head_sha', { head: '' }], ['no_valid_record', { record: null }],
  ['stale_base', { ageHours: 12 + 1 / 3600 }], ['too_many_merges', { merges: 41 }],
  ['delta_uncomputable', { ancestor: false }], ['policy_digest_mismatch', { digest: 'different' }],
  ['policy_not_at_base', { atBase: false }],
  ['policy_path_in_p', { record: { files: ['.github/workflows/ci.yml'], policy_digest: null } }],
  ['policy_path_in_delta', { delta: ['.github/actions/new/action.yml'] }],
  ['entry_not_single_commit', { entryCommits: 2 }], ['entry_outside_p', { entryFiles: ['apps/web/src/x.ts', 'apps/api/src/y.ts'] }],
  ['unrouted_own_test', { unrouted: true }],
  ['error', { error: Error('git failed') }],
]) test(`fallback: ${reason}`, () => assert.equal(queue.fallbackReason({ ...validFacts(), ...change }), reason));
test('delta diff failures fall back even if B is an ancestor', () => assert.equal(queue.fallbackReason({ ...validFacts(), diffOk: false }), 'delta_uncomputable'));
test('a null record digest falls back', () => {
  const facts = validFacts(); facts.record.policy_digest = null;
  assert.equal(queue.fallbackReason(facts), 'policy_digest_mismatch');
});
test('base age and merge count boundaries are inclusive', () => {
  for (const [ageHours, merges, expected] of [[12, 40, ''], [12 + 1 / 3600, 40, 'stale_base'], [12, 41, 'too_many_merges']]) {
    assert.equal(queue.fallbackReason({ ...validFacts(), ageHours, merges }), expected);
  }
  assert.equal(queue.MAX_BASE_AGE_HOURS, 12); assert.equal(queue.MAX_DELTA_MERGES, 40);
});
test('policy path fallback covers every policy file and conservative directory', () => {
  for (const path of [...queue.POLICY_FILES, '.github/scripts/new.mjs', '.github/workflows/new.yml', '.github/actions/a/action.yml']) {
    assert.equal(queue.fallbackReason({ ...validFacts(), delta: [path] }), 'policy_path_in_delta', path);
  }
});
test('an exception inside the shadow core yields full/error, never a thrown exit', async () => {
  const out = await queue.shadowCore({ read: () => { throw Error('read failed'); } }, { event: 'merge_group', full: classify(['apps/web/src/x.ts']) });
  assert.equal(out.mode, 'full'); assert.equal(out.reason, 'error');
});

const recordInput = () => ({ event: 'pull_request', ciSuccess: 'success', headSha: H, mergeSha: M,
  pr: 12, runId: 100, runAttempt: 2, selection: classify(['apps/web/src/x.ts']) });
const rawRecord = (overrides = {}) => ({ schema: 1, head_sha: H, merge_sha: M, base_sha: B, pr_number: 12,
  run_id: 100, run_attempt: 2, created_at: '2026-11-01T12:00:00.000Z', files: ['apps/web/src/x.ts'],
  files_source: 'merge-commit', policy_digest: 'digest', selection: recordInput().selection,
  non_gating_jobs: NEVER, suites_passed: true, ...overrides });
function recordIO(overrides = {}) {
  const writes = new Map(), errors = [], calls = [];
  return { writes, errors, calls, now: () => Date.parse('2026-11-01T12:00:00Z'),
    read: path => path === '.github/workflows/ci.yml' ? workflow : '',
    write: (path, content) => writes.set(path, content), remove: path => writes.delete(path),
    stderr: text => errors.push(text),
    git: args => {
      calls.push(args);
      if (args[0] === 'rev-parse') return args[1].endsWith('^1') ? B : H;
      if (args[0] === 'diff') return 'apps/web/src/x.ts\n';
      if (args[0] === 'ls-tree') return `100644 blob ${'e'.repeat(40)}\t.github/workflows/ci.yml\n`;
      throw Error(`Unexpected git: ${args}`);
    }, ...overrides };
}
test('record writes every provenance field from the checked-out merge and base policy', () => {
  const io = recordIO(), input = recordInput();
  queue.record(io, input);
  const r = JSON.parse(io.writes.get('provenance.json'));
  assert.deepEqual(r, rawRecord({ policy_digest: createHash('sha256').update(`100644 blob ${'e'.repeat(40)}\t.github/workflows/ci.yml\n`).digest('hex'), policy_in_files: false }));
  assert.ok(io.calls.some(args => args.join(' ') === `diff --name-only --no-renames ${B} ${M}`));
  assert.ok(io.calls.some(args => args[0] === 'ls-tree' && args[1] === B));
});
test('record head mismatch removes stale output and throws with both heads', () => {
  const io = recordIO(); const git = io.git;
  io.git = args => args[0] === 'rev-parse' && args[1].endsWith('^2') ? BASE : git(args);
  io.writes.set('provenance.json', 'stale');
  assert.throws(() => queue.record(io, recordInput()), error => {
    assert.match(error.message, /head.*mismatch/i);
    for (const value of [M, BASE, H]) assert.ok(error.message.includes(value));
    return true;
  });
  assert.equal(io.writes.size, 0);
});
test('record with policy paths has a null digest and policy_in_files true', () => {
  const io = recordIO(); const git = io.git;
  io.git = args => args[0] === 'diff' ? '.github/workflows/ci.yml\n' : git(args);
  queue.record(io, recordInput());
  const r = JSON.parse(io.writes.get('provenance.json'));
  assert.equal(r.policy_digest, null); assert.equal(r.policy_in_files, true);
});
test('record removes stale output and throws with the wrong event or CI Success result', () => {
  for (const change of [...['failure', 'cancelled', 'skipped', '', undefined].map(ciSuccess => ({ ciSuccess })),
    { event: 'merge_group' }, { event: undefined }]) {
    const io = recordIO(), input = { ...recordInput(), ...change };
    io.writes.set('provenance.json', 'stale');
    assert.throws(() => queue.record(io, input), error => {
      assert.ok(error.message.includes(`event=${JSON.stringify(input.event)}`));
      assert.ok(error.message.includes(`ciSuccess=${JSON.stringify(input.ciSuccess)}`));
      return true;
    });
    assert.equal(io.writes.size, 0);
  }
});
test('validateRecord rejects each invalid provenance field and unparseable JSON', () => {
  for (const value of ['{', null, [], ...[
    { schema: 2 }, { head_sha: BASE }, { files_source: 'api' }, { suites_passed: 'true' },
    { files: {} }, { files: [42] }, { base_sha: 'not-a-sha' },
  ].map(change => rawRecord(change))]) assert.equal(queue.validateRecord(value, H), null);
  assert.deepEqual(queue.validateRecord(JSON.stringify(rawRecord()), H), rawRecord());
});
test('pickRecord chooses newest valid run then attempt and skips invalid records', () => {
  const newest = rawRecord({ run_id: 102, run_attempt: 3 });
  assert.deepEqual(queue.pickRecord([rawRecord({ run_id: 101, run_attempt: 8 }), newest,
    rawRecord({ run_id: 102, run_attempt: 1 }), rawRecord({ run_id: 103, head_sha: BASE }), '{'], H), newest);
  assert.equal(queue.pickRecord(['{', rawRecord({ suites_passed: false })], H), null);
});
function tempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-selection-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'CI'); git('config', 'user.email', 'ci@example.com');
    const put = (path, body) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), body); };
    const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    fn({ dir, git, put, commit });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('real temp git record uses M parents, merge diff and base tree digest', () => tempRepo(({ dir, git, put, commit }) => {
  put('.github/workflows/ci.yml', workflow); const base = commit('base');
  git('checkout', '-qb', 'pr'); put('apps/web/src/x.ts', 'export const x = 1;'); const head = commit('head');
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', 'merge', 'pr'); const merge = git('rev-parse', 'HEAD');
  const io = queue.createIO({ cwd: dir });
  queue.record(io, { ...recordInput(), headSha: head, mergeSha: merge });
  const r = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
  assert.equal(r.base_sha, base); assert.equal(r.head_sha, head);
  assert.deepEqual(r.files, git('diff', '--name-only', '--no-renames', base, merge).split('\n'));
  assert.equal(r.policy_digest, queue.policyDigest(io, base));
  assert.equal(queue.policyDigest(io, base), queue.policyDigest(io, base, [...queue.POLICY_FILES].reverse()));
  rmSync(join(dir, 'provenance.json'));
  for (const path of queue.POLICY_FILES) {
    const previous = git('rev-parse', 'HEAD'); put(path, `${path} changed`); const next = commit('policy change');
    assert.notEqual(queue.policyDigest(io, previous), queue.policyDigest(io, next), path);
  }
  const previous = git('rev-parse', 'HEAD'); put('docs/note.md', 'non-policy'); const next = commit('docs');
  assert.equal(queue.policyDigest(io, previous), queue.policyDigest(io, next));
}));

function shadowIO(options = {}) {
  const input = { event: 'merge_group', headRef: 'refs/heads/gh-readonly-queue/main/pr-12-deadbeef', headSha: M, baseSha: BASE,
    full: classify(['apps/web/src/x.ts']) };
  const tree = `100644 blob ${'e'.repeat(40)}\t.github/workflows/ci.yml\n`;
  const now = Date.parse('2026-11-01T12:00:00Z'), logs = [], errors = [], writes = new Map(), calls = [];
  const r = rawRecord({ policy_digest: createHash('sha256').update(tree).digest('hex') });
  const io = {
    now: () => now, stdout: line => logs.push(line), stderr: line => errors.push(line), logs, errors, calls, writes,
    append: (path, content) => writes.set(path, (writes.get(path) ?? '') + content),
    records: () => ({ records: [r], stats: { runs: 1, artifacts: 1, expired: 0, rejected: [] } }), exists: path => path === '.github/workflows/ci.yml',
    prHead: pr => { assert.equal(pr, 12); return H; },
    read: path => readFileSync(join(REPO_ROOT, path), 'utf8'),
    exec: (cmd, args, stdin) => { assert.equal(cmd, 'bash'); return execFileSync(cmd, args, { cwd: REPO_ROOT, input: stdin, encoding: 'utf8' }); },
    git: args => {
      calls.push(args);
      if (args[0] === 'rev-parse') throw Object.assign(Error('a squash queue commit has no second parent'), { status: 128 });
      if (args[0] === 'show') return String(now / 1000 - 3600);
      if (args[0] === 'merge-base') return '';
      const answer = {
        [`rev-list --count --first-parent ${B}..${BASE}`]: '1',
        [`rev-list --count --first-parent ${BASE}..${M}`]: '1',
        [`diff --name-only --no-renames ${B} ${BASE}`]: 'apps/api/src/routes/x.ts\n',
        [`diff --name-only --no-renames ${BASE} ${M}`]: 'apps/web/src/x.ts\n',
      }[args.join(' ')];
      if (answer !== undefined) return answer;
      if (args[0] === 'ls-tree') { assert.equal(args[1], BASE); return tree; }
      if (args[0] === 'hash-object') return 'e'.repeat(40);
      throw Error(`Unexpected git: ${args}`);
    }, ...options,
  };
  return { io, input, r };
}
test('shadow emits one complete log, only two outputs, and a markdown summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-output-'));
  try {
    const { io, input } = shadowIO(); io.append = (path, text) => { writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text); };
    const output = join(dir, 'output'), summary = join(dir, 'summary');
    const out = queue.shadow(io, input, { output, summary });
    assert.equal(out.mode, 'shadow'); assert.equal(out.invalid_records, 0);
    assert.equal(io.logs.length, 1); assert.ok(io.logs[0].startsWith('queue-selection: '));
    for (const field of ['mode', 'reason', 'pr', 'head', 'B', 'parent', 'age_h', 'merges', 'p', 'delta', 'overlap', 'thin_jobs', 'full_jobs', 'would_skip', 'would_add', 'unrun_own_tests', 'policy_digest']) {
      assert.ok(io.logs[0].includes(`${field}=`), field);
    }
    assert.equal(readFileSync(output, 'utf8'), 'selection_mode=shadow\nselection_reason=\n');
    assert.match(readFileSync(summary, 'utf8'), /### Queue selection/);
    assert.deepEqual(out.would_skip, out.full_jobs.filter(j => !out.thin_jobs.includes(j)));
    assert.deepEqual(out.would_add, out.thin_jobs.filter(j => !out.full_jobs.includes(j)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('fallback keeps a single log and full jobs, even with a null policy digest', () => {
  const { io, input, r } = shadowIO(); r.files = ['.github/workflows/ci.yml']; r.policy_digest = null;
  const out = queue.shadow(io, input, { output: 'out' });
  assert.equal(out.reason, 'policy_path_in_p'); assert.deepEqual(out.thin_jobs, out.full_jobs);
  assert.ok(out.full_jobs.includes('test-web'));
  assert.equal(io.logs.length, 1); assert.match(io.logs[0], /mode=full reason=policy_path_in_p/);
  assert.equal(io.writes.get('out'), 'selection_mode=full\nselection_reason=policy_path_in_p\n');
});
test('shadow takes H from the PR API (queue commits are single-parent squashes), never from ^2', () => {
  const { io, input } = shadowIO();
  const out = queue.shadowCore(io, input);
  assert.equal(out.mode, 'shadow', JSON.stringify(out)); assert.equal(out.head, H);
  assert.ok(!io.calls.some(args => args.some(a => String(a).endsWith('^2'))), 'must not read a second parent');
  assert.ok(io.calls.some(args => args.join(' ') === `diff --name-only --no-renames ${BASE} ${M}`), 'entry diff computed');
});
test('shadow falls back when the queue entry changes a file the record never tested', () => {
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => args[0] === 'diff' && args.at(-1) === M ? 'apps/web/src/x.ts\napps/web/src/new.ts\n' : git(args);
  assert.equal(queue.shadowCore(io, input).reason, 'entry_outside_p');
});
test('shadow checks base blobs before executing classifier or reading selection policy', () => {
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => args[0] === 'hash-object' ? 'f'.repeat(40) : git(args);
  io.exec = () => assert.fail('classifier must not execute');
  io.read = path => { assert.equal(path, '.github/workflows/ci.yml'); return workflow; };
  assert.equal(queue.shadowCore(io, input).reason, 'policy_not_at_base');
});
test('shadow validates artifact records, counts invalid ones, and never refreshes B age from created_at', () => {
  const { io, input, r } = shadowIO(); io.records = () => ({ records: ['{', rawRecord({ head_sha: BASE }), r], stats: { runs: 3, artifacts: 3, expired: 0, rejected: [] } });
  assert.equal(queue.shadowCore(io, input).invalid_records, 2);
  r.created_at = '2099-01-01T00:00:00Z'; const git = io.git;
  io.git = args => args[0] === 'show' ? String(io.now() / 1000 - 12 * 3600 - 1) : git(args);
  assert.equal(queue.shadowCore(io, input).reason, 'stale_base');
});
test('shadow catches each git/gh failure and the explicit delta failure cases', () => {
  for (const command of ['show', 'merge-base', 'rev-list', 'diff', 'ls-tree', 'hash-object']) {
    const { io, input } = shadowIO(); const git = io.git;
    io.git = args => { if (args[0] === command) throw Object.assign(Error('failed'), { status: 128 }); return git(args); };
    assert.equal(queue.shadowCore(io, input).reason, command === 'diff' ? 'delta_uncomputable' : 'error', command);
  }
  { const { io, input } = shadowIO(); io.prHead = () => { throw Error('gh api failed'); };
    assert.equal(queue.shadowCore(io, input).reason, 'error'); }
  { const { io, input } = shadowIO(); io.prHead = () => 'not-a-sha\n';
    assert.equal(queue.shadowCore(io, input).reason, 'no_head_sha'); }
  const { io, input } = shadowIO(); io.records = () => { throw Error('gh failed'); };
  assert.equal(queue.shadowCore(io, input).reason, 'error');
  const { io: other, input: otherInput } = shadowIO(); const git = other.git;
  other.git = args => { if (args[0] === 'merge-base') throw Object.assign(Error('not ancestor'), { status: 1 }); return git(args); };
  assert.equal(queue.shadowCore(other, otherInput).reason, 'delta_uncomputable');
});
test('all changes-gated job expressions parse and evaluate with true/false flags', () => {
  const jobs = Object.values(queue.workflowJobs(workflow)).filter(j => j.condition?.includes('needs.changes.outputs.'));
  assert.equal(jobs.length, 48);
  const keys = [...workflow.matchAll(/needs.changes.outputs.(\w+)/g)].map(m => m[1]);
  for (const { condition } of jobs) for (const value of ['true', 'false']) {
    assert.equal(queue.evaluateIf(queue.parseIfExpression(condition), Object.fromEntries(keys.map(k => [k, value]))), value === 'true', condition);
  }
  for (const invalid of ["true", "needs.changes.outputs.code != 'true'", "needs.changes.outputs.code == 'true'; process.exit()", "(needs.changes.outputs.code == 'true'"]) {
    assert.throws(() => queue.parseIfExpression(invalid));
  }
});
test('JOB_CLASSES covers each changes-gated job exactly once with the right area', () => {
  const jobs = queue.workflowJobs(workflow), entries = Object.values(queue.JOB_CLASSES).flatMap(c => Array.isArray(c) ? c : Object.keys(c));
  const gated = Object.entries(jobs).filter(([, j]) => j.condition?.includes('needs.changes.outputs.')).map(([name]) => name);
  assert.equal(entries.length, new Set(entries).size);
  assert.deepEqual(entries.sort(), gated.sort());
  for (const [name, area] of Object.entries({ ...queue.JOB_CLASSES.build, ...queue.JOB_CLASSES.unit })) {
    const pathArea = { viewer: 'apps/viewer', mobile: 'apps/mobile', shared: '@breeze/shared', document_ui: '@breeze/document-ui' }[area];
    if (pathArea) assert.ok(jobs[name].body.includes(pathArea), name);
    else assert.ok(jobs[name].condition.includes(`needs.changes.outputs.${area} == 'true'`), name);
  }
});
function artifactIO() {
  const calls = [], removed = [], records = new Map();
  const runs = [{ id: 100, event: 'pull_request', path: '.github/workflows/ci.yml', head_sha: H },
    { id: 999, event: 'merge_group', path: '.github/workflows/ci.yml', head_sha: H }];
  return { calls, removed, records, temp: () => '/tmp/fake-provenance', remove: path => removed.push(path),
    exists: path => records.has(path), read: path => records.get(path),
    gh: args => {
      calls.push(args);
      if (args[0] === 'api' && args[1].includes('/workflows/')) return JSON.stringify([{ workflow_runs: runs }]);
      if (args[0] === 'api' && args[1].includes('/artifacts')) return JSON.stringify([{ artifacts: [
        { name: 'ci-provenance-attempt-1', expired: false }, { name: 'ci-provenance-attempt-2', expired: false },
        { name: 'ci-provenance-attempt-3', expired: true }, { name: 'other', expired: false },
      ] }]);
      if (args[0] === 'run' && args[1] === 'download') {
        const attempt = Number(args[args.indexOf('--name') + 1].split('-').at(-1));
        records.set('/tmp/fake-provenance/provenance.json', JSON.stringify(rawRecord({ run_attempt: attempt }))); return '';
      }
      throw Error(`Unexpected gh ${args}`);
    } };
}
test('artifact discovery paginates exact-head PR workflow runs and all attempt records', () => {
  const io = artifactIO();
  const { records, stats } = queue.readRecords(io, { repository: 'owner/repo', head: H, pr: 12 });
  assert.deepEqual(stats, { runs: 1, artifacts: 3, expired: 1, rejected: [] });
  assert.equal(records.length, 2); assert.equal(queue.pickRecord(records, H).run_attempt, 2);
  assert.ok(io.calls[0][1].includes(`head_sha=${H}`));
  for (const args of io.calls.filter(a => a[0] === 'api')) { assert.ok(args.includes('--paginate')); assert.ok(args.includes('--slurp')); }
  assert.equal(io.calls.filter(a => a[0] === 'run').length, 2);
  assert.equal(io.removed.length, 2);
});
test('artifact discovery skips invalid JSON/identity but propagates download failures and cleans up', () => {
  for (const contents of ['{', JSON.stringify(rawRecord({ run_id: 999 }))]) {
    const io = artifactIO(); io.read = () => contents;
    assert.equal(queue.pickRecord(queue.readRecords(io, { repository: 'owner/repo', head: H }).records, H), null);
  }
  const io = artifactIO(), gh = io.gh;
  io.gh = args => { if (args[0] === 'run') throw Error('download failed'); return gh(args); };
  assert.throws(() => queue.readRecords(io, { repository: 'owner/repo', head: H }), /download failed/);
  assert.equal(io.removed.length, 1);
});
test('CLI shadow uses env data and emits only advisory outputs; bad JSON fails full/error', () => {
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => args[0] === 'sparse-checkout' ? '' : git(args);
  const env = { EVENT_NAME: input.event, HEAD_REF: input.headRef, HEAD_SHA: M, BASE_SHA: BASE,
    FULL_SELECTION: JSON.stringify(input.full), GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'summary' };
  assert.equal(queue.runCLI(io, ['shadow'], env).mode, 'shadow');
  assert.equal(io.writes.get('out'), 'selection_mode=shadow\nselection_reason=\n');
  const bad = shadowIO().io;
  assert.equal(queue.runCLI(bad, ['shadow'], { ...env, FULL_SELECTION: '{' }).reason, 'error');
  assert.equal(bad.logs.length, 1);
});

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const UPLOAD_SHA = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';
test('changes reads the CI Gate\'s selection in a bounded advisory step after byte-identical classify (W05)', () => {
  const body = job('changes');
  assert.equal(body.match(/^    permissions:\n([\s\S]*?)(?=^    [a-z][\w-]*:)/m)[1], '      contents: read\n      pull-requests: read\n      actions: read\n');
  assert.ok(body.includes("      selection_mode: ${{ steps.queue_thin.outputs.selection_mode || (github.event_name == 'pull_request' && 'pr' || 'full') }}\n"));
  assert.ok(body.includes("      selection_reason: ${{ steps.queue_thin.outputs.selection_reason || (steps.queue_thin.outcome == 'failure' && 'thin_step_failed') || '' }}\n"));
  assert.ok(body.includes('      thin_skip: ${{ steps.queue_thin.outputs.thin_skip }}\n'));
  assert.ok(body.indexOf('id: queue_thin') > body.indexOf('id: classify'));
  assert.match(body, /fetch-depth: \$\{\{ github.event_name == 'merge_group' && '0' \|\| '1' \}\}/);
  assert.ok(!workflow.includes('queue_shadow') && !workflow.includes('queue-selection.mjs shadow'), 'the W04 candidate-side shadow step is gone');
  const step = body.slice(body.indexOf('      - name: Read the CI Gate\'s queue selection'));
  assert.match(step, /^      - name: Read the CI Gate's queue selection \(W05\)\n(?:        # .*\n)+        id: queue_thin\n        if: github.event_name == 'merge_group'\n        continue-on-error: true\n        timeout-minutes: 5\n        run: \|\n          node \.github\/scripts\/queue-selection\.mjs consume\n        env:\n/);
  const env = Object.fromEntries([...step.matchAll(/^          ([A-Z_]+): (.*)$/gm)].map(([, key, value]) => [key, value]));
  assert.deepEqual(env, {
    GH_TOKEN: '${{ github.token }}', HEAD_SHA: '${{ github.event.merge_group.head_sha }}',
    BASE_SHA: '${{ github.event.merge_group.base_sha }}', HEAD_REF: '${{ github.event.merge_group.head_ref }}',
    THIN_QUEUE: '${{ vars.CI_THIN_QUEUE }}', ...GATE_ENV,
  });
  const classifyStep = body.match(/      - name: Classify changed files\n[\s\S]*?(?=\n      - name:|\n  # ─── Docs check)/)[0].trimEnd() + '\n';
  // Snapshot from origin/main, including the complete full_suite printf and env.
  assert.equal(createHash('sha256').update(classifyStep).digest('hex'), '72d1c815b5dc6b2cc89d6c2acf4d4b59c3ec03038c2f41a3c6896c5f9c95b99a');
  assert.ok(classifyStep.includes("printf 'code=true\\ndocs=true\\nagent=true\\napp=true\\napi=true\\nweb=true\\nportal=true\\naddins=true\\nm365=true\\nrust=true\\ntopology_browser=true\\nagent_code=true\\nintegration=true\\npath_readers=true\\nreader_tests=\\n'"));
});
test('no gate or CI Success reads advisory selection outputs', () => {
  assert.doesNotMatch(job('ci-success'), /selection_mode|selection_reason/);
  for (const line of workflow.split('\n')) {
    if (/^      selection_(mode|reason):/.test(line)) continue;
    assert.doesNotMatch(line, /(?:if:.*|needs\.[\w-]+\.outputs\.)(?:selection_mode|selection_reason)/);
  }
});
test('provenance-record runs only after PR CI Success with exact permissions and upload contract', () => {
  const body = job('provenance-record');
  assert.ok(workflow.indexOf('  provenance-record:') > workflow.indexOf('  main-red-alert:'));
  assert.match(body, /^    needs: \[changes, ci-success\]$/m);
  assert.deepEqual(body.split('\n').filter(line => line.startsWith('    if:')), ["    if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.result == 'success' && needs.ci-success.result == 'success' }}"]);
  assert.match(body, /^    continue-on-error: true$/m);
  assert.match(body, /^    timeout-minutes: 10$/m);
  assert.equal(body.match(/^    permissions:\n([\s\S]*?)(?=^    [a-z][\w-]*:)/m)[1], '      contents: read\n');
  assert.ok(body.includes(`uses: actions/checkout@${CHECKOUT_SHA}`));
  assert.match(body, /ref: \$\{\{ github.sha \}\}/); assert.match(body, /fetch-depth: 2/);
  assert.match(body, /persist-credentials: false/); assert.match(body, /sparse-checkout-cone-mode: false/);
  assert.match(body, /sparse-checkout: \|\n            \.github\/scripts\n            \.github\/workflows/);
  assert.ok(body.includes(`uses: actions/upload-artifact@${UPLOAD_SHA} # v7`));
  assert.ok(body.includes('name: ci-provenance-attempt-${{ github.run_attempt }}'));
  assert.match(body, /path: provenance.json/); assert.match(body, /retention-days: 7/);
  assert.match(body, /^          if-no-files-found: error$/m);
  assert.ok(body.includes('CI_SUCCESS_RESULT: ${{ needs.ci-success.result }}'));
  assert.ok(body.includes('FULL_SELECTION: ${{ toJSON(needs.changes.outputs) }}'));
  assert.match(body, /run: node \.github\/scripts\/queue-selection\.mjs record/);
  assert.doesNotMatch(job('ci-success').match(/needs: \[([^\]]+)\]/)[1], /provenance-record/);
});
test('lint registers queue-selection next to W3', () => {
  assert.match(job('lint'), /^        run: node --test \.github\/scripts\/queue-selection\.test\.mjs$/mu);
  assert.match(job('lint'), /Test PR selection contract \(W3\)\n        run: node --test \.github\/scripts\/ci-pr-selection\.test\.mjs\n\n      - name: Test queue selection contract \(W4\)/);
});
test('record drops advisory outputs from the 15-key classifier selection', () => {
  const io = recordIO(), input = recordInput();
  input.selection = { ...input.selection, selection_mode: 'pr', selection_reason: '' };
  queue.record(io, input);
  const stored = JSON.parse(io.writes.get('provenance.json'));
  assert.equal(Object.keys(stored.selection).length, 15);
  assert.deepEqual(stored.selection, recordInput().selection);
});

test('existing classifier test harness still extracts exactly the classifier shell', () => {
  const extracted = job('changes').split('        run: |\n')[1].split('\n')
    .filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  assert.ok(extracted.startsWith('set -euo pipefail\n'));
  assert.ok(extracted.endsWith('printf \'%s\\n\' "${classified}" | tee -a "${GITHUB_OUTPUT}"'));
  assert.doesNotMatch(extracted, /\$\{\{|queue-selection/);
});

test('real sparse queue checkout verifies base policy and computes shadow without network', () => tempRepo(({ dir, git, put, commit }) => {
  // Listed files that have not landed yet (the W02 gate) are absent at base too.
  for (const path of new Set([...queue.POLICY_FILES, 'apps/api/vitest.integration.config.ts',
    ...Object.keys(context.playwrightConfigs).map(name => `e2e-tests/${name}`)])) {
    if (existsSync(join(REPO_ROOT, path))) put(path, readFileSync(join(REPO_ROOT, path), 'utf8'));
  }
  const base = commit('base policies');
  git('checkout', '-qb', 'pr'); put('apps/web/src/x.ts', 'export const x = 1;'); const head = commit('PR');
  git('checkout', '-qb', 'pr-check', base); git('merge', '--no-ff', '-qm', 'PR merge', 'pr');
  const prMerge = git('rev-parse', 'HEAD'), io = queue.createIO({ cwd: dir });
  const r = queue.record(io, { ...recordInput(), headSha: head, mergeSha: prMerge });
  rmSync(join(dir, 'provenance.json'));
  git('checkout', '-q', 'main'); put('apps/api/src/routes/x.ts', 'export const x = 1;'); const parent = commit('ahead');
  git('merge', '--squash', '-q', 'pr'); git('commit', '-qm', 'queue squash'); const queueHead = git('rev-parse', 'HEAD');
  assert.equal(git('rev-list', '--parents', '-n', '1', queueHead).split(' ').length, 2, 'queue commit has exactly one parent');
  io.prHead = pr => { assert.equal(pr, 12); return head; };
  git('sparse-checkout', 'set', '--no-cone', '.github/scripts');
  assert.ok(!existsSync(join(dir, '.github/workflows/ci.yml')));
  io.records = (requestedHead, pr) => { assert.equal(requestedHead, head); assert.equal(pr, 12); return { records: [r], stats: { runs: 1, artifacts: 1, expired: 0, rejected: [] } }; };
  const logs = []; io.stdout = line => logs.push(line);
  const out = queue.runCLI(io, ['shadow'], { EVENT_NAME: 'merge_group', HEAD_REF: 'refs/heads/gh-readonly-queue/main/pr-12-deadbeef',
    HEAD_SHA: queueHead, BASE_SHA: parent, FULL_SELECTION: JSON.stringify(classify(r.files)) });
  assert.equal(out.mode, 'shadow', JSON.stringify(out)); assert.equal(out.B, base);
  assert.deepEqual(out.delta, ['apps/api/src/routes/x.ts']); assert.equal(logs.length, 1);
  assert.ok(!out.thin_jobs.includes('test-web')); assert.ok(out.thin_jobs.includes('build-web'));
  assert.ok(out.thin_jobs.includes('build-api'), 'builds include the delta area');
}));

test('base policy digest is logged on policy fallbacks', () => {
  for (const mismatch of ['record', 'working-tree']) {
    const { io, input, r } = shadowIO(); const git = io.git;
    if (mismatch === 'record') r.policy_digest = null;
    else io.git = args => args[0] === 'hash-object' ? 'f'.repeat(40) : git(args);
    const out = queue.shadow(io, input);
    assert.equal(out.reason, mismatch === 'record' ? 'policy_digest_mismatch' : 'policy_not_at_base');
    assert.match(out.policy_digest, /^[a-f\d]{64}$/);
    assert.ok(io.logs[0].includes(`policy_digest="${out.policy_digest}"`));
  }
});
test('git lazy fetch authentication is child-only and absent from command arguments', () => {
  const env = { GH_TOKEN: 'fake-test-token', GITHUB_SERVER_URL: 'https://github.com', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.foo', GIT_CONFIG_VALUE_0: 'bar' };
  const before = { ...env }, calls = [], io = queue.createIO({ env });
  io.exec = (...args) => { calls.push(args); return ''; };
  io.git(['sparse-checkout', 'add', '.github/workflows']);
  const [command, args, , childEnv] = calls[0];
  assert.equal(command, 'git'); assert.deepEqual(args, ['sparse-checkout', 'add', '.github/workflows']);
  assert.equal(childEnv.GIT_CONFIG_COUNT, '2');
  assert.equal(childEnv.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  assert.equal(childEnv.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:fake-test-token').toString('base64')}`);
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0'); assert.deepEqual(env, before);
});

test('record CLI takes event and attempt identity only from env', () => {
  const io = recordIO(), selection = recordInput().selection;
  queue.runCLI(io, ['record'], { EVENT_NAME: 'pull_request', CI_SUCCESS_RESULT: 'success', HEAD_SHA: H, MERGE_SHA: M,
    PR_NUMBER: '12', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', FULL_SELECTION: JSON.stringify(selection) });
  const r = JSON.parse(io.writes.get('provenance.json'));
  assert.equal(r.head_sha, H); assert.equal(r.run_id, 100); assert.equal(r.run_attempt, 2);
  assert.deepEqual(r.selection, selection);
});


test('T6: only the three outputs read the consume step, classifier gates are pinned', () => {
  const keys = ['code', 'docs', 'agent', 'app', 'api', 'web', 'portal', 'addins', 'm365', 'rust',
    'topology_browser', 'agent_code', 'integration', 'path_readers', 'reader_tests'];
  const body = job('changes');
  for (const key of keys) {
    assert.deepEqual(body.split('\n').filter(line => line.startsWith(`      ${key}:`)),
      [`      ${key}: \${{ steps.classify.outputs.${key} }}`]);
  }
  const outputLines = workflow.split('\n').filter(line => line.includes('steps.queue_thin.'));
  assert.equal(outputLines.length, 3);
  for (const line of outputLines) assert.match(line, /^      (selection_mode|selection_reason|thin_skip):/);
  for (const key of ['selection_mode', 'selection_reason']) {
    assert.equal(workflow.split(key).length - 1, 2, key);
    assert.equal(outputLines.filter(line => line.startsWith(`      ${key}:`)).length, 1);
  }
});


test('F3: record CLI exits 1 and removes a previous artifact on invalid run context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-record-cli-'));
  try {
    writeFileSync(join(dir, 'provenance.json'), 'stale');
    const result = spawnSync(process.execPath, [join(REPO_ROOT, '.github/scripts/queue-selection.mjs'), 'record'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, EVENT_NAME: 'merge_group', CI_SUCCESS_RESULT: 'failure', FULL_SELECTION: '{}' },
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /event="merge_group".*ciSuccess="failure"/);
    assert.ok(!existsSync(join(dir, 'provenance.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F5: shadow reports input.error before any workflow read', () => {
  const { io, input } = shadowIO(); let reads = 0;
  io.read = () => { reads++; throw Error('later ENOENT'); };
  const out = queue.shadowCore(io, { ...input, error: Error('first cause') });
  assert.equal(out.reason, 'error'); assert.equal(out.error, 'first cause'); assert.equal(reads, 0);
});
test('F5: CLI labels the first parse or sparse-checkout failure without masking it', () => {
  for (const full of ['{', '{}']) {
    const { io } = shadowIO(); let reads = 0, gitCalls = 0;
    io.read = () => { reads++; throw Error('later ENOENT'); };
    io.git = () => { gitCalls++; throw Error('fetch unavailable'); };
    const out = queue.runCLI(io, ['shadow'], { EVENT_NAME: 'merge_group', FULL_SELECTION: full });
    assert.equal(out.reason, 'error'); assert.equal(reads, 0);
    if (full === '{') { assert.match(out.error, /^FULL_SELECTION parse failed: /); assert.equal(gitCalls, 0); }
    else { assert.equal(out.error, 'sparse-checkout add failed: fetch unavailable'); assert.equal(gitCalls, 1); }
  }
});


const DELTA_COUNT = `rev-list --count --first-parent ${B}..${BASE}`;
const ENTRY_COUNT = `rev-list --count --first-parent ${BASE}..${M}`;
const DELTA_DIFF = `diff --name-only --no-renames ${B} ${BASE}`;
const ENTRY_DIFF = `diff --name-only --no-renames ${BASE} ${M}`;
for (const [reason, command, answer] of [
  ['too_many_merges', DELTA_COUNT, '41'],
  ['policy_path_in_delta', DELTA_DIFF, '.github/actions/x/action.yml\n'],
  ['entry_not_single_commit', ENTRY_COUNT, '2'],
  ['empty_change_set', ENTRY_DIFF, ''],
]) test(`T5: shadowCore ${reason} uses the exact git range`, () => {
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => args.join(' ') === command ? answer : git(args);
  assert.equal(queue.shadowCore(io, input).reason, reason);
});
for (const reason of ['empty_change_set', 'no_pr_number', 'no_valid_record', 'not_merge_group']) {
  test(`T5: shadowCore ${reason} input fallback`, () => {
    const { io, input, r } = shadowIO(); let headCalls = 0; const prHead = io.prHead;
    io.prHead = pr => { headCalls++; return prHead(pr); };
    if (reason === 'empty_change_set') r.files = [];
    if (reason === 'no_pr_number') input.headRef = 'not-a-queue-ref';
    if (reason === 'no_valid_record') io.records = () => ({ records: [], stats: { runs: 0, artifacts: 0, expired: 0, rejected: [] } });
    if (reason === 'not_merge_group') input.event = 'pull_request';
    const out = queue.shadowCore(io, input);
    assert.equal(out.mode, 'full'); assert.equal(out.reason, reason);
    assert.equal(headCalls, ['empty_change_set', 'no_valid_record'].includes(reason) ? 1 : 0);
    assert.deepEqual(out.thin_jobs, out.full_jobs);
  });
}
test('F6: empty P is full, but a nonempty entry with no delta can still be shadow', () => {
  const full = Object.fromEntries(Object.keys(classify(['apps/web/src/x.ts'])).map(key => [key, 'true']));
  const out = select([], [], full);
  assert.equal(out.reason, 'empty_change_set'); assert.deepEqual(out.thin_jobs, out.full_jobs);
  for (const change of [{ record: { files: [] } }, { entryFiles: [] }]) {
    assert.equal(queue.fallbackReason({ ...validFacts(), ...change }), 'empty_change_set');
  }
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => args.join(' ') === DELTA_DIFF ? '' : git(args);
  assert.equal(queue.shadowCore(io, input).mode, 'shadow');
});
test('F7: delta diff failures retain their git error while falling back', () => {
  const { io, input } = shadowIO(); const git = io.git;
  io.git = args => { if (args.join(' ') === DELTA_DIFF) throw Error('delta diff: missing base object'); return git(args); };
  const out = queue.shadowCore(io, input);
  assert.equal(out.reason, 'delta_uncomputable'); assert.equal(out.error, 'delta diff: missing base object');
});


test('F8: artifact diagnostics identify each rejected record and keep invalid_records', () => {
  for (const [contents, why] of [
    ['{', 'invalid_json'], [JSON.stringify(rawRecord({ schema: 2 })), 'invalid_record'],
    [JSON.stringify(rawRecord({ run_id: 999 })), 'run_id_mismatch'],
    [JSON.stringify(rawRecord({ run_attempt: 99 })), 'attempt_mismatch'],
    [JSON.stringify(rawRecord({ pr_number: 99 })), 'pr_number_mismatch'], [null, 'missing_provenance'],
  ]) {
    const artifacts = artifactIO();
    artifacts.read = path => contents === null || contents === '{' || why === 'attempt_mismatch' ? contents
      : JSON.stringify({ ...JSON.parse(contents), run_attempt: JSON.parse(artifacts.records.get(path)).run_attempt });
    if (contents === null) artifacts.exists = () => false;
    const result = queue.readRecords(artifacts, { repository: 'owner/repo', head: H, pr: 12 });
    assert.deepEqual(result.records, [null, null]);
    assert.deepEqual(result.stats, { runs: 1, artifacts: 3, expired: 1, rejected: [
      { run_id: 100, attempt: 1, why }, { run_id: 100, attempt: 2, why },
    ] });
    const { io, input } = shadowIO(); io.records = () => result;
    const out = queue.shadow(io, input, { summary: 'summary' });
    assert.equal(out.reason, 'no_valid_record'); assert.equal(out.invalid_records, 2);
    assert.deepEqual(out.record_stats, result.stats);
    assert.ok(io.logs[0].includes(`record_stats=${JSON.stringify(result.stats)}`));
    assert.ok(io.writes.get('summary').includes(`record_stats=${JSON.stringify(result.stats)}`));
  }
});
test('F8: no matching workflow runs produce zero diagnostic counts', () => {
  const io = artifactIO(); io.gh = () => JSON.stringify([{ workflow_runs: [] }]);
  assert.deepEqual(queue.readRecords(io, { repository: 'owner/repo', head: H }), {
    records: [], stats: { runs: 0, artifacts: 0, expired: 0, rejected: [] },
  });
});
test('F4: errors and missing records get warning annotations and complete single-line logs', () => {
  for (const reason of ['error', 'no_valid_record']) {
    const { io, input } = shadowIO();
    if (reason === 'error') input.error = Error('first cause 50%\nsecond line');
    else io.records = () => ({ records: [], stats: { runs: 2, artifacts: 1, expired: 1, rejected: [] } });
    const out = queue.shadow(io, input, { summary: 'summary' });
    assert.equal(out.reason, reason); assert.equal(io.logs.length, 1);
    assert.equal(io.logs[0].split('\n').length, 1);
    assert.ok(io.logs[0].includes(`error=${JSON.stringify(out.error ?? null)}`));
    assert.ok(io.writes.get('summary').includes(`error=${JSON.stringify(out.error ?? null)}`));
    const warnings = io.errors.filter(line => line.startsWith('::warning title=queue-selection shadow::'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], `::warning title=queue-selection shadow::${reason}: ${reason === 'error'
      ? 'first cause 50%25%0Asecond line' : JSON.stringify(out.record_stats)}`);
  }
  const { io, input } = shadowIO(); input.headRef = 'bad'; queue.shadow(io, input);
  assert.equal(io.errors.filter(line => line.startsWith('::warning')).length, 0);
});


const areaNames = ['api', 'web', 'portal', 'addins', 'm365', 'rust', 'agent_code'];
const activeAreas = paths => areaNames.filter(area => classify(paths)[area] === 'true');
const DISJOINT_DELTA = ['apps/m365-graph-read-executor/src/a.ts'];
const floorRules = context.floor.split('\n').map(line => line.split('#')[0].trim()).filter(Boolean);
const onFloor = path => floorRules.some(rule => rule.endsWith('/') ? path.startsWith(rule) : path === rule);
test('T2: same-area units run without same-file overlap, truly disjoint areas do not', () => {
  const P = ['apps/web/src/a.ts'];
  assert.deepEqual(activeAreas(P), ['api', 'web']);
  assert.deepEqual(activeAreas(['apps/api/src/b.ts']), ['api']);
  const same = select(P, ['apps/web/src/b.ts']);
  assert.deepEqual(same.overlap, []); assert.ok(same.thin_jobs.includes('test-web'));
  const api = select(P, ['apps/api/src/b.ts']);
  assert.ok(api.thin_jobs.includes('test-api')); assert.ok(!api.thin_jobs.includes('test-web'));
  assert.deepEqual(activeAreas(DISJOINT_DELTA), ['m365']);
  assert.deepEqual(activeAreas(P).filter(area => activeAreas(DISJOINT_DELTA).includes(area)), []);
  const disjoint = select(P, DISJOINT_DELTA);
  assert.ok(!disjoint.thin_jobs.includes('test-web')); assert.ok(!disjoint.thin_jobs.includes('test-api'));
});
test('T3: own test routes actually select unit and non-floor integration jobs', () => {
  const P = ['apps/web/src/x.test.tsx'];
  assert.deepEqual(activeAreas(P).filter(area => activeAreas(DISJOINT_DELTA).includes(area)), []);
  assert.ok(select(P, DISJOINT_DELTA).thin_jobs.includes('test-web'));
  const includeBlock = context.integrationConfig.match(/include:\s*\[([\s\S]*?)\]/)[1].replace(/\/\/[^\n]*/g, '');
  const candidates = [...includeBlock.matchAll(/['"]([^'"]+)['"]/g)].map(m => `apps/api/${m[1]}`);
  const ownIntegration = candidates.find(path => !/[?*{]/.test(path) && !onFloor(path));
  assert.ok(ownIntegration, 'derive an integration include not covered by the floor');
  assert.deepEqual(queue.routeOwnTest(ownIntegration, context).jobs, ['integration-test']);
  assert.ok(select([ownIntegration], []).thin_jobs.includes('integration-test'));
});
test('T4: API overlap runs integration only when both PR classifiers request it', () => {
  const P = ['apps/api/src/services/a.ts'], delta = ['apps/api/src/routes/b.ts'], web = ['apps/web/src/b.ts'];
  for (const path of [...P, ...delta, ...web]) assert.ok(!onFloor(path), path);
  assert.equal(classify(P, true).integration, 'true'); assert.equal(classify(delta, true).integration, 'true');
  assert.ok(select(P, delta).thin_jobs.includes('integration-test'));
  assert.equal(classify(web).api, 'true'); assert.equal(classify(web, true).integration, 'false');
  assert.ok(!select(P, web).thin_jobs.includes('integration-test'));
});
test('T7: self-gated migrations/docs and shared path-area units remain selected', () => {
  assert.ok(select(['apps/api/migrations/zzz.sql'], []).thin_jobs.includes('check-migrations'));
  assert.ok(select(['docs/queue-notes.md'], []).thin_jobs.includes('docs-check'));
  assert.ok(select(['packages/shared/src/a.ts'], ['packages/shared/src/b.ts']).thin_jobs.includes('test-shared'));
  assert.equal(classify(DISJOINT_DELTA).api, 'false');
  assert.ok(select(DISJOINT_DELTA, ['apps/api/src/routes/x.ts']).thin_jobs.includes('build-api'), 'a build area present only in delta');
});

// ── W02d (#10746): an injected record source; the default is unchanged ───

test('shadowCore: without io.recordSource it reads io.records, as the candidate-side shadow always has', () => {
  const { io, input } = shadowIO();
  let read = 0;
  const records = io.records;
  io.records = (...args) => { read++; return records(...args); };
  assert.equal(queue.shadowCore(io, input).mode, 'shadow');
  assert.equal(read, 1);
  assert.equal(queue.createIO().recordSource, undefined, 'the candidate side never gets a source by default');
});

test('shadowCore: io.recordSource replaces io.records and its record goes through the same checks', () => {
  const { io, input, r } = shadowIO();
  io.records = () => assert.fail('io.records must not be read when a source is injected');
  const asked = [];
  io.recordSource = (head, pr) => { asked.push([head, pr]); return { records: [r], stats: { source: 'injected' } }; };
  const out = queue.shadowCore(io, input);
  assert.equal(out.mode, 'shadow');
  assert.deepEqual(asked, [[H, 12]]);
  assert.deepEqual(out.record_stats, { source: 'injected' });
  // The source supplies evidence only: a record it vouches for still has to pass.
  io.recordSource = () => ({ records: [{ ...r, files: ['apps/web/src/other.ts'] }], stats: {} });
  assert.equal(queue.shadowCore(io, input).reason, 'entry_outside_p');
});

for (const reason of ['no_anchor', 'anchor_not_pinned', 'anchor_policy_in_p', 'no_verified_pr_run']) {
  test(`shadowCore: a source that reports ${reason} means full, under that reason`, () => {
    const { io, input } = shadowIO();
    io.recordSource = () => ({ records: [], stats: { runs: 2 }, reason });
    const out = queue.shadowCore(io, input);
    assert.equal(out.mode, 'full');
    assert.equal(out.reason, reason);
    assert.deepEqual(out.thin_jobs, out.full_jobs);
    assert.deepEqual(out.record_stats, { runs: 2 });
    assert.deepEqual(out.would_skip, []);
  });
}

test('shadowCore: a source that throws is reason=error, and full', () => {
  const { io, input } = shadowIO();
  io.recordSource = () => { throw Error('actions api down'); };
  const out = queue.shadowCore(io, input);
  assert.deepEqual([out.mode, out.reason, out.error], ['full', 'error', 'actions api down']);
});

test('policyAtBase: io.blob answers for the policy files; the default hashes the working tree', () => {
  const { io, input } = shadowIO();
  const git = io.git;
  io.git = args => { if (args[0] === 'hash-object') assert.fail('hash-object reads the working tree'); return git(args); };
  const asked = [];
  io.blob = path => { asked.push(path); return 'e'.repeat(40); };
  assert.equal(queue.shadowCore(io, input).mode, 'shadow');
  assert.deepEqual(asked, ['.github/workflows/ci.yml']);
  io.blob = () => 'a'.repeat(40);
  assert.equal(queue.shadowCore(io, input).reason, 'policy_not_at_base');
});

test('SHADOW_FIELDS and CLASSIFIER_KEYS are what the shadow line and a record carry', () => {
  const { io, input } = shadowIO();
  const out = queue.shadow(io, input);
  const logged = [...io.logs[0].matchAll(/ (\w+)=/g)].map(match => match[1]).filter(key => !['mode', 'reason'].includes(key));
  assert.deepEqual(logged, queue.SHADOW_FIELDS);
  assert.equal(out.mode, 'shadow');
  assert.deepEqual(queue.CLASSIFIER_KEYS, Object.keys(classify(['apps/web/src/x.ts'])));
});

// ── W05 (#10749): consume, the changes job reading the CI Gate's selection ──

const GATE_PATH = '.github/workflows/ci-gate.yml';
const REPO = 'LanternOps/breeze';
const GATE_RUN = 4242, PINNED_WORKFLOW = 409546478, LISTED_GATE = 777, LISTED_CI = 778;
const QUEUE_REF = 'refs/heads/gh-readonly-queue/main/pr-12-deadbeef';
const FAKE_TEMP = '/tmp/queue-thin-fake';
const GATE_ENV = { GATE_WORKFLOW: GATE_PATH, GATE_SELECTION_ARTIFACT: 'ci-gate-selection-attempt-1', GATE_SELECTION_FILE: 'ci-gate-selection.json' };
const consumeEnv = (overrides = {}) => ({ GITHUB_REPOSITORY: REPO, HEAD_SHA: M, BASE_SHA: BASE, HEAD_REF: QUEUE_REF,
  THIN_QUEUE: 'enforce', ...GATE_ENV, ...overrides });
const gateRun = (overrides = {}) => ({ id: GATE_RUN, path: GATE_PATH, event: 'merge_group', head_sha: M,
  workflow_id: PINNED_WORKFLOW, ...overrides });
const published = (overrides = {}) => ({ schema: 1, repository: REPO, head_sha: M, base_sha: BASE, head_ref: QUEUE_REF,
  policy_digest: 'f'.repeat(64), gate_run: GATE_RUN, gate_attempt: 1, source_attempt: 1, mode: 'thin', reason: '',
  thin_skip: ['test-web', 'build-web'], would_skip: ['build-web', 'test-web', 'smoke-test'], thin_queue: 'enforce', ...overrides });
// A fake clock: sleep advances it. runsAt / artifactAt say from which second each
// is visible, so the 60 s and 180 s deadlines can be tested at their boundaries.
const SELECTION_ARTIFACT = { name: 'ci-gate-selection-attempt-1', expired: false };
// failing: { workflows | runs | artifacts: n } makes the first n such calls throw, as a 5xx would.
function consumeIO({ runs = [gateRun()], runsAt = 0, artifactAt = 0, body = published(), workflows,
  artifacts = [SELECTION_ARTIFACT], failing = {} } = {}) {
  let now = 1_000_000;
  const start = now, calls = [], logs = [], errors = [], writes = new Map(), removed = [];
  const at = () => (now - start) / 1000;
  const listed = workflows ?? [{ id: LISTED_GATE, path: GATE_PATH }, { id: LISTED_CI, path: '.github/workflows/ci.yml' }];
  const flaky = kind => {
    if ((failing[kind] ?? 0) > 0) { failing[kind]--; throw Object.assign(Error(`Command failed: gh api ${kind}`), { stderr: 'HTTP 502: Bad Gateway\n' }); }
  };
  const paginated = args => assert.ok(args.includes('--paginate') && args.includes('--slurp'), `not paginated: ${args.join(' ')}`);
  const io = {
    calls, logs, errors, writes, removed,
    now: () => now, sleep: ms => { now += ms; },
    stdout: line => logs.push(line), stderr: line => errors.push(line),
    append: (path, text) => writes.set(path, (writes.get(path) ?? '') + text),
    temp: () => FAKE_TEMP, remove: path => removed.push(path),
    read: path => {
      assert.equal(path, `${FAKE_TEMP}/ci-gate-selection.json`);
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    gh: args => {
      calls.push(args);
      const endpoint = args[0] === 'api' ? args.find(arg => arg.startsWith('repos/')) : null;
      if (endpoint === `repos/${REPO}/actions/workflows?per_page=100`) {
        paginated(args); flaky('workflows');
        return JSON.stringify([{ workflows: listed }]);
      }
      if (endpoint === `repos/${REPO}/actions/runs?event=merge_group&head_sha=${M}&per_page=100`) {
        flaky('runs');
        return JSON.stringify({ workflow_runs: at() >= runsAt ? runs : [] });
      }
      const run = endpoint?.match(/^repos\/LanternOps\/breeze\/actions\/runs\/(\d+)\/artifacts\?name=ci-gate-selection-attempt-1&per_page=100$/);
      if (run) {
        paginated(args); flaky('artifacts');
        return JSON.stringify([{ artifacts: at() >= artifactAt && Number(run[1]) === GATE_RUN ? artifacts : [] }]);
      }
      if (args[0] === 'run' && args[1] === 'download') {
        assert.deepEqual(args, ['run', 'download', String(GATE_RUN), '--repo', REPO, '--name', 'ci-gate-selection-attempt-1', '--dir', FAKE_TEMP]);
        return '';
      }
      throw Error(`Unexpected gh: ${args.join(' ')}`);
    },
  };
  return io;
}
const outputs = io => Object.fromEntries((io.writes.get('out') ?? '').trim().split('\n').map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
const consumeWith = async (io, env = consumeEnv()) => {
  assert.equal(await queue.consume(io, env, { output: 'out' }), 0);
  return outputs(io);
};

test('consume: kill switch off, unset or unknown is full thin_disabled with no gh call', async () => {
  for (const value of [undefined, '', 'off', 'ENFORCE', 'on']) {
    const io = consumeIO();
    assert.deepEqual(await consumeWith(io, consumeEnv({ THIN_QUEUE: value })),
      { thin_skip: '', selection_mode: 'full', selection_reason: 'thin_disabled' }, String(value));
    assert.equal(io.calls.length, 0, String(value));
    assert.equal(io.logs.length, 1);
    assert.match(io.logs[0], /^queue-thin: mode=full reason=thin_disabled gate_run=null waited_s=0 thin_skip=""$/);
  }
});

test('consume: a thin selection becomes the thin_skip value, exactly three output keys', async () => {
  const io = consumeIO();
  await consumeWith(io);
  assert.equal(io.writes.get('out'), 'thin_skip=,build-web,test-web,\nselection_mode=thin\nselection_reason=\n');
  assert.deepEqual(io.logs, [`queue-thin: mode=thin reason= gate_run=${GATE_RUN} waited_s=0 thin_skip=",build-web,test-web,"`]);
  assert.deepEqual(io.removed, [FAKE_TEMP]);
});

test('consume: shadow runs everything and logs the list it would skip', async () => {
  const io = consumeIO({ body: published({ mode: 'shadow', thin_queue: 'shadow' }) });
  assert.deepEqual(await consumeWith(io, consumeEnv({ THIN_QUEUE: 'shadow' })),
    { thin_skip: '', selection_mode: 'full', selection_reason: 'gate_shadow' });
  assert.deepEqual(io.logs, [`queue-thin: mode=full reason=gate_shadow gate_run=${GATE_RUN} waited_s=0 thin_skip="" would_skip=",build-web,test-web,"`]);
});

test('consume: a full selection is full with the gate\'s reason', async () => {
  for (const reason of ['thin_disabled', 'audit_sample', 'stale_base', 'error']) {
    assert.deepEqual(await consumeWith(consumeIO({ body: published({ mode: 'full', reason, thin_skip: [] }) })),
      { thin_skip: '', selection_mode: 'full', selection_reason: `gate:${reason}` }, reason);
  }
});

test('consume: the gate run must appear within 60 s (polled every 10 s)', async () => {
  const found = consumeIO({ runsAt: 60 });
  assert.equal((await consumeWith(found)).selection_mode, 'thin');
  assert.match(found.logs[0], / waited_s=60 /);
  const late = consumeIO({ runsAt: 61 });
  assert.deepEqual(await consumeWith(late), { thin_skip: '', selection_mode: 'full', selection_reason: 'no_gate_run' });
  assert.match(late.logs[0], / waited_s=60 /);
  const polls = late.calls.filter(args => args.some(arg => arg.includes('actions/runs?event=merge_group')));
  assert.equal(polls.length, 7, 'polls at 0, 10, ... 60 s');
});

test('consume: the selection must appear within 180 s of the start', async () => {
  const found = consumeIO({ runsAt: 30, artifactAt: 180 });
  assert.equal((await consumeWith(found)).selection_mode, 'thin');
  assert.match(found.logs[0], / waited_s=180 /);
  const late = consumeIO({ runsAt: 30, artifactAt: 181 });
  assert.deepEqual(await consumeWith(late), { thin_skip: '', selection_mode: 'full', selection_reason: 'no_gate_selection' });
  assert.ok(!late.calls.some(args => args[0] === 'run'), 'nothing is downloaded');
});

test('consume: only this gate\'s attempt-1 artifact, unexpired, counts as published', async () => {
  for (const [name, artifacts] of [
    ['expired', [{ ...SELECTION_ARTIFACT, expired: true }]],
    ['another name', [{ name: 'ci-gate-selection-attempt-2', expired: false }]],
    ['none', []],
  ]) {
    const io = consumeIO({ artifacts });
    assert.deepEqual(await consumeWith(io), { thin_skip: '', selection_mode: 'full', selection_reason: 'no_gate_selection' }, name);
    assert.ok(!io.calls.some(args => args[0] === 'run'), `${name}: nothing is downloaded`);
  }
});

test('consume: a transient API error is retried at the next poll, until the deadline', async () => {
  for (const kind of ['workflows', 'runs', 'artifacts']) {
    const io = consumeIO({ failing: { [kind]: 2 } });
    assert.equal((await consumeWith(io)).selection_mode, 'thin', kind);
    assert.match(io.logs[0], / waited_s=20 /, kind);
  }
  // Still failing at the deadline: full error, and the cause gh printed is kept.
  const down = consumeIO({ failing: { runs: 99 } });
  assert.equal((await consumeWith(down)).selection_reason, 'error');
  assert.match(down.logs[0], / waited_s=60 thin_skip="" detail="Command failed: gh api runs: HTTP 502: Bad Gateway"$/);
  const late = consumeIO({ failing: { artifacts: 99 } });
  assert.equal((await consumeWith(late)).selection_reason, 'error');
  assert.match(late.logs[0], / waited_s=180 thin_skip="" detail="Command failed: gh api artifacts: HTTP 502: Bad Gateway"$/);
});

test('consume: a failed download keeps gh\'s cause; a failed cleanup does not discard a good selection', async () => {
  const io = consumeIO();
  const gh = io.gh;
  io.gh = args => {
    if (args[0] === 'run') throw Object.assign(Error('Command failed: gh run download 4242'), { stderr: 'HTTP 404: Not Found\n' });
    return gh(args);
  };
  assert.equal((await consumeWith(io)).selection_reason, 'error');
  assert.match(io.logs[0], / detail="Command failed: gh run download 4242: HTTP 404: Not Found"$/);
  const tidy = consumeIO();
  tidy.remove = () => { throw Error('EBUSY'); };
  assert.equal((await consumeWith(tidy)).selection_mode, 'thin');
});

test('consume: once the switch is on, the gate\'s published mode decides (a flip mid-entry drains)', async () => {
  // The gate published thin under enforce; the switch moved to shadow before changes read
  // it. In-flight entries keep their published list (plan D3), and the gate judges with it.
  assert.equal((await consumeWith(consumeIO(), consumeEnv({ THIN_QUEUE: 'shadow' }))).selection_mode, 'thin');
  // Off is read at once and runs everything, which the gate's list always permits.
  assert.equal((await consumeWith(consumeIO(), consumeEnv({ THIN_QUEUE: 'off' }))).selection_reason, 'thin_disabled');
});

test('consume: only a pinned gate run counts (repository-wide, gate path, unlisted workflow id)', async () => {
  for (const [name, runs] of [
    ['a candidate copy under a listed id', [gateRun({ workflow_id: LISTED_GATE })]],
    ['another path', [gateRun({ path: '.github/workflows/ci.yml' })]],
    ['another event', [gateRun({ event: 'pull_request' })]],
    ['another head', [gateRun({ head_sha: H })]],
    ['no workflow id', [gateRun({ workflow_id: null })]],
  ]) {
    assert.equal((await consumeWith(consumeIO({ runs }))).selection_reason, 'no_gate_run', name);
  }
  const noListedGate = consumeIO({ workflows: [{ id: LISTED_CI, path: '.github/workflows/ci.yml' }] });
  assert.equal((await consumeWith(noListedGate)).selection_reason, 'no_gate_run', 'an unlisted id proves nothing without a listed gate');
  // The newest pinned run wins; a newer candidate copy is ignored.
  const io = consumeIO({ runs: [gateRun({ id: 9999, workflow_id: LISTED_GATE }), gateRun({ id: 1 }), gateRun()] });
  assert.equal((await consumeWith(io)).selection_mode, 'thin');
  assert.ok(io.calls.some(args => args.includes(`repos/${REPO}/actions/runs/${GATE_RUN}/artifacts?name=ci-gate-selection-attempt-1&per_page=100`)));
});

test('consume: a selection for another entry, run, attempt or repository is invalid and full', async () => {
  for (const [name, body] of [
    ['another head', published({ head_sha: H })],
    ['another base', published({ base_sha: B })],
    ['another head ref', published({ head_ref: 'refs/heads/gh-readonly-queue/main/pr-13-deadbeef' })],
    ['another repository', published({ repository: 'someone/else' })],
    ['another gate run', published({ gate_run: GATE_RUN + 1 })],
    ['a later attempt', published({ gate_attempt: 2 })],
    ['schema 2', published({ schema: 2 })],
    ['an unknown mode', published({ mode: 'thinner' })],
    ['a list that is not job ids', published({ thin_skip: ['test-web,smoke-test'] })],
    ['a newline in a job id', published({ thin_skip: ['test-web\nselection_mode=thin'] })],
    ['an extra key', { ...published(), extra: true }],
    ['not JSON', '{"schema":'],
    ['not an object', '[]'],
  ]) {
    const io = consumeIO({ body });
    assert.deepEqual(await consumeWith(io), { thin_skip: '', selection_mode: 'full', selection_reason: 'gate_selection_invalid' }, name);
    assert.match(io.logs[0], / detail=/, name);
  }
});

test('consume: any exception is full error and exit 0, and the temp dir is removed', async () => {
  const io = consumeIO();
  const gh = io.gh;
  io.gh = args => { if (args[0] === 'run') throw Error('HTTP 502'); return gh(args); };
  assert.deepEqual(await consumeWith(io), { thin_skip: '', selection_mode: 'full', selection_reason: 'error' });
  assert.match(io.logs[0], / detail="HTTP 502"$/);
  assert.deepEqual(io.removed, [FAKE_TEMP]);
  for (const env of [consumeEnv({ HEAD_SHA: 'nope' }), consumeEnv({ BASE_SHA: '' }), consumeEnv({ GITHUB_REPOSITORY: 'a b' }),
    consumeEnv({ GATE_WORKFLOW: undefined }), consumeEnv({ GATE_WORKFLOW: '../x.yml' }), consumeEnv({ GATE_SELECTION_ARTIFACT: 'a b' }),
    consumeEnv({ GATE_SELECTION_FILE: '../ci-gate-selection.json' })]) {
    const bad = consumeIO();
    assert.equal((await consumeWith(bad, env)).selection_reason, 'error');
    assert.equal(bad.calls.length, 0);
  }
});

test('consume: an unwritable output still exits 0 and says so', async () => {
  const io = consumeIO();
  io.append = () => { throw Error('EROFS'); };
  assert.equal(await queue.consume(io, consumeEnv(), { output: 'out' }), 0);
  assert.equal(io.logs.length, 1);
  assert.ok(io.errors.some(line => line.includes('EROFS')));
});

test('consume mirrors the gate: producer names, selection keys, value format and every validity check', () => {
  assert.deepEqual(GATE_ENV, { GATE_WORKFLOW, GATE_SELECTION_ARTIFACT: thin.selectionArtifact(1), GATE_SELECTION_FILE: thin.SELECTION_FILE });
  assert.deepEqual(queue.GATE_SELECTION_KEYS, thin.SELECTION_KEYS);
  for (const list of [[], ['test-web'], ['test-web', 'build-api', 'test-web'], ['integration-test', 'path-read-contracts']]) {
    assert.equal(queue.skipValue(list), thin.thinSkipValue(list));
  }
  for (const bad of [['Test-Web'], ['a,b'], [''], [1]]) {
    assert.throws(() => queue.skipValue(bad)); assert.throws(() => thin.thinSkipValue(bad));
  }
  // Differential: the consumer rejects exactly what the gate's own check rejects.
  const expected = { repository: REPO, head_sha: M, base_sha: BASE, head_ref: QUEUE_REF, gate_run: GATE_RUN, gate_attempt: 1, source_attempt: 1 };
  const values = [null, undefined, 0, -1, 1, 2, 1.5, '', 'x', 'shadow', M, 'f'.repeat(64), [], ['test-web'], ['UP'], [1], {}, true];
  const bodies = [published(), published({ mode: 'full', reason: 'stale_base', thin_skip: [] }), published({ policy_digest: null }),
    published({ mode: 'shadow' }), null, [], 'text', { ...published(), extra: 1 }];
  for (const key of thin.SELECTION_KEYS) {
    const { [key]: _, ...without } = published();
    bodies.push(without);
    for (const value of values) bodies.push(published({ [key]: value }));
  }
  let rejected = 0;
  for (const body of bodies) {
    const gate = thin.selectionFailure(body, expected), mine = queue.gateSelectionProblem(body, expected);
    assert.equal(mine, gate, JSON.stringify(body));
    if (gate) rejected++;
  }
  assert.ok(rejected > 200 && rejected < bodies.length, `${rejected} of ${bodies.length} rejected`);
});

// ── W05 (#10749) B2: ci.yml skips what the selection allows; CI Success accepts it ──

const THIN_JOBS = ['build-api', 'build-web', 'build-portal', 'build-agent', 'build-m365-graph-read-executor',
  'build-m365-graph-actions-executor', 'build-m365-communications-executor', 'rust-check',
  'test-api', 'test-web', 'test-portal', 'test-mobile', 'test-viewer', 'test-shared', 'test-document-ui',
  'test-office-addin-core', 'test-excel-addin', 'test-word-addin', 'test-powerpoint-addin', 'test-outlook-addin',
  'test-m365-graph-read-executor', 'test-m365-graph-actions-executor', 'test-m365-communications-executor',
  'test-agent', 'test-agent-windows', 'integration-test', 'path-read-contracts'];
const thinClause = id => ` && !contains(needs.changes.outputs.thin_skip, ',${id},')`;
const needsOf = body => {
  const inline = body.match(/^    needs: \[([^\]]*)\]$/m)?.[1] ?? body.match(/^    needs: ([\w-]+)$/m)?.[1];
  if (inline !== undefined) return inline.split(',').map(s => s.trim()).filter(Boolean);
  const list = body.match(/^    needs:\n((?:      - .*\n)+)/m)?.[1];
  return list ? [...list.matchAll(/^      - ([\w-]+)/gm)].map(m => m[1]) : [];
};

test('B2: THINNABLE is the plan\'s 27 jobs, and exactly the jobs CI Success can count as satisfied', () => {
  assert.deepEqual([...thin.THINNABLE].sort(), [...THIN_JOBS].sort());
  assert.deepEqual(thin.thinnableAtBase(extractAggregator(workflow)), [...thin.THINNABLE]);
});

test('B2: each thinnable job skips itself only on its own id; no other job reads the selection', () => {
  const jobs = queue.workflowJobs(workflow);
  for (const [id, { condition, body }] of Object.entries(jobs)) {
    if (THIN_JOBS.includes(id)) {
      assert.ok(condition?.endsWith(thinClause(id)), `${id}: ${condition}`);
      assert.equal(condition.split('thin_skip').length, 2, id);
      assert.equal(body.split('thin_skip').length, 2, `${id} mentions thin_skip only in its if:`);
    } else if (id !== 'changes' && id !== 'ci-success') {
      assert.ok(!body.includes('thin_skip') && !body.includes('THIN_SKIP'), id);
    }
  }
  const lines = workflow.split('\n').filter(line => /thin_skip|THIN_SKIP/.test(line) && !line.trim().startsWith('#'));
  assert.deepEqual(lines.filter(line => !line.startsWith('    if: ')), [
    '      thin_skip: ${{ steps.queue_thin.outputs.thin_skip }}',
    '          THIN_SKIP: ${{ needs.changes.outputs.thin_skip }}',
    '          for thin_job in ${THIN_SKIP//,/ }; do',
    '          if [[ -n "${THIN_SKIP}" ]]; then',
    '            echo "Thin queue run: skipped as the CI Gate\'s selection allowed, counted as satisfied:${THIN_SKIP//,/ }"',
  ]);
  assert.equal(lines.filter(line => line.startsWith('    if: ')).length, THIN_JOBS.length);
});

test('B2: no job but CI Success needs a thinnable job, so skipping one never skips another', () => {
  const jobs = queue.workflowJobs(workflow);
  assert.ok(THIN_JOBS.every(id => needsOf(jobs['ci-success'].body).includes(id)));
  for (const [id, { body }] of Object.entries(jobs)) {
    if (id === 'ci-success') continue;
    assert.deepEqual(needsOf(body).filter(need => THIN_JOBS.includes(need)), [], id);
  }
  assert.deepEqual(needsOf(jobs['main-red-alert'].body), ['ci-success'], 'the parser reads needs');
});

test('B2: the thin clause parses and is always true for selection (thin never feeds back into it)', () => {
  const base = "needs.changes.outputs.code == 'true'";
  for (const flags of [{ code: 'true' }, { code: 'true', thin_skip: ',test-web,' }, { code: 'true', thin_skip: 'true' }]) {
    assert.equal(queue.evaluateIf(`${base}${thinClause('test-web')}`, flags), true);
  }
  assert.equal(queue.evaluateIf(`${base}${thinClause('test-web')}`, { code: 'false' }), false);
  for (const invalid of [
    `${base} && contains(needs.changes.outputs.thin_skip, ',test-web,')`,
    `${base} && !contains(needs.changes.outputs.code, ',test-web,')`,
    `${base} && !contains(needs.changes.outputs.thin_skip, 'test-web')`,
    `${base} && !contains(needs.changes.outputs.thin_skip, ',Test-Web,')`,
    `${base} && !contains(needs.changes.outputs.thin_skip, ',test-web,') || true`,
  ]) assert.throws(() => queue.parseIfExpression(invalid), invalid);
});

// The real ci-success script, run the way the gate runs it (runAggregator).
const aggregator = extractAggregator(workflow);
const green = () => Object.fromEntries(aggregator.needs.map(need => [need, 'success']));
const judgeScript = ({ results = {}, flags = {}, thinSkip = '' } = {}) => runAggregator(createGateIO(), aggregator, {
  results: { ...green(), ...results }, flags: { ...FULL_SUITE_FLAGS, ...flags, thin_skip: thinSkip },
  outputs: { 'mobile-native-changes.mobile': 'true' }, isPr: false });

test('B2: CI Success counts a skipped job as satisfied only when the selection lists it', () => {
  assert.equal(judgeScript().passed, true, 'baseline: a full green app entry');
  assert.equal(judgeScript({ results: { 'test-web': 'skipped' }, thinSkip: ',test-web,' }).passed, true);
  assert.equal(judgeScript({ results: { 'test-web': 'skipped' } }).passed, false, 'not listed: still required');
  assert.equal(judgeScript({ results: { 'test-web': 'skipped' }, thinSkip: ',build-web,' }).passed, false, 'another job listed');
  for (const result of ['failure', 'cancelled', '']) {
    assert.equal(judgeScript({ results: { 'test-web': result }, thinSkip: ',test-web,' }).passed, false, `a listed job that ${result || 'is missing'} is red`);
  }
  assert.equal(judgeScript({ thinSkip: ',test-web,' }).passed, true, 'running a listed job anyway is never punished');
  // A job thin can never skip stays required even when a forged list names it.
  assert.equal(judgeScript({ results: { 'smoke-test': 'skipped' }, thinSkip: ',smoke-test,' }).passed, false);
  assert.equal(judgeScript({ results: { 'build-mobile-ios': 'skipped' }, thinSkip: ',build-mobile-ios,' }).passed, false);
  // A false area flag still demands skipped: the existing leg is unchanged.
  const webOff = { flags: { web: 'false' }, results: { 'build-web': 'skipped', 'test-web': 'skipped' } };
  assert.equal(judgeScript(webOff).passed, true);
  assert.equal(judgeScript({ ...webOff, thinSkip: ',test-api,' }).passed, true, 'a list naming other jobs changes nothing');
  assert.equal(judgeScript({ ...webOff, results: { ...webOff.results, 'test-web': 'success' }, thinSkip: ',test-web,' }).passed, false);
  // A list that names a job its own flags turned off is red, the fail-closed way: the
  // arm rewrites skipped to success and the false leg demands skipped. The gate never
  // publishes one (would_skip only holds jobs the full flags run).
  assert.equal(judgeScript({ ...webOff, thinSkip: ',test-web,' }).passed, false);
  // Every thinnable job, all skipped at once and all listed.
  const all = Object.fromEntries(THIN_JOBS.map(id => [id, 'skipped']));
  assert.equal(judgeScript({ results: all, thinSkip: thin.thinSkipValue(THIN_JOBS) }).passed, true);
  assert.equal(judgeScript({ results: all, thinSkip: thin.thinSkipValue(THIN_JOBS.slice(1)) }).passed, false);
});

test('B2: CI Success names the jobs it counted, and a hostile list is inert', () => {
  const out = judgeScript({ results: { 'test-web': 'skipped', 'build-api': 'skipped' }, thinSkip: ',build-api,test-web,' });
  assert.equal(out.passed, true);
  assert.match(out.stdout, /^Thin queue run: skipped as the CI Gate's selection allowed, counted as satisfied: build-api test-web $/m);
  assert.match(out.stdout, /All required jobs passed!\n$/);
  assert.doesNotMatch(judgeScript().stdout, /Thin queue run/);
  const dir = mkdtempSync(join(tmpdir(), 'thin-inert-'));
  try {
    // Expansion never runs anything, and a word only counts when it is exactly a label.
    for (const value of [`,$(touch ${dir}/pwned),`, `,test-web$(touch ${dir}/pwned),`, `,\`touch ${dir}/pwned\`,`,
      `,'test-web',`, ',"test-web",', ',test-web;TEST_WEB_RESULT=success,', ',TEST_WEB_RESULT=success,', ',test-web*,']) {
      assert.equal(judgeScript({ results: { 'test-web': 'skipped' }, thinSkip: value }).passed, false, value);
    }
    assert.ok(!existsSync(join(dir, 'pwned')));
    // Whitespace separates like a comma, so it can only name a label, as ",test-web," does.
    assert.equal(judgeScript({ results: { 'test-web': 'skipped' }, thinSkip: ' test-web ' }).passed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('B2: the CI Success script also runs under the macOS bash 3.2 the gate tests use locally', { skip: !existsSync('/bin/bash') }, () => {
  const run = (thinSkip, testWeb) => spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', aggregator.script], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(aggregator.env).map(([name, ref]) => [name,
      ref.kind === 'result' ? (ref.job === 'test-web' ? testWeb : 'success') : ref.kind === 'changes'
        ? (ref.key === 'thin_skip' ? thinSkip : FULL_SUITE_FLAGS[ref.key] ?? '') : ref.kind === 'output' ? 'true' : 'false'])) } });
  assert.equal(run(',test-web,', 'skipped').status, 0);
  assert.equal(run('', 'skipped').status, 1);
});

test('B3: docs/agents/testing.md explains the thin queue run, its log line, every reason and the kill switch', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/agents/testing.md'), 'utf8');
  const section = doc.slice(doc.indexOf('**Thin merge-queue run (W05, #10749).**'));
  assert.ok(section.length < doc.length, 'the section exists');
  for (const text of ['`queue-thin: mode=… reason=… gate_run=… waited_s=… thin_skip=…`', '`ci-gate-selection:`', '`CI_THIN_QUEUE`',
    '`thin_skip`', '`thin_skip_unjustified`', '`gh variable set CI_THIN_QUEUE --body off`', 'docs/agents/merge-and-deploy.md']) {
    assert.ok(section.includes(text), text);
  }
  for (const reason of ['thin_disabled', 'no_gate_run', 'no_gate_selection', 'gate_selection_invalid', 'gate_shadow', 'gate:<reason>', 'error']) {
    assert.ok(section.includes(`\`${reason}\``), reason);
  }
});

test('consume CLI: the real module loads, and with the kill switch unset it writes full and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-thin-cli-'));
  try {
    const output = join(dir, 'out');
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: REPO, HEAD_SHA: M, BASE_SHA: BASE, HEAD_REF: QUEUE_REF, ...GATE_ENV };
    const result = spawnSync(process.execPath, [join(REPO_ROOT, '.github/scripts/queue-selection.mjs'), 'consume'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'thin_skip=\nselection_mode=full\nselection_reason=thin_disabled\n');
    assert.match(result.stdout, /^queue-thin: mode=full reason=thin_disabled /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
