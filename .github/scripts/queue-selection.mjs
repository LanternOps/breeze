// W4: advisory only. These selections must never replace the classifier outputs.
export const POLICY_FILES = [
  '.github/scripts/classify-pr-paths.sh', '.github/scripts/integration-floor-paths.txt',
  '.github/scripts/path-reader-map.txt', '.github/scripts/qemu-gate-paths.txt',
  '.github/scripts/queue-selection.mjs', '.github/flaky-tests.json', '.github/workflows/ci.yml',
];
export const MAX_BASE_AGE_HOURS = 12;
export const MAX_DELTA_MERGES = 40;
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
export function routeOwnTest(path, { workflow, integrationConfig }) {
  if (path.startsWith('e2e-tests/')) {
    const relative = path.slice('e2e-tests/'.length);
    const jobs = Object.entries(workflowJobs(workflow)).filter(([, job]) =>
      job.body.split('\n').some(line => !line.trim().startsWith('#') && line.includes(relative))).map(([name]) => name);
    return { jobs, unrun: !jobs.length };
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
export function computeSelection({ P, delta, full, workflow, classify, floor, integrationConfig }) {
  const jobs = workflowJobs(workflow);
  const full_jobs = Object.entries(jobs).filter(([, j]) => j.condition?.includes('needs.changes.outputs.') && evaluateIf(j.condition, full)).map(([n]) => n);
  const union = unique([...P, ...delta]);
  const combined = classify(union), pFlags = classify(P), dFlags = classify(delta);
  const overlap = P.filter(p => delta.includes(p));
  const pAreas = areas(P, pFlags), dAreas = areas(delta, dFlags), allAreas = areas(union, combined);
  const unitAreas = new Set([...pAreas].filter(a => dAreas.has(a)).concat([...areas(overlap, overlap.length ? classify(overlap) : {})]));
  const ownJobs = new Set(), unrun_own_tests = [];
  for (const path of P.filter(ownTest)) {
    const routed = routeOwnTest(path, { workflow, integrationConfig });
    if (routed.unrun) unrun_own_tests.push(path);
    else if (!routed.jobs.length) return { mode: 'full', reason: 'unrouted_own_test', full_jobs, thin_jobs: full_jobs, overlap, unrun_own_tests };
    routed.jobs.forEach(job => ownJobs.add(job));
  }
  const floorHit = floor.split('\n').map(l => l.split('#')[0].trim()).filter(Boolean)
    .some(rule => union.some(p => rule.endsWith('/') ? p.startsWith(rule) : p === rule));
  const integration = ownJobs.has('integration-test') || floorHit ||
    (unitAreas.has('api') && truth(classify(P, true).integration) && truth(classify(delta, true).integration));
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
