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
