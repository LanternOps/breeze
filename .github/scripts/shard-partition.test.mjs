// W07a (#10751): integration shards partitioned by recorded file timing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  EMPTY_SHARD_SENTINEL, SUITE_MAP_PATH, ShardPlanError, TIMINGS_PATH, assertPartition, integrationTestFiles, loadTimings, partition,
  planDigest, planLoads, timingShard, toRepoKey,
} from './shard-partition.mjs';
import { runSelection } from './integration-suites.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const read = path => readFileSync(join(REPO_ROOT, path), 'utf8');

// Deterministic pseudo-random numbers (mulberry32), so a failure reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, seed) {
  const out = [...list];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function synthetic(count, seed = 1) {
  const next = rng(seed);
  const files = Array.from({ length: count }, (_, i) => `apps/api/src/__tests__/integration/f${String(i).padStart(4, '0')}.integration.test.ts`);
  // Long-tailed like the real suite: most files 3–20 s, a few over a minute.
  const timings = Object.fromEntries(files.map(f => [f, Math.round((next() < 0.05 ? 60 + next() * 60 : 3 + next() * 17) * 10) / 10]));
  return { files, timings };
}

test('every file exactly once', () => {
  const { files, timings } = synthetic(1626);
  const plan = partition(files, { count: 16, timings, defaultSeconds: 10 });
  assert.equal(plan.length, 16);
  const flat = plan.flat();
  assert.equal(flat.length, files.length);
  assert.deepEqual([...flat].sort(), [...files].sort());
  assertPartition(plan, files);
  for (const shard of plan) assert.ok(shard.length > 0, 'no empty shard at 1626 files');
});

test('deterministic under shuffled input', () => {
  const { files, timings } = synthetic(1626, 7);
  // Equal weights on purpose: ties must break by path, not by input order.
  for (const f of files.slice(0, 200)) timings[f] = 5;
  const expected = partition(files, { count: 16, timings, defaultSeconds: 10 });
  for (let seed = 1; seed <= 5; seed++) {
    assert.deepEqual(partition(shuffled(files, seed), { count: 16, timings, defaultSeconds: 10 }), expected, `shuffle ${seed}`);
  }
  assert.equal(planDigest(partition(shuffled(files, 99), { count: 16, timings, defaultSeconds: 10 })), planDigest(expected));
});

test('the partition is balanced on a long-tailed suite', () => {
  const { files, timings } = synthetic(1626, 3);
  const loads = planLoads(partition(files, { count: 16, timings, defaultSeconds: 10 }), { timings, defaultSeconds: 10 });
  const mean = loads.reduce((s, x) => s + x, 0) / loads.length;
  assert.ok(Math.max(...loads) / mean <= 1.02, `max/mean ${Math.max(...loads) / mean}`);
});

test('unknown files weigh the p75 of known weights', () => {
  const table = loadTimings(JSON.stringify({ schema: 1, files: { 'a.test.ts': 1, 'b.test.ts': 2, 'c.test.ts': 3, 'd.test.ts': 4 } }));
  assert.equal(table.defaultSeconds, 3);
  const plan = partition(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'new.test.ts'], { count: 2, ...table });
  assert.deepEqual(planLoads(plan, table), [7, 6]);
  // The unknown file weighs 3, so it lands beside c. At weight 0 it would
  // have gone last, onto shard 1: [a, d, new] / [b, c].
  assert.deepEqual(plan, [['a.test.ts', 'b.test.ts', 'd.test.ts'], ['c.test.ts', 'new.test.ts']]);
});

test('overhead moves load off shard 1', () => {
  const { files, timings } = synthetic(1600, 11);
  for (const f of files) timings[f] = Math.min(timings[f], 10);
  const opts = { count: 16, timings, defaultSeconds: 10 };
  const without = planLoads(partition(files, opts), opts);
  const withOverhead = planLoads(partition(files, { ...opts, overhead: { 1: 120 } }), opts);
  const moved = without[0] - withOverhead[0];
  // Greedy placement is exact to within one file's weight (≤ 10 s here).
  assert.ok(Math.abs(moved - 120) <= 10, `shard 1 lost ${moved}s of file load, expected about 120`);
});

