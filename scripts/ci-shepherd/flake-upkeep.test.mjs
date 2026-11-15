import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LEDGER_PATH } from '../../.github/scripts/flaky-ledger.mjs';
import { FLAKE_LABEL, parseFlakeIssue } from './flake-issues.mjs';
import { proposalRecords } from './flake-upkeep.mjs';
import { createWorld } from './fake-world.mjs';
import { createGitHub } from './github.mjs';
import { LEDGER_BRANCH_PREFIX } from './ledger-pr.mjs';
import { REPO_ROOT } from './shepherd.mjs';
import { readJsonl } from './state.mjs';
import { tick } from './tick.mjs';

// The W06c hook in the tick (#10750): flaky-test issues, proposals and the
// rolling ledger PR, end to end against the stateful fake and a temp clone.

const REPO = 'LanternOps/breeze';
const T0 = Date.parse('2026-11-08T12:00:00Z');
const H = 3600_000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ID = 'src/components/psa/PsaConnectionsPage.test.tsx > PsaConnectionsPage > POSTs ownerScope:partner';
const FILE = 'apps/web/src/components/psa/PsaConnectionsPage.test.tsx';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const sighting = (over = {}) => ({ runner: 'vitest-web', id: ID, file: FILE, kind: 'fail_pass', run: 1, attempt: 1, job: 'Test Web (shard 3/4)', pr: 11312, event: 'pull_request', sha: 'a'.repeat(40), at: iso(T0 - 2 * H), ...over });
// Corroborated: 3 runs, 2 PRs, one in the queue, one fail_other.
const CORROBORATED = [sighting({ run: 1 }), sighting({ run: 2, pr: 11338, kind: 'fail_other' }), sighting({ run: 3, pr: 11338, event: 'merge_group', kind: 'fail_fail' })];

