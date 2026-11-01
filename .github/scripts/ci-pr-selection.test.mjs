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