test('absolute and relative paths normalise to one key', () => {
  const root = '/home/runner/work/breeze/breeze';
  const key = 'apps/api/src/x.test.ts';
  assert.equal(toRepoKey(`${root}/apps/api/src/x.test.ts`, root), key);
  assert.equal(toRepoKey(`${root}/`.concat('apps/api/src/x.test.ts'), `${root}/`), key);
  assert.equal(toRepoKey('apps/api/src/x.test.ts', root), key);
  assert.equal(toRepoKey('./apps/api/src/x.test.ts', root), key);
  assert.equal(toRepoKey('C:\\a\\breeze\\apps\\api\\src\\x.test.ts', 'C:\\a\\breeze'), key);
  assert.throws(() => toRepoKey('/elsewhere/apps/api/src/x.test.ts', root), ShardPlanError);
  assert.throws(() => toRepoKey('../outside.test.ts', root), ShardPlanError);
});

test('assertPartition throws on a dropped file, a duplicate and a stranger', () => {
  const files = ['a', 'b', 'c'];
  assertPartition([['a'], ['b', 'c']], files);
  assert.throws(() => assertPartition([['a'], ['b']], files), e => e instanceof ShardPlanError && /in no shard: c/.test(e.message));
  assert.throws(() => assertPartition([['a', 'c'], ['b', 'c']], files), e => e instanceof ShardPlanError && /more than one shard: c/.test(e.message));
  assert.throws(() => assertPartition([['a', 'x'], ['b', 'c']], files), e => e instanceof ShardPlanError && /not in the run: x/.test(e.message));
});

test('loadTimings rejects every malformed table', () => {
  for (const text of [undefined, null, '', '{', '[]', '{"schema":2,"files":{"a":1}}', '{"schema":1}',
    '{"schema":1,"files":{}}', '{"schema":1,"files":{"a":-1}}', '{"schema":1,"files":{"a":"1"}}',
    '{"schema":1,"files":{"a":1},"overhead":{"x":1}}', '{"schema":1,"files":{"a":1},"overhead":{"1":-5}}']) {
    assert.equal(loadTimings(text), null, String(text));
  }
  assert.deepEqual(loadTimings('{"schema":1,"files":{"a":2},"overhead":{"1":30}}'), { timings: { a: 2 }, overhead: { 1: 30 }, defaultSeconds: 2 });
});

// A stub of what vitest hands a sequencer: specs carrying absolute module ids.
const ROOT = '/repo';
const specsOf = files => files.map(f => ({ moduleId: `${ROOT}/${f}`, project: { name: '' } }));

test('missing or invalid table falls back to the inherited shard', () => {
  const specs = specsOf(['apps/api/src/a.test.ts', 'apps/api/src/b.test.ts']);
  for (const timingsText of [null, 'not json', '{"schema":9}']) {
    const logs = [];
    const fallback = ['inherited'];
    const out = timingShard(specs, { index: 1, count: 2, repoRoot: ROOT, timingsText, fallback: () => fallback, log: l => logs.push(l) });
    assert.equal(out, fallback);
    assert.match(logs.join('\n'), /^::warning title=Shard timing unavailable::/m);
  }
});

