#!/usr/bin/env node
// CI shepherd CLI (W06, #10744 / #10750). Read-only in W06a: no subcommand
// here calls a mutation.
//
//   shepherd.mjs classify --run <id> --pr <n> [--history <sightings.jsonl>]
//       Prints the RunVerdict for one merge_group CI run as JSON.
//   shepherd.mjs replay --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--json] [--history <sightings.jsonl>]
//       One row per `failed_checks` removal in the window, then counts per class.
//       The touched-file check uses each PR's files as they are now, not as
//       they were at the removal; sightings are cut at the removal time.
//   shepherd.mjs record-fixture --run <id> --pr <n> --name <slug>
//       Writes trimmed facts to fixtures/<slug>.json for the classifier tests.
//
// Common options: --repo <owner/name> (default LanternOps/breeze),
// --budget <calls> (default 600). The token comes from GH_TOKEN, GITHUB_TOKEN
// or `gh auth token`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRun } from './classify.mjs';
import { History, ingestRun, readSightings } from './evidence.mjs';
import { groupRunFor, prSnapshot, recentRemovals, requiredJobIds, runFacts } from './facts.mjs';
import { createGitHub } from './github.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const FIXTURE_DIR = join(HERE, 'fixtures');
const FIXTURE_TAIL_LINES = 200;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, repo: 'LanternOps/breeze', budget: 600, json: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--json') {
      opts.json = true;
      continue;
    }
    const v = rest[i + 1];
    if (!k.startsWith('--') || v === undefined) throw new UsageError(`bad option ${k}`);
    opts[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    i++;
  }
  for (const k of ['run', 'pr', 'budget']) {
    if (opts[k] !== undefined) {
      opts[k] = Number(opts[k]);
      if (!Number.isInteger(opts[k]) || opts[k] <= 0) throw new UsageError(`--${k} must be a positive integer`);
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new UsageError('--repo must be owner/name');
  return opts;
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const readCiYml = () => readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

// Fixture = { name, source, prFiles, facts }. Passed and skipped jobs are
// dropped unless they carry a flake report (the classifier reads failed jobs
// and `ciSuccess`; sightings read reports), and each log tail is cut to its
// last 200 lines.
export function trimFacts(facts) {
  const keep = (j) => j.conclusion === 'failure' || j.conclusion === 'cancelled' || j.name === 'CI Success' || j.report !== null;
  return {
    ...facts,
    jobs: facts.jobs.filter(keep).map((j) => ({
      ...j,
      logTail: j.logTail === null ? null : j.logTail.split('\n').slice(-FIXTURE_TAIL_LINES).join('\n'),
    })),
  };
}

async function recordFixture(gh, opts) {
  const snapshot = await prSnapshot(gh, { repo: opts.repo, pr: opts.pr });
  const facts = await runFacts(gh, { repo: opts.repo, runId: opts.run, ciYml: readCiYml() });
  const fixture = {
    name: opts.name,
    source: { run: opts.run, pr: opts.pr, recordedAt: new Date().toISOString().slice(0, 10) },
    prFiles: snapshot.files,
    facts: trimFacts(facts),
  };
  const out = join(opts.outDir ?? FIXTURE_DIR, `${opts.name}.json`);
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`wrote ${out} (${gh.calls} API calls)\n`);
}

async function classifyOne(gh, opts) {
  const snapshot = await prSnapshot(gh, { repo: opts.repo, pr: opts.pr });
  const ciYml = readCiYml();
  const facts = await runFacts(gh, { repo: opts.repo, runId: opts.run, ciYml });
  if (facts.run.pr !== null && facts.run.pr !== opts.pr) {
    process.stderr.write(`shepherd: warning: run ${opts.run} tested PR #${facts.run.pr}, not #${opts.pr}; the touched-file check uses #${opts.pr}'s files\n`);
  }
  const history = History.fromSightings(opts.history ? readSightings(opts.history) : []);
  const verdict = classifyRun(facts, { prFiles: new Set(snapshot.files), history, repoRoot: REPO_ROOT, pr: opts.pr, now: Date.now(), requiredJobs: requiredJobIds(ciYml) });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}

// Every failed_checks removal in the window. Facts are gathered for all of
// them first, so each verdict can see the other removals' sightings.
export async function replay(gh, { repo, since, until = null, ciYml, repoRoot = REPO_ROOT, history = [] }) {
  const stats = {};
  const removals = (await recentRemovals(gh, { repo, since, until, maxPages: 40, stats })).filter((r) => r.reason === 'failed_checks');
  const rows = [];
  for (const removal of removals) {
    const row = { pr: removal.pr, removalAt: removal.at, removalId: removal.id, run: null, class: null, signature: null, testIds: [], error: null };
    try {
      const snapshot = await prSnapshot(gh, { repo, pr: removal.pr });
      row.isFork = snapshot.isFork;
      const ref = await groupRunFor(gh, { repo, pr: removal.pr, removal });
      if (ref) {
        row.run = ref.id;
        row.facts = await runFacts(gh, { repo, runId: ref.id, ciYml });
      }
      row.prFiles = snapshot.files;
    } catch (e) {
      if (e.name === 'BudgetExceeded') throw e;
      row.error = e.message;
    }
    rows.push(row);
  }
  const sightings = [...history];
  for (const row of rows) if (row.facts && !row.isFork) sightings.push(...ingestRun(row.facts, { repo, repoRoot }));
  const all = History.fromSightings(sightings);
  const requiredJobs = requiredJobIds(ciYml);
  const now = until === null ? Date.now() : Date.parse(until);
  for (const row of rows) {
    if (row.isFork) {
      row.class = 'skipped_fork';
    } else if (row.facts) {
      const ctx = { prFiles: new Set(row.prFiles), history: all, repoRoot, pr: row.pr, now: Date.parse(row.removalAt) || now, requiredJobs };
      const v = classifyRun(row.facts, ctx);
      Object.assign(row, { class: v.class, signature: v.signature, testIds: v.testIds, verdict: v });
    } else if (!row.error) {
      row.class = 'no_group_run';
    } else {
      row.class = 'error';
    }
    delete row.facts;
    delete row.prFiles;
  }
  const counts = {};
  for (const row of rows) counts[row.class] = (counts[row.class] ?? 0) + 1;
  // `complete: false`: the removal scan hit its page cap before `since`.
  return { rows, counts, calls: gh.calls, complete: stats.complete };
}

export function renderReplay({ rows, counts, complete = true }) {
  const lines = ['pr\tremoval_at\trun\tclass\tsignature\ttest_ids'];
  for (const r of rows) {
    const ids = r.testIds.length > 3 ? `${r.testIds.slice(0, 3).join(' | ')} (+${r.testIds.length - 3})` : r.testIds.join(' | ');
    lines.push([r.pr, r.removalAt, r.run ?? '-', r.class, r.signature ?? '-', ids || (r.error ? `error: ${r.error}` : '-')].join('\t'));
  }
  lines.push('', 'class\tcount', ...Object.entries(counts).sort().map(([k, v]) => `${k}\t${v}`), `total\t${rows.length}`);
  if (!complete) lines.push('PARTIAL: the removal scan stopped at its page cap before --since');
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: shepherd.mjs classify --run <id> --pr <n> | replay --since <YYYY-MM-DD> [--until <date>] [--json] | record-fixture --run <id> --pr <n> --name <slug>';

export async function main(argv, { makeGitHub = (budget) => createGitHub({ token: token(), budget }) } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!['classify', 'replay', 'record-fixture'].includes(opts.command)) throw new UsageError(`unknown command ${opts.command ?? ''}`);
    const badDate = (d) => d !== undefined && (!/^\d{4}-\d{2}-\d{2}/.test(d) || Number.isNaN(Date.parse(d)));
    if (opts.command === 'replay' && (opts.since === undefined || badDate(opts.since) || badDate(opts.until))) throw new UsageError('replay needs --since YYYY-MM-DD (and --until, if given, a real date)');
    if (opts.command !== 'replay' && (!opts.run || !opts.pr)) throw new UsageError(`${opts.command} needs --run and --pr`);
    if (opts.command === 'record-fixture' && !SLUG.test(opts.name ?? '')) throw new UsageError('record-fixture needs --name <slug> ([a-z0-9-])');
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`shepherd: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const gh = makeGitHub(opts.budget);
  if (opts.command === 'record-fixture') await recordFixture(gh, opts);
  else if (opts.command === 'classify') await classifyOne(gh, opts);
  else {
    const history = opts.history ? readSightings(opts.history) : [];
    const result = await replay(gh, { repo: opts.repo, since: opts.since, until: opts.until ?? null, ciYml: readCiYml(), history });
    process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderReplay(result));
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
