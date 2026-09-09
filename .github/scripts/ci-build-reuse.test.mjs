import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../actions/load-smoke-images/action.yml', import.meta.url), 'utf8');
const job = (name) => {
  const body = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(body, `Missing job ${name}`);
  return body;
};
const shellBlock = (text, indentation) => {
  const lines = text.split('run: |\n')[1]?.split('\n');
  assert.ok(lines, 'Missing run script');
  return lines.filter((line) => line.startsWith(' '.repeat(indentation)))
    .map((line) => line.slice(indentation)).join('\n');
};

test('unit tests avoid app compilation while dedicated builds remain required', () => {
  for (const [app, command] of [
    ['api', 'pnpm --filter=@breeze/api test:run'],
    ['web', 'pnpm --filter=@breeze/web test --run'],
    ['portal', 'pnpm --filter=@breeze/portal test'],
  ]) {
    assert.ok(job(`test-${app}`).includes(`run: ${command}`));
    assert.doesNotMatch(job(`test-${app}`), /run: pnpm test --filter=/u);
    assert.ok(job(`build-${app}`).includes(`pnpm build --filter=@breeze/${app}`));
    assert.ok(job('ci-success').includes(`[[ "\${BUILD_${app.toUpperCase()}_RESULT}" != "success" ]]`));
  }
});

test('each smoke image is built once, with matching build args and its own cache', () => {
  const producer = job('build-smoke-images');
  const compose = readFileSync(new URL('../../docker-compose.override.yml.ci', import.meta.url), 'utf8');
  for (const app of ['api', 'web', 'portal']) assert.ok(producer.includes(`- image: ${app}`));
  for (const file of ['docker/Dockerfile.api', 'docker/Dockerfile.web', 'apps/portal/Dockerfile']) {
    assert.ok(producer.includes(`dockerfile: ${file}`));
    assert.ok(compose.includes(`dockerfile: ${file}`));
  }
  assert.match(producer, /build-args: PUBLIC_API_URL=/u);
  assert.match(producer, /PORTAL_BASE_PATH=\/portal\n\s+PUBLIC_API_URL=/u);
  assert.match(producer, /platforms: linux\/amd64/u);
  assert.match(producer, /push: false/u);
  assert.doesNotMatch(producer, /packages: write|secrets\.|login-action/u);
  assert.match(producer, /cache-from: type=gha,scope=ci-smoke-\$\{\{ matrix.image \}\}/u);
  assert.match(producer, /cache-to: type=gha,mode=max,scope=ci-smoke-\$\{\{ matrix.image \}\}/u);
  assert.match(producer, /outputs: type=docker,dest=\$\{\{ runner.temp \}\}\/\$\{\{ matrix.image \}\}.tar/u);
  assert.match(producer, /name: ci-smoke-image-\$\{\{ matrix.image \}\}/u);
  assert.match(producer, /if-no-files-found: error/u);
  assert.match(loader, /pattern: ci-smoke-image-\*/u);
  assert.doesNotMatch(loader, /github-token:|run-id:|repository:/u, 'download only this run, including fork PRs');
});

test('both suites depend on and load shared images instead of rebuilding', () => {
  for (const name of ['smoke-test', 'guided-setup-smoke']) {
    const body = job(name);
    assert.match(body, /needs: \[[^\]]*build-smoke-images[^\]]*\]/u);
    assert.match(body, /uses: \.\/\.github\/actions\/load-smoke-images/u);
    assert.doesNotMatch(body, /docker build|up --build/u);
  }
  assert.match(job('smoke-test'), /up --no-build -d/u);
  assert.doesNotMatch(job('smoke-test'), /BREEZE_(API|WEB|PORTAL)_IMAGE_REF=.*:latest/u);
  assert.match(job('lint'), /node --test \.github\/scripts\/ci-build-reuse.test.mjs/u);
});

// Exercise the actual loader shell without building or loading local images.
// A missing artifact, failed docker load, or wrong checkout must stop both
// consumers before their application references are exported to later steps.
for (const [label, missing, loadFailure, revision, expectedStatus] of [
  ['all images match', '', '', 'current-sha', 0],
  ['missing portal archive', 'portal', '', 'current-sha', 1],
  ['docker load fails', '', 'web', 'current-sha', 1],
  ['stale image revision', '', '', 'previous-sha', 1],
]) {
  test(`loader: ${label}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'breeze-image-loader-'));
    try {
      for (const app of ['api', 'web', 'portal']) {
        if (app !== missing) writeFileSync(join(dir, `${app}.tar`), 'fixture');
      }
      writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "load" ]]; then
  [[ "$2" == "--input" && -f "$3" ]] || exit 1
  [[ -z "$LOAD_FAILURE" || "$3" != */"$LOAD_FAILURE".tar ]] || exit 1
elif [[ "$1 $2" == "image inspect" ]]; then
  [[ "\${@: -1}" == ghcr.io/lanternops/breeze/*:ci-smoke-123 ]] || exit 1
  echo "$TEST_REVISION"
else
  exit 1
fi
`, { mode: 0o755 });
      const envFile = join(dir, 'github-env');
      writeFileSync(envFile, '');
      const execution = spawnSync('bash', ['-e', '-c', shellBlock(loader, 8)], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE_ARCHIVE_DIR: dir,
          CI_IMAGE_VERSION: 'ci-smoke-123', CI_IMAGE_REVISION: 'current-sha',
          TEST_REVISION: revision, LOAD_FAILURE: loadFailure, GITHUB_ENV: envFile,
        },
      });
      assert.equal(execution.status, expectedStatus, execution.stdout + execution.stderr);
      const output = readFileSync(envFile, 'utf8');
      if (expectedStatus !== 0) assert.equal(output, '');
      else {
        assert.ok(output.includes('GUIDED_SMOKE_VERSION=ci-smoke-123\n'));
        for (const app of ['api', 'web', 'portal']) {
          assert.ok(output.includes(`BREEZE_${app.toUpperCase()}_IMAGE_REF=ghcr.io/lanternops/breeze/${app}:ci-smoke-123\n`));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const summary = job('ci-success');
const passing = Object.fromEntries(
  [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((match) => [match[1], 'success']),
);
for (const result of ['failure', 'cancelled', 'skipped', '']) {
  for (const isPr of ['true', 'false']) {
    test(`summary: image producer ${result || 'missing'}, PR=${isPr}`, () => {
      const execution = spawnSync('bash', ['-e', '-c', shellBlock(summary, 10)], {
        encoding: 'utf8',
        env: {
          ...process.env, ...passing, IS_PR: isPr, CODE_CHANGED: 'true', DOCS_CHANGED: 'false',
          MOBILE_NATIVE_REQUIRED: 'true', BUILD_SMOKE_IMAGES_RESULT: result,
          SMOKE_TEST_RESULT: 'skipped', GUIDED_SETUP_SMOKE_RESULT: 'skipped',
        },
      });
      assert.equal(execution.status, isPr === 'true' ? 0 : 1, execution.stdout + execution.stderr);
    });
  }
}