test('the sequencer core returns this shard, and every shard computes one plan', () => {
  const files = ['apps/api/src/a.test.ts', 'apps/api/src/b.test.ts', 'apps/api/src/c.test.ts', 'apps/api/src/d.test.ts', 'apps/api/src/new.test.ts'];
  const timingsText = JSON.stringify({ schema: 1, files: { [files[0]]: 40, [files[1]]: 30, [files[2]]: 20, [files[3]]: 10 }, overhead: { 1: 15 } });
  const specs = specsOf(files);
  const seen = [];
  const digests = new Set();
  for (let index = 1; index <= 3; index++) {
    const written = [];
    const logs = [];
    const out = timingShard(shuffled(specs, index), {
      index, count: 3, repoRoot: ROOT, timingsText, fallback: () => assert.fail('no fallback with a valid table'),
      log: l => logs.push(l), writePlan: p => written.push(p),
    });
    for (const spec of out) assert.ok(specs.includes(spec), 'returns vitest\'s own spec objects');
    seen.push(...out.map(s => s.moduleId));
    assert.equal(written.length, 1);
    const [plan] = written;
    assert.equal(plan.index, index);
    assert.equal(plan.count, 3);
    assert.equal(plan.total, 5);
    assert.deepEqual(plan.files, out.map(s => s.moduleId.slice(ROOT.length + 1)).sort());
    assert.match(plan.planDigest, /^[a-f\d]{64}$/);
    digests.add(plan.planDigest);
    assert.match(logs.join('\n'), new RegExp(`^shard-plan: shard=${index}/3 files=${out.length}/5 known=4/5 .*planDigest=${plan.planDigest}$`, 'm'));
  }
  assert.equal(digests.size, 1, 'every shard computed the same global plan');
  assert.deepEqual(seen.sort(), specs.map(s => s.moduleId).sort(), 'the shards together run every file once');
});

test('the sequencer core rejects an invalid shard index and a spec handed over twice', () => {
  const specs = specsOf(['apps/api/src/a.test.ts']);
  const timingsText = JSON.stringify({ schema: 1, files: { 'apps/api/src/a.test.ts': 1 } });
  for (const [index, count] of [[0, 2], [3, 2], [1, 0], [1.5, 2]]) {
    assert.throws(() => timingShard(specs, { index, count, repoRoot: ROOT, timingsText, fallback: () => [] }),
      e => e instanceof ShardPlanError && /invalid shard/.test(e.message), `${index}/${count}`);
  }
  assert.throws(() => timingShard([...specs, ...specsOf(['apps/api/src/a.test.ts'])], { index: 1, count: 2, repoRoot: ROOT, timingsText, fallback: () => [] }),
    e => e instanceof ShardPlanError && /handed to the sequencer twice/.test(e.message));
});

test('the fallback warning says why; a stale table warns; a failed plan write only warns', () => {
  const specs = specsOf(['apps/api/src/a.test.ts', 'apps/api/src/b.test.ts']);
  const run = opts => {
    const logs = [];
    const out = timingShard(specs, { index: 1, count: 2, repoRoot: ROOT, fallback: () => 'fallback', log: l => logs.push(l), ...opts });
    return { out, logs: logs.join('\n') };
  };
  assert.match(run({ timingsText: null, timingsError: 'EACCES' }).logs, /could not be read \(EACCES\)/);
  assert.match(run({ timingsText: null }).logs, /could not be read \(missing\)/);
  assert.match(run({ timingsText: '{"schema":2}' }).logs, /is not a valid schema-1 table/);
  const half = JSON.stringify({ schema: 1, files: { 'apps/api/src/a.test.ts': 1 } });
  assert.match(run({ timingsText: half }).logs, /^::warning title=Shard timing stale::Only 1\/2 integration files/m);
  const full = JSON.stringify({ schema: 1, files: { 'apps/api/src/a.test.ts': 1, 'apps/api/src/b.test.ts': 2 } });
  assert.doesNotMatch(run({ timingsText: full }).logs, /::warning/);
  const failed = run({ timingsText: full, writePlan: () => { throw new Error('ENOSPC: no space left'); } });
  assert.equal(failed.out.length, 1, 'the shard still runs its files');
  assert.match(failed.logs, /^::warning title=Shard plan not written::ENOSPC/m);
});

