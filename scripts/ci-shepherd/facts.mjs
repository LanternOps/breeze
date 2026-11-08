// Facts about a merge-queue removal (W06a, #10750).
//
// Read-only: every function here only GETs or runs GraphQL queries. Given a
// `failed_checks` removal it finds the merge_group CI run that tested the PR
// and, for each failed or cancelled job, the evidence the classifier needs:
// annotations, the job log (tail + each retry attempt's parsed failures) and
// the job's flake-report artifact.
//
// Two facts verified against the API on 2026-11-08 shape this file:
//   - A RemovedFromMergeQueueEvent's `beforeCommit` is the MERGE-GROUP commit
//     (the squash the queue tested; its parent is the base), not the PR head.
//     It equals the group run's `head_sha`, so it finds the run exactly.
//   - A job log is ~2 MB and the vitest failure summary of the last attempt
//     can sit more than 400 lines from the end, so failures are parsed from
//     the whole log here and only a tail is kept.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jobInstances, workflowJobsOf } from '../../.github/scripts/ci-gate.mjs';
import { parseFailures } from '../../.github/scripts/retry-shard.mjs';
import { GitHubError } from './github.mjs';

export const CI_WORKFLOW = '.github/workflows/ci.yml';
export const CI_SUCCESS = 'CI Success';
export const MAX_REPORT_BYTES = 256 * 1024;
export const LOG_TAIL_LINES = 400;
export const MAX_ATTEMPT_IDS = 200;
const MAX_FILES = 3000;
const GROUP_WINDOW_MS = 6 * 3600_000;

const ms = (iso) => Date.parse(iso);
const toIso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function getJson(gh, path) {
  const res = await gh.rest('GET', path);
  if (res.status !== 200) throw new GitHubError(res.status, `GET ${path}: ${res.status} ${res.body?.message ?? ''}`.trim());
  return res.body;
}

// ── Removals ─────────────────────────────────────────────────────────────

const QUEUE_EVENT_FIELDS = `
  __typename
  ... on AddedToMergeQueueEvent { id createdAt actor { login } }
  ... on RemovedFromMergeQueueEvent { id createdAt reason actor { login } beforeCommit { oid } }`;

const REMOVALS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        updatedAt
        timelineItems(last: 20, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, ADDED_TO_MERGE_QUEUE_EVENT]) {
          nodes { ${QUEUE_EVENT_FIELDS} }
        }
      }
    }
  }
}`;

const queueEvent = (ev) =>
  ev.__typename === 'AddedToMergeQueueEvent'
    ? { type: 'added', id: ev.id, at: ev.createdAt, actor: ev.actor?.login ?? null }
    : {
        type: 'removed',
        id: ev.id,
        at: ev.createdAt,
        actor: ev.actor?.login ?? null,
        reason: ev.reason ?? null,
        beforeCommit: ev.beforeCommit?.oid ?? null,
      };

// Removal = { pr, id, at, reason, actor, beforeCommit }, oldest first. Pages
// through PRs by most recent update until one page's oldest update predates
// `since` or `maxPages` is reached. Stopping there assumes a queue event bumps
// the PR's updatedAt (not verified separately); only the last 20 queue events
// of each PR are read. `stats.complete` is set false when `maxPages` ran out
// before the cutoff, so a caller can say its list is partial.
export async function recentRemovals(gh, { repo, since, until = null, maxPages = 1, stats = {} }) {
  const [owner, name] = repo.split('/');
  const from = ms(since);
  const to = until === null ? Infinity : ms(until);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error(`recentRemovals: bad window ${since}..${until}`);
  const out = [];
  let after = null;
  stats.complete = false;
  for (let page = 0; page < maxPages; page++) {
    const conn = (await gh.graphql(REMOVALS_QUERY, { owner, name, after })).repository.pullRequests;
    for (const pr of conn.nodes) {
      for (const ev of pr.timelineItems.nodes) {
        if (ev.__typename !== 'RemovedFromMergeQueueEvent') continue;
        const at = ms(ev.createdAt);
        if (at < from || at >= to) continue;
        const { id, actor, reason, beforeCommit } = queueEvent(ev);
        out.push({ pr: pr.number, id, at: ev.createdAt, reason, actor, beforeCommit });
      }
    }
    const oldest = conn.nodes.at(-1)?.updatedAt;
    if (!conn.pageInfo.hasNextPage || !oldest || ms(oldest) < from) {
      stats.complete = true;
      break;
    }
    after = conn.pageInfo.endCursor;
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
}

// ── PR snapshot ──────────────────────────────────────────────────────────

const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      number
      state
      headRefOid
      headRefName
      isCrossRepository
      headRepository { nameWithOwner }
      autoMergeRequest { enabledAt }
      mergeQueueEntry { state position }
      labels(first: 100) { nodes { name } }
      timelineItems(last: 30, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { ${QUEUE_EVENT_FIELDS} }
      }
    }
  }
}`;

