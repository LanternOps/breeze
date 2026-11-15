import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LEDGER_PATH } from '../../.github/scripts/flaky-ledger.mjs';
import { createWorld } from './fake-world.mjs';
import { createGitHub } from './github.mjs';
import { LEDGER_BRANCH_PREFIX, ledgerPrTick, readMainLedger, renderLedgerPr } from './ledger-pr.mjs';
import { createWriter, gitCli, readOnlyGitHub } from './writer.mjs';

// The rolling ledger PR (W06c C3, #10750): a temp git repo stands in for the
// shepherd's own clone, a fake world for GitHub and the gh CLI.

const REPO = 'LanternOps/breeze';
const TODAY = '2026-11-14';
const BRANCH = `${LEDGER_BRANCH_PREFIX}${TODAY}`;
const ID = 'src/components/psa/PsaConnectionsPage.test.tsx > PsaConnectionsPage > POSTs ownerScope:partner';
const FILE = 'apps/web/src/components/psa/PsaConnectionsPage.test.tsx';
const ENTRY = { id: ID, runner: 'vitest-web', file: FILE, issue: 900, added: TODAY, expires: '2026-11-28' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const proposal = (over = {}) => ({
  next: [ENTRY],
  add: [ENTRY],
  renew: [],
  remove: [],
  fixRequired: [],
  waitingIssue: [],
  evidence: { [`vitest-web|${ID}`]: { sightings7: 3, kinds: { fail_pass: 1, fail_fail: 1, fail_other: 1 }, prs: 2 } },
  ...over,
});

// origin (bare) with main holding an empty ledger; `checkout` = the
// shepherd's clone, detached at origin/main as run.sh leaves it.
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'ci-shepherd-ledger-pr-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  for (const cwd of [seed]) {
    git(cwd, 'config', 'user.name', 'test');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
  }
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
  return { root, origin, checkout };
}

function setup({ mode = 'act' } = {}) {
  const world = createWorld();
  const gh = createGitHub({ token: 't', fetchImpl: world.fetchImpl, budget: 100_000 });
  const r = repos();
  const writer = mode === 'act' ? createWriter({ gh, exec: world.exec, git: gitCli, repo: REPO }) : null;
  const run = (over = {}) =>
    ledgerPrTick({ gh: mode === 'act' ? gh : readOnlyGitHub(gh), git: gitCli, writer, checkoutDir: r.checkout, repo: REPO, proposal: proposal(), today: TODAY, mode, modeNow: async () => mode, ...over });
  return { world, gh, ...r, run };
}

const branches = (origin) => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

