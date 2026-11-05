#!/usr/bin/env node
// Housekeeping for the repo's Actions caches, run by ci-cache-seed.yml (#11119).
//
//   superseded --prefix P            keep the newest-created entry of family P
//                                    on this ref, delete the rest
//   budget [--budget-bytes N]        delete retired families on main, then evict
//                                    until the repo's total is under BUDGET_BYTES
//
// Common flags: --dry-run prints the plan and deletes nothing.
// Reads GITHUB_REPOSITORY and GITHUB_REF; `gh` authenticates with GH_TOKEN,
// which needs actions: write. Planning is pure and tested in
// ci-cache-policy.test.mjs, as is the CLI against a stub `gh`.
//
// Exit codes: 0 done; 1 something was left undone (a listing or delete failed,
// or the budget is not met); 2 bad usage.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FIELDS = 'id,key,ref,sizeInBytes,createdAt,lastAccessedAt';
// One page of `gh cache list`. A listing that fills it may be truncated, and a
// truncated total would pass the budget while the repo is over it.
export const LIST_LIMIT = 5000;

// GitHub evicts least-recently-used entries of ANY kind once the repo passes its
// 10 GB limit; that is how the Tauri closure was lost (#11119). Staying 1.5 GB
// under it leaves room for one seed run's exports between two budget passes, so
// GitHub's eviction never gets to choose. docs/agents/testing.md documents this.
export const BUDGET_BYTES = 8_500_000_000;

// Families nothing on main saves any more: setup-node's and setup-go's built-in
// caches (replaced by the seed's pnpm-* and go-*) and setup-trivy's binary.
// Deleted on main only: release.yml still saves them on tag refs, where the
// budget's other-refs pass reaches them only when the repo is over budget.
export const RETIRED_PREFIXES = ['node-cache-', 'setup-go-', 'trivy-binary-'];

const BLOB = 'buildkit-blob-';
const time = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t; // unknown sorts as oldest
};

// Keys are immutable, so a new lockfile / go.sum / day makes a new entry per OS.
// The newest-created one is the current key: the seed saves in push order under
// one concurrency group. (Recomputing the key elsewhere is not safe: Windows
// checks go.sum out with CRLF, so its hashFiles differs from Linux's.)
export function planSuperseded(entries, { prefix }) {
  if (!prefix) throw new Error('--prefix is required');
  const family = entries
    .filter((e) => e.key.startsWith(prefix))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  return { keep: family[0] ?? null, deletions: family.slice(1) };
}

// What is cheap to lose, cheapest first: anything on another ref (only that ref
// can read it, and PR/queue refs no longer save at all), then main's buildkit
// layers by least-recent access, which is what GitHub would evict first anyway.
// Every other main entry is a seed key that a CI job restores.
export function planBudget(entries, { budgetBytes, mainRef }) {
  const onMain = (e) => e.ref === mainRef;
  const retired = entries.filter((e) => onMain(e) && RETIRED_PREFIXES.some((p) => e.key.startsWith(p)));
  const rest = entries.filter((e) => !retired.includes(e));
  const sum = (list) => list.reduce((s, e) => s + e.sizeInBytes, 0);
  const evictable = rest
    .filter((e) => !onMain(e) || e.key.startsWith(BLOB))
    .sort((a, b) => Number(onMain(a)) - Number(onMain(b))
      || time(a.lastAccessedAt) - time(b.lastAccessedAt) || a.id - b.id);
  const evicted = [];
  let total = sum(rest);
  for (const e of evictable) {
    if (total <= budgetBytes) break;
    evicted.push(e);
    total -= e.sizeInBytes;
  }
  const remaining = sum(rest.filter((e) => !evicted.includes(e)));
  return { deletions: [...retired, ...evicted], remaining, overBudget: remaining > budgetBytes };
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

class UsageError extends Error {}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function list(repo, { ref, key } = {}) {
  const args = ['cache', 'list', '--repo', repo, '--limit', String(LIST_LIMIT), '--json', FIELDS];
  if (ref) args.push('--ref', ref);
  if (key) args.push('--key', key);
  const what = `gh cache list${ref ? ` --ref ${ref}` : ''}${key ? ` --key ${key}` : ''}`;
  let entries;
  try {
    entries = JSON.parse(gh(args));
  } catch (err) {
    throw new Error(`${what}: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${what}: expected a JSON array`);
  if (entries.length >= LIST_LIMIT) throw new Error(`${what}: ${entries.length} entries fill the listing limit; the total may be truncated`);
  return entries;
}

// Returns the entries that could not be deleted.
function remove(repo, deletions, dryRun) {
  const failed = [];
  for (const e of deletions) {
    const line = `${e.key} (${e.ref}, ${mb(e.sizeInBytes)})`;
    if (dryRun) {
      console.log(`would delete ${line}`);
      continue;
    }
    try {
      gh(['cache', 'delete', String(e.id), '--repo', repo]);
      console.log(`deleted ${line}`);
    } catch {
      failed.push(e);
      console.log(`::warning::could not delete cache ${line}`);
    }
  }
  return failed;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, dryRun: false, budgetBytes: BUDGET_BYTES };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--budget-bytes') opts.budgetBytes = Number(rest[++i]);
    else if (a === '--prefix') opts.prefix = rest[++i];
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (command === 'superseded' && !opts.prefix) throw new UsageError('superseded needs --prefix');
  if (command === 'budget' && !(opts.budgetBytes > 0)) throw new UsageError(`bad --budget-bytes ${opts.budgetBytes}`);
  if (command !== 'superseded' && command !== 'budget') throw new UsageError(`unknown command ${command}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF;
  if (!repo || !ref) throw new UsageError('GITHUB_REPOSITORY and GITHUB_REF are required');

  if (opts.command === 'superseded') {
    const { keep, deletions } = planSuperseded(list(repo, { ref, key: opts.prefix }), opts);
    console.log(keep ? `keeping ${keep.key} (created ${keep.createdAt})` : `no ${opts.prefix}* entries on ${ref}`);
    const failed = remove(repo, deletions, opts.dryRun);
    if (failed.length) throw new Error(`${failed.length} of ${deletions.length} superseded ${opts.prefix}* deletes failed`);
    return;
  }

  // Every ref: entries on other refs count toward the same limit.
  const entries = list(repo);
  const total = entries.reduce((s, e) => s + e.sizeInBytes, 0);
  const plan = planBudget(entries, { budgetBytes: opts.budgetBytes, mainRef: ref });
  console.log(`${entries.length} entries, ${mb(total)}; budget ${mb(opts.budgetBytes)}; ${plan.deletions.length} to delete`);
  const failed = remove(repo, plan.deletions, opts.dryRun);
  // What a failed delete left behind still counts.
  const remaining = plan.remaining + failed.reduce((s, e) => s + e.sizeInBytes, 0);
  console.log(`${mb(remaining)} left${failed.length ? ` (${failed.length} deletes failed)` : ''}`);
  if (remaining > opts.budgetBytes) {
    throw new Error(failed.length
      ? `${mb(remaining)} is over the ${mb(opts.budgetBytes)} budget because ${failed.length} deletes failed`
      // Only seed keys are left, so the budget itself no longer fits: someone
      // has to decide what may live on main (docs/agents/testing.md).
      : `still ${mb(remaining)} after evicting everything evictable; over the ${mb(opts.budgetBytes)} budget`);
  }
  if (failed.length) throw new Error(`${failed.length} deletes failed (budget still met)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.log(`::error::ci-cache-prune: ${err.message}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}
