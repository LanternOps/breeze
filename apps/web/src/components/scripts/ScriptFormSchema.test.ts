import { describe, expect, it } from 'vitest';
import {
  hasSecretParameters,
  secretsBlockedForRun,
  stripSecretParameterValueFields,
  mappingToRows,
  parameterBindingKey,
  rowsToMapping,
  runtimeParameters,
  scriptSchema,
  SUPPRESS_SEVERITY,
  type ExitCodeSeverityMapping,
  type ExitCodeSeverityRow,
  type ScriptParameter,
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

// #3409 PR4c-2: a parameter can declare a SECRET tenant variable, delivered to
// the agent only as `BREEZE_VAR_<NAME>` — never substituted into the script.
describe('tenantSecret parameters', () => {
  const secretRow: ScriptParameter = {
    name: 'api_token',
    source: 'tenantSecret',
    variableKey: 'vendor_password',
  };

  it('reports the bound variable key so run surfaces can name it', () => {
    expect(parameterBindingKey(secretRow)).toBe('vendor_password');
  });

  it('returns null for a secret row whose key has not been chosen yet', () => {
    expect(parameterBindingKey({ ...secretRow, variableKey: '' })).toBeNull();
  });

  it('never prompts for a secret parameter — it is bound, not runtime', () => {
    expect(runtimeParameters([secretRow, { name: 'msg', type: 'string' }]).map(p => p.name)).toEqual(['msg']);
  });

  it('detects secret parameters in a list', () => {
    expect(hasSecretParameters([secretRow])).toBe(true);
    expect(hasSecretParameters([{ name: 'msg', type: 'string' }])).toBe(false);
    expect(hasSecretParameters(undefined)).toBe(false);
    expect(
      hasSecretParameters([{ name: 'a', type: 'string', source: 'tenantVariable', variableKey: 'k' }])
    ).toBe(false);
  });

  it('accepts a secret parameter through the form schema', () => {
    const result = scriptSchema.safeParse({
      name: 'S',
      category: 'Custom',
      language: 'powershell',
      osTypes: ['windows'],
      content: 'echo hi',
      timeoutSeconds: 300,
      runAs: 'system',
      parameters: [secretRow],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data.parameters?.[0];
      expect(parsed).toMatchObject({ source: 'tenantSecret', type: 'string', required: true });
    }
  });

  it('rejects an upper-case secret parameter name under `name` (it is the env-var key)', () => {
    const result = scriptSchema.safeParse({
      name: 'S',
      category: 'Custom',
      language: 'powershell',
      osTypes: ['windows'],
      content: 'echo hi',
      timeoutSeconds: 300,
      runAs: 'system',
      parameters: [{ ...secretRow, name: 'API_TOKEN' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'parameters.0.name')).toBe(true);
    }
  });

  it('rejects a default value on a secret parameter — that would be a plaintext credential', () => {
    const result = scriptSchema.safeParse({
      name: 'S',
      category: 'Custom',
      language: 'powershell',
      osTypes: ['windows'],
      content: 'echo hi',
      timeoutSeconds: 300,
      runAs: 'system',
      parameters: [{ ...secretRow, defaultValue: 'hunter2' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('stripSecretParameterValueFields', () => {
  it('drops the seeded empty default/options and pins type + required on a secret row', () => {
    const out = stripSecretParameterValueFields({
      name: 'S',
      parameters: [
        { name: 'api_token', source: 'tenantSecret', variableKey: 'k', type: 'select', defaultValue: '', options: '', required: false },
      ],
    });
    expect(out.parameters[0]).toEqual({
      name: 'api_token',
      source: 'tenantSecret',
      variableKey: 'k',
      type: 'string',
      required: true,
    });
  });

  it('leaves every other arm untouched, object identity included', () => {
    const values = {
      parameters: [{ name: 'msg', type: 'string', defaultValue: '', options: '', required: false }],
    };
    expect(stripSecretParameterValueFields(values)).toBe(values);
  });

  it('tolerates values with no parameters at all', () => {
    const values = { name: 'S' };
    expect(stripSecretParameterValueFields(values)).toBe(values);
  });
});

// #3409 PR4c-2: the web-side mirror of the server's `runAsSupportsSecretEnv`
// (apps/api/src/services/scriptSecretDelivery.ts). Both halves of the rule
// matter — a targeted session is refused even under `system`.
describe('secretsBlockedForRun', () => {
  it('allows an untargeted system or elevated run', () => {
    expect(secretsBlockedForRun({ runAs: 'system' })).toBe(false);
    expect(secretsBlockedForRun({ runAs: 'elevated' })).toBe(false);
    expect(secretsBlockedForRun({ runAs: 'system', targetSessionId: null })).toBe(false);
    // Unset run-as defaults to the service context server-side.
    expect(secretsBlockedForRun({})).toBe(false);
  });

  it('blocks a user-context run', () => {
    expect(secretsBlockedForRun({ runAs: 'user' })).toBe(true);
  });

  it('blocks ANY targeted session, including session 0, even under system', () => {
    expect(secretsBlockedForRun({ runAs: 'system', targetSessionId: 3 })).toBe(true);
    expect(secretsBlockedForRun({ runAs: 'system', targetSessionId: 0 })).toBe(true);
    expect(secretsBlockedForRun({ targetSessionId: 1 })).toBe(true);
  });
});
