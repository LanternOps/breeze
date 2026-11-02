import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// W4: advisory only. These selections must never replace the classifier outputs.
export const POLICY_FILES = [
  '.github/scripts/classify-pr-paths.sh', '.github/scripts/integration-floor-paths.txt',
  '.github/scripts/path-reader-map.txt', '.github/scripts/qemu-gate-paths.txt',
  '.github/scripts/queue-selection.mjs', '.github/flaky-tests.json', '.github/workflows/ci.yml',
];
export const MAX_BASE_AGE_HOURS = 12;
export const MAX_DELTA_MERGES = 40;
const CLASSIFIER_KEYS = ['code', 'docs', 'agent', 'app', 'api', 'web', 'portal', 'addins', 'm365', 'rust',
  'topology_browser', 'agent_code', 'integration', 'path_readers', 'reader_tests'];
const AREAS = ['api', 'web', 'portal', 'addins', 'm365', 'rust', 'agent_code'];
const PATH_AREAS = { viewer: 'apps/viewer/', mobile: 'apps/mobile/', shared: 'packages/shared/', document_ui: 'packages/document-ui/' };
const unit = {
  'test-api': 'api', 'test-web': 'web', 'test-portal': 'portal',
  'test-mobile': 'mobile', 'test-viewer': 'viewer', 'test-shared': 'shared', 'test-document-ui': 'document_ui',
  'test-office-addin-core': 'addins', 'test-excel-addin': 'addins', 'test-word-addin': 'addins',
  'test-powerpoint-addin': 'addins', 'test-outlook-addin': 'addins',
  'test-m365-graph-read-executor': 'm365', 'test-m365-graph-actions-executor': 'm365',
  'test-m365-communications-executor': 'm365', 'test-agent': 'agent_code', 'test-agent-windows': 'agent_code',
};
export const JOB_CLASSES = {
  always: ['lint', 'typecheck', 'security-audit', 'release-ledger'],
  build: { 'build-api': 'api', 'build-web': 'web', 'build-portal': 'portal', 'build-agent': 'agent_code',
    'build-m365-graph-read-executor': 'm365', 'build-m365-graph-actions-executor': 'm365',
    'build-m365-communications-executor': 'm365', 'rust-check': 'rust' },
  unit,
  integration: ['integration-test'], readers: ['path-read-contracts'],
  never_thinned: ['test-agent-race', 'rust-check-windows', 'portal-dev-e2e', 'build-smoke-images',
    'smoke-test', 'guided-setup-smoke', 'workspace-runtime'],
  self_gated: ['docs-check', 'mobile-native-changes', 'recovery-media-e2e', 'topology-browser-gate',
    'auth-browser-transition-browser-contract', 'check-migrations', 'check-migrations-nonsuperuser',
    'agent-windows-manifest-guard', 'lint-agent', 'windows-runtime-smoke'],
};
const truth = value => value === true || value === 'true';
const unique = values => [...new Set(values)];
export function workflowJobs(workflow) {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  return Object.fromEntries([...jobs.matchAll(/^  ([a-z][\w-]*):\n([\s\S]*?)(?=^  [a-z][\w-]*:|$(?![\s\S]))/gm)]
    .map(([, name, body]) => [name, { body, condition: body.match(/^    if: (.*)$/m)?.[1] }]));
}
export function nonGatingJobs(workflow) {
  const jobs = workflowJobs(workflow);
  const gate = jobs['ci-success'].body;
  const needs = gate.match(/^    needs: \[([^\]]+)\]/m)[1].split(',').map(s => s.trim());
  const resultVars = Object.fromEntries([...gate.matchAll(/(\w+_RESULT): \$\{\{ needs\.([\w-]+)\.result \}\}/g)].map(m => [m[1], m[2]]));
  const exemptions = [...gate.matchAll(/^.*if \[\[ "\$\{IS_PR\}" != "true".*$/gm)]
    .flatMap(m => [...m[0].matchAll(/\$\{(\w+_RESULT)\}/g)].map(v => resultVars[v[1]]));
  // Only jobs with classifier conditions are suites; omit the aggregate and post-run jobs.
  return Object.entries(jobs).filter(([name, j]) => j.condition?.includes('needs.changes.outputs.') &&
    (!needs.includes(name) || exemptions.includes(name))).map(([name]) => name).sort();
}

// Recursive descent, never eval: the grammar deliberately has no arbitrary JS/shell.
export function parseIfExpression(expression) {
  const tokens = expression.match(/needs\.changes\.outputs\.\w+\s*==\s*'true'|&&|\|\||[()]|\S+/g) ?? [];
  let pos = 0;
  const atom = () => {
    const token = tokens[pos++];
    if (token === '(') { const value = or(); if (tokens[pos++] !== ')') throw Error('Missing )'); return value; }
    const key = token?.match(/^needs\.changes\.outputs\.(\w+)\s*==\s*'true'$/)?.[1];
    if (!key) throw Error(`Unsupported condition: ${expression}`);
    return { key };
  };
  const and = () => { let value = atom(); while (tokens[pos] === '&&') { pos++; value = { op: 'and', left: value, right: atom() }; } return value; };
  const or = () => { let value = and(); while (tokens[pos] === '||') { pos++; value = { op: 'or', left: value, right: and() }; } return value; };
  const tree = or();
  if (pos !== tokens.length) throw Error(`Trailing condition: ${expression}`);
  return tree;
}
export function evaluateIf(tree, flags) {
  if (typeof tree === 'string') tree = parseIfExpression(tree);
  if (tree.key) return truth(flags[tree.key]);
  return tree.op === 'and' ? evaluateIf(tree.left, flags) && evaluateIf(tree.right, flags)
    : evaluateIf(tree.left, flags) || evaluateIf(tree.right, flags);
}
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const ownTest = path => /(?:\.test\.(?:ts|tsx|mts|mjs|js)|\.spec\.(?:ts|tsx)|_test\.go)$/.test(path);
// Read only run commands, never comments, env values, or step names.
function runCommands(body) {
  return [...body.matchAll(/^        run: (.*)(?:\n((?:          .*\n|\n)*))?/gm)]
    .map(([, inline, block]) => inline === '|' || inline === '>' ? block ?? '' : inline).join('\n');
}
export function configRoutes({ workflow, playwrightConfigs = {} }) {
  return Object.entries(workflowJobs(workflow)).flatMap(([job, { body }]) =>
    [...runCommands(body).matchAll(/playwright\s+test[^\n]*?--config=([^\s]+)/g)].map(([, config]) => {
      if (!/^[\w.-]+$/.test(config)) throw Error('Unsupported Playwright config path');
      const source = playwrightConfigs[config];
      if (typeof source !== 'string') throw Error(`Missing config: ${config}`);
      const dir = source.match(/\btestDir:\s*(['"])([^'"]+)\1\s*[,}]/)?.[2];
      if (!dir || dir.includes('..') || dir.startsWith('/') || (source.match(/\btestDir:/g) ?? []).length !== 1) throw Error('Unsupported testDir');
      const matches = source.match(/\btestMatch:\s*\/((?:\\.|[^/\n])+)\/([imsu]*)\s*[,}]/);
      if ((source.match(/\btestMatch:/g) ?? []).length > (matches ? 1 : 0)) throw Error('Unsupported testMatch');
      return { job, config, prefix: `e2e-tests/${dir.replace(/^\.\//, '').replace(/\/$/, '')}/`,
        match: matches ? new RegExp(matches[1], matches[2]) : /\.(?:spec|test)\.[cm]?[jt]sx?$/ };
    }));
}
export function routeOwnTest(path, context) {
  const { workflow, integrationConfig } = context;
  if (path.startsWith('e2e-tests/')) {
    let routes;
    try { routes = configRoutes(context); } catch { return { jobs: [] }; }
    const relative = path.slice('e2e-tests/'.length);
    const jobs = Object.entries(workflowJobs(workflow)).filter(([, job]) =>
      runCommands(job.body).split(/\s+/).includes(relative)).map(([name]) => name);
    for (const route of routes) if (path.startsWith(route.prefix) && route.match.test(path)) jobs.push(route.job);
    return { jobs: unique(jobs), unrun: !jobs.length };
  }
  if (path.startsWith('apps/api/')) {
    const includes = integrationConfig.match(/\binclude:\s*\[([\s\S]*?)\]/)?.[1];
    if (!includes) throw Error('Cannot parse integration includes');
    const globs = [...includes.replace(/\/\/[^\n]*/g, '').matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
    return { jobs: [globs.some(g => globRegex(g).test(path.slice(9))) ? 'integration-test' : 'test-api'] };
  }
  if (path.startsWith('agent/')) return { jobs: ['test-agent', 'test-agent-windows'] };
  const prefixJobs = {
    'apps/web/': 'test-web', 'apps/portal/': 'test-portal', 'apps/viewer/': 'test-viewer',
    'apps/mobile/': 'test-mobile', 'packages/shared/': 'test-shared', 'packages/document-ui/': 'test-document-ui',
    'packages/extension-sdk/': 'test-api', 'ee/workspace/': 'test-api',
    'packages/office-addin-core/': 'test-office-addin-core',
    ...Object.fromEntries(['excel', 'word', 'powerpoint', 'outlook'].map(p => [`apps/${p}-addin/`, `test-${p}-addin`])),
    ...Object.fromEntries(['graph-read', 'graph-actions', 'communications'].map(p => [`apps/m365-${p}-executor/`, `test-m365-${p}-executor`])),
  };
  return { jobs: Object.entries(prefixJobs).filter(([prefix]) => path.startsWith(prefix)).map(([, job]) => job) };
}
function areas(paths, flags) {
  return new Set([...AREAS.filter(key => truth(flags[key])), ...Object.entries(PATH_AREAS)
    .filter(([, prefix]) => paths.some(p => p.startsWith(prefix))).map(([key]) => key)]);
}
export function computeSelection({ P, delta, full, workflow, classify, floor, integrationConfig, playwrightConfigs }) {
  const jobs = workflowJobs(workflow);
  const full_jobs = Object.entries(jobs).filter(([, j]) => j.condition?.includes('needs.changes.outputs.') && evaluateIf(j.condition, full)).map(([n]) => n);
  if (!P.length) return { mode: 'full', reason: 'empty_change_set', full_jobs, thin_jobs: full_jobs,
    overlap: [], unrun_own_tests: [], would_skip: [], would_add: [] };
  const union = unique([...P, ...delta]);
  const classifyPaths = (paths, pr = false) => paths.length ? classify(paths, pr) : {};
  const combined = classifyPaths(union), pFlags = classifyPaths(P), dFlags = classifyPaths(delta);
  const overlap = P.filter(p => delta.includes(p));
  const pAreas = areas(P, pFlags), dAreas = areas(delta, dFlags), allAreas = areas(union, combined);
  const unitAreas = new Set([...pAreas].filter(a => dAreas.has(a)).concat([...areas(overlap, overlap.length ? classify(overlap) : {})]));
  const ownJobs = new Set(), unrun_own_tests = [];
  for (const path of P.filter(ownTest)) {
    const routed = routeOwnTest(path, { workflow, integrationConfig, playwrightConfigs });
    if (routed.unrun) unrun_own_tests.push(path);
    else if (!routed.jobs.length) return { mode: 'full', reason: 'unrouted_own_test', full_jobs, thin_jobs: full_jobs, overlap, unrun_own_tests };
    routed.jobs.forEach(job => ownJobs.add(job));
  }
  const floorHit = floor.split('\n').map(l => l.split('#')[0].trim()).filter(Boolean)
    .some(rule => union.some(p => rule.endsWith('/') ? p.startsWith(rule) : p === rule));
  const integration = ownJobs.has('integration-test') || floorHit ||
    (unitAreas.has('api') && truth(classifyPaths(P, true).integration) && truth(classifyPaths(delta, true).integration));
  const never = nonGatingJobs(workflow);
  const thin_jobs = Object.entries(jobs).filter(([name, j]) => {
    if (!j.condition?.includes('needs.changes.outputs.')) return false;
    if (never.includes(name)) return full_jobs.includes(name);
    let flags = combined;
    if (name in JOB_CLASSES.build) {
      const area = JOB_CLASSES.build[name]; flags = { ...combined, [area]: allAreas.has(area) };
    } else if (name in unit) {
      const area = unit[name], selected = unitAreas.has(area) || ownJobs.has(name);
      flags = { ...combined, ...(AREAS.includes(area) ? { [area]: selected } : { code: selected, app: selected }) };
    } else if (JOB_CLASSES.integration.includes(name)) flags = { ...combined, integration };
    else if (JOB_CLASSES.readers.includes(name)) flags = dFlags;
    else if (![...JOB_CLASSES.always, ...JOB_CLASSES.self_gated].includes(name)) return full_jobs.includes(name);
    return evaluateIf(j.condition, flags);
  }).map(([name]) => name);
  return { mode: 'shadow', reason: '', overlap, thin_jobs, full_jobs, unrun_own_tests,
    flags: { ...combined, integration: String(integration), path_readers: dFlags.path_readers, reader_tests: dFlags.reader_tests },
    reader_tests: dFlags.reader_tests ?? '', would_skip: full_jobs.filter(j => !thin_jobs.includes(j)),
    would_add: thin_jobs.filter(j => !full_jobs.includes(j)) };
}

const policyPath = path => POLICY_FILES.includes(path) || /^\.github\/(?:workflows|scripts|actions)\//.test(path);
export function fallbackReason(f) {
  if (f.error) return 'error';
  if (f.event !== 'merge_group') return 'not_merge_group';
  if (!f.pr) return 'no_pr_number';
  if (!f.head) return 'no_head_sha';
  if (!f.record) return 'no_valid_record';
  if (!f.record.files.length || f.entryFiles?.length === 0) return 'empty_change_set';
  // Prefer the actionable path reason over the deliberately null digest.
  if (f.record.files.some(policyPath)) return 'policy_path_in_p';
  if (f.ageHours > MAX_BASE_AGE_HOURS) return 'stale_base';
  if (f.merges > MAX_DELTA_MERGES) return 'too_many_merges';
  if (f.ancestor === false || f.diffOk === false) return 'delta_uncomputable';
  if (f.delta?.some(policyPath)) return 'policy_path_in_delta';
  if (f.entryCommits !== undefined && f.entryCommits !== 1) return 'entry_not_single_commit';
  // The entry must not change anything the green PR run did not see.
  if (f.entryFiles?.some(path => !f.record.files.includes(path))) return 'entry_outside_p';
  if (f.atBase === false) return 'policy_not_at_base';
  if (f.digest !== undefined && (!f.record.policy_digest || f.record.policy_digest !== f.digest)) return 'policy_digest_mismatch';
  if (f.unrouted) return 'unrouted_own_test';
  return '';
}
const sha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
const lines = text => text.trim().split('\n').filter(Boolean);
function fullJobs(workflow, flags) {
  return Object.entries(workflowJobs(workflow)).filter(([, j]) => j.condition?.includes('needs.changes.outputs.') &&
    evaluateIf(j.condition, flags)).map(([name]) => name);
}
function treeAt(io, revision, files = POLICY_FILES) {
  if (!sha(revision)) throw Error('Invalid revision');
  return io.git(['ls-tree', revision, '--', ...[...files].sort()]);
}
function policyAtBase(io, tree) {
  const blobs = Object.fromEntries(lines(tree).map(line => {
    const match = line.match(/^\d+ blob ([a-f\d]{40})\t(.+)$/);
    if (!match) throw Error('Unsupported policy tree entry');
    return [match[2], match[1]];
  }));
  return POLICY_FILES.every(path => io.exists(path) ? io.git(['hash-object', '--', path]).trim() === blobs[path] : !blobs[path]);
}
function selectionContext(io, workflow) {
  const configs = unique([...workflow.matchAll(/--config=([\w.-]+)/g)].map(m => m[1]));
  return { workflow, floor: io.read('.github/scripts/integration-floor-paths.txt'),
    integrationConfig: io.read('apps/api/vitest.integration.config.ts'),
    playwrightConfigs: Object.fromEntries(configs.map(name => [name, io.read(`e2e-tests/${name}`)])),
    classify: (paths, pr = false) => Object.fromEntries(lines(io.exec('bash',
      ['.github/scripts/classify-pr-paths.sh', ...(pr ? ['--pull-request'] : [])], paths.join('\n') + '\n'))
      .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })) };
}
export function shadowCore(io, input) {
  const out = { mode: 'full', reason: '', pr: null, head: '', B: '', parent: input.baseSha ?? '', age_h: null,
    merges: null, p: [], delta: [], overlap: [], thin_jobs: [], full_jobs: [], would_skip: [], would_add: [],
    invalid_records: 0, unrun_own_tests: [] };
  const stop = reason => ({ ...out, reason, thin_jobs: out.full_jobs });
  try {
    if (input.error) throw input.error;
    const workflow = io.read('.github/workflows/ci.yml');
    out.full_jobs = fullJobs(workflow, input.full);
    if (input.event !== 'merge_group') return stop('not_merge_group');
    out.pr = Number(input.headRef?.match(/(?:^|\/)pr-(\d+)-[a-f\d]+$/i)?.[1]) || null;
    if (!out.pr) return stop('no_pr_number');
    if (!sha(input.headSha) || !sha(input.baseSha)) return stop('no_head_sha');
    // Queue entries are single-parent squash commits, so H is not in the queue
    // history; it comes from the PR. Pushing to a queued PR ejects it, and the
    // entry diff is checked against the record's P below (entry_outside_p).
    out.head = String(io.prHead(out.pr)).trim();
    if (!sha(out.head)) return stop('no_head_sha');
    const { records, stats } = io.records(out.head, out.pr);
    out.record_stats = stats;
    out.invalid_records = records.filter(r => !validateRecord(r, out.head)).length;
    const record = pickRecord(records, out.head);
    if (!record) return stop('no_valid_record');
    out.B = record.base_sha; out.p = record.files;
    const facts = { event: input.event, pr: out.pr, head: out.head, record };
    let reason = fallbackReason(facts);
    if (reason) return stop(reason);
    const timestamp = Number(io.git(['show', '-s', '--format=%ct', out.B]).trim());
    out.age_h = (io.now() / 1000 - timestamp) / 3600;
    if (!Number.isFinite(out.age_h) || timestamp <= 0 || out.age_h < 0) throw Error('Invalid base time');
    facts.ageHours = out.age_h;
    if ((reason = fallbackReason(facts))) return stop(reason);
    try { io.git(['merge-base', '--is-ancestor', out.B, input.baseSha]); }
    catch (err) { if (err.status === 1) return stop('delta_uncomputable'); throw err; }
    out.merges = Number(io.git(['rev-list', '--count', '--first-parent', `${out.B}..${input.baseSha}`]).trim());
    facts.merges = out.merges;
    if (!Number.isSafeInteger(out.merges) || out.merges < 0) throw Error('Invalid merge count');
    if ((reason = fallbackReason(facts))) return stop(reason);
    try { out.delta = lines(io.git(['diff', '--name-only', '--no-renames', out.B, input.baseSha])); }
    catch (error) { return { ...stop('delta_uncomputable'), error: String(error.message ?? error) }; }
    facts.delta = out.delta;
    facts.entryCommits = Number(io.git(['rev-list', '--count', '--first-parent', `${input.baseSha}..${input.headSha}`]).trim());
    facts.entryFiles = lines(io.git(['diff', '--name-only', '--no-renames', input.baseSha, input.headSha]));
    if ((reason = fallbackReason(facts))) return stop(reason);
    const tree = treeAt(io, input.baseSha);
    facts.atBase = policyAtBase(io, tree);
    facts.digest = digestTree(tree);
    out.policy_digest = facts.digest;
    if ((reason = fallbackReason(facts))) return stop(reason);
    return { ...out, policy_digest: facts.digest, ...computeSelection({ ...selectionContext(io, workflow),
      P: record.files, delta: out.delta, full: input.full }) };
  } catch (error) { return { ...stop('error'), error: String(error.message ?? error) }; }
}

const digestTree = tree => createHash('sha256').update(tree).digest('hex');
export function policyDigest(io, revision, files = POLICY_FILES) {
  return digestTree(treeAt(io, revision, files));
}
export function validateRecord(value, head) {
  try {
    const r = typeof value === 'string' ? JSON.parse(value) : value;
    return r && r.schema === 1 && r.head_sha === head && r.files_source === 'merge-commit' &&
      r.suites_passed === true && sha(r.base_sha) && Array.isArray(r.files) && r.files.every(f => typeof f === 'string') ? r : null;
  } catch { return null; }
}
export function pickRecord(records, head) {
  return records.map(r => validateRecord(r, head)).filter(Boolean).sort((a, b) =>
    (Number(b.run_id) || 0) - (Number(a.run_id) || 0) || (Number(b.run_attempt) || 0) - (Number(a.run_attempt) || 0))[0] ?? null;
}
export function record(io, input) {
  const output = input.output ?? 'provenance.json';
  io.remove(output); // A re-run must never upload a previous attempt's file.
  if (input.event !== 'pull_request' || input.ciSuccess !== 'success') {
    throw Error(`provenance: event=${JSON.stringify(input.event)} ciSuccess=${JSON.stringify(input.ciSuccess)}; expected pull_request/success`);
  }
  if (!sha(input.mergeSha) || !sha(input.headSha)) throw Error('Invalid merge/head SHA');
  const base = io.git(['rev-parse', `${input.mergeSha}^1`]).trim();
  const head = io.git(['rev-parse', `${input.mergeSha}^2`]).trim();
  if (head !== input.headSha) throw Error(`provenance: head mismatch: merge_sha=${input.mergeSha} M^2=${head} head_sha=${input.headSha}`);
  if (!sha(base)) throw Error('Invalid merge base');
  const files = lines(io.git(['diff', '--name-only', '--no-renames', base, input.mergeSha]));
  const policy_in_files = files.some(policyPath);
  const value = { schema: 1, head_sha: input.headSha, merge_sha: input.mergeSha, base_sha: base,
    pr_number: Number(input.pr), run_id: Number(input.runId), run_attempt: Number(input.runAttempt),
    created_at: new Date(io.now()).toISOString(), files, files_source: 'merge-commit',
    policy_digest: policy_in_files ? null : policyDigest(io, base), policy_in_files,
    selection: Object.fromEntries(CLASSIFIER_KEYS.map(key => [key, input.selection[key]])), non_gating_jobs: nonGatingJobs(io.read('.github/workflows/ci.yml')), suites_passed: true };
  io.write(output, JSON.stringify(value, null, 2) + '\n');
  return value;
}

// Every external operation is replaceable. Tests never need gh or the network.
export function createIO({ cwd = process.cwd(), env = process.env } = {}) {
  const io = {
    exec: (command, args, input, childEnv = {}) => execFileSync(command, args, { cwd, env: { ...env, ...childEnv }, input, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }),
    read: path => readFileSync(resolve(cwd, path), 'utf8'),
    exists: path => existsSync(resolve(cwd, path)),
    write: (path, text) => writeFileSync(resolve(cwd, path), text),
    append: (path, text) => appendFileSync(resolve(cwd, path), text),
    remove: path => rmSync(resolve(cwd, path), { recursive: true, force: true }),
    temp: () => mkdtempSync(join(tmpdir(), 'queue-provenance-')),
    now: () => Date.now(), stdout: text => process.stdout.write(text + '\n'), stderr: text => process.stderr.write(text + '\n'),
  };
  io.git = args => {
    // Sparse/partial checkout can lazily fetch blobs. Authenticate only this
    // subprocess; never restore credentials in .git/config or expose them in argv.
    const childEnv = { GIT_TERMINAL_PROMPT: '0' };
    if (env.GH_TOKEN) {
      const n = Number(env.GIT_CONFIG_COUNT || 0);
      childEnv.GIT_CONFIG_COUNT = String(n + 1);
      childEnv[`GIT_CONFIG_KEY_${n}`] = `http.${env.GITHUB_SERVER_URL || 'https://github.com'}/.extraheader`;
      childEnv[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}`;
    }
    return io.exec('git', args, undefined, childEnv);
  };
  io.gh = args => io.exec('gh', args);
  io.records = (head, pr) => readRecords(io, { repository: env.GITHUB_REPOSITORY, head, pr });
  io.prHead = pr => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !Number.isSafeInteger(pr) || pr <= 0) throw Error('Invalid repository/PR');
    return io.gh(['api', `repos/${env.GITHUB_REPOSITORY}/pulls/${pr}`, '--jq', '.head.sha']);
  };
  return io;
}

export function readRecords(io, { repository, head, pr }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !sha(head)) throw Error('Invalid repository/head');
  const pages = endpoint => {
    const result = JSON.parse(io.gh(['api', endpoint, '--paginate', '--slurp']));
    if (!Array.isArray(result)) throw Error('Invalid API pagination');
    return result;
  };
  const runs = pages(`repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`);
  if (runs.some(page => page.total_count > 1000)) throw Error('Workflow run search truncated');
  const records = [], stats = { runs: 0, artifacts: 0, expired: 0, rejected: [] };
  // Counts cover matching PR workflow runs and named provenance artifacts.
  for (const run of runs.flatMap(page => page.workflow_runs)) {
    if (run.event !== 'pull_request' || run.head_sha !== head || run.path !== '.github/workflows/ci.yml') continue;
    if (!Number.isSafeInteger(run.id) || run.id <= 0) throw Error('Invalid run id');
    stats.runs++;
    const artifacts = pages(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`).flatMap(page => page.artifacts);
    for (const artifact of artifacts) {
      const attempt = artifact.name.match(/^ci-provenance-attempt-([1-9]\d*)$/)?.[1];
      if (!attempt) continue;
      stats.artifacts++;
      if (artifact.expired) { stats.expired++; continue; }
      const dir = io.temp();
      try {
        io.gh(['run', 'download', String(run.id), '--repo', repository, '--name', artifact.name, '--dir', dir]);
        const path = join(dir, 'provenance.json');
        let r, why;
        if (!io.exists(path)) why = 'missing_provenance';
        else {
          const text = io.read(path);
          try { r = JSON.parse(text); } catch { why = 'invalid_json'; }
        }
        if (!why && !validateRecord(r, head)) why = 'invalid_record';
        if (!why && r.run_id !== run.id) why = 'run_id_mismatch';
        if (!why && r.run_attempt !== Number(attempt)) why = 'attempt_mismatch';
        if (!why && pr && r.pr_number !== pr) why = 'pr_number_mismatch';
        records.push(why ? null : r);
        if (why) stats.rejected.push({ run_id: run.id, attempt: Number(attempt), why });
      } finally { io.remove(dir); }
    }
  }
  return { records, stats };
}
export function shadow(io, input, { output, summary } = {}) {
  const out = shadowCore(io, input);
  const fields = ['pr', 'head', 'B', 'parent', 'age_h', 'merges', 'p', 'delta', 'overlap', 'thin_jobs', 'full_jobs',
    'would_skip', 'would_add', 'invalid_records', 'unrun_own_tests', 'policy_digest', 'reader_tests', 'error', 'record_stats'];
  const log = `queue-selection: mode=${out.mode} reason=${out.reason} ` +
    fields.map(key => `${key}=${JSON.stringify(out[key] ?? null)}`).join(' ');
  io.stdout(log);
  if (out.error) io.stderr(`queue-selection error: ${JSON.stringify(out.error)}`);
  if (out.reason === 'error' || out.reason === 'no_valid_record') {
    const detail = String(out.error ?? JSON.stringify(out.record_stats ?? null));
    const escaped = detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    io.stderr(`::warning title=queue-selection shadow::${out.reason}: ${escaped}`);
  }
  if (output) io.append(output, `selection_mode=${out.mode}\nselection_reason=${out.reason}\n`);
  if (summary) io.append(summary, `### Queue selection (shadow only)\n\n\`\`\`text\n${log}\n\`\`\`\n`);
  return out;
}
export function runCLI(io, args, env) {
  if (args[0] === 'record') return record(io, { event: env.EVENT_NAME, ciSuccess: env.CI_SUCCESS_RESULT,
    headSha: env.HEAD_SHA, mergeSha: env.MERGE_SHA, pr: env.PR_NUMBER, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, selection: JSON.parse(env.FULL_SELECTION) });
  if (args[0] !== 'shadow') throw Error('Usage: queue-selection.mjs record|shadow');
  const input = { event: env.EVENT_NAME, headRef: env.HEAD_REF, headSha: env.HEAD_SHA, baseSha: env.BASE_SHA, full: {} };
  try {
    input.full = JSON.parse(env.FULL_SELECTION);
  } catch (error) { input.error = Error(`FULL_SELECTION parse failed: ${error.message ?? error}`); }
  try {
    // Preserve changes' shallow PR checkout and its classify step exactly.
    // Materialize candidate files, then prove each policy blob equals the base.
    if (!input.error) io.git(['sparse-checkout', 'add', '.github/workflows', '.github/flaky-tests.json',
      'apps/api/vitest.integration.config.ts', 'e2e-tests/playwright.*.config.ts']);
  } catch (error) { input.error = Error(`sparse-checkout add failed: ${error.message ?? error}`); }
  return shadow(io, input, { output: env.GITHUB_OUTPUT, summary: env.GITHUB_STEP_SUMMARY });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runCLI(createIO(), process.argv.slice(2), process.env); }
  catch (error) { process.stderr.write(`queue-selection: ${String(error.message)}\n`); process.exitCode = 1; }
}
