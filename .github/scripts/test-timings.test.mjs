// W07a (#10751): the integration timing table is rebuilt from CI job logs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TimingLogError, buildTable, parseJobLog, refresh, shardOverhead, serializeTable, writeTable } from './test-timings.mjs';
import { loadTimings } from './shard-partition.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const FIXTURES = join(REPO_ROOT, '.github/scripts/fixtures/test-timings');
// A real shard-2 job log from merge-group run 42519693144 (2026-11-08), raw
// API format with its ANSI colour codes, trimmed to its first four files.
const realLog = readFileSync(join(FIXTURES, 'shard-2-job-log.txt'), 'utf8');

const P = 'apps/api/src/__tests__/integration/';
const REAL = {
  // First file: reported 68.664 s plus the median per-file overhead of the
  // other three (wall − reported: 7.661, 4.560, 3.942 → 4.560). Its own wall
  // span would also count globalSetup's migrations.
  [`${P}wispGrantsRls.integration.test.ts`]: 73.2,
  // The rest: wall clock between consecutive file-completion lines, which
  // counts import and setup time the reporter's own duration leaves out.
  [`${P}aiOperatorIdentityOnboardingGate.integration.test.ts`]: 56.8,
  'apps/api/src/services/autopay/enrollmentService.integration.test.ts': 34.2,
  [`${P}remoteDesktopTerminalIntent.integration.test.ts`]: 56.0,
};

test('parses a real job log: wall-clock seconds per file, repo-relative keys', () => {
  assert.deepEqual(parseJobLog(realLog), { files: REAL, count: 4 });
});

