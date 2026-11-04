import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { budgetSkipReason, decide, goRetryCommand, ledgerRunner, parseFailures } from './retry-shard.mjs';

// Whole-shard retry (W1, #10744). The merge queue has no retry, so one flaky
// test ejects the PR and rebuilds every entry behind it. The wrapper re-runs a
// failed shard once — the whole vitest shard, or the failed Go packages — and
// only when it could see which tests failed.

const SCRIPT = fileURLToPath(new URL('./retry-shard.mjs', import.meta.url));
const fixture = (name) => readFileSync(new URL(`./fixtures/retry-shard/${name}`, import.meta.url), 'utf8');
const ids = (r) => r.failures.map((f) => f.id);

const AGENT = 'github.com/breeze-rmm/agent';

// ── parseFailures: vitest ────────────────────────────────────────────────

test('vitest: parses the FAIL summary lines of a real CI log (ANSI colour on)', () => {
  const r = parseFailures('vitest', fixture('vitest-two-failures.txt'));
  assert.equal(r.buildFailed, false);
  assert.deepEqual(ids(r), [
    'src/routes/mcpServer.tasks.test.ts > B-W06 byte identity when Tasks are not effective, not declared, or legacy > MCP_TASKS_ENABLED off → discover, tasks/* (-32601 / 404) and the Mcp-Name rule equal the pre-W06 bytes',
    'src/routes/mcpServer.tasks.test.ts > B-W06 byte identity when Tasks are not effective, not declared, or legacy > MCP_TASKS_ENABLED off, not declared → discover, tasks/* (-32601 / 404) and the Mcp-Name rule equal the pre-W06 bytes',
  ]);
  for (const f of r.failures) {
    assert.equal(f.file, 'src/routes/mcpServer.tasks.test.ts');
    assert.equal(f.pkg, null);
  }
});

test('vitest: splits file on the first " > " only, dedupes, and reads failed suites', () => {
  const out = [
    ' FAIL  src/early.test.ts > looks like a summary but precedes it',
    '',
    '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/broken.test.ts [ src/broken.test.ts ]',
    "Error: Cannot find module './gone'",
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/a.test.ts > suite > handles a > b ordering',
    ' FAIL  src/a.test.ts > suite > handles a > b ordering',
    ' FAIL  src/b.test.ts > top-level test',
    '',
  ].join('\n');
  const r = parseFailures('vitest', out);
  assert.deepEqual(ids(r), [
    'src/broken.test.ts [ src/broken.test.ts ]',
    'src/a.test.ts > suite > handles a > b ordering',
    'src/b.test.ts > top-level test',
  ]);
  assert.deepEqual(r.failures.map((f) => f.file), ['src/broken.test.ts', 'src/a.test.ts', 'src/b.test.ts']);
});

test('vitest: an Unhandled Errors section → unattributed (failures alone do not explain the exit)', () => {
  assert.equal(parseFailures('vitest', '\x1b[31m⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\x1b[39m\nError: boom\n').unattributed, true);
  assert.equal(parseFailures('vitest', 'Unhandled Rejection\nError: boom\n').unattributed, true);
  assert.equal(parseFailures('vitest', fixture('vitest-two-failures.txt')).unattributed, false);
});

