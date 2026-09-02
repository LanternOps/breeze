import { describe, expect, it } from 'vitest';
import {
  DEVICE_CUSTOM_FIELD_KEY_PATTERN,
  MAX_SCRIPT_PARAMETER_OPTIONS_LENGTH,
  MAX_SECRET_SCRIPT_PARAMETERS,
  SCRIPT_BUILTIN_PARAMETER_KEYS,
  SCRIPT_PARAMETER_SOURCES,
  canonicalizeScriptParameterDefinitions,
  normalizeScriptParameterDefinitions,
  scriptParameterDefinitionSchema,
  scriptParameterDefinitionsEqual,
  scriptParameterDefinitionsSchema,
  scriptParameterEnvName,
  scriptParameterEnvSuffix,
  scriptSecretEnvName,
} from './scriptParameterDefinitions';
import { MAX_SCRIPT_PARAMETERS, MAX_SCRIPT_PARAMETER_VALUE_LENGTH } from './scriptParameters';

const runtimeDefinition = (name: string) => ({ name, type: 'string' as const });

describe('scriptParameterDefinitionSchema — source default', () => {
  // The whole compatibility story: every definition stored before #3409 PR3
  // has no `source` key at all. If this regresses, every existing script's
  // parameters become unsaveable.
  it('defaults a legacy definition with no source to runtime', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ name: 'target', type: 'string' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'target', type: 'string', required: false, source: 'runtime' });
  });

  it('defaults source on a fully-populated legacy definition', () => {
    const result = scriptParameterDefinitionSchema.safeParse({
      name: 'mode',
      type: 'select',
      defaultValue: 'fast',
      required: true,
      options: 'fast,slow',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: 'mode',
      type: 'select',
      defaultValue: 'fast',
      required: true,
      options: 'fast,slow',
      source: 'runtime',
    });
  });

  it('defaults required to false when omitted', () => {
    const result = scriptParameterDefinitionSchema.safeParse(runtimeDefinition('x'));
    expect(result.success && result.data.required).toBe(false);
  });

  it('rejects an unknown source', () => {
    expect(scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'magic' }).success).toBe(false);
  });

  it('enumerates exactly the five supported sources, tenantSecret last (web <select> order)', () => {
    expect([...SCRIPT_PARAMETER_SOURCES]).toEqual([
      'runtime',
      'tenantVariable',
      'deviceCustomField',
      'builtin',
      'tenantSecret',
    ]);
  });
});

