import { describe, it, expect } from 'vitest';
import { partitionGroupsByExecutionFieldProvenance, warningsForRefusedExecutionGroups } from './executionTargetGating';

describe('partitionGroupsByExecutionFieldProvenance (denylist option)', () => {
  it('splits groups into allowed vs refused by their stored filterFieldsUsed', () => {
    const result = partitionGroupsByExecutionFieldProvenance([
      { id: 'g1', filterFieldsUsed: ['hostname'] },
      { id: 'g2', filterFieldsUsed: ['osType', 'metrics.diskPercent'] },
      { id: 'g3', filterFieldsUsed: null },
      { id: 'g4', filterFieldsUsed: ['custom.approved'] },
    ]);

    expect(result.allowedGroupIds).toEqual(['g2', 'g3']);
    expect(result.refusedGroups).toEqual([
      { id: 'g1', refusedFields: ['hostname'] },
      { id: 'g4', refusedFields: ['custom.approved'] },
    ]);
  });

  it('keeps the documented canonical example group allowed', () => {
    const result = partitionGroupsByExecutionFieldProvenance([
      { id: 'servers-90-disk', filterFieldsUsed: ['osType', 'metrics.diskPercent'] },
    ]);
    expect(result.allowedGroupIds).toEqual(['servers-90-disk']);
    expect(result.refusedGroups).toEqual([]);
  });
});

describe('warningsForRefusedExecutionGroups', () => {
  it('produces one human-readable warning per refused group naming its refused fields', () => {
    const warnings = warningsForRefusedExecutionGroups([
      { id: 'g1', refusedFields: ['hostname', 'tags'] },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('g1');
    expect(warnings[0]).toContain('hostname');
    expect(warnings[0]).toContain('tags');
  });

  it('returns an empty array for no refused groups', () => {
    expect(warningsForRefusedExecutionGroups([])).toEqual([]);
  });
});