test('vitest: no summary section → no failures (setup/infra failure)', () => {
  const r = parseFailures('vitest', 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n FAIL  this is console noise\n');
  assert.deepEqual(r, { failures: [], buildFailed: false, raceDetected: false, timedOut: false, unattributed: false });
});

// ── parseFailures: go ────────────────────────────────────────────────────

test('go: failing tests and failing subtests; parents implied by a failing child are dropped', () => {
  const r = parseFailures('go', fixture('go-test-failures.jsonl'));
  assert.equal(r.buildFailed, false);
  assert.deepEqual(ids(r), [
    `${AGENT}/sessionbroker.TestSessionManager_AddRemoteICECandidateAfterAnswer`,
    `${AGENT}/sessionbroker.TestSessionManager_Subtests/fails`,
  ]);
  for (const f of r.failures) {
    assert.equal(f.pkg, `${AGENT}/sessionbroker`);
    assert.equal(f.file, null);
  }
});

test('go: a parent that fails on its own (no failing child) is reported; package-only fail → id = package', () => {
  const lines = [
    { Action: 'pass', Package: 'p/a', Test: 'TestParent/child' },
    { Action: 'fail', Package: 'p/a', Test: 'TestParent' },
    { Action: 'fail', Package: 'p/a' },
    { Action: 'output', Package: 'p/b', Output: 'panic: TestMain exploded\n' },
    { Action: 'fail', Package: 'p/b' },
    { Action: 'pass', Package: 'p/c' },
  ].map((o) => JSON.stringify(o));
  const r = parseFailures('go', [...lines, 'not json at all', ''].join('\n'));
  assert.deepEqual(r.failures, [
    { id: 'p/a.TestParent', file: null, pkg: 'p/a' },
    { id: 'p/b', file: null, pkg: 'p/b' },
  ]);
  assert.equal(r.buildFailed, false);
});

test('go: build-fail → buildFailed', () => {
  assert.equal(parseFailures('go', fixture('go-build-fail.jsonl')).buildFailed, true);
});

test('go: [setup failed] package → buildFailed', () => {
  assert.equal(parseFailures('go', fixture('go-setup-fail.jsonl')).buildFailed, true);
});

test('go: a real -race report → raceDetected (and the racy test is still a failure)', () => {
  const r = parseFailures('go', fixture('go-race.jsonl'));
  assert.equal(r.raceDetected, true);
  assert.equal(r.buildFailed, false);
  assert.deepEqual(ids(r), [`${AGENT}/racy.TestCounterRace`]);
});

test('raceDetected is false for plain go failures and always false for vitest', () => {
  assert.equal(parseFailures('go', fixture('go-test-failures.jsonl')).raceDetected, false);
  assert.equal(parseFailures('vitest', ' FAIL  noise\n⎯ Failed Tests 1 ⎯\n FAIL  src/a.test.ts > WARNING: DATA RACE\n').raceDetected, false);
});

// ── parseFailures: go, unattributed package failures ─────────────────────
// Real `go test -json` output (go 1.27) from a throwaway module, one package
// per case, each with a TestFlaky and a TestOther. The dedupe above keeps the
// package-level fail out of `failures` (retry targeting), so anything the
// failed tests do not fully explain must surface as `unattributed`.

const QPKG = (n) => `${AGENT}/internal/q${n}`;

test('go: a test that panics → unattributed (later tests in the package never ran)', () => {
  const r = parseFailures('go', fixture('go-quarantine-panic.jsonl'));
  assert.deepEqual(ids(r), [`${QPKG('panic')}.TestFlaky`]);
  assert.equal(r.unattributed, true);
});

test('go: TestMain fails after m.Run → unattributed', () => {
  const r = parseFailures('go', fixture('go-quarantine-main.jsonl'));
  assert.deepEqual(ids(r), [`${QPKG('main')}.TestFlaky`]);
  assert.equal(r.unattributed, true);
});

test('go: -timeout hit → unattributed (a test ran and never finished)', () => {
  const r = parseFailures('go', fixture('go-quarantine-timeout.jsonl'));
  assert.equal(r.unattributed, true);
});

// A package that hit `go test -timeout` used the whole timeout; a second
// attempt of it cannot fit in the job, so it is never retried (like a race).
test('go: `panic: test timed out` → timedOut; plain failures and vitest never are', () => {
  const r = parseFailures('go', fixture('go-quarantine-timeout.jsonl'));
  assert.equal(r.timedOut, true);
  assert.equal(r.failures.length > 0, true, 'the timed-out package is still a failure');
  assert.equal(parseFailures('go', fixture('go-quarantine-clean.jsonl')).timedOut, false);
  assert.equal(parseFailures('go', fixture('go-test-failures.jsonl')).timedOut, false);
  assert.equal(parseFailures('go', fixture('go-quarantine-panic.jsonl')).timedOut, false, 'an ordinary panic is not a timeout');
  // t.Log output is indented, so a test that merely logs the phrase is not a timeout.
  const logged = [
    { Action: 'output', Package: 'p/a', Test: 'TestA', Output: '    a_test.go:9: panic: test timed out after 1s\n' },
    { Action: 'fail', Package: 'p/a', Test: 'TestA' },
    { Action: 'fail', Package: 'p/a' },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.equal(parseFailures('go', logged).timedOut, false);
  assert.equal(parseFailures('vitest', ' FAIL  x\n⎯ Failed Tests 1 ⎯\n FAIL  src/a.test.ts > panic: test timed out after 1s\n').timedOut, false);
});

test('go: a plain test failure in an otherwise clean package → not unattributed', () => {
  const r = parseFailures('go', fixture('go-quarantine-clean.jsonl'));
  assert.deepEqual(ids(r), [`${QPKG('clean')}.TestFlaky`]);
  assert.equal(r.unattributed, false);
  assert.equal(parseFailures('go', fixture('go-test-failures.jsonl')).unattributed, false);
});

test('go: a test with `run` but no terminal event → unattributed; standard package lines are not', () => {
  const ev = (o) => JSON.stringify({ Package: 'p/a', ...o });
  const base = [
    ev({ Action: 'run', Test: 'TestA' }),
    ev({ Action: 'fail', Test: 'TestA' }),
    ev({ Action: 'output', Output: 'FAIL\n' }),
    ev({ Action: 'output', Output: 'coverage: 12.5% of statements\n' }),
    ev({ Action: 'output', Output: 'exit status 1\n' }),
    ev({ Action: 'output', Output: 'FAIL\tp/a\t0.10s\n' }),
    ev({ Action: 'fail' }),
  ];
  assert.equal(parseFailures('go', base.join('\n')).unattributed, false);
  assert.equal(parseFailures('go', [ev({ Action: 'run', Test: 'TestB' }), ...base].join('\n')).unattributed, true);
});

// ── decide ───────────────────────────────────────────────────────────────

const F = [{ id: 'src/a.test.ts > t', file: 'src/a.test.ts', pkg: null }];
const base = { quarantine: new Set(), changedFiles: null };
const run = (first, second = null) => decide({ ...base, first: { failures: [], buildFailed: false, ...first }, second });

test('decide: first attempt passes → exit 0, no retry', () => {
  assert.deepEqual(run({ code: 0 }), { exitCode: 0, retry: false, flaky: [], quarantined: [] });
});

test('decide: first fails with visible failures → retry', () => {
  assert.equal(run({ code: 1, failures: F }).retry, true);
});

test('decide: fails then passes → exit 0, flaky = first ids', () => {
  assert.deepEqual(run({ code: 1, failures: F }, { code: 0, failures: [] }), {
    exitCode: 0,
    retry: true,
    flaky: ['src/a.test.ts > t'],
    quarantined: [],
  });
});

test('decide: fails twice → exit 1', () => {
  const d = run({ code: 1, failures: F }, { code: 1, failures: F });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.flaky, []);
});

test('decide: second attempt killed by a signal → exit 1', () => {
  assert.equal(run({ code: 1, failures: F }, { code: null, failures: [] }).exitCode, 1);
});

test('decide: exit 2 with no parsed failures → exit 2, no retry (Review Focus 1)', () => {
  assert.deepEqual(run({ code: 2 }), { exitCode: 2, retry: false, flaky: [], quarantined: [] });
});

test('decide: signal-killed first attempt → exit 1, no retry', () => {
  assert.deepEqual(run({ code: null, failures: F }), { exitCode: 1, retry: false, flaky: [], quarantined: [] });
});

test('decide: data race on attempt 1 → exit first code, never retried', () => {
  assert.deepEqual(run({ code: 1, failures: F, raceDetected: true }), {
    exitCode: 1,
    retry: false,
    flaky: [],
    quarantined: [],
  });
});

test('decide: a go -timeout on attempt 1 → exit first code, never retried', () => {
  assert.deepEqual(run({ code: 1, failures: F, timedOut: true }), {
    exitCode: 1,
    retry: false,
    flaky: [],
    quarantined: [],
  });
});

test('decide: build failure → first code, no retry', () => {
  assert.deepEqual(run({ code: 1, failures: F, buildFailed: true }), {
    exitCode: 1,
    retry: false,
    flaky: [],
    quarantined: [],
  });
});

// ── decide: quarantine (Task 3) ──────────────────────────────────────────
// A quarantined test may fail both attempts only when the PR touched neither
// it nor its sibling source, and only when the changed-file list is known.

const QF = { id: 'src/services/foo.test.ts > foo > flaky', file: 'src/services/foo.test.ts', pkg: null };
const OTHER = { id: 'src/services/bar.test.ts > bar > real', file: 'src/services/bar.test.ts', pkg: null };
const Q = new Set([QF.id]);
const API_PATHS = { prefix: 'apps/api/' };
const twice = (failures, ctx, second = {}) =>
  decide({
    first: { code: 1, failures, buildFailed: false, raceDetected: false },
    second: { code: 1, failures, buildFailed: false, raceDetected: false, ...second },
    paths: API_PATHS,
    ...ctx,
  });

test('decide: quarantined test fails twice, its file untouched → exit 0, quarantined=[id]', () => {
  assert.deepEqual(twice([QF], { quarantine: Q, changedFiles: new Set(['apps/api/src/other.ts']) }), {
    exitCode: 0,
    retry: true,
    flaky: [],
    quarantined: [QF.id],
  });
});

test('decide: quarantined test whose file the PR touched → exit 1 (Review Focus 3)', () => {
  const d = twice([QF], { quarantine: Q, changedFiles: new Set(['apps/api/src/services/foo.test.ts']) });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.quarantined, []);
});

