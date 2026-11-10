// Flake sightings: what each CI run says about each failing test (W06a, #10750).
//
// A sighting is one test id's outcome across one job's two attempts:
//   fail_pass  — failed on attempt 1, passed on the retry (the report's `flaky`);
//   fail_fail  — failed on both attempts;
//   fail_other — failed on attempt 1 only, while attempt 2 failed on other tests.
// Attempts come from a schema-2 flake report, or else from the job log split at
// retry-shard's retry marker (facts.processLog). Fork runs give no sightings:
// their code is not ours, and neither is their evidence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ledgerPaths, ledgerRunner } from '../../.github/scripts/retry-shard.mjs';

// Both Go retry-shard jobs pass `--go-dir agent`.
export const GO_DIR = 'agent';

const GO_TEST_ID = /^(.+?)\.((?:Test|Fuzz|Example)[A-Za-z0-9_]*(?:\/.*)?)$/;

// A reported id back to the `{ id, file, pkg }` shape retry-shard parses and
// flaky-ledger matches: vitest `<file> > … > <test>` (file relative to the
// package), go `<import path>.<Test>[/<sub>]` or a bare package.
export function failureFromId(runner, id) {
  if (runner === 'go') {
    const m = GO_TEST_ID.exec(id);
    return { id, file: null, pkg: m ? m[1] : id };
  }
  return { id, file: id.split(' > ')[0].replace(/\s+\[.*\]$/, '').trim(), pkg: null };
}

// { source, first, second, flaky } for a job, or null when it has no attempts
// to read. `flaky` is the report's list (schema 1 or 2), or null without one.
export function attemptsOf(job) {
  const flaky = Array.isArray(job.report?.flaky) ? job.report.flaky : null;
  if (job.report?.schema === 2) return { source: 'report', first: job.report.first, second: job.report.second, flaky };
  if (Array.isArray(job.logAttempts) && job.logAttempts.length) {
    return { source: 'log', first: job.logAttempts[0], second: job.logAttempts[1] ?? null, flaky };
  }
  return flaky ? { source: 'report', first: null, second: null, flaky } : null;
}

const pathsCache = new Map();
function pathsFor(ledger, repoRoot) {
  const key = `${ledger}\0${repoRoot}`;
  if (!pathsCache.has(key)) pathsCache.set(key, ledgerPaths(ledger, { repoRoot, goDir: join(repoRoot, GO_DIR) }));
  return pathsCache.get(key);
}

// Repo-relative path of a failure: the vitest test file, or the Go package dir.
export function repoPathOf(ledger, failure, repoRoot) {
  const paths = pathsFor(ledger, repoRoot);
  if (!paths) return null;
  if (failure.file) return `${paths.prefix ?? ''}${failure.file}`;
  if (!failure.pkg || !paths.goModule) return null;
  if (failure.pkg === paths.goModule) return paths.goDir;
  if (!failure.pkg.startsWith(`${paths.goModule}/`)) return null;
  return `${paths.goDir}/${failure.pkg.slice(paths.goModule.length + 1)}`;
}

export function ingestRun(facts, { repo, repoRoot }) {
  if (facts.run.headRepo?.toLowerCase() !== repo.toLowerCase()) return [];
  const out = [];
  for (const job of facts.jobs) {
    const ledger = job.runner && job.label ? ledgerRunner(job.runner, job.label) : null;
    const a = ledger && attemptsOf(job);
    if (!a) continue;
    const add = (id, kind) => {
      const failure = failureFromId(job.runner, id);
      out.push({
        runner: ledger,
        id,
        file: repoPathOf(ledger, failure, repoRoot),
        kind,
        run: facts.run.id,
        attempt: facts.run.attempt,
        job: job.name,
        pr: facts.run.pr,
        event: facts.run.event,
        sha: facts.run.headSha,
        at: job.completedAt ?? facts.run.updatedAt,
      });
    };
    const seen = new Set();
    for (const id of a.flaky ?? []) {
      seen.add(id);
      add(id, 'fail_pass');
    }
    if (a.first && a.second) {
      const second = new Set(a.second.failures);
      for (const id of a.first.failures) {
        if (seen.has(id)) continue;
        if (second.has(id)) add(id, 'fail_fail');
        else if (a.second.failures.length) add(id, 'fail_other');
      }
    }
  }
  return out;
}

const key = (s) => `${s.run}\0${s.attempt}\0${s.job}\0${s.runner}\0${s.id}`;

export class History {
  constructor(list) {
    this.list = list;
    this.byTest = new Map();
    for (const s of list) {
      const k = `${s.runner}\0${s.id}`;
      if (!this.byTest.has(k)) this.byTest.set(k, []);
      this.byTest.get(k).push(s);
    }
  }

  // Dedupes by (run, attempt, job, runner, id); the first copy wins.
  static fromSightings(list) {
    const seen = new Set();
    const unique = [];
    for (const s of list) {
      if (seen.has(key(s))) continue;
      seen.add(key(s));
      unique.push(s);
    }
    return new History(unique);
  }

  // Sightings of one test from `since` through `until`. `excludePr` drops that
  // PR's own non-queue runs (its merge_group runs still count); `excludeRun`
  // drops one run. `until` keeps a replay from using later evidence.
  sightings(runner, id, { since = null, until = null, excludePr = null, excludeRun = null } = {}) {
    const from = since === null ? -Infinity : Date.parse(since);
    const to = until === null ? Infinity : Date.parse(until);
    return (this.byTest.get(`${runner}\0${id}`) ?? []).filter((s) => {
      const at = Date.parse(s.at);
      return at >= from && at <= to && s.run !== excludeRun && !(excludePr !== null && s.pr === excludePr && s.event !== 'merge_group');
    });
  }

  all() {
    return [...this.list];
  }
}

export function readSightings(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
