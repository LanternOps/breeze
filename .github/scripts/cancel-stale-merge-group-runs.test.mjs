import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cancelStaleMergeGroupRuns } from './cancel-stale-merge-group-runs.mjs';

const REPO = 'o/r';

// Fake GitHub API. `refs` = branches that exist; `runs` = unfinished runs per status.
function fakeApi({ runs = {}, refs = new Set(), refError = {}, cancelFails = new Set() } = {}) {
  const cancelled = [];
  const api = async (method, path) => {
    const m = path.match(/^repos\/o\/r\/actions\/runs\?event=merge_group&status=(\w+)&per_page=100&page=(\d+)$/);
    if (method === 'GET' && m) {
      const all = runs[m[1]] ?? [];
      const page = Number(m[2]);
      return { status: 200, body: { workflow_runs: all.slice((page - 1) * 100, page * 100) } };
    }
    const r = path.match(/^repos\/o\/r\/git\/ref\/heads\/(.+)$/);
    if (method === 'GET' && r) {
      const name = decodeURIComponent(r[1]);
      if (refError[name]) return { status: refError[name], body: {} };
      return refs.has(name) ? { status: 200, body: {} } : { status: 404, body: {} };
    }
    const c = path.match(/^repos\/o\/r\/actions\/runs\/(\d+)\/cancel$/);
    if (method === 'POST' && c) {
      if (cancelFails.has(Number(c[1]))) return { status: 500, body: {} };
      cancelled.push(Number(c[1]));
      return { status: 202, body: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, cancelled };
}

const run = (id, head_branch) => ({ id, head_branch });
const log = { info() {}, warn() {} };

test('live ref is kept, missing ref is cancelled', async () => {
  const { api, cancelled } = fakeApi({
    runs: { queued: [run(1, 'gh-readonly-queue/main/pr-1-aaa'), run(2, 'gh-readonly-queue/main/pr-2-bbb')], in_progress: [run(3, 'gh-readonly-queue/main/pr-3-ccc')] },
    refs: new Set(['gh-readonly-queue/main/pr-1-aaa']),
  });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled.sort(), [2, 3]);
  assert.equal(res.cancelled, 2);
  assert.equal(res.errors, 0);
});

test('ref lookup API error (non-404) never cancels', async () => {
  const { api, cancelled } = fakeApi({
    runs: { queued: [run(1, 'gh-readonly-queue/main/pr-1-aaa')] },
    refError: { 'gh-readonly-queue/main/pr-1-aaa': 500 },
  });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled, []);
  assert.equal(res.errors, 1);
});

test('run listing failure cancels nothing and reports an error', async () => {
  const cancelled = [];
  const api = async (method, path) => {
    if (method === 'POST') { cancelled.push(path); return { status: 202, body: {} }; }
    return { status: 500, body: {} };
  };
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled, []);
  assert.ok(res.errors > 0);
});

test('runs without a head_branch are skipped, not cancelled', async () => {
  const { api, cancelled } = fakeApi({ runs: { queued: [run(1, null), run(2, '')] } });
  await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled, []);
});

test('a failed cancel is counted and does not stop later cancels', async () => {
  const { api, cancelled } = fakeApi({
    runs: { queued: [run(1, 'x1'), run(2, 'x2')] },
    cancelFails: new Set([1]),
  });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled, [2]);
  assert.equal(res.errors, 1);
});

test('paginates beyond 100 runs', async () => {
  const many = Array.from({ length: 150 }, (_, i) => run(i + 1, `gone-${i + 1}`));
  const { api, cancelled } = fakeApi({ runs: { queued: many } });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.equal(cancelled.length, 150);
  assert.equal(res.cancelled, 150);
});

test('same ref is looked up once for multiple workflows', async () => {
  const lookups = [];
  const base = fakeApi({ runs: { queued: [run(1, 'b'), run(2, 'b')] }, refs: new Set(['b']) });
  const api = async (m, p) => { if (p.includes('/git/ref/')) lookups.push(p); return base.api(m, p); };
  await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.equal(lookups.length, 1);
  assert.deepEqual(base.cancelled, []);
});