// PrSnapshot = { pr, state: 'OPEN'|'CLOSED'|'MERGED', headSha, headRef, isFork,
// autoMerge, queue: {state, position}|null, labels, files, events }.
// `files` includes both sides of a rename; `events` are oldest first.
export async function prSnapshot(gh, { repo, pr, withFiles = true }) {
  const [owner, name] = repo.split('/');
  const p = (await gh.graphql(PR_QUERY, { owner, name, n: pr })).repository.pullRequest;
  if (!p) throw new GitHubError(404, `PR #${pr} not found`);
  const files = [];
  if (withFiles) {
    for (let page = 1; files.length < MAX_FILES; page++) {
      const list = await getJson(gh, `repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
      for (const f of list) {
        files.push(f.filename);
        if (f.previous_filename) files.push(f.previous_filename);
      }
      if (list.length < 100) break;
    }
  }
  return {
    pr,
    state: p.state,
    headSha: p.headRefOid,
    headRef: p.headRefName,
    isFork: Boolean(p.isCrossRepository) || p.headRepository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase(),
    autoMerge: p.autoMergeRequest !== null && p.autoMergeRequest !== undefined,
    queue: p.mergeQueueEntry ? { state: p.mergeQueueEntry.state, position: p.mergeQueueEntry.position } : null,
    labels: p.labels.nodes.map((l) => l.name),
    files: [...new Set(files)],
    events: p.timelineItems.nodes.map(queueEvent).sort((a, b) => ms(a.at) - ms(b.at)),
  };
}

// ── The group run ────────────────────────────────────────────────────────

const runRef = (r) => ({
  id: r.id,
  attempt: r.run_attempt,
  headSha: r.head_sha,
  headBranch: r.head_branch,
  createdAt: r.created_at,
  conclusion: r.conclusion,
});

const newest = (runs) => runs.sort((a, b) => ms(b.created_at) - ms(a.created_at) || b.id - a.id)[0] ?? null;

// The merge_group CI run that tested the PR before this removal, or null.
// By `beforeCommit` (the group commit) when present; otherwise, or when no run
// has that head, the newest run on the PR's queue branch created in the six
// hours before the removal.
export async function groupRunFor(gh, { repo, pr, removal }) {
  const at = ms(removal.at);
  const eligible = (r) => r.path === CI_WORKFLOW && r.event === 'merge_group' && ms(r.created_at) <= at;
  if (removal.beforeCommit) {
    const q = new URLSearchParams({ event: 'merge_group', head_sha: removal.beforeCommit, per_page: '20' });
    const body = await getJson(gh, `repos/${repo}/actions/workflows/ci.yml/runs?${q}`);
    const run = newest(body.workflow_runs.filter((r) => eligible(r) && r.head_sha === removal.beforeCommit));
    if (run) return runRef(run);
  }
  const branch = new RegExp(`^gh-readonly-queue/.+/pr-${pr}-[0-9a-f]+$`);
  const found = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ event: 'merge_group', created: `${toIso(at - GROUP_WINDOW_MS)}..${toIso(at)}`, per_page: '100', page: String(page) });
    const body = await getJson(gh, `repos/${repo}/actions/workflows/ci.yml/runs?${q}`);
    found.push(...body.workflow_runs.filter((r) => eligible(r) && branch.test(r.head_branch ?? '')));
    if (body.workflow_runs.length < 100) break;
  }
  const run = newest(found);
  return run && runRef(run);
}

// ── Job identity from ci.yml ─────────────────────────────────────────────

const MATRIX_REF = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `Integration Tests (shard ${{ matrix.shard }}/16)` vs `Integration Tests
// (shard 11/16)` → { shard: '11' }; null when the name does not fit.
function matrixValues(template, name) {
  const keys = [];
  const pattern = template
    .split(MATRIX_REF)
    .map((part, i) => {
      if (i % 2 === 1) {
        keys.push(part);
        return '(.+?)';
      }
      return escapeRe(part);
    })
    .join('');
  const m = new RegExp(`^${pattern}$`).exec(name);
  return m ? Object.fromEntries(keys.map((k, i) => [k, m[i + 1]])) : null;
}

// The ci.yml job behind a display name: its id, `timeout-minutes` (null when
// unset) and, when it runs retry-shard, the `--label` (matrix values filled in)
// and `--runner`. Names are matched through ci-gate's jobInstances.
export function jobIdentity(ciYml, name) {
  const none = { jobId: null, timeoutMinutes: null, label: null, runner: null };
  for (const [jobId, { body }] of Object.entries(workflowJobsOf(ciYml))) {
    let inst;
    try {
      inst = jobInstances(ciYml, jobId);
    } catch {
      continue;
    }
    if (!inst || !(inst.template === name || inst.expected.includes(name))) continue;
    const values = matrixValues(inst.template, name) ?? {};
    const timeout = /^ {4}timeout-minutes: (\d+)\s*$/m.exec(body);
    const shard = /retry-shard\.mjs\s+(.*)$/m.exec(body);
    let label = null;
    let runner = null;
    if (shard) {
      runner = /--runner\s+(\S+)/.exec(shard[1])?.[1] ?? null;
      // `api-${{ matrix.shard }}` has spaces inside the expression.
      const raw = /--label\s+((?:\$\{\{[^}]*\}\}|\S)+)/.exec(shard[1])?.[1] ?? null;
      label = raw && raw.replace(MATRIX_REF, (ref, key) => values[key] ?? ref);
      if (label && label.includes('${{')) label = null;
    }
    return { jobId, timeoutMinutes: timeout ? Number(timeout[1]) : null, label, runner };
  }
  return none;
}

// The ci.yml job ids `CI Success` needs: only their failures can fail it.
export function requiredJobIds(ciYml) {
  const body = workflowJobsOf(ciYml)['ci-success']?.body ?? '';
  const needs = /^ {4}needs: \[([^\]]+)\]/m.exec(body);
  if (!needs) throw new Error('ci.yml: cannot read the needs of ci-success');
  return new Set(needs[1].split(',').map((s) => s.trim()).filter(Boolean));
}

// ── Logs ─────────────────────────────────────────────────────────────────

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// retry-shard's `::warning` before attempt 2 (the log shows it as `##[warning]…`).
const RETRY_MARKER = /re-running the whole shard once/;

export function cleanLog(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(TIMESTAMP, '').replace(ANSI, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

const capIds = (ids) => {
  const unique = [...new Set(ids)];
  return { failures: unique.slice(0, MAX_ATTEMPT_IDS), truncated: unique.length > MAX_ATTEMPT_IDS };
};

// retry-shard re-prints `go test -json` as plain `go test -v` text, so the log
// has `--- FAIL: TestX` lines followed by the package's `FAIL\t<pkg>\t…` line.
const GO_FAIL_TEST = /^\s*--- FAIL: (\S+)/;
const GO_FAIL_PKG = /^FAIL\t(\S+?)(?:\t| \[|$)/;
const GO_OK_PKG = /^ok\s+\S+/;

function parseGoText(text) {
  const ids = [];
  let pending = [];
  let buildFailed = false;
  let raceDetected = false;
  let timedOut = false;
  let unattributed = false;
  for (const line of text.split('\n')) {
    if (line.includes('WARNING: DATA RACE')) raceDetected = true;
    if (/^panic: test timed out after /.test(line)) timedOut = true;
    if (/^panic: /.test(line)) unattributed = true;
    let m = GO_FAIL_TEST.exec(line);
    if (m) {
      pending.push(m[1]);
      continue;
    }
    m = GO_FAIL_PKG.exec(line);
    if (m) {
      if (/\[(?:build|setup) failed\]/.test(line)) buildFailed = true;
      const tests = pending.filter((t) => !pending.some((o) => o.startsWith(`${t}/`)));
      ids.push(...(tests.length ? tests.map((t) => `${m[1]}.${t}`) : [m[1]]));
      pending = [];
      continue;
    }
    if (GO_OK_PKG.test(line)) pending = [];
  }
  return { ...capIds(ids), unattributed, buildFailed, raceDetected, timedOut };
}

function attemptFromText(runner, text) {
  if (runner === 'go') return parseGoText(text);
  const p = parseFailures(runner, text);
  return {
    ...capIds(p.failures.map((f) => f.id)),
    unattributed: p.unattributed,
    buildFailed: p.buildFailed,
    raceDetected: p.raceDetected,
    timedOut: p.timedOut,
  };
}

// { logTail, logAttempts }. `logAttempts` (null without a retry-shard runner)
// holds one parsed attempt per side of the retry marker: one entry when no
// retry ran, two when it did. Same shape as a schema-2 report attempt, minus
// the exit code.
export function processLog(text, runner) {
  const lines = cleanLog(text);
  const logTail = lines.slice(-LOG_TAIL_LINES).join('\n');
  if (runner !== 'vitest' && runner !== 'go') return { logTail, logAttempts: null };
  const cut = lines.findIndex((l) => RETRY_MARKER.test(l));
  const segments = cut === -1 ? [lines] : [lines.slice(0, cut), lines.slice(cut + 1)];
  return { logTail, logAttempts: segments.map((seg) => attemptFromText(runner, seg.join('\n'))) };
}

// ── Flake reports ────────────────────────────────────────────────────────

const REPORT_NAME = /^flake-report-[A-Za-z0-9._-]+\.json$/;

export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report is not an object';
  if (report.schema === 2) {
    const attemptOk = (a) => a && typeof a === 'object' && Array.isArray(a.failures);
    if (typeof report.label !== 'string' || !attemptOk(report.first) || !(report.second === null || attemptOk(report.second))) {
      return 'schema 2 report is malformed';
    }
    return null;
  }
  if (report.schema === undefined) {
    if (typeof report.label !== 'string' || !Array.isArray(report.flaky) || !Array.isArray(report.quarantined) || !Number.isInteger(report.attempts)) {
      return 'schema 1 report is malformed';
    }
    return null;
  }
  return `unsupported schema ${JSON.stringify(report.schema)}`;
}

// Reads the one flake report out of an artifact zip without extracting
// anything: `unzip -Z1` lists members, `unzip -p` streams the member into a
// buffer capped just past 256 KB (so a zip bomb fails as "too large").
export function readReportZip(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-shepherd-'));
  const fail = (reportError) => ({ report: null, reportError });
  try {
    const zip = join(dir, 'artifact.zip');
    writeFileSync(zip, bytes);
    let members;
    try {
      members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).split('\n').filter(Boolean);
    } catch (e) {
      return fail(`artifact is not a readable zip (${e.code ?? e.status ?? e.message})`);
    }
    const reports = members.filter((m) => REPORT_NAME.test(m));
    if (reports.length !== 1) return fail(`expected one flake report in the artifact, found ${reports.length}`);
    let text;
    try {
      text = execFileSync('unzip', ['-p', zip, reports[0]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_REPORT_BYTES + 1, timeout: 30_000 });
    } catch (e) {
      return fail(e.code === 'ENOBUFS' ? `too large: over ${MAX_REPORT_BYTES} bytes inflated` : `cannot inflate the flake report (${e.code ?? e.status ?? e.message})`);
    }
    if (Buffer.byteLength(text) > MAX_REPORT_BYTES) return fail(`too large: over ${MAX_REPORT_BYTES} bytes inflated`);
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      return fail('invalid JSON');
    }
    const invalid = validateReport(report);
    return invalid ? fail(invalid) : { report, reportError: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listArtifacts(gh, repo, runId) {
  const list = [];
  for (let page = 1; page <= 3; page++) {
    const res = await gh.rest('GET', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if (res.status !== 200) return { list, error: `artifact listing ${res.status}` };
    list.push(...res.body.artifacts);
    if (res.body.artifacts.length < 100) break;
  }
  return { list, error: null };
}

// A report belongs to this job attempt only if it was uploaded after the
// attempt started and (schema 2) its provenance names this run and attempt.
// The artifact name is reused across attempts with `overwrite: true`, so a
// re-run that fails before retry-shard writes anything leaves the previous
// attempt's report in place; reading it would classify a failure nobody saw.
export function staleReason(report, artifact, { runId, jobAttempt, jobStartedAt }) {
  const uploaded = artifact.updated_at ?? artifact.created_at;
  if (uploaded && jobStartedAt && ms(uploaded) < ms(jobStartedAt)) return 'stale: uploaded before this job attempt started';
  const p = report?.schema === 2 ? report.provenance : null;
  if (p?.runId && String(p.runId) !== String(runId)) return `stale: report is from run ${p.runId}`;
  if (p?.runAttempt && jobAttempt !== null && jobAttempt !== undefined && String(p.runAttempt) !== String(jobAttempt)) {
    return `stale: report is from attempt ${p.runAttempt}`;
  }
  return null;
}

async function flakeReport(gh, repo, artifacts, label, ctx) {
  if (artifacts.error) return { report: null, reportError: artifacts.error };
  const a = artifacts.list.find((x) => x.name === `flake-report-${label}`);
  if (!a) return { report: null, reportError: 'not_uploaded' };
  if (a.expired) return { report: null, reportError: 'expired' };
  if (a.size_in_bytes > MAX_REPORT_BYTES) return { report: null, reportError: `too large: ${a.size_in_bytes} bytes zipped` };
  const early = staleReason(null, a, ctx);
  if (early) return { report: null, reportError: early };
  const zip = await gh.raw(`repos/${repo}/actions/artifacts/${a.id}/zip`, { binary: true });
  if (!zip.bytes) return { report: null, reportError: `artifact download ${zip.status}` };
  const read = readReportZip(zip.bytes);
  const stale = read.report && staleReason(read.report, a, ctx);
  return stale ? { report: null, reportError: stale } : read;
}

// ── Run facts ────────────────────────────────────────────────────────────

const QUEUE_BRANCH_PR = /^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/;
const failedStep = (steps = []) =>
  (steps.find((s) => s.conclusion === 'failure') ?? steps.find((s) => s.conclusion === 'cancelled') ?? steps.find((s) => s.status === 'in_progress'))?.name ?? null;

// { jobs, complete }: `complete` is false when the listing stopped short of
// `total_count` (three pages of 100).
async function listJobs(gh, repo, runId) {
  const jobs = [];
  let total = 0;
  for (let page = 1; page <= 3; page++) {
    const body = await getJson(gh, `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...body.jobs);
    total = body.total_count ?? jobs.length;
    if (body.jobs.length < 100 || jobs.length >= total) break;
  }
  return { jobs, complete: jobs.length >= total };
}

// A job that did not pass: anything but success, skipped or neutral (failure,
// cancelled, timed_out, startup_failure, action_required…). Null = unfinished.
export const isFailedConclusion = (c) => typeof c === 'string' && !['success', 'skipped', 'neutral'].includes(c);

async function annotationsOf(gh, repo, jobId) {
  // GitHub keeps at most 50 annotations per job, so one page of 100 holds them all.
  const res = await gh.rest('GET', `repos/${repo}/check-runs/${jobId}/annotations?per_page=100`);
  if (res.status !== 200 || !Array.isArray(res.body)) return { annotations: [], error: `annotations ${res.status}` };
  const annotations = res.body
    .filter((a) => a.annotation_level === 'failure' || a.annotation_level === 'warning')
    .map((a) => (a.title ? `${a.title}: ${a.message}` : a.message));
  return { annotations, error: null };
}

const GATE_LINE = /^ci-gate: verdict=(\S+) reason=(\S+)/m;

// The newest `CI Gate` run's verdict for this head, or null when none ran.
async function gateFor(gh, repo, headSha) {
  const res = await gh.rest('GET', `repos/${repo}/actions/workflows/ci-gate.yml/runs?head_sha=${headSha}&per_page=5`);
  if (res.status === 404) return null;
  if (res.status !== 200) return { verdict: null, reason: `gate_lookup_${res.status}` };
  const run = newest(res.body.workflow_runs ?? []);
  if (!run) return null;
  const { jobs } = await listJobs(gh, repo, run.id);
  for (const job of jobs) {
    const log = await gh.raw(`repos/${repo}/actions/jobs/${job.id}/logs`);
    const m = log.text && GATE_LINE.exec(cleanLog(log.text).join('\n'));
    if (m) return { verdict: m[1], reason: m[2], run: run.id };
  }
  return { verdict: null, reason: 'gate_line_missing', run: run.id };
}

// RunFacts = { run, jobs: JobFact[], jobsComplete, ciSuccess: 'present'|'missing', gate }.
// Only jobs that did not pass (never the CI Success aggregate) get their
// annotations and log fetched; any retry-shard job's flake report is read when
// the job failed or uploaded one. A fetch that fails is recorded on the fact
// (`errors`, `logStatus`, `reportError`), never dropped.
export async function runFacts(gh, { repo, runId, ciYml }) {
  const r = await getJson(gh, `repos/${repo}/actions/runs/${runId}`);
  const queuePr = QUEUE_BRANCH_PR.exec(r.head_branch ?? '');
  const run = {
    id: r.id,
    attempt: r.run_attempt,
    headSha: r.head_sha,
    headBranch: r.head_branch,
    headRepo: r.head_repository?.full_name ?? null,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pr: queuePr ? Number(queuePr[1]) : (r.pull_requests?.[0]?.number ?? null),
  };
  const { jobs: apiJobs, complete: jobsComplete } = await listJobs(gh, repo, runId);
  let artifacts = null;
  const jobs = [];
  for (const j of apiJobs) {
    const ident = jobIdentity(ciYml, j.name);
    const fact = {
      id: j.id,
      name: j.name,
      jobId: ident.jobId,
      attempt: j.run_attempt ?? null,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      timeoutMinutes: ident.timeoutMinutes,
      label: ident.label,
      runner: ident.runner,
      failedStep: failedStep(j.steps),
      annotations: [],
      logStatus: null,
      logTail: null,
      logAttempts: null,
      report: null,
      reportError: null,
      errors: [],
    };
    const failed = isFailedConclusion(j.conclusion) && j.name !== CI_SUCCESS;
    if (failed) {
      const ann = await annotationsOf(gh, repo, j.id);
      fact.annotations = ann.annotations;
      if (ann.error) fact.errors.push(ann.error);
      const log = await gh.raw(`repos/${repo}/actions/jobs/${j.id}/logs`);
      fact.logStatus = log.status;
      if (log.text !== null) Object.assign(fact, processLog(log.text, ident.runner));
    }
    // A job that failed then passed on the retry succeeded, and its report is
    // the only record of that flake, so a passed job's report is read too when
    // one was uploaded (retry-shard writes one only after a failed attempt 1).
    if (ident.label) {
      artifacts ??= await listArtifacts(gh, repo, runId);
      const uploaded = artifacts.list.some((a) => a.name === `flake-report-${ident.label}`);
      const ctx = { runId: r.id, jobAttempt: fact.attempt, jobStartedAt: j.started_at };
      if (failed || uploaded || artifacts.error) Object.assign(fact, await flakeReport(gh, repo, artifacts, ident.label, ctx));
    }
    jobs.push(fact);
  }
  return {
    run,
    jobs,
    jobsComplete,
    ciSuccess: apiJobs.some((j) => j.name === CI_SUCCESS) ? 'present' : 'missing',
    gate: await gateFor(gh, repo, run.headSha),
  };
}