test('decide: quarantined test whose sibling source the PR touched → exit 1', () => {
  assert.equal(twice([QF], { quarantine: Q, changedFiles: new Set(['apps/api/src/services/foo.ts']) }).exitCode, 1);
});

test('decide: changedFiles unknown (null) → no quarantine, exit 1 (Review Focus 4)', () => {
  const d = twice([QF], { quarantine: Q, changedFiles: null });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.quarantined, []);
});

test('decide: quarantined + one non-quarantined failure → exit 1', () => {
  const d = twice([QF, OTHER], { quarantine: Q, changedFiles: new Set() });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.quarantined, []);
});

test('decide: quarantine never applies without a real failing second attempt', () => {
  // Second attempt: signal-killed, build failure, data race, unattributed
  // failure (e.g. vitest Unhandled Errors), or no parsed failures.
  for (const second of [
    { code: null },
    { buildFailed: true },
    { raceDetected: true },
    { unattributed: true },
    { failures: [] },
  ]) {
    const d = twice([QF], { quarantine: Q, changedFiles: new Set() }, second);
    assert.notEqual(d.exitCode, 0, JSON.stringify(second));
    assert.deepEqual(d.quarantined, [], JSON.stringify(second));
  }
});

test('decide: quarantine never stops a no-retry first attempt from failing', () => {
  for (const first of [{ buildFailed: true }, { raceDetected: true }, { timedOut: true }, { code: null }]) {
    const d = decide({
      first: { code: 1, failures: [QF], buildFailed: false, raceDetected: false, ...first },
      second: null,
      quarantine: Q,
      changedFiles: new Set(),
      paths: API_PATHS,
    });
    assert.deepEqual({ retry: d.retry, quarantined: d.quarantined }, { retry: false, quarantined: [] });
    assert.notEqual(d.exitCode, 0);
  }
});

test('decide (go): a quarantined top-level test covers its failing subtest; a package failure never', () => {
  const pkg = `${AGENT}/internal/x`;
  const sub = { id: `${pkg}.TestX/sub`, file: null, pkg };
  const paths = { goModule: AGENT, goDir: 'agent' };
  const go = (failures, changedFiles) =>
    decide({
      first: { code: 1, failures, buildFailed: false, raceDetected: false },
      second: { code: 1, failures, buildFailed: false, raceDetected: false },
      quarantine: new Set([`${pkg}.TestX`, pkg]),
      changedFiles,
      paths,
    });
  assert.deepEqual(go([sub], new Set(['apps/api/x.ts'])).quarantined, [sub.id]);
  assert.equal(go([sub], new Set(['agent/internal/x/x.go'])).exitCode, 1);
  assert.equal(go([{ id: pkg, file: null, pkg }], new Set()).exitCode, 1);
});