test('pinned edges: overhead past the shard count is ignored; fewer files than shards leaves empty shards', () => {
  const timings = { a: 5, b: 3 };
  assert.deepEqual(partition(['a', 'b'], { count: 2, timings, overhead: { 5: 100 } }), [['a'], ['b']]);
  assert.deepEqual(partition(['a', 'b'], { count: 4, timings }), [['a'], ['b'], [], []]);
  assert.deepEqual(partition([], { count: 3, timings }), [[], [], []]);
  assert.equal(loadTimings('{"schema":1,"files":{"a":1},"overhead":{"1":1e999}}'), null, 'a non-finite overhead is invalid');
});

test('the sequencer core fails loudly on a spec outside the repository', () => {
  const specs = [...specsOf(['apps/api/src/a.test.ts']), { moduleId: '/tmp/stray.test.ts' }];
  const timingsText = JSON.stringify({ schema: 1, files: { 'apps/api/src/a.test.ts': 1 } });
  assert.throws(() => timingShard(specs, { index: 1, count: 2, repoRoot: ROOT, timingsText, fallback: () => [] }), ShardPlanError);
});

// ── Named-suite selection in the sequencer (W07b2) ─────────────────────────

const IT = 'apps/api/src/__tests__/integration';
const SUITE_FIXTURE = `
suite ai tests ${IT}/ai[!a-z0-9]*
suite ai sources apps/api/src/services/ai*
suite ticket tests ${IT}/ticket[!a-z0-9]*
suite ticket sources apps/api/src/services/ticket*
`;
const selectionFiles = [
  ...['aiTools', 'aiBudget', 'aiChat'].map(n => `${IT}/${n}.integration.test.ts`),
  ...['ticketCore', 'ticketSla', 'ticketForms', 'ticketMerge', 'ticketTime'].map(n => `${IT}/${n}.integration.test.ts`),
  ...['auth', 'devices', 'orgs', 'sites'].map(n => `${IT}/${n}.integration.test.ts`),
];
const selectionTimings = JSON.stringify({ schema: 1, files: Object.fromEntries(selectionFiles.map((f, i) => [f, 10 + i])), overhead: { 1: 5 } });
const selectionSpecs = [...specsOf(selectionFiles), ...specsOf([EMPTY_SHARD_SENTINEL])];

// Runs every shard of one configuration and returns what each returned, logged and wrote.
function everyShard({ count = 4, selection, timingsText = selectionTimings, specs = selectionSpecs } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const logs = [];
    const written = [];
    const out = timingShard(shuffled(specs, i + 1), {
      index: i + 1, count, repoRoot: ROOT, timingsText, selection, fallback: subset => ({ fallback: subset }),
      log: l => logs.push(l), writePlan: p => written.push(p),
    });
    return { out, logs: logs.join('\n'), plan: written[0] };
  });
}
const keysOf = out => out.map(s => s.moduleId.slice(ROOT.length + 1)).sort();

test('the empty-shard sentinel is set aside: no shard runs it while every shard has files', () => {
  assert.equal(EMPTY_SHARD_SENTINEL, `${IT}/emptyShard.sentinel.test.ts`);
  const shards = everyShard();
  const seen = shards.flatMap(s => keysOf(s.out));
  assert.deepEqual(seen.sort(), [...selectionFiles].sort(), 'every file once, and not the sentinel');
  for (const s of shards) assert.equal(s.plan.total, selectionFiles.length);
  // The fallback (vitest's own sharding) is handed the same list, sentinel removed.
  const [fallback] = everyShard({ timingsText: null });
  assert.deepEqual(keysOf(fallback.out.fallback), [...selectionFiles].sort());
});

