// W07b1 (#10751): the named integration suite map and its import evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CORE, FLOOR_PATH, SUITE_MAP_PATH, SuiteMapError, directApiImports, globRegex, loadFloor, loadSuiteMap, neutralPath,
  sourceOwners, suiteOfTest, suitesForChange,
} from './integration-suites.mjs';
import { integrationTestFiles } from './shard-partition.mjs';
import { POLICY_FILES } from './ci-policy.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const read = path => readFileSync(join(REPO_ROOT, path), 'utf8');

const FIXTURE = `
# a comment
suite core tests apps/api/src/__tests__/integration/aiStatic.integration.test.ts
suite ai tests apps/api/src/__tests__/integration/ai[!a-z0-9]*
suite ai sources apps/api/src/services/ai*
suite ticket tests apps/api/src/__tests__/integration/ticket[!a-z0-9]*
suite ticket tests apps/api/src/services/tickets/*.integration.test.ts
suite ticket sources apps/api/src/services/ticket*
suite ticket sources apps/api/src/services/aiTicketBridge.ts
`;

test('globs: `*` crosses `/`, `?` is one character, classes and negated classes', () => {
  assert.ok(globRegex('apps/api/src/services/ai*').test('apps/api/src/services/ai/deep/x.ts'));
  assert.ok(globRegex('a?c').test('abc') && globRegex('a?c').test('a/c'), 'bash `?` matches any one character');
  assert.ok(!globRegex('a?c').test('ac'));
  const boundary = globRegex('x/ai[!a-z0-9]*');
  assert.ok(boundary.test('x/aiTools.test.ts') && boundary.test('x/ai-budget.test.ts'));
  assert.ok(!boundary.test('x/airgap.test.ts') && !boundary.test('x/ai2.test.ts'));
  assert.ok(globRegex('x/[a-c]').test('x/b'));
  assert.throws(() => globRegex('x/[abc'), SuiteMapError);
  assert.throws(() => globRegex('x/[a\\]'), SuiteMapError);
});