const goFixtureVerdict = (name) => {
  const r = parseFailures('go', fixture(`go-quarantine-${name}.jsonl`));
  const attempt = { code: 1, ...r };
  return decide({
    first: attempt,
    second: attempt,
    quarantine: new Set([`${QPKG(name)}.TestFlaky`]),
    changedFiles: new Set(['README.md']),
    paths: { goModule: AGENT, goDir: 'agent' },
  });
};

test('decide (go fixtures): quarantined TestFlaky panics / TestMain fails / timeout → non-zero', () => {
  for (const name of ['panic', 'main', 'timeout']) {
    const d = goFixtureVerdict(name);
    assert.notEqual(d.exitCode, 0, name);
    assert.deepEqual(d.quarantined, [], name);
  }
});

test('decide (go fixtures): plain quarantined failure in a clean package → still excused', () => {
  assert.deepEqual(goFixtureVerdict('clean'), {
    exitCode: 0,
    retry: true,
    flaky: [],
    quarantined: [`${QPKG('clean')}.TestFlaky`],
  });
});

test('decide: an unattributed FIRST attempt also refuses quarantine (retry still happens)', () => {
  const first = { code: 1, failures: [QF], buildFailed: false, raceDetected: false, unattributed: true };
  assert.equal(decide({ first, second: null, quarantine: Q, changedFiles: new Set(), paths: API_PATHS }).retry, true);
  const d = decide({ first, second: { ...first, unattributed: false }, quarantine: Q, changedFiles: new Set(), paths: API_PATHS });
  assert.equal(d.exitCode, 1);
  assert.deepEqual(d.quarantined, []);
});

test('decide: a quarantined verdict keeps first-attempt flaky ids (failed once, passed on retry)', () => {
  const d = decide({
    first: { code: 1, failures: [QF, OTHER], buildFailed: false, raceDetected: false },
    second: { code: 1, failures: [QF], buildFailed: false, raceDetected: false },
    quarantine: Q,
    changedFiles: new Set(),
    paths: API_PATHS,
  });
  assert.deepEqual(d, { exitCode: 0, retry: true, flaky: [OTHER.id], quarantined: [QF.id] });
});

// ── Retry budget ─────────────────────────────────────────────────────────
// `--budget-minutes N` = the job's timeout minus its setup allowance. A retry
// is skipped when a second attempt as long as the first would not fit in what
// is left of N; a job timeout reports `cancelled` and hides the real failure.

const MIN = 60_000;

test('budgetSkipReason: no budget → never skips', () => {
  assert.equal(budgetSkipReason({ budgetMinutes: null, elapsedMs: 500 * MIN, attemptMs: 400 * MIN }), null);
});

test('budgetSkipReason: a second attempt that fits → null', () => {
  // 50-min budget, attempt 1 took 20 min, 21 min elapsed → 29 left ≥ 20.
  assert.equal(budgetSkipReason({ budgetMinutes: 50, elapsedMs: 21 * MIN, attemptMs: 20 * MIN }), null);
  // Exactly fits.
  assert.equal(budgetSkipReason({ budgetMinutes: 50, elapsedMs: 25 * MIN, attemptMs: 25 * MIN }), null);
});

test('budgetSkipReason: a second attempt that would overrun → reason naming the numbers', () => {
  // 35-min budget, attempt 1 took 18 min, 18.5 elapsed → 16.5 left < 18.
  const why = budgetSkipReason({ budgetMinutes: 35, elapsedMs: 18.5 * MIN, attemptMs: 18 * MIN });
  assert.equal(typeof why, 'string');
  assert.match(why, /18\.0 min/);
  assert.match(why, /16\.5 min/);
  assert.match(why, /35-min/);
  // Elapsed past the budget already.
  assert.notEqual(budgetSkipReason({ budgetMinutes: 10, elapsedMs: 12 * MIN, attemptMs: 1 * MIN }), null);
});

// ── Go retry command ─────────────────────────────────────────────────────

test('goRetryCommand: same flags and packages, plus -count=1 so the test cache cannot replay passes', () => {
  assert.deepEqual(
    goRetryCommand(['go', 'test', '-json', '-v', '-coverprofile=coverage.out', './...']),
    ['go', 'test', '-count=1', '-json', '-v', '-coverprofile=coverage.out', './...'],
  );
  // A command's own later -count still wins, and -args stays last.
  assert.deepEqual(
    goRetryCommand(['go', 'test', '-json', '-race', '-count=1', '-timeout', '20m', './...', '-args', '-flag']),
    ['go', 'test', '-count=1', '-json', '-race', '-count=1', '-timeout', '20m', './...', '-args', '-flag'],
  );
});

// ── CLI ──────────────────────────────────────────────────────────────────

function cli(args, { cwd, env = {} }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(cwd, 'summary.md'), ...env },
  });
}

// Fails attempt 1 with a vitest-shaped summary, passes attempt 2.
const FLAKY_VITEST = `
const fs = require('fs');
const n = Number(fs.existsSync('count') ? fs.readFileSync('count', 'utf8') : 0) + 1;
fs.writeFileSync('count', String(n));
if (n === 1) {
  console.log('\\n⎯⎯⎯ Failed Tests 1 ⎯⎯⎯\\n\\n FAIL  src/a.test.ts > suite > flaky one\\n');
  process.exit(Number(process.env.N ?? 1));
}
`;

