import { describe, expect, it } from 'vitest';
import { legacySelectedMonitorRefs } from './monitorProposalCompatibility';

describe('historical Fleet Design approvals', () => {
  const section = [{ functionKey: 'file_server', alertRules: [
    { name: 'Old CPU', conditions: [{ type: 'metric' }] },
    { name: 'New CPU', kind: 'cpu', condition: { operator: 'gt', value: 80 } },
  ] }];

  it('blocks only selected legacy proposals and preserves stable identities', () => {
    expect(legacySelectedMonitorRefs(section, ['monitoring:file_server:rule:0']))
      .toEqual(['monitoring:file_server:rule:0']);
    expect(legacySelectedMonitorRefs(section, ['monitoring:file_server:rule:1'])).toEqual([]);
    expect(legacySelectedMonitorRefs(section, [])).toEqual([]);
  });

  it('treats a rule with a kind but no condition object as legacy', () => {
    const odd = [{ functionKey: 'f', alertRules: [{ name: 'x', kind: 'cpu', condition: null }] }];
    expect(legacySelectedMonitorRefs(odd, ['monitoring:f:rule:0'])).toEqual(['monitoring:f:rule:0']);
  });
});
