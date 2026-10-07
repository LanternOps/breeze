import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Per-area job gating (2026-09-18). The `changes` classifier emits one boolean
// per application AREA on top of code/docs/agent/app, and the heavy jobs that
// only exercise one area run only when that area changed. Measured on
// merge-group run 35405850683 (an api-only dependency bump): 278 runner-minutes,
// most of it add-in/M365/Rust/portal jobs that could not have been affected.
//
// The danger is one-directional: a wrong gate SILENTLY SKIPS a whole area's
// tests and CI Success still goes green. So every rule here fails OPEN:
//   - a shared/global input (lockfile, packages/**, ci.yml, docker, scripts…)
//     sets every area;
//   - a code path matching NO area rule sets every area;
//   - an unresolvable merge_group entry and a non-PR event set every area;
//   - an area whose tests READ another area's files is also set when those
//     files change (the cross-area scan below keeps that list honest).

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const summary = job('ci-success');

const AREAS = ['api', 'web', 'portal', 'addins', 'm365', 'rust'];
const classify = (paths, script = new URL('./classify-pr-paths.sh', import.meta.url).pathname) => {
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    input: paths.join('\n') + (paths.length ? '\n' : ''),
  });
  assert.equal(run.status, 0, run.stderr);
  return Object.fromEntries(run.stdout.trim().split('\n').map((l) => l.split('=')));
};
const areasOf = (out) => Object.fromEntries(AREAS.map((a) => [a, out[a]]));
const expectAreas = (on) => Object.fromEntries(AREAS.map((a) => [a, on === 'all' || on.includes(a) ? 'true' : 'false']));

