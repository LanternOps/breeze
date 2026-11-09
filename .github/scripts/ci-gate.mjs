// The verdict core of the pinned CI Gate (W02, #10746).
//
// Policy comes from the base revision: its classifier decides the flags and its
// `ci-success` script decides the result. The candidate supplies only the diff
// and job results from the Actions API, plus display names for finding those
// jobs. Nothing from the candidate tree is executed.
//
// This covers selection. It does not prove tests ran honestly: a PR can still
// replace a job's `run:` under the same id. See the W02 plan.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isPolicyPath } from './ci-policy.mjs';
import { CLASSIFIER_KEYS, SHADOW_FIELDS, createIO, nonGatingJobs, policyDigest, shadowCore, workflowJobs } from './queue-selection.mjs';
import { SELECTION_FILE, THINNABLE, bindingOf, choose, fullSelection, readsThinSkip, selectionArtifact, selectionFailure, thinSkipValue } from './ci-gate-thin.mjs';

const CLASSIFIER = '.github/scripts/classify-pr-paths.sh';
const CLASSIFIER_SIDECARS = ['qemu-gate-paths.txt', 'integration-floor-paths.txt', 'path-reader-map.txt'];

// What the `changes` job prints when it cannot classify. Pinned to ci.yml by a test.
export const FULL_SUITE_FLAGS = Object.freeze({
  code: 'true', docs: 'true', agent: 'true', app: 'true', api: 'true', web: 'true', portal: 'true', addins: 'true',
  m365: 'true', rust: 'true', topology_browser: 'true', agent_code: 'true', integration: 'true', path_readers: 'true',
  reader_tests: '',
});

export class GateError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const DERIVED_OUTPUTS = new Set(['mobile-native-changes.mobile']);
const isSha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
const nonEmptyLines = text => text.split('\n').filter(Boolean);
// execFileSync's message starts "Command failed: <argv>". The cause is in stderr.
const failureText = error => (nonEmptyLines(String(error?.stderr ?? '').trim())[0] ?? nonEmptyLines(String(error?.message ?? error))[0] ?? 'unknown failure').slice(0, 300);

export function createGateIO(options = {}) {
  const io = createIO(options);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  io.repository = env.GITHUB_REPOSITORY;
  // A deadline for what follows, so the shadow selection cannot outlast the job
  // and turn a decided verdict into a timeout. Infinity leaves every timeout as written.
  let endsAt = Infinity;
  io.limitTime = at => { endsAt = at; };
  const within = ceiling => {
    const left = endsAt - Date.now();
    if (left <= 0) throw new GateError('selection_time_limit');
    return Math.min(ceiling, left);
  };
  // git and gh reach the network here (lazy blobs, paginated jobs), so they get
  // more than createIO's 30 s. io.git and io.gh both go through io.exec.
  io.exec = (command, args, input, childEnv = {}) => execFileSync(command, args, {
    cwd, env: { ...env, ...childEnv }, input, encoding: 'utf8',
    timeout: within(180_000), maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  // Real path: on macOS tmpdir() is a symlink, and a script's own main-module
  // check compares argv[1] with its resolved URL.
  io.temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ci-gate-')));
  io.sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.min(ms, endsAt - Date.now())));
  // Base-revision code runs with exactly this environment. The token never reaches it.
  io.runIsolated = (command, args, { input, childEnv = {}, dir } = {}) => execFileSync(command, args, {
    cwd: dir ?? cwd, env: { PATH: env.PATH, ...childEnv }, input, encoding: 'utf8',
    timeout: within(60_000), maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return io;
}

const showAt = (io, revision, path) => io.git(['show', `${revision}:${path}`]);

// A temp copy of the base's classifier and sidecars, run with no token in its environment.
function runBaseClassifier(io, dir, baseSha, input, args) {
  io.write(join(dir, 'classify-pr-paths.sh'), showAt(io, baseSha, CLASSIFIER));
  for (const name of CLASSIFIER_SIDECARS) {
    // An absent sidecar is the classifier's own fail-closed case.
    try { io.write(join(dir, name), showAt(io, baseSha, `.github/scripts/${name}`)); } catch { /* absent at this base */ }
  }
  return io.runIsolated('bash', [join(dir, 'classify-pr-paths.sh'), ...args], { input, dir });
}

const parseFlags = stdout => Object.fromEntries(nonEmptyLines(stdout).map(line => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));

function classifyAtBase(io, baseSha, changed) {
  const dir = io.temp();
  try {
    const flags = parseFlags(runBaseClassifier(io, dir, baseSha, `${changed.join('\n')}\n`, []));
    return 'code' in flags ? flags : { ...FULL_SUITE_FLAGS };
  } catch {
    // Same as the `changes` job: an unusable classifier runs the full suite.
    return { ...FULL_SUITE_FLAGS };
  } finally { io.remove(dir); }
}

export function baseFlags(io, baseSha, headSha) {
  if (!isSha(baseSha) || !isSha(headSha)) throw new GateError('base_unreadable', 'invalid revision');
  let changed;
  // The same diff as the `changes` job, so the classifier sees the same list,
  // including git's quoting of unusual paths.
  try { changed = nonEmptyLines(io.git(['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`])); }
  catch (error) { throw new GateError('base_unreadable', String(error.message ?? error)); }
  // Policy paths from an unquoted (-z) listing of the same diff, so an unusual name still matches.
  let unquoted;
  try { unquoted = io.git(['diff', '-z', '--name-only', '--no-renames', `${baseSha}...${headSha}`]).split('\0').filter(Boolean); }
  catch (error) { throw new GateError('base_unreadable', String(error.message ?? error)); }
  return { flags: classifyAtBase(io, baseSha, changed), changed, policyPaths: unquoted.filter(isPolicyPath) };
}

function parseEnvValue(value, needs) {
  const known = job => {
    if (!needs.includes(job)) throw new GateError('aggregator_unparseable', `env reads ${job}, which is not in needs`);
    return job;
  };
  let match;
  if ((match = value.match(/^\$\{\{ needs\.([\w-]+)\.result \}\}$/))) return { kind: 'result', job: known(match[1]) };
  if ((match = value.match(/^\$\{\{ needs\.changes\.outputs\.(\w+) \}\}$/))) { known('changes'); return { kind: 'changes', key: match[1] }; }
  if ((match = value.match(/^\$\{\{ needs\.([\w-]+)\.outputs\.(\w+) \}\}$/))) {
    // The gate can only supply an output it derives itself.
    if (!DERIVED_OUTPUTS.has(`${match[1]}.${match[2]}`)) throw new GateError('aggregator_unparseable', `no derivation for ${value}`);
    return { kind: 'output', job: known(match[1]), key: match[2] };
  }
  if (value === "${{ github.event_name == 'pull_request' }}") return { kind: 'is_pr' };
  throw new GateError('aggregator_unparseable', `unsupported env value: ${value}`);
}

export function extractAggregator(ciYml) {
  const body = workflowJobs(ciYml)['ci-success']?.body;
  if (!body) throw new GateError('aggregator_unparseable', 'no ci-success job');
  const needs = body.match(/^    needs: \[([^\]\n]+)\]$/m)?.[1].split(',').map(job => job.trim());
  if (!needs) throw new GateError('aggregator_unparseable', 'no single-line needs');

  const stepLines = body.match(/^      - name: Check all jobs passed\n([\s\S]*)$/m)?.[1].split('\n');
  if (!stepLines || stepLines[0] !== '        env:') throw new GateError('aggregator_unparseable', 'no Check all jobs passed step with env');
  const runAt = stepLines.indexOf('        run: |');
  if (runAt < 0) throw new GateError('aggregator_unparseable', 'no run block');

  const env = {};
  for (const line of stepLines.slice(1, runAt)) {
    const match = line.match(/^ {10}(\w+): (.*)$/);
    if (!match) throw new GateError('aggregator_unparseable', `unsupported env line: ${line.trim()}`);
    env[match[1]] = parseEnvValue(match[2], needs);
  }

  const script = [];
  for (const line of stepLines.slice(runAt + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(10))) break;
    script.push(line.slice(10));
  }
  while (script.length && !script[0].trim() || script[0]?.startsWith('#')) script.shift();
  while (script.length && !script.at(-1).trim()) script.pop();
  const text = script.join('\n');
  // The script runs as written here, so a template would not expand as it does on a runner.
  if (!text || text.includes('${{')) throw new GateError('aggregator_unparseable', 'script is empty or uses a template expression');
  return { env, script: text, needs };
}

// ── Job identity: ids from the base aggregator, display names from the head ──
//
// A display name is not authority, so a cosmetic rename must not block. A
// removed or renamed id is `missing`. Shapes this parser does not know fail
// closed as head_unparseable rather than guessing at GitHub's naming.

let jobsCache = { text: null, jobs: null };
export function workflowJobsOf(ciYml) {
  if (jobsCache.text !== ciYml) jobsCache = { text: ciYml, jobs: workflowJobs(ciYml) };
  return jobsCache.jobs;
}

const unquote = value => value.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

function parseMatrix(id, body) {
  const lines = body.split('\n');
  const strategy = lines.indexOf('    strategy:');
  if (strategy < 0) return null;
  let at = strategy + 1;
  while (at < lines.length && lines[at] !== '      matrix:' && (!lines[at].trim() || lines[at].startsWith('      '))) at++;
  if (lines[at] !== '      matrix:') return null;
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !line.startsWith('        ')) break;
    if (line.trim() && !line.trim().startsWith('#')) block.push(line);
  }
  const fail = why => { throw new GateError('head_unparseable', `${id}: matrix ${why}`); };
  const top = block.filter(line => /^ {8}\S/.test(line));
  if (top.length === 1 && top[0] === '        include:') {
    const combos = [];
    for (const line of block.slice(1)) {
      const item = line.match(/^ {10}- ([\w-]+): (.*)$/);
      const field = line.match(/^ {12}([\w-]+): (.*)$/);
      if (item) combos.push({ [item[1]]: unquote(item[2]) });
      else if (field && combos.length) combos.at(-1)[field[1]] = unquote(field[2]);
      else if (!/^ {14}/.test(line)) fail(`include line: ${line.trim()}`); // block-scalar content
    }
    return combos.length ? combos : fail('include is empty');
  }
  const inline = top.length === 1 && top[0].match(/^ {8}([\w-]+): \[([^\]]*)\]$/);
  if (!inline || block.length !== 1) fail('shape is not one inline list or one include list');
  const values = inline[2].split(',').map(unquote).filter(Boolean);
  return values.length ? values.map(value => ({ [inline[1]]: value })) : fail('list is empty');
}

export function jobInstances(ciYml, jobId) {
  const body = workflowJobsOf(ciYml)[jobId]?.body;
  if (body === undefined) return null;
  const named = body.match(/^    name: (.*)$/m)?.[1];
  const template = named === undefined ? jobId : unquote(named);
  const refs = [...template.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)].map(match => match[1]);
  const matrix = parseMatrix(jobId, body);
  const fail = why => { throw new GateError('head_unparseable', `${jobId}: ${why}`); };
  if (!matrix) return refs.length ? fail('name uses an expression without a matrix') : { template, expected: [template] };
  if (!refs.length) fail('matrix job name has no matrix expression');
  const keys = refs.map(ref => ref.match(/^matrix\.([\w-]+)$/)?.[1] ?? fail(`unsupported name expression ${ref}`));
  const expected = matrix.map(combo => {
    if (keys.some(key => combo[key] === undefined || /^[|>]/.test(combo[key]))) fail('name references a value the matrix does not set');
    return template.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key) => combo[key]);
  });
  return { template, expected };
}

