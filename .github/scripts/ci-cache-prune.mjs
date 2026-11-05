#!/usr/bin/env node
// Housekeeping for the repo's Actions caches, run by ci-cache-seed.yml (#11119).
//
//   superseded --prefix P --keep K   delete every entry of family P on this ref
//                                    except K, the key the job just saved
//   budget [--budget-bytes N]        delete retired families, then evict until
//                                    the repo's total is under BUDGET_BYTES
//
// Common flags: --dry-run prints the plan and deletes nothing.
// Reads GITHUB_REPOSITORY and GITHUB_REF; `gh` authenticates with GH_TOKEN,
// which needs actions: write. Planning is pure and tested in
// ci-cache-policy.test.mjs; only `main` below talks to GitHub.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FIELDS = 'id,key,ref,sizeInBytes,lastAccessedAt';

export function planSuperseded(entries, { prefix, keep }) {
  if (!prefix || !keep?.startsWith(prefix)) {
    throw new Error(`keep key ${keep} is not in its own prefix ${prefix}`);
  }
  const family = entries.filter((e) => e.key.startsWith(prefix));
  if (!family.some((e) => e.key === keep)) {
    // The save just before this failed, or the listing lags it: deleting the
    // rest could leave the family with nothing.
    return { deletions: [], warning: `${keep} is not listed yet; keeping every ${prefix}* entry` };
  }
  return { deletions: family.filter((e) => e.key !== keep), warning: null };
}

// GitHub evicts least-recently-used entries of ANY kind once the repo passes its
// 10 GB limit; that is how the Tauri closure was lost (#11119). Staying 1.5 GB
// under it leaves room for one seed run's exports between two budget passes, so
// GitHub's eviction never gets to choose. docs/agents/testing.md documents this.
export const BUDGET_BYTES = 8_500_000_000;

// Families nothing restores any more: setup-node's and setup-go's built-in
// caches (replaced by the seed's pnpm-* and go-*) and setup-trivy's binary.
export const RETIRED_PREFIXES = ['node-cache-', 'setup-go-', 'trivy-binary-'];

// What is cheap to lose, cheapest first: anything on another ref (only that ref
// can read it, and PR/queue refs no longer save at all), then main's buildkit
// layers by least-recent access, which is what GitHub would evict first anyway.
// Every other main entry is a seed key that a CI job restores.
const BLOB = 'buildkit-blob-';

export function planBudget(entries, { budgetBytes, mainRef }) {
  const retired = entries.filter((e) => RETIRED_PREFIXES.some((p) => e.key.startsWith(p)));
  const rest = entries.filter((e) => !retired.includes(e));
  const sum = (list) => list.reduce((s, e) => s + e.sizeInBytes, 0);
  const onMain = (e) => e.ref === mainRef;
  const evictable = rest
    .filter((e) => !onMain(e) || e.key.startsWith(BLOB))
    .sort((a, b) => Number(onMain(a)) - Number(onMain(b))
      || Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt));
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function list(repo, { ref, key } = {}) {
  const args = ['cache', 'list', '--repo', repo, '--limit', '1000', '--json', FIELDS];
  if (ref) args.push('--ref', ref);
  if (key) args.push('--key', key);
  return JSON.parse(gh(args));
}

function remove(repo, deletions, dryRun) {
  let failed = 0;
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
      // Another run may have deleted it first; a leftover only costs space.
      failed += 1;
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
    else if (a === '--keep') opts.keep = rest[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF;
  if (!repo || !ref) throw new Error('GITHUB_REPOSITORY and GITHUB_REF are required');

  if (opts.command === 'superseded') {
    const { deletions, warning } = planSuperseded(list(repo, { ref, key: opts.prefix }), opts);
    if (warning) console.log(`::warning::${warning}`);
    if (deletions.length === 0) console.log(`no superseded ${opts.prefix}* entries on ${ref}`);
    remove(repo, deletions, opts.dryRun);
    return;
  }
  if (opts.command === 'budget') {
    if (!(opts.budgetBytes > 0)) throw new Error(`bad --budget-bytes ${opts.budgetBytes}`);
    // Every ref: entries on other refs count toward the same limit.
    const entries = list(repo);
    const total = entries.reduce((s, e) => s + e.sizeInBytes, 0);
    const plan = planBudget(entries, { budgetBytes: opts.budgetBytes, mainRef: ref });
    console.log(`${entries.length} entries, ${mb(total)}; budget ${mb(opts.budgetBytes)}; ${plan.deletions.length} to delete`);
    const failed = remove(repo, plan.deletions, opts.dryRun);
    console.log(`${mb(plan.remaining)} left${failed ? ` (${failed} deletes failed)` : ''}`);
    if (plan.overBudget) {
      // Only seed keys are left, so the budget itself no longer fits: someone
      // has to decide what may live on main (docs/agents/testing.md).
      throw new Error(`still ${mb(plan.remaining)} after evicting everything evictable; over the ${mb(opts.budgetBytes)} budget`);
    }
    return;
  }
  throw new Error(`unknown command ${opts.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.log(`::error::ci-cache-prune: ${err.message}`);
    process.exitCode = 1;
  }
}