test('malformed map throws, naming the line', () => {
  for (const [text, why] of [
    ['suite ai test apps/x', /expected "suite <name> tests\|sources <glob>"/],
    ['suite Ai tests apps/x', /invalid suite name "Ai"/],
    ['suite all tests apps/x', /invalid suite name "all"/],
    ['suite ai tests apps/x extra', /expected/],
    ['suite core sources apps/api/src/x.ts', /core always runs, so it owns no sources/],
    ['suite ai sources apps/x\nsuite ai sources apps/x', /:2: duplicate rule "ai sources apps\/x"/],
    ['suite ai tests apps/x\nsuite ticket tests apps/x', /:2: tests glob apps\/x is already owned by ai/],
    ['suite ai tests apps/[x', /unclosed \[/],
  ]) {
    assert.throws(() => loadSuiteMap(text), e => e instanceof SuiteMapError && why.test(e.message), text);
  }
});

test('a test belongs to the first suite whose tests glob matches, else core', () => {
  const map = loadSuiteMap(FIXTURE);
  assert.deepEqual(map.suites, [CORE, 'ai', 'ticket']);
  assert.equal(suiteOfTest(map, 'apps/api/src/__tests__/integration/aiTools.integration.test.ts'), 'ai');
  assert.equal(suiteOfTest(map, 'apps/api/src/__tests__/integration/aiStatic.integration.test.ts'), CORE, 'an earlier core rule wins');
  assert.equal(suiteOfTest(map, 'apps/api/src/__tests__/integration/airgap.integration.test.ts'), CORE);
  assert.equal(suiteOfTest(map, 'apps/api/src/services/tickets/close.integration.test.ts'), 'ticket');
  assert.deepEqual(sourceOwners(map, 'apps/api/src/services/aiTicketBridge.ts'), ['ai', 'ticket']);
});

const FLOOR = ['apps/api/migrations/', 'apps/api/src/db/', 'packages/', 'apps/api/vitest.integration.config.ts'];

test('a floor path selects every suite', () => {
  const map = loadSuiteMap(FIXTURE);
  assert.deepEqual(suitesForChange(map, ['apps/api/src/services/aiTools.ts', 'apps/api/migrations/2026-x.sql'], { floor: FLOOR }),
    { suites: 'all', reason: 'floor:apps/api/migrations/2026-x.sql' });
  assert.equal(suitesForChange(map, ['packages/shared/src/x.ts'], { floor: FLOOR }).suites, 'all');
});

test('an unmapped API source selects every suite', () => {
  const map = loadSuiteMap(FIXTURE);
  assert.deepEqual(suitesForChange(map, ['apps/api/src/services/aiTools.ts', 'apps/api/src/services/billing.ts'], { floor: FLOOR }),
    { suites: 'all', reason: 'unmapped:apps/api/src/services/billing.ts' });
  // Not only apps/api: anything the suite could read fails open too.
  for (const path of ['scripts/ci/x.sh', 'apps/web/package.json', 'e2e-tests/x.spec.ts', 'docker-compose.yml']) {
    assert.equal(suitesForChange(map, [path], { floor: FLOOR }).suites, 'all', path);
  }
});

test('mapped changes select their owners plus core; unreachable paths add nothing', () => {
  const map = loadSuiteMap(FIXTURE);
  assert.deepEqual(suitesForChange(map, [
    'apps/api/src/services/ticketComments.ts',
    'apps/api/src/services/ticketComments.test.ts',
    'apps/web/src/components/Ticket.tsx',
    'docs/tickets.md',
  ], { floor: FLOOR }), { suites: [CORE, 'ticket'], reason: 'mapped' });
  assert.deepEqual(suitesForChange(map, ['apps/api/src/services/aiTicketBridge.ts'], { floor: FLOOR }).suites, [CORE, 'ai', 'ticket']);
  assert.deepEqual(suitesForChange(map, ['apps/api/src/services/tickets/close.integration.test.ts'], { floor: FLOOR }).suites, [CORE, 'ticket']);
  assert.deepEqual(suitesForChange(map, [], { floor: FLOOR }), { suites: [CORE], reason: 'mapped' });
});

// neutralPath must never call a path unreachable that the PR classifier says
// the integration suite can read. Pinned in that direction over one sample of
// every neutral pattern, plus the manifests that must stay reachable.
test('neutral paths are a subset of the PR classifier\'s integration=false set', () => {
  const integrationOf = path => {
    const run = spawnSync('bash', [join(REPO_ROOT, '.github/scripts/classify-pr-paths.sh'), '--pull-request'], { input: `${path}\n`, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.match(/^integration=(\w+)$/m)[1];
  };
  const neutral = ['docs/x.md', 'apps/docs/src/x.mdx', 'apps/api/README.md', 'agent/internal/x.go', 'apps/web/src/x.tsx',
    'apps/portal/src/x.ts', 'apps/viewer/src/x.ts', 'apps/helper/src/x.rs', 'apps/mobile/x.ts', 'apps/excel-addin/x.ts',
    'apps/word-addin/x.ts', 'apps/powerpoint-addin/x.ts', 'apps/outlook-addin/x.ts', 'apps/m365-graph-read-executor/x.ts',
    'apps/m365-graph-actions-executor/x.ts', 'apps/m365-communications-executor/x.ts', 'Cargo.lock', 'rust-toolchain.toml'];
  for (const path of neutral) {
    assert.equal(neutralPath(path), true, path);
    assert.equal(integrationOf(path), 'false', `classifier runs integration for ${path}`);
  }
  for (const path of ['apps/web/package.json', 'apps/api/package.json', 'apps/web/.npmrc', 'scripts/x.sh', 'apps/api/src/services/x.ts']) {
    assert.equal(neutralPath(path), false, path);
  }
  // API unit tests cannot reach the suite; its own files and helpers can.
  assert.equal(neutralPath('apps/api/src/services/x.test.ts'), true);
  assert.equal(neutralPath('apps/api/src/services/x.integration.test.ts'), false);
  assert.equal(neutralPath('apps/api/src/__tests__/integration/x.test.ts'), false);
});

test('direct imports: literal static, re-export, side-effect and dynamic imports, resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suites-'));
  try {
    const put = (path, body = '') => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), body); };
    for (const f of ['a.ts', 'b.ts', 'c/index.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']) put(`apps/api/src/services/${f}`);
    put('apps/api/src/db/index.ts');
    put('apps/api/src/__tests__/integration/x.integration.test.ts', [
      "import { a } from '../../services/a';",
      "import { b } from '../../services/b.js';",
      "export { c } from '../../services/c';",
      "import '../../services/d';",
      "const e = await import('../../services/e');",
      "import { db } from '@/db';",
      "import { describe } from 'vitest';",
      "const f = await import(`../../services/${'f'}`);",
      "// a commented import('../../services/g') still counts: over-approximation is safe",
      "import { missing } from '../../services/missing';",
    ].join('\n'));
    assert.deepEqual(directApiImports(dir, 'apps/api/src/__tests__/integration/x.integration.test.ts'), [
      'apps/api/src/db/index.ts', 'apps/api/src/services/a.ts', 'apps/api/src/services/b.ts', 'apps/api/src/services/c/index.ts',
      'apps/api/src/services/d.ts', 'apps/api/src/services/e.ts', 'apps/api/src/services/g.ts',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── The committed map against the real suite ────────────────────────────────

const map = loadSuiteMap(read(SUITE_MAP_PATH));
const tests = integrationTestFiles(REPO_ROOT);
const floor = loadFloor(read(FLOOR_PATH));

test('every integration test belongs to exactly one suite', () => {
  assert.ok(tests.length >= 1500, `only ${tests.length} integration tests`);
  const testRules = map.rules.filter(r => r.kind === 'tests');
  const owned = new Map();
  for (const t of tests) {
    const suites = new Set(testRules.filter(r => r.re.test(t)).map(r => r.suite));
    assert.ok(suites.size <= 1, `${t} is matched by the tests globs of ${[...suites].join(' and ')}`);
    const suite = suiteOfTest(map, t);
    owned.set(suite, (owned.get(suite) ?? 0) + 1);
  }
  for (const suite of map.suites.filter(s => s !== CORE)) assert.ok(owned.get(suite) > 0, `suite ${suite} owns no test`);
  assert.equal([...owned.values()].reduce((s, n) => s + n, 0), tests.length);
});

test('core stays at or under 48% of integration files', () => {
  // A ratchet, measured at 47.4% on 2026-11-08 (24 suites from filename
  // prefixes with >= 15 tests). Lower it as suites split out of core.
  const core = tests.filter(t => suiteOfTest(map, t) === CORE).length;
  assert.ok(core / tests.length <= 0.48, `core holds ${core}/${tests.length} (${(core / tests.length * 100).toFixed(1)}%)`);
});

test('imports match ownership: a suite\'s tests import only its own or unowned sources', () => {
  const problems = [];
  for (const t of tests) {
    const suite = suiteOfTest(map, t);
    if (suite === CORE) continue;
    for (const f of directApiImports(REPO_ROOT, t)) {
      const owners = sourceOwners(map, f);
      if (owners.length && !owners.includes(suite)) problems.push(`${t} (suite ${suite}) → ${f} → owned by ${owners.join(', ')}`);
    }
  }
  assert.deepEqual(problems, [], `A change to these imports would not select the importing test's suite. For each, add `
    + `"suite <suite> sources <import>" to ${SUITE_MAP_PATH}, or move the test to core with "suite core tests <test>" above `
    + 'the suite\'s own tests glob.');
});

function walk(dir, rel, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`, out);
    else out.push(`${rel}${e.name}`);
  }
  return out;
}

test('no dead globs: every tests glob owns a test and every sources glob matches a source', () => {
  const sources = walk(join(REPO_ROOT, 'apps/api/src'), 'apps/api/src/').filter(f => !/\.test\.[cm]?[jt]sx?$/.test(f));
  const dead = map.rules.filter(r => !(r.kind === 'tests' ? tests : sources).some(f => r.re.test(f)));
  assert.deepEqual(dead.map(r => `${SUITE_MAP_PATH}:${r.line} suite ${r.suite} ${r.kind} ${r.glob}`), [],
    'remove (or fix) rules whose files were deleted or renamed');
});

test('with the committed map and floor: a migration and an unmapped source select all, a mapped one does not', () => {
  assert.equal(suitesForChange(map, ['apps/api/migrations/2026-11-08-000000-x.sql'], { floor }).suites, 'all');
  assert.equal(suitesForChange(map, ['apps/api/src/__tests__/integration/setup.ts'], { floor }).suites, 'all');
  assert.equal(suitesForChange(map, ['apps/api/src/index.ts'], { floor }).suites, 'all');
  const mapped = suitesForChange(map, ['apps/api/src/services/ticketService.ts'], { floor });
  assert.equal(mapped.reason, 'mapped');
  assert.ok(mapped.suites.includes('ticket') && mapped.suites.includes(CORE) && mapped.suites.length < map.suites.length);
});

test('the map is a listed policy input', () => {
  assert.ok(POLICY_FILES.includes(SUITE_MAP_PATH));
});

test('lint runs this suite', () => {
  const ci = read('.github/workflows/ci.yml');
  const lint = ci.match(/^  lint:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(lint, 'lint job not found');
  assert.match(lint, /^        run: node --test \.github\/scripts\/integration-suites\.test\.mjs$/m);
});
