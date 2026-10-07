// Contract tests for the server-only release lane in release.yml,
// release-promotion.yml and ci.yml.
//
// Two layers:
//   1. structural — every job that produces a binary artifact family, holds a
//      signing secret or OIDC, or pushes the binaries image is gated on
//      release_kind == 'full'; the integrity gate, create-release, the asset
//      allowlist and the draft rule have their server-only branches;
//   2. behavioural — the job graph is SIMULATED (scripts/release/__fixtures__/
//      workflow-graph.mjs) against the pre-change snapshot, and every full
//      release scenario (tag, prerelease, build-only dispatch, dispatch on a
//      tag, every Windows/macOS signing switch, every single-job failure) must
//      produce exactly the job results it produced before this lane existed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as workflowSecurity from '../../.github/scripts/check-workflow-security.mjs';
import { readJobGraph, simulate } from './__fixtures__/workflow-graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const RELEASE_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const PROMOTION_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release-promotion.yml');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const BASELINE = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'release-job-graph.full-baseline.json'), 'utf8')).jobs;
const scratch = mkdtempSync(join(tmpdir(), 'release-workflow-server-only-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The 16 jobs design §4 skips for a server-only release.
const BINARY_JOBS = [
  'build-agent',
  'build-recovery-media',
  'build-windows-unsigned',
  'build-macos-agent',
  'build-macos-installer-app',
  'build-viewer',
  'build-helper',
  'build-viewer-macos',
  'build-helper-macos',
  'resolve-windows-signing-provider',
  'sign-windows-tauri-azure',
  'sign-windows-tauri-sslcom',
  'sign-windows-tauri',
  'package-windows-updater',
  'merge-viewer-update-manifest',
  'build-binaries-image',
];
const FULL_CONJUNCT = "needs.classify-release.outputs.release_kind == 'full'";
const SERVER_ONLY_CONJUNCT = "needs.classify-release.outputs.release_kind == 'server-only'";

const releaseText = readFileSync(RELEASE_WORKFLOW, 'utf8');
const releaseLines = workflowSecurity.activeLines(releaseText);
const releaseJobs = new Map(workflowSecurity.workflowJobs(releaseLines).map((job) => [job.name, job]));

function job(name) {
  const found = releaseJobs.get(name);
  assert.ok(found, `release.yml must define job ${name}`);
  return found;
}
const jobText = (name) => job(name).lines.map((line) => line.content).join('\n');
const currentGraph = readJobGraph(RELEASE_WORKFLOW);

function ifConjuncts(name) {
  let condition = currentGraph[name].if ?? '';
  if (condition.startsWith('${{') && condition.endsWith('}}')) condition = condition.slice(3, -2);
  return workflowSecurity.topLevelLogicalParts(condition, '&&').map((part) => part.trim());
}

// Lines of one step (from its `- name:` to the next step), and its run script.
function stepLines(jobName, stepName) {
  const lines = job(jobName).lines;
  const start = lines.findIndex((line) => !line.isBlockScalarContent && line.trimmed === `- name: ${stepName}`);
  assert.notEqual(start, -1, `${jobName} must have a step named "${stepName}"`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index].isBlockScalarContent && lines[index].indent <= lines[start].indent) { end = index; break; }
  }
  return { start, lines: lines.slice(start, end) };
}

function stepRun(jobName, stepName) {
  const { lines } = stepLines(jobName, stepName);
  const runIndex = lines.findIndex((line) => !line.isBlockScalarContent && line.trimmed === 'run: |');
  assert.notEqual(runIndex, -1, `${stepName} must have a run: | block`);
  const body = [];
  for (let index = runIndex + 1; index < lines.length && lines[index].isBlockScalarContent; index += 1) body.push(lines[index]);
  // activeLines drops blank lines; re-read the raw file slice to keep heredocs intact.
  const raw = releaseText.split('\n').slice(body[0].line - 1, body.at(-1).line);
  const indent = Math.min(...raw.filter((line) => line.trim()).map((line) => line.match(/^ */u)[0].length));
  return raw.map((line) => line.slice(indent)).join('\n');
}

function stepIndex(jobName, stepName) {
  return stepLines(jobName, stepName).start;
}

// ── Structural contract ─────────────────────────────────────────────────────
test('every binary/signing job needs classify-release and is gated on release_kind == full', () => {
  for (const name of BINARY_JOBS) {
    assert.ok(currentGraph[name].needs.includes('classify-release'), `${name} must need classify-release`);
    assert.ok(
      ifConjuncts(name).includes(FULL_CONJUNCT),
      `${name}: "${FULL_CONJUNCT}" must be a top-level && conjunct of its if: (got ${currentGraph[name].if})`,
    );
  }
});

