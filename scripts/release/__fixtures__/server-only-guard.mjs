// Shared fixture-repo helpers for the server-only guard test files
// (check-server-only-eligibility*.test.mjs). Split across files only so
// `node --test` runs them in parallel.
//
// Every fixture copies the CURRENT scripts/release/ into the base commit, so
// the base tree carries a real guard — exactly what the first full release
// containing this machinery will look like.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_RELEASE_IMAGES } from '../release-image-manifest.mjs';

export const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BOOTSTRAP = join(HERE, 'run-server-only-guard.sh');
export const LEDGER_CHANGE = join(HERE, 'check-server-only-ledger-change.sh');
export const LEDGER = '.github/release-provenance/server-only-tags.tsv';
export const CANDIDATES = '.github/release-provenance/candidate-tags.tsv';
export const SIDE_BRANCH = '.github/release-provenance/side-branch-tags.tsv';
// The root .env.example carries the release-manifest trust anchor.
export const ENV_EXAMPLE = 'A=1\nRELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=base-key=\nAGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=false\n';
export const scratch = mkdtempSync(join(tmpdir(), 'server-only-guard-test-'));
let fixtureNumber = 0;
export const nextFixtureNumber = () => fixtureNumber++;
after(() => rmSync(scratch, { recursive: true, force: true }));

export function run(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', ...options });
}

function releaseScripts() {
  const files = {};
  for (const entry of readdirSync(HERE, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || name.endsWith('.test.mjs')) continue;
    files[`scripts/release/${name}`] = readFileSync(join(HERE, name));
  }
  return files;
}

export class Fixture {
  // scriptOverrides replaces files under scripts/release/ in the BASE tree (and
  // so, unchanged, in every later commit) — used to simulate a helper CLI that
  // silently does nothing.
  constructor({ baseHasGuard = true, scriptOverrides = {} } = {}) {
    this.repo = join(scratch, `repo-${nextFixtureNumber()}`);
    mkdirSync(this.repo, { recursive: true });
    this.git('init', '-q', '--initial-branch=main');
    this.git('config', 'user.name', 'Server Only Test');
    this.git('config', 'user.email', 'server-only@example.invalid');
    this.git('config', 'commit.gpgsign', 'false');
    this.git('config', 'tag.gpgsign', 'false');
    const common = {
      [LEDGER]: '# header\n',
      [CANDIDATES]: '# header\n',
      [SIDE_BRANCH]: '# header\n',
      'apps/api/src/app.ts': 'export const app = 1;\n',
      'agent/main.go': 'package main\n',
      '.env.example': ENV_EXAMPLE,
    };
    const scripts = { ...releaseScripts(), ...scriptOverrides };
    this.v117 = this.commit(baseHasGuard ? { ...common, ...scripts } : common, 'v0.117.0 tree');
    this.git('tag', 'v0.117.0');
    this.base = this.commit({ 'apps/api/src/app.ts': 'export const app = 2;\n' }, 'v0.118.0 tree');
    this.git('tag', 'v0.118.0');
  }

  git(...args) {
    const result = run(this.repo, 'git', args);
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  }

  commit(files, message = 'change') {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) {
        rmSync(join(this.repo, path), { force: true });
        continue;
      }
      mkdirSync(dirname(join(this.repo, path)), { recursive: true });
      writeFileSync(join(this.repo, path), contents);
    }
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  read(path) {
    return readFileSync(join(this.repo, path), 'utf8');
  }

  addRow(tag, commit, base = 'v0.118.0', note = 'test fix') {
    return this.commit({ [LEDGER]: `${this.read(LEDGER)}${tag}\t${commit}\t${base}\t${note}\n` }, `ledger ${tag}`);
  }

  guard(tag, commit, { ledgerRef = 'main', mainRef = 'main', extra = [], env = {} } = {}) {
    const report = join(this.repo, '..', `report-${nextFixtureNumber()}.json`);
    const result = run(this.repo, 'bash', [BOOTSTRAP,
      '--tag', tag,
      '--commit', commit,
      '--ledger-ref', ledgerRef,
      '--main-ref', mainRef,
      '--report', report,
      ...extra,
    ], { env: { ...process.env, ...env } });
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(report, 'utf8')); } catch { /* no report on refusal */ }
    return { ...result, report: parsed, output: `${result.stdout}\n${result.stderr}` };
  }
}

export function assertRefused(result, pattern) {
  assert.equal(result.status, 1, `expected a refusal (exit 1)\n${result.output}`);
  assert.match(result.output, pattern);
  assert.equal(result.report, null, 'a refused run must not write an eligibility report');
}

export function assertEligible(result) {
  assert.equal(result.status, 0, result.output);
  assert.ok(result.report, 'eligible run must write a report');
}

