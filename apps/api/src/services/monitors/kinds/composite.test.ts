import { describe, expect, it } from 'vitest';
import { compositeKind } from './composite';
import { applyOverrides, MONITOR_KIND_SPECS } from './index';

const CTX = { monitorId: '00000000-0000-4000-8000-000000000001' };

describe('composite kind (W05c1, spec C8)', () => {
  it('is registered, server-evaluated and has no overridable keys', () => {
    expect(MONITOR_KIND_SPECS.composite).toBe(compositeKind);
    expect(compositeKind.agentDelivered).toBe(false);
    expect(compositeKind.overridableKeys).toEqual([]);
  });

  it('compiles match=all to an and-group of the children compiled by their own specs', () => {
    const compiled = compositeKind.toAlertCondition(
      compositeKind.conditionSchema.parse({
        match: 'all',
        children: [
          { kind: 'cpu', condition: { operator: 'gt', value: 90, durationMinutes: 10 } },
          { kind: 'memory', condition: { operator: 'gte', value: 85 } },
        ],
      }),
      CTX,
    );
    expect(compiled).toEqual({
      logic: 'and',
      conditions: [
        { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90, durationMinutes: 10 },
        { type: 'threshold', metric: 'ramPercent', operator: 'gte', value: 85 },
      ],
    });
  });

  it('compiles match=any to an or-group', () => {
    const compiled = compositeKind.toAlertCondition(
      compositeKind.conditionSchema.parse({
        match: 'any',
        children: [
          { kind: 'disk', condition: { operator: 'gt', value: 95 } },
          { kind: 'offline', condition: { durationMinutes: 5 } },
        ],
      }),
      CTX,
    );
    expect(compiled).toMatchObject({ logic: 'or' });
    expect((compiled as { conditions: unknown[] }).conditions).toHaveLength(2);
  });

  it('applyOverrides on a composite returns the condition unchanged (the sweep override path replaces the root wholesale)', () => {
    const condition = compositeKind.conditionSchema.parse({
      match: 'all',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
        { kind: 'memory', condition: { operator: 'gt', value: 90 } },
      ],
    });
    expect(applyOverrides(compositeKind, condition, { match: 'any', children: [], value: 1 })).toEqual(condition);
  });
});