let namesCache = { text: null, owners: null };
function nameOwners(ciYml) {
  if (namesCache.text === ciYml) return namesCache.owners;
  const owners = new Map();
  for (const id of Object.keys(workflowJobsOf(ciYml))) {
    let instances;
    try { instances = jobInstances(ciYml, id); } catch { continue; } // judged when that id is rolled up
    for (const name of new Set([instances.template, ...instances.expected])) owners.set(name, [...(owners.get(name) ?? []), id]);
  }
  namesCache = { text: ciYml, owners };
  return owners;
}

const PR_ONLY = "${{ github.event_name == 'pull_request' }}";
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped']);

// Mirrors needs.<job>.result for the latest attempt's API job list.
export function rollup(jobId, apiJobs, headCiYml, { event }) {
  const instances = jobInstances(headCiYml, jobId);
  if (!instances) return 'missing';
  const continueOnError = workflowJobsOf(headCiYml)[jobId].body.match(/^    continue-on-error: (.*)$/m)?.[1];
  if (continueOnError !== undefined && continueOnError !== PR_ONLY) {
    throw new GateError('continue_on_error_unsupported', `${jobId}: ${continueOnError}`);
  }
  const names = new Set([instances.template, ...instances.expected]);
  for (const name of names) {
    const owners = nameOwners(headCiYml).get(name) ?? [];
    const listed = apiJobs.filter(job => job.name === name).length;
    if (owners.length > 1 || listed > 1) throw new GateError('duplicate_job_name', `${name}: ${owners.join(', ') || `${listed} API jobs`}`);
  }
  const conclusion = job => {
    const value = CONCLUSIONS.has(job.conclusion) ? job.conclusion : 'failure';
    return value === 'failure' && continueOnError === PR_ONLY && event === 'pull_request' ? 'success' : value;
  };
  const isMatrix = instances.expected.length !== 1 || instances.expected[0] !== instances.template;
  const literal = isMatrix ? apiJobs.find(job => job.name === instances.template) : undefined;
  const found = instances.expected.map(name => apiJobs.find(job => job.name === name)).filter(Boolean);
  if (literal) {
    // A skipped matrix job reports once under its literal name. That is never
    // evidence the shards passed, and next to real shards it is incoherent.
    return !found.length && conclusion(literal) === 'skipped' ? 'skipped' : 'failure';
  }
  if (!found.length) return 'missing';
  if (found.length < instances.expected.length) return 'failure';
  const results = new Set(found.map(conclusion));
  if (results.has('failure')) return 'failure';
  if (results.has('cancelled')) return 'cancelled';
  if (results.size === 1) return [...results][0];
  return 'failure'; // success and skipped together
}

// ── MOBILE_NATIVE_REQUIRED ───────────────────────────────────────────────
//
// Not in the jobs API. Deriving it from whether iOS ran would be circular, so
// it comes from the base's filter and the base's closure script.

const MOBILE_OUTPUT = "${{ github.event_name == 'workflow_dispatch' || steps.changes.outputs.mobile == 'true' || steps.lockfile.outputs.changed == 'true' }}";

function mobileFilters(body) {
  const lines = body.split('\n');
  const start = lines.indexOf('          filters: |');
  if (start < 0) return null;
  const filters = {};
  let key = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(12))) break;
    if (!line.trim() || /^ {14}#/.test(line)) continue;
    const heading = line.match(/^ {12}(\w+):$/);
    const glob = line.match(/^ {14}- '([\w.@-]+(?:\/[\w.@-]+)*(?:\/\*\*)?)'$/);
    if (heading) filters[key = heading[1]] = [];
    else if (glob && key) filters[key].push(glob[1]);
    else return null;
  }
  const names = Object.keys(filters).sort().join(',');
  return names === 'lockfile,mobile' && filters.mobile.length && filters.lockfile.length ? filters : null;
}

const matchesGlob = (path, glob) => glob.endsWith('/**') ? path.startsWith(glob.slice(0, -2)) : path === glob;

export function deriveMobileRequired(io, baseSha, headSha, changed) {
  try {
    const body = workflowJobs(showAt(io, baseSha, '.github/workflows/ci.yml'))['mobile-native-changes']?.body;
    const output = body?.match(/^      mobile: (.*)$/m)?.[1];
    const filters = body && mobileFilters(body);
    // An unknown output shape or filter, or a path git had to quote, is a native input.
    if (output !== MOBILE_OUTPUT || !filters || changed.some(path => path.startsWith('"'))) return 'true';
    const hit = key => changed.some(path => filters[key].some(glob => matchesGlob(path, glob)));
    if (hit('mobile')) return 'true';
    if (!hit('lockfile')) return 'false';
    const dir = io.temp();
    try {
      io.write(join(dir, 'closure.mjs'), showAt(io, baseSha, '.github/scripts/mobile-lockfile-closure.mjs'));
      io.write(join(dir, 'base.yaml'), showAt(io, baseSha, 'pnpm-lock.yaml'));
      io.write(join(dir, 'head.yaml'), showAt(io, headSha, 'pnpm-lock.yaml'));
      const stdout = io.runIsolated('node', [join(dir, 'closure.mjs'), join(dir, 'base.yaml'), join(dir, 'head.yaml')], { dir });
      return stdout.match(/^changed=(true|false)$/m)?.[1] ?? 'true';
    } finally { io.remove(dir); }
  } catch {
    return 'true';
  }
}

export function runAggregator(io, aggregator, values) {
  const mapped = ref => {
    if (ref.kind === 'result') return values.results[ref.job];
    if (ref.kind === 'changes') return values.flags[ref.key];
    if (ref.kind === 'output') return values.outputs[`${ref.job}.${ref.key}`];
    return String(values.isPr === true);
  };
  const childEnv = Object.fromEntries(Object.entries(aggregator.env).map(([name, ref]) => [name, mapped(ref) ?? '']));
  const dir = io.temp();
  try {
    // A `run:` step with no `shell:` is `bash -e {0}`.
    const stdout = io.runIsolated('bash', ['--noprofile', '--norc', '-e', '-c', aggregator.script], { childEnv, dir });
    return { passed: true, stdout };
  } catch (error) {
    if (!Number.isInteger(error.status)) throw new GateError('aggregator_exec', String(error.message ?? error));
    return { passed: false, stdout: String(error.stdout ?? '') };
  } finally { io.remove(dir); }
}