test('discovery: no other job produces binaries, holds signing secrets or OIDC, or pushes the binaries image', () => {
  const BINARY_ARTIFACT = /^\s+(?:name|asset_name): (?:breeze-(?:agent|backup|watchdog|user-helper|desktop-helper|viewer|helper|recovery)-|breeze-installer-app\b|viewer-latest-json\b|macos-pkg-attestation\b)/mu;
  const SIGNING_SECRET = /\bsecrets\.(?:TAURI_SIGNING_|APPLE_|SSLCOM_|AZURE_)/u;
  const discovered = new Set();
  for (const [name] of releaseJobs) {
    const text = jobText(name);
    const reasons = [];
    if (BINARY_ARTIFACT.test(text) && /actions\/upload-artifact@/u.test(text)) reasons.push('uploads a binary artifact');
    if (SIGNING_SECRET.test(text)) reasons.push('references a signing secret');
    if (/id-token:\s*write/u.test(text)) reasons.push('has id-token: write');
    if (/\/binaries,push-by-digest=true/u.test(text)) reasons.push('pushes the binaries image');
    if (reasons.length === 0) continue;
    discovered.add(name);
    if (name === 'carry-forward-binaries') continue; // carries viewer-latest-json forward; gated server-only below
    assert.ok(BINARY_JOBS.includes(name), `${name} (${reasons.join(', ')}) must be in the server-only skip set`);
  }
  for (const name of BINARY_JOBS) {
    if (['resolve-windows-signing-provider', 'sign-windows-tauri'].includes(name)) continue; // gate jobs, no artifacts
    assert.ok(discovered.has(name), `discovery heuristic went stale: it no longer recognises ${name}`);
  }
});