function clone() {
  const root = mkdtempSync(join(tmpdir(), 'ci-shepherd-upkeep-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(join(seed, '.github'), { recursive: true });
  writeFileSync(join(seed, LEDGER_PATH), '[]\n');
  mkdirSync(join(seed, 'apps/web/src/components/psa'), { recursive: true });
  writeFileSync(join(seed, FILE), 'test\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '--quiet', 'origin', 'main');
  git(root, 'clone', '--quiet', origin, checkout);
  git(checkout, 'config', 'user.name', 'shepherd');
  git(checkout, 'config', 'user.email', 'shepherd@example.invalid');
  git(checkout, 'checkout', '--quiet', '--detach', 'origin/main');
  return { origin, checkout };
}

function setup({ mode = 'act', sightings = CORROBORATED } = {}) {
  const world = createWorld({ mode, now: T0 });
  const gh = createGitHub({ token: 't', fetchImpl: world.fetchImpl, budget: 100_000 });
  const stateDir = mkdtempSync(join(tmpdir(), 'ci-shepherd-upkeep-state-'));
  writeFileSync(join(stateDir, 'sightings.jsonl'), sightings.map((s) => `${JSON.stringify(s)}\n`).join(''));
  const repos = clone();
  const run = (over = {}) => tick({ gh, repo: REPO, stateDir, checkoutDir: repos.checkout, now: world.clock, clock: () => world.clock, exec: world.exec, repoRoot: REPO_ROOT, log: () => {}, ...over });
  const decisions = () => readJsonl(join(stateDir, 'decisions.jsonl'));
  const state = () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
  const ledgerBranches = () => git(repos.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((b) => b.startsWith(LEDGER_BRANCH_PREFIX));
  return { world, gh, stateDir, run, decisions, state, ledgerBranches, ...repos };
}

test('shadow: no write, no push; it logs the issue and the ledger PR it would make, once a day', async () => {
  for (const mode of [null, 'shadow']) {
    const env = setup({ mode });
    const s1 = await env.run();
    assert.equal(s1.status, 'ok', JSON.stringify(s1.errors));
    assert.deepEqual(env.world.writeCalls(), []);
    assert.deepEqual(env.world.execs, []);
    assert.deepEqual(env.ledgerBranches(), []);
    const flake = env.decisions().filter((d) => d.source === 'flake');
    assert.deepEqual(flake.map((d) => d.kind).sort(), ['flake_issue_create', 'ledger_add_waiting_issue']);
    for (const d of flake) assert.equal(d.status, 'shadow');
    await env.run();
    assert.equal(env.decisions().filter((d) => d.source === 'flake').length, 2, 'not logged again the same day');
  }
});

test('shadow with an issue already open logs the ledger PR it would open, with the proposed entry', async () => {
  const env = setup({ mode: 'shadow' });
  const body = `x\n<!-- ci-shepherd:flake v1 ${JSON.stringify({ runner: 'vitest-web', id: ID, file: FILE, total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] })} -->\n`;
  env.world.issues.push({ number: 900, title: 't', body, labels: [FLAKE_LABEL], state: 'open', author: env.world.viewer });
  await env.run();
  const pr = env.decisions().find((d) => d.kind === 'ledger_pr');
  assert.ok(pr, JSON.stringify(env.decisions()));
  assert.equal(pr.status, 'shadow');
  assert.deepEqual(pr.mutations[0].args.add, [ID]);
  assert.deepEqual(env.world.writeCalls(), []);
});

test('act: one tick opens the issue, then the ledger PR quarantining the test for 14 days', async () => {
  const env = setup();
  const s = await env.run();
  assert.equal(s.status, 'ok', JSON.stringify(s.errors));
  assert.equal(env.world.issues.length, 1);
  const issue = env.world.issues[0];
  assert.deepEqual(parseFlakeIssue(issue.body).total, { fail_pass: 1, fail_fail: 1, fail_other: 1 });
  assert.deepEqual(env.ledgerBranches(), [`${LEDGER_BRANCH_PREFIX}2026-11-08`]);
  const ledger = JSON.parse(git(env.origin, 'show', `${LEDGER_BRANCH_PREFIX}2026-11-08:${LEDGER_PATH}`));
  assert.deepEqual(ledger, [{ id: ID, runner: 'vitest-web', file: FILE, issue: issue.number, added: '2026-11-08', expires: '2026-11-22' }]);
  const prCreate = env.world.writes.filter((w) => w.op === 'pr_create');
  assert.equal(prCreate.length, 1);
  assert.ok(env.world.execs.some((a) => a[1] === 'merge' && a[2] === String(prCreate[0].pr)), 'auto-merge requested');
  assert.deepEqual(s.sweeps.flake, { created: 1, updated: 0, ledger: 'opened' });

  // Later ticks: no second issue, no second PR (open → waiting, checked hourly).
  env.world.clock += 5 * 60_000;
  await env.run();
  env.world.clock += 61 * 60_000;
  const s3 = await env.run();
  assert.equal(s3.sweeps.flake.ledger, 'waiting');
  assert.equal(env.world.issues.length, 1);
  assert.equal(env.world.writes.filter((w) => w.op === 'pr_create').length, 1);
  assert.deepEqual(env.ledgerBranches(), [`${LEDGER_BRANCH_PREFIX}2026-11-08`]);
});

test('act: an issue whose create response was lost is found again, not opened twice', async () => {
  const env = setup({ sightings: CORROBORATED.slice(0, 2) });
  env.world.loseResponseOnce('issue_create');
  const s1 = await env.run();
  assert.equal(s1.status, 'degraded');
  assert.equal(env.world.issues.length, 1);
  assert.ok(Object.keys(env.state().flake.pending).length === 1, 'intent saved before the create');
  env.world.clock += 5 * 60_000;
  const s2 = await env.run();
  assert.equal(s2.status, 'ok', JSON.stringify(s2.errors));
  assert.equal(env.world.issues.length, 1, 'no duplicate');
  assert.deepEqual(env.state().flake.pending, {});
});

test('act: a create that failed outright is made on the next tick', async () => {
  const env = setup({ sightings: CORROBORATED.slice(0, 2) });
  env.world.failOnce('issue_create');
  await env.run();
  assert.equal(env.world.issues.length, 0);
  env.world.clock += 5 * 60_000;
  await env.run();
  assert.equal(env.world.issues.length, 1);
});

test('leaving act before the upkeep writes nothing for it', async () => {
  let reads = 0;
  // act for the tick's own reads, shadow from the upkeep's re-read on.
  const env = setup({ mode: () => (++reads <= 1 ? 'act' : 'shadow') });
  await env.run();
  assert.equal(env.world.issues.length, 0);
  assert.deepEqual(env.world.writes.filter((w) => ['issue_create', 'issue_edit', 'label_create', 'pr_create'].includes(w.op)), []);
  assert.deepEqual(env.ledgerBranches(), []);
});

test('without a checkout dir, act opens issues but no ledger PR, and says why', async () => {
  const env = setup();
  const s = await env.run({ checkoutDir: null });
  assert.equal(env.world.issues.length, 1);
  assert.deepEqual(env.ledgerBranches(), []);
  assert.equal(s.status, 'degraded');
  assert.match(s.errors.join('\n'), /no checkout dir/);
});

test('a lost flake-records.json is rebuilt from the issues before any proposal', async () => {
  const env = setup();
  await env.run();
  const issue = env.world.issues[0];
  // The issue says 50 days quarantined; locally the records file is gone.
  const rec = parseFlakeIssue(issue.body);
  issue.body = issue.body.replace(/"quarantine_days":\d+/, '"quarantine_days":50');
  assert.equal(parseFlakeIssue(issue.body).quarantine_days, 50);
  assert.equal(rec.quarantine_days, 0);
  writeFileSync(join(env.stateDir, 'flake-records.json'), '{}\n');
  env.world.clock += 5 * 60_000;
  await env.run();
  const records = JSON.parse(readFileSync(join(env.stateDir, 'flake-records.json'), 'utf8'));
  assert.equal(Object.values(records)[0].quarantine_days, 50);
});

test('a main_broken breaker on the test blocks its quarantine through the real tick wiring', async () => {
  for (const status of ['suspected', 'confirmed']) {
    const env = setup();
    const breaker = { kind: 'main_broken', key: ID, status, openedAt: iso(T0 - H), prs: [1, 2, 3], restore: [], ...(status === 'confirmed' ? { confirmedAt: iso(T0 - H) } : {}) };
    writeFileSync(join(env.stateDir, 'state.json'), `${JSON.stringify({ breakers: { breakers: [breaker], observations: [] } })}\n`);
    const s = await env.run();
    assert.equal(env.world.issues.length, 1, 'the issue is still opened');
    assert.deepEqual(env.ledgerBranches(), [], status);
    assert.deepEqual(env.world.writes.filter((w) => w.op === 'pr_create'), [], status);
    assert.equal(env.state().breakers.breakers.length, 1, `${status} breaker still open: ${JSON.stringify(s.errors)}`);
  }
});

const issueBody = (over = {}) => `x\n<!-- ci-shepherd:flake v1 ${JSON.stringify({ runner: 'vitest-web', id: ID, file: FILE, total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [], ...over })} -->\n`;

test('60 quarantine days: the issue gets flaky-fix-required once and no ledger PR opens', async () => {
  const env = setup();
  env.world.issues.push({ number: 900, title: 't', body: issueBody({ quarantine_days: 60, quarantine_through: '2026-11-01' }), labels: [FLAKE_LABEL], state: 'open', author: env.world.viewer });
  await env.run();
  assert.deepEqual(env.world.issues[0].labels, [FLAKE_LABEL, 'flaky-fix-required']);
  assert.deepEqual(env.world.writes.filter((w) => w.op === 'label_create').map((w) => w.name), ['flaky-fix-required']);
  assert.deepEqual(env.ledgerBranches(), []);
  env.world.clock += 5 * 60_000;
  await env.run();
  assert.equal(env.world.writes.filter((w) => w.op === 'label_add').length, 1, 'labelled once');
  // Shadow logs it once a day and writes nothing.
  const sh = setup({ mode: 'shadow' });
  sh.world.issues.push({ number: 900, title: 't', body: issueBody({ quarantine_days: 60, quarantine_through: '2026-11-01' }), labels: [FLAKE_LABEL], state: 'open', author: sh.world.viewer });
  await sh.run();
  await sh.run();
  assert.equal(sh.decisions().filter((d) => d.kind === 'flake_fix_required').length, 1);
  assert.deepEqual(sh.world.writeCalls(), []);
});

test('an auto-merge request that failed is made on a later tick, once', async () => {
  const env = setup();
  env.world.failOnce('enqueue');
  const s1 = await env.run();
  assert.equal(s1.status, 'degraded');
  const pr = env.world.writes.find((w) => w.op === 'pr_create').pr;
  assert.equal(env.state().flake.unenqueued, pr);
  env.world.clock += 61 * 60_000;
  const s2 = await env.run();
  assert.equal(s2.sweeps.flake.ledger, 'waiting');
  assert.equal(env.world.writes.filter((w) => w.op === 'enqueue' && w.pr === pr).length, 1);
  assert.equal(env.state().flake.unenqueued, null);
  env.world.clock += 61 * 60_000;
  await env.run();
  assert.equal(env.world.execs.filter((a) => a[1] === 'merge' && a[2] === String(pr)).length, 2, 'one failed try, one retry, no more');
});

test('an unreadable operator flaky-test issue blocks new issues and says so', async () => {
  const env = setup();
  env.world.issues.push({ number: 70, title: 't', body: 'a human rewrote this body', labels: [FLAKE_LABEL], state: 'open', author: env.world.viewer });
  const s = await env.run();
  assert.equal(env.world.issues.length, 1, 'no new issue');
  assert.equal(s.status, 'degraded');
  assert.match(s.errors.join('\n'), /listing is incomplete.*70/);
});

test('an issue closed since the last refresh stops the ledger PR that would cite it', async () => {
  const env = setup();
  const key = `vitest-web|${ID}`;
  env.world.issues.push({ number: 900, title: 't', body: issueBody(), labels: [FLAKE_LABEL], state: 'closed', closed_at: iso(T0 - 30_000), author: env.world.viewer });
  // The index, refreshed a minute ago, still has it open.
  writeFileSync(join(env.stateDir, 'state.json'), `${JSON.stringify({ flake: { refreshedAt: iso(T0 - 60_000), viewer: env.world.viewer, index: { [key]: { issue: 900, open: true, closedAt: null, labels: [FLAKE_LABEL], since: null } }, pending: {}, logged: {} } })}\n`);
  writeFileSync(join(env.stateDir, 'flake-records.json'), `${JSON.stringify({ [key]: parseFlakeIssue(issueBody()) })}\n`);
  await env.run();
  assert.deepEqual(env.ledgerBranches(), []);
  assert.deepEqual(env.world.writes.filter((w) => w.op === 'pr_create'), []);
  assert.equal(env.state().flake.index[key].open, false);
  // Control: the same state with the issue open does open the PR.
  const ok = setup();
  ok.world.issues.push({ number: 900, title: 't', body: issueBody(), labels: [FLAKE_LABEL], state: 'open', author: ok.world.viewer });
  writeFileSync(join(ok.stateDir, 'state.json'), `${JSON.stringify({ flake: { refreshedAt: iso(T0 - 60_000), viewer: ok.world.viewer, index: { [key]: { issue: 900, open: true, closedAt: null, labels: [FLAKE_LABEL], since: null } }, pending: {}, logged: {} } })}\n`);
  writeFileSync(join(ok.stateDir, 'flake-records.json'), `${JSON.stringify({ [key]: parseFlakeIssue(issueBody()) })}\n`);
  await ok.run();
  assert.equal(ok.ledgerBranches().length, 1);
});

test('a create GitHub refused (4xx) leaves no intent; a 5xx keeps it', async () => {
  const refused = setup({ sightings: CORROBORATED.slice(0, 2) });
  refused.world.refuseOnce('issue_create');
  await refused.run();
  assert.deepEqual(refused.state().flake.pending, {});
  const maybe = setup({ sightings: CORROBORATED.slice(0, 2) });
  maybe.world.failOnce('issue_create');
  await maybe.run();
  assert.equal(Object.keys(maybe.state().flake.pending).length, 1);
});

test('nothing to do costs no API call', async () => {
  const env = setup({ sightings: [] });
  await env.run();
  const mine = env.world.calls.filter((c) => /\/labels|\/pulls$/.test(c.path) || /flaky-test/.test(c.query ?? ''));
  assert.deepEqual(mine, []);
});

test("proposal records: a successor issue's evidence starts after the last close", () => {
  const key = `vitest-web|${ID}`;
  const index = { [key]: { issue: 2, open: true, closedAt: null, since: iso(T0 - 3 * H), labels: [] } };
  const recs = proposalRecords({ index, records: {}, sightings: [sighting({ run: 1, at: iso(T0 - 4 * H) }), sighting({ run: 2, at: iso(T0 - H) })], ledger: [], today: '2026-11-08' });
  assert.deepEqual(recs[0].sightings.map((s) => s.run), [2]);
  assert.equal(recs[0].issue, 2);
  const closed = proposalRecords({ index: { [key]: { issue: 1, open: false, closedAt: iso(T0 - 3 * H), labels: [] } }, records: {}, sightings: [sighting({ at: iso(T0 - 4 * H) })], ledger: [], today: '2026-11-08' });
  assert.deepEqual(closed[0].sightings, []);
  assert.equal(closed[0].issue, null);
});
