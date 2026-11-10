// The Linux viewer build reports whether the WebKitGTK it is about to bundle
// has WebRTC (#9557). The report must never fail a release build: a missing
// WebRTC is a known packaging gap, and a broken probe is not worth a release.
// What it must do is say which of the three cases happened.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'report-viewer-linux-webrtc.sh');
const scratch = mkdtempSync(join(tmpdir(), 'report-viewer-linux-webrtc-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function report(probeExit, probeOutput = '') {
  const probe = join(scratch, `probe-${probeExit}.sh`);
  writeFileSync(probe, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(probeOutput)}\nexit ${probeExit}\n`);
  chmodSync(probe, 0o755);
  const summary = join(scratch, `summary-${probeExit}.md`);
  writeFileSync(summary, '');
  const result = spawnSync('bash', [SCRIPT, probe], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { ...result, summary: readFileSync(summary, 'utf8') };
}

test('WebRTC present: a notice, no warning', () => {
  const r = report(0, 'webkitgtk 2.99.0: typeof RTCPeerConnection = function');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::notice::.*has WebRTC/mu);
  assert.doesNotMatch(r.stdout, /::(warning|error)::/u);
  assert.match(r.summary, /has WebRTC/u);
});

test('WebRTC absent: a warning that names the consequence, and the build goes on', () => {
  const r = report(3, 'webkitgtk 2.50.4: typeof RTCPeerConnection = undefined');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::warning::.*without WebRTC/mu);
  assert.match(r.stdout, /service/u);
  assert.doesNotMatch(r.stdout, /::(notice|error)::/u);
  assert.match(r.summary, /without WebRTC/u);
  // The probe's own line is kept so the WebKitGTK version is on record.
  assert.match(r.stdout, /webkitgtk 2\.50\.4/u);
});

test('probe broke: an error annotation that does not claim either answer, and the build goes on', () => {
  for (const code of [1, 4, 127]) {
    const r = report(code, 'Traceback (most recent call last)');
    assert.equal(r.status, 0, `exit ${code}`);
    assert.match(r.stdout, new RegExp(`^::error::.*could not be determined.*exit ${code}`, 'mu'));
    assert.doesNotMatch(r.stdout, /::(notice|warning)::/u);
    assert.doesNotMatch(r.stdout + r.summary, /has WebRTC|without WebRTC/u);
  }
});

test('release.yml runs the report in the Linux viewer leg only', () => {
  const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const start = text.indexOf('\n  build-viewer:\n');
  const job = text.slice(start, text.indexOf('\n  build-helper:\n', start));
  const step = job.split(/\n {6}- name: /u).find((s) => s.includes('report-viewer-linux-webrtc.sh'));
  assert.ok(step, 'build-viewer has no step calling report-viewer-linux-webrtc.sh');
  assert.match(step, /if: matrix\.platform == 'ubuntu-22\.04'/u);
  assert.match(step, /probe-webkitgtk-webrtc\.py/u);
  // Before the build, so the answer is in the log even when the build fails.
  assert.ok(job.indexOf('report-viewer-linux-webrtc.sh') < job.indexOf('- name: Build Tauri app'));
});