test('classify-release: runs after lineage, least privilege, full history, base-executed guard', () => {
  const classify = currentGraph['classify-release'];
  assert.deepEqual(classify.needs, ['validate-release-lineage']);
  assert.equal(classify.if, '${{ !cancelled() }}');
  const text = jobText('classify-release');
  assert.match(text, /permissions:\n\s+contents: read\n/u);
  assert.doesNotMatch(text, /contents: write|packages: write|id-token/u);
  assert.match(text, /fetch-depth: 0/u);
  assert.match(text, /fetch-tags: true/u);
  assert.match(text, /persist-credentials: false/u);
  for (const output of ['release_kind', 'binaries_tag', 'binaries_sha', 'binaries_version']) {
    assert.match(text, new RegExp(`${output}: \\$\\{\\{ steps\\.classify\\.outputs\\.${output} \\}\\}`, 'u'));
  }
  const script = stepRun('classify-release', 'Classify release kind');
  assert.match(script, /bash scripts\/release\/run-server-only-guard\.sh/u);
  assert.match(script, /--ledger-ref origin\/main/u);
  assert.match(script, /--main-ref origin\/main/u);
  assert.match(script, /--online/u);
  assert.match(script, /3\)/u, 'exit 3 (not listed) must map to full');
  assert.match(script, /LINEAGE_CHANNEL" != "mainline"/u, 'server-only requires mainline lineage');
  assert.match(script, /LINEAGE_RESULT" != "success"/u);
  assert.match(text, /name: server-only-classification/u);
  assert.doesNotMatch(script, /\$\{\{/u, 'no expression interpolation inside run:');
});

test('classify-release script: build-only runs are full; exit 3 is full; anything else fails', () => {
  const script = stepRun('classify-release', 'Classify release kind');
  const cases = [
    [{ REF_TYPE: 'branch', REF: 'refs/heads/main', EVENT_NAME: 'workflow_dispatch', SKIP_RELEASE: 'true' }, 0, 'release_kind=full'],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'workflow_dispatch', SKIP_RELEASE: 'true' }, 0, 'release_kind=full'],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'failure' }, 1, null],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'success', LINEAGE_CHANNEL: 'mainline', GUARD_EXIT: '3' }, 0, 'release_kind=full'],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'success', LINEAGE_CHANNEL: 'mainline', GUARD_EXIT: '1' }, 1, null],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'success', LINEAGE_CHANNEL: 'mainline', GUARD_EXIT: '2' }, 1, null],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'success', LINEAGE_CHANNEL: 'candidate', GUARD_EXIT: '0' }, 1, null],
    [{ REF_TYPE: 'tag', REF: 'refs/tags/v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', LINEAGE_RESULT: 'success', LINEAGE_CHANNEL: 'mainline', GUARD_EXIT: '0' }, 0, 'release_kind=server-only'],
  ];
  for (const [env, status, expected] of cases) {
    const work = mkdtempSync(join(scratch, 'classify-'));
    const bin = join(work, 'bin');
    mkdirSync(join(work, 'scripts', 'release'), { recursive: true });
    mkdirSync(bin);
    // A stub git (origin/main resolves) and a stub bootstrap with a chosen exit code.
    writeFileSync(join(bin, 'git'), '#!/usr/bin/env bash\n[[ "$1" == "rev-parse" ]] && { echo 0123456789abcdef0123456789abcdef01234567; exit 0; }\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(work, 'scripts', 'release', 'run-server-only-guard.sh'), `#!/usr/bin/env bash
report=""
while [ $# -gt 0 ]; do case "$1" in --report) report="$2"; shift 2 ;; *) shift ;; esac; done
if [ "\${GUARD_EXIT}" = 0 ]; then
  printf '{"tag":"v1.2.3","commit":"%s","base":"v1.2.0","baseSha":"%s","binariesVersion":"1.2.0","changedPathCount":1,"online":true,"agentFacing":[]}\\n' "$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..40})" > "$report"
fi
exit "\${GUARD_EXIT}"
`, { mode: 0o755 });
    const output = join(work, 'out');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: work,
        GITHUB_REPOSITORY: 'LanternOps/breeze',
        REF_NAME: 'v1.2.3',
        LINEAGE_RESULT: '',
        LINEAGE_CHANNEL: '',
        GUARD_EXIT: '3',
        ...env,
      },
    });
    assert.equal(result.status, status, `${JSON.stringify(env)}\n${result.stdout}\n${result.stderr}`);
    const written = readFileSync(output, 'utf8');
    if (expected) {
      assert.match(written, new RegExp(`^${expected}$`, 'mu'), JSON.stringify(env));
    } else {
      assert.doesNotMatch(written, /release_kind=/u, `a failed classification must not emit a kind: ${JSON.stringify(env)}`);
    }
    if (expected === 'release_kind=server-only') {
      assert.match(written, /^binaries_tag=v1\.2\.0$/mu);
      assert.match(written, /^binaries_sha=b{40}$/mu);
      assert.match(written, /^binaries_version=1\.2\.0$/mu);
    }
  }
});

test('classify-release refusal tells the operator what is actually possible once the tag exists', () => {
  const script = stepRun('classify-release', 'Classify release kind');
  const refusal = script.split('\n').find((line) => /eligibility guard refused it/u.test(line));
  assert.ok(refusal, 'classify-release must explain a guard refusal');
  // The tag already exists when this runs, so check-server-only-ledger-change.sh
  // refuses any edit or removal of its row: never tell the operator to do that.
  assert.doesNotMatch(refusal, /remove the ledger row|fix or remove/iu);
  assert.match(refusal, /new tag/u);
  assert.match(refusal, /cannot be edited or removed/u);
});

test('carry-forward-binaries: server-only only, read-only, verifies the base before carrying anything', () => {
  const carry = currentGraph['carry-forward-binaries'];
  assert.deepEqual(carry.needs, ['classify-release']);
  assert.ok(ifConjuncts('carry-forward-binaries').includes(SERVER_ONLY_CONJUNCT));
  assert.ok(ifConjuncts('carry-forward-binaries').includes("needs.classify-release.result == 'success'"));
  const text = jobText('carry-forward-binaries');
  assert.match(text, /permissions:\n\s+contents: read\n\s+packages: read\n/u);
  assert.doesNotMatch(text, /packages: write|contents: write|id-token/u);
  assert.doesNotMatch(text, /secrets\.(?!RELEASE_MANIFEST_ED25519_PUBLIC_KEY\b|GITHUB_TOKEN\b)/u, 'only the public manifest key and the job token');
  assert.doesNotMatch(text, /docker\/build-push-action@|imagetools create/u, 'carry-forward never builds or retags');

  const script = stepRun('carry-forward-binaries', 'Verify the base release manifest');
  assert.match(script, /release-image-manifest\.mjs verify/u);
  assert.match(script, /--require-kind full/u);
  assert.match(script, /--expected-release "\$BINARIES_TAG"/u);
  assert.match(script, /sourceCommit/u);

  const binaries = stepRun('carry-forward-binaries', 'Confirm the carried binaries image');
  assert.match(binaries, /imagetools inspect/u);
  assert.match(binaries, /\/binaries\/VERSION/u);
  assert.match(binaries, /BINARIES_VERSION/u);

  const record = stepRun('carry-forward-binaries', 'Record carried signed-manifest input');
  assert.match(record, /--source-commit "\$BINARIES_SHA"/u, 'carried sourceCommit is truthfully the base commit');
  assert.match(record, /--carried-from-release "\$BINARIES_TAG"/u);
  assert.match(record, /--carried-from-source-commit "\$BINARIES_SHA"/u);
  assert.match(text, /name: release-image-binaries/u, 'same artifact name the full build uses');

  const latest = stepRun('carry-forward-binaries', 'Carry the Viewer update manifest byte-identical');
  assert.match(latest, /sha256/u);
  assert.match(latest, /size/u);
  assert.match(latest, /releases\/download\/\$\{BINARIES_TAG\}\//u);
  assert.match(text, /name: viewer-latest-json/u);
});

test('release-integrity-gate: full checks unchanged; server-only requires every binary job skipped', () => {
  const gate = currentGraph['release-integrity-gate'];
  for (const name of [...BINARY_JOBS.filter((entry) => entry !== 'build-binaries-image' || true), 'classify-release', 'carry-forward-binaries']) {
    assert.ok(gate.needs.includes(name), `integrity gate must need ${name}`);
  }
  const script = stepRun('release-integrity-gate', 'Fail closed when release signing was skipped');
  for (const name of [
    'build-windows-unsigned', 'build-macos-agent', 'build-macos-installer-app', 'sign-windows-tauri',
    'build-viewer-macos', 'build-helper-macos', 'package-windows-updater', 'merge-viewer-update-manifest',
  ]) {
    assert.match(script, new RegExp(`require_success "${name}"`, 'u'), `full branch must still require ${name}`);
  }
  for (const name of BINARY_JOBS) {
    assert.match(script, new RegExp(`require_skipped "${name}"`, 'u'), `server-only branch must require ${name} skipped`);
  }
  assert.match(script, /require_success "carry-forward-binaries"/u);
});

test('integrity gate script: executes both branches and fails closed on an unknown kind', () => {
  const script = stepRun('release-integrity-gate', 'Fail closed when release signing was skipped');
  const envNames = [...jobText('release-integrity-gate').matchAll(/^\s+([A-Z_]+_RESULT): \$\{\{ needs\./gmu)].map((match) => match[1]);
  const all = (value) => Object.fromEntries(envNames.map((name) => [name, value]));
  const runGate = (env) => spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, REF_NAME: 'v1.2.3', EVENT_NAME: 'push', SKIP_RELEASE: 'false', ...env },
  });
  const full = { ...all('success'), RELEASE_KIND: 'full', CARRY_FORWARD_BINARIES_RESULT: 'skipped' };
  assert.equal(runGate(full).status, 0, runGate(full).stdout + runGate(full).stderr);
  assert.equal(runGate({ ...full, SIGN_WINDOWS_TAURI_RESULT: 'skipped' }).status, 1);

  const serverOnly = { ...all('skipped'), RELEASE_KIND: 'server-only', CARRY_FORWARD_BINARIES_RESULT: 'success', CLASSIFY_RELEASE_RESULT: 'success' };
  const ok = runGate(serverOnly);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(runGate({ ...serverOnly, BUILD_AGENT_RESULT: 'success' }).status, 1, 'a binary job that ran must fail the gate');
  assert.equal(runGate({ ...serverOnly, SIGN_WINDOWS_TAURI_SSLCOM_RESULT: 'failure' }).status, 1);
  assert.equal(runGate({ ...serverOnly, CARRY_FORWARD_BINARIES_RESULT: 'skipped' }).status, 1);
  assert.equal(runGate({ ...full, RELEASE_KIND: '' }).status, 1, 'an empty kind on a tag release must fail closed');
  assert.equal(runGate({ ...full, RELEASE_KIND: 'agent-only' }).status, 1);
  assert.equal(runGate({ RELEASE_KIND: '', EVENT_NAME: 'workflow_dispatch', SKIP_RELEASE: 'true' }).status, 0, 'build-only stays advisory');
});

test('create-release has a full branch and a server-only branch, and needs both new jobs', () => {
  const create = currentGraph['create-release'];
  assert.ok(create.needs.includes('classify-release'));
  assert.ok(create.needs.includes('carry-forward-binaries'));
  const conjuncts = ifConjuncts('create-release');
  assert.ok(conjuncts.includes("needs.classify-release.result == 'success'"));
  const branch = conjuncts.find((part) => part.includes(FULL_CONJUNCT));
  assert.ok(branch, 'create-release must carry the kind disjunction as one top-level conjunct');
  const [fullBranch, serverOnlyBranch, ...extra] = workflowSecurity
    .topLevelLogicalParts(branch.trim().replace(/^\(|\)$/gu, ''), '||')
    .map((part) => part.trim());
  assert.equal(extra.length, 0);
  assert.ok(fullBranch.includes(FULL_CONJUNCT));
  assert.ok(serverOnlyBranch.includes(SERVER_ONLY_CONJUNCT));
  assert.ok(serverOnlyBranch.includes("needs.carry-forward-binaries.result == 'success'"));
  for (const name of BINARY_JOBS) {
    if (!create.needs.includes(name)) continue;
    assert.ok(serverOnlyBranch.includes(`needs.${name}.result == 'skipped'`), `server-only branch must require ${name} skipped`);
  }
});

test('server-only releases are always drafts; candidate and RELEASE_DRAFT_FIRST behave as before', () => {
  assert.ok(jobText('create-release').includes(
    "draft: ${{ needs.validate-release-lineage.outputs.channel == 'candidate' || vars.RELEASE_DRAFT_FIRST == 'true' || needs.classify-release.outputs.release_kind == 'server-only' }}",
  ));
});

test('the server-only asset allowlist runs before the manifest is signed; the banner is prepended', () => {
  const allowlist = stepIndex('create-release', 'Verify server-only release assets');
  const signing = stepIndex('create-release', 'Sign release artifact manifest');
  const fullCheck = stepIndex('create-release', 'Verify signing-input manifest entries');
  assert.ok(allowlist < signing, 'allowlist must run before signing');
  assert.ok(fullCheck < signing);
  const { lines: fullLines } = stepLines('create-release', 'Verify signing-input manifest entries');
  assert.ok(fullLines.some((line) => line.trimmed === "if: startsWith(github.ref, 'refs/tags/') && env.RELEASE_KIND == 'full'"));
  const { lines: soLines } = stepLines('create-release', 'Verify server-only release assets');
  assert.ok(soLines.some((line) => line.trimmed === "if: startsWith(github.ref, 'refs/tags/') && env.RELEASE_KIND == 'server-only'"));
  assert.ok(jobText('create-release').includes(
    "body_path: ${{ env.RELEASE_KIND == 'server-only' && 'release-banner.md' || '' }}",
  ), 'full releases must pass no body');
  assert.ok(stepIndex('create-release', 'Write server-only release banner') < stepIndex('create-release', 'Create GitHub Release'));
});

test('build-docker-api bakes BREEZE_BINARIES_VERSION only for server-only releases', () => {
  assert.ok(currentGraph['build-docker-api'].needs.includes('classify-release'));
  const text = jobText('build-docker-api');
  assert.ok(text.includes(
    "${{ needs.classify-release.outputs.release_kind == 'server-only' && format('BREEZE_BINARIES_VERSION={0}', needs.classify-release.outputs.binaries_version) || '' }}",
  ), 'full releases must pass no BREEZE_BINARIES_VERSION build-arg at all');
  for (const [name] of releaseJobs) {
    if (name === 'build-docker-api') continue;
    assert.doesNotMatch(jobText(name), /BREEZE_BINARIES_VERSION=/u, `${name} must not bake the pairing`);
  }
});

test('promote-signed-release-images is unchanged and still promotes the (carried) binaries digest', () => {
  assert.deepEqual(currentGraph['promote-signed-release-images'], BASELINE['promote-signed-release-images']);
  assert.match(jobText('promote-signed-release-images'), /- \{ name: binaries, moving_channels: true \}/u);
});

// ── Behavioural contract: full releases are unchanged ──────────────────────
const EVENTS = {
  'tag push': { github: { ref_type: 'tag', ref: 'refs/tags/v1.2.3', ref_name: 'v1.2.3', event_name: 'push' }, inputs: {} },
  'prerelease tag push': { github: { ref_type: 'tag', ref: 'refs/tags/v1.2.3-rc.1', ref_name: 'v1.2.3-rc.1', event_name: 'push' }, inputs: {} },
  'build-only dispatch on main': { github: { ref_type: 'branch', ref: 'refs/heads/main', ref_name: 'main', event_name: 'workflow_dispatch' }, inputs: { skip_release: true } },
  'dispatch on main without skip': { github: { ref_type: 'branch', ref: 'refs/heads/main', ref_name: 'main', event_name: 'workflow_dispatch' }, inputs: { skip_release: false } },
  'build-only dispatch on a tag': { github: { ref_type: 'tag', ref: 'refs/tags/v1.2.3', ref_name: 'v1.2.3', event_name: 'workflow_dispatch' }, inputs: { skip_release: true } },
  'release dispatch on a tag': { github: { ref_type: 'tag', ref: 'refs/tags/v1.2.3', ref_name: 'v1.2.3', event_name: 'workflow_dispatch' }, inputs: { skip_release: false } },
};
const VARS = [];
for (const windows of ['true', 'false']) {
  for (const macos of ['true', 'false']) {
    for (const provider of ['azure', 'sslcom']) {
      VARS.push({ ENABLE_WINDOWS_SIGNING: windows, ENABLE_MACOS_SIGNING: macos, WINDOWS_SIGNING_PROVIDER: provider });
    }
  }
}

const isTagRelease = ({ github, inputs }) => github.ref_type === 'tag'
  && github.ref.startsWith('refs/tags/v')
  && !(github.event_name === 'workflow_dispatch' && inputs.skip_release);

// classify-release as release.yml implements it: build-only runs are full;
// a tag release requires lineage success (else the job fails, no output).
function scenario(event, vars, failures, kind = 'full') {
  const base = EVENTS[event];
  return {
    ...base,
    vars,
    failures,
    outputs(name) {
      if (name === 'resolve-windows-signing-provider') return { provider: vars.WINDOWS_SIGNING_PROVIDER };
      if (name === 'validate-release-lineage') return { channel: 'mainline' };
      if (name === 'classify-release') return { release_kind: isTagRelease(base) ? kind : 'full', binaries_version: kind === 'server-only' ? '1.2.0' : '' };
      return {};
    },
    behaviour: {
      'classify-release': (results) => (isTagRelease(base) && results['validate-release-lineage'] !== 'success' ? 'failure' : 'success'),
      // .github/scripts/assert-windows-signing-convergence.mjs: exactly the
      // selected provider succeeded and the other was skipped.
      'sign-windows-tauri': (results) => {
        const azure = results['sign-windows-tauri-azure'];
        const sslcom = results['sign-windows-tauri-sslcom'];
        const converged = vars.WINDOWS_SIGNING_PROVIDER === 'azure'
          ? azure === 'success' && sslcom === 'skipped'
          : sslcom === 'success' && azure === 'skipped';
        return converged ? 'success' : 'failure';
      },
    },
  };
}

test('the job-graph snapshot is the pre-change graph and the current graph only adds jobs', () => {
  const added = Object.keys(currentGraph).filter((name) => !(name in BASELINE)).sort();
  assert.deepEqual(added, ['carry-forward-binaries', 'classify-release']);
  const removed = Object.keys(BASELINE).filter((name) => !(name in currentGraph));
  assert.deepEqual(removed, []);
  for (const [name, entry] of Object.entries(BASELINE)) {
    const extraNeeds = currentGraph[name].needs.filter((need) => !entry.needs.includes(need));
    const droppedNeeds = entry.needs.filter((need) => !currentGraph[name].needs.includes(need));
    assert.deepEqual(droppedNeeds, [], `${name} must keep every original need`);
    for (const need of extraNeeds) {
      assert.ok(
        ['classify-release', 'carry-forward-binaries'].includes(need)
          || (['release-integrity-gate', 'create-release'].includes(name) && BINARY_JOBS.includes(need)),
        `${name} gained an unexpected need: ${need}`,
      );
    }
  }
});

// Jobs that sign, notarize or publish. When lineage fails on a tag release,
// classify-release fails too (there is no release kind); the two graphs then
// differ only in unsigned build jobs the old graph ran for nothing — neither
// signs, notarizes, publishes or promotes anything.
const SIGNING_OR_PUBLISHING = [
  'build-macos-agent', 'build-macos-installer-app', 'build-viewer', 'build-viewer-macos', 'build-helper-macos',
  'sign-windows-tauri-azure', 'sign-windows-tauri-sslcom', 'package-windows-updater', 'build-binaries-image',
  'create-release', 'promote-signed-release-images',
];

for (const statusModel of ['transitive', 'direct']) {
  test(`full releases: every scenario yields the pre-change job results (${statusModel} status model)`, () => {
    let compared = 0;
    for (const event of Object.keys(EVENTS)) {
      for (const vars of VARS) {
        for (const failed of [null, ...Object.keys(BASELINE)]) {
          const failures = new Set(failed ? [failed] : []);
          const before = simulate(BASELINE, scenario(event, vars, failures), statusModel);
          const now = simulate(currentGraph, scenario(event, vars, failures), statusModel);
          if (now['classify-release'] !== 'success') {
            // Not a full release: lineage failed on a tag release.
            assert.equal(failed, 'validate-release-lineage', `classify-release failed unexpectedly under "${event}"`);
            for (const name of SIGNING_OR_PUBLISHING) {
              assert.equal(before[name], 'skipped', `${name} ran before the change with failed lineage?`);
              assert.equal(now[name], 'skipped', `${name} must not run when classification failed`);
            }
            continue;
          }
          for (const name of Object.keys(BASELINE)) {
            assert.equal(
              now[name],
              before[name],
              `${name} changed under "${event}" ${JSON.stringify(vars)} failure=${failed}: ${before[name]} -> ${now[name]}`,
            );
          }
          assert.equal(now['carry-forward-binaries'], 'skipped', 'carry-forward never runs for a full release');
          compared += 1;
        }
      }
    }
    assert.ok(compared > 1000, `scenario matrix too small (${compared})`);
  });

  test(`server-only release: every binary job skipped, server images + carry-forward + publisher run (${statusModel})`, () => {
    for (const vars of VARS) {
      const results = simulate(currentGraph, scenario('tag push', vars, new Set(), 'server-only'), statusModel);
      for (const name of BINARY_JOBS) assert.equal(results[name], 'skipped', `${name} must be skipped (${JSON.stringify(vars)})`);
      for (const name of [
        'validate-release-lineage', 'classify-release', 'carry-forward-binaries', 'build-api', 'build-web',
        'build-docker-api', 'build-docker-web', 'build-docker-portal', 'build-docker-m365-graph-read-executor',
        'build-docker-m365-graph-actions-executor', 'build-docker-m365-communications-executor',
        'release-integrity-gate', 'create-release', 'promote-signed-release-images',
      ]) {
        assert.equal(results[name], 'success', `${name} must run for a server-only release (${JSON.stringify(vars)})`);
      }
    }
  });

  test(`server-only release fails closed when carry-forward or classification fails (${statusModel})`, () => {
    const vars = VARS[0];
    const carryFailed = simulate(currentGraph, scenario('tag push', vars, new Set(['carry-forward-binaries']), 'server-only'), statusModel);
    assert.equal(carryFailed['create-release'], 'skipped');
    const classifyFailed = simulate(currentGraph, scenario('tag push', vars, new Set(['classify-release']), 'server-only'), statusModel);
    for (const name of [...BINARY_JOBS, 'carry-forward-binaries', 'create-release']) {
      assert.equal(classifyFailed[name], 'skipped', `${name} must not run when classification failed`);
    }
    const lineageFailed = simulate(currentGraph, scenario('tag push', vars, new Set(['validate-release-lineage']), 'server-only'), statusModel);
    assert.equal(lineageFailed['classify-release'], 'failure');
    assert.equal(lineageFailed['create-release'], 'skipped');
  });
}

// ── Manifest + asset contract: execute the real create-release scripts ───────
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitRepo(dir) {
  for (const args of [['init', '-q'], ['config', 'user.email', 'x@example.invalid'], ['config', 'user.name', 'x'], ['commit', '-q', '--allow-empty', '-m', 'x']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
}

function prepareAssets(kind) {
  const work = mkdtempSync(join(scratch, `prepare-${kind}-`));
  const commit = gitRepo(work);
  mkdirSync(join(work, 'artifacts', 'api-dist'), { recursive: true });
  mkdirSync(join(work, 'artifacts', 'web-dist'), { recursive: true });
  writeFileSync(join(work, 'artifacts', 'api-dist', 'index.js'), 'api\n');
  writeFileSync(join(work, 'artifacts', 'web-dist', 'index.html'), 'web\n');
  mkdirSync(join(work, 'artifacts', 'viewer-latest-json'), { recursive: true });
  writeFileSync(join(work, 'artifacts', 'viewer-latest-json', 'latest.json'), '{"version":"1.2.0"}\n');
  writeFileSync(join(work, 'release-images.json'), '[]\n');
  if (kind === 'full') {
    mkdirSync(join(work, 'artifacts', 'breeze-recovery-linux-amd64'), { recursive: true });
    writeFileSync(join(work, 'artifacts', 'breeze-recovery-linux-amd64', 'breeze-recovery-linux-amd64.iso'), 'iso\n');
    mkdirSync(join(work, 'artifacts', 'macos-pkg-attestation'), { recursive: true });
    writeFileSync(join(work, 'artifacts', 'macos-pkg-attestation', 'macos-pkg.tsv'), '');
  } else {
    const binaries = { name: 'binaries', repository: 'ghcr.io/lanternops/breeze/binaries', digest: `sha256:${'1'.repeat(64)}` };
    writeFileSync(join(work, 'release-images.json'), JSON.stringify([binaries]));
    writeFileSync(join(work, 'carried-images.json'), JSON.stringify([{ ...binaries, fromRelease: 'v1.2.0', fromSourceCommit: 'b'.repeat(40) }]));
  }
  const result = spawnSync('bash', ['-e', '-c', stepRun('create-release', 'Prepare release assets')], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'LanternOps/breeze',
      GITHUB_REF_NAME: 'v1.2.3',
      WINDOWS_SIGNING_PROVIDER_USED: '',
      RELEASE_KIND: kind,
      BINARIES_TAG: kind === 'server-only' ? 'v1.2.0' : '',
      BINARIES_SHA: kind === 'server-only' ? 'b'.repeat(40) : '',
    },
  });
  return { work, commit, result };
}

test('manifest: a full release differs from today only by "releaseKind": "full"', () => {
  const { work, commit, result } = prepareAssets('full');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifest = JSON.parse(readFileSync(join(work, 'release-assets', 'release-artifact-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['assets', 'images', 'release', 'releaseKind', 'repository', 'schemaVersion', 'sourceCommit']);
  assert.equal(manifest.releaseKind, 'full');
  assert.equal(manifest.sourceCommit, commit);
  const raw = readFileSync(join(work, 'release-assets', 'release-artifact-manifest.json'), 'utf8');
  assert.equal((raw.match(/^ {2}"sourceCommit":/gmu) ?? []).length, 1);
});

test('manifest: a full release still refuses to ship without the recovery ISO or pkg attestation', () => {
  for (const missing of ['artifacts/breeze-recovery-linux-amd64', 'artifacts/macos-pkg-attestation']) {
    const work = mkdtempSync(join(scratch, 'prepare-missing-'));
    gitRepo(work);
    for (const dir of ['artifacts/api-dist', 'artifacts/web-dist', 'artifacts/breeze-recovery-linux-amd64', 'artifacts/macos-pkg-attestation']) {
      mkdirSync(join(work, dir), { recursive: true });
    }
    writeFileSync(join(work, 'artifacts/breeze-recovery-linux-amd64/breeze-recovery-linux-amd64.iso'), 'iso\n');
    writeFileSync(join(work, 'artifacts/macos-pkg-attestation/macos-pkg.tsv'), '');
    writeFileSync(join(work, 'release-images.json'), '[]\n');
    rmSync(join(work, missing), { recursive: true, force: true });
    const result = spawnSync('bash', ['-e', '-c', stepRun('create-release', 'Prepare release assets')], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: 'LanternOps/breeze', GITHUB_REF_NAME: 'v1.2.3', WINDOWS_SIGNING_PROVIDER_USED: '', RELEASE_KIND: 'full' },
    });
    assert.notEqual(result.status, 0, `full release without ${missing} must fail`);
  }
  const unknown = spawnSync('bash', ['-e', '-c', stepRun('create-release', 'Prepare release assets')], {
    cwd: mkdtempSync(join(scratch, 'prepare-unknown-')),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_KIND: '' },
  });
  assert.notEqual(unknown.status, 0, 'an empty release kind must fail closed');
});

test('manifest: a server-only release records kind, pairing and carried images; the allowlist check passes', () => {
  const { work, result } = prepareAssets('server-only');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifestPath = join(work, 'release-assets', 'release-artifact-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.releaseKind, 'server-only');
  assert.equal(manifest.binariesRelease, 'v1.2.0');
  assert.equal(manifest.binariesSourceCommit, 'b'.repeat(40));
  assert.equal(manifest.carriedImages[0].fromRelease, 'v1.2.0');
  assert.deepEqual(manifest.assets.map((asset) => asset.name).sort(), ['breeze-api.tar.gz', 'breeze-web.tar.gz', 'latest.json']);

  // Base manifest for the latest.json byte-identity check.
  const latest = readFileSync(join(work, 'release-assets', 'latest.json'));
  const baseDir = join(work, 'server-only-base');
  mkdirSync(baseDir);
  writeFileSync(join(baseDir, 'identity.json'), JSON.stringify({
    assets: [{ name: 'latest.json', sha256: sha256(latest), size: latest.length }],
    images: [{ name: 'binaries', repository: 'ghcr.io/lanternops/breeze/binaries', digest: `sha256:${'1'.repeat(64)}` }],
  }));
  const verify = (extraEnv = {}) => spawnSync('bash', ['-e', '-c', stepRun('create-release', 'Verify server-only release assets')], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, BINARIES_TAG: 'v1.2.0', BINARIES_SHA: 'b'.repeat(40), RUNNER_TEMP: work, ...extraEnv },
  });
  const ok = verify();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  // Any binary asset, a wrong pairing, or a modified latest.json fails closed.
  const original = readFileSync(manifestPath, 'utf8');
  for (const [label, mutate] of [
    ['agent binary', (m) => m.assets.push({ name: 'breeze-agent-linux-amd64', sha256: '0'.repeat(64), size: 1 })],
    ['unsigned input', (m) => m.assets.push({ name: 'breeze-agent-windows-amd64-unsigned.exe', sha256: '0'.repeat(64), size: 1 })],
    ['installer', (m) => m.assets.push({ name: 'breeze-viewer-windows.msi', sha256: '0'.repeat(64), size: 1 })],
    ['recovery ISO', (m) => m.assets.push({ name: 'breeze-recovery-linux-amd64.iso', sha256: '0'.repeat(64), size: 1 })],
    ['unexpected asset', (m) => m.assets.push({ name: 'notes.txt', sha256: '0'.repeat(64), size: 1 })],
    ['wrong kind', (m) => { m.releaseKind = 'full'; }],
    ['wrong pairing', (m) => { m.binariesRelease = 'v1.1.0'; }],
    ['latest.json changed', (m) => { m.assets.find((a) => a.name === 'latest.json').sha256 = 'f'.repeat(64); }],
    ['carried digest mismatch', (m) => { m.carriedImages[0].digest = `sha256:${'2'.repeat(64)}`; }],
  ]) {
    const manifest2 = JSON.parse(original);
    mutate(manifest2);
    writeFileSync(manifestPath, JSON.stringify(manifest2));
    const refused = verify();
    assert.notEqual(refused.status, 0, `${label} must be refused`);
  }
  writeFileSync(manifestPath, original);
});

// ── release-promotion.yml ──────────────────────────────────────────────────
test('promotion revalidates the ledger row and the signed kind before publishing', () => {
  const text = readFileSync(PROMOTION_WORKFLOW, 'utf8');
  const revalidate = text.indexOf('- name: Revalidate server-only ledger row');
  const publish = text.indexOf('- name: Verify exact draft and publish');
  const lineage = text.indexOf('- name: Require mainline release lineage');
  assert.ok(lineage !== -1 && revalidate > lineage && publish > revalidate, 'revalidation runs after lineage and before publish');
  const step = text.slice(revalidate, publish);
  assert.match(step, /bash scripts\/release\/run-server-only-guard\.sh/u);
  assert.match(step, /--ledger-ref origin\/main/u);
  assert.match(step, /--main-ref origin\/main/u);
  assert.match(step, /--online/u);
  assert.match(step, /release-image-manifest\.mjs verify/u);
  assert.match(step, /RELEASE_MANIFEST_ED25519_PUBLIC_KEY/u);
  assert.match(step, /server-only.*not listed|not listed.*server-only/isu);
  assert.doesNotMatch(step, /\$\{\{ (?!secrets\.|github\.token|inputs\.tag|steps\.lineage\.outputs\.tag_sha)/u);
});

// ── ci.yml release-ledger job ──────────────────────────────────────────────
test('ci.yml runs the release-ledger job for every code change and CI Success requires it', () => {
  const ciText = readFileSync(CI_WORKFLOW, 'utf8');
  const jobs = new Map(workflowSecurity.workflowJobs(workflowSecurity.activeLines(ciText)).map((entry) => [entry.name, entry]));
  const ledger = jobs.get('release-ledger');
  assert.ok(ledger, 'ci.yml must define release-ledger');
  const text = ledger.lines.map((line) => line.content).join('\n');
  assert.match(text, /^ {4}needs: \[changes\]$/mu);
  assert.match(text, /^ {4}if: needs\.changes\.outputs\.code == 'true'$/mu, 'code-gated only: never api- or app-gated');
  assert.match(text, /fetch-depth: 0/u);
  assert.match(text, /fetch-tags: true/u);
  assert.match(text, /node --test scripts\/release\/\*\.test\.mjs/u);
  assert.match(text, /server-only-ledger\.mjs validate --ref HEAD/u);
  assert.match(text, /check-server-only-ledger-change\.sh/u);
  assert.match(text, /git merge-base HEAD origin\/main/u);
  const summary = jobs.get('ci-success').lines.map((line) => line.content).join('\n');
  assert.match(summary, /needs: \[[^\]]*\brelease-ledger\b/u);
  assert.match(summary, /RELEASE_LEDGER_RESULT: \$\{\{ needs\.release-ledger\.result \}\}/u);
  assert.match(summary, /\[\[ "\$\{RELEASE_LEDGER_RESULT\}" != "success" \]\]/u);
});
