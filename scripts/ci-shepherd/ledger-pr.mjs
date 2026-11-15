// The rolling flaky-ledger PR (W06c C3, #10750).
//
// At most one open ledger PR at a time, head `ci-shepherd/ledger-<today>`.
// While one is open the shepherd waits: a queued branch is push-locked, and a
// second PR would race the first. The branch is made in a temporary worktree
// of the shepherd's own clone (never a working copy anyone edits), from
// origin/main, and pushed as a new branch: never forced, so a branch that
// already exists is an error for a human, not something to overwrite. A
// ledger PR a human closed today is not reopened until tomorrow.
//
// The PR auto-merges (OD-4) under the merge queue: `.github/flaky-tests.json`
// is a policy path, so its queue run is the full suite.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LEDGER_PATH } from '../../.github/scripts/flaky-ledger.mjs';
import { flakeKey, neutralText } from './flake-issues.mjs';
import { isEmptyProposal } from './ledger-proposals.mjs';
import { CLOSING_KEYWORD } from './markers.mjs';

export const LEDGER_BRANCH_PREFIX = 'ci-shepherd/ledger-';
const PULL_PAGES = 5;
const BASE = 'origin/main';

// The ledger and file checks at origin/main of the shepherd's clone: the
// commit the ledger branch is made from.
export function readMainLedger(git, checkoutDir) {
  const ledger = JSON.parse(git(['show', `${BASE}:${LEDGER_PATH}`], { cwd: checkoutDir }));
  const fileExists = (path) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) return false;
    try {
      git(['cat-file', '-e', `${BASE}:${path}`], { cwd: checkoutDir });
      return true;
    } catch {
      return false;
    }
  };
  return { ledger, fileExists };
}

export const ledgerJson = (next) => `${JSON.stringify(next, null, 2)}\n`;

export function renderLedgerPr(proposal) {
  const counts = `${proposal.add.length} add, ${proposal.renew.length} renew, ${proposal.remove.length} remove`;
  const title = `ci(flaky-ledger): ${counts} (shepherd)`;
  const row = (change, e) => {
    const ev = proposal.evidence?.[flakeKey(e.runner, e.id)];
    const kinds = ev ? Object.entries(ev.kinds).map(([k, n]) => `${k} ${n}`).join(', ') : '-';
    return `| ${change} | \`${neutralText(e.id)}\` | ${neutralText(e.runner)} | #${e.issue} | ${ev ? ev.sightings7 : '-'} | ${kinds} | ${change === 'remove' ? '-' : e.expires} |`;
  };
  const body = [
    `Flaky-ledger upkeep by the CI shepherd: ${counts}.`,
    '',
    '| Change | Test | Runner | Issue | Sightings, 7 days | Kinds | Expires |',
    '|---|---|---|---|---|---|---|',
    ...proposal.add.map((e) => row('add', e)),
    ...proposal.renew.map((e) => row('renew', e)),
    ...proposal.remove.map((e) => row('remove', e)),
    '',
    'An entry lets its test fail both attempts without failing the job, and only in a PR that does not touch the test: a PR that touches the test file or its sibling source (for Go, any file in its package) is never excused, and the ledger is read from the base commit, so no PR can quarantine its own failure.',
    'Entries the shepherd writes run 14 days and each test is quarantined for at most 60 days in total; after that it must be fixed.',
    '',
    'Refs #10750',
  ].join('\n');
  // Ids are neutralised above; this is the backstop.
  if (CLOSING_KEYWORD.test(body) || CLOSING_KEYWORD.test(title)) throw new Error('renderLedgerPr: refusing a closing keyword');
  return { title, body, commitMessage: title };
}

async function openLedgerPr(gh, repo) {
  for (let page = 1; page <= PULL_PAGES; page++) {
    const res = await gh.rest('GET', `repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
    if (res.status !== 200) throw new Error(`open PR listing: ${res.status}`);
    const mine = res.body.find((p) => p.head?.ref?.startsWith(LEDGER_BRANCH_PREFIX) && p.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase());
    if (mine) return mine.number;
    if (res.body.length < 100) return null;
  }
  // More open PRs than pages read: an unseen ledger PR is possible, so wait.
  return -1;
}

// { status: 'noop'|'shadow'|'waiting'|'done_today'|'partial'|'opened', … }.
// `modeNow()` is read again right before the first write. Errors (a refused
// push, a gh failure) propagate after the worktree is removed.
export async function ledgerPrTick({ gh, git, writer, checkoutDir, repo, proposal, today, mode, modeNow }) {
  if (isEmptyProposal(proposal)) return { status: 'noop' };
  const branch = `${LEDGER_BRANCH_PREFIX}${today}`;
  const { title, body, commitMessage } = renderLedgerPr(proposal);
  if (mode !== 'act' || !writer) return { status: 'shadow', branch, title, body };
  if (!checkoutDir) throw new Error('ledger PR: no checkout dir (run.sh passes the shepherd clone)');

  const open = await openLedgerPr(gh, repo);
  if (open !== null) return { status: 'waiting', pr: open };
  const [owner] = repo.split('/');
  const res = await gh.rest('GET', `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
  if (res.status !== 200) throw new Error(`ledger PR lookup: ${res.status}`);
  if (res.body.length) return { status: 'done_today', pr: res.body[0].number };
  if ((await modeNow()) !== 'act') return { status: 'partial', reason: 'left act before the ledger push' };

  // Today's branch already pushed but no PR for it: an earlier tick crashed
  // between the push and `gh pr create`. Resume only when the branch holds
  // exactly this proposal; anything else is for a human.
  if (git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: checkoutDir }).trim()) {
    git(['fetch', '--quiet', 'origin', `refs/heads/${branch}`], { cwd: checkoutDir });
    let pushed = null;
    try {
      pushed = git(['show', `FETCH_HEAD:${LEDGER_PATH}`], { cwd: checkoutDir });
    } catch {
      pushed = null;
    }
    if (pushed !== ledgerJson(proposal.next)) throw new Error(`ledger PR: ${branch} already exists with other content and no PR; a human should delete or open it`);
    const pr = await writer.createPr({ head: branch, title, body });
    await writer.enqueue(pr);
    return { status: 'opened', pr, branch, resumed: true };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ci-shepherd-ledger-'));
  const wt = join(tmp, 'wt');
  let added = false;
  try {
    git(['worktree', 'add', '--quiet', '-B', branch, wt, BASE], { cwd: checkoutDir });
    added = true;
    writeFileSync(join(wt, LEDGER_PATH), ledgerJson(proposal.next));
    git(['add', LEDGER_PATH], { cwd: wt });
    git(['commit', '--quiet', '-m', commitMessage], { cwd: wt });
    try {
      await writer.pushBranch(wt, branch);
    } catch (e) {
      throw new Error(`ledger PR: push of ${branch} refused: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`);
    }
  } finally {
    if (added) {
      try {
        git(['worktree', 'remove', '--force', wt], { cwd: checkoutDir });
      } catch {
        // Pruned below.
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    try {
      git(['worktree', 'prune'], { cwd: checkoutDir });
    } catch {
      // Nothing to prune.
    }
  }
  const pr = await writer.createPr({ head: branch, title, body });
  await writer.enqueue(pr);
  return { status: 'opened', pr, branch };
}