test('CLI vitest: fail then pass → exit 0, report attempts 2, flaky warning, step summary', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const r = cli(['--runner', 'vitest', '--label', 'api-3', '--', process.execPath, '-e', FLAKY_VITEST], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(cwd, 'count'), 'utf8'), '2');
  const report = JSON.parse(readFileSync(join(cwd, 'flake-report-api-3.json'), 'utf8'));
  assert.deepEqual(report, {
    label: 'api-3',
    attempts: 2,
    flaky: ['src/a.test.ts > suite > flaky one'],
    quarantined: [],
    exitCode: 0,
  });
  assert.match(r.stdout, /^::warning title=Flaky test::src\/a\.test\.ts > suite > flaky one$/m);
  // The child's own output still reaches the log.
  assert.match(r.stdout, / FAIL {2}src\/a\.test\.ts > suite > flaky one/);
  assert.match(readFileSync(join(cwd, 'summary.md'), 'utf8'), /\| api-3 \| 2 \|/);
});

test('CLI vitest: exit 2 with nothing parsed → runs once, exit 2, no flake (Review Focus 1)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const script = `const fs=require('fs');fs.appendFileSync('count','x');console.error('DB not ready');process.exit(2)`;
  const r = cli(['--runner', 'vitest', '--label', 'integration-1', '--', process.execPath, '-e', script], { cwd });
  assert.equal(r.status, 2);
  assert.equal(readFileSync(join(cwd, 'count'), 'utf8'), 'x');
  const report = JSON.parse(readFileSync(join(cwd, 'flake-report-integration-1.json'), 'utf8'));
  assert.deepEqual(report.flaky, []);
  assert.equal(report.attempts, 1);
  assert.equal(report.exitCode, 2);
  assert.doesNotMatch(r.stdout, /Flaky test/);
});

test('CLI vitest: clean first pass → exit 0 and no report file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const r = cli(['--runner', 'vitest', '--label', 'web-1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd });
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(cwd, 'flake-report-web-1.json')), false);
});

test('CLI vitest: fails twice → exit 1, report attempts 2, nothing flaky', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const script = `console.log('⎯ Failed Tests 1 ⎯\\n FAIL  src/a.test.ts > real break');process.exit(1)`;
  const r = cli(['--runner', 'vitest', '--label', 'api-1', '--', process.execPath, '-e', script], { cwd });
  assert.equal(r.status, 1);
  const report = JSON.parse(readFileSync(join(cwd, 'flake-report-api-1.json'), 'utf8'));
  assert.deepEqual(report, { label: 'api-1', attempts: 2, flaky: [], quarantined: [], exitCode: 1 });
});

// A fake `go` on PATH: records argv, emits -json events, writes a coverprofile.
const FAKE_GO = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('go-calls.json', JSON.stringify(args) + '\\n');
const n = fs.readFileSync('go-calls.json', 'utf8').trim().split('\\n').length;
const cov = (args.find((a) => a.startsWith('-coverprofile=')) || '').slice('-coverprofile='.length);
const ev = (o) => console.log(JSON.stringify(o));
if (n === 1) {
  ev({ Action: 'output', Package: 'p/a', Test: 'TestA', Output: '--- PASS: TestA (0.00s)\\n' });
  ev({ Action: 'pass', Package: 'p/a', Test: 'TestA' });
  ev({ Action: 'pass', Package: 'p/a' });
  ev({ Action: 'output', Package: 'p/b', Test: 'TestB', Output: '--- FAIL: TestB (0.01s)\\n' });
  ev({ Action: 'fail', Package: 'p/b', Test: 'TestB' });
  ev({ Action: 'fail', Package: 'p/b' });
  fs.writeFileSync(cov, 'mode: set\\np/a/a.go:1.1,2.2 1 1\\np/b/b.go:1.1,2.2 1 0\\n');
  process.exit(1);
}
ev({ Action: 'pass', Package: 'p/a', Test: 'TestA' });
ev({ Action: 'pass', Package: 'p/a' });
ev({ Action: 'output', Package: 'p/b', Test: 'TestB', Output: '--- PASS: TestB (0.01s)\\n' });
ev({ Action: 'pass', Package: 'p/b', Test: 'TestB' });
ev({ Action: 'pass', Package: 'p/b' });
fs.writeFileSync(cov, 'mode: set\\np/a/a.go:1.1,2.2 1 1\\np/b/b.go:1.1,2.2 1 1\\n');
`;

test('CLI go: adds -json, re-prints Output, retries the whole shard uncached, keeps its coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  writeFileSync(join(bin, 'go'), FAKE_GO);
  chmodSync(join(bin, 'go'), 0o755);
  const godir = join(root, 'agent');
  spawnSync('mkdir', [godir]);
  const r = cli(
    ['--runner', 'go', '--go-dir', 'agent', '--label', 'agent', '--', 'go', 'test', '-v', '-coverprofile=coverage.out', './...'],
    { cwd: root, env: { PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(join(godir, 'go-calls.json'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls, [
    ['test', '-json', '-v', '-coverprofile=coverage.out', './...'],
    ['test', '-count=1', '-json', '-v', '-coverprofile=coverage.out', './...'],
  ]);
  assert.equal(readFileSync(join(godir, 'coverage.out'), 'utf8'), 'mode: set\np/a/a.go:1.1,2.2 1 1\np/b/b.go:1.1,2.2 1 1\n');
  // Human-readable output, not raw JSON.
  assert.match(r.stdout, /^--- FAIL: TestB \(0\.01s\)$/m);
  assert.doesNotMatch(r.stdout, /"Action"/);
  assert.match(r.stdout, /^::warning title=Flaky test::p\/b\.TestB$/m);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-agent.json'), 'utf8'));
  assert.deepEqual(report, { label: 'agent', attempts: 2, flaky: ['p/b.TestB'], quarantined: [], exitCode: 0 });
});

// A failure that needs the other packages running beside it: TestB fails only
// when the whole shard really executes. Narrowing to p/b, or re-running with
// the test cache replaying p/a, removes the contention and would turn it green.
const FAKE_GO_CONTENTION = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('go-calls.json', JSON.stringify(args) + '\\n');
const first = fs.readFileSync('go-calls.json', 'utf8').trim().split('\\n').length === 1;
const contended = first || (args.includes('./...') && args.includes('-count=1'));
const ev = (o) => console.log(JSON.stringify(o));
if (args.includes('./...')) {
  ev({ Action: 'pass', Package: 'p/a', Test: 'TestA' });
  ev({ Action: 'pass', Package: 'p/a' });
}
ev({ Action: contended ? 'fail' : 'pass', Package: 'p/b', Test: 'TestB' });
ev({ Action: contended ? 'fail' : 'pass', Package: 'p/b' });
process.exit(contended ? 1 : 0);
`;

