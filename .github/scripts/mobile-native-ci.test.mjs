import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const changes = job('mobile-native-changes');
const build = job('build-mobile-ios');
const summary = job('ci-success');

test('mobile compilation watches all native and workspace dependency inputs', () => {
  for (const input of [
    'apps/mobile/**', 'packages/**',
    'pnpm-workspace.yaml', '.npmrc', '.node-version', '.nvmrc', 'patches/**',
    '.github/workflows/ci.yml', '.github/scripts/mobile-native-ci.test.mjs',
    '.github/scripts/mobile-lockfile-closure.mjs',
  ]) {
    assert.ok(changes.includes(`- '${input}'`), `Missing native build input ${input}`);
  }
  // The lockfile and root package.json are NOT direct inputs any more: they
  // gate through the closure comparison so api/web-only bumps never allocate a
  // macOS runner. Both must still be watched by the `lockfile` filter.
  const mobileFilterMatch = changes.match(/mobile:\n([\s\S]*?)\n\s+lockfile:/u);
  assert.ok(mobileFilterMatch, 'mobile: filter block followed by lockfile: block not found');
  const mobileFilter = mobileFilterMatch[1];
  assert.doesNotMatch(mobileFilter, /- 'pnpm-lock\.yaml'|- 'package\.json'/u, 'lockfile edits must go through the closure gate');
  const lockfileFilterMatch = changes.match(/lockfile:\n([\s\S]*?)\n\n/u);
  assert.ok(lockfileFilterMatch, 'lockfile: filter block not found');
  const lockfileFilter = lockfileFilterMatch[1];
  assert.match(lockfileFilter, /- 'pnpm-lock\.yaml'/u);
  assert.match(lockfileFilter, /- 'package\.json'/u);
  assert.match(changes, /id: lockfile\n\s+if: steps\.changes\.outputs\.lockfile == 'true'/u);
  assert.match(changes, /node \.github\/scripts\/mobile-lockfile-closure\.mjs "\$\{RUNNER_TEMP\}\/pnpm-lock\.base\.yaml" pnpm-lock\.yaml \| tee -a "\$GITHUB_OUTPUT"/u);
  assert.match(changes, /steps\.lockfile\.outputs\.changed == 'true'/u, 'closure result must feed the mobile output');
  assert.match(changes, /github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha/u);
  assert.match(changes, /runs-on: ubuntu-latest/u);
  // ci.yml no longer runs on pushes to main (the merge queue evaluated every
  // landing on its merge-group ref), so there is no multi-commit push to span:
  // PRs and merge groups compare against the default branch, and a manual
  // dispatch on main falls through to `mobile: true`.
  assert.doesNotMatch(changes, /github\.event\.before/u, 'no push-only base: main pushes do not run CI');
  assert.match(changes, /base: \$\{\{ github\.event\.repository\.default_branch \}\}/u, 'compare against the default branch');
  assert.doesNotMatch(workflow, /^  push:\n\s+branches: \[main\]/mu, 'ci.yml must not trigger on push to main; the queue already ran it');
  assert.match(changes, /github\.event_name == 'workflow_dispatch'/u);
  assert.doesNotMatch(changes, /- 'apps\/api\/\*\*'/u);
  assert.match(build, /needs: \[mobile-native-changes\]/u);
  assert.match(build, /if: needs\.mobile-native-changes\.outputs\.mobile == 'true'/u);
});

test('native check compiles a secret-free unsigned simulator build from frozen dependencies', () => {
  assert.match(build, /runs-on: macos-/u);
  assert.match(build, /pnpm install --filter breeze-mobile\.\.\. --frozen-lockfile/u);
  assert.match(build, /pnpm exec expo prebuild --platform ios --no-install/u);
  assert.match(build, /run: pod install/u);
  assert.match(build, /-workspace BreezeRMM\.xcworkspace/u);
  assert.match(build, /-scheme BreezeRMM/u);
  assert.match(build, /-configuration Debug/u);
  assert.match(build, /-sdk iphonesimulator/u);
  assert.match(build, /-destination 'generic\/platform=iOS Simulator'/u);
  assert.match(build, /CODE_SIGNING_ALLOWED=NO/u);
  assert.match(build, /SENTRY_DISABLE_AUTO_UPLOAD: 'true'/u);
  assert.match(build, /set -o pipefail/u, 'tee must not hide compilation errors');
  assert.doesNotMatch(build, /secrets\.|continue-on-error:|BREEZE_MOBILE_ALLOW_|BREEZE_MOBILE_DEV:/u);
});

test('CI Success keeps existing required checks and requires both new jobs', () => {
  const dependencies = summary.match(/needs: \[([^\]]+)\]/u)?.[1].split(', ');
  for (const name of ['lint', 'typecheck', 'test-api', 'test-web', 'test-agent', 'test-mobile', 'mobile-native-changes', 'build-mobile-ios']) {
    assert.ok(dependencies?.includes(name), `Missing required dependency ${name}`);
  }
  assert.match(job('lint'), /node --test \.github\/scripts\/mobile-native-ci\.test\.mjs/u);
  assert.match(job('lint'), /node --test \.github\/scripts\/mobile-lockfile-closure\.test\.mjs/u);
});

test('Test Web is sharded four ways like Test API', () => {
  const web = job('test-web');
  assert.match(web, /name: Test Web \(shard \$\{\{ matrix\.shard \}\}\/4\)/u);
  assert.match(web, /shard: \[1, 2, 3, 4\]/u);
  assert.match(web, /fail-fast: false/u);
  assert.match(web, /pnpm --filter=@breeze\/web test --run --shard=\$\{\{ matrix\.shard \}\}\/4/u);
});

// Execute the real summary shell, with other required jobs successful. A path
// detector failure or an unexpectedly skipped native check must never go green.
const summaryScript = summary.split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');
const passingResults = Object.fromEntries(
  [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((match) => [match[1], 'success']),
);
for (const [label, detector, required, result, passes] of [
  ['relevant change compiles', 'success', 'true', 'success', true],
  ['unrelated change skips', 'success', 'false', 'skipped', true],
  ['compile fails', 'success', 'true', 'failure', false],
  ['compile unexpectedly skips', 'success', 'true', 'skipped', false],
  ['compile cancels', 'success', 'true', 'cancelled', false],
  ['detector fails', 'failure', '', 'skipped', false],
  ['detector skips', 'skipped', '', 'skipped', false],
  ['detector emits no output', 'success', '', 'skipped', false],
  ['unexpected build failure', 'success', 'false', 'failure', false],
]) {
  test(`CI Success: ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: {
        ...process.env, ...passingResults, IS_PR: 'true',
        // These three non-`_RESULT` classifier outputs are not covered by
        // `passingResults` (auto-discovered only from `*_RESULT:` env lines),
        // but ci-success's fail-closed gates require them to be exactly
        // 'true'/'false' or the whole check goes red regardless of the
        // mobile-specific fixture below.
        AGENT_CHANGED: 'true',
        APP_CHANGED: 'true',
        MOBILE_NATIVE_CHANGES_RESULT: detector,
        MOBILE_NATIVE_REQUIRED: required,
        BUILD_MOBILE_IOS_RESULT: result,
      },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}
