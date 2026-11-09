#!/usr/bin/env node
// W07a (#10751): rebuild .github/ci-timings/integration.json from the job logs
// of recent fully-green CI runs.
//
//   node .github/scripts/test-timings.mjs refresh [--runs 10 | --run-ids <id,id>]
//        [--out .github/ci-timings/integration.json] [--repo LanternOps/breeze]
//
// `--runs N` takes the newest N merge_group CI runs that succeeded with all
// integration shards green. `--run-ids` takes explicit runs (any event).
//
// A file's weight is the wall clock it held the shard's single vitest worker:
// the time between its completion line and the previous file's, read from the
// default reporter's timestamped log lines. That counts module import and
// setup, which the reporter's own per-file duration (and the JSON reporter's
// startTime/endTime span) leaves out: 283 of 1,623 s on one shard measured
// 2026-11-08. The first file's span also holds globalSetup's migrations, so it
// is weighed as its reported duration plus the median per-file overhead.
// Only the `test:integration --shard=` step is read (shard 1 runs three more
// vitest steps after it). That step is reconciled against its own
// `Test Files … (N)` summary; one that does not reconcile (a retried shard, a
// changed reporter format) is skipped, and a run where most shard logs fail
// to parse aborts the refresh.
//
// Per file the table keeps the p75 over runs, in seconds to one decimal;
// overhead["k"] is the median over runs of the steps only shard k runs.
// Files no longer in the integration suite at HEAD are dropped.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, STALE_BELOW, TIMINGS_PATH, integrationTestFiles, loadTimings, partition, planLoads, quantile } from './shard-partition.mjs';

export class TimingLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimingLogError';
  }
}

// Colour codes, raw (API logs) or caret-escaped as `^[[32m` (`gh run view --log`).
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*m/g;
// A raw API log line, or `gh run view --log`'s `<job>\t<step>\t<line>`.
const LINE = /(?:^|\t)\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const RUN_BANNER = /^\s*RUN\s+v\d/;
// A file result is indented one space (✓ passed, ↓ skipped, ❯ or × failed);
// slow-test lines under it are indented more.
const FILE_RESULT = /^ ?([✓×↓❯]) (src\/\S+\.test\.ts) \([^)]*\)(?: +(\d+(?:\.\d+)?)(ms|s))?\s*$/;
const SUMMARY = /^\s*Test Files\s.*\((\d+)\)\s*$/;
const SHARD_JOB = /^Integration Tests \(shard (\d+)\/(\d+)\)$/;
// Each workflow step opens with a `##[group]Run <command>` marker. Shard 1 runs
// three more vitest steps after the sharded one; only that one is read.
const STEP_MARKER = /^##\[group\]Run /;
export const INTEGRATION_STEP = /\btest:integration --shard=/;

const toMs = stamp => Date.parse(stamp.replace(/(\.\d{3})\d*Z$/, '$1Z'));
const round1 = seconds => Math.round(seconds * 10) / 10;
const median = values => quantile([...values].sort((a, b) => a - b), 0.5);

// { files: { <repo path>: seconds }, count } for one shard's job log.
// The timestamped lines of the sharded integration step (the whole log when it
// has no step markers).
function integrationStepLines(text) {
  const lines = [];
  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.match(LINE);
    if (line) lines.push({ at: toMs(line[1]), body: line[2] });
  }
  const markers = lines.flatMap((l, i) => (STEP_MARKER.test(l.body) ? [i] : []));
  if (!markers.length) return lines;
  const start = markers.find(i => INTEGRATION_STEP.test(lines[i].body));
  if (start === undefined) throw new TimingLogError('no `test:integration --shard` step in the log');
  const end = markers.find(i => i > start) ?? lines.length;
  return lines.slice(start + 1, end);
}

