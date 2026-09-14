import { describe, it, expect } from 'vitest';
import { MONITOR_KINDS, monitorConditionSchemas, type MonitorKind } from '@breeze/shared';
import { MONITOR_KIND_FIELDS, defaultConditionFor } from './monitorKindFields';

describe('monitorKindFields (#5289)', () => {
  it('has a field-map entry for every monitor kind', () => {
    for (const kind of MONITOR_KINDS) {
      expect(MONITOR_KIND_FIELDS[kind]).toBeDefined();
      expect(MONITOR_KIND_FIELDS[kind].length).toBeGreaterThan(0);
    }
  });

  it('every field key is a key of the kind\'s condition schema shape', () => {
    for (const kind of MONITOR_KINDS) {
      const shape = (monitorConditionSchemas[kind as MonitorKind] as { shape: Record<string, unknown> }).shape;
      for (const field of MONITOR_KIND_FIELDS[kind as MonitorKind]) {
        expect(Object.keys(shape)).toContain(field.key);
      }
    }
  });

  it('defaultConditionFor produces a value that validates against the kind schema', () => {
    for (const kind of MONITOR_KINDS) {
      const result = monitorConditionSchemas[kind as MonitorKind].safeParse(defaultConditionFor(kind as MonitorKind));
      expect({ kind, success: result.success, error: result.success ? undefined : result.error.message }).toEqual(
        expect.objectContaining({ success: true }),
      );
    }
  });
});
