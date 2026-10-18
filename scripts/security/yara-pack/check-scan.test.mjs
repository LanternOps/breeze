import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScan } from './check-scan.mjs';

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

test('scan error, non-zero exit, legacy engine and garbage output fail', () => {
  assert.equal(checkScan(summary({ error: 'boom' }), 2, 1).ok, false);
  assert.equal(checkScan(summary(), 2, 1).ok, false);
  assert.equal(checkScan(summary({ engine: 'legacy' }), 0, 1).ok, false);
  assert.equal(checkScan(`not json\n${summary()}`, 0, 1).ok, false);
});

test('summary/match count disagreement fails', () => {
  assert.equal(checkScan(summary({ matches: 2 }), 0, 1).ok, false);
});