describe('scriptParameterDefinitionSchema — runtime arm', () => {
  it('accepts an explicit runtime source', () => {
    expect(scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'number', source: 'runtime' }).success).toBe(true);
  });

  it.each(['string', 'number', 'boolean', 'select'])('accepts type %s', (type) => {
    expect(scriptParameterDefinitionSchema.safeParse({ name: 'x', type }).success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'json' }).success).toBe(false);
  });

  it('rejects a missing type', () => {
    expect(scriptParameterDefinitionSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('strips a binding key that does not belong to the runtime arm', () => {
    // Deliberately NOT strict: the three schemas this replaces were all plain
    // (stripping) z.objects, and `scripts.parameters` was `z.any()` for years,
    // so stored definitions may carry extra keys. Rejecting them would make
    // untouched legacy scripts unsaveable. The arm still owns the shape — the
    // stray key is dropped, never persisted.
    const result = scriptParameterDefinitionSchema.safeParse({
      name: 'x',
      type: 'string',
      source: 'runtime',
      variableKey: 'api_key',
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('variableKey');
  });

  it('rejects a defaultValue longer than the value cap', () => {
    expect(
      scriptParameterDefinitionSchema.safeParse({
        name: 'x',
        type: 'string',
        defaultValue: 'a'.repeat(MAX_SCRIPT_PARAMETER_VALUE_LENGTH + 1),
      }).success
    ).toBe(false);
  });

  it('rejects an options list longer than the options cap', () => {
    expect(
      scriptParameterDefinitionSchema.safeParse({
        name: 'x',
        type: 'select',
        options: 'a'.repeat(MAX_SCRIPT_PARAMETER_OPTIONS_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});

describe('scriptParameterDefinitionSchema — tenantVariable arm', () => {
  it('accepts a valid tenant variable binding', () => {
    const result = scriptParameterDefinitionSchema.safeParse({
      name: 'apiKey',
      type: 'string',
      source: 'tenantVariable',
      variableKey: 'vendor_api_key',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: 'apiKey',
      type: 'string',
      required: false,
      source: 'tenantVariable',
      variableKey: 'vendor_api_key',
    });
  });

  it('requires variableKey', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'tenantVariable' });
    expect(result.success).toBe(false);
    // Arm-specific error, not a four-branch union failure — the discriminator
    // fast path must still be doing the work.
    expect(result.error?.issues[0]?.path).toEqual(['variableKey']);
  });

  it.each([
    'Uppercase',
    '9leading',
    'has space',
    'has-hyphen',
    'trailing.',
    '',
    'a'.repeat(65),
  ])('rejects variableKey %j (tenant-variable key grammar)', (variableKey) => {
    expect(
      scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'tenantVariable', variableKey }).success
    ).toBe(false);
  });

  it('accepts the longest legal variableKey', () => {
    expect(
      scriptParameterDefinitionSchema.safeParse({
        name: 'x',
        type: 'string',
        source: 'tenantVariable',
        variableKey: `a${'b'.repeat(63)}`,
      }).success
    ).toBe(true);
  });

  it('strips a foreign binding key on the tenantVariable arm', () => {
    const result = scriptParameterDefinitionSchema.safeParse({
      name: 'x',
      type: 'string',
      source: 'tenantVariable',
      variableKey: 'ok',
      fieldKey: 'asset_tag',
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('fieldKey');
  });
});

describe('scriptParameterDefinitionSchema — tenantSecret arm (#3409 PR4c-2)', () => {
  const secretDefinition = { name: 'api_token', source: 'tenantSecret' as const, variableKey: 'vendor_token' };

  it('accepts a minimal secret binding, defaulting type to string and required to true', () => {
    const result = scriptParameterDefinitionSchema.safeParse(secretDefinition);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: 'api_token',
      source: 'tenantSecret',
      variableKey: 'vendor_token',
      type: 'string',
      required: true,
    });
  });

  it('forces required to true regardless of input', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, required: false });
    // A secret that is missing fails the device closed — there is no optional
    // secret, so `required:false` is not a thing a definition can say.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['required']);
    const explicit = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, required: true });
    expect(explicit.success && explicit.data.required).toBe(true);
  });

  it('requires variableKey at the arm path', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ name: 'api_token', source: 'tenantSecret' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['variableKey']);
  });

  it.each(['Uppercase', '9leading', 'has-hyphen', '', 'a'.repeat(65)])(
    'rejects variableKey %j (tenant-variable key grammar)',
    (variableKey) => {
      expect(scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, variableKey }).success).toBe(false);
    }
  );

  // The secretEnv wire key IS the env-var name source on the agent
  // (`BREEZE_VAR_` + ToUpper(key), no `-` folding) and the agent's
  // ParseSecretEnv validates it against the tenant-key grammar, so a name the
  // ordinary parameter grammar would accept must already be rejected here.
  it.each(['Api-Token', 'API_TOKEN', 'api-token', '_leading', '9leading', 'a'.repeat(65)])(
    'rejects name %j outside the tenant-variable key grammar at [name]',
    (name) => {
      const result = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, name });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['name']);
    }
  );

  it('rejects a defaultValue — it would be a plaintext credential in the definition', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, defaultValue: 'hunter22' });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((candidate) => candidate.path[0] === 'defaultValue');
    expect(issue?.message).toMatch(/cannot carry a default/i);
  });

  it('rejects options', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, options: 'a,b' });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((candidate) => candidate.path[0] === 'options');
    expect(issue?.message).toMatch(/cannot declare options/i);
  });

  it.each(['select', 'number', 'boolean'])('rejects type %j', (type) => {
    const result = scriptParameterDefinitionSchema.safeParse({ ...secretDefinition, type });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['type']);
  });

  it('still collides with a runtime parameter of the same name', () => {
    // The suffix rule keys on `name` for every arm. A secret and a runtime
    // parameter sharing a name is a duplicate even though they land in
    // different env vars (BREEZE_VAR_ vs BREEZE_PARAM_) — do not "fix" this.
    const result = scriptParameterDefinitionsSchema.safeParse([
      runtimeDefinition('token'),
      { name: 'token', source: 'tenantSecret', variableKey: 'vendor_token' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([1, 'name']);
    expect(result.error?.issues[0]?.message).toMatch(/Duplicate parameter name "token"/);
  });

  it('canonicalizes stably, including source and variableKey', () => {
    const canonical = canonicalizeScriptParameterDefinitions([secretDefinition]);
    expect(canonical).toBe(
      JSON.stringify([
        JSON.stringify([
          ['name', 'api_token'],
          ['required', true],
          ['source', 'tenantSecret'],
          ['type', 'string'],
          ['variableKey', 'vendor_token'],
        ]),
      ])
    );
    expect(
      canonicalizeScriptParameterDefinitions([
        { variableKey: 'vendor_token', source: 'tenantSecret', name: 'api_token', required: true, type: 'string' },
      ])
    ).toBe(canonical);
  });
});

describe('scriptSecretEnvName', () => {
  it('mirrors the agent: BREEZE_VAR_ + ToUpper(name), no separator folding', () => {
    expect(scriptSecretEnvName('api_token')).toBe('BREEZE_VAR_API_TOKEN');
    expect(scriptSecretEnvName('a1_b2')).toBe('BREEZE_VAR_A1_B2');
  });
});

describe('scriptParameterDefinitionSchema — deviceCustomField arm', () => {
  it('accepts a valid custom-field binding', () => {
    expect(
      scriptParameterDefinitionSchema.safeParse({
        name: 'assetTag',
        type: 'string',
        source: 'deviceCustomField',
        fieldKey: 'asset_tag',
      }).success
    ).toBe(true);
  });

  it('requires fieldKey', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'deviceCustomField' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fieldKey']);
  });

  it.each(['Uppercase', '9leading', 'has-hyphen', 'has space', ''])('rejects fieldKey %j', (fieldKey) => {
    expect(
      scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'deviceCustomField', fieldKey }).success
    ).toBe(false);
  });

  it('matches the custom_field_definitions.field_key grammar and column width', () => {
    expect(DEVICE_CUSTOM_FIELD_KEY_PATTERN.test('a'.repeat(100))).toBe(true);
    expect(DEVICE_CUSTOM_FIELD_KEY_PATTERN.test('a'.repeat(101))).toBe(false);
  });
});

