import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as queue from './queue-selection.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const classify = (paths, pr = false) => Object.fromEntries(execFileSync('bash', [
  join(REPO_ROOT, '.github/scripts/classify-pr-paths.sh'), ...(pr ? ['--pull-request'] : []),
], { encoding: 'utf8', input: paths.join('\n') + '\n' }).trim().split('\n').map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
const context = {
  workflow, classify,
  floor: readFileSync(join(REPO_ROOT, '.github/scripts/integration-floor-paths.txt'), 'utf8'),
  integrationConfig: readFileSync(join(REPO_ROOT, 'apps/api/vitest.integration.config.ts'), 'utf8'),
};
const select = (P, delta, full = classify(P)) => queue.computeSelection({ ...context, P, delta, full });
const fixtureDir = join(REPO_ROOT, '.github/scripts/fixtures/queue-selection');
const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8')));
const fixture = name => fixtures.find(f => f.name === name);
const NEVER = ['build-smoke-images', 'guided-setup-smoke', 'portal-dev-e2e', 'rust-check-windows', 'smoke-test', 'test-agent-race', 'workspace-runtime'];

test('fixtures: every real interaction is caught by the thin selection', () => {
  assert.equal(fixtures.length, 7);
  for (const f of fixtures) {
    const out = select(f.P, f.delta);
    assert.equal(out.mode, 'shadow', `${f.name}: ${out.reason}`);
    assert.ok(out.thin_jobs.includes(f.caught_by_job), f.name);
  }
});
test('fixture same-file-overlap: O is computed and its area runs its full unit suite', () => {
  const f = fixture('same-file-overlap');
  const out = select(f.P, f.delta);
  assert.deepEqual(out.overlap, f.expect_overlap);
  assert.ok(out.thin_jobs.includes('test-web'));
});
test('fixture docs-path-read: reader map applied to delta', () => {
  const f = fixture('docs-path-read');
  const out = select(f.P, f.delta);
  for (const reader of f.expect_reader_tests) assert.ok(out.reader_tests.includes(reader));
  assert.ok(out.thin_jobs.includes('path-read-contracts'));
});
test('own tests are routed to the job that runs them', () => {
  for (const [path, jobs] of [
    ['apps/api/src/__tests__/integration/x.integration.test.ts', ['integration-test']],
    ['apps/api/src/services/x.test.ts', ['test-api']],
    ['apps/web/src/x.test.tsx', ['test-web']],
    ['agent/internal/x/x_test.go', ['test-agent', 'test-agent-windows']],
  ]) assert.deepEqual(queue.routeOwnTest(path, context).jobs, jobs);
  assert.equal(select(['unknown/x.test.ts'], []).reason, 'unrouted_own_test');
});
test('floor applied to P ∪ delta', () => {
  for (const [P, delta] of [
    [['apps/web/src/x.ts'], ['apps/api/migrations/zzz.sql']],
    [['apps/api/migrations/zzz.sql'], ['apps/web/src/x.ts']],
  ]) assert.ok(select(P, delta).thin_jobs.includes('integration-test'));
});
test('never-thinned jobs keep the full value', () => {
  assert.deepEqual(queue.nonGatingJobs(workflow), NEVER);
  const out = select(['apps/web/src/x.ts'], []);
  for (const name of NEVER) assert.equal(out.thin_jobs.includes(name), out.full_jobs.includes(name), name);
  for (const name of ['smoke-test', 'portal-dev-e2e']) assert.ok(out.thin_jobs.includes(name));
});
test('e2e specs: named → that job; unnamed → unrun, not a fallback', () => {
  assert.deepEqual(queue.routeOwnTest('e2e-tests/tests/multi-currency.spec.ts', context).jobs, ['portal-dev-e2e']);
  const path = 'e2e-tests/tests/document-renderer.spec.ts';
  const out = select([path], []);
  assert.deepEqual(out.unrun_own_tests, [path]);
  assert.equal(out.mode, 'shadow');
});
