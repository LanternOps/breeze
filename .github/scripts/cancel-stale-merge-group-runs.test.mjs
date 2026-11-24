import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cancelStaleMergeGroupRuns } from './cancel-stale-merge-group-runs.mjs';

const REPO = 'o/r';

// Fake GitHub API. `refs` = branches that exist; `runs` = unfinished runs per status.
function fakeApi({ runs = {}, refs = new Set(), refError = {}, cancelFails = new Set(), cancelStatus = 500 } = {}) {
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
      if (cancelFails.has(Number(c[1]))) return { status: cancelStatus, body: {} };
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

test('ref lookup 403/429 or a thrown error never cancels', async () => {
  for (const mode of [403, 429, 'throw']) {
    const base = fakeApi({ runs: { queued: [run(1, 'b')] }, refError: mode === 'throw' ? {} : { b: mode } });
    const api = async (m, p) => {
      if (mode === 'throw' && p.includes('/git/ref/')) throw new Error('network');
      return base.api(m, p);
    };
    const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
    assert.deepEqual(base.cancelled, [], String(mode));
    assert.equal(res.errors, 1);
  }
});

// Stacked pull requests: each PR in a stack is its own queue entry, chained on the
// previous entry's head. When a mid-stack entry fails, it and every entry above it
// leave the queue at once, and their refs go together.
const queueRef = (pr, base) => `gh-readonly-queue/main/pr-${pr}-${base.repeat(40)}`;

test('stack: entries removed together are each cancelled, every workflow on them, and a live entry is kept', async () => {
  const lookups = [];
  const failed = queueRef(15, 'a'), above = queueRef(16, 'b'), live = queueRef(30, 'c');
  const base = fakeApi({
    // CI, CI Gate and the janitor itself start a merge_group run per entry.
    runs: { queued: [run(1, above), run(2, above)], in_progress: [run(3, failed), run(4, failed), run(5, above), run(6, live), run(7, live)] },
    refs: new Set([live]),
  });
  const api = async (m, p) => { if (p.includes('/git/ref/')) lookups.push(p); return base.api(m, p); };
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(base.cancelled.sort((x, y) => x - y), [1, 2, 3, 4, 5]);
  assert.deepEqual([res.inspected, res.cancelled, res.errors], [7, 5, 0]);
  assert.equal(lookups.length, 3, 'one lookup per ref, however many entries leave at once');
});

test('stack: a survivor re-queued under the same ref name keeps the old runs; a live ref is never a cancel', async () => {
  // The rebuilt entry has a new head but the same PR and base, so the same ref name.
  // The janitor reads only the ref's existence, so it errs toward not cancelling.
  const reused = queueRef(16, 'a');
  const { api, cancelled } = fakeApi({ runs: { in_progress: [run(1, reused), run(2, reused)] }, refs: new Set([reused]) });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.deepEqual(cancelled, []);
  assert.deepEqual([res.cancelled, res.errors], [0, 0]);
});

test('cancel returning 409 (already finished) is benign, not an error', async () => {
  const { api } = fakeApi({ runs: { queued: [run(1, 'gone')] }, cancelFails: new Set([1]), cancelStatus: 409 });
  const res = await cancelStaleMergeGroupRuns({ api, repo: REPO, log });
  assert.equal(res.errors, 0);
  assert.equal(res.cancelled, 0);
});