test('shadow: every shard returns exactly what it returns without a selection, and logs what enforcement would run', () => {
  const plain = everyShard();
  for (const selection of [
    { suites: 'ai', mode: 'enforce', mapText: SUITE_FIXTURE, enforce: false }, // the env asks, the constant says no
    { suites: 'ai', mode: 'shadow', mapText: SUITE_FIXTURE, enforce: true },   // the constant allows, the env does not ask
    { suites: 'ai', mode: undefined, mapText: SUITE_FIXTURE, enforce: true },
  ]) {
    const shadow = everyShard({ selection });
    shadow.forEach((s, i) => {
      assert.deepEqual(s.out, plain[i].out, `shard ${i + 1}: shadow runs the A1 plan`);
      assert.equal(s.plan.planDigest, plain[i].plan.planDigest);
      assert.match(s.logs, /^integration-suites: mode=shadow suites=core,ai would_run=7\/12$/m);
      assert.doesNotMatch(s.logs, /::warning/);
      assert.deepEqual(s.plan.selection, { mode: 'shadow', suites: ['core', 'ai'], wouldRun: 7, total: 12, digest: s.plan.selection.digest });
      assert.match(s.plan.selection.digest, /^[a-f\d]{64}$/);
    });
  }
  // Without the env (a local run) there is no selection at all.
  for (const s of plain) {
    assert.doesNotMatch(s.logs, /integration-suites:/);
    assert.equal(s.plan.selection, undefined);
  }
  // No timing table: the fallback still gets every file, and the line is still logged.
  const [noTable] = everyShard({ timingsText: null, selection: { suites: 'ai', mode: 'enforce', mapText: SUITE_FIXTURE, enforce: false } });
  assert.deepEqual(keysOf(noTable.out.fallback), [...selectionFiles].sort());
  assert.match(noTable.logs, /^integration-suites: mode=shadow suites=core,ai would_run=7\/12$/m);
});

test('a selection that throws is caught: every file runs, with a warning', () => {
  const selection = { mode: 'enforce', mapText: SUITE_FIXTURE, enforce: true, get suites() { throw new Error('boom'); } };
  const shards = everyShard({ selection });
  assert.deepEqual(shards.flatMap(s => keysOf(s.out)).sort(), [...selectionFiles].sort());
  assert.match(shards[0].logs, /^::warning title=Integration suites::the selection failed \(boom\), so every suite runs$/m);
  assert.match(shards[0].logs, /^integration-suites: mode=shadow suites=all would_run=12\/12$/m);
  assert.equal(shards[0].plan.selection.suites, 'all');
});

test('enforce: only the selected suites plus core run, every shard checks one plan, an empty shard runs the sentinel', () => {
  const selection = { suites: 'ai', mode: 'enforce', mapText: SUITE_FIXTURE, enforce: true };
  const expected = selectionFiles.filter(f => !/\/ticket/.test(f)).sort();
  for (const count of [3, 9]) {
    const shards = everyShard({ count, selection });
    const ran = shards.flatMap(s => keysOf(s.out)).filter(k => k !== EMPTY_SHARD_SENTINEL);
    assert.deepEqual(ran.sort(), expected, `${count} shards: union equals the selection, each file once`);
    assert.equal(new Set(shards.map(s => s.plan.planDigest)).size, 1, 'every shard computed one plan');
    assert.equal(new Set(shards.map(s => s.plan.selection.digest)).size, 1, 'and one selection');
    for (const s of shards) {
      assert.ok(s.out.length > 0, 'no shard returns nothing: vitest exits 1 on an empty shard');
      const sentinel = keysOf(s.out).includes(EMPTY_SHARD_SENTINEL);
      assert.equal(sentinel, s.plan.files.length === 0, 'the sentinel runs exactly where the plan is empty');
      if (sentinel) assert.equal(s.out.length, 1);
      assert.match(s.logs, /^integration-suites: mode=enforce suites=core,ai would_run=7\/12$/m);
      assert.deepEqual({ ...s.plan.selection, digest: undefined }, { mode: 'enforce', suites: ['core', 'ai'], wouldRun: 7, total: 12, digest: undefined });
      assert.equal(s.plan.total, 7);
    }
    assert.equal(shards.filter(s => keysOf(s.out).includes(EMPTY_SHARD_SENTINEL)).length, Math.max(0, count - expected.length));
  }
  // `all` under enforcement is the full run.
  const all = everyShard({ selection: { ...selection, suites: 'all' } });
  assert.deepEqual(all.flatMap(s => keysOf(s.out)).sort(), [...selectionFiles].sort());
  assert.match(all[0].logs, /^integration-suites: mode=enforce suites=all would_run=12\/12$/m);
});

