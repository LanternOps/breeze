// Self-test for scripts/security/check-agent-binary-signatures.sh (#2797):
// proves the guard actually fails on planted threat-signature bytes and
// passes clean inputs, so a broken scan cannot rot into a vacuous green.
//
// Every banned token in this file is assembled at RUNTIME from fragment
// arrays. The guard's --source mode only scans agent/ Go source (not .mjs),
// but repo-wide secret/AV scanners grep raw source text, so the tokens must
// never appear contiguously here either. Do not join the fragments into
// literals.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'security', 'check-agent-binary-signatures.sh');

// --- banned needles, assembled at runtime (see header comment) --------------

const frag = (parts) => parts.join('');

// The full 68-byte AV test-file payload: prefix + name token + suffix.
const avName = frag(['EIC', 'AR-STANDARD-', 'ANTIVIRUS-TEST-', 'FILE']);
const avPayload = frag(['X5O!P%@AP[4\\', 'PZX54(P^)7CC)7}$', avName, '!$H+H*']);
const credTool = frag(['mimi', 'katz']);
const trojan = frag(['emo', 'tet']);

// Deterministic "clean" filler: consecutive byte values can never spell an
// ASCII token (each byte differs from its neighbor by 1), and determinism
// beats random bytes that could — with tiny probability — spell one.
const cleanBytes = (len) => Buffer.from(Array.from({ length: len }, (_, i) => i % 251));

const tmp = mkdtempSync(join(tmpdir(), 'agent-sig-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let fileNo = 0;
const binFile = (content) => {
  const path = join(tmp, `bin-${fileNo++}`);
  writeFileSync(path, content);
  return path;
};

const run = (...args) =>
  spawnSync('bash', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

// --- cases ------------------------------------------------------------------

test('binary containing the full 68-byte AV payload fails the scan', () => {
  assert.equal(avPayload.length, 68, 'payload must be exactly 68 bytes');
  const path = binFile(
    Buffer.concat([cleanBytes(512), Buffer.from(avPayload, 'latin1'), cleanBytes(512)]),
  );
  const res = run(path);
  assert.equal(res.status, 1, `expected exit 1\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /AV test-file payload/);
});

test('binary with one tool token embedded in clean bytes fails the scan', () => {
  const path = binFile(
    Buffer.concat([cleanBytes(256), Buffer.from(credTool), cleanBytes(256)]),
  );
  const res = run(path);
  assert.equal(res.status, 1, `expected exit 1\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /banned tool token/);
});

test('regression: a planted trojan token directly after alphanumeric bytes still fails', () => {
  // Reviewer repro: rodata packs strings with no delimiters, so a real token
  // can sit right after an alphanumeric byte. The old [^[:alnum:]_] anchor
  // missed this; the [^rR] anchor must catch it.
  const path = binFile(Buffer.from(frag(['somestring', trojan, 'more'])));
  const res = run(path);
  assert.equal(res.status, 1, `expected exit 1\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /banned tool token/);
});

test('the remote-T… identifier family does not false-positive the trojan token', () => {
  // These camelCase identifiers survive into binaries (string literals +
  // pclntab); the token inside them is always preceded by r/R, which the
  // anchor excludes.
  const path = binFile(
    Buffer.concat([
      cleanBytes(64),
      Buffer.from(frag(['remote', 'Type']) + ' ' + frag(['Remote', 'TimeStamp'])),
      cleanBytes(64),
    ]),
  );
  const res = run(path);
  assert.equal(res.status, 0, `expected exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
});

test('clean binary passes with exit 0', () => {
  const res = run(binFile(cleanBytes(4096)));
  assert.equal(res.status, 0, `expected exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

test('no arguments fails with usage error', () => {
  const res = run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage/);
});

test('a missing binary path fails rather than passing vacuously', () => {
  const res = run(join(tmp, 'does-not-exist'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /binary not found/);
});

test('--source mode passes against the real tree', () => {
  const res = run('--source');
  assert.equal(res.status, 0, `expected exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});