test('CLI go: a failure that reproduces on every full-shard run stays red', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  writeFileSync(join(bin, 'go'), FAKE_GO_CONTENTION);
  chmodSync(join(bin, 'go'), 0o755);
  const r = cli(['--runner', 'go', '--label', 'agent', '--', 'go', 'test', './...'], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /Flaky test/);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-agent.json'), 'utf8'));
  assert.deepEqual(report, { label: 'agent', attempts: 2, flaky: [], quarantined: [], exitCode: 1 });
});

test('CLI go: a data race fails the job on attempt 1 with an ::error annotation, no retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  writeFileSync(
    join(bin, 'go'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync('go-calls', 'x');\nprocess.stdout.write(${JSON.stringify(fixture('go-race.jsonl'))});\nprocess.exit(1);\n`,
  );
  chmodSync(join(bin, 'go'), 0o755);
  const r = cli(['--runner', 'go', '--label', 'agent-race', '--', 'go', 'test', '-race', './...'], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(root, 'go-calls'), 'utf8'), 'x', 'must not retry');
  assert.match(r.stdout, /^::error title=Data race::/m);
  assert.doesNotMatch(r.stdout, /Flaky test|Retrying test shard/);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-agent-race.json'), 'utf8'));
  assert.deepEqual(report, { label: 'agent-race', attempts: 1, flaky: [], quarantined: [], exitCode: 1 });
});

test('CLI go: interleaved -json events print as one block per package, like plain go test', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  const events = [
    { Action: 'output', Package: 'p/a', Output: '=== RUN   TestA\n' },
    { Action: 'output', Package: 'p/b', Output: '=== RUN   TestB\n' },
    { Action: 'output', Package: 'p/a', Output: 'ok  \tp/a\n' },
    { Action: 'pass', Package: 'p/a' },
    { Action: 'output', Package: 'p/b', Output: 'ok  \tp/b\n' },
    { Action: 'pass', Package: 'p/b' },
  ];
  writeFileSync(join(bin, 'go'), `#!/usr/bin/env node\n${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n')}\n`);
  chmodSync(join(bin, 'go'), 0o755);
  const r = cli(['--runner', 'go', '--label', 'agent-race', '--', 'go', 'test', './...'], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '=== RUN   TestA\nok  \tp/a\n=== RUN   TestB\nok  \tp/b\n');
});

test('CLI: rejects a missing --label or a non-`go test` command for the go runner', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  assert.equal(cli(['--runner', 'vitest', '--', 'true'], { cwd }).status, 2);
  assert.equal(cli(['--runner', 'go', '--label', 'x', '--', 'gofmt', '-l', '.'], { cwd }).status, 2);
});

test('CLI: rejects a --budget-minutes that is not a positive number', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  for (const v of ['0', '-5', 'abc', '']) {
    assert.equal(cli(['--runner', 'vitest', '--label', 'x', '--budget-minutes', v, '--', 'true'], { cwd }).status, 2, v);
  }
});