export function parseJobLog(text, { root = 'apps/api' } = {}) {
  let runAt = null;
  const results = [];
  const summaries = [];
  for (const { at, body } of integrationStepLines(text)) {
    let m;
    if (runAt === null && RUN_BANNER.test(body)) runAt = at;
    else if ((m = body.match(FILE_RESULT))) results.push({ at, file: m[2], reported: m[3] ? Number(m[3]) / (m[4] === 's' ? 1 : 1000) : 0 });
    else if ((m = body.match(SUMMARY))) summaries.push(Number(m[1]));
  }
  if (summaries.length !== 1) throw new TimingLogError(`${summaries.length} vitest summaries in one log (expected exactly 1; a retried shard has 2)`);
  if (runAt === null) throw new TimingLogError('no vitest RUN banner before the file results');
  if (results.length !== summaries[0]) {
    throw new TimingLogError(`${results.length} file results but the summary counts ${summaries[0]}; the reporter format may have changed`);
  }
  if (new Set(results.map(r => r.file)).size !== results.length) throw new TimingLogError('a file reported twice in one run');
  let previous = runAt;
  for (const r of results) {
    if (!(r.at >= previous)) throw new TimingLogError(`log timestamps go backwards at ${r.file}`);
    previous = r.at;
  }
  const spans = results.map((r, i) => (r.at - (i ? results[i - 1].at : runAt)) / 1000);
  const overheads = results.slice(1).map((r, i) => spans[i + 1] - r.reported);
  const firstOverhead = overheads.length ? Math.max(0, median(overheads)) : 0;
  const files = {};
  results.forEach((r, i) => { files[`${root}/${r.file}`] = round1(i ? spans[i] : r.reported + firstOverhead); });
  return { files, count: results.length };
}

