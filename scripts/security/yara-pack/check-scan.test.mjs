import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScan as check } from './check-scan.mjs';

const checkScan = (text, exit, min) => check(text, exit, min, 0.02);

const summary = (o = {}) =>
  JSON.stringify({ filesScanned: 5000, filesFailed: 3, matches: 0, compileMs: 1, durationMs: 1, workers: 2, peakGoSysMb: 1, peakRssMb: 1, engine: 'yara', ...o });

test('clean run passes', () => {
  assert.equal(checkScan(summary() + '\n', 0, 1000).ok, true);
});

test('a match fails and names the rule and file', () => {
  const m = JSON.stringify({ path: '/usr/bin/x', ruleSetId: 's', ruleName: 'DITEKSHEN_Foo', ruleId: 'r', severity: 'high', type: 'malware' });
  const res = checkScan(`${m}\n${summary({ matches: 1 })}\n`, 0, 1000);
  assert.equal(res.ok, false);
  assert.match(res.failures.join('\n'), /DITEKSHEN_Foo matched \/usr\/bin\/x/);
});

test('agent log lines on stdout are ignored', () => {
  const log = 'time=2026-10-18T03:25:29.564-06:00 level=WARN msg="IOC scan could not scan a file" component=security path=/usr/bin/sudo';
  assert.equal(checkScan(`${log}\n${summary()}\n`, 0, 1000).ok, true);
});

test('too few files scanned fails (no vacuous pass)', () => {
  assert.equal(checkScan(summary({ filesScanned: 10 }), 0, 1000).ok, false);
});

test('missing summary fails', () => {
  assert.equal(checkScan('', 0, 1).ok, false);
});

test('each failure mode fails on its own', () => {
  assert.equal(checkScan(summary({ error: 'boom' }), 0, 1).ok, false, 'summary error with exit 0');
  assert.equal(checkScan(summary(), 2, 1).ok, false, 'clean summary, non-zero exit');
  assert.equal(checkScan(summary({ engine: 'legacy' }), 0, 1).ok, false, 'legacy engine');
  assert.equal(checkScan(`not json\n${summary()}`, 0, 1).ok, false, 'garbage line');
});

test('too many unscannable files fails; a few is fine; a missing count fails', () => {
  assert.equal(check(summary({ filesScanned: 980, filesFailed: 20 }), 0, 1, 0.02).ok, true, '2.0% at a 2% ceiling');
  const res = check(summary({ filesScanned: 900, filesFailed: 100 }), 0, 1, 0.02);
  assert.equal(res.ok, false);
  assert.match(res.failures.join('\n'), /100 of 1000 files could not be scanned/);
  assert.equal(check(summary({ filesFailed: undefined }), 0, 1, 0.02).ok, false);
});

test('the CLI refuses a zero floor or a missing/invalid ratio (a guard that cannot fail is not a guard)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const f = join(mkdtempSync(join(tmpdir(), 'check-scan-')), 'scan.jsonl');
  writeFileSync(f, summary() + '\n');
  const run = (...args) => spawnSync(process.execPath, [join(here, 'check-scan.mjs'), f, '0', ...args], { encoding: 'utf8' });
  assert.equal(run('1000', '0.02').status, 0);
  assert.equal(run('0', '0.02').status, 2);
  assert.equal(run('1000').status, 2);
  assert.equal(run('1000', '1').status, 2);
});

test('summary/match count disagreement fails', () => {
  assert.equal(checkScan(summary({ matches: 2 }), 0, 1).ok, false);
});