test('CLI go: a package that hit -timeout fails on attempt 1 with an ::error annotation, no retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  writeFileSync(
    join(bin, 'go'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync('go-calls', 'x');\nprocess.stdout.write(${JSON.stringify(fixture('go-quarantine-timeout.jsonl'))});\nprocess.exit(1);\n`,
  );
  chmodSync(join(bin, 'go'), 0o755);
  const r = cli(['--runner', 'go', '--label', 'agent-race', '--', 'go', 'test', '-race', '-timeout', '20m', './...'], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(root, 'go-calls'), 'utf8'), 'x', 'must not retry');
  assert.match(r.stdout, /^::error title=Test timeout::agent-race: /m);
  assert.doesNotMatch(r.stdout, /Flaky test|Retrying test shard/);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-agent-race.json'), 'utf8'));
  assert.deepEqual(report, { label: 'agent-race', attempts: 1, flaky: [], quarantined: [], exitCode: 1 });
});

// The clock is real here but needs no sleep: a node child takes far longer
// than 0.0001 min (6 ms) to start, so attempt 1 alone overruns that budget,
// while 600 min always leaves room.
test('CLI vitest: a retry that would overrun --budget-minutes is skipped (::error, attempt 1 stands)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const r = cli(['--runner', 'vitest', '--label', 'api-4', '--budget-minutes', '0.0001', '--', process.execPath, '-e', FLAKY_VITEST], { cwd });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(cwd, 'count'), 'utf8'), '1', 'must not retry');
  assert.match(r.stdout, /^::error title=Retry skipped::api-4: /m);
  assert.doesNotMatch(r.stdout, /Flaky test|Retrying test shard/);
  const report = JSON.parse(readFileSync(join(cwd, 'flake-report-api-4.json'), 'utf8'));
  assert.deepEqual(report, { label: 'api-4', attempts: 1, flaky: [], quarantined: [], exitCode: 1 });
});

test('CLI vitest: a retry that fits --budget-minutes runs as usual', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retry-shard-'));
  const r = cli(['--runner', 'vitest', '--label', 'api-4', '--budget-minutes', '600', '--', process.execPath, '-e', FLAKY_VITEST], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(cwd, 'count'), 'utf8'), '2');
  assert.doesNotMatch(r.stdout, /Retry skipped/);
});

// ── CLI: flaky ledger (Task 3) ───────────────────────────────────────────

test('ledgerRunner: --runner + --label prefix → ledger runner; anything else → null (no quarantine)', () => {
  assert.equal(ledgerRunner('vitest', 'api-3'), 'vitest-api');
  assert.equal(ledgerRunner('vitest', 'web-1'), 'vitest-web');
  assert.equal(ledgerRunner('vitest', 'integration-16'), 'vitest-integration');
  assert.equal(ledgerRunner('go', 'agent'), 'go');
  assert.equal(ledgerRunner('go', 'agent-race'), 'go');
  assert.equal(ledgerRunner('vitest', 'portal-1'), null);
  assert.equal(ledgerRunner('vitest', 'apix-1'), null);
});

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// A repo whose BASE commit quarantines `entries`; HEAD then touches `touched`.
function ledgerRepo(entries, touched) {
  const root = mkdtempSync(join(tmpdir(), 'retry-shard-ledger-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'ci@example.com');
  git(root, 'config', 'user.name', 'ci');
  spawnSync('mkdir', ['-p', join(root, '.github'), join(root, 'agent/internal/x'), join(root, 'apps/api/src')]);
  writeFileSync(join(root, '.github/flaky-tests.json'), JSON.stringify(entries));
  writeFileSync(join(root, 'agent/go.mod'), 'module github.com/breeze-rmm/agent\n\ngo 1.25\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  for (const f of touched) writeFileSync(join(root, f), 'changed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'head');
  return { root, baseSha };
}

const vitestEntry = {
  id: 'src/a.test.ts > suite > flaky one',
  runner: 'vitest-api',
  file: 'apps/api/src/a.test.ts',
  issue: 10744,
  added: today(),
  expires: plusDays(7),
};
const ALWAYS_FAILS = `console.log('⎯ Failed Tests 1 ⎯\\n FAIL  src/a.test.ts > suite > flaky one');process.exit(1)`;

test('CLI vitest: a base-ledger test failing twice, untouched → exit 0, quarantined in report + annotation', () => {
  const { root, baseSha } = ledgerRepo([vitestEntry], ['README.md']);
  const r = cli(['--runner', 'vitest', '--label', 'api-2', '--', process.execPath, '-e', ALWAYS_FAILS], {
    cwd: root,
    env: { CI_BASE_SHA: baseSha },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-api-2.json'), 'utf8'));
  assert.deepEqual(report, { label: 'api-2', attempts: 2, flaky: [], quarantined: [vitestEntry.id], exitCode: 0 });
  assert.match(r.stdout, /^::warning title=Quarantined test::src\/a\.test\.ts > suite > flaky one$/m);
});

test('CLI vitest: the PR touched the sibling source → exit 1', () => {
  const { root, baseSha } = ledgerRepo([vitestEntry], ['apps/api/src/a.ts']);
  const r = cli(['--runner', 'vitest', '--label', 'api-2', '--', process.execPath, '-e', ALWAYS_FAILS], {
    cwd: root,
    env: { CI_BASE_SHA: baseSha },
  });
  assert.equal(r.status, 1);
});

test('CLI vitest: no CI_BASE_SHA → no quarantine, exit 1', () => {
  const { root } = ledgerRepo([vitestEntry], ['README.md']);
  const r = cli(['--runner', 'vitest', '--label', 'api-2', '--', process.execPath, '-e', ALWAYS_FAILS], {
    cwd: root,
    env: { CI_BASE_SHA: '' },
  });
  assert.equal(r.status, 1);
});

test('CLI vitest: quarantined failure + Unhandled Errors reaches decide() as unattributed → exit 1', () => {
  const { root, baseSha } = ledgerRepo([vitestEntry], ['README.md']);
  const script = `console.log('⎯ Failed Tests 1 ⎯\\n FAIL  src/a.test.ts > suite > flaky one\\n\\n⎯⎯ Unhandled Errors ⎯⎯\\nError: leaked');process.exit(1)`;
  const r = cli(['--runner', 'vitest', '--label', 'api-2', '--', process.execPath, '-e', script], {
    cwd: root,
    env: { CI_BASE_SHA: baseSha },
  });
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'flake-report-api-2.json'), 'utf8')).quarantined, []);
});

test('CLI vitest: a ledger entry added only on HEAD is ignored → exit 1', () => {
  const { root, baseSha } = ledgerRepo([], ['README.md']);
  writeFileSync(join(root, '.github/flaky-tests.json'), JSON.stringify([vitestEntry]));
  git(root, 'commit', '-q', '-am', 'head quarantines its own failure');
  const r = cli(['--runner', 'vitest', '--label', 'api-2', '--', process.execPath, '-e', ALWAYS_FAILS], {
    cwd: root,
    env: { CI_BASE_SHA: baseSha },
  });
  assert.equal(r.status, 1);
});

test('CLI vitest: a ledger entry for another runner does not apply (web label) → exit 1', () => {
  const { root, baseSha } = ledgerRepo([vitestEntry], ['README.md']);
  const r = cli(['--runner', 'vitest', '--label', 'web-2', '--', process.execPath, '-e', ALWAYS_FAILS], {
    cwd: root,
    env: { CI_BASE_SHA: baseSha },
  });
  assert.equal(r.status, 1);
});

test('CLI go: a quarantined test failing twice in an untouched package → exit 0; module path from go.mod', () => {
  const pkg = `${AGENT}/internal/x`;
  const goEntry = { ...vitestEntry, id: `${pkg}.TestFlaky`, runner: 'go', file: 'agent/internal/x/x_test.go' };
  const { root, baseSha } = ledgerRepo([goEntry], ['README.md']);
  const bin = mkdtempSync(join(tmpdir(), 'retry-shard-bin-'));
  const events = [
    { Action: 'output', Package: pkg, Test: 'TestFlaky', Output: '--- FAIL: TestFlaky (0.01s)\n' },
    { Action: 'fail', Package: pkg, Test: 'TestFlaky' },
    { Action: 'fail', Package: pkg },
  ];
  writeFileSync(join(bin, 'go'), `#!/usr/bin/env node\n${events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join('\n')}\nprocess.exit(1);\n`);
  chmodSync(join(bin, 'go'), 0o755);
  const args = ['--runner', 'go', '--go-dir', 'agent', '--label', 'agent', '--', 'go', 'test', './...'];
  const env = { PATH: `${bin}:${process.env.PATH}`, CI_BASE_SHA: baseSha };
  const r = cli(args, { cwd: root, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'flake-report-agent.json'), 'utf8')).quarantined, [`${pkg}.TestFlaky`]);

  writeFileSync(join(root, 'agent/internal/x/x.go'), 'package x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'touch the package');
  assert.equal(cli(args, { cwd: root, env }).status, 1);
});

