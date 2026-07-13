import { describe, expect, it } from 'vitest';
import {
  mappingToRows,
  rowsToMapping,
  scriptSchema,
  SUPPRESS_SEVERITY,
  type ExitCodeSeverityMapping,
  type ExitCodeSeverityRow,
} from './ScriptFormSchema';

describe('rowsToMapping / mappingToRows', () => {
  it('round-trips a suppress entry through both helpers', () => {
    const rows: ExitCodeSeverityRow[] = [
      { exitCode: '0', severity: SUPPRESS_SEVERITY },
      { exitCode: '1', severity: 'high' },
    ];
    const wire = rowsToMapping(rows);
    expect(wire).toEqual({ '0': null, '1': 'high' });
    expect(mappingToRows(wire)).toEqual(rows);
  });

  it('emits null on the wire for suppress entries', () => {
    const wire = rowsToMapping([{ exitCode: '0', severity: SUPPRESS_SEVERITY }]);
    expect(wire).toEqual({ '0': null });
  });

  it('preserves null entries when loading from the wire', () => {
    const wire: ExitCodeSeverityMapping = { '0': null, '2': 'critical' };
    const rows = mappingToRows(wire);
    expect(rows).toEqual([
      { exitCode: '0', severity: SUPPRESS_SEVERITY },
      { exitCode: '2', severity: 'critical' },
    ]);
  });

  it('returns undefined when given no rows', () => {
    expect(rowsToMapping(undefined)).toBeUndefined();
    expect(rowsToMapping([])).toBeUndefined();
  });

  it('returns an empty array when given no mapping', () => {
    expect(mappingToRows(undefined)).toEqual([]);
    expect(mappingToRows(null)).toEqual([]);
  });
});

describe('scriptSchema timeoutSeconds', () => {
  const base = {
    name: 'Test Script',
    category: 'Maintenance',
    language: 'bash' as const,
    osTypes: ['linux' as const],
    content: 'echo test',
    runAs: 'system' as const,
  };

  it('accepts a timeout at the 3600s executor cap', () => {
    expect(scriptSchema.safeParse({ ...base, timeoutSeconds: 3600 }).success).toBe(true);
  });

  it('rejects timeouts above 3600s (#2398 — agent clamps at 1 hour)', () => {
    for (const tooLong of [3601, 7200, 86400]) {
      const result = scriptSchema.safeParse({ ...base, timeoutSeconds: tooLong });
      expect(result.success).toBe(false);
    }
  });

  // Deliberate: editing a legacy script saved under the old 86400 cap surfaces
  // a clear validation error instead of silently clamping — the stored value
  // was never honored by the agent, so we force a visible correction here
  // (unlike the AI-builder editorSnapshot, which clamps so session creation
  // doesn't fail on an unrelated field). See #2398.
  it('rejects a legacy 86400 value with the 1-hour message on edit', () => {
    const result = scriptSchema.safeParse({ ...base, timeoutSeconds: 86400 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'timeoutSeconds');
      expect(issue?.message).toBe('Timeout cannot exceed 1 hour (3600 seconds)');
    }
  });
});
