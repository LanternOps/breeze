// The shepherd's write path (W06b B3, #10750). This module and nothing else
// changes GitHub state; tick.mjs constructs a writer only in act mode, and
// in any other mode every read goes through readOnlyGitHub, which refuses a
// write before it reaches the network.
//
// Each method is one write. Callers check state first (apply.mjs); the
// methods themselves only tolerate the "already in that state" answers.
import { execFileSync } from 'node:child_process';

import { GitHubError, isMutationQuery } from './github.mjs';

export class ShadowWriteBlocked extends Error {
  constructor(what) {
    super(`shadow mode: refused write ${what}`);
    this.name = 'ShadowWriteBlocked';
  }
}

// A view of `gh` that can only read. Shares the call counter and budget.
export function readOnlyGitHub(gh) {
  return {
    get calls() {
      return gh.calls;
    },
    get budget() {
      return gh.budget;
    },
    set budget(v) {
      gh.budget = v;
    },
    rest: (method, path, body) => {
      if (String(method).toUpperCase() !== 'GET') throw new ShadowWriteBlocked(`${method} ${path}`);
      return gh.rest(method, path, body);
    },
    graphql: (query, variables) => {
      if (isMutationQuery(query)) throw new ShadowWriteBlocked('GraphQL mutation');
      return gh.graphql(query, variables);
    },
    raw: (path, opts) => gh.raw(path, opts),
    readOnly: true,
  };
}

// The `gh` CLI, for the two writes done through it: enqueue (`gh pr merge
// --auto`, the path proven to start merge_group CI with the operator token)
// and the main CI dispatch. Arguments are an array; no shell.
export const ghCli = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

const DISABLE_AUTO_MERGE = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const DEQUEUE = `mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { clientMutationId }
}`;

async function ok(res, what, accept = []) {
  if ((res.status >= 200 && res.status < 300) || accept.includes(res.status)) return res;
  throw new GitHubError(res.status, `${what}: ${res.status} ${res.body?.message ?? ''}`.trim());
}

export function createWriter({ gh, exec = ghCli, repo }) {
  if (gh.readOnly) throw new Error('createWriter: refusing a read-only client');
  return {
    async comments(pr) {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const res = await ok(await gh.rest('GET', `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`), 'list comments');
        out.push(...res.body.map((c) => ({ id: c.id, author: c.user?.login ?? null, body: c.body ?? '' })));
        if (res.body.length < 100) break;
      }
      return out;
    },
    async postComment(pr, body) {
      const res = await ok(await gh.rest('POST', `repos/${repo}/issues/${pr}/comments`, { body }), 'post comment');
      return res.body.id;
    },
    async editComment(id, body) {
      await ok(await gh.rest('PATCH', `repos/${repo}/issues/comments/${id}`, { body }), 'edit comment');
    },
    async addLabel(pr, name) {
      await ok(await gh.rest('POST', `repos/${repo}/issues/${pr}/labels`, { labels: [name] }), 'add label');
    },
    async removeLabel(pr, name) {
      await ok(await gh.rest('DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(name)}`), 'remove label', [404]);
    },
    async disableAutoMerge(nodeId) {
      await gh.graphql(DISABLE_AUTO_MERGE, { pullRequestId: nodeId });
    },
    async dequeue(nodeId) {
      await gh.graphql(DEQUEUE, { id: nodeId });
    },
    async enqueue(pr) {
      exec(['pr', 'merge', String(pr), '--auto', '-R', repo]);
    },
    async dispatchMainCi() {
      exec(['workflow', 'run', 'CI', '--ref', 'main', '-R', repo]);
    },
    // Find an open issue with this exact title (first label) or create it.
    async issueUpsert({ title, body, labels = [] }) {
      const q = labels.length ? `labels=${encodeURIComponent(labels[0])}&` : '';
      const list = await ok(await gh.rest('GET', `repos/${repo}/issues?${q}state=open&per_page=100`), 'list issues');
      const found = list.body.find((i) => !i.pull_request && i.title === title);
      if (found) return found.number;
      const res = await ok(await gh.rest('POST', `repos/${repo}/issues`, { title, body, labels }), 'create issue');
      return res.body.number;
    },
  };
}
