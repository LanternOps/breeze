#!/usr/bin/env node
// Housekeeping for the repo's Actions caches, run by ci-cache-seed.yml (#11119).
//
//   superseded --prefix P --keep K   delete every entry of family P on this ref
//                                    except K, the key the job just saved
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
  const opts = { command, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--dry-run') opts.dryRun = true;
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
