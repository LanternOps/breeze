import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildYaraBundleJson } from './yaraBundle';
import { YARA_BUNDLE_FORMAT, YARA_BUNDLE_FORMAT_VERSION } from '../types/yara';

// The W02 §C2 contract in executable form, owned by the agent package.
const fixtureDir = resolve(__dirname, '../../../../agent/internal/yarascan/testdata');

describe('buildYaraBundleJson (W02 §C2)', () => {
  it('reproduces the W02 golden bundle byte for byte', () => {
    const golden = readFileSync(resolve(fixtureDir, 'bundle-v1.golden.json'));
    const sum = readFileSync(resolve(fixtureDir, 'bundle-v1.golden.json.sha256'), 'utf8').trim();
    const json = buildYaraBundleJson({
      ruleSetId: '00000000-0000-4000-8000-000000000001',
      version: 3,
      autoQuarantine: false,
      rules: [{
        id: '00000000-0000-4000-8000-0000000000a1',
        name: 'fixture_marker',
        severity: 'high',
        source: 'rule fixture_marker : fixture { meta: threat_type = "pup" strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }',
      }],
    });
    expect(Buffer.from(json, 'utf8').equals(golden)).toBe(true);
    expect(createHash('sha256').update(json, 'utf8').digest('hex')).toBe(sum);
  });

  it('sorts rules by id regardless of input order', () => {
    const json = buildYaraBundleJson({
      ruleSetId: 's', version: 1, autoQuarantine: false, rules: [
        { id: 'b', name: 'rb', severity: 'low', source: 'rule rb { condition: true }' },
        { id: 'a', name: 'ra', severity: 'low', source: 'rule ra { condition: true }' },
      ],
    });
    expect(json.indexOf('"id":"a"')).toBeLessThan(json.indexOf('"id":"b"'));
  });

  it('uses code-unit order (not locale order) so it matches the agent', () => {
    // localeCompare would put 'a' before 'B'; the agent sorts by byte value.
    const json = buildYaraBundleJson({
      ruleSetId: 's', version: 1, autoQuarantine: false, rules: [
        { id: 'a', name: 'ra', severity: 'low', source: 'rule ra { condition: true }' },
        { id: 'B', name: 'rb', severity: 'low', source: 'rule rb { condition: true }' },
      ],
    });
    expect(json.indexOf('"id":"B"')).toBeLessThan(json.indexOf('"id":"a"'));
  });

  it('emits keys in contract order and drops anything extra on a rule', () => {
    const json = buildYaraBundleJson({
      ruleSetId: 'S', version: 4, autoQuarantine: true,
      rules: [{ id: 'r', name: 'n', severity: 'critical', source: 'rule n { condition: true }', extra: 'x' } as never],
    });
    expect(json).toBe(
      `{"format":"${YARA_BUNDLE_FORMAT}","v":${YARA_BUNDLE_FORMAT_VERSION},"ruleSetId":"S","version":4,"autoQuarantine":true,` +
        '"rules":[{"id":"r","name":"n","severity":"critical","source":"rule n { condition: true }"}]}',
    );
  });

  it('an empty set is a valid bundle with an empty rules array', () => {
    expect(buildYaraBundleJson({ ruleSetId: 'S', version: 1, autoQuarantine: false, rules: [] }))
      .toMatch(/"rules":\[\]\}$/);
  });

  it('does not mutate the caller\'s rules array', () => {
    const rules = [
      { id: 'b', name: 'rb', severity: 'low' as const, source: 'x' },
      { id: 'a', name: 'ra', severity: 'low' as const, source: 'y' },
    ];
    buildYaraBundleJson({ ruleSetId: 's', version: 1, autoQuarantine: false, rules });
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