// ─── Classifier: per-area rules ─────────────────────────────────────────
test('classifier: emits every area output, in order, after code/docs/agent/app, then topology_browser, agent_code, integration', () => {
  const run = spawnSync('bash', [new URL('./classify-pr-paths.sh', import.meta.url).pathname], {
    encoding: 'utf8', input: 'apps/api/src/index.ts\n',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.stdout.trim().split('\n').map((l) => l.split('=')[0]),
    // topology_browser (#6117) is a single-job gate, not an area; it trails the areas.
    // integration (#5936) gates one job, not an area; it trails everything.
    ['code', 'docs', 'agent', 'app', ...AREAS, 'topology_browser', 'agent_code', 'integration'],
  );
});

for (const [paths, on] of [
  // api-only. apps/api/** is read by nothing outside the api area except the
  // portal's visibility-gate test (apps/api/src/routes/portal/**), below.
  [['apps/api/src/services/foo.ts'], ['api']],
  [['apps/api/migrations/2026-10-01-x.sql'], ['api']],
  [['apps/api/src/routes/devices/core.ts', 'apps/api/package.json'], ['api']],
  // web — test-api's repo-wide contract suites (exchangeRateBoundary,
  // tierConfig parity, the Dockerfile scans) read apps/web, so web also sets api.
  [['apps/web/src/components/Foo.tsx'], ['web', 'api']],
  [['apps/web/astro.config.mjs'], ['web', 'api']],
  // portal — exchangeRateBoundary scans apps/portal/src; Dockerfile scans read it.
  [['apps/portal/src/pages/index.astro'], ['portal', 'api']],
  // The portal's visibilityGate test reads apps/api/src/routes/portal/*.ts.
  [['apps/api/src/routes/portal/tickets.ts'], ['api', 'portal']],
  // add-ins (office-addin-core is under packages/**, which is global).
  [['apps/excel-addin/src/taskpane.ts'], ['addins']],
  [['apps/word-addin/src/x.ts'], ['addins']],
  [['apps/powerpoint-addin/src/x.ts'], ['addins']],
  [['apps/outlook-addin/src/x.ts'], ['addins']],
  // M365 executors.
  [['apps/m365-graph-read-executor/src/index.ts'], ['m365']],
  [['apps/m365-graph-actions-executor/src/index.ts'], ['m365']],
  [['apps/m365-communications-executor/src/index.ts'], ['m365']],
  // Every app's Dockerfile and package.json is enumerated by test-api's
  // dockerfileWorkspaceManifests / dockerfileOpensslUpgrade / image-scan suites.
  [['apps/m365-graph-read-executor/Dockerfile'], ['m365', 'api']],
  [['apps/excel-addin/package.json'], ['addins', 'api']],
  // Rust / Tauri apps. desktopWs_inputSchema.test.ts (test-api) reads apps/viewer/src.
  [['apps/helper/src-tauri/src/main.rs'], ['rust']],
  [['apps/viewer/src-tauri/src/main.rs'], ['rust']],
  [['apps/viewer/src/lib/protocol.ts'], ['rust', 'api']],
  [['Cargo.lock'], ['rust']],
  [['rust-toolchain.toml'], ['rust']],
  // Mobile has its own gate (mobile-native-changes); no area job reads it except
  // through package.json enumeration.
  [['apps/mobile/src/App.tsx'], []],
  [['apps/mobile/package.json'], ['api']],
  // Unions.
  [['apps/excel-addin/src/x.ts', 'apps/m365-graph-read-executor/src/x.ts'], ['addins', 'm365']],
]) {
  test(`classifier: ${paths.join(' + ')} → ${on.join(',') || 'no area'}`, () => {
    const out = classify(paths);
    assert.equal(out.code, 'true');
    assert.deepEqual(areasOf(out), expectAreas(on));
  });
}

test('classifier: shared/global inputs set every area', () => {
  for (const path of [
    'packages/shared/src/types/device.ts',
    'packages/office-addin-core/src/x.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.node-version',
    '.nvmrc',
    'patches/foo@1.0.0.patch',
    'tsconfig.json',
    'tsconfig.base.json',
    '.github/workflows/ci.yml',
    '.github/scripts/classify-pr-paths.sh',
    '.github/scripts/prepare-ci-apt-sources.mjs',
    'docker/Dockerfile.api',
    'docker-compose.yml',
    'docker-compose.test.yml',
    'Dockerfile.api',
    'scripts/smoke-guided-setup.sh',
    'scripts/release/verify-release-images.sh',
    'ee/workspace/src/index.ts',
  ]) {
    assert.deepEqual(areasOf(classify([path])), expectAreas('all'), path);
  }
});

test('classifier: FAIL OPEN — a code path matching no area rule sets every area', () => {
  for (const path of [
    'agent/internal/heartbeat/heartbeat.go',
    'e2e-tests/tests/login.spec.ts',
    'load-tests/k6/devices.js',
    'deploy/docker-compose.prod.yml',
    '.github/workflows/release.yml',
    '.github/actions/install-chromium/action.yml',
    'turbo.json',
    'some-new-top-level-dir/x.ts',
    'apps/some-new-app/src/index.ts',
    // A nested tsconfig/Dockerfile/Cargo file is NOT a root global; outside an
    // app dir it must still fail open rather than match nothing.
    'tools/tsconfig.json',
  ]) {
    assert.deepEqual(areasOf(classify([path])), expectAreas('all'), path);
  }
});

test('classifier: docs-only lists set no area, an empty list sets every area', () => {
  assert.deepEqual(areasOf(classify(['docs/guide.md', 'apps/api/README.md', 'apps/docs/src/content/docs/x.mdx'])), expectAreas([]));
  assert.deepEqual(areasOf(classify([])), expectAreas('all'));
});

test('classifier: a tooling-only (app=false) change always sets api, so check-migrations still runs', () => {
  // ci-success requires check-migrations == success on the tooling-only path
  // (it is the sole validation of the release-lineage / migration guards there),
  // and check-migrations is now api-gated. Every tooling path is either global
  // or unmatched, so api is true; pin it.
  for (const path of [
    '.github/workflows/release.yml',
    '.github/scripts/ci-build-reuse.test.mjs',
    'scripts/release/check-release-lineage.sh',
    'scripts/security/check-npm-audit.sh',
    '.github/release-provenance/candidate-tags.tsv',
  ]) {
    const out = classify([path]);
    assert.equal(out.app, 'false', path);
    assert.equal(out.api, 'true', path);
  }
});

// ─── Cross-area reads: keep the cross-area rules honest ─────────────────
// Scan every area's sources for a literal reference into ANOTHER area's
// directory (a `../` relative path, a repo-root-relative `apps/<x>/…` string,
// or a `'apps', '<x>'` join) and require the classifier to set the READING
// area when that path changes. A reference found here with no matching rule
// is a test that would be silently skipped. Directory enumeration
// (readdirSync over apps/*) cannot be found this way; those are pinned below.
const AREA_DIRS = {
  api: ['apps/api'],
  web: ['apps/web'],
  portal: ['apps/portal'],
  addins: ['apps/excel-addin', 'apps/word-addin', 'apps/powerpoint-addin', 'apps/outlook-addin'],
  m365: ['apps/m365-graph-read-executor', 'apps/m365-graph-actions-executor', 'apps/m365-communications-executor'],
  rust: ['apps/viewer', 'apps/helper'],
};
const OWNED_DIRS = [...Object.values(AREA_DIRS).flat(), 'apps/mobile'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'coverage', 'gen', 'locales', 'build']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|astro|json|toml|rs|sh|ya?ml)$/u;
function* walk(dir) {
  let entries;
  try { entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(e.name)) yield p;
  }
}
const crossAreaRefs = () => {
  const refs = [];
  for (const [area, dirs] of Object.entries(AREA_DIRS)) {
    for (const dir of dirs) {
      for (const file of walk(dir)) {
        readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*|#)/u.test(line)) return;
          const targets = [];
          for (const m of line.matchAll(/['"`]((?:\.\.\/)+[^'"`$\s]*)/gu)) targets.push(normalize(join(dirname(file), m[1])));
          for (const m of line.matchAll(/['"`](apps\/[a-z0-9-]+(?:\/[^'"`$\s:]*)?)/gu)) targets.push(normalize(m[1]));
          for (const m of line.matchAll(/['"`]apps['"`]\s*,\s*['"`]([a-z0-9-]+)['"`]/gu)) targets.push(`apps/${m[1]}`);
          for (const target of targets) {
            const owner = OWNED_DIRS.find((d) => target === d || target.startsWith(`${d}/`));
            if (!owner || AREA_DIRS[area].includes(owner)) continue;
            refs.push({ area, target: target.replace(/\/$/u, ''), at: `${file}:${i + 1}` });
          }
        });
      }
    }
  }
  return refs;
};

test('cross-area scan finds the known references (guards against a vacuous scan)', () => {
  const refs = crossAreaRefs();
  const seen = new Set(refs.map((r) => `${r.area} ${r.target}`));
  for (const known of [
    'api apps/web/src/components/ai-risk/tierConfig',
    'api apps/viewer/src',
    'api apps/portal/src',
    'portal apps/api/src/routes/portal/tickets.ts',
    'web apps/api/src/services/accounting/types.ts',
    'web apps/api/src/services/monitors',
  ]) {
    assert.ok(seen.has(known), `scanner no longer finds "${known}" — it is stale, or the reference moved`);
  }
});

test('every cross-area reference sets the reading area when the referenced path changes', () => {
  const missing = [];
  for (const { area, target, at } of crossAreaRefs()) {
    // A changed-file list only ever names files: probe the path itself when it
    // names one, and something beneath it when it may be a directory (or an
    // extensionless import specifier).
    const abs = join(REPO_ROOT, target);
    const probes = existsSync(abs) && statSync(abs).isDirectory()
      ? [`${target}/probe.ts`]
      : existsSync(abs) ? [target] : ['.ts', '.tsx', '.js', '.mjs'].map((ext) => `${target}${ext}`).filter((p) => existsSync(join(REPO_ROOT, p)));
    if (probes.length === 0) missing.push(`${area} ← ${target} (${at}): referenced path does not exist; fix the scanner`);
    for (const probe of probes) {
      if (classify([probe])[area] !== 'true') missing.push(`${area} ← ${probe} (${at})`);
    }
  }
  assert.deepEqual(missing, [], 'add a cross-area rule to classify-pr-paths.sh for each of these');
});

test('every app Dockerfile and package.json sets api (test-api enumerates them)', () => {
  const apps = readdirSync(join(REPO_ROOT, 'apps'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(apps.length >= 10, 'apps/ enumeration is stale');
  for (const app of apps) {
    for (const file of ['Dockerfile', 'package.json']) {
      if (!existsSync(join(REPO_ROOT, 'apps', app, file))) continue;
      if (app === 'docs') continue; // docs-only classification owns apps/docs/**
      assert.equal(classify([`apps/${app}/${file}`]).api, 'true', `apps/${app}/${file}`);
    }
  }
});

// ─── changes job wiring ─────────────────────────────────────────────────
const classifyScript = job('changes').split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');

test('the changes job exposes every area output from the classifier', () => {
  const body = job('changes');
  for (const area of AREAS) {
    assert.match(body, new RegExp(`^      ${area}: \\$\\{\\{ steps\\.classify\\.outputs\\.${area} \\}\\}$`, 'mu'), area);
  }
});

const runChangesStep = (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'area-gate-'));
  try {
    const outputFile = join(dir, 'gh-output');
    writeFileSync(outputFile, '');
    const execution = spawnSync('bash', ['-c', classifyScript], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env },
    });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    return Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map((l) => l.split('=')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('merge_group: an unresolvable entry and a non-PR event set every area (full suite)', () => {
  for (const env of [
    { EVENT_NAME: 'merge_group', BASE_SHA: '', HEAD_SHA: 'abc' },
    { EVENT_NAME: 'merge_group', BASE_SHA: 'abc', HEAD_SHA: '' },
    { EVENT_NAME: 'merge_group', BASE_SHA: '0000000000000000000000000000000000000000', HEAD_SHA: '1111111111111111111111111111111111111111' },
    { EVENT_NAME: 'workflow_dispatch' },
  ]) {
    const out = runChangesStep(env);
    assert.equal(out.code, 'true', JSON.stringify(env));
    assert.deepEqual(areasOf(out), expectAreas('all'), JSON.stringify(env));
    assert.equal(out.integration, 'true', JSON.stringify(env));
  }
});

// ─── Job gating ─────────────────────────────────────────────────────────
const APP_IF = "needs.changes.outputs.code == 'true' && needs.changes.outputs.app == 'true'";
const AREA_JOBS = {
  // integration-test is NOT here: it has its own, narrower `integration` output
  // (#5936), asserted at the bottom of this file and in classify-pr-paths.test.mjs.
  api: ['test-api', 'check-migrations-nonsuperuser', 'build-api'],
  web: ['test-web', 'build-web'],
  portal: ['test-portal', 'build-portal'],
  addins: ['test-office-addin-core', 'test-excel-addin', 'test-word-addin', 'test-powerpoint-addin', 'test-outlook-addin'],
  m365: [
    'test-m365-graph-read-executor', 'test-m365-graph-actions-executor', 'test-m365-communications-executor',
    'build-m365-graph-read-executor', 'build-m365-graph-actions-executor', 'build-m365-communications-executor',
  ],
  rust: ['rust-check'],
};
// They boot the whole stack (api + web + portal images), so any of the three.
const STACK_JOBS = ['build-smoke-images', 'smoke-test', 'guided-setup-smoke'];
const STACK_IF = `${APP_IF} && (needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.portal == 'true')`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

for (const [area, jobs] of Object.entries(AREA_JOBS)) {
  for (const name of jobs) {
    test(`${name} is gated on the ${area} area`, () => {
      assert.match(job(name), new RegExp(`^    if: ${escape(`${APP_IF} && needs.changes.outputs.${area} == 'true'`)}$`, 'mu'));
    });
  }
}
test('check-migrations is gated on code AND api (never on app: it guards tooling-only PRs)', () => {
  assert.match(job('check-migrations'), /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.api == 'true'$/mu);
});
for (const name of STACK_JOBS) {
  test(`${name} is gated on api OR web OR portal`, () => {
    assert.match(job(name), new RegExp(`^    if: ${escape(STACK_IF)}$`, 'mu'));
  });
}
test('jobs that must never be area-gated are not', () => {
  for (const name of ['changes', 'lint', 'typecheck', 'security-audit', 'workspace-runtime', 'docs-check', 'ci-success',
    'auth-browser-transition-browser-contract', 'test-viewer', 'test-mobile', 'test-agent', 'build-agent']) {
    assert.doesNotMatch(job(name), /^    if: .*outputs\.(api|web|portal|addins|m365|rust) ==/mu, name);
  }
});

// ─── ci-success tri-state ───────────────────────────────────────────────
const FLAG = { api: 'API_CHANGED', web: 'WEB_CHANGED', portal: 'PORTAL_CHANGED', addins: 'ADDINS_CHANGED', m365: 'M365_CHANGED', rust: 'RUST_CHANGED' };
const resultVar = (name) => `${name.toUpperCase().replace(/-/gu, '_')}_RESULT`;
const triState = (flag, rv) => new RegExp(
  `\\{ \\[\\[ "\\$\\{${flag}\\}" == "true" \\]\\] && \\[\\[ "\\$\\{${rv}\\}" != "success" \\]\\]; \\} \\|\\| \\\\\\n\\s*`
  + `\\{ \\[\\[ "\\$\\{${flag}\\}" != "true" \\]\\] && \\[\\[ "\\$\\{${flag}\\}" != "false" \\]\\]; \\} \\|\\| \\\\\\n\\s*`
  + `\\{ \\[\\[ "\\$\\{${flag}\\}" == "false" \\]\\] && \\[\\[ "\\$\\{${rv}\\}" != "skipped" \\]\\]; \\}`,
  'u',
);

test('ci-success receives every area flag from the classifier', () => {
  for (const [area, flag] of Object.entries(FLAG)) {
    assert.match(summary, new RegExp(`^          ${flag}: \\$\\{\\{ needs\\.changes\\.outputs\\.${area} \\}\\}$`, 'mu'));
  }
});
for (const [area, jobs] of Object.entries(AREA_JOBS)) {
  for (const name of jobs) {
    test(`ci-success asserts ${name} with the three-branch ${FLAG[area]} pattern`, () => {
      const rv = resultVar(name);
      assert.match(summary, triState(FLAG[area], rv));
      assert.doesNotMatch(summary, new RegExp(`^\\s*\\[\\[ "\\$\\{${rv}\\}" != "success" \\]\\] \\|\\| \\\\$`, 'mu'),
        `the old unconditional ${rv} clause must be replaced by the three-branch pattern`);
    });
  }
}

// check-migrations (#7032): gated on code AND api, so it is outside AREA_JOBS, but
// an api change must still REQUIRE it green. It used to be asserted only when
// app=false, so a red migration-naming/replay/immutability guard passed CI Success
// on every API PR.
test('ci-success asserts check-migrations with the three-branch API_CHANGED pattern (#7032)', () => {
  assert.match(summary, triState('API_CHANGED', 'CHECK_MIGRATIONS_RESULT'));
});

// Execute the real summary shell.
const summaryScript = summary.split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');
const resultVars = [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((m) => m[1]);
const allResults = (v) => Object.fromEntries(resultVars.map((r) => [r, v]));
const gatedVars = Object.fromEntries(Object.entries(AREA_JOBS).map(([a, jobs]) => [a, jobs.map(resultVar)]));
const STACK_VARS = STACK_JOBS.map(resultVar);
// A whole-suite green run with only the given areas changed: every other area's
// jobs skipped, exactly as their `if:` would leave them.
const onlyAreas = (on, { isPr = 'true' } = {}) => {
  const env = {
    ...allResults('success'),
    CHANGES_RESULT: 'success', CODE_CHANGED: 'true', DOCS_CHANGED: 'false', DOCS_CHECK_RESULT: 'skipped',
    APP_CHANGED: 'true', AGENT_CHANGED: 'false', RECOVERY_MEDIA_E2E_RESULT: 'skipped',
    MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped', IS_PR: isPr,
  };
  for (const area of AREAS) {
    const changed = on.includes(area);
    env[FLAG[area]] = changed ? 'true' : 'false';
    if (!changed) for (const v of gatedVars[area]) env[v] = 'skipped';
  }
  if (!on.includes('api')) env.CHECK_MIGRATIONS_RESULT = 'skipped';
  // Integration rides its own flag; model it as following api here (the PR gate is
  // never wider than api — pinned below), the tri-state lives in classify-pr-paths.test.mjs.
  env.INTEGRATION_CHANGED = on.includes('api') ? 'true' : 'false';
  if (!on.includes('api')) env.INTEGRATION_TEST_RESULT = 'skipped';
  if (!['api', 'web', 'portal'].some((a) => on.includes(a))) for (const v of STACK_VARS) env[v] = 'skipped';
  return env;
};
const runSummary = (env) => spawnSync('bash', ['-e', '-c', summaryScript], { encoding: 'utf8', env: { ...process.env, ...env } });

for (const [label, env, passes] of [
  ['api-only PR, other areas skipped', onlyAreas(['api']), true],
  ['api-only merge-queue entry, other areas skipped', onlyAreas(['api'], { isPr: 'false' }), true],
  ['addins-only merge-queue entry: smoke jobs correctly skipped', onlyAreas(['addins'], { isPr: 'false' }), true],
  ['addins-only merge-queue entry: smoke ran anyway', { ...onlyAreas(['addins'], { isPr: 'false' }), SMOKE_TEST_RESULT: 'success' }, false],
  ['web-only merge-queue entry: smoke skipped although the stack changed', { ...onlyAreas(['web'], { isPr: 'false' }), SMOKE_TEST_RESULT: 'skipped' }, false],
  ['web-only merge-queue entry: smoke red', { ...onlyAreas(['web'], { isPr: 'false' }), SMOKE_TEST_RESULT: 'failure' }, false],
  ['web-only PR: smoke red stays non-blocking', { ...onlyAreas(['web']), SMOKE_TEST_RESULT: 'failure' }, true],
  ['every area changed, all green', onlyAreas(AREAS), true],
  ['every area changed, all green, merge queue', onlyAreas(AREAS, { isPr: 'false' }), true],
  ['api-only: check-migrations ran although api=false?', { ...onlyAreas(['web']), CHECK_MIGRATIONS_RESULT: 'success' }, false],
  ['api changed: check-migrations red blocks an application PR (#7032)', { ...onlyAreas(['api']), CHECK_MIGRATIONS_RESULT: 'failure' }, false],
  ['api changed: check-migrations skipped (job vanished) blocks (#7032)', { ...onlyAreas(['api']), CHECK_MIGRATIONS_RESULT: 'skipped' }, false],
  ['api changed: check-migrations red blocks a merge-queue entry (#7032)', { ...onlyAreas(['api'], { isPr: 'false' }), CHECK_MIGRATIONS_RESULT: 'failure' }, false],
]) {
  test(`CI Success (areas): ${label}`, () => {
    const r = runSummary(env);
    assert.equal(r.status, passes ? 0 : 1, r.stdout + r.stderr);
  });
}

for (const [area, vars] of Object.entries(gatedVars)) {
  for (const rv of vars) {
    test(`CI Success (areas): ${area} changed, ${rv} unexpectedly skipped → red`, () => {
      assert.equal(runSummary({ ...onlyAreas([area]), [rv]: 'skipped' }).status, 1);
    });
    test(`CI Success (areas): ${area} changed, ${rv} red → red`, () => {
      assert.equal(runSummary({ ...onlyAreas([area]), [rv]: 'failure' }).status, 1);
    });
    const other = area === 'rust' ? 'm365' : 'rust';
    test(`CI Success (areas): ${area} NOT changed, ${rv} ran anyway → red`, () => {
      assert.equal(runSummary({ ...onlyAreas([other]), [rv]: 'success' }).status, 1);
    });
  }
}
// Review of #6315: every area's all-green entry, not just api/web/addins — a
// portal-only entry exercises the PORTAL_CHANGED leg of STACK_CHANGED, and
// m365/rust-only entries must pass with the smoke jobs skipped.
for (const area of ['portal', 'm365', 'rust']) {
  for (const isPr of ['true', 'false']) {
    test(`CI Success (areas): ${area}-only, all green, IS_PR=${isPr}`, () => {
      const r = runSummary(onlyAreas([area], { isPr }));
      assert.equal(r.status, 0, r.stdout + r.stderr);
    });
  }
}
test('CI Success (areas): portal-only merge-queue entry with smoke skipped → red (the stack changed)', () => {
  assert.equal(runSummary({ ...onlyAreas(['portal'], { isPr: 'false' }), SMOKE_TEST_RESULT: 'skipped' }).status, 1);
});

test('classifier: a bare *.mdx outside any docs directory is docs-only', () => {
  const out = classify(['apps/api/CHANGELOG.mdx']);
  assert.equal(out.code, 'false');
  assert.deepEqual(areasOf(out), expectAreas([]));
});

// A rename lists only the NEW path unless asked otherwise. Moving a file out of
// an area must still run that area (its tests may import the old path), so
// both listings include the old side of a rename.
test('the PR listing includes the previous path of a renamed file', () => {
  assert.match(classifyScript, /--jq '\.\[\] \| \.filename, \(\.previous_filename \/\/ empty\)'/u);
});
test('merge_group: a rename out of an area sets that area too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'area-rename-'));
  try {
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.com');
    git('config', 'user.name', 'CI');
    spawnSync('mkdir', ['-p', join(dir, 'apps/web/src'), join(dir, 'apps/excel-addin/src'), join(dir, '.github/scripts')]);
    const body = 'export const x = 1;\n'.repeat(40);
    writeFileSync(join(dir, 'apps/excel-addin/src/shared.ts'), body);
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'apps/excel-addin/src/shared.ts', 'apps/web/src/shared.ts');
    git('commit', '-q', '-m', 'move');
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, '.github/scripts/classify-pr-paths.sh'), readFileSync(new URL('./classify-pr-paths.sh', import.meta.url)));
    const outputFile = join(dir, 'gh-output');
    writeFileSync(outputFile, '');
    const r = spawnSync('bash', ['-c', classifyScript], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile, EVENT_NAME: 'merge_group', BASE_SHA: base, HEAD_SHA: head },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map((l) => l.split('=')));
    assert.equal(out.web, 'true');
    assert.equal(out.addins, 'true', 'the old side of the rename must be classified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint runs this suite (it is the only thing that enforces the area contract)', () => {
  const lint = job('lint');
  assert.match(lint, /^    if: needs\.changes\.outputs\.code == 'true'$/mu, 'lint must stay code-only so it runs on every code PR');
  assert.match(lint, /^        run: node --test \.github\/scripts\/ci-area-gating\.test\.mjs$/mu);
});

for (const flag of Object.values(FLAG)) {
  for (const bad of ['', 'maybe']) {
    test(`CI Success (areas): ${flag}=${JSON.stringify(bad)} fails closed`, () => {
      assert.equal(runSummary({ ...onlyAreas(AREAS), [flag]: bad }).status, 1);
    });
  }
}

// ─── #5936: the integration-test PR gate, derived from the suite's sources ──
// `integration` (--pull-request only) skips the 16-shard real-Postgres job for
// paths the suite cannot read. A wrong `false` silently skips it on a PR (the
// merge queue still runs it — it is never gated there), so the map is re-derived
// here from what the job actually executes, not trusted by hand:
//   1. every include glob of every integration vitest config the job runs;
//   2. every repo path referenced (relative `../` import/read, a repo-root
//      `apps/<x>` literal, an `'apps', '<x>'` join) by code the suite can reach —
//      apps/api (minus its unit tests), ee/, and every workspace package reachable
//      from their package.json manifests;
//   3. every compose file and pnpm filter the integration-test job invokes.
// Each of those must classify integration=true on a PR.
const classifyPrGate = (paths) => {
  const run = spawnSync('bash', [new URL('./classify-pr-paths.sh', import.meta.url).pathname, '--pull-request'], {
    encoding: 'utf8',
    input: paths.join('\n') + (paths.length ? '\n' : ''),
  });
  assert.equal(run.status, 0, run.stderr);
  return Object.fromEntries(run.stdout.trim().split('\n').map((l) => l.split('=')));
};

const pkgDirByName = (() => {
  const map = {};
  for (const root of ['apps', 'packages', 'ee']) {
    for (const e of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
      const manifest = join(REPO_ROOT, root, e.name, 'package.json');
      if (e.isDirectory() && existsSync(manifest)) map[JSON.parse(readFileSync(manifest, 'utf8')).name] = `${root}/${e.name}`;
    }
  }
  return map;
})();

// apps/api and the built-in extensions it boots/tests, plus their workspace deps, transitively.
const integrationPackageDirs = (() => {
  const seen = new Set();
  const queue = ['apps/api', ...readdirSync(join(REPO_ROOT, 'ee'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `ee/${e.name}`)];
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8'));
    for (const deps of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
      for (const [name, spec] of Object.entries(deps ?? {})) {
        if (String(spec).startsWith('workspace:')) {
          assert.ok(pkgDirByName[name], `${dir} depends on unknown workspace package ${name}`);
          queue.push(pkgDirByName[name]);
        }
      }
    }
  }
  return [...seen];
})();

// A unit test is not integration-reachable; an integration suite (or anything
// under src/__tests__/integration) is.
const isUnitTest = (file) => /\.test\.[cm]?[jt]sx?$/u.test(file)
  && !/\.integration\.test\.ts$/u.test(file)
  && !file.includes('/src/__tests__/integration/');

const integrationRefs = () => {
  const refs = [];
  for (const dir of integrationPackageDirs) {
    for (const file of walk(dir)) {
      if (isUnitTest(file)) continue;
      readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*|#)/u.test(line)) return;
        const targets = [];
        for (const m of line.matchAll(/['"`]((?:\.\.\/)+[^'"`$\s]*)/gu)) targets.push(normalize(join(dirname(file), m[1])));
        for (const m of line.matchAll(/['"`](apps\/[a-z0-9-]+(?:\/[^'"`$\s:]*)?)/gu)) targets.push(normalize(m[1]));
        for (const m of line.matchAll(/['"`]apps['"`]\s*,\s*['"`]([a-z0-9-]+)['"`]/gu)) targets.push(`apps/${m[1]}`);
        for (const target of targets) {
          if (target.startsWith('..')) continue; // outside the repo
          refs.push({ target: target.replace(/\/$/u, ''), at: `${file}:${i + 1}` });
        }
      });
    }
  }
  return refs;
};
const probeFor = (target) => {
  const abs = join(REPO_ROOT, target);
  return existsSync(abs) && statSync(abs).isDirectory() ? `${target}/probe.ts` : target;
};

test('integration gate: the reachable package set is derived, not hardcoded', () => {
  for (const must of ['apps/api', 'packages/shared', 'packages/extension-sdk', 'ee/workspace']) {
    assert.ok(integrationPackageDirs.includes(must), `${must} missing from ${integrationPackageDirs.join(', ')}`);
  }
  assert.ok(!integrationPackageDirs.includes('apps/web'), 'apps/web must not be reachable from the API manifests');
});

test('integration gate: the reference scan finds the known cross-directory reads (guards against a vacuous scan)', () => {
  const seen = new Set(integrationRefs().map((r) => r.target));
  for (const known of [
    'packages/shared/src/fixtures/scanPath.json', // filesystemMultiVolumeMigration.integration.test.ts
    'packages/shared/src/testing/topologyFixtures', // topologyDigestIngest / baseline suites
    'apps/api/migrations', // replayMigration.ts and the readFileSync replays
    'apps/api/scripts/topology-migrate', // topology-rollout / legacy-import suites
    '.env.test', // every integration vitest config loads it
  ]) {
    assert.ok(seen.has(known), `scanner no longer finds "${known}" — it is stale, or the reference moved`);
  }
});

test('integration gate: every repo path integration-reachable code references is integration=true on a PR', () => {
  const missing = [];
  for (const { target, at } of integrationRefs()) {
    if (classifyPrGate([probeFor(target)]).integration !== 'true') missing.push(`${target} (${at})`);
  }
  assert.deepEqual(missing, [], 'the integration suite reads these; classify them integration=true in classify-pr-paths.sh');
});

test('integration gate: every include glob of every integration config the job runs is integration=true', () => {
  const configs = ['apps/api/vitest.integration.config.ts', 'apps/api/vitest.config.request-db-role.ts', 'apps/api/vitest.config.rls-coverage.ts',
    ...integrationPackageDirs.filter((d) => d.startsWith('ee/')).map((d) => `${d}/vitest.integration.config.ts`).filter((f) => existsSync(join(REPO_ROOT, f)))];
  let globs = 0;
  for (const config of configs) {
    // Drop comment lines first: one inside the include list quotes `::text[]`.
    const src = readFileSync(join(REPO_ROOT, config), 'utf8').split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n');
    const include = src.match(/include:\s*\[([\s\S]*?)\]/u);
    assert.ok(include, `${config}: no include list`);
    for (const m of include[1].matchAll(/'([^']+)'/gu)) {
      globs += 1;
      const prefix = m[1].split('*')[0];
      const probe = `${dirname(config)}/${prefix}${prefix.endsWith('.ts') ? '' : 'x.integration.test.ts'}`;
      assert.equal(classifyPrGate([probe]).integration, 'true', `${config}: ${m[1]}`);
    }
  }
  assert.ok(globs > 20, 'integration include parser is stale');
});

test('integration gate: every compose file and pnpm package the integration-test job invokes is integration=true', () => {
  const body = job('integration-test');
  const compose = [...body.matchAll(/docker compose -f (\S+)/gu)].map((m) => m[1]);
  const filters = [...body.matchAll(/--filter[= ](@breeze\/[a-z0-9-]+)/gu)].map((m) => m[1]);
  assert.ok(compose.includes('docker-compose.test.yml'), 'compose parser is stale');
  assert.ok(filters.includes('@breeze/api') && filters.includes('@breeze/ext-workspace'), 'filter parser is stale');
  for (const file of compose) assert.equal(classifyPrGate([file]).integration, 'true', file);
  for (const name of filters) {
    assert.ok(pkgDirByName[name], name);
    assert.equal(classifyPrGate([`${pkgDirByName[name]}/src/probe.ts`]).integration, 'true', name);
    assert.ok(integrationPackageDirs.includes(pkgDirByName[name]), `${name} is run by the job but not in the derived package set`);
  }
});

test('integration gate: the excluded directories are exactly the ones no integration-reachable code touches', () => {
  // The only paths the PR gate may classify false. Each is a whole app (or the Go
  // agent / root Rust manifests) that no reachable package depends on, and the
  // reference scan above proves nothing reachable reads into it.
  const excluded = [
    'agent/internal/x.go', 'apps/web/src/x.ts', 'apps/portal/src/x.ts', 'apps/viewer/src/x.ts', 'apps/helper/src/x.ts',
    'apps/mobile/src/x.ts', 'apps/excel-addin/src/x.ts', 'apps/word-addin/src/x.ts', 'apps/powerpoint-addin/src/x.ts',
    'apps/outlook-addin/src/x.ts', 'apps/m365-graph-read-executor/src/x.ts', 'apps/m365-graph-actions-executor/src/x.ts',
    'apps/m365-communications-executor/src/x.ts', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
  ];
  for (const probe of excluded) assert.equal(classifyPrGate([probe]).integration, 'false', probe);
  const reachable = integrationPackageDirs;
  for (const probe of excluded) {
    const top = probe.split('/').slice(0, probe.startsWith('apps/') ? 2 : 1).join('/');
    assert.ok(!reachable.some((d) => d === top), `${top} is reachable from the API manifests but excluded from the gate`);
  }
});

test('integration gate: on a PR it is never wider than api (integration=true ⇒ api=true)', () => {
  for (const path of [
    'apps/api/src/x.ts', 'apps/api/migrations/x.sql', 'packages/shared/src/x.ts', 'ee/workspace/src/x.ts', 'pnpm-lock.yaml',
    'package.json', 'docker-compose.test.yml', '.github/workflows/ci.yml', '.github/scripts/x.mjs', 'e2e-tests/x.ts',
    'some-new-dir/x.ts', 'apps/web/src/x.ts', 'agent/x.go', 'apps/mobile/src/x.ts', 'apps/excel-addin/src/x.ts', 'Cargo.lock',
  ]) {
    const out = classifyPrGate([path]);
    if (out.integration === 'true') assert.equal(out.api, 'true', path);
  }
});
