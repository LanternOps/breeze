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

import { isPolicyPath } from './ci-policy.mjs';
import { createIO, workflowJobs } from './queue-selection.mjs';

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

const isSha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
const nonEmptyLines = text => text.split('\n').filter(Boolean);

export function createGateIO(options = {}) {
  const io = createIO(options);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // git and gh reach the network here (lazy blobs, paginated jobs), so they get
  // more than createIO's 30 s. io.git and io.gh both go through io.exec.
  io.exec = (command, args, input, childEnv = {}) => execFileSync(command, args, {
    cwd, env: { ...env, ...childEnv }, input, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  // Real path: on macOS tmpdir() is a symlink, and a script's own main-module
  // check compares argv[1] with its resolved URL.
  io.temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ci-gate-')));
  // Base-revision code runs with exactly this environment. The token never reaches it.
  io.runIsolated = (command, args, { input, childEnv = {}, dir } = {}) => execFileSync(command, args, {
    cwd: dir ?? cwd, env: { PATH: env.PATH, ...childEnv }, input, encoding: 'utf8',
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return io;
}

const showAt = (io, revision, path) => io.git(['show', `${revision}:${path}`]);

function classifyAtBase(io, baseSha, changed) {
  const dir = io.temp();
  try {
    io.write(join(dir, 'classify-pr-paths.sh'), showAt(io, baseSha, CLASSIFIER));
    for (const name of CLASSIFIER_SIDECARS) {
      // An absent sidecar is the classifier's own fail-closed case.
      try { io.write(join(dir, name), showAt(io, baseSha, `.github/scripts/${name}`)); } catch { /* absent at this base */ }
    }
    const stdout = io.runIsolated('bash', [join(dir, 'classify-pr-paths.sh')], { input: `${changed.join('\n')}\n`, dir });
    const flags = Object.fromEntries(nonEmptyLines(stdout).map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
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
  const policyPaths = changed.filter(path => isPolicyPath(path.replace(/^"/, '')));
  return { flags: classifyAtBase(io, baseSha, changed), changed, policyPaths };
}

function parseEnvValue(value, needs) {
  const known = job => {
    if (!needs.includes(job)) throw new GateError('aggregator_unparseable', `env reads ${job}, which is not in needs`);
    return job;
  };
  let match;
  if ((match = value.match(/^\$\{\{ needs\.([\w-]+)\.result \}\}$/))) return { kind: 'result', job: known(match[1]) };
  if ((match = value.match(/^\$\{\{ needs\.changes\.outputs\.(\w+) \}\}$/))) { known('changes'); return { kind: 'changes', key: match[1] }; }
  if ((match = value.match(/^\$\{\{ needs\.([\w-]+)\.outputs\.(\w+) \}\}$/))) return { kind: 'output', job: known(match[1]), key: match[2] };
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