// ── --online: the base must be a published, signed full release ────────────
export function onlineStub(fx, { draft = false, prerelease = false, releaseKind, sourceCommit } = {}) {
  const stub = mkdtempSync(join(scratch, 'gh-stub-'));
  const bin = join(stub, 'bin');
  const assets = join(stub, 'assets', 'v0.118.0');
  mkdirSync(bin, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = {
    assets: [],
    images: REQUIRED_RELEASE_IMAGES.map((name, index) => ({
      digest: `sha256:${String((index + 1) % 10).repeat(64)}`,
      name,
      repository: `ghcr.io/lanternops/breeze/${name}`,
    })),
    release: 'v0.118.0',
    repository: 'LanternOps/breeze',
    schemaVersion: 1,
    sourceCommit: sourceCommit ?? fx.base,
  };
  if (releaseKind) manifest.releaseKind = releaseKind;
  if (releaseKind === 'server-only') {
    manifest.binariesRelease = 'v0.117.0';
    manifest.binariesSourceCommit = fx.v117;
    const binaries = manifest.images.find((image) => image.name === 'binaries');
    manifest.carriedImages = [{ ...binaries, fromRelease: 'v0.117.0', fromSourceCommit: fx.v117 }];
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(assets, 'release-artifact-manifest.json'), bytes);
  writeFileSync(join(assets, 'release-artifact-manifest.json.ed25519'), `${sign(null, bytes, privateKey).toString('base64')}\n`);
  writeFileSync(join(stub, 'view.json'), JSON.stringify({ isDraft: draft, isPrerelease: prerelease }));
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "release view" || "$1 $2" == "release download" ]] || { echo "unexpected gh $*" >&2; exit 9; }
mode="$2"; tag="$3"; shift 3
dir=""; patterns=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [[ "$2" == "LanternOps/breeze" ]] || { echo "wrong repo $2" >&2; exit 9; }; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --pattern) patterns+=("$2"); shift 2 ;;
    --json) shift 2 ;;
    *) echo "unexpected arg $1" >&2; exit 9 ;;
  esac
done
if [ "$mode" = view ]; then cat "${stub}/view.json"; exit 0; fi
for p in "\${patterns[@]}"; do cp "${stub}/assets/$tag/$p" "$dir/"; done
`);
  chmodSync(gh, 0o755);
  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    },
    extra: ['--online', '--expected-repository', 'LanternOps/breeze'],
  };
}

export function onlineFixture() {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit);
  return { fx, commit };
}

// ── PR CI: ledger-change check (append-only + guard on new rows) ────────────
export function ledgerChange(fx, baseRef, headRef = 'main', { script = LEDGER_CHANGE } = {}) {
  const summary = join(scratch, `summary-${nextFixtureNumber()}.md`);
  writeFileSync(summary, '');
  const result = run(fx.repo, 'bash', [script, '--base-ref', baseRef, '--head-ref', headRef, '--main-ref', 'main'],
    { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { ...result, summary: readFileSync(summary, 'utf8'), output: `${result.stdout}\n${result.stderr}` };
}

// ── Helper CLIs that silently do nothing ────────────────────────────────────
// What a helper looks like when its invokedAsCli() check misses: it loads,
// prints nothing and exits 0.
export const SILENT_CLI = '// simulated: the CLI entry point never ran\nexport {};\n';

// A path-policy CLI that runs but never reports a match (a broken matcher that
// still prints a plausible trailer).
export const NEVER_MATCHES_CLI = `import { readFileSync } from 'node:fs';
const text = readFileSync(0, 'utf8');
const count = text.split(text.includes('\\0') ? '\\0' : '\\n').filter(Boolean).length;
process.stderr.write(\`# matched=0 of \${count}\\n\`);
`;

// The real path-policy CLI with its stderr (and so its trailer) swallowed:
// correct matches, but no proof that it processed the whole change set.
export const PATH_CLI_WITHOUT_TRAILER = {
  'scripts/release/release-path-policy.mjs': `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const real = fileURLToPath(new URL('./release-path-policy.real.mjs', import.meta.url));
const result = spawnSync(process.execPath, [real, ...process.argv.slice(2)], {
  input: readFileSync(0),
  stdio: ['pipe', 'inherit', 'ignore'],
});
process.exit(result.status ?? 1);
`,
  'scripts/release/release-path-policy.real.mjs': readFileSync(join(HERE, 'release-path-policy.mjs')),
};

// The real ledger CLI, except that one subcommand silently does nothing.
export function ledgerCliSilentOn(command) {
  return {
    'scripts/release/server-only-ledger.mjs': `import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(command)}) process.exit(0);
const real = fileURLToPath(new URL('./server-only-ledger.real.mjs', import.meta.url));
const result = spawnSync(process.execPath, [real, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    'scripts/release/server-only-ledger.real.mjs': readFileSync(join(HERE, 'server-only-ledger.mjs')),
  };
}