test('enforce fails open to every file: unusable env, map, or timing table', () => {
  const base = { mode: 'enforce', mapText: SUITE_FIXTURE, enforce: true };
  for (const [selection, why] of [
    [{ ...base, suites: '' }, /BREEZE_INTEGRATION_SUITES is unset or empty/],
    [{ ...base, suites: undefined }, /BREEZE_INTEGRATION_SUITES is unset or empty/],
    [{ ...base, suites: 'ai;rm -rf' }, /malformed BREEZE_INTEGRATION_SUITES/],
    // Workflow-command escaping: `%` and a newline cannot end the annotation or start another command.
    [{ ...base, suites: 'a%b\n::error::x' }, /malformed BREEZE_INTEGRATION_SUITES "a%25b\\n::error::x"$/],
    [{ ...base, suites: 'ai,nope' }, /unknown suite "nope"/],
    [{ ...base, suites: 'ai', mapText: 'suite ai test x' }, /suite map unusable/],
    [{ ...base, suites: 'ai', mapText: null }, /suite map unusable/],
  ]) {
    const shards = everyShard({ selection });
    assert.deepEqual(shards.flatMap(s => keysOf(s.out)).sort(), [...selectionFiles].sort(), JSON.stringify(selection));
    assert.match(shards[0].logs, /^integration-suites: mode=enforce suites=all would_run=12\/12$/m);
    assert.match(shards[0].logs, new RegExp(`^::warning title=Integration suites::.*${why.source}`, 'm'));
    assert.equal(shards[0].logs.split('\n').filter(l => l.includes('Integration suites')).length, 1, 'one single-line warning');
    for (const s of shards) assert.equal(s.plan.selection.suites, 'all');
  }
  // No timing table: vitest's own sharding over every file, never a subset.
  const [noTable] = everyShard({ timingsText: null, selection: { ...base, suites: 'ai' } });
  assert.deepEqual(keysOf(noTable.out.fallback), [...selectionFiles].sort());
  assert.match(noTable.logs, /^integration-suites: mode=enforce suites=all would_run=12\/12$/m);
  assert.match(noTable.logs, /^::warning title=Integration suites::.*every suite runs/m);
});

test('enforce: an empty shard without the sentinel spec fails loudly', () => {
  const selection = { suites: 'ai', mode: 'enforce', mapText: SUITE_FIXTURE, enforce: true };
  assert.throws(() => everyShard({ count: 9, selection, specs: specsOf(selectionFiles) }),
    e => e instanceof ShardPlanError && /no selected file/.test(e.message) && e.message.includes(EMPTY_SHARD_SENTINEL));
});

// ── The committed table against the real suite ─────────────────────────────

const table = loadTimings(read(TIMINGS_PATH));

test('the committed timing table parses', () => {
  assert.ok(table, `${TIMINGS_PATH} must be a valid schema-1 table`);
  const raw = JSON.parse(read(TIMINGS_PATH));
  assert.ok(Array.isArray(raw.runs) && raw.runs.length >= 10, 'the table is built from at least 10 CI runs');
  assert.deepEqual(Object.keys(raw.files), Object.keys(raw.files).sort(), 'keys are sorted (byte-stable refreshes)');
});