describe('scriptParameterDefinitionSchema — builtin arm', () => {
  it.each(SCRIPT_BUILTIN_PARAMETER_KEYS)('accepts builtinKey %s', (builtinKey) => {
    expect(
      scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'builtin', builtinKey }).success
    ).toBe(true);
  });

  it('requires builtinKey', () => {
    const result = scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'builtin' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['builtinKey']);
  });

  it('rejects a builtinKey with no resolver arm', () => {
    expect(
      scriptParameterDefinitionSchema.safeParse({ name: 'x', type: 'string', source: 'builtin', builtinKey: 'device.serial' })
        .success
    ).toBe(false);
  });
});

describe('scriptParameterDefinitionSchema — name grammar', () => {
  it.each(['log-level', 'log_level', '_private', 'A1', 'a'.repeat(64)])('accepts %j', (name) => {
    expect(scriptParameterDefinitionSchema.safeParse({ name, type: 'string' }).success).toBe(true);
  });

  it.each(['-leading', '9leading', 'has space', 'a.b', 'a=b', '', 'a'.repeat(65)])('rejects %j', (name) => {
    expect(scriptParameterDefinitionSchema.safeParse({ name, type: 'string' }).success).toBe(false);
  });
});

describe('scriptParameterEnvSuffix / scriptParameterEnvName', () => {
  // Must match agent/internal/executor/executor.go:339-341 exactly:
  // "BREEZE_PARAM_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_")).
  it.each([
    ['log-level', 'LOG_LEVEL'],
    ['log_level', 'LOG_LEVEL'],
    ['logLevel', 'LOGLEVEL'],
    ['LOGLEVEL', 'LOGLEVEL'],
    ['a-b-c', 'A_B_C'],
  ])('normalizes %s to %s', (name, expected) => {
    expect(scriptParameterEnvSuffix(name)).toBe(expected);
    expect(scriptParameterEnvName(name)).toBe(`BREEZE_PARAM_${expected}`);
  });
});

