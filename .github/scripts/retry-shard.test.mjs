import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decide, goRetryArgs, mergeCoverProfiles, parseFailures } from './retry-shard.mjs';

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

test('vitest: no summary section → no failures (setup/infra failure)', () => {
  const r = parseFailures('vitest', 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n FAIL  this is console noise\n');
  assert.deepEqual(r, { failures: [], buildFailed: false, raceDetected: false });
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

test('decide: build failure → first code, no retry', () => {
  assert.deepEqual(run({ code: 1, failures: F, buildFailed: true }), {
    exitCode: 1,
    retry: false,
    flaky: [],
    quarantined: [],
  });
});

// ── Go retry command + coverage merge ────────────────────────────────────

test('goRetryArgs: keeps flags, swaps packages for the failed ones, rewrites -coverprofile', () => {
  assert.deepEqual(
    goRetryArgs(['test', '-json', '-v', '-coverprofile=coverage.out', './...'], ['p/b', 'p/c']),
    { args: ['test', '-json', '-v', '-coverprofile=coverage.out.retry', 'p/b', 'p/c'], coverProfile: 'coverage.out' },
  );
  assert.deepEqual(
    goRetryArgs(['test', '-json', '-race', '-count=1', '-timeout', '20m', './...'], ['p/b']),
    { args: ['test', '-json', '-race', '-count=1', '-timeout', '20m', 'p/b'], coverProfile: null },
  );
  assert.deepEqual(
    goRetryArgs(['test', '-json', '-coverprofile', 'c.out', '-run', '^TestX$', './internal/...', '-args', '-flag'], ['p/b']),
    { args: ['test', '-json', '-coverprofile', 'c.out.retry', '-run', '^TestX$', 'p/b', '-args', '-flag'], coverProfile: 'c.out' },
  );
});

test('mergeCoverProfiles: base A,B + retry B → A original, B retry, one mode header', () => {
  const baseProfile = [
    'mode: set',
    'github.com/x/agent/a/a.go:3.10,5.2 1 1',
    'github.com/x/agent/b/b.go:3.10,5.2 1 0',
    'github.com/x/agent/b/b.go:7.10,9.2 1 0',
    'github.com/x/agent/ab/ab.go:1.1,2.2 1 1',
    '',
  ].join('\n');
  const retryProfile = ['mode: set', 'github.com/x/agent/b/b.go:3.10,5.2 1 1', 'github.com/x/agent/b/b.go:7.10,9.2 1 1', ''].join('\n');
  const merged = mergeCoverProfiles(baseProfile, retryProfile);
  assert.equal(
    merged,
    [
      'mode: set',
      'github.com/x/agent/a/a.go:3.10,5.2 1 1',
      'github.com/x/agent/ab/ab.go:1.1,2.2 1 1',
      'github.com/x/agent/b/b.go:3.10,5.2 1 1',
      'github.com/x/agent/b/b.go:7.10,9.2 1 1',
      '',
    ].join('\n'),
  );
  assert.equal(merged.match(/^mode:/gm).length, 1);
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
ev({ Action: 'output', Package: 'p/b', Test: 'TestB', Output: '--- PASS: TestB (0.01s)\\n' });
ev({ Action: 'pass', Package: 'p/b', Test: 'TestB' });
ev({ Action: 'pass', Package: 'p/b' });
fs.writeFileSync(cov, 'mode: set\\np/b/b.go:1.1,2.2 1 1\\n');
`;

test('CLI go: adds -json, re-prints Output, retries only failed packages, merges coverage', () => {
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
    ['test', '-json', '-v', '-coverprofile=coverage.out.retry', 'p/b'],
  ]);
  assert.equal(readFileSync(join(godir, 'coverage.out'), 'utf8'), 'mode: set\np/a/a.go:1.1,2.2 1 1\np/b/b.go:1.1,2.2 1 1\n');
  assert.equal(existsSync(join(godir, 'coverage.out.retry')), false);
  // Human-readable output, not raw JSON.
  assert.match(r.stdout, /^--- FAIL: TestB \(0\.01s\)$/m);
  assert.doesNotMatch(r.stdout, /"Action"/);
  assert.match(r.stdout, /^::warning title=Flaky test::p\/b\.TestB$/m);
  const report = JSON.parse(readFileSync(join(root, 'flake-report-agent.json'), 'utf8'));
  assert.deepEqual(report, { label: 'agent', attempts: 2, flaky: ['p/b.TestB'], quarantined: [], exitCode: 0 });
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