test('every integration file is mapped to exactly one shard', () => {
  const files = integrationTestFiles(REPO_ROOT);
  assert.ok(files.length >= 1500, `enumerated only ${files.length} integration files`);
  const plan = partition(files, { count: 16, ...table });
  assertPartition(plan, files);
  for (const shard of plan) assert.ok(shard.length > 0, 'no shard is empty');
  // A key-format sanity floor, not a freshness ratchet: a table keyed
  // differently from the suite would map 0%. New files fall back to the p75
  // weight until the next refresh (`test-timings.mjs refresh`).
  const known = files.filter(f => Object.hasOwn(table.timings, f)).length;
  assert.ok(known / files.length >= 0.5, `only ${known}/${files.length} integration files have a recorded timing`);
});

test('integrationTestFiles matches the vitest config include and exclude lists', () => {
  const files = new Set(integrationTestFiles(REPO_ROOT));
  // Spot checks across include styles: flat dir glob, directory glob, one exact file, and an exclude.
  assert.ok(files.has('apps/api/src/__tests__/integration/wispGrantsRls.integration.test.ts'));
  assert.ok(files.has('apps/api/src/services/autopay/enrollmentService.integration.test.ts'));
  assert.ok(files.has('apps/api/src/index.autopay.integration.test.ts'));
  assert.ok(!files.has('apps/api/src/__tests__/integration/rls-coverage.integration.test.ts'), 'excluded file');
  assert.ok(!files.has('apps/api/src/__tests__/integration/workspace.vercel.e2e.test.ts'), 'excluded file');
  for (const f of files) assert.match(f, /^apps\/api\/src\/.+\.test\.ts$/);
});

test('the committed table balances the suite it was recorded from', () => {
  const files = Object.keys(table.timings);
  const loads = planLoads(partition(files, { count: 16, ...table }), table);
  const mean = loads.reduce((s, x) => s + x, 0) / loads.length;
  // A ratchet; lower it as the data improves.
  assert.ok(Math.max(...loads) / mean <= 1.10, `max/mean ${(Math.max(...loads) / mean).toFixed(3)}`);
});