describe('scriptParameterDefinitionsSchema — collisions', () => {
  it('accepts distinct parameter names', () => {
    const result = scriptParameterDefinitionsSchema.safeParse([runtimeDefinition('alpha'), runtimeDefinition('beta')]);
    expect(result.success).toBe(true);
  });

  it('rejects an exact duplicate name', () => {
    const result = scriptParameterDefinitionsSchema.safeParse([runtimeDefinition('alpha'), runtimeDefinition('alpha')]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate parameter name "alpha"');
    expect(result.error?.issues[0]?.path).toEqual([1, 'name']);
  });

  it('rejects a hyphen/underscore collision', () => {
    const result = scriptParameterDefinitionsSchema.safeParse([runtimeDefinition('log-level'), runtimeDefinition('log_level')]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('BREEZE_PARAM_LOG_LEVEL');
  });

  it('rejects the reverse hyphen/underscore collision', () => {
    expect(
      scriptParameterDefinitionsSchema.safeParse([runtimeDefinition('log_level'), runtimeDefinition('log-level')]).success
    ).toBe(false);
  });

  it.each([
    ['logLevel', 'LOGLEVEL'],
    ['logLevel', 'loglevel'],
    ['LOGLEVEL', 'loglevel'],
  ])('rejects the case collision %s vs %s', (a, b) => {
    expect(scriptParameterDefinitionsSchema.safeParse([runtimeDefinition(a), runtimeDefinition(b)]).success).toBe(false);
  });

  it('rejects a mixed case + separator collision (log-Level vs LOG_LEVEL)', () => {
    const result = scriptParameterDefinitionsSchema.safeParse([runtimeDefinition('log-Level'), runtimeDefinition('LOG_LEVEL')]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('collides with "log-Level"');
  });

  it('detects a collision across different sources', () => {
    expect(
      scriptParameterDefinitionsSchema.safeParse([
        { name: 'api-key', type: 'string' },
        { name: 'API_KEY', type: 'string', source: 'tenantVariable', variableKey: 'api_key' },
      ]).success
    ).toBe(false);
  });

  it('reports the collision at the later element, once per collision', () => {
    const result = scriptParameterDefinitionsSchema.safeParse([
      runtimeDefinition('a-b'),
      runtimeDefinition('a_b'),
      runtimeDefinition('A_B'),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      [1, 'name'],
      [2, 'name'],
    ]);
  });
});

describe('scriptParameterDefinitionsSchema — array', () => {
  it('accepts an empty list', () => {
    expect(scriptParameterDefinitionsSchema.safeParse([]).success).toBe(true);
  });

  it(`accepts exactly ${MAX_SCRIPT_PARAMETERS} definitions`, () => {
    const definitions = Array.from({ length: MAX_SCRIPT_PARAMETERS }, (_, i) => runtimeDefinition(`p${i}`));
    expect(scriptParameterDefinitionsSchema.safeParse(definitions).success).toBe(true);
  });

  it(`rejects ${MAX_SCRIPT_PARAMETERS + 1} definitions`, () => {
    const definitions = Array.from({ length: MAX_SCRIPT_PARAMETERS + 1 }, (_, i) => runtimeDefinition(`p${i}`));
    expect(scriptParameterDefinitionsSchema.safeParse(definitions).success).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(scriptParameterDefinitionsSchema.safeParse({ name: 'x', type: 'string' }).success).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Secret-parameter cap (#3409 PR4c-2, finding 3).
  //
  // MAX_SCRIPT_PARAMETERS (64) is twice MAX_SECRET_SCRIPT_PARAMETERS (32), so
  // without this rule a script declaring 33+ tenantSecret parameters SAVES
  // cleanly and then blows up at dispatch inside the envelope builder — which
  // rethrows, taking the whole fan-out down with a 500 instead of failing one
  // device. The cap has to be a SAVE-time rule for that reason.
  // ---------------------------------------------------------------------
  const secretDefinition = (name: string) => ({
    name,
    source: 'tenantSecret' as const,
    variableKey: name,
  });

  it(`accepts exactly ${MAX_SECRET_SCRIPT_PARAMETERS} tenantSecret definitions`, () => {
    const definitions = Array.from({ length: MAX_SECRET_SCRIPT_PARAMETERS }, (_, i) => secretDefinition(`s${i}`));
    expect(scriptParameterDefinitionsSchema.safeParse(definitions).success).toBe(true);
  });

  it(`rejects ${MAX_SECRET_SCRIPT_PARAMETERS + 1} tenantSecret definitions`, () => {
    const definitions = Array.from({ length: MAX_SECRET_SCRIPT_PARAMETERS + 1 }, (_, i) => secretDefinition(`s${i}`));
    const result = scriptParameterDefinitionsSchema.safeParse(definitions);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      `A script cannot declare more than ${MAX_SECRET_SCRIPT_PARAMETERS} secret parameters`
    );
  });

  // The cap counts ONLY tenantSecret rows — a script may still declare up to
  // MAX_SCRIPT_PARAMETERS parameters overall, and non-secret sources never
  // reach the secretEnv envelope.
  it('counts only tenantSecret rows, not the whole definition list', () => {
    const definitions = [
      ...Array.from({ length: MAX_SECRET_SCRIPT_PARAMETERS }, (_, i) => secretDefinition(`s${i}`)),
      ...Array.from({ length: MAX_SCRIPT_PARAMETERS - MAX_SECRET_SCRIPT_PARAMETERS }, (_, i) => runtimeDefinition(`p${i}`)),
    ];
    expect(definitions).toHaveLength(MAX_SCRIPT_PARAMETERS);
    expect(scriptParameterDefinitionsSchema.safeParse(definitions).success).toBe(true);
  });

  it('reports the secret cap on the first over-limit element, not the whole array', () => {
    const definitions = Array.from({ length: MAX_SECRET_SCRIPT_PARAMETERS + 2 }, (_, i) => secretDefinition(`s${i}`));
    const result = scriptParameterDefinitionsSchema.safeParse(definitions);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
    expect(paths).toContain(`${MAX_SECRET_SCRIPT_PARAMETERS}.source`);
  });

  it('does not mutate when a caller applies a tighter cap', () => {
    // ai.ts narrows to 50; that must not narrow the shared schema.
    const narrowed = scriptParameterDefinitionsSchema.max(1);
    const two = [runtimeDefinition('a'), runtimeDefinition('b')];
    expect(narrowed.safeParse(two).success).toBe(false);
    expect(scriptParameterDefinitionsSchema.safeParse(two).success).toBe(true);
  });

  it('still applies the collision rule under a tighter cap', () => {
    expect(scriptParameterDefinitionsSchema.max(50).safeParse([runtimeDefinition('a-b'), runtimeDefinition('A_B')]).success).toBe(
      false
    );
  });
});

describe('normalizeScriptParameterDefinitions', () => {
  it('treats null and undefined as an empty list', () => {
    expect(normalizeScriptParameterDefinitions(null)).toEqual([]);
    expect(normalizeScriptParameterDefinitions(undefined)).toEqual([]);
  });

  it('materializes defaults', () => {
    expect(normalizeScriptParameterDefinitions([{ name: 'x', type: 'string' }])).toEqual([
      { name: 'x', type: 'string', required: false, source: 'runtime' },
    ]);
  });

  it('returns null for an unparseable stored value', () => {
    expect(normalizeScriptParameterDefinitions([{ nope: true }])).toBeNull();
    expect(normalizeScriptParameterDefinitions('not an array')).toBeNull();
  });
});

describe('scriptParameterDefinitionsEqual', () => {
  it('treats a legacy definition as equal to its normalized form', () => {
    expect(
      scriptParameterDefinitionsEqual(
        [{ name: 'x', type: 'string' }],
        [{ name: 'x', type: 'string', required: false, source: 'runtime' }]
      )
    ).toBe(true);
  });

  it('ignores key order', () => {
    expect(scriptParameterDefinitionsEqual([{ type: 'string', name: 'x' }], [{ name: 'x', type: 'string' }])).toBe(true);
  });

  it('treats null and [] as equal', () => {
    expect(scriptParameterDefinitionsEqual(null, [])).toBe(true);
  });

  it('detects an added parameter', () => {
    expect(scriptParameterDefinitionsEqual([{ name: 'x', type: 'string' }], [{ name: 'x', type: 'string' }, { name: 'y', type: 'string' }])).toBe(false);
  });

  it('detects a removed parameter', () => {
    expect(scriptParameterDefinitionsEqual([{ name: 'x', type: 'string' }], [])).toBe(false);
  });

  it('detects a type change', () => {
    expect(scriptParameterDefinitionsEqual([{ name: 'x', type: 'string' }], [{ name: 'x', type: 'number' }])).toBe(false);
  });

  it('detects a required flip', () => {
    expect(scriptParameterDefinitionsEqual([{ name: 'x', type: 'string' }], [{ name: 'x', type: 'string', required: true }])).toBe(
      false
    );
  });

  it('detects a default-value change', () => {
    expect(
      scriptParameterDefinitionsEqual([{ name: 'x', type: 'string', defaultValue: 'a' }], [{ name: 'x', type: 'string', defaultValue: 'b' }])
    ).toBe(false);
  });

  it('detects a source binding change', () => {
    expect(
      scriptParameterDefinitionsEqual(
        [{ name: 'x', type: 'string' }],
        [{ name: 'x', type: 'string', source: 'tenantVariable', variableKey: 'api_key' }]
      )
    ).toBe(false);
  });

  it('detects a rebinding to a different variable key', () => {
    expect(
      scriptParameterDefinitionsEqual(
        [{ name: 'x', type: 'string', source: 'tenantVariable', variableKey: 'a' }],
        [{ name: 'x', type: 'string', source: 'tenantVariable', variableKey: 'b' }]
      )
    ).toBe(false);
  });

  it('detects a reorder', () => {
    expect(
      scriptParameterDefinitionsEqual(
        [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }],
        [{ name: 'b', type: 'string' }, { name: 'a', type: 'string' }]
      )
    ).toBe(false);
  });

  it('reports changed when either side is unparseable', () => {
    expect(scriptParameterDefinitionsEqual([{ garbage: 1 }], [{ garbage: 1 }])).toBe(false);
  });
});
