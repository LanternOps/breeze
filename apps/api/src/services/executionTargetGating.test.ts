import { describe, it, expect, vi } from 'vitest';

const { whereMock } = vi.hoisted(() => ({ whereMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
}));
import {
  resolveExecutionSafeGroupIds,
  inlineFilterHasExecutionRefusedFields,
  partitionGroupsByExecutionFieldProvenance,
  warningsForRefusedExecutionGroups,
} from './executionTargetGating';

describe('log-shipping health filter as an execution target (#8611)', () => {
  it('refuses a dynamic group keyed on logShippingFailing', () => {
    const result = partitionGroupsByExecutionFieldProvenance([
      { id: 'ls', filterFieldsUsed: ['logShippingFailing', 'osType'] },
    ]);
    expect(result.allowedGroupIds).toEqual([]);
    expect(result.refusedGroups).toEqual([{ id: 'ls', refusedFields: ['logShippingFailing'] }]);
  });

  it('refuses an inline filter (script / automation target) keyed on logShippingFailing', () => {
    expect(
      inlineFilterHasExecutionRefusedFields({
        operator: 'AND',
        conditions: [{ field: 'logShippingFailing', operator: 'equals', value: 'yes' }],
      }),
    ).toEqual(['logShippingFailing']);
  });
});

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

describe('execution target visibility (#10521 W1)', () => {
  it("returns an id with no visible row as refused with refusedFields ['unresolvable']", async () => {
    whereMock.mockResolvedValueOnce([
      { id: 'safe', filterFieldsUsed: ['osType'] },
      { id: 'unsafe', filterFieldsUsed: ['hostname'] },
    ]);
    const result = await resolveExecutionSafeGroupIds(['missing', 'safe', 'missing', 'unsafe', 'safe']);
    expect(result.allowedGroupIds).toEqual(['safe']);
    expect(result.refusedGroups).toEqual([
      { id: 'unsafe', refusedFields: ['hostname'] },
      { id: 'missing', refusedFields: ['unresolvable'] },
    ]);
  });

  it('words the unresolvable warning without naming agent-reported fields', () => {
    const warnings = warningsForRefusedExecutionGroups([{ id: 'missing', refusedFields: ['unresolvable'] }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing');
    expect(warnings[0]).toContain('could not be resolved (it no longer exists or is not visible here)');
    expect(warnings[0]).not.toContain('agent-reported');
  });
});