// The real adapter, through vitest's own config loader and spec resolution.
// Offline: no globalSetup runs and no test executes. Needs apps/api's
// dependencies, so lint runs this suite after `pnpm install`.
test('the real TimingSequencer shards every spec vitest resolves exactly once, with one plan', async () => {
  const apiRequire = createRequire(join(REPO_ROOT, 'apps/api/package.json'));
  const { createVitest } = await import(pathToFileURL(apiRequire.resolve('vitest/node')).href);
  const saved = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'BREEZE_INTEGRATION_SUITES', 'BREEZE_INTEGRATION_SUITES_MODE']
    .map(k => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k]; // no shard-plan files, and no selection, from a test
  const savedLog = console.log;
  const logs = [];
  let vitest;
  try {
    vitest = await createVitest('test', {
      root: join(REPO_ROOT, 'apps/api'), config: join(REPO_ROOT, 'apps/api/vitest.integration.config.ts'), watch: false, shard: '1/16',
    });
    const specs = await vitest.globTestSpecifications();
    // The node-side enumeration the tests above rely on agrees with vitest's.
    assert.deepEqual(specs.map(s => toRepoKey(s.moduleId, REPO_ROOT)).sort(), integrationTestFiles(REPO_ROOT));
    const Sequencer = vitest.config.sequence.sequencer;
    assert.equal(Sequencer.name, 'TimingSequencer');
    const sentinel = specs.find(s => toRepoKey(s.moduleId, REPO_ROOT) === EMPTY_SHARD_SENTINEL);
    assert.ok(sentinel, 'vitest resolves the empty-shard sentinel');
    console.log = (...args) => logs.push(args.join(' '));
    const runAll = async () => {
      const shards = [];
      for (let index = 1; index <= 16; index++) {
        vitest.config.shard = { index, count: 16 };
        const out = await new Sequencer(vitest).shard(specs);
        for (const spec of out) assert.ok(specs.includes(spec));
        shards.push(out);
      }
      return shards;
    };
    const plain = await runAll();
    // Shadow, as a PR run sets it (W07b2): the same specs in every shard.
    process.env.BREEZE_INTEGRATION_SUITES = 'core,ai,ticket';
    process.env.BREEZE_INTEGRATION_SUITES_MODE = 'enforce';
    const shadow = await runAll();
    const shadowLogs = logs.splice(0);
    // In GitHub Actions an unset selection env means broken wiring: it warns, and still runs everything.
    delete process.env.BREEZE_INTEGRATION_SUITES;
    delete process.env.BREEZE_INTEGRATION_SUITES_MODE;
    process.env.GITHUB_ACTIONS = 'true';
    vitest.config.shard = { index: 1, count: 16 };
    const unwired = await new Sequencer(vitest).shard(specs);
    const unwiredLogs = logs.splice(0);
    console.log = savedLog;
    const seen = plain.flat().map(s => s.moduleId);
    assert.equal(seen.length, specs.length - 1, 'every spec once, except the sentinel');
    assert.equal(new Set(seen).size, specs.length - 1);
    assert.ok(!seen.includes(sentinel.moduleId));
    shadow.forEach((out, i) => assert.deepEqual(out, plain[i], `shard ${i + 1}: shadow changes nothing`));
    assert.equal(new Set(shadowLogs.map(l => l.match(/planDigest=(\w+)/)?.[1]).filter(Boolean)).size, 1, shadowLogs.slice(0, 3).join('\n'));
    const shadowLines = shadowLogs.filter(l => l.startsWith('integration-suites: '));
    assert.equal(shadowLines.length, 16, 'every shadow shard logs its selection');
    assert.equal(new Set(shadowLines).size, 1);
    // would_run is what the committed map really selects (the Gate B-enforce ratio is built from it).
    const files = integrationTestFiles(REPO_ROOT).filter(f => f !== EMPTY_SHARD_SENTINEL);
    const chosen = runSelection({ suites: 'core,ai,ticket', mapText: read(SUITE_MAP_PATH) });
    const wouldRun = files.filter(f => chosen.suites.includes(chosen.suiteOf(f))).length;
    assert.ok(wouldRun > 0 && wouldRun < files.length, `${wouldRun}/${files.length}`);
    assert.equal(shadowLines[0], `integration-suites: mode=shadow suites=core,ai,ticket would_run=${wouldRun}/${files.length}`);
    assert.equal(shadowLogs.filter(l => l.startsWith('::warning')).length, 0, shadowLogs.join('\n'));
    assert.deepEqual(unwired, plain[0]);
    assert.ok(unwiredLogs.some(l => /^::warning title=Integration suites::BREEZE_INTEGRATION_SUITES is unset or empty/.test(l)), unwiredLogs.join('\n'));
    assert.ok(unwiredLogs.includes(`integration-suites: mode=shadow suites=all would_run=${files.length}/${files.length}`));
  } finally {
    console.log = savedLog;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await vitest?.close();
  }
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the integration config shards with the timing sequencer', () => {
  const config = read('apps/api/vitest.integration.config.ts');
  assert.match(config, /from '\.\.\/\.\.\/\.github\/scripts\/shard-partition\.mjs'/);
  assert.match(config, /class TimingSequencer extends BaseSequencer/);
  assert.match(config, /^\s+sequencer: TimingSequencer,?$/m);
  // queue-selection and ci-area-gating read the FIRST `include:` list as the suite's.
  assert.equal(config.indexOf('include:'), config.indexOf("include: [\n      'src/"), 'test.include stays the first include list');
});

test('integration-test uploads every shard\'s plan', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.match(/^  integration-test:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(job, 'integration-test job not found');
  assert.match(job, /name: shard-plan-integration-\$\{\{ matrix\.shard \}\}\n\s+path: apps\/api\/shard-plan-\*\.json/);
});

test('lint runs this suite', () => {
  const ci = read('.github/workflows/ci.yml');
  const lint = ci.match(/^  lint:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(lint, 'lint job not found');
  assert.match(lint, /^        run: node --test \.github\/scripts\/shard-partition\.test\.mjs$/m);
});
