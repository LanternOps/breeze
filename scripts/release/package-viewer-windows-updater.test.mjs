import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// The Windows viewer auto-update bundle (#7681). tauri-plugin-updater builds its
// Windows extractor on the `zip` crate with default-features = false — no
// Deflate decoder — so a deflated bundle downloads and signature-verifies, then
// fails to unpack ("unsupported Zip archive: Compression method not supported")
// and every installed Windows viewer is stuck on its version.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'package-viewer-windows-updater.sh');
const RELEASE_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const MSI_NAME = 'breeze-viewer-windows.msi';

const scratch = mkdtempSync(join(tmpdir(), 'viewer-windows-updater-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Highly compressible on purpose: Info-ZIP keeps an entry stored when Deflate
// would not shrink it, so random bytes would hide a missing `-0`.
const msiBytes = Buffer.from('MSI fixture payload. '.repeat(4096));

function fixtureDir(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(dir, { msi = join(dir, MSI_NAME), out = join(dir, `${MSI_NAME}.zip`), env = {} } = {}) {
  return spawnSync('bash', [SCRIPT, msi, out], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Parse the local file headers of a zip: [{ name, method, data }]. */
function localEntries(zip) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      name: zip.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      method,
      data: zip.subarray(dataStart, dataStart + compressedSize),
    });
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('packs the MSI as a single STORED entry the updater can extract', () => {
  const dir = fixtureDir('stored');
  writeFileSync(join(dir, MSI_NAME), msiBytes);

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const entries = localEntries(readFileSync(join(dir, `${MSI_NAME}.zip`)));
  assert.equal(entries.length, 1, 'exactly one entry (the updater runs the first .msi it finds)');
  assert.equal(entries[0].name, MSI_NAME, 'entry is the MSI at the archive root (no directory prefix)');
  assert.equal(entries[0].method, 0, 'compression method must be 0 (stored), not 8 (deflate)');
  assert.ok(entries[0].data.equals(msiBytes), 'stored entry bytes are the MSI verbatim');
});

test('fails closed when a zip that compresses slips through', () => {
  // Simulates the regression: a `zip` that ignores -0 (the pre-#7681 command).
  const dir = fixtureDir('regressed');
  writeFileSync(join(dir, MSI_NAME), msiBytes);
  const realZip = spawnSync('bash', ['-c', 'command -v zip'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realZip, 'zip must be installed to run this test');
  const shimDir = fixtureDir('regressed-bin');
  const shim = join(shimDir, 'zip');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [ "$a" = "-0" ] || args+=("$a"); done\nexec "${realZip}" "\${args[@]}"\n`,
  );
  chmodSync(shim, 0o755);

  const result = run(dir, { env: { PATH: `${shimDir}:${process.env.PATH}` } });
  assert.notEqual(result.status, 0, 'a deflated bundle must fail the release job');
  assert.match(result.stderr, /not stored/i);
});

test('refuses a missing or empty MSI', () => {
  const dir = fixtureDir('empty');
  writeFileSync(join(dir, MSI_NAME), '');
  assert.notEqual(run(dir).status, 0, 'empty MSI');
  assert.notEqual(run(dir, { msi: join(dir, 'absent.msi') }).status, 0, 'missing MSI');
});

test('release.yml builds the Windows updater bundle through this script', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');
  // The job that zips and minisigns the bundle, up to the next job.
  const start = workflow.indexOf('\n  package-windows-updater:\n');
  assert.notEqual(start, -1, 'package-windows-updater job not found');
  const next = workflow.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  const job = next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);

  // Invoked with the signed MSI in and the bundle that gets minisigned out
  // (not just mentioned in a comment).
  assert.match(
    job,
    /^\s*bash scripts\/release\/package-viewer-windows-updater\.sh \\\n\s*staging\/breeze-viewer-windows\.msi \\\n\s*staging\/breeze-viewer-windows\.msi\.zip\s*$/m,
  );
  assert.match(job, /tauri signer sign .*staging\/breeze-viewer-windows\.msi\.zip/);
  // Nothing else in the job archives the MSI itself.
  assert.doesNotMatch(job, /^\s*(zip|7z|python3? -m zipfile)\s/m);
  // And no other job builds the bundle with a compressing `zip`.
  assert.doesNotMatch(workflow, /^\s*zip\b.*breeze-viewer-windows\.msi\.zip/m);
});
