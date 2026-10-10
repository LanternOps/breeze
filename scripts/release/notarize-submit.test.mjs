import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// notarize-submit.sh runs `xcrun notarytool submit … --wait`. A stub `xcrun`
// on PATH stands in for Apple: it prints $XCRUN_OUTPUT_FILE and exits XCRUN_STATUS
// for `notarytool submit`, and prints a marker for `notarytool log`. Output
// travels through a file, not the env var itself: Linux caps one env string at
// 128 KB, and the SIGPIPE regression needs output well past the pipe buffer.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'notarize-submit.sh');
const scratch = mkdtempSync(join(tmpdir(), 'notarize-submit-test-'));
const binDir = join(scratch, 'bin');
const artifact = join(scratch, 'breeze-agent.zip');

mkdirSync(binDir);
writeFileSync(artifact, 'synthetic artifact\n');
writeFileSync(
  join(binDir, 'xcrun'),
  `#!/usr/bin/env bash
if [ "$1 $2" = "notarytool log" ]; then
  echo "STUB-LOG for $3"
  exit 0
fi
cat "$XCRUN_OUTPUT_FILE"
exit "$XCRUN_STATUS"
`,
);
chmodSync(join(binDir, 'xcrun'), 0o755);
after(() => rmSync(scratch, { recursive: true, force: true }));

let outputSeq = 0;
function run({ output, status }) {
  const outputFile = join(scratch, `xcrun-output-${outputSeq++}.txt`);
  writeFileSync(outputFile, `${output}\n`);
  return spawnSync('bash', [SCRIPT, artifact], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      APPLE_ID: 'dev@example.com',
      APPLE_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'ABCDE12345',
      XCRUN_OUTPUT_FILE: outputFile,
      XCRUN_STATUS: String(status),
    },
  });
}

test('notarytool exiting non-zero: fails AND prints notarytool output (#7710)', () => {
  const message =
    'Error: HTTP status code: 403. A required agreement is missing or has expired.';
  const result = run({ output: message, status: 1 });
  assert.notEqual(result.status, 0, 'script must fail when notarytool exits non-zero');
  assert.ok(
    result.stdout.includes(message),
    `notarytool's error must reach stdout; got stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.match(result.stderr, /::error::notarytool exited 1/);
});

test('notarytool exits 0 but status is Invalid: fails closed and fetches the log', () => {
  const result = run({
    output: '  id: 1111-2222\n  status: Invalid\nProcessing complete',
    status: 0,
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes('status: Invalid'));
  assert.match(result.stderr, /status='Invalid' submission='1111-2222'/);
  assert.match(result.stderr, /STUB-LOG for 1111-2222/);
});

test('notarytool exits 0 with no status line: fails closed', () => {
  const result = run({ output: 'unexpected output', status: 0 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status=''/);
});

test('notarytool exits 0 with status Accepted: succeeds', () => {
  const result = run({
    output: '  id: 3333-4444\n  status: Accepted\nProcessing complete',
    status: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Notarization Accepted: breeze-agent\.zip \(submission 3333-4444\)/);
});

test('a large Accepted output does not trip SIGPIPE under pipefail', () => {
  // awk exits at the first match; when the rest of the output exceeds the pipe
  // buffer, the upstream writer used to die with SIGPIPE (141) under pipefail.
  const filler = 'x'.repeat(200).concat('\n').repeat(5000); // ~1 MB, far past the pipe buffer
  const result = run({
    output: `  id: 5555-6666\n  status: Accepted\n${filler}Processing complete`,
    status: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Notarization Accepted: breeze-agent\.zip \(submission 5555-6666\)/);
});
