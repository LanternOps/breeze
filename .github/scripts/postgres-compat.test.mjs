import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Postgres 17/18 compatibility contract (#11416 W1, #11417).
//
// One source of truth for the tested majors (postgres-versions.json), three
// consumers that must agree with it:
//   - ci.yml's PR smoke: a second, newest-major service inside check-migrations
//     and check-migrations-nonsuperuser (no new job, so the CI Gate's judged job
//     set and `CI Success` are unchanged);
//   - postgres-compat.yml, the scheduled full-suite run on 17 and 18, which
//     COPIES ci.yml's integration-test steps (a reusable workflow would rename
//     the gate-judged check) and is kept in step with them here;
//   - postgres-compat.mjs, which turns the trigger into the version list and
//     reconciles the rolling issue (unit-tested at the bottom of this file).
// Built-ins only: this runs in the lint job before `pnpm install`.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const exists = (rel) => existsSync(new URL(rel, import.meta.url));

const VERSIONS_PATH = './postgres-versions.json';
const COMPAT_PATH = '../workflows/postgres-compat.yml';
const CI_PATH = '../workflows/ci.yml';

const loadVersions = () => JSON.parse(read(VERSIONS_PATH));
const ci = () => read(CI_PATH);
const compat = () => read(COMPAT_PATH);

// ── Minimal YAML-shape helpers ──────────────────────────────────────────────
// No YAML parser is installed for .github/scripts tests. These read the
// repo's own block-style workflow layout: jobs at indent 2, job keys at 4,
// steps at `      - ` (6), step keys at 8.

const indentOf = (line) => line.search(/\S/);
const isNoise = (line) => line.trim() === '' || /^\s*#/.test(line);

/** Lines of `key:` (at `indent`) through its last more-indented line. */
function block(lines, key, indent) {
  const head = new RegExp(`^ {${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!isNoise(line) && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

function job(text, id) {
  const lines = block(text.split('\n'), id, 2);
  assert.ok(lines, `job ${id} not found`);
  return lines;
}

/** `key: value` pairs directly under `key:` at `indent` (comments ignored). */
function mapUnder(lines, key, indent) {
  const b = block(lines, key, indent);
  if (!b) return null;
  const out = {};
  const child = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):\\s*(.*)$`);
  for (const line of b.slice(1)) {
    const m = child.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** List items directly under `key:` at `indent`. */
function listUnder(lines, key, indent) {
  const b = block(lines, key, indent);
  if (!b) return null;
  return b.slice(1)
    .filter((l) => new RegExp(`^ {${indent + 2}}- `).test(l))
    .map((l) => l.trim().slice(2).replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'));
}

/** Step chunks of a job (each starts at `      - `). */
function steps(jobLines) {
  const out = [];
  let cur = null;
  for (const line of jobLines) {
    if (/^ {6}- /.test(line)) {
      cur = [line];
      out.push(cur);
    } else if (cur && (isNoise(line) || indentOf(line) > 6)) {
      cur.push(line);
    } else {
      cur = null;
    }
  }
  return out.map((s) => {
    const first = s[0].replace(/^ {6}- /, '        ');
    const body = [first, ...s.slice(1)];
    const name = (/^ {8}name:\s*(.+)$/m.exec(body.join('\n')) || [])[1]?.trim() ?? '';
    return { name, lines: body };
  });
}

const stepNamed = (jobLines, name) => {
  const s = steps(jobLines).find((x) => x.name === name);
  assert.ok(s, `step "${name}" not found`);
  return s;
};
const stepEnv = (step) => mapUnder(step.lines, 'env', 8) ?? {};
const stepRun = (step) => {
  const b = block(step.lines, 'run', 8);
  assert.ok(b, `step "${step.name}" has no run:`);
  return b.filter((l) => !isNoise(l)).map((l) => l.trimEnd()).join('\n');
};
/** A step with comments and blank lines dropped: what actually executes. */
const normalized = (step) => step.lines.filter((l) => !isNoise(l)).map((l) => l.trimEnd()).join('\n');

const PG_SMOKE_SUFFIX = /\s\(Postgres (\d+)\)$/;

// ── postgres-versions.json ──────────────────────────────────────────────────

test('postgres-versions.json names the default, the PR smoke and the scheduled majors', () => {
  const v = loadVersions();
  assert.match(v.default, /^\d{2}$/);
  assert.match(v.prSmoke, /^\d{2}$/);
  assert.notEqual(v.prSmoke, v.default, 'the PR smoke exists to test a major other than the default');
  const keys = Object.keys(v.scheduled);
  assert.ok(keys.length > 0);
  assert.ok(keys.includes(v.prSmoke), 'the PR smoke major must also get the scheduled full suite');
  assert.ok(!keys.includes(v.default), 'the default major already runs the full suite on every PR');
  const crons = new Set();
  for (const [major, entry] of Object.entries(v.scheduled)) {
    assert.match(major, /^\d{2}$/);
    assert.ok(['daily', 'weekly'].includes(entry.cadence), `${major}: cadence ${entry.cadence}`);
    // daily = `M H * * *`; weekly = `M H * * D`. Off the hour (minute != 0).
    const shape = entry.cadence === 'daily' ? /^([1-5]?\d) (\d{1,2}) \* \* \*$/ : /^([1-5]?\d) (\d{1,2}) \* \* [0-6]$/;
    const m = shape.exec(entry.cron);
    assert.ok(m, `${major}: cron ${JSON.stringify(entry.cron)} does not match cadence ${entry.cadence}`);
    assert.notEqual(Number(m[1]), 0, `${major}: keep the cron off the hour`);
    assert.ok(!crons.has(entry.cron), `${major}: cron ${entry.cron} is shared with another major`);
    crons.add(entry.cron);
  }
});

// ── ci.yml PR smoke ─────────────────────────────────────────────────────────

const SMOKE_JOBS = ['check-migrations', 'check-migrations-nonsuperuser'];

for (const id of SMOKE_JOBS) {
  test(`${id}: keeps its stock Postgres 16 service and adds a newest-major twin on :5434`, () => {
    const { prSmoke } = loadVersions();
    const j = job(ci(), id);
    const pg16 = mapUnder(j, 'postgres', 6);
    assert.equal(pg16?.image, 'postgres:16', 'the existing leg stays exactly as it was (W3 moves it)');
    const newest = mapUnder(j, 'postgres-newest', 6);
    assert.ok(newest, 'postgres-newest service missing');
    assert.equal(newest.image, `pgvector/pgvector:pg${prSmoke}`);
    const svc = (name) => block(j, name, 6);
    assert.deepEqual(mapUnder(svc('postgres-newest'), 'env', 8), mapUnder(svc('postgres'), 'env', 8),
      'the twin must use the same credentials as the 16 service');
    assert.deepEqual(listUnder(svc('postgres-newest'), 'ports', 8), ['5434:5432']);
    const options = (name) => svc(name).slice(svc(name).findIndex((l) => /^ {8}options:/.test(l)))
      .filter((l) => !isNoise(l)).join('\n');
    assert.equal(options('postgres-newest'), options('postgres'), 'same health options');
  });

  test(`${id}: every Postgres-N smoke step targets :5434, and its major is asserted first`, () => {
    const { prSmoke } = loadVersions();
    const j = job(ci(), id);
    const jobEnv = mapUnder(j, 'env', 4) ?? {};
    const all = steps(j);
    const smoke = all.filter((s) => PG_SMOKE_SUFFIX.test(s.name));
    assert.ok(smoke.length >= 2, `expected an assertion plus at least one smoke step, saw ${smoke.length}`);
    for (const s of smoke) assert.equal(PG_SMOKE_SUFFIX.exec(s.name)[1], prSmoke, `${s.name}: wrong major`);

    const [first, ...rest] = smoke;
    assert.equal(first.name, `Assert the server major (Postgres ${prSmoke})`, 'the assertion must be the first smoke step');
    assert.equal(stepRun(first), `        run: pnpm --filter @breeze/api exec tsx scripts/assert-postgres-major.ts ${prSmoke}`);
    assert.match(stepEnv(first).DATABASE_URL ?? '', /@localhost:5434\//);

    // A smoke step that left any job-level :5432 URL un-overridden would talk
    // to the 16 server while its name claims 18.
    const urlKeys = Object.keys(jobEnv).filter((k) => /@localhost:5432\//.test(jobEnv[k]));
    assert.ok(urlKeys.length > 0);
    for (const s of rest) {
      const env = stepEnv(s);
      for (const k of urlKeys) {
        assert.equal(env[k], jobEnv[k].replace('@localhost:5432/', '@localhost:5434/'), `${s.name}: ${k}`);
      }
      for (const [k, v] of Object.entries(env)) {
        assert.doesNotMatch(v, /:5432\//, `${s.name}: ${k} still points at the 16 server`);
      }
    }
  });
}

test('check-migrations: the Postgres-N migration and drift steps run exactly what the 16 steps run', () => {
  const { prSmoke } = loadVersions();
  const j = job(ci(), 'check-migrations');
  for (const base of ['Apply migrations against empty Postgres', 'Check for schema drift']) {
    assert.equal(stepRun(stepNamed(j, `${base} (Postgres ${prSmoke})`)), stepRun(stepNamed(j, base)), base);
  }
  // The RLS coverage contract on the newest major runs the integration job's command.
  assert.equal(
    stepRun(stepNamed(j, `Run RLS coverage contract test (Postgres ${prSmoke})`)),
    stepRun(stepNamed(job(ci(), 'integration-test'), 'Run RLS coverage contract test')),
  );
});

test('check-migrations-nonsuperuser: the Postgres-N step runs exactly what the 16 step runs', () => {
  const { prSmoke } = loadVersions();
  const j = job(ci(), 'check-migrations-nonsuperuser');
  const base = 'Apply migrations as a non-superuser role';
  assert.equal(stepRun(stepNamed(j, `${base} (Postgres ${prSmoke})`)), stepRun(stepNamed(j, base)));
});

test('ci.yml runs this contract in the lint job, before dependencies are installed', () => {
  const lint = steps(job(ci(), 'lint'));
  const at = lint.findIndex((s) => s.lines.some((l) => l.trim() === 'run: node --test .github/scripts/postgres-compat.test.mjs'));
  assert.ok(at !== -1, 'lint must run node --test .github/scripts/postgres-compat.test.mjs');
  assert.ok(at < lint.findIndex((s) => s.name === 'Install dependencies'), 'built-ins only: runs before pnpm install');
});

// ── postgres-compat.yml ─────────────────────────────────────────────────────

test('postgres-compat.yml exists alongside its script and version file', () => {
  for (const rel of [COMPAT_PATH, VERSIONS_PATH, './postgres-compat.mjs']) assert.ok(exists(rel), `${rel} missing`);
});

test('postgres-compat.yml: crons equal postgres-versions.json; dispatch and PR triggers are bounded', () => {
  const lines = compat().split('\n');
  const on = block(lines, 'on', 0);
  assert.ok(on, 'no on: block');
  const crons = on.map((l) => /^ {4}- cron:\s*'([^']+)'/.exec(l)?.[1]).filter(Boolean).sort();
  const v = loadVersions();
  assert.deepEqual(crons, Object.values(v.scheduled).map((e) => e.cron).sort());

  const options = listUnder(block(on, 'versions', 6), 'options', 8);
  assert.ok(options?.length, 'workflow_dispatch input `versions` needs choice options');
  const keys = Object.keys(v.scheduled);
  for (const opt of options) {
    for (const major of opt.split(',')) assert.ok(keys.includes(major), `dispatch option ${opt}: ${major} is not scheduled`);
  }
  assert.deepEqual([...new Set(options.flatMap((o) => o.split(',')))].sort(), [...keys].sort(), 'every scheduled major is dispatchable');

  const paths = listUnder(block(on, 'pull_request', 2), 'paths', 4);
  assert.deepEqual([...(paths ?? [])].sort(), [
    '.github/scripts/postgres-compat.mjs',
    '.github/scripts/postgres-versions.json',
    '.github/workflows/postgres-compat.yml',
  ], 'a PR runs the 17/18 matrix only when it edits this workflow, its script or its version list');
  assert.ok(!/^ {2}pull_request_target:/m.test(compat()), 'never pull_request_target');
});

test('postgres-compat.yml: read-only by default; only the notifier writes, and only on schedule', () => {
  const text = compat();
  const top = mapUnder(text.split('\n'), 'permissions', 0);
  assert.deepEqual(top, { contents: 'read' });
  assert.doesNotMatch(text, /secrets\./, 'runs on pull_request: no repository secret may be referenced');
  const notify = job(text, 'notify');
  assert.deepEqual(mapUnder(notify, 'permissions', 4), { contents: 'read', actions: 'read', issues: 'write' });
  const cond = (/^ {4}if:\s*(.+)$/m.exec(notify.join('\n')) || [])[1] ?? '';
  assert.match(cond, /always\(\)/);
  assert.match(cond, /github\.event_name == 'schedule'/);
  assert.match(cond, /github\.repository == 'LanternOps\/breeze'/);
  const writers = text.split('\n').filter((l) => /^\s+(issues|contents|actions|pull-requests): write/.test(l));
  assert.equal(writers.length, 1, 'issues: write on the notifier is the only write permission');
});

test('postgres-compat.yml: every test job runs the planned majors and asserts its server first', () => {
  const text = compat();
  for (const id of ['migrations', 'migrations-nonsuperuser', 'integration']) {
    const j = job(text, id);
    const body = j.join('\n');
    assert.match(body, /^ {4}needs: \[plan\]$/m, `${id}: needs plan`);
    assert.match(body, /^ {8}pg: \$\{\{ fromJSON\(needs\.plan\.outputs\.versions\) \}\}$/m, `${id}: matrix.pg from plan`);
    assert.match(body, /^ {4}name: .*\(Postgres \$\{\{ matrix\.pg \}\}[,)]/m, `${id}: job name must carry the major (the notifier groups by it)`);
    const all = steps(j);
    const assertAt = all.findIndex((s) => s.name === 'Assert the server major');
    assert.ok(assertAt !== -1, `${id}: no "Assert the server major" step`);
    assert.match(stepRun(all[assertAt]), /scripts\/assert-postgres-major\.ts "\$PG_MAJOR"$/);
    const pgMajor = stepEnv(all[assertAt]).PG_MAJOR ?? mapUnder(j, 'env', 4)?.PG_MAJOR;
    assert.equal(pgMajor, '${{ matrix.pg }}', `${id}: PG_MAJOR must come from the matrix`);
    // Never an inline matrix expression in a run block (zizmor template-injection).
    for (const s of all) {
      const run = block(s.lines, 'run', 8)?.join('\n') ?? '';
      assert.doesNotMatch(run, /\$\{\{\s*(matrix\.pg|needs\.|inputs\.|github\.event\.)/, `${id}: "${s.name}" interpolates an untrusted value into run:`);
    }
    const firstTest = all.findIndex((s) => /check:migrations|db:check-drift|test:integration|retry-shard/.test(s.lines.join('\n')));
    assert.ok(firstTest > assertAt, `${id}: the version assertion must precede every test step`);
  }
});

test('postgres-compat.yml: the migration jobs mirror ci.yml with the matrix image', () => {
  const text = compat();
  const pairs = [
    ['migrations', 'check-migrations', ['Apply migrations against empty Postgres', 'Check for schema drift']],
    ['migrations-nonsuperuser', 'check-migrations-nonsuperuser', ['Apply migrations as a non-superuser role']],
  ];
  for (const [nightlyId, ciId, stepNames] of pairs) {
    const n = job(text, nightlyId);
    const c = job(ci(), ciId);
    assert.deepEqual(mapUnder(n, 'env', 4), mapUnder(c, 'env', 4), `${nightlyId}: job env must equal ci.yml ${ciId}`);
    const nSvc = mapUnder(n, 'postgres', 6);
    assert.equal(nSvc?.image, 'pgvector/pgvector:pg${{ matrix.pg }}');
    assert.deepEqual(mapUnder(block(n, 'postgres', 6), 'env', 8), mapUnder(block(c, 'postgres', 6), 'env', 8));
    assert.deepEqual(listUnder(block(n, 'postgres', 6), 'ports', 8), listUnder(block(c, 'postgres', 6), 'ports', 8));
    for (const s of stepNames) assert.equal(normalized(stepNamed(n, s)), normalized(stepNamed(c, s)), `${nightlyId}: ${s}`);
  }
});

// The nightly's integration job is ci.yml's integration-test with three
// declared differences, and nothing else:
//   1. no "Fetch base commit" step (no base: the nightly quarantines nothing);
//   2. an "Assert the server major" step after the stack starts;
//   3. labels and artifact names carry the major, so the 17 and 18 legs of
//      one run never collide on `flake-report-integration-<shard>`. In `run:`
//      the major is `$PG_MAJOR` (job env), never `${{ matrix.pg }}`: the matrix
//      comes from a job output, which zizmor treats as injectable.
const CI_ONLY_STEPS = ['Fetch base commit for the flaky ledger'];
const NIGHTLY_ONLY_STEPS = ['Assert the server major'];
const relabel = (s) => s
  .replaceAll('--label integration-${{ matrix.shard }}', '--label integration-pg${PG_MAJOR}-${{ matrix.shard }}')
  .replaceAll('flake-report-integration-${{ matrix.shard }}', 'flake-report-integration-pg${{ matrix.pg }}-${{ matrix.shard }}');

test('postgres-compat.yml integration: step-for-step parity with ci.yml integration-test', () => {
  const c = steps(job(ci(), 'integration-test')).filter((s) => !CI_ONLY_STEPS.includes(s.name));
  const n = steps(job(compat(), 'integration')).filter((s) => !NIGHTLY_ONLY_STEPS.includes(s.name));
  assert.deepEqual(n.map((s) => s.name), c.map((s) => s.name), 'same steps, same order');
  for (let i = 0; i < c.length; i += 1) {
    assert.equal(normalized(n[i]), relabel(normalized(c[i])), `step "${c[i].name}" drifted from ci.yml`);
  }
  // Every CI_ONLY / NIGHTLY_ONLY name must still exist, or the exemption is stale.
  for (const name of CI_ONLY_STEPS) stepNamed(job(ci(), 'integration-test'), name);
  for (const name of NIGHTLY_ONLY_STEPS) stepNamed(job(compat(), 'integration'), name);
});

test('postgres-compat.yml integration: same shards, a timeout at least ci.yml\'s, bounded concurrency', () => {
  const c = job(ci(), 'integration-test');
  const n = job(compat(), 'integration');
  const shardsOf = (j) => (/^ {8}shard:\s*(\[.*\])$/m.exec(j.join('\n')) || [])[1];
  assert.ok(shardsOf(c));
  assert.equal(shardsOf(n), shardsOf(c));
  const timeout = (j) => Number((/^ {4}timeout-minutes:\s*(\d+)$/m.exec(j.join('\n')) || [])[1]);
  assert.ok(timeout(n) >= timeout(c), `nightly timeout ${timeout(n)} < ci.yml ${timeout(c)}`);
  const body = n.join('\n');
  assert.match(body, /^ {6}fail-fast: false$/m);
  const maxParallel = Number((/^ {6}max-parallel:\s*(\d+)$/m.exec(body) || [])[1]);
  assert.ok(maxParallel >= 1 && maxParallel <= 8, `max-parallel ${maxParallel}: the nightly must never hold more than 8 runners`);
  const env = mapUnder(n, 'env', 4);
  assert.deepEqual(env, { BREEZE_TEST_PG_IMAGE: 'pgvector/pgvector:pg${{ matrix.pg }}', PG_MAJOR: '${{ matrix.pg }}' },
    'the image comes from the matrix; no CI_BASE_SHA, so nothing is quarantined');
});

// ── postgres-compat.mjs ─────────────────────────────────────────────────────

const lib = () => import('./postgres-compat.mjs');

test('planVersions: schedule → the major whose cron fired; dispatch → its input; PR → every scheduled major', async () => {
  const { planVersions } = await lib();
  const config = {
    default: '16',
    prSmoke: '18',
    scheduled: { 18: { cadence: 'daily', cron: '53 3 * * *' }, 17: { cadence: 'weekly', cron: '53 4 * * 0' } },
  };
  assert.deepEqual(planVersions({ eventName: 'schedule', schedule: '53 3 * * *', config }), ['18']);
  assert.deepEqual(planVersions({ eventName: 'schedule', schedule: '53 4 * * 0', config }), ['17']);
  assert.throws(() => planVersions({ eventName: 'schedule', schedule: '0 0 * * *', config }), /no scheduled major/);
  assert.deepEqual(planVersions({ eventName: 'workflow_dispatch', input: '18', config }), ['18']);
  assert.deepEqual(planVersions({ eventName: 'workflow_dispatch', input: '18,17', config }), ['17', '18']);
  assert.deepEqual(planVersions({ eventName: 'workflow_dispatch', input: ' 17 , 17 ', config }), ['17']);
  assert.throws(() => planVersions({ eventName: 'workflow_dispatch', input: '19', config }), /not a scheduled major/);
  assert.throws(() => planVersions({ eventName: 'workflow_dispatch', input: '', config }), /no versions/);
  assert.deepEqual(planVersions({ eventName: 'pull_request', config }), ['17', '18']);
  assert.throws(() => planVersions({ eventName: 'push', config }), /unsupported event/);
});

test('planVersions accepts the committed postgres-versions.json', async () => {
  const { planVersions } = await lib();
  const config = loadVersions();
  for (const [major, { cron }] of Object.entries(config.scheduled)) {
    assert.deepEqual(planVersions({ eventName: 'schedule', schedule: cron, config }), [major]);
  }
});

test('summarizeRun groups job conclusions by the major in the job name', async () => {
  const { summarizeRun } = await lib();
  const jobs = [
    { name: 'Plan Postgres versions', conclusion: 'success' },
    { name: 'Migrations (Postgres 18)', conclusion: 'success' },
    { name: 'Migrations, non-superuser (Postgres 18)', conclusion: 'success' },
    { name: 'Integration (Postgres 18, shard 1/16)', conclusion: 'failure' },
    { name: 'Integration (Postgres 18, shard 2/16)', conclusion: 'cancelled' },
    { name: 'Integration (Postgres 18, shard 3/16)', conclusion: 'success' },
    { name: 'Migrations (Postgres 17)', conclusion: 'success' },
    { name: 'Integration (Postgres 17, shard 1/16)', conclusion: 'success' },
    { name: 'File or close the postgres-compat issues', conclusion: null },
  ];
  assert.deepEqual(summarizeRun(jobs, ['17', '18', '19']), [
    { version: '17', state: 'green', failed: [], total: 2 },
    {
      version: '18',
      state: 'failing',
      // A timeout reports as cancelled, so it counts as a failure.
      failed: ['Integration (Postgres 18, shard 1/16)', 'Integration (Postgres 18, shard 2/16)'],
      total: 5,
    },
    // No job ran for 19 (e.g. the matrix never expanded): no signal either way.
    { version: '19', state: 'no-signal', failed: [], total: 0 },
  ]);
  // A skipped leg is neither green nor failing.
  assert.equal(summarizeRun([
    { name: 'Migrations (Postgres 18)', conclusion: 'success' },
    { name: 'Integration (Postgres 18, shard 1/16)', conclusion: 'skipped' },
  ], ['18'])[0].state, 'no-signal');
});

test('planIssueActions: open or comment on a failing major, close a green one, leave the rest', async () => {
  const { planIssueActions, issueTitle } = await lib();
  const runUrl = 'https://example.invalid/run/1';
  const open = [{ number: 41, title: issueTitle('17') }, { number: 7, title: 'unrelated' }];
  const actions = planIssueActions({
    summary: [
      { version: '17', state: 'failing', failed: ['Migrations (Postgres 17)'], total: 3 },
      { version: '18', state: 'failing', failed: ['Integration (Postgres 18, shard 4/16)'], total: 18 },
    ],
    openIssues: open,
    runUrl,
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => [a.kind, a.number ?? a.title]), [['comment', 41], ['create', issueTitle('18')]]);
  assert.match(actions[0].body, /Still failing/);
  assert.match(actions[1].body, /Integration \(Postgres 18, shard 4\/16\)/);
  for (const a of actions) assert.ok(a.body.includes(runUrl));

  const healed = planIssueActions({
    summary: [
      { version: '17', state: 'green', failed: [], total: 18 },
      { version: '18', state: 'green', failed: [], total: 18 },
      { version: '19', state: 'no-signal', failed: [], total: 0 },
    ],
    openIssues: open,
    runUrl,
  });
  assert.deepEqual(healed.map((a) => [a.kind, a.number]), [['close', 41]], 'only the open 17 issue closes; no-signal does nothing');
});

test('planIssueActions: a failed plan job files the workflow-level issue', async () => {
  const { planIssueActions, WORKFLOW_ISSUE_TITLE } = await lib();
  const actions = planIssueActions({ summary: [], planFailed: true, openIssues: [], runUrl: 'u' });
  assert.deepEqual(actions.map((a) => [a.kind, a.title]), [['create', WORKFLOW_ISSUE_TITLE]]);
});

// The notifier is a reporter, not a gate (ci.yml main-red-alert discipline):
// reads retry, writes get exactly one attempt, and a failed read never turns
// into "nothing is open" (that would open a duplicate issue every red night).
function fakeGh(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    const r = responses[key];
    const next = Array.isArray(r) ? r.shift() : r;
    if (next instanceof Error) throw next;
    return next ?? '';
  };
  return { calls, run };
}

const NOTIFY_ENV = {
  GH_REPO: 'LanternOps/breeze',
  RUN_ID: '123',
  RUN_ATTEMPT: '1',
  RUN_URL: 'https://example.invalid/run/123',
  VERSIONS: '["18"]',
  PLAN_RESULT: 'success',
};
const quiet = { log: () => {}, error: () => {}, summary: () => {} };

test('notify: a failing major with no open issue gets one issue; label creation errors are ignored', async () => {
  const { notify, issueTitle } = await lib();
  const gh = fakeGh({
    'label create': new Error('already exists'),
    'api --paginate': 'Migrations (Postgres 18)\tsuccess\nIntegration (Postgres 18, shard 1/16)\tfailure\n',
    'issue list': '[]',
  });
  const code = await notify({ env: NOTIFY_ENV, runGh: gh.run, sleep: async () => {}, out: quiet });
  assert.equal(code, 0);
  const creates = gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'create');
  assert.equal(creates.length, 1);
  assert.ok(creates[0].includes(issueTitle('18')));
  assert.ok(creates[0].includes('postgres-compat'));
});

test('notify: retries reads, and an unreadable issue list writes nothing', async () => {
  const { notify } = await lib();
  const fail = () => new Error('HTTP 503');
  const gh = fakeGh({
    'api --paginate': [fail(), 'Integration (Postgres 18, shard 1/16)\tfailure\n'],
    'issue list': [fail(), fail(), fail()],
  });
  const errors = [];
  const code = await notify({ env: NOTIFY_ENV, runGh: gh.run, sleep: async () => {}, out: { ...quiet, error: (m) => errors.push(m) } });
  assert.equal(code, 0, 'a notifier never reddens the run on an API outage');
  assert.equal(gh.calls.filter((a) => a[0] === 'api').length, 2, 'the jobs read was retried');
  assert.equal(gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'list').length, 3);
  assert.equal(gh.calls.filter((a) => a[0] === 'issue' && a[1] !== 'list').length, 0, 'no write after a failed read');
  assert.ok(errors.some((m) => /could not read/i.test(m)));
});

test('notify: a failed write is attempted once, reported, and does not stop the next major', async () => {
  const { notify, issueTitle } = await lib();
  const gh = fakeGh({
    'api --paginate': 'Integration (Postgres 17, shard 1/16)\tfailure\nIntegration (Postgres 18, shard 1/16)\tsuccess\n',
    'issue list': JSON.stringify([{ number: 9, title: issueTitle('18') }]),
    'issue create': new Error('HTTP 502'),
  });
  const errors = [];
  const code = await notify({
    env: { ...NOTIFY_ENV, VERSIONS: '["17","18"]' },
    runGh: gh.run,
    sleep: async () => {},
    out: { ...quiet, error: (m) => errors.push(m) },
  });
  assert.equal(code, 0);
  assert.equal(gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'create').length, 1, 'never retry a write');
  assert.equal(gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'close' && a[2] === '9').length, 1, 'the green 18 still closes');
  assert.ok(errors.some((m) => /failed to open/i.test(m)));
});