test('a proposal gives one commit with the exact expected JSON, a PR and auto-merge', async () => {
  const env = setup();
  const res = await env.run();
  assert.equal(res.status, 'opened');
  assert.deepEqual(branches(env.origin).sort(), [BRANCH, 'main']);
  assert.equal(git(env.origin, 'show', `${BRANCH}:${LEDGER_PATH}`) + '\n', `${JSON.stringify([ENTRY], null, 2)}\n`);
  assert.equal(git(env.origin, 'rev-list', '--count', `main..${BRANCH}`), '1');
  assert.equal(git(env.origin, 'log', '-1', '--format=%s', BRANCH), 'ci(flaky-ledger): 1 add, 0 renew, 0 remove (shepherd)');
  const created = env.world.writes.filter((w) => w.op === 'pr_create');
  assert.equal(created.length, 1);
  assert.equal(created[0].head, BRANCH);
  assert.equal(res.pr, created[0].pr);
  assert.deepEqual(env.world.execs.filter((a) => a[1] === 'merge'), [['pr', 'merge', String(res.pr), '--auto', '-R', REPO]]);
  // The temporary worktree is gone; the clone is still detached at main.
  assert.equal(git(env.checkout, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  assert.equal(git(env.checkout, 'rev-parse', 'HEAD'), git(env.origin, 'rev-parse', 'main'));
});

test('a mixed proposal writes exactly `next` (hand-written fields kept) and touches only the ledger', async () => {
  const env = setup();
  const kept = { id: 'src/z.test.ts > z', runner: 'vitest-api', file: 'apps/api/src/z.test.ts', issue: 5, added: '2026-11-10', expires: '2026-11-24', covers: ['apps/api/src/z'] };
  const renewed = { id: 'src/y.test.ts > y', runner: 'vitest-api', file: 'apps/api/src/y.test.ts', issue: 6, added: TODAY, expires: '2026-11-28' };
  const removed = { id: 'src/w.test.ts > w', runner: 'vitest-api', file: 'apps/api/src/w.test.ts', issue: 7, added: '2026-10-01', expires: '2026-10-15' };
  const next = [kept, renewed, ENTRY].sort((a, b) => (a.runner === b.runner ? (a.id < b.id ? -1 : 1) : a.runner < b.runner ? -1 : 1));
  const res = await env.run({ proposal: proposal({ next, add: [ENTRY], renew: [renewed], remove: [removed] }) });
  assert.equal(res.status, 'opened');
  assert.deepEqual(JSON.parse(git(env.origin, 'show', `${BRANCH}:${LEDGER_PATH}`)), next);
  assert.equal(git(env.origin, 'diff', '--name-only', `main..${BRANCH}`), LEDGER_PATH);
  assert.equal(git(env.origin, 'log', '-1', '--format=%s', BRANCH), 'ci(flaky-ledger): 1 add, 1 renew, 1 remove (shepherd)');
  const body = env.world.writes.find((w) => w.op === 'pr_create').body;
  for (const change of ['add', 'renew', 'remove']) assert.match(body, new RegExp(`\\| ${change} \\|`));
});

test('an open ledger PR gives waiting and no git write', async () => {
  const env = setup();
  env.world.addPr(500, { headRef: `${LEDGER_BRANCH_PREFIX}2026-11-13` });
  const res = await env.run();
  assert.deepEqual(res, { status: 'waiting', pr: 500 });
  assert.deepEqual(branches(env.origin), ['main']);
  assert.deepEqual(env.world.execs, []);
  assert.deepEqual(env.world.writeCalls(), []);
});

test("a fork PR on a ledger-named branch is not the shepherd's", async () => {
  const env = setup();
  env.world.addPr(501, { headRef: `${LEDGER_BRANCH_PREFIX}2026-11-13`, isFork: true });
  assert.equal((await env.run()).status, 'opened');
});

test("today's ledger PR closed by a human is not reopened today", async () => {
  const env = setup();
  env.world.addPr(502, { headRef: BRANCH, state: 'CLOSED' });
  const res = await env.run();
  assert.equal(res.status, 'done_today');
  assert.deepEqual(branches(env.origin), ['main']);
  assert.deepEqual(env.world.execs, []);
});

test('the body matches no closing keyword, even when a test id carries one', async () => {
  const nasty = { ...ENTRY, id: 'src/components/psa/PsaConnectionsPage.test.tsx > fixes #12 for @someone' };
  const p = proposal({ next: [nasty], add: [nasty], evidence: {} });
  const { body, title } = renderLedgerPr(p);
  for (const text of [body, title]) {
    assert.doesNotMatch(text, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i);
    assert.doesNotMatch(text, /@\w/);
  }
  assert.match(body, /Refs #10750/);
  assert.match(body, /touches/i, 'states the touch exemption');
  assert.match(body, /\| add \|/);
});

test('an empty proposal gives noop and no call at all', async () => {
  const env = setup();
  const res = await env.run({ proposal: proposal({ next: [], add: [], evidence: {} }) });
  assert.deepEqual(res, { status: 'noop' });
  assert.deepEqual(env.world.calls, []);
  assert.deepEqual(branches(env.origin), ['main']);
});

test('shadow mode makes no call and no git write, and says what it would open', async () => {
  const env = setup({ mode: 'shadow' });
  const res = await env.run();
  assert.equal(res.status, 'shadow');
  assert.equal(res.branch, BRANCH);
  assert.match(res.title, /1 add/);
  assert.deepEqual(env.world.calls, []);
  assert.deepEqual(branches(env.origin), ['main']);
});

test('leaving act before the push stops with partial and pushes nothing', async () => {
  const env = setup();
  const res = await env.run({ modeNow: async () => 'shadow' });
  assert.equal(res.status, 'partial');
  assert.deepEqual(branches(env.origin), ['main']);
  assert.deepEqual(env.world.execs, []);
});

test("someone else's branch under today's name is an error, never overwritten, and leaves no worktree", async () => {
  const env = setup();
  // Someone else's commit already sits on today's branch.
  const other = join(env.root, 'other');
  git(env.root, 'clone', '--quiet', env.origin, other);
  git(other, 'config', 'user.name', 'x');
  git(other, 'config', 'user.email', 'x@example.invalid');
  writeFileSync(join(other, 'x.txt'), 'x\n');
  git(other, 'add', 'x.txt');
  git(other, 'commit', '--quiet', '-m', 'x');
  git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`);
  await assert.rejects(env.run(), /already exists with other content/);
  assert.equal(git(env.origin, 'log', '-1', '--format=%s', BRANCH), 'x', 'never forced');
  assert.equal(git(env.checkout, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  assert.deepEqual(env.world.writes.filter((w) => w.op === 'pr_create'), []);
});

test('a crash between the push and the PR is resumed by the next tick, with no second push', async () => {
  const env = setup();
  env.world.failOnce('pr_create');
  await assert.rejects(env.run(), /502/);
  assert.deepEqual(branches(env.origin).sort(), [BRANCH, 'main']);
  const head = git(env.origin, 'rev-parse', BRANCH);
  const res = await env.run();
  assert.equal(res.status, 'opened');
  assert.equal(res.resumed, true);
  assert.equal(git(env.origin, 'rev-parse', BRANCH), head, 'the branch was not pushed again');
  assert.equal(env.world.writes.filter((w) => w.op === 'pr_create').length, 1);
  // A different proposal on the same day does not reuse that branch.
  env.world.prs.get(res.pr).state = 'CLOSED';
  assert.equal((await env.run({ proposal: proposal({ add: [], next: [], remove: [ENTRY] }) })).status, 'done_today');
});

test('a PR whose URL was lost is found by its head and gets its auto-merge', async () => {
  const env = setup();
  const exec = (args) => {
    const out = env.world.exec(args);
    return args[1] === 'create' ? 'something unexpected' : out;
  };
  const writer = createWriter({ gh: env.gh, exec, git: gitCli, repo: REPO });
  const res = await env.run({ writer });
  assert.equal(res.status, 'opened');
  const created = env.world.writes.find((w) => w.op === 'pr_create');
  assert.equal(res.pr, created.pr);
  assert.ok(env.world.execs.some((a) => a[1] === 'merge' && a[2] === String(created.pr)));
});

test('an orphan branch with other content is reported, not reused', async () => {
  const env = setup();
  env.world.failOnce('pr_create');
  await assert.rejects(env.run(), /502/);
  const other = { ...ENTRY, expires: '2026-11-27' };
  await assert.rejects(env.run({ proposal: proposal({ next: [other], add: [other] }) }), /already exists with other content/);
  assert.deepEqual(env.world.writes.filter((w) => w.op === 'pr_create'), []);
});

test('the main ledger and file checks read origin/main in the clone', () => {
  const r = repos();
  const main = readMainLedger(gitCli, r.checkout);
  assert.deepEqual(main.ledger, []);
  assert.equal(main.fileExists(FILE), true);
  assert.equal(main.fileExists('apps/web/src/nope.test.tsx'), false);
  assert.equal(main.fileExists('../outside'), false);
});
