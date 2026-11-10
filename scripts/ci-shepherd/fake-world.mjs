// Test helper: a stateful fake of the GitHub API slice the shepherd uses
// (W06b, #10750). Unlike fake-github.mjs (recorded responses), this one keeps
// PRs, queue entries, runs, comments, labels and issues, and applies the
// shepherd's writes to them, so a test can run two ticks and look at what the
// first one left behind.
//
// Every request is in `calls` ({ method, path, query?, mutation }); writes are
// also in `writes`. `exec(args)` stands in for the `gh` CLI (enqueue, main CI
// dispatch) and is logged in `execs`. `failOnce(op)` makes the next write of
// that op answer 502 (`dequeue`, `comment_post`, …) — a crash mid-apply.

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createWorld({ repo = 'LanternOps/breeze', viewer = 'operator', mode = null, now = Date.parse('2026-11-08T12:00:00Z') } = {}) {
  const w = {
    repo,
    viewer,
    mode, // null → the variable is unset (404); a function → called per read
    clock: now,
    prs: new Map(),
    runs: [],
    issues: [],
    calls: [],
    writes: [],
    execs: [],
    failing: new Map(),
    nextId: 1000,
  };
  const id = () => w.nextId++;

  w.addPr = (n, over = {}) => {
    const pr = {
      number: n,
      id: `PR_${n}`,
      state: 'OPEN',
      headSha: `${String(n).padStart(8, '0')}${'a'.repeat(32)}`,
      headPushedAt: '2026-11-08T08:00:00Z',
      isFork: false,
      autoMerge: true,
      queue: null,
      labels: [],
      events: [],
      comments: [],
      files: [],
      ...over,
    };
    w.prs.set(n, pr);
    return pr;
  };

  // A failed_checks removal of `pr` tested by a merge_group run whose failed
  // job is `job` (default: Type Check failing in its typecheck step = real).
  w.removeFailed = (n, { at, job = { name: 'Type Check', step: 'Run typecheck', annotations: [] }, runId = id() } = {}) => {
    const pr = w.prs.get(n);
    const evId = `RFMQE_${id()}`;
    const group = `${String(runId).padStart(8, 'f')}${'b'.repeat(32)}`;
    pr.events.push({ __typename: 'RemovedFromMergeQueueEvent', id: evId, createdAt: at, reason: 'failed_checks', actor: { login: viewer }, beforeCommit: { oid: group } });
    pr.queue = null;
    const created = iso(Date.parse(at) - 30 * 60_000);
    const jobIdN = id();
    w.runs.push({
      id: runId,
      run_attempt: 1,
      head_sha: group,
      head_branch: `gh-readonly-queue/main/pr-${n}-${'c'.repeat(40)}`,
      head_repository: { full_name: repo },
      event: 'merge_group',
      status: 'completed',
      conclusion: 'failure',
      path: '.github/workflows/ci.yml',
      created_at: created,
      updated_at: at,
      pull_requests: [],
      jobs: [
        {
          id: jobIdN,
          name: job.name,
          run_attempt: 1,
          conclusion: 'failure',
          started_at: created,
          completed_at: at,
          steps: [{ name: job.step, conclusion: 'failure' }],
          annotations: job.annotations ?? [],
          log: job.log ?? null,
        },
        { id: id(), name: 'CI Success', run_attempt: 1, conclusion: 'failure', started_at: at, completed_at: at, steps: [], annotations: [], log: null },
      ],
    });
    return { id: evId, at, runId };
  };

  w.reAdd = (n, at) => {
    const pr = w.prs.get(n);
    pr.events.push({ __typename: 'AddedToMergeQueueEvent', id: `AMQE_${id()}`, createdAt: at, actor: { login: viewer } });
    pr.queue = { state: 'QUEUED', position: 1, enqueuedAt: at, groupSha: null };
  };

  w.failOnce = (op) => w.failing.set(op, (w.failing.get(op) ?? 0) + 1);
  const shouldFail = (op) => {
    const n = w.failing.get(op) ?? 0;
    if (!n) return false;
    w.failing.set(op, n - 1);
    return true;
  };

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json(404, { message: 'Not Found' });
  const write = (op, detail) => w.writes.push({ op, ...detail });

  const queueEventNode = (e) => e;
  const snapshotNode = (pr) => ({
    id: pr.id,
    number: pr.number,
    state: pr.state,
    headRefOid: pr.headSha,
    headRefName: `branch-${pr.number}`,
    isCrossRepository: pr.isFork,
    headRepository: { nameWithOwner: pr.isFork ? 'someone/breeze' : repo },
    autoMergeRequest: pr.autoMerge ? { enabledAt: '2026-11-08T00:00:00Z' } : null,
    mergeQueueEntry: pr.queue ? { state: pr.queue.state, position: pr.queue.position } : null,
    labels: { nodes: pr.labels.map((name) => ({ name })) },
    timelineItems: { nodes: pr.events.slice(-30).map(queueEventNode) },
  });

  function graphql(query, variables) {
    if (/^\s*mutation/.test(query)) {
      const prId = variables.pullRequestId ?? variables.id;
      const pr = [...w.prs.values()].find((p) => p.id === prId);
      if (/disablePullRequestAutoMerge/.test(query)) {
        if (shouldFail('disable_auto_merge')) return json(502, { message: 'Bad Gateway' });
        write('disable_auto_merge', { pr: pr.number });
        pr.autoMerge = false;
        return json(200, { data: { disablePullRequestAutoMerge: { clientMutationId: null } } });
      }
      if (/dequeuePullRequest/.test(query)) {
        if (shouldFail('dequeue')) return json(502, { message: 'Bad Gateway' });
        write('dequeue', { pr: pr.number });
        pr.queue = null;
        pr.events.push({ __typename: 'RemovedFromMergeQueueEvent', id: `RFMQE_${id()}`, createdAt: iso(w.clock), reason: 'manual', actor: { login: viewer }, beforeCommit: null });
        return json(200, { data: { dequeuePullRequest: { clientMutationId: null } } });
      }
      return json(200, { errors: [{ message: 'unknown mutation' }] });
    }
    if (/pullRequests\(/.test(query)) {
      const nodes = [...w.prs.values()].map((pr) => ({ number: pr.number, updatedAt: iso(w.clock), timelineItems: { nodes: pr.events.slice(-20) } }));
      return json(200, { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    if (/pullRequest\(number/.test(query)) {
      const pr = w.prs.get(variables.n);
      return json(200, { data: { repository: { pullRequest: pr ? snapshotNode(pr) : null } } });
    }
    if (/mergeQueue\(/.test(query)) {
      const nodes = [...w.prs.values()]
        .filter((p) => p.queue)
        .map((p) => ({ position: p.queue.position, state: p.queue.state, enqueuedAt: p.queue.enqueuedAt ?? iso(w.clock), headCommit: p.queue.groupSha ? { oid: p.queue.groupSha } : null, pullRequest: { number: p.number } }));
      return json(200, { data: { repository: { mergeQueue: { entries: { nodes } } } } });
    }
    return json(200, { errors: [{ message: `fake-world: unhandled query ${query.slice(0, 60)}` }] });
  }

  const runJson = (r) => {
    const { jobs, ...rest } = r;
    return rest;
  };
  const findJob = (jobId) => w.runs.flatMap((r) => r.jobs).find((j) => j.id === jobId);

  function rest(method, path, q, body) {
    const p = path.replace(`/repos/${repo}/`, 'R/');
    let m;
    if (method === 'GET' && p === '/user') return json(200, { login: viewer });
    if (method === 'GET' && p === 'R/actions/variables/CI_SHEPHERD_MODE') {
      const v = typeof w.mode === 'function' ? w.mode() : w.mode;
      return v === null ? notFound() : json(200, { name: 'CI_SHEPHERD_MODE', value: v });
    }
    if (method === 'GET' && (m = /^R\/pulls\/(\d+)\/files$/.exec(p))) return json(200, (w.prs.get(Number(m[1]))?.files ?? []).map((filename) => ({ filename })));
    if (method === 'GET' && p === 'R/actions/runs' && q.get('head_sha')) {
      const pr = [...w.prs.values()].find((x) => x.headSha === q.get('head_sha'));
      const runs = pr?.headPushedAt ? [{ id: id(), event: 'pull_request', head_sha: pr.headSha, created_at: pr.headPushedAt }] : [];
      return json(200, { total_count: runs.length, workflow_runs: runs });
    }
    if (method === 'GET' && p === 'R/actions/workflows/ci.yml/runs') {
      let runs = w.runs.filter((r) => r.path === '.github/workflows/ci.yml');
      if (q.get('event')) runs = runs.filter((r) => r.event === q.get('event'));
      if (q.get('head_sha')) runs = runs.filter((r) => r.head_sha === q.get('head_sha'));
      if (q.get('status')) runs = runs.filter((r) => r.status === q.get('status'));
      const created = q.get('created');
      if (created?.startsWith('>=')) runs = runs.filter((r) => Date.parse(r.created_at) >= Date.parse(created.slice(2)));
      else if (created?.includes('..')) {
        const [a, b] = created.split('..');
        runs = runs.filter((r) => Date.parse(r.created_at) >= Date.parse(a) && Date.parse(r.created_at) <= Date.parse(b));
      }
      return json(200, { total_count: runs.length, workflow_runs: runs.map(runJson) });
    }
    if (method === 'GET' && p === 'R/actions/workflows/ci-gate.yml/runs') return notFound();
    if (method === 'GET' && (m = /^R\/actions\/runs\/(\d+)$/.exec(p))) {
      const r = w.runs.find((x) => x.id === Number(m[1]));
      return r ? json(200, runJson(r)) : notFound();
    }
    if (method === 'GET' && (m = /^R\/actions\/runs\/(\d+)\/jobs$/.exec(p))) {
      const r = w.runs.find((x) => x.id === Number(m[1]));
      const jobs = (r?.jobs ?? []).map(({ annotations, log, ...j }) => j);
      return json(200, { total_count: jobs.length, jobs });
    }
    if (method === 'GET' && (m = /^R\/actions\/runs\/(\d+)\/artifacts$/.exec(p))) return json(200, { total_count: 0, artifacts: [] });
    if (method === 'GET' && (m = /^R\/check-runs\/(\d+)\/annotations$/.exec(p))) {
      return json(200, (findJob(Number(m[1]))?.annotations ?? []).map((message) => ({ annotation_level: 'failure', message, title: '' })));
    }
    if (method === 'GET' && (m = /^R\/actions\/jobs\/(\d+)\/logs$/.exec(p))) {
      const log = findJob(Number(m[1]))?.log;
      return log ? new Response(log, { status: 200 }) : notFound();
    }
    if ((m = /^R\/issues\/(\d+)\/comments$/.exec(p))) {
      const pr = w.prs.get(Number(m[1]));
      if (method === 'GET') return json(200, pr.comments.map((c) => ({ id: c.id, user: { login: c.author }, body: c.body })));
      if (method === 'POST') {
        if (shouldFail('comment_post')) return json(502, { message: 'Bad Gateway' });
        const c = { id: id(), author: viewer, body: body.body };
        pr.comments.push(c);
        write('comment_post', { pr: pr.number, body: body.body });
        return json(201, { id: c.id });
      }
    }
    if (method === 'PATCH' && (m = /^R\/issues\/comments\/(\d+)$/.exec(p))) {
      for (const pr of w.prs.values()) {
        const c = pr.comments.find((x) => x.id === Number(m[1]));
        if (c) {
          c.body = body.body;
          write('comment_edit', { pr: pr.number, body: body.body });
          return json(200, { id: c.id });
        }
      }
      return notFound();
    }
    if (method === 'POST' && (m = /^R\/issues\/(\d+)\/labels$/.exec(p))) {
      const pr = w.prs.get(Number(m[1]));
      for (const l of body.labels) if (!pr.labels.includes(l)) pr.labels.push(l);
      write('label_add', { pr: pr.number, labels: body.labels });
      return json(200, pr.labels.map((name) => ({ name })));
    }
    if (method === 'DELETE' && (m = /^R\/issues\/(\d+)\/labels\/(.+)$/.exec(p))) {
      const pr = w.prs.get(Number(m[1]));
      const name = decodeURIComponent(m[2]);
      write('label_remove', { pr: pr.number, name });
      if (!pr.labels.includes(name)) return notFound();
      pr.labels = pr.labels.filter((l) => l !== name);
      return json(200, []);
    }
    if (method === 'GET' && p === 'R/issues') {
      const label = q.get('labels');
      const fromPrs = [...w.prs.values()]
        .filter((pr) => pr.state === 'OPEN' && pr.labels.includes(label))
        .map((pr) => ({ number: pr.number, state: 'open', title: `PR ${pr.number}`, pull_request: {}, labels: pr.labels.map((name) => ({ name })) }));
      const issues = w.issues.filter((i) => i.state === 'open' && i.labels.includes(label)).map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) }));
      return json(200, [...fromPrs, ...issues]);
    }
    if (method === 'POST' && p === 'R/issues') {
      const issue = { number: id(), title: body.title, body: body.body, labels: body.labels ?? [], state: 'open' };
      w.issues.push(issue);
      write('issue_create', { title: body.title });
      return json(201, { number: issue.number });
    }
    if (method === 'GET' && (m = /^R\/issues\/(\d+)$/.exec(p))) {
      const i = w.issues.find((x) => x.number === Number(m[1]));
      return i ? json(200, i) : notFound();
    }
    return notFound();
  }

  w.fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    if (url.pathname === '/graphql') {
      const mutation = /^\s*mutation/.test(body.query);
      w.calls.push({ method, path: '/graphql', mutation });
      return graphql(body.query, body.variables ?? {});
    }
    w.calls.push({ method, path: url.pathname, query: url.search, mutation: method !== 'GET' });
    return rest(method, url.pathname, url.searchParams, body);
  };

  w.exec = (args) => {
    w.execs.push(args);
    const [a, b, n] = args;
    if (a === 'pr' && b === 'merge') {
      if (shouldFail('enqueue')) throw new Error('gh: 502');
      const pr = w.prs.get(Number(n));
      pr.autoMerge = true;
      pr.queue = { state: 'QUEUED', position: 1, enqueuedAt: iso(w.clock), groupSha: null };
      pr.events.push({ __typename: 'AddedToMergeQueueEvent', id: `AMQE_${id()}`, createdAt: iso(w.clock), actor: { login: viewer } });
      write('enqueue', { pr: pr.number });
    } else if (a === 'workflow' && b === 'run') {
      write('dispatch_main_ci', {});
    }
    return '';
  };

  // Every request that could change GitHub state.
  w.writeCalls = () => w.calls.filter((c) => c.mutation);
  return w;
}