// ── Verdict ──────────────────────────────────────────────────────────────

const CI_YML = '.github/workflows/ci.yml';

export function prepare(io, { baseSha, headSha, event }) {
  const { flags, changed, policyPaths } = baseFlags(io, baseSha, headSha);
  const ciAt = (revision, code) => {
    try { return showAt(io, revision, CI_YML); } catch (error) { throw new GateError(code, String(error.message ?? error)); }
  };
  const aggregator = extractAggregator(ciAt(baseSha, 'base_unreadable'));
  const headCi = ciAt(headSha, 'head_unreadable');
  return { flags, changed, policyPaths, aggregator, headCi, event, mobile: deriveMobileRequired(io, baseSha, headSha, changed) };
}

// The base script's own answer; the blame list only explains a red one.
// ctx.thinSkip is the list the gate published for this entry (W05): the base
// script reads it as THIN_SKIP, and a base that does not read it ignores it.
export function judge(io, ctx, apiJobs) {
  let results;
  try {
    results = Object.fromEntries(ctx.aggregator.needs.map(job => [job, rollup(job, apiJobs, ctx.headCi, { event: ctx.event })]));
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    return { verdict: 'fail', reason: error.code, detail: error.message, results: {}, stdout: '' };
  }
  const thinSkip = ctx.thinSkip ?? [];
  const run = values => runAggregator(io, ctx.aggregator, { results: values, flags: { ...ctx.flags, thin_skip: thinSkipValue(thinSkip) },
    outputs: { 'mobile-native-changes.mobile': ctx.mobile }, isPr: ctx.event === 'pull_request' });
  const first = run(results);
  if (first.passed) return { verdict: 'pass', reason: 'required_jobs_passed', results, stdout: first.stdout };
  // Jobs that did not finish cleanly, then any single job whose other state
  // would satisfy the script once those are repaired.
  const blamed = new Set(ctx.aggregator.needs.filter(job => !['success', 'skipped'].includes(results[job])));
  const repaired = Object.fromEntries(Object.entries(results).map(([job, result]) => [job, blamed.has(job) ? 'success' : result]));
  if (!run(repaired).passed) {
    for (const job of ctx.aggregator.needs) {
      if (run({ ...repaired, [job]: repaired[job] === 'success' ? 'skipped' : 'success' }).passed) blamed.add(job);
    }
  }
  if (!blamed.size) return { verdict: 'fail', reason: 'required_jobs_failed', results, stdout: first.stdout };
  // Only skipped thinnable jobs the list did not cover: a selection fault (a skip
  // nothing authorized), not a test failure.
  const jobs = [...blamed];
  const unjustified = jobs.every(job => results[job] === 'skipped' && THINNABLE.includes(job) && !thinSkip.includes(job));
  return { verdict: 'fail', reason: `${unjustified ? 'thin_skip_unjustified' : 'required_jobs_failed'}:${jobs.join(',')}`, results, stdout: first.stdout };
}

export function verdict(io, { baseSha, headSha, apiJobs, event, thinSkip = [] }) {
  let ctx;
  try {
    ctx = prepare(io, { baseSha, headSha, event });
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    return { verdict: 'fail', reason: error.code, detail: error.message, flags: null, policyPaths: [], results: {}, stdout: '' };
  }
  return { ...judge(io, { ...ctx, thinSkip }, apiJobs), flags: ctx.flags, policyPaths: ctx.policyPaths, mobile: ctx.mobile };
}

// ── Replay controls ──────────────────────────────────────────────────────
//
// On a green sample, each must turn the verdict red. A control that stays
// green means the verdict cannot see that kind of breakage.

export function controlTargets(aggregator, flags) {
  const varFor = (kind, key) => Object.entries(aggregator.env).find(([, ref]) => ref.kind === kind && ref.key === key)?.[0];
  const lines = aggregator.script.split('\n');
  const codeVar = varFor('changes', 'code');
  const codeAt = codeVar ? lines.findIndex(line => line.includes(`[[ "\${${codeVar}}" != "false" ]] && {`)) : -1;
  const docsOnly = flags.code === 'false' && codeAt >= 0;
  const live = docsOnly ? lines.slice(0, codeAt) : lines;
  const resultJob = name => aggregator.env[name]?.kind === 'result' ? aggregator.env[name].job : null;
  let unconditional = null;
  for (const line of docsOnly || codeAt < 0 ? live : lines.slice(codeAt + 1)) {
    const match = line.match(/^\s*(?:if )?\[\[ "\$\{(\w+)\}" != "success" \]\] \|\| \\$/);
    if (match && resultJob(match[1])) { unconditional = resultJob(match[1]); break; }
  }
  let threeBranch = null;
  for (const line of live) {
    const match = line.match(/\{ \[\[ "\$\{(\w+)\}" == "false" \]\] && \[\[ "\$\{(\w+)\}" != "skipped" \]\]; \}/);
    const ref = match && aggregator.env[match[1]];
    if (ref?.kind === 'changes' && flags[ref.key] === 'false' && resultJob(match[2])) {
      threeBranch = { flagVar: match[1], job: resultJob(match[2]) };
      break;
    }
  }
  return { unconditional, threeBranch };
}

function setJob(apiJobs, headCi, jobId, conclusion) {
  const { template, expected } = jobInstances(headCi, jobId);
  const names = new Set([template, ...expected]);
  return conclusion === null ? apiJobs.filter(job => !names.has(job.name))
    : apiJobs.map(job => names.has(job.name) ? { ...job, conclusion } : job);
}

export function runControls(io, ctx, apiJobs) {
  const { unconditional, threeBranch } = controlTargets(ctx.aggregator, ctx.flags);
  const controls = [];
  if (unconditional) {
    controls.push({ control: 'unconditional_failure', job: unconditional, jobs: setJob(apiJobs, ctx.headCi, unconditional, 'failure') });
    controls.push({ control: 'missing', job: unconditional, jobs: setJob(apiJobs, ctx.headCi, unconditional, null) });
  }
  if (threeBranch) controls.push({ control: 'three_branch', job: threeBranch.job, jobs: setJob(apiJobs, ctx.headCi, threeBranch.job, 'success') });
  const failures = [];
  if (!unconditional) failures.push({ control: 'unconditional_failure', job: null, verdict: 'no_target' });
  for (const { control, job, jobs } of controls) {
    const out = judge(io, ctx, jobs);
    if (out.verdict !== 'fail') failures.push({ control, job, verdict: out.verdict });
  }
  return { run: controls.map(c => c.control), failures };
}

// ── The needs oracle ─────────────────────────────────────────────────────
//
// `ci-success` uploads toJSON(needs). It is candidate-written, so it is never
// authority: a difference is only reported, and never changes a verdict.

export function compareOracle(oracle, results, mobile) {
  const diffs = [];
  for (const [job, result] of Object.entries(results)) {
    const seen = oracle?.[job]?.result ?? null;
    if (seen !== result) diffs.push({ job, oracle: seen, gate: result });
  }
  const native = oracle?.['mobile-native-changes'];
  if (native?.result === 'success' && native.outputs?.mobile !== mobile) {
    diffs.push({ job: 'mobile', oracle: native.outputs?.mobile ?? null, gate: mobile });
  }
  return diffs;
}

// One JSON file from a run's artifact, or null when no unexpired artifact has that name.
function readArtifactJson(io, repository, runId, name, file) {
  const pages = ghJson(io, ['api', `repos/${repository}/actions/runs/${runId}/artifacts?name=${name}&per_page=100`, '--paginate', '--slurp']);
  if (!pages.flatMap(page => page.artifacts ?? []).some(artifact => artifact.name === name && !artifact.expired)) return null;
  const dir = io.temp();
  try {
    io.gh(['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', dir]);
    return JSON.parse(io.read(join(dir, file)));
  } finally { io.remove(dir); }
}

const readOracle = (io, repository, run) => readArtifactJson(io, repository, run.id, `ci-needs-oracle-attempt-${run.run_attempt}`, 'ci-needs-oracle.json');