// ── ci.yml wiring ────────────────────────────────────────────────────────
// Every wrapped job states its timeout, passes `--budget-minutes` = timeout −
// SETUP_ALLOWANCE, and has room for two attempts at the slowest measured step.
// SETUP_ALLOWANCE covers the steps before and after the wrapped one: measured
// at most 1.3 min before and 1.4 min after (test-api / integration shard 1,
// six CI runs 2026-10-29..30); 5 leaves room for a cold pnpm/Go cache.
// MAX_STEP_MIN is the slowest successful wrapped step in those runs.

const SETUP_ALLOWANCE = 5;
const MAX_STEP_MIN = {
  'test-api': 11.7,
  'test-web': 11.9,
  'test-agent': 5.9,
  'test-agent-race': 19.2,
  'integration-test': 24.3,
};
const ciYml = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
function ciJobs() {
  const out = new Map();
  let cur = null;
  for (const line of ciYml.slice(ciYml.search(/^jobs:\s*$/m)).split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) out.set((cur = m[1]), []);
    else if (/^\S/.test(line)) cur = null;
    else if (cur) out.get(cur).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n')]));
}

test('ci.yml: every retry-shard job has a timeout and passes --budget-minutes = timeout − allowance', () => {
  const wrapped = [...ciJobs()].filter(([, body]) => /^\s+run: .*retry-shard\.mjs /m.test(body));
  assert.deepEqual(wrapped.map(([name]) => name).sort(), Object.keys(MAX_STEP_MIN).sort());
  for (const [name, body] of wrapped) {
    const t = /^ {4}timeout-minutes: (\d+)$/m.exec(body);
    assert.ok(t, `${name} has no job-level timeout-minutes`);
    const timeout = Number(t[1]);
    const runs = [...body.matchAll(/^\s+run: .*retry-shard\.mjs (.*)$/gm)];
    assert.equal(runs.length, 1, name);
    assert.match(runs[0][1], new RegExp(`--budget-minutes ${timeout - SETUP_ALLOWANCE} `), `${name}: budget must be ${timeout} − ${SETUP_ALLOWANCE}`);
    const need = 2 * MAX_STEP_MIN[name] + SETUP_ALLOWANCE;
    assert.ok(timeout >= need, `${name}: timeout ${timeout} < 2 × ${MAX_STEP_MIN[name]} + ${SETUP_ALLOWANCE} — a retry cannot fit`);
  }
});

test('ci.yml: every flake-report upload overwrites (a "re-run failed jobs" attempt reuses the name)', () => {
  const uploads = ciYml.split(/\n(?= {6}- )/).filter((s) => /^\s+name: flake-report-/m.test(s));
  assert.equal(uploads.length, 5);
  for (const s of uploads) {
    assert.match(s, /uses: actions\/upload-artifact@/);
    assert.match(s, /^\s+overwrite: true$/m, s);
  }
});
