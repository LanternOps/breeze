// Cancels unfinished merge_group workflow runs whose temporary
// `gh-readonly-queue/...` ref no longer exists (#9800). When a merge-queue
// entry is dequeued, GitHub deletes the refs of the discarded groups but does
// not cancel their runs, so they keep occupying runners ahead of the live ones.
//
// Safety: a run is cancelled ONLY when the ref lookup returns exactly 404.
// Any other outcome (API error, rate limit, network) leaves the run alone.
import { pathToFileURL } from 'node:url';

const STATUSES = ['queued', 'in_progress'];
const PER_PAGE = 100;
const MAX_PAGES = 20;

export async function cancelStaleMergeGroupRuns({ api, repo, log = console }) {
  const result = { inspected: 0, cancelled: 0, errors: 0 };
  const refExists = new Map(); // ref -> true | false | null (unknown)

  async function lookupRef(ref) {
    if (refExists.has(ref)) return refExists.get(ref);
    let state = null;
    try {
      const encoded = ref.split('/').map(encodeURIComponent).join('/');
      const res = await api('GET', `repos/${repo}/git/ref/heads/${encoded}`);
      if (res.status === 200) state = true;
      else if (res.status === 404) state = false;
      else log.warn(`ref lookup for ${ref} returned ${res.status}; leaving runs alone`);
    } catch (err) {
      log.warn(`ref lookup for ${ref} failed (${err.message}); leaving runs alone`);
    }
    if (state === null) result.errors++;
    refExists.set(ref, state);
    return state;
  }

  for (const status of STATUSES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let res;
      try {
        res = await api('GET', `repos/${repo}/actions/runs?event=merge_group&status=${status}&per_page=${PER_PAGE}&page=${page}`);
      } catch (err) {
        log.warn(`listing ${status} runs failed (${err.message})`);
        result.errors++;
        break;
      }
      if (res.status !== 200) {
        log.warn(`listing ${status} runs returned ${res.status}`);
        result.errors++;
        break;
      }
      const runs = res.body?.workflow_runs ?? [];
      for (const { id, head_branch: ref } of runs) {
        result.inspected++;
        if (!ref) continue;
        if ((await lookupRef(ref)) !== false) continue;
        let cancel;
        try {
          cancel = await api('POST', `repos/${repo}/actions/runs/${id}/cancel`);
        } catch (err) {
          cancel = { status: 0, error: err };
        }
        if (cancel.status === 409) {
          log.info(`run ${id} already finished; nothing to cancel`);
        } else if (cancel.status === 202) {
          log.info(`cancelled run ${id}: ref ${ref} no longer exists`);
          result.cancelled++;
        } else {
          log.warn(`cancel of run ${id} returned ${cancel.status}`);
          result.errors++;
        }
      }
      if (runs.length < PER_PAGE) break;
    }
  }
  return result;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  const api = async (method, path) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    let body = {};
    try { body = await res.json(); } catch { /* empty body (e.g. 202) */ }
    return { status: res.status, body };
  };
  const result = await cancelStaleMergeGroupRuns({
    api,
    repo,
    log: { info: (m) => console.log(m), warn: (m) => console.log(`::warning::${m}`) },
  });
  console.log(`inspected=${result.inspected} cancelled=${result.cancelled} errors=${result.errors}`);
  // Errors never cancel anything, so failing the job is safe and makes a broken
  // janitor (lost permission, persistent 5xx) visible instead of silently green.
  if (result.errors > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