// The list a past queue entry was judged with: its pinned gate run's attempt-1
// selection, which every later attempt re-publishes. The run is found the way
// W05b's consumer finds it (repository-wide, at the gate's path, under a workflow
// id the repository does not list) and the file must bind to that run and entry.
// Returns null when that cannot be known. Read only for a base whose ci-success
// reads THIN_SKIP; any other base never saw a list.
export function historicalThinSkip(io, repository, { headSha, baseSha }, workflows) {
  if (!workflows.some(workflow => workflow.path === GATE_WORKFLOW)) return null;
  const list = ghJson(io, ['api', `repos/${repository}/actions/runs?event=merge_group&head_sha=${headSha}&per_page=100`]);
  if (!Array.isArray(list?.workflow_runs)) throw new GateError('api_error', 'workflow runs: no list in the response');
  const run = list.workflow_runs.filter(candidate => candidate.path === GATE_WORKFLOW && candidate.event === 'merge_group' &&
    candidate.head_sha === headSha && Number.isSafeInteger(candidate.workflow_id) &&
    !workflows.some(workflow => workflow.id === candidate.workflow_id)).sort((a, b) => b.id - a.id)[0];
  if (!run) return null;
  const value = readArtifactJson(io, repository, run.id, selectionArtifact(1), SELECTION_FILE);
  if (value === null || selectionFailure(value, { repository, head_sha: headSha, base_sha: baseSha, gate_run: run.id, gate_attempt: 1 })) return null;
  return value.mode === 'thin' ? value.thin_skip : [];
}

const listedWorkflows = (io, repository) => listAll(io, `repos/${repository}/actions/workflows?per_page=100`, 'workflows').flatMap(page => page.workflows);

// ── Replay against real merge-queue runs ─────────────────────────────────

const QUEUE_REF = /^gh-readonly-queue\/[\w.-]+\/pr-(\d+)-([a-f\d]{40})$/;