const seconds = s => (Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000;

// { "<shard>": seconds } of steps that succeeded on one shard and were skipped
// on every other (shard 1's ee boot and single-DB contract suites).
export function shardOverhead(jobs) {
  const shards = jobs.map(job => ({ shard: Number(job.name.match(SHARD_JOB)?.[1]), steps: job.steps ?? [] }));
  const out = {};
  for (const { shard, steps } of shards) {
    const others = shards.filter(s => s.shard !== shard);
    if (!others.length) continue;
    const own = steps.filter(step => step.conclusion === 'success'
      && others.every(o => o.steps.some(x => x.name === step.name && x.conclusion === 'skipped')));
    const total = own.reduce((sum, step) => sum + seconds(step), 0);
    if (total > 0) out[shard] = round1(total);
  }
  return out;
}

// The table from per-run samples: [{ id, createdAt, files, overhead }].
export function buildTable(runs, { present }) {
  const samples = new Map();
  for (const run of runs) {
    for (const [file, s] of Object.entries(run.files)) {
      if (!present.has(file)) continue;
      if (!samples.has(file)) samples.set(file, []);
      samples.get(file).push(s);
    }
  }
  const files = {};
  for (const file of [...samples.keys()].sort()) files[file] = round1(quantile(samples.get(file).sort((a, b) => a - b), 0.75));
  const overheadSamples = new Map();
  for (const run of runs) {
    for (const [shard, s] of Object.entries(run.overhead ?? {})) {
      if (!overheadSamples.has(shard)) overheadSamples.set(shard, []);
      overheadSamples.get(shard).push(s);
    }
  }
  const overhead = {};
  for (const shard of [...overheadSamples.keys()].sort((a, b) => Number(a) - Number(b))) overhead[shard] = round1(median(overheadSamples.get(shard)));
  return {
    schema: 1,
    generated: runs.map(r => r.createdAt).filter(Boolean).sort().at(-1) ?? null,
    source: 'ci-job-logs',
    runs: runs.map(r => r.id).sort((a, b) => a - b),
    files,
    overhead,
  };
}

export function serializeTable(table) {
  return `${JSON.stringify(table, null, 2)}\n`;
}

function runJobs(gh, repo, id) {
  return gh(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`, '--paginate', '--jq',
    '.jobs[] | {id, name, conclusion, steps: [(.steps // [])[] | {name, conclusion, started_at, completed_at}]}'])
    .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

// One run's samples, or a reason it is not usable.
function sampleRun(gh, repo, { id, createdAt }, log) {
  const shards = runJobs(gh, repo, id).filter(job => SHARD_JOB.test(job.name) && job.conclusion === 'success');
  const counts = new Set(shards.map(job => Number(job.name.match(SHARD_JOB)[2])));
  const indexes = [...new Set(shards.map(job => Number(job.name.match(SHARD_JOB)[1])))].sort((a, b) => a - b);
  if (!shards.length) return { skip: 'no green integration shards' };
  if (counts.size !== 1) return { skip: `integration shard counts disagree (${[...counts].join(', ')})` };
  const [count] = counts;
  if (indexes.length !== count || shards.length !== count) return { skip: `integration shards ${indexes.join(',')} of ${count}` };
  const files = {};
  let failures = 0;
  for (const job of shards) {
    try {
      Object.assign(files, parseJobLog(gh(['run', 'view', '-R', repo, '--job', String(job.id), '--log'])).files);
    } catch (error) {
      if (!(error instanceof TimingLogError)) throw error;
      failures++;
      log(`run ${id} job ${job.id} (${job.name}): skipped: ${error.message}`);
    }
  }
  if (failures * 2 > shards.length) {
    throw new TimingLogError(`run ${id}: ${failures} of ${shards.length} shard logs did not parse; the reporter format may have changed`);
  }
  // A partial run would leave some files with fewer samples than the table
  // implies, so it is not a sample at all.
  if (failures) return { skip: `${failures} of ${shards.length} shard logs did not parse` };
  const overhead = shardOverhead(shards);
  if (!Object.keys(overhead).length) log(`run ${id}: no shard-only steps found, so this run adds no overhead sample`);
  return { sample: { id, createdAt, files, overhead } };
}

// The new table (an object). `present`: the integration files at HEAD.
export function refresh({ gh, repo, runs, runIds, present, log = m => process.stderr.write(`${m}\n`) }) {
  const collected = [];
  if (runIds?.length) {
    for (const id of runIds) {
      const createdAt = gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '.created_at']).trim() || null;
      const { sample, skip } = sampleRun(gh, repo, { id, createdAt }, log);
      if (skip) throw new TimingLogError(`run ${id}: ${skip}`);
      collected.push(sample);
    }
  } else {
    const want = runs ?? 10;
    const listed = JSON.parse(gh(['run', 'list', '-R', repo, '--workflow', 'CI', '--event', 'merge_group', '--status', 'success',
      '--limit', String(Math.max(50, want * 4)), '--json', 'databaseId,createdAt']));
    for (const run of listed) {
      if (collected.length >= want) break;
      const { sample, skip } = sampleRun(gh, repo, { id: run.databaseId, createdAt: run.createdAt }, log);
      if (skip) { log(`run ${run.databaseId}: skipped, ${skip}`); continue; }
      log(`run ${run.databaseId}: ${Object.keys(sample.files).length} files`);
      collected.push(sample);
    }
    if (collected.length < want) throw new TimingLogError(`found only ${collected.length} usable runs of the ${want} requested`);
  }
  return buildTable(collected, { present });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, out: join(REPO_ROOT, TIMINGS_PATH), repo: process.env.GITHUB_REPOSITORY || 'LanternOps/breeze' };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--runs') opts.runs = Number(value);
    else if (flag === '--run-ids') opts.runIds = value.split(',').map(Number);
    else if (flag === '--out') opts.out = value;
    else if (flag === '--repo') opts.repo = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (opts.command !== 'refresh') throw new Error('usage: test-timings.mjs refresh [--runs N | --run-ids a,b] [--out path] [--repo owner/name]');
  if (opts.runs !== undefined && !(Number.isInteger(opts.runs) && opts.runs > 0)) throw new Error('--runs must be a positive integer');
  if (opts.runIds?.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('--run-ids must be run ids');
  return opts;
}

// Checks a refreshed table before it replaces the committed one: it must be a
// table the sequencer accepts and cover at least STALE_BELOW of the suite.
// Returns the summary lines; throws (writing nothing) otherwise.
export function writeTable(table, { present, out, count = 16, write = writeFileSync }) {
  const text = serializeTable(table);
  const loaded = loadTimings(text);
  if (!loaded) throw new TimingLogError('the refreshed table is empty or invalid; nothing written');
  const known = present.filter(f => Object.hasOwn(loaded.timings, f)).length;
  if (known / present.length < STALE_BELOW) {
    throw new TimingLogError(`the refreshed table covers only ${known}/${present.length} integration files; nothing written`);
  }
  write(out, text);
  const loads = planLoads(partition(present, { count, ...loaded }), loaded);
  const mean = loads.reduce((s, x) => s + x, 0) / loads.length;
  return [
    `wrote ${out}: ${Object.keys(table.files).length} files from runs ${table.runs.join(', ')}`,
    `coverage ${known}/${present.length}; projected ${count}-shard max/mean ${(Math.max(...loads) / mean).toFixed(3)}`
      + ` (max ${Math.round(Math.max(...loads))}s, mean ${Math.round(mean)}s); overhead ${JSON.stringify(table.overhead)}`,
  ];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const present = integrationTestFiles(REPO_ROOT);
  const table = refresh({ gh, repo: opts.repo, runs: opts.runs, runIds: opts.runIds, present: new Set(present) });
  for (const line of writeTable(table, { present, out: opts.out })) console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) {
    console.error(`test-timings: ${error.message}`);
    process.exit(1);
  }
}
