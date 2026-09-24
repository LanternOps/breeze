import { describe, expect, it } from 'vitest';
import { readWorkflowSelection, writeWorkflowSelection } from './alertWorkflowFilter';

describe('alert workflow filter editing', () => {
  it('reads legacy scalar values and updates only the chosen dimension', () => {
    const stored = { severity: 'critical', ruleId: 'rule-a', 'device.tags': ['prod'] };
    expect(readWorkflowSelection(stored, 'severity')).toEqual(['critical']);
    expect(writeWorkflowSelection(stored, 'kind', ['cpu', 'memory'])).toEqual({
      ...stored, kind: ['cpu', 'memory'],
    });
    expect(stored).not.toHaveProperty('kind');
  });

  it('empty selection removes a restriction without deleting compatibility filters', () => {
    expect(writeWorkflowSelection({ severity: ['high'], ruleId: 'r' }, 'severity', []))
      .toEqual({ ruleId: 'r' });
    expect(readWorkflowSelection(undefined, 'kind')).toEqual([]);
  });
});