test('parses the `gh run view --log` format (job and step prefixes, caret-escaped colours)', () => {
  const prefixed = realLog.split('\n').map(l => (l ? `Integration Tests (shard 2/16)\tUNKNOWN STEP\t${l}` : l)).join('\n')
    .replace(/\x1b/g, '^[');
  assert.match(prefixed, /\^\[\[32m✓/);
  assert.deepEqual(parseJobLog(prefixed), { files: REAL, count: 4 });
});

// Shard 1's real job log, trimmed to its step markers and two files per vitest
// step: it runs FOUR vitest sessions (integration, ee workspace, request-db-role,
// rls-coverage), and only the sharded integration step's files belong in the table.
const shard1Log = readFileSync(join(FIXTURES, 'shard-1-job-log.txt'), 'utf8');

test('reads only the sharded integration step of a job with several vitest steps', () => {
  assert.equal((shard1Log.replace(/\x1b\[[0-9;]*m/g, '').match(/Test Files/g) ?? []).length, 4);
  assert.deepEqual(parseJobLog(shard1Log), {
    // reported 50.794 + the other file's overhead (36.979 − 32.775); then the wall span.
    files: { [`${P}flowConversionSwitch.integration.test.ts`]: 55, [`${P}deviceCommandOfflineQueue.integration.test.ts`]: 37 },
    count: 2,
  });
  const noStep = shard1Log.replace(/test:integration --shard=/g, 'test:integration --other=');
  assert.throws(() => parseJobLog(noStep), e => e instanceof TimingLogError && /no `test:integration --shard` step/.test(e.message));
});

test('stdout and slow-test lines that name a file are not file results', () => {
  assert.match(realLog, /stdout.*\| src\/__tests__\/integration\/wispGrantsRls/);
  assert.match(realLog.replace(/\x1b\[[0-9;]*m/g, ''), /Z {5,}✓ /);
  assert.equal(Object.keys(parseJobLog(realLog).files).length, 4);
});

test('a log that does not reconcile with its own summary is rejected', () => {
  const plain = realLog.replace(/\x1b\[[0-9;]*m/g, '');
  // Retried shard: two vitest runs in one step.
  assert.throws(() => parseJobLog(`${realLog}\n${realLog}`), e => e instanceof TimingLogError && /2 vitest summaries/.test(e.message));
  // The parser missed a file (or the reporter format changed).
  assert.throws(() => parseJobLog(plain.replace('Test Files  4 passed (4)', 'Test Files  5 passed (5)')),
    e => e instanceof TimingLogError && /4 file results but the summary counts 5/.test(e.message));
  assert.throws(() => parseJobLog(plain.replace(/ RUN {2}v/, ' XXX  v')), e => e instanceof TimingLogError && /RUN banner/.test(e.message));
  const twice = plain.replace(/(Z  ✓ src\/services\/autopay\/enrollmentService[^\n]*)/, '$1\n2026-11-08T20:25:41.0000000Z  ✓ src/__tests__/integration/wispGrantsRls.integration.test.ts (1 test) 5ms')
    .replace('Test Files  4 passed (4)', 'Test Files  5 passed (5)');
  assert.throws(() => parseJobLog(twice), e => e instanceof TimingLogError && /a file reported twice/.test(e.message));
  const backwards = plain.replace('2026-11-08T20:25:40.0112832Z  ✓ src/services/autopay', '2026-11-08T20:25:00.0000000Z  ✓ src/services/autopay');
  assert.throws(() => parseJobLog(backwards), e => e instanceof TimingLogError && /timestamps go backwards at src\/services\/autopay/.test(e.message));
});

const synth = lines => lines.map(([at, body]) => `2026-11-08T20:${at}Z ${body}`).join('\n');

test('a failed file (❯) is a file result too, so its log still reconciles', () => {
  // Shape from a real retried shard (run 42534887950, shard 4): the failed file's line.
  assert.deepEqual(parseJobLog(synth([['00:00.000', ' RUN  v4.1.12 /r/apps/api'],
    ['00:06.500', ' ❯ src/__tests__/integration/agentCommandRelayShards.integration.test.ts (7 tests | 1 failed) 6082ms'],
    ['00:06.600', '     × a second consumer for a shard another consumer holds refuses to start 1123ms'],
    ['00:07.000', ' Test Files  1 failed (1)']])).files, { 'apps/api/src/__tests__/integration/agentCommandRelayShards.integration.test.ts': 6.1 });
});

test('a one-file shard weighs its reported duration; a skipped file weighs its wall span', () => {
  assert.deepEqual(parseJobLog(synth([['00:00.000', ' RUN  v4.1.12 /r/apps/api'], ['01:00.000', ' ✓ src/a.integration.test.ts (2 tests) 12345ms'],
    ['01:01.000', ' Test Files  1 passed (1)']])), { files: { 'apps/api/src/a.integration.test.ts': 12.3 }, count: 1 });
  assert.deepEqual(parseJobLog(synth([['00:00.000', ' RUN  v4.1.12 /r/apps/api'], ['00:30.000', ' ✓ src/a.integration.test.ts (2 tests) 20000ms'],
    ['00:34.500', ' ↓ src/b.integration.test.ts (3 tests | 3 skipped)'], ['00:40.000', ' ✓ src/c.integration.test.ts (1 test) 5000ms'],
    ['00:41.000', ' Test Files  2 passed | 1 skipped (3)']])).files, {
    // overheads: b 4.5 − 0, c 5.5 − 5 → median (nearest rank, lower) 0.5
    'apps/api/src/a.integration.test.ts': 20.5, 'apps/api/src/b.integration.test.ts': 4.5, 'apps/api/src/c.integration.test.ts': 5.5,
  });
});

const step = (name, conclusion, start, end) => ({ name, conclusion, started_at: start, completed_at: end });
const job = (shard, extra) => ({
  id: shard, name: `Integration Tests (shard ${shard}/3)`, conclusion: 'success',
  steps: [
    step('Run integration tests', 'success', '2026-11-08T20:00:00Z', '2026-11-08T20:20:00Z'),
    step('Boot API once to apply built-in extension migrations (ee)', extra ? 'success' : 'skipped', '2026-11-08T20:20:00Z', extra ? '2026-11-08T20:20:30Z' : '2026-11-08T20:20:00Z'),
    step('Run RLS coverage contract test', extra ? 'success' : 'skipped', '2026-11-08T20:20:30Z', extra ? '2026-11-08T20:20:42Z' : '2026-11-08T20:20:30Z'),
    step('Teardown', 'success', '2026-11-08T20:20:42Z', '2026-11-08T20:20:48Z'),
  ],
});

test('shard overhead is the steps only that shard runs', () => {
  assert.deepEqual(shardOverhead([job(1, true), job(2, false), job(3, false)]), { 1: 42 });
  assert.deepEqual(shardOverhead([job(1, false), job(2, false), job(3, false)]), {});
});

const runOf = (id, createdAt, files, overhead = { 1: 60 }) => ({ id, createdAt, files, overhead });

test('per file p75 over runs, overhead median, files gone at HEAD dropped', () => {
  const a = 'apps/api/src/a.integration.test.ts';
  const b = 'apps/api/src/b.integration.test.ts';
  const gone = 'apps/api/src/gone.integration.test.ts';
  const runs = [
    runOf(3, '2026-11-08T03:00:00Z', { [a]: 10, [b]: 4.04, [gone]: 1 }, { 1: 70 }),
    runOf(1, '2026-11-08T01:00:00Z', { [a]: 20, [b]: 4 }, { 1: 50 }),
    runOf(2, '2026-11-08T02:00:00Z', { [a]: 30, [b]: 5, [gone]: 1 }, { 1: 60 }),
    runOf(4, '2026-11-08T04:00:00Z', { [a]: 40 }, { 1: 80 }),
  ];
  const table = buildTable(runs, { present: new Set([a, b]) });
  // Nearest-rank p75: a over [10,20,30,40] → 30; b over [4,4.04,5] → 5.
  assert.deepEqual(table, {
    schema: 1, generated: '2026-11-08T04:00:00Z', source: 'ci-job-logs', runs: [1, 2, 3, 4],
    files: { [a]: 30, [b]: 5 }, overhead: { 1: 60 },
  });
  assert.ok(loadTimings(serializeTable(table)), 'the output is a table the sequencer accepts');
});

test('the output is byte-stable for the same inputs, in any order', () => {
  const a = 'apps/api/src/a.integration.test.ts';
  const z = 'apps/api/src/z.integration.test.ts';
  const runs = [runOf(1, '2026-11-08T01:00:00Z', { [z]: 3, [a]: 2 }), runOf(2, '2026-11-08T02:00:00Z', { [a]: 1, [z]: 4 })];
  const present = new Set([a, z]);
  const text = serializeTable(buildTable(runs, { present }));
  assert.equal(serializeTable(buildTable([...runs].reverse(), { present })), text);
  assert.ok(text.indexOf(a) < text.indexOf(z), 'keys sorted');
  assert.ok(text.endsWith('}\n'));
});

// A fake `gh`: three shards of one run, each serving the real log's shape.
function fakeGh({ runs, logs }) {
  const calls = [];
  const gh = args => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs.map(r => ({ databaseId: r.id, createdAt: r.createdAt })));
    const jobsPath = args.find(a => /\/actions\/runs\/\d+\/jobs/.test(a));
    if (args[0] === 'api' && jobsPath) {
      const id = Number(jobsPath.match(/runs\/(\d+)\//)[1]);
      return runs.find(r => r.id === id).jobs.map(j => JSON.stringify(j)).join('\n');
    }
    const runPath = args.find(a => /\/actions\/runs\/\d+$/.test(a));
    if (args[0] === 'api' && runPath) return `${runs.find(r => r.id === Number(runPath.match(/(\d+)$/)[1])).createdAt}\n`;
    if (args[0] === 'run' && args[1] === 'view') return logs[args[args.indexOf('--job') + 1]];
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

test('refresh: picks fully-green runs, skips a run missing shards, builds the table', () => {
  const present = new Set(Object.keys(REAL));
  const jobsFor = (base, shards) => shards.map(s => ({ ...job(s, s === 1), id: base + s, name: `Integration Tests (shard ${s}/3)` }));
  const runs = [
    { id: 30, createdAt: '2026-11-08T03:00:00Z', jobs: jobsFor(300, [1, 2]) }, // docs-only entry: a shard missing
    { id: 20, createdAt: '2026-11-08T02:00:00Z', jobs: jobsFor(200, [1, 2, 3]) },
    { id: 10, createdAt: '2026-11-08T01:00:00Z', jobs: jobsFor(100, [1, 2, 3]) },
  ];
  const logs = Object.fromEntries([...runs.flatMap(r => r.jobs.map(j => [String(j.id), realLog]))]);
  const { gh, calls } = fakeGh({ runs, logs });
  const messages = [];
  const table = refresh({ gh, repo: 'o/r', runs: 2, present, log: m => messages.push(m) });
  assert.deepEqual(table.runs, [10, 20]);
  assert.deepEqual(table.files, REAL);
  assert.deepEqual(table.overhead, { 1: 42 });
  assert.ok(calls[0].startsWith('run list -R o/r --workflow CI --event merge_group --status success'), calls[0]);
  assert.match(messages.join('\n'), /run 30: skipped, integration shards 1,2 of 3/);
});

test('refresh: a run with any unparseable shard log is not a sample; a majority is fatal', () => {
  const present = new Set(Object.keys(REAL));
  const jobsFor = base => [1, 2, 3, 4].map(s => ({ ...job(s, s === 1), id: base + s, name: `Integration Tests (shard ${s}/4)` }));
  const runs = [
    { id: 20, createdAt: '2026-11-08T02:00:00Z', jobs: jobsFor(200) },
    { id: 10, createdAt: '2026-11-08T01:00:00Z', jobs: jobsFor(100) },
  ];
  // Run 20 has one retried (two-summary) shard; run 10 is clean.
  const logs = { 201: realLog, 202: realLog, 203: realLog, 204: `${realLog}\n${realLog}`, 101: realLog, 102: realLog, 103: realLog, 104: realLog };
  const messages = [];
  const table = refresh({ gh: fakeGh({ runs, logs }).gh, repo: 'o/r', runs: 1, present, log: m => messages.push(m) });
  assert.deepEqual(table.runs, [10], 'the partial run is skipped, the next clean one used');
  assert.deepEqual(table.files, REAL);
  assert.match(messages.join('\n'), /run 20 job 204 \(Integration Tests \(shard 4\/4\)\): skipped: 2 vitest summaries/);
  assert.match(messages.join('\n'), /run 20: skipped, 1 of 4 shard logs did not parse/);
  // Named explicitly, a partial run is an error, not a silent gap.
  assert.throws(() => refresh({ gh: fakeGh({ runs, logs }).gh, repo: 'o/r', runIds: [20], present, log: () => {} }),
    e => e instanceof TimingLogError && /run 20: 1 of 4 shard logs did not parse/.test(e.message));
  const badLogs = { ...logs, 102: 'garbage', 103: 'garbage', 104: 'garbage' };
  assert.throws(() => refresh({ gh: fakeGh({ runs, logs: badLogs }).gh, repo: 'o/r', runIds: [10], present, log: () => {} }),
    e => e instanceof TimingLogError && /3 of 4 shard logs did not parse; the reporter format may have changed/.test(e.message));
});

test('writeTable validates before it overwrites the committed table', () => {
  const present = Object.keys(REAL);
  const writes = [];
  const write = (path, text) => writes.push([path, text]);
  const table = buildTable([runOf(1, '2026-11-08T01:00:00Z', REAL)], { present: new Set(present) });
  // Nothing matched the suite: an empty table.
  const empty = buildTable([runOf(1, '2026-11-08T01:00:00Z', { 'apps/api/src/other.test.ts': 1 })], { present: new Set(present) });
  assert.throws(() => writeTable(empty, { present, out: 'x.json', write }), /empty or invalid; nothing written/);
  // Below STALE_BELOW (0.9): 4 of 5.
  assert.throws(() => writeTable(table, { present: [...present, 'apps/api/src/new.integration.test.ts'], out: 'x.json', write }),
    /covers only 4\/5 integration files; nothing written/);
  assert.equal(writes.length, 0);
  const lines = writeTable(table, { present, out: 'x.json', write, count: 2 });
  assert.deepEqual(writes, [['x.json', serializeTable(table)]]);
  assert.match(lines.join('\n'), /coverage 4\/4; projected 2-shard max\/mean/);
});

test('refresh: an explicit run without every shard green is an error', () => {
  const runs = [{ id: 10, createdAt: '2026-11-08T01:00:00Z', jobs: [{ ...job(1, true), name: 'Integration Tests (shard 1/2)' }] }];
  assert.throws(() => refresh({ gh: fakeGh({ runs, logs: {} }).gh, repo: 'o/r', runIds: [10], present: new Set(), log: () => {} }),
    e => e instanceof TimingLogError && /run 10/.test(e.message));
});

test('lint runs this suite', () => {
  const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const lint = ci.match(/^  lint:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(lint, 'lint job not found');
  assert.match(lint, /^        run: node --test \.github\/scripts\/test-timings\.test\.mjs$/m);
});