function hasCommit(io, sha, onFailure = () => {}) {
  try { io.git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { /* not local yet */ }
  // An ejected group's head may be gone from the server.
  try { io.git(['fetch', '--no-tags', '--quiet', 'origin', sha]); io.git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch (error) { onFailure(error); return false; }
}

// The Actions API returns transient 5xx often enough that one attempt is a bug. Reads only.
function ghJson(io, args) {
  for (let attempt = 1; ; attempt++) {
    try { return JSON.parse(io.gh(args)); } catch (error) {
      if (attempt >= 3) throw new GateError('api_error', `${args[1]}: ${failureText(error)}`);
      io.sleep?.(attempt * 5_000);
    }
  }
}

export function runJobs(io, repository, runId) {
  // The default filter is the latest attempt, which is what needs.<job> sees.
  const pages = ghJson(io, ['api', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100&filter=latest`, '--paginate', '--slurp']);
  // A page with no list is an API problem. Read as zero jobs, it would blame the candidate.
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.jobs))) throw new GateError('api_error', 'jobs pagination');
  return pages.flatMap(page => page.jobs).map(({ name, conclusion, status }) => ({ name, conclusion, status }));
}

function queueSample(io, repository, run) {
  const ref = run.head_branch?.match(QUEUE_REF);
  if (!ref || !isSha(run.head_sha)) return { skip: 'excluded' };
  const [, pr, baseSha] = ref;
  if (!hasCommit(io, baseSha) || !hasCommit(io, run.head_sha)) return { skip: 'unfetchable' };
  const jobs = runJobs(io, repository, run.id);
  const recorded = jobs.find(job => job.name === 'CI Success')?.conclusion;
  if (!['success', 'failure'].includes(recorded)) return { skip: 'excluded' };
  return { pr: Number(pr), baseSha, headSha: run.head_sha, jobs, recorded };
}

export function replay(io, { repository, limit = 50, minEvaluated = 15, widenTo = 200, prepare: prep = prepare }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new GateError('invalid_repository', String(repository));
  const out = { evaluated: 0, red: 0, unfetchable: 0, excluded: 0, apiErrors: 0, oracleCompared: 0, oracleUnreadable: 0,
    thinUnknown: 0, thinUnreadable: 0, controlsRun: 0, controlKinds: {},
    considered: 0, disagreements: [], controlFailures: [], problems: [] };
  let workflows = null;
  // The list a W05 base judged this entry with. undefined: excluded, never judged with an empty list.
  // No gate selection to find is thinUnknown; one found that cannot be read, or a bug, is thinUnreadable.
  const thinSkipFor = (s, ctx) => {
    if (!readsThinSkip(ctx.aggregator)) return [];
    try {
      workflows ??= listedWorkflows(io, repository);
      const list = historicalThinSkip(io, repository, s, workflows);
      if (list) return list;
      out.thinUnknown++;
      io.stderr(`ci-gate-replay: head ${s.headSha}: no gate selection bound to this entry; excluded`);
    } catch (error) {
      if (error?.code === 'api_error') out.apiErrors++; else out.thinUnreadable++;
      io.stderr(`ci-gate-replay: head ${s.headSha}: gate selection unreadable: ${String(error.message ?? error).split('\n')[0]}`);
    }
    return undefined;
  };
  const evaluate = run => {
    let s;
    try { s = queueSample(io, repository, run); } catch (error) {
      if (error?.code !== 'api_error') throw error;
      s = { skip: 'apiErrors' };
      io.stderr(`ci-gate-replay: run ${run.id}: ${error.message}`);
    }
    if (s.skip) { out[s.skip]++; return; }
    let ctx = null, result;
    try {
      ctx = prep(io, { baseSha: s.baseSha, headSha: s.headSha, event: 'merge_group' });
      const thinSkip = thinSkipFor(s, ctx);
      if (thinSkip === undefined) return;
      ctx = { ...ctx, thinSkip };
      result = judge(io, ctx, s.jobs);
    } catch (error) {
      if (!(error instanceof GateError)) throw error;
      result = { verdict: 'fail', reason: error.code };
    }
    out.evaluated++;
    if (s.recorded === 'failure') out.red++;
    // A red sample agrees only when the verdict blames jobs; a gate error that
    // happens to be red would otherwise satisfy the "found a red" bar.
    const agrees = s.recorded === 'success' ? result.verdict === 'pass'
      : result.verdict === 'fail' && /^(?:required_jobs_failed|thin_skip_unjustified:)/.test(result.reason);
    if (!agrees) out.disagreements.push({ kind: 'verdict', run: run.id, pr: s.pr, recorded: s.recorded, verdict: result.verdict, reason: result.reason });
    let controls = '';
    if (agrees && s.recorded === 'success' && ctx) {
      const c = runControls(io, ctx, s.jobs);
      out.controlsRun += c.run.length;
      for (const control of c.run) out.controlKinds[control] = (out.controlKinds[control] ?? 0) + 1;
      out.controlFailures.push(...c.failures.map(failure => ({ run: run.id, ...failure })));
      controls = ` controls=${c.run.length} control_failures=${c.failures.length}`;
    }
    if (ctx && Object.keys(result.results ?? {}).length) {
      let oracle = null;
      try { oracle = readOracle(io, repository, run); } catch (error) {
        // The artifact was listed, so this is not "no oracle": count it.
        out.oracleUnreadable++;
        io.stderr(`ci-gate-replay: run ${run.id}: oracle unreadable: ${String(error.message ?? error).split('\n')[0]}`);
      }
      if (oracle) {
        out.oracleCompared++;
        for (const diff of compareOracle(oracle, result.results, ctx.mobile)) out.disagreements.push({ kind: 'oracle', run: run.id, pr: s.pr, ...diff });
      }
    }
    io.stdout(`ci-gate-replay-run: run=${run.id} pr=${s.pr} recorded=${s.recorded} verdict=${result.verdict} reason=${result.reason}${controls}`);
  };
  pages: for (let page = 1; out.considered < widenTo; page++) {
    const list = ghJson(io, ['api', `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&status=completed&per_page=100&page=${page}`]);
    const runs = list.workflow_runs ?? [];
    if (!runs.length) break;
    for (const run of runs) {
      if (run.event !== 'merge_group' || run.path !== CI_YML || run.conclusion === 'cancelled') continue;
      if (out.considered >= widenTo || (out.considered >= limit && out.red > 0)) break pages;
      out.considered++;
      // Past the limit, widen only to find a red sample.
      if (out.considered > limit && run.conclusion !== 'failure') continue;
      evaluate(run);
    }
  }
  if (out.evaluated < minEvaluated) out.problems.push(`evaluated ${out.evaluated} < ${minEvaluated}`);
  if (out.red === 0) out.problems.push(`no red sample in ${out.considered} runs`);
  if (out.disagreements.length) out.problems.push(`${out.disagreements.length} disagreement(s) with CI Success`);
  if (out.controlFailures.length) out.problems.push(`${out.controlFailures.length} control(s) stayed green`);
  if (!out.controlKinds.three_branch) out.problems.push('three_branch control never ran');
  if (out.oracleUnreadable) out.problems.push(`${out.oracleUnreadable} oracle artifact(s) unreadable`);
  // A W05 entry's selection is uploaded by the gate and kept 7 days; missing on many is a fault, not noise.
  if (out.thinUnreadable) out.problems.push(`${out.thinUnreadable} gate selection(s) unreadable`);
  if (out.thinUnknown * 10 > out.considered) out.problems.push(`no gate selection for ${out.thinUnknown} of ${out.considered} runs`);
  // Unfetchable heads are expected (ejected groups); API errors are not, past a few.
  if (out.apiErrors * 10 > out.considered) out.problems.push(`API errors on ${out.apiErrors} of ${out.considered} runs`);
  return { ...out, ok: out.problems.length === 0 };
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const TRIM_HEADER = 'name: CI (trimmed by ci-gate.mjs trimWorkflow; job headers, ci-success and mobile-native-changes)';

// Keeps exactly what the gate reads: each job's header (name, strategy,
// continue-on-error), the whole aggregator, and the mobile filter.
export function trimWorkflow(ciYml) {
  const out = [TRIM_HEADER, 'jobs:'];
  for (const [id, { body }] of Object.entries(workflowJobs(ciYml))) {
    out.push(`  ${id}:`);
    const lines = body.split('\n');
    if (id === 'ci-success' || id === 'mobile-native-changes') {
      while (lines.length && (!lines.at(-1).trim() || /^  #/.test(lines.at(-1)))) lines.pop();
      out.push(...lines);
    } else {
      const steps = lines.indexOf('    steps:');
      out.push(...(steps < 0 ? lines : lines.slice(0, steps)).filter(line => line.trim() && !/^\s*#/.test(line)));
    }
  }
  return `${out.join('\n')}\n`;
}

export function recordFixture(io, { repository, runId, prepare: prep = prepare }) {
  const run = ghJson(io, ['api', `repos/${repository}/actions/runs/${runId}`]);
  const s = queueSample(io, repository, run);
  if (s.skip) throw new GateError('not_recordable', `${runId}: ${s.skip}`);
  const ctx = prep(io, { baseSha: s.baseSha, headSha: s.headSha, event: 'merge_group' });
  // The list it was judged with (W05). Unknown is not recordable: [] would be a guess.
  const thinSkip = readsThinSkip(ctx.aggregator) ? historicalThinSkip(io, repository, s, listedWorkflows(io, repository)) : [];
  if (!thinSkip) throw new GateError('not_recordable', `${runId}: no readable gate selection for a base that reads THIN_SKIP`);
  const snapshots = {};
  const snap = revision => {
    const name = `ci-${io.git(['rev-parse', `${revision}:${CI_YML}`]).trim().slice(0, 12)}.yml`;
    snapshots[name] = trimWorkflow(showAt(io, revision, CI_YML));
    return name;
  };
  const fixture = { source: { run_id: run.id, pr: s.pr }, changed: ctx.changed, flags: ctx.flags, mobile: ctx.mobile, thin_skip: thinSkip,
    jobs: s.jobs.filter(job => job.name !== 'CI Success').map(({ name, conclusion }) => ({ name, conclusion })),
    ci_success: s.recorded, base_ci: snap(s.baseSha), head_ci: snap(s.headSha),
    expect: { verdict: s.recorded === 'success' ? 'pass' : 'fail' } };
  return { fixture, snapshots };
}

// ── Waiting for the candidate's CI run ───────────────────────────────────

const MINUTE = 60_000;
const POLL_MS = MINUTE;
const RUN_MISSING_MS = 15 * MINUTE;
const API_TOLERANCE_MS = 15 * MINUTE;
const DEADLINE_MS = 140 * MINUTE; // the job allows 145; the queue's check timeout is 150

function findCiRun(io, repository, headSha) {
  const list = ghJson(io, ['api', `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${headSha}&per_page=100`]);
  // A body with no list is an API problem, not "no run yet", which would blame the candidate.
  if (!Array.isArray(list?.workflow_runs)) throw new GateError('api_error', 'workflow runs: no list in the response');
  const matching = list.workflow_runs.filter(run => run.path === CI_YML && run.event === 'merge_group' && run.head_sha === headSha);
  return matching.sort((a, b) => b.id - a.id)[0] ?? null;
}

// The stop signal is timing only. Whatever CI Success says, the verdict comes from the results.
export function waitForCi(io, { repository, headSha, headRef, deadlineMs = DEADLINE_MS }) {
  const start = io.now();
  let failingSince = null;
  for (;;) {
    const now = io.now();
    if (now - start >= deadlineMs) return { reason: 'deadline' };
    try {
      const run = findCiRun(io, repository, headSha);
      if (run?.status === 'completed' && run.conclusion === 'cancelled') return { reason: 'ci_cancelled', run };
      const jobs = run ? runJobs(io, repository, run.id) : [];
      failingSince = null;
      if (!run && now - start >= RUN_MISSING_MS) return { reason: 'ci_run_missing', detail: `no CI run for ${headRef}` };
      if (run?.status === 'completed' || jobs.some(job => job.name === 'CI Success' && job.status === 'completed')) return { run, jobs };
    } catch (error) {
      if (error?.code !== 'api_error') throw error;
      failingSince ??= now;
      if (io.now() - failingSince >= API_TOLERANCE_MS) return { reason: 'api_error', detail: error.message };
    }
    io.sleep(POLL_MS);
  }
}

// ── Logging text the candidate can influence ─────────────────────────────
//
// The runner reads stdout and stderr for workflow commands. Paths, oracle values
// and parser details all come from the candidate, so they are written as one
// JSON-escaped line: they cannot start a line or carry a `##[` command.

const logValue = value => JSON.stringify(value).replaceAll('##[', '#\\u0023[');
const commandData = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const logSha = value => isSha(value) ? value : 'none';

function gateLine({ verdict: outcome, reason, event, base, head, ciRun = 'none', attempt = 'none', policyPaths = [], flags = null, oracle = 'none', thin = 'none' }) {
  return `ci-gate: verdict=${outcome} reason=${reason} event=${/^\w+$/.test(event ?? '') ? event : 'none'} base=${logSha(base)} head=${logSha(head)} ` +
    `ci_run=${ciRun} attempt=${attempt} policy_paths=${logValue(policyPaths)} flags=${logValue(flags)} oracle=${oracle} thin=${thin}`;
}

// What E2 records. Verbatim, and never compared to anything: the shape of the
// ref under a ruleset is not checked, and a wrong guess would reject every run.
function logIdentity(io, env) {
  io.stdout(`ci-gate-identity: workflow_ref=${env.GITHUB_WORKFLOW_REF ?? ''} workflow_sha=${logSha(env.GITHUB_WORKFLOW_SHA)} ` +
    `gate_run=${env.GITHUB_RUN_ID ?? 'none'} gate_attempt=${env.GITHUB_RUN_ATTEMPT ?? 'none'}`);
}

// ── Trusted PR evidence for W05, in shadow (W02d) ────────────────────────
//
// What thin selection will need from a PR, read only from sources the candidate
// cannot write: anchors from pinned gate runs, and CI job results from the
// Actions API judged by the base revision. Nothing here reaches a verdict.

export const GATE_WORKFLOW = '.github/workflows/ci-gate.yml';
const ANCHOR_ARTIFACT = /^ci-gate-anchor-attempt-([1-9]\d*)$/;
// A PR event starts its CI and gate runs within moments of each other.
const SAME_EVENT_SKEW_MS = 10 * MINUTE;

// The trust decision, in one place. Returns why a run is not the pinned gate, or
// null when it is.
//
// `workflow_id` is what the candidate cannot choose. A run started by the org
// ruleset carries an id GitHub does not list for this repository (seen at E2). A
// copy of the file a PR enabled for itself should be an ordinary run under a listed
// id; negative leg N1 proves that, and until then it is inferred. If it is wrong,
// this is shadow data and W05 must not rely on it. The identity line is
// corroboration, not proof: once the id shows main's gate wrote the log, the line
// says which ref the ruleset ran. A candidate copy could print anything, so it is
// never enough without the id.
export function pinnedRunFailure(run, { repository, head, attempt, workflows, identity, workflowOnMain }) {
  if (run.path !== GATE_WORKFLOW) return `path ${run.path}`;
  if (run.event !== 'pull_request') return `event ${run.event}`;
  if (run.head_sha !== head) return `head ${run.head_sha}`;
  if (!Number.isSafeInteger(run.workflow_id)) return 'no workflow_id';
  // With no listed entry to tell it from, an unlisted id proves nothing.
  if (!workflows.some(workflow => workflow.path === GATE_WORKFLOW)) return `no listed workflow at ${GATE_WORKFLOW}`;
  if (workflows.some(workflow => workflow.id === run.workflow_id)) return `workflow_id ${run.workflow_id} is listed for this repository`;
  if (!identity) return 'no identity line';
  if (identity.workflow_ref !== `${repository}/${GATE_WORKFLOW}@refs/heads/main`) return `workflow_ref ${identity.workflow_ref}`;
  if (identity.gate_run !== run.id) return `gate_run ${identity.gate_run}`;
  if (identity.gate_attempt !== attempt) return `gate_attempt ${identity.gate_attempt}`;
  if (!workflowOnMain) return `workflow_sha ${identity.workflow_sha} is not on main`;
  return null;
}

// The line logIdentity writes, as the job log endpoint returns it: one timestamp, then the line.
export function parseIdentity(log) {
  const lines = [...log.matchAll(/^\S+ ci-gate-identity: workflow_ref=(\S+) workflow_sha=([a-f\d]{40}) gate_run=(\d+) gate_attempt=(\d+)$/gm)];
  if (lines.length !== 1) return null;
  const [, workflow_ref, workflow_sha, gateRun, gateAttempt] = lines[0];
  return { workflow_ref, workflow_sha, gate_run: Number(gateRun), gate_attempt: Number(gateAttempt) };
}

function listAll(io, endpoint, key) {
  const pages = ghJson(io, ['api', endpoint, '--paginate', '--slurp']);
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page?.[key]))) throw new GateError('api_error', `${endpoint}: no ${key} list`);
  return pages;
}

// gh 2.103 refuses to print a log's colour codes without this flag, and an older
// gh does not know it. The text is only ever parsed, never echoed.
function jobLog(io, repository, jobId) {
  const endpoint = `repos/${repository}/actions/jobs/${jobId}/logs`;
  try { return io.gh(['api', '--allow-escape-sequences', endpoint]); } catch { /* an older gh, or the real failure below */ }
  try { return io.gh(['api', endpoint]); } catch (error) { throw new GateError('api_error', `${endpoint}: ${failureText(error)}`); }
}

function runIdentity(io, repository, run, attempt) {
  const pages = listAll(io, `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`, 'jobs');
  const job = pages.flatMap(page => page.jobs).find(({ name }) => name === 'CI Gate');
  return job ? parseIdentity(jobLog(io, repository, job.id)) : null;
}

function isOnMain(io, sha) {
  try { io.git(['merge-base', '--is-ancestor', sha, 'origin/main']); return true; } catch (error) {
    // Exit 1 is the answer "no". Anything else says nothing about the run.
    if (error?.status === 1) return false;
    throw new GateError('selection_ancestry', `ancestry check for ${sha} failed: ${failureText(error)}`);
  }
}

// Unlike classifyAtBase, a classifier that fails here is not read as "everything
// changed": judging the PR's run under flags it never ran with would blame the PR.
function prFlagsAtBase(io, baseSha, files) {
  const dir = io.temp();
  try {
    const flags = parseFlags(runBaseClassifier(io, dir, baseSha, `${files.join('\n')}\n`, ['--pull-request']));
    return 'code' in flags ? { flags } : { why: 'classifier printed no flags' };
  } catch (error) { return { why: `classifier failed: ${failureText(error)}` }; }
  finally { io.remove(dir); }
}

function anchorFailure(value, { head, pr, run, attempt }) {
  if (value === null || typeof value !== 'object') return 'not an object';
  if (value.schema !== 1) return 'schema';
  if (value.head_sha !== head) return 'head_sha';
  if (value.pr_number !== pr) return 'pr_number';
  if (value.run_id !== run.id) return 'run_id';
  if (value.run_attempt !== attempt) return 'run_attempt';
  if (!isSha(value.base_sha)) return 'base_sha';
  if (!isSha(value.merge_sha)) return 'merge_sha';
  if (value.files_source !== 'merge-commit') return 'files_source';
  if (!Array.isArray(value.files) || !value.files.every(file => typeof file === 'string')) return 'files';
  if (typeof value.policy_in_files !== 'boolean') return 'policy_in_files';
  if (!value.policy_in_files && typeof value.policy_digest !== 'string') return 'policy_digest';
  return null;
}

function readAnchor(io, repository, run, name) {
  const dir = io.temp();
  try {
    io.gh(['run', 'download', String(run.id), '--repo', repository, '--name', name, '--dir', dir]);
    return JSON.parse(io.read(join(dir, ANCHOR_FILE)));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally { io.remove(dir); }
}

// Pinned anchors for this head, oldest first. No anchor means run everything.
// Losing the oldest (expired, rejected) raises the base, so verifiedPrRun refuses
// a base newer than the run it verifies.
function pinnedAnchors(io, repository, { head, pr, runs, stats }) {
  const workflows = listAll(io, `repos/${repository}/actions/workflows?per_page=100`, 'workflows').flatMap(page => page.workflows);
  const anchors = [];
  for (const run of runs.filter(({ path }) => path === GATE_WORKFLOW)) {
    const artifacts = listAll(io, `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts').flatMap(page => page.artifacts);
    for (const artifact of artifacts) {
      const attempt = Number(artifact.name?.match(ANCHOR_ARTIFACT)?.[1]);
      if (!attempt || artifact.expired) continue;
      const identity = runIdentity(io, repository, run, attempt);
      const why = pinnedRunFailure(run, { repository, head, attempt, workflows, identity, workflowOnMain: !!identity && hasCommit(io, identity.workflow_sha) && isOnMain(io, identity.workflow_sha) });
      if (why) { stats.not_pinned.push({ run: run.id, attempt, why }); continue; }
      const value = readAnchor(io, repository, run, artifact.name);
      const bad = value === null ? 'not json' : anchorFailure(value, { head, pr, run, attempt });
      if (bad) { stats.rejected.push({ run: run.id, attempt, why: bad }); continue; }
      anchors.push({ ...value, run_created_at: run.created_at });
    }
  }
  return anchors.sort((a, b) => a.run_id - b.run_id || a.run_attempt - b.run_attempt);
}

// The newest pull_request CI run for this head, judged the way the PR event was:
// the base's script, IS_PR=true, the base's classifier with --pull-request.
// Returns { ci, flags } when it counts, or { why } when it does not.
function verifiedPrRun(io, repository, { head, pr, runs, oldest, newest, files }) {
  const ci = runs.filter(run => run.path === CI_YML && run.event === 'pull_request' && run.head_sha === head &&
    (!run.pull_requests?.length || run.pull_requests.some(({ number }) => number === pr))).sort((a, b) => b.id - a.id)[0];
  if (!ci) return { why: 'no pull_request CI run for this head' };
  if (ci.status !== 'completed') return { why: `CI run ${ci.id} is ${ci.status}` };
  // "The oldest base errs old" only holds if some anchor is as old as what this run
  // tested. Written so that a time that will not parse fails too.
  if (!(Date.parse(oldest.run_created_at) <= Date.parse(ci.created_at) + SAME_EVENT_SKEW_MS)) return { why: `oldest anchor is newer than CI run ${ci.id}, or a time is unreadable` };
  for (const sha of new Set([oldest.base_sha, oldest.merge_sha, newest.merge_sha])) {
    const cause = fetchFailure(io, sha);
    if (cause) return { why: `cannot fetch ${sha}: ${cause}` };
  }
  let aggregator, headCi;
  try {
    aggregator = extractAggregator(showAt(io, oldest.base_sha, CI_YML));
    // A pull_request run uses the merge commit's workflow, so that names its jobs.
    headCi = showAt(io, newest.merge_sha, CI_YML);
  } catch (error) { return { why: failureText(error) }; }
  const { flags, why } = prFlagsAtBase(io, oldest.base_sha, files);
  if (why) return { why };
  const out = judge(io, { flags, aggregator, headCi, event: 'pull_request',
    mobile: deriveMobileRequired(io, oldest.base_sha, oldest.merge_sha, files) }, runJobs(io, repository, ci.id));
  return out.verdict === 'pass' ? { ci, flags } : { why: `CI run ${ci.id}: ${out.reason}` };
}

// A record in W4's schema, or { reason } when the evidence does not hold. Never
// reads a candidate artifact: provenance.json has no way in.
export function trustedRecord(io, { head, pr }, stats = {}) {
  const repository = io.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new GateError('invalid_repository', String(repository));
  if (!isSha(head) || !Number.isSafeInteger(pr) || pr <= 0) throw new GateError('invalid_repository', 'invalid head or PR');
  Object.assign(stats, { not_pinned: [], rejected: [] });
  const pages = listAll(io, `repos/${repository}/actions/runs?event=pull_request&head_sha=${head}&per_page=100`, 'workflow_runs');
  // The API lists at most 1,000; a shorter list could be missing the newest run.
  if (pages.some(page => page.total_count > 1000)) throw new GateError('api_error', 'workflow run search truncated');
  const runs = pages.flatMap(page => page.workflow_runs).filter(run => run.head_sha === head);

  const anchors = pinnedAnchors(io, repository, { head, pr, runs, stats });
  stats.anchors = anchors.length;
  if (!anchors.length) return { reason: stats.not_pinned.length ? 'anchor_not_pinned' : 'no_anchor' };
  if (anchors.some(({ policy_in_files }) => policy_in_files)) return { reason: 'anchor_policy_in_p' };

  // More than one anchor comes from a close and reopen, or a re-run of the gate.
  // The oldest base and every file over-approximate Δ and P.
  const oldest = anchors[0], newest = anchors.at(-1);
  const files = [...new Set(anchors.flatMap(anchor => anchor.files))];
  const verified = verifiedPrRun(io, repository, { head, pr, runs, oldest, newest, files });
  if (verified.why) { stats.verification = verified.why; return { reason: 'no_verified_pr_run' }; }
  stats.ci_run = verified.ci.id;
  return { schema: 1, head_sha: head, merge_sha: oldest.merge_sha, base_sha: oldest.base_sha, pr_number: pr,
    run_id: verified.ci.id, run_attempt: verified.ci.run_attempt, created_at: oldest.created_at, files, files_source: 'merge-commit',
    policy_digest: oldest.policy_digest, policy_in_files: false,
    selection: Object.fromEntries(CLASSIFIER_KEYS.map(key => [key, verified.flags[key]])),
    non_gating_jobs: nonGatingJobs(showAt(io, oldest.base_sha, CI_YML)), suites_passed: true };
}

// shadowCore reads policy through this, so everything it reads is the entry's
// base revision, whatever is checked out. So policyAtBase is true by construction
// and its check does no work here; the digest comparison still does. Only the
// base's classifier can be executed, with no token.
export function baseRevisionIO(io, baseSha) {
  return { ...io,
    read: path => showAt(io, baseSha, path),
    exists: path => io.git(['ls-tree', baseSha, '--', path]).trim() !== '',
    blob: path => io.git(['rev-parse', `${baseSha}:${path}`]).trim(),
    exec(command, args, input) {
      if (command !== 'bash' || args[0] !== CLASSIFIER) throw new GateError('base_io_refused', `base-revision io refuses to run ${command} ${args[0] ?? ''}`);
      const dir = io.temp();
      try { return runBaseClassifier(io, dir, baseSha, input, args.slice(1)); } finally { io.remove(dir); }
    },
    // A ref, because `contents: read` covers it. This workflow's token has no
    // `pull-requests` scope, and whether the pulls API works without one is not checked.
    prHead(pr) {
      if (!Number.isSafeInteger(pr) || pr <= 0) throw new GateError('invalid_repository', 'invalid PR');
      return io.git(['ls-remote', 'origin', `refs/pull/${pr}/head`]).match(/^([a-f\d]{40})\t/)?.[1] ?? '';
    },
    recordSource(head, pr) {
      const stats = {};
      const out = trustedRecord(io, { head, pr }, stats);
      return out.reason ? { records: [], stats, reason: out.reason } : { records: [out], stats };
    },
  };
}

export function queueSelection(io, env, flags) {
  return shadowCore(baseRevisionIO(io, env.BASE_SHA), { event: env.GITHUB_EVENT_NAME, headRef: env.HEAD_REF, headSha: env.HEAD_SHA, baseSha: env.BASE_SHA, full: flags });
}

// ── select: publish the entry's queue selection (W05, #10749) ────────────
//
// Runs before CI fans out; the next step uploads the file and `verify` judges
// against it. Always exits 0 and leaves exactly one ci-gate-selection line and a
// file: anything that goes wrong is mode=full, which skips nothing. Its children
// and sleeps get three minutes, so it cannot eat the wait verify needs.

const SELECTION_MS = 3 * MINUTE;

// The gate's own checks, which the decision in ci-gate-thin.mjs is given.
const flagsAt = (io, baseSha, headSha) => {
  try { return baseFlags(io, baseSha, headSha).flags; } catch (error) { if (error instanceof GateError) return null; throw error; }
};
// Unreadable or unparseable at the base: no W05 block there. Anything else is a bug, so reason=error.
const aggregatorAt = (io, baseSha) => {
  let text;
  try { text = showAt(io, baseSha, CI_YML); } catch { return null; }
  try { return extractAggregator(text); } catch (error) { if (error instanceof GateError) return null; throw error; }
};
const SELECT_STEPS = { pinFailure, fetchFailure, flagsAt, queueSelection, aggregatorAt, readArtifact: readArtifactJson };

const selectionLine = ({ published: p, shadow, wouldReason, wouldThinSkip }) => `ci-gate-selection: mode=${p.mode} reason=${p.reason} ` +
  `thin_queue=${logValue(p.thin_queue)} thin_skip=${logValue(p.thin_skip)} source_attempt=${logValue(p.source_attempt)} ` +
  `would_reason=${logValue(wouldReason)} would_thin_skip=${logValue(wouldThinSkip)} ` +
  `${SHADOW_FIELDS.map(key => `${key}=${logValue(shadow[key] ?? null)}`).join(' ')}`;

const quietly = write => { try { write(); } catch { /* the selection is already decided */ } };

export function select(io, env, deps = {}) {
  let out;
  try {
    io.remove(SELECTION_FILE); // A re-run must never upload a previous attempt's file.
    io.limitTime?.(io.now() + SELECTION_MS);
    out = choose(io, env, { ...SELECT_STEPS, ...deps });
  } catch (error) {
    out = fullSelection(env, 'error', { shadow: { error: failureText(error) } });
  } finally { quietly(() => io.limitTime?.(Infinity)); }
  const errored = error => fullSelection(env, 'error', { shadow: { error: failureText(error) } });
  let text, body;
  try {
    text = selectionLine(out);
    body = `${JSON.stringify(out.published, null, 2)}\n`;
  } catch (error) {
    out = errored(error);
    text = selectionLine(out);
    body = `${JSON.stringify(out.published, null, 2)}\n`;
  }
  if (out.detail) quietly(() => io.stderr(`ci-gate-detail: ${logValue(out.detail)}`));
  try { io.write(SELECTION_FILE, body); } catch (error) {
    // No file means verify and CI both run everything; the line must not claim otherwise.
    quietly(() => io.stderr(`ci-gate-detail: selection not written: ${logValue(failureText(error))}`));
    text = selectionLine(errored(Error(`selection not written: ${failureText(error)}`)));
  }
  quietly(() => io.stdout(text));
  return 0;
}

// The list `verify` judges with: the one `select` published in this job, when it
// is this entry's, this run's and this attempt's, and says thin. Anything else
// judges the entry as full, as before W05.
function publishedThinSkip(io, env) {
  let value, why;
  try { value = JSON.parse(io.read(SELECTION_FILE)); } catch (error) { why = `${SELECTION_FILE}: ${failureText(error)}`; }
  why ??= selectionFailure(value, bindingOf(env));
  if (why) {
    io.stderr(`ci-gate-detail: selection unusable: ${logValue(why)}`);
    return [];
  }
  return value.mode === 'thin' ? value.thin_skip : [];
}

// ── verify: the verdict for one queue entry ──────────────────────────────

// The checkout is of workflow_sha, so candidate commits are not guaranteed local.
// Returns why the commit cannot be had, or null once it is here.
function fetchFailure(io, sha) {
  let cause = 'not found';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (hasCommit(io, sha, error => { cause = failureText(error); })) return null;
    if (attempt < 3) io.sleep(attempt * 5_000);
  }
  return cause;
}

// Returns why the gate is not pinned, or null when it is.
function pinFailure(io, workflowSha) {
  if (!isSha(workflowSha)) return 'GITHUB_WORKFLOW_SHA is not a sha';
  // The checkout normally wrote this ref; fetching it here means the answer does
  // not depend on that. A failed fetch leaves what is local, and no ref is not pinned.
  let fetchNote = '';
  try { io.git(['fetch', '--no-tags', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']); }
  catch (error) { fetchNote = ` (fetching main failed: ${failureText(error)})`; }
  try { io.git(['merge-base', '--is-ancestor', workflowSha, 'origin/main']); return null; } catch (error) {
    // Exit 1 is the answer "no". Anything else means the check could not run.
    const why = error?.status === 1 ? 'not an ancestor of origin/main' : `ancestry check failed: ${failureText(error)}`;
    return `${workflowSha}: ${why}${fetchNote}`;
  }
}

// Advisory: the artifact is candidate-written, so no outcome here can change a verdict.
function checkOracle(io, repository, run, out) {
  if (!Object.keys(out.results ?? {}).length) return 'none';
  try {
    const oracle = readOracle(io, repository, run);
    if (!oracle) return 'absent';
    const diffs = compareOracle(oracle, out.results, out.mobile);
    for (const diff of diffs) io.stderr(`::warning title=ci-gate oracle disagreement::${commandData(logValue(diff))}`);
    return diffs.length ? `disagree:${diffs.length}` : 'agree';
  } catch (error) {
    io.stderr(`::warning title=ci-gate oracle unreadable::${commandData(logValue(failureText(error)))}`);
    return 'unreadable';
  }
}

function reportPolicyPaths(io, env, policyPaths) {
  if (!policyPaths.length) return;
  const listed = policyPaths.map(logValue);
  io.stdout(`::notice title=ci-gate policy paths::This entry touches ${listed.length} policy path(s): ${commandData(listed.join(', '))}`);
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    io.append(env.GITHUB_STEP_SUMMARY, `### CI Gate: this entry touches policy paths\n\n${listed.map(path => `- ${path}`).join('\n')}\n`);
  } catch (error) { io.stderr(`ci-gate-detail: step summary not written: ${logValue(failureText(error))}`); }
}

function judgeEntry(io, env, { waitForCi: wait, verdict: decide }, line) {
  const started = io.now();
  if (env.GITHUB_EVENT_NAME !== 'merge_group') return { reason: 'wrong_event' };
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) return { reason: 'invalid_repository' };
  const thinSkip = publishedThinSkip(io, env);
  line.thin = thinSkip.length;
  const unpinned = pinFailure(io, env.GITHUB_WORKFLOW_SHA);
  if (unpinned) return { reason: 'not_pinned', detail: unpinned };
  if (!isSha(env.BASE_SHA) || !isSha(env.HEAD_SHA)) return { reason: 'base_unreadable', detail: 'invalid revision' };
  for (const [name, sha] of [['base', env.BASE_SHA], ['head', env.HEAD_SHA]]) {
    const cause = fetchFailure(io, sha);
    if (cause) return { reason: 'base_unreadable', detail: `cannot fetch ${name} ${sha}: ${cause}` };
  }

  // The deadline covers the whole script, so a slow fetch cannot push it past the job timeout.
  const waited = wait(io, { repository, headSha: env.HEAD_SHA, headRef: env.HEAD_REF, deadlineMs: DEADLINE_MS - (io.now() - started) });
  if (waited.run) Object.assign(line, { ciRun: waited.run.id, attempt: waited.run.run_attempt });
  if (waited.reason) return waited;

  const out = decide(io, { baseSha: env.BASE_SHA, headSha: env.HEAD_SHA, apiJobs: waited.jobs, event: 'merge_group', thinSkip });
  Object.assign(line, { policyPaths: out.policyPaths ?? [], flags: out.flags ?? null, oracle: checkOracle(io, repository, waited.run, out) });
  if (Object.keys(out.results ?? {}).length) io.stdout(`ci-gate-results: ${logValue(out.results)}`);
  if (out.verdict !== 'pass') for (const text of nonEmptyLines(out.stdout ?? '')) io.stdout(`ci-gate-script: ${text}`);
  return out;
}

// Exit 0 only on verdict=pass. Everything else, a thrown exception included, is
// a fail with exactly one ci-gate line. The token reaches git and gh only.
export function verify(io, env, deps = {}) {
  const line = { verdict: 'fail', reason: 'error', event: env.GITHUB_EVENT_NAME, base: env.BASE_SHA, head: env.HEAD_SHA, thin: 0 };
  try {
    logIdentity(io, env);
    const out = judgeEntry(io, env, { waitForCi, verdict, ...deps }, line);
    line.reason = out.reason;
    line.verdict = out.verdict === 'pass' ? 'pass' : 'fail';
    if (out.detail) io.stderr(`ci-gate-detail: ${logValue(out.detail)}`);
    reportPolicyPaths(io, env, line.policyPaths ?? []);
  } catch (error) {
    line.verdict = 'fail';
    line.reason = error instanceof GateError ? error.code : 'error';
    io.stderr(`ci-gate-detail: ${logValue(failureText(error))}`);
  }
  io.stdout(gateLine(line));
  return line.verdict === 'pass' ? 0 : 1;
}

// ── anchor: what a pull_request event tested, for W05 ────────────────────
//
// Always passes. On a PR the gate only records; `CI Success` still judges the PR
// and the queue still judges the entry. No anchor is safe, because W05 treats
// that as "run everything".

export const ANCHOR_FILE = 'ci-gate-anchor.json';

function writeAnchor(io, env) {
  const merge = env.GITHUB_SHA;
  const head = env.PR_HEAD_SHA;
  const isCount = value => /^[1-9]\d*$/.test(value ?? '');
  const invalid = [
    ...(env.GITHUB_EVENT_NAME === 'pull_request' ? [] : ['GITHUB_EVENT_NAME']),
    ...[['GITHUB_SHA', merge], ['PR_HEAD_SHA', head]].filter(([, value]) => !isSha(value)).map(([name]) => name),
    ...['PR_NUMBER', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].filter(name => !isCount(env[name])),
  ];
  if (invalid.length) return { reason: 'anchor_invalid_input', detail: `invalid: ${invalid.join(', ')}` };
  const cause = fetchFailure(io, merge);
  if (cause) return { reason: 'base_unreadable', detail: `cannot fetch ${merge}: ${cause}` };
  // rev-parse --verify --quiet exits 1 with no output when there is no such parent.
  const parent = number => { try { return io.git(['rev-parse', '--verify', '--quiet', `${merge}^${number}`]).trim(); } catch { return null; } };
  const base = parent(1);
  if (!isSha(base)) return { reason: 'base_unreadable', detail: `${merge} has no first parent` };
  const second = parent(2);
  if (second !== head) return { reason: 'merge_head_mismatch', base, detail: `M^2=${second ?? 'none'} expected ${head}` };
  // `files` is W4's quoted listing, what a classifier reads. Policy paths come from
  // an unquoted (-z) listing of the same diff, so an unusual name still matches.
  const files = nonEmptyLines(io.git(['diff', '--name-only', '--no-renames', base, merge]));
  const policyPaths = io.git(['diff', '-z', '--name-only', '--no-renames', base, merge]).split('\0').filter(Boolean).filter(isPolicyPath);
  const policyInFiles = policyPaths.length > 0;
  io.write(ANCHOR_FILE, `${JSON.stringify({ schema: 1, head_sha: head, merge_sha: merge, base_sha: base, pr_number: Number(env.PR_NUMBER), run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT), created_at: new Date(io.now()).toISOString(), files, files_source: 'merge-commit',
    policy_digest: policyInFiles ? null : policyDigest(io, base), policy_in_files: policyInFiles }, null, 2)}\n`);
  return { reason: 'anchor_written', base, policyPaths };
}

export function anchor(io, env) {
  const line = { verdict: 'pass', reason: 'anchor_error', event: env.GITHUB_EVENT_NAME, head: env.PR_HEAD_SHA };
  try {
    logIdentity(io, env);
    io.remove(ANCHOR_FILE); // A re-run must never upload a previous attempt's file.
    Object.assign(line, writeAnchor(io, env));
  } catch (error) { line.detail = failureText(error); }
  if (line.reason !== 'anchor_written') io.stderr(`ci-gate-detail: no anchor written: ${line.reason} ${logValue(line.detail ?? '')}`);
  io.stdout(gateLine(line));
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────

export function runCLI(io, args, env) {
  const repository = env.GITHUB_REPOSITORY;
  if (args[0] === 'select') return select(io, env);
  if (args[0] === 'verify') return verify(io, env);
  if (args[0] === 'anchor') return anchor(io, env);
  if (args[0] === 'replay') {
    const out = replay(io, { repository });
    io.stdout(`ci-gate-replay: evaluated=${out.evaluated} red=${out.red} disagreements=${out.disagreements.length} ` +
      `controlFailures=${out.controlFailures.length} oracleCompared=${out.oracleCompared} unfetchable=${out.unfetchable} ` +
      `excluded=${out.excluded} apiErrors=${out.apiErrors} oracleUnreadable=${out.oracleUnreadable} considered=${out.considered} ` +
      `thinUnknown=${out.thinUnknown} thinUnreadable=${out.thinUnreadable} controlsRun=${out.controlsRun} controlKinds=${JSON.stringify(out.controlKinds)}`);
    for (const d of out.disagreements) io.stderr(`::error title=ci-gate replay disagreement::${JSON.stringify(d)}`);
    for (const c of out.controlFailures) io.stderr(`::error title=ci-gate replay control stayed green::${JSON.stringify(c)}`);
    for (const p of out.problems) io.stderr(`ci-gate-replay: FAIL ${p}`);
    return out.ok ? 0 : 1;
  }
  if (args[0] === 'record-fixture') {
    const [, runId, dir, name] = args;
    if (!/^\d+$/.test(runId ?? '') || !dir || !/^[\w-]+$/.test(name ?? '')) throw new GateError('usage', 'record-fixture <run-id> <dir> <name>');
    const { fixture, snapshots } = recordFixture(io, { repository, runId });
    for (const [file, text] of Object.entries(snapshots)) io.write(join(dir, file), text);
    io.write(join(dir, `${name}.json`), `${JSON.stringify({ name, ...fixture }, null, 2)}\n`);
    return 0;
  }
  throw new GateError('usage', 'ci-gate.mjs verify | anchor | select | replay | record-fixture <run-id> <dir> <name>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try { process.exitCode = runCLI(createGateIO(), args, process.env); }
  catch (error) {
    process.stderr.write(`ci-gate: ${String(error.message ?? error)}\n`);
    // select never fails its step: a failed step would skip verify, and the gate with it.
    // With no file written, verify and CI both run everything.
    if (args[0] === 'select') process.stdout.write('ci-gate-selection: mode=full reason=error\n');
    process.exitCode = args[0] === 'select' ? 0 : 1;
  }
}
