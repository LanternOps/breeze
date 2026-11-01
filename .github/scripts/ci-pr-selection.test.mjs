import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const scripts = join(REPO_ROOT, '.github/scripts');
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const classify = (paths, pr = false, dir = scripts) => {
  const run = spawnSync('bash', [join(dir, 'classify-pr-paths.sh'), ...(pr ? ['--pull-request'] : [])], {
    encoding: 'utf8', input: paths.join('\n') + (paths.length ? '\n' : ''),
  });
  assert.equal(run.status, 0, run.stderr);
  return { ...Object.fromEntries(run.stdout.trim().split('\n').map((line) => line.split('='))), stderr: run.stderr };
};
const classifyPr = (paths, dir) => classify(paths, true, dir);
const entries = (file) => readFileSync(join(scripts, file), 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);
const withPolicies = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-selection-'));
  try {
    for (const file of ['classify-pr-paths.sh', 'path-reader-map.txt', 'qemu-gate-paths.txt']) {
      if (existsSync(join(scripts, file))) copyFileSync(join(scripts, file), join(dir, file));
    }
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const REQUIRED_FLOOR = `apps/api/migrations/
apps/api/src/db/
apps/api/src/services/tenantCascade.ts
apps/api/src/services/orgMergeRegistry.ts
apps/api/src/services/tenantExportPolicy.ts
apps/api/src/services/tenantExportPolicyRegistry.ts
apps/api/src/__tests__/
apps/api/vitest.integration.config.ts
apps/api/vitest.config.rls.ts
apps/api/vitest.config.rls-coverage.ts
apps/api/vitest.config.request-db-role.ts
apps/api/vitest.config.integration-suite-coverage.ts
apps/api/vitest.config.site-scope-coverage.ts
ee/
packages/
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.npmrc
.node-version
.nvmrc
patches/
docker-compose.test.yml
docker/
.github/workflows/ci.yml
.github/scripts/`.split('\n');

test('floor file: every required entry is present', () => {
  const floor = entries('integration-floor-paths.txt');
  for (const path of REQUIRED_FLOOR) assert.ok(floor.includes(path), path);
});
test('floor file: every entry exists in the tree', () => {
  for (const path of entries('integration-floor-paths.txt')) {
    assert.ok(existsSync(join(REPO_ROOT, path)), path);
    assert.equal(statSync(join(REPO_ROOT, path)).isDirectory(), path.endsWith('/'), path);
  }
});
test('floor file: every entry classifies integration=true on a PR', () => {
  for (const path of entries('integration-floor-paths.txt')) {
    const out = classifyPr([path.endsWith('/') ? `${path}probe.ts` : path]);
    assert.equal(out.integration, 'true', path);
    assert.equal(out.code, 'true', path);
  }
});
test('floor: applied independently of the exclusion rules', () => withPolicies((dir) => {
  writeFileSync(join(dir, 'integration-floor-paths.txt'), 'apps/web/src/floor-probe.ts\n');
  assert.equal(classifyPr(['apps/web/src/floor-probe.ts'], dir).integration, 'true');
  assert.equal(classifyPr(['apps/web/src/other.ts'], dir).integration, 'false');
}));
test('floor: missing or empty file disables the PR gate (fail-closed)', () => withPolicies((dir) => {
  for (const content of [null, '# nothing pinned\n']) {
    if (content !== null) writeFileSync(join(dir, 'integration-floor-paths.txt'), content);
    const out = classifyPr(['apps/web/src/x.ts'], dir);
    assert.equal(out.integration, 'true');
    assert.match(out.stderr, /integration-floor-paths/);
  }
}));
test('floor: changes nothing without --pull-request and nothing on a docs path', () => {
  assert.equal(classify(['apps/api/migrations/x.sql']).integration, 'true');
  assert.equal(classifyPr(['apps/api/README.md']).integration, 'false');
});
test('lint runs this suite', () => {
  assert.match(job('lint'), /^        run: node --test \.github\/scripts\/ci-pr-selection\.test\.mjs$/mu);
});

const trackedFiles = (...patterns) => {
  const run = spawnSync('git', ['ls-files', '--', ...patterns], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean);
};
test('install inputs: every tracked workspace manifest and install input classifies integration=true on a PR', () => {
  const files = trackedFiles('apps/*/package.json', 'packages/*/package.json', 'ee/*/package.json', 'package.json',
    'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc', '.nvmrc', '.node-version', 'patches/*');
  assert.ok(files.length >= 20);
  for (const file of files) assert.equal(classifyPr([file]).integration, 'true', file);
  for (const dir of ['apps/web', 'apps/mobile', 'packages/shared', 'ee/workspace', 'nested/deep']) {
    for (const file of ['.npmrc', '.nvmrc', '.node-version']) {
      assert.equal(classifyPr([`${dir}/${file}`]).integration, 'true', `${dir}/${file}`);
    }
  }
});
test('install inputs: a manifest change still sets api and integration never exceeds api', () => {
  const out = classifyPr(['apps/web/package.json']);
  assert.equal(out.api, 'true');
  assert.equal(out.integration, 'true');
});
test('apps/docs/package.json is a manifest, not documentation', () => {
  const out = classifyPr(['apps/docs/package.json']);
  for (const flag of ['code', 'docs', 'app', 'api', 'integration']) assert.equal(out[flag], 'true', flag);
  for (const flag of ['web', 'portal', 'addins', 'm365', 'rust', 'agent_code']) assert.equal(out[flag], 'false', flag);
  assert.equal(classifyPr(['apps/docs/src/content/docs/x.mdx']).code, 'false');
});
test('a non-manifest app file still does not run integration', () => {
  for (const file of ['apps/web/src/x.ts', 'apps/m365-communications-executor/Dockerfile', 'apps/mobile/src/App.tsx']) {
    assert.equal(classifyPr([file]).integration, 'false', file);
  }
});

const readerMap = () => entries('path-reader-map.txt').map((line) => {
  const [test, pattern] = line.split(/\s+/u);
  return { test, pattern };
});
const bashMatches = (pattern, paths) => {
  const run = spawnSync('bash', ['-c', 'while IFS= read -r p; do [[ "$p" == $1 ]] && printf "%s\\n" "$p"; done; exit 0', 'match', pattern], {
    encoding: 'utf8', input: paths.join('\n') + '\n', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean);
};
const classificationCache = new Map();
const cachedClassify = (path) => {
  if (!classificationCache.has(path)) classificationCache.set(path, classify([path]));
  return classificationCache.get(path);
};
test('reader map: every row names an existing test and matches tracked docs-classified paths', () => {
  const tracked = trackedFiles();
  const map = readerMap();
  assert.ok(map.length >= 9);
  for (const row of map) {
    assert.match(row.test, /\.test\.(ts|tsx|mjs)$/u);
    assert.ok(existsSync(join(REPO_ROOT, row.test)), row.test);
    const matches = bashMatches(row.pattern, tracked);
    assert.ok(matches.length, `dead map row: ${row.test} ${row.pattern}`);
    for (const path of matches) {
      const out = cachedClassify(path);
      assert.equal(out.docs, 'true', path);
      if (path !== 'apps/docs/package.json') assert.equal(out.code, 'false', path);
    }
  }
});
test('reader map scan: every docs path a test reads by literal path is declared', () => {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const directories = new Map();
  for (const file of tracked) {
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
      if (!directories.has(dir)) directories.set(dir, []);
      directories.get(dir).push(file);
    }
  }
  // Fixture file names that collide with tracked root docs: these tests create
  // README.md / CLAUDE.md in a temporary tree (or a mocked git tree listing);
  // nothing is read from the repository.
  const exemptions = {
    'ee/workspace/src/__tests__/support/provisionTestDb.test.ts': ['README.md'],
    'apps/api/src/jobs/wingetIndexSyncWorker.test.ts': ['README.md'],
    'apps/api/src/services/aiModels/prepareSdkChild.test.ts': ['CLAUDE.md'],
  };
  const map = readerMap();
  const findings = new Set();
  const missing = new Set();
  for (const file of tracked.filter((p) => /^(?:(?:apps|packages|ee)\/[^/]+\/src\/|scripts\/).*\.test\.(ts|tsx|mjs)$/u.test(p))) {
    for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*|\/\*|#)/u.test(line)) continue;
      for (const match of line.matchAll(/(['"`])([^'"`\n]+)\1/gu)) {
        const literal = match[2];
        if (exemptions[file]?.includes(literal)) continue;
        const candidates = [literal];
        if (/^\.\.?\//u.test(literal)) candidates.push(normalize(join(dirname(file), literal)));
        for (const path of candidates) {
          if (!trackedSet.has(path) && !directories.has(path)) continue;
          const out = cachedClassify(path);
          if (out.code !== 'false' || out.docs !== 'true') continue;
          findings.add(file);
          // A directory read must cover every tracked descendant, not just one file.
          const targets = directories.get(path) ?? [path];
          const covered = new Set(map.filter((r) => r.test === file).flatMap((r) => bashMatches(r.pattern, targets)));
          if (targets.some((target) => !covered.has(target))) missing.add(`${file} reads ${path}`);
        }
      }
    }
  }
  for (const file of [
    'apps/web/src/components/devices/time/timeSyncDocs.test.ts', 'apps/api/src/config/turnPeerRestrictions.test.ts',
    'apps/api/src/config/envReadComposeCoverage.test.ts', 'apps/api/src/config/redisEvictionPolicyDocs.test.ts',
    'scripts/agents/build-agents-md.test.mjs', 'scripts/security/check-security-guards.test.mjs',
  ]) assert.ok(findings.has(file), `vacuous scan: ${file}`);
  assert.deepEqual([...missing], []);
});
test('classifier: mapped docs name their sorted readers; unmapped docs and code have none', () => {
  const out = classify(['apps/docs/src/content/docs/deploy/turn-server.mdx']);
  assert.equal(out.code, 'false');
  assert.equal(out.docs, 'true');
  assert.equal(out.path_readers, 'true');
  assert.equal(out.reader_tests, 'apps/api/src/config/redisEvictionPolicyDocs.test.ts apps/api/src/config/turnPeerRestrictions.test.ts apps/web/src/lib/__tests__/alertingDocs.test.ts');
  for (const file of ['docs/guide.md', 'apps/api/src/index.ts']) {
    const other = classify([file]);
    assert.equal(other.path_readers, 'false');
    assert.equal(other.reader_tests, '');
  }
  assert.equal(classify(['CLAUDE.md']).reader_tests, 'scripts/agents/build-agents-md.test.mjs');
  assert.equal(classify(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.md']).reader_tests, 'scripts/agents/build-agents-md.test.mjs');
  // README.md is read by bootstrapDocs.test.ts; the fixture-name collisions are exempted in the scan below.
  assert.equal(classify(['README.md']).reader_tests, 'apps/api/src/db/bootstrapDocs.test.ts');
});
test('classifier: empty list fails closed to path_readers=true with an empty reader list', () => {
  const out = classify([]);
  assert.equal(out.path_readers, 'true');
  assert.equal(out.reader_tests, '');
});
test('classifier: missing or empty reader map fails closed with an empty list, exit 0', () => withPolicies((dir) => {
  rmSync(join(dir, 'path-reader-map.txt'), { force: true });
  for (const content of [null, '# empty\n']) {
    if (content !== null) writeFileSync(join(dir, 'path-reader-map.txt'), content);
    const out = classify(['docs/guide.md'], false, dir);
    assert.equal(out.path_readers, 'true');
    assert.equal(out.reader_tests, '');
    assert.match(out.stderr, /path-reader-map/);
  }
}));
test('classifier: --pull-request does not change reader outputs', () => {
  for (const files of [[], ['CLAUDE.md'], ['docs/guide.md'], ['apps/docs/src/content/docs/deploy/turn-server.mdx']]) {
    for (const flag of ['path_readers', 'reader_tests']) assert.equal(classifyPr(files)[flag], classify(files)[flag]);
  }
});
const summary = job('ci-success');
const summaryScript = summary.split('        run: |\n')[1].split('\n')
  .filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
const allResults = (value) => Object.fromEntries([...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((m) => [m[1], value]));
const triState = (flag, rv) => new RegExp(
  `\\{ \\[\\[ "\\$\\{${flag}\\}" == "true" \\]\\] && \\[\\[ "\\$\\{${rv}\\}" != "success" \\]\\]; \\} \\|\\| \\\\\\n\\s*`
  + `\\{ \\[\\[ "\\$\\{${flag}\\}" != "true" \\]\\] && \\[\\[ "\\$\\{${flag}\\}" != "false" \\]\\]; \\} \\|\\| \\\\\\n\\s*`
  + `\\{ \\[\\[ "\\$\\{${flag}\\}" == "false" \\]\\] && \\[\\[ "\\$\\{${rv}\\}" != "skipped" \\]\\]; \\}`, 'u');
const runSummary = (env) => spawnSync('bash', ['-e', '-c', summaryScript], { encoding: 'utf8', env: { ...process.env, ...env } });
test('changes exposes reader outputs and the merge-group fallback turns readers on with an empty list', () => {
  for (const flag of ['path_readers', 'reader_tests']) assert.ok(job('changes').includes(flag + ': ${{ steps.classify.outputs.' + flag + ' }}'));
  assert.match(job('changes'), /integration=true\\npath_readers=true\\nreader_tests=\\n' \| tee/u);
});
test('path-read-contracts is gated only on path_readers and asserted outside the code block', () => {
  const body = job('path-read-contracts');
  assert.match(body, /^    if: needs\.changes\.outputs\.path_readers == 'true'$/mu);
  assert.match(body, /run: node \.github\/scripts\/run-reader-tests\.mjs/u);
  assert.match(body, /READER_TESTS: \$\{\{ needs\.changes\.outputs\.reader_tests \}\}/u);
  assert.match(summary, /needs: \[[^\]]*\bpath-read-contracts\b/u);
  assert.match(summary, /PATH_READ_CONTRACTS_RESULT: \$\{\{ needs\.path-read-contracts\.result \}\}/u);
  assert.match(summary, /PATH_READERS_CHANGED: \$\{\{ needs\.changes\.outputs\.path_readers \}\}/u);
  assert.match(summaryScript, triState('PATH_READERS_CHANGED', 'PATH_READ_CONTRACTS_RESULT'));
  assert.ok(summaryScript.indexOf('"${PATH_READERS_CHANGED}"') < summaryScript.indexOf('"${CODE_CHANGED}" != "false"'));
  assert.match(job('lint'), /run: node --test \.github\/scripts\/run-reader-tests\.test\.mjs/u);
});
for (const [flag, result, passes] of [
  ['true', 'success', true], ['true', 'failure', false], ['true', 'skipped', false],
  ['false', 'skipped', true], ['false', 'success', false], ['', 'skipped', false], ['maybe', 'success', false],
]) {
  test(`docs-only summary: readers=${JSON.stringify(flag)} result=${result}`, () => {
    const out = runSummary({ ...allResults('skipped'), CHANGES_RESULT: 'success', DOCS_CHANGED: 'true',
      DOCS_CHECK_RESULT: 'success', CODE_CHANGED: 'false', PATH_READERS_CHANGED: flag, PATH_READ_CONTRACTS_RESULT: result });
    assert.equal(out.status, passes ? 0 : 1, out.stdout + out.stderr);
  });
}
