import { describe, it, expect } from 'vitest';

import {
  builtinNameContextNeeds,
  hasTenantVariableBoundParameters,
  resolveSourcedParameters,
  scriptNeedsVariableScope,
  type ResolveSourcedParametersInput,
  type SourcedParameterDevice,
} from './sourcedParameters';
import type { ResolvedVariable } from './tenantVariableResolution';

/**
 * #3409 PR3 — the sourced-parameter resolver.
 *
 * The whole precedence table (plan §2.1) is exercised here rather than
 * through `dispatchScriptToDevice`, because the resolver is pure: every case
 * below is a direct input/output assertion with no DB, no mocks and no
 * ambient context to get wrong.
 */

const DEVICE: SourcedParameterDevice = {
  id: 'device-1',
  orgId: 'org-a',
  hostname: 'WKS-014',
  siteId: 'site-1',
  customFields: { license_key: 'LK-1', blank_field: '   ', object_field: { nested: true } },
};

const variable = (overrides: Partial<ResolvedVariable> & { key: string }): ResolvedVariable => ({
  value: 'from-variable',
  isSecret: false,
  variableId: `var-${overrides.key}`,
  version: 7,
  ownerScope: 'organization',
  ...overrides,
});

const varsWith = (...entries: ResolvedVariable[]): Map<string, ResolvedVariable> =>
  new Map(entries.map((entry) => [entry.key, entry]));

function resolve(overrides: Partial<ResolveSourcedParametersInput> = {}) {
  return resolveSourcedParameters({
    definitions: [],
    callerParameters: {},
    device: DEVICE,
    ...overrides,
  });
}

/** Narrowing helper — every success assertion below wants `.parameters`. */
function expectOk(result: ReturnType<typeof resolve>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

function expectFailed(result: ReturnType<typeof resolve>) {
  if (result.ok) throw new Error(`expected failure, got: ${JSON.stringify(result.parameters)}`);
  return result;
}

describe('resolveSourcedParameters — BOUND precedence (source -> default -> missing)', () => {
  it('uses the resolved source value, ignoring both the default and a caller value', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token', defaultValue: 'the-default' },
        ],
        callerParameters: { token: 'caller-supplied' },
        variables: varsWith(variable({ key: 'api_token', value: 'from-variable' })),
      }),
    );

    expect(result.parameters).toEqual({ token: 'from-variable' });
  });

  it('falls back to the definition default when the source has no value', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'absent', defaultValue: 'the-default' },
        ],
        variables: varsWith(),
      }),
    );

    expect(result.parameters).toEqual({ token: 'the-default' });
  });

  it('treats an empty-string source value as blank and falls back to the default', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token', defaultValue: 'the-default' },
        ],
        variables: varsWith(variable({ key: 'api_token', value: '' })),
      }),
    );

    expect(result.parameters).toEqual({ token: 'the-default' });
  });

  // The blank rule is widened past `installerVariables.ts:91-95`'s `=== ''`
  // to whitespace-only (plan §2.1): '   ' would otherwise ship as a
  // BREEZE_PARAM_* value that looks set but carries nothing.
  it('treats a WHITESPACE-ONLY source value as blank', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token', defaultValue: 'the-default' },
        ],
        variables: varsWith(variable({ key: 'api_token', value: '   \t\n ' })),
      }),
    );

    expect(result.parameters).toEqual({ token: 'the-default' });
  });

  it('treats a whitespace-only DEFAULT as no default at all', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'token', type: 'string', required: true, source: 'tenantVariable', variableKey: 'absent', defaultValue: '  ' },
        ],
        variables: varsWith(),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
  });

  it('OMITS an optional bound parameter that resolves to nothing (never an empty value)', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'absent' },
          { name: 'other', type: 'string', source: 'runtime' },
        ],
        callerParameters: { other: 'kept' },
        variables: varsWith(),
      }),
    );

    expect(result.parameters).toEqual({ other: 'kept' });
    expect(result.parameters).not.toHaveProperty('token');
  });

  it('FAILS the device for a required bound parameter with no source value and no default', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'token', type: 'string', required: true, source: 'tenantVariable', variableKey: 'absent' },
        ],
        variables: varsWith(),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('token');
  });

  it('does NOT use a caller value to satisfy a required bound parameter', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'token', type: 'string', required: true, source: 'tenantVariable', variableKey: 'absent' },
        ],
        callerParameters: { token: 'caller-supplied' },
        variables: varsWith(),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.ignoredParameters).toEqual(['token']);
  });
});

describe('resolveSourcedParameters — RUNTIME precedence (caller -> default -> missing)', () => {
  it('uses the caller value over the definition default', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime', defaultValue: 'info' }],
        callerParameters: { level: 'debug' },
      }),
    );

    expect(result.parameters).toEqual({ level: 'debug' });
  });

  it('applies the definition default when the caller supplied nothing', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime', defaultValue: 'info' }],
      }),
    );

    expect(result.parameters).toEqual({ level: 'info' });
  });

  it('treats an explicit null as absent and falls through to the default', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime', defaultValue: 'info' }],
        callerParameters: { level: null },
      }),
    );

    expect(result.parameters).toEqual({ level: 'info' });
  });

  it('preserves a non-string caller value (canonicalization happens later, at dispatch)', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'count', type: 'number', source: 'runtime' }],
        callerParameters: { count: 3 },
      }),
    );

    expect(result.parameters).toEqual({ count: 3 });
  });

  it('OMITS an optional runtime parameter with neither a caller value nor a default', () => {
    const result = expectOk(
      resolve({ definitions: [{ name: 'level', type: 'string', source: 'runtime' }] }),
    );

    expect(result.parameters).toEqual({});
  });

  it('FAILS the device for a required runtime parameter with neither', () => {
    const result = expectFailed(
      resolve({ definitions: [{ name: 'level', type: 'string', required: true, source: 'runtime' }] }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('level');
  });

  // `required` is evaluated AFTER precedence, never before (plan §2.1) — a
  // default satisfies it, so a required parameter with a default never fails.
  it('satisfies `required` from the default rather than failing', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', required: true, source: 'runtime', defaultValue: 'info' }],
      }),
    );

    expect(result.parameters).toEqual({ level: 'info' });
  });

  it('defaults `source` to runtime for a legacy definition that carries no source key', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', defaultValue: 'info' }],
        callerParameters: { level: 'debug' },
      }),
    );

    expect(result.parameters).toEqual({ level: 'debug' });
    expect(result.ignoredParameters).toEqual([]);
  });
});

// Plan §2.4 — the subtle one. A secret target is a POLICY DENIAL, not
// "missing": falling back to the default, honouring a caller value, or
// omitting the parameter would each silently bypass an operator's deliberate
// reclassification of that variable as secret.
describe('resolveSourcedParameters — secret denial', () => {
  const secretDefinition = (extra: Record<string, unknown> = {}) => ({
    name: 'token',
    type: 'string',
    source: 'tenantVariable',
    variableKey: 'api_token',
    ...extra,
  });

  it('fails the device rather than falling back to the definition default', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretDefinition({ defaultValue: 'the-default' })],
        variables: varsWith(variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toMatch(/secret/i);
    // The proof that this is a denial and not a "missing" fallthrough.
    expect(result.error).not.toContain('the-default');
  });

  it('fails even when the parameter is OPTIONAL (not omitted)', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretDefinition({ required: false })],
        variables: varsWith(variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toMatch(/secret/i);
  });

  it('fails even when the caller supplied a value for the key', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretDefinition()],
        callerParameters: { token: 'caller-supplied' },
        variables: varsWith(variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).not.toContain('caller-supplied');
  });

  it('names the parameter key and the variable key, never the secret value', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretDefinition({ defaultValue: 'the-default' })],
        variables: varsWith(variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.error).toContain('token');
    expect(result.error).toContain('api_token');
    expect(result.error).not.toContain('sup3r-s3cret');
  });

  it('reports a secret denial and a genuine missing parameter distinctly in one pass', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          secretDefinition(),
          { name: 'gone', type: 'string', required: true, source: 'tenantVariable', variableKey: 'absent' },
        ],
        variables: varsWith(variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.error).toMatch(/secret/i);
    expect(result.error).toContain('gone');
    expect(result.error).not.toContain('sup3r-s3cret');
  });
});

// #3409 PR4c-2 — the `tenantSecret` arm. The mirror image of the denial above:
// secret delivery is DECLARED, never inferred, so this source demands a secret
// target and refuses a plaintext one, and the resolved value never touches the
// `parameters` map (which the agent substitutes into the script text).
describe('resolveSourcedParameters — tenantSecret source (secretEnv)', () => {
  const secretParam = (extra: Record<string, unknown> = {}) => ({
    name: 'api_token',
    source: 'tenantSecret',
    variableKey: 'vendor_token',
    ...extra,
  });

  it('routes the value into secretEnv, never into parameters, and records a descriptor', () => {
    const result = expectOk(
      resolve({
        definitions: [secretParam()],
        variables: varsWith(
          variable({ key: 'vendor_token', value: 'sup3r-s3cret', isSecret: true, variableId: 'var-9', version: 3 }),
        ),
      }),
    );

    expect(result.parameters).toEqual({});
    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret' });
    expect(result.bindings).toEqual([
      {
        key: 'api_token',
        source: 'tenantSecret',
        variableId: 'var-9',
        ownerScope: 'organization',
        version: 3,
      },
    ]);
  });

  it('exposes an empty secretEnv when the script declares no secret parameter', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime' }],
        callerParameters: { level: 'debug' },
      }),
    );

    expect(result.secretEnv).toEqual({});
  });

  it('fails the device when the target variable is NOT a secret', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretParam()],
        variables: varsWith(variable({ key: 'vendor_token', value: 'plaintext-value', isSecret: false })),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('is not a secret');
    expect(result.error).toContain('api_token');
    expect(result.error).toContain('vendor_token');
    // Denial strings carry KEYS only — the target is plaintext here, so a
    // leak would be silent rather than obviously wrong.
    expect(result.error).not.toContain('plaintext-value');
  });

  it('fails the device when the target variable is missing (never a default, there is none)', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretParam()],
        variables: varsWith(),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('api_token');
    expect(result.error).not.toContain('is not a secret');
  });

  it('throws when no variables map was supplied (call-site programming error)', () => {
    expect(() =>
      resolve({
        definitions: [secretParam()],
      }),
    ).toThrow(/variables map is required/i);
  });

  it('drops a caller-supplied value for the secret key and reports it as ignored', () => {
    const result = expectOk(
      resolve({
        definitions: [secretParam()],
        callerParameters: { api_token: 'caller-supplied', free: 'kept' },
        variables: varsWith(variable({ key: 'vendor_token', value: 'sup3r-s3cret', isSecret: true })),
      }),
    );

    expect(result.parameters).toEqual({ free: 'kept' });
    expect(result.ignoredParameters).toEqual(['api_token']);
    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret' });
  });

  it('reports a notSecret denial alongside a tenantVariable secret denial in one pass', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          secretParam(),
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
        ],
        variables: varsWith(
          variable({ key: 'vendor_token', value: 'plaintext-value', isSecret: false }),
          variable({ key: 'api_token', value: 'sup3r-s3cret', isSecret: true }),
        ),
      }),
    );

    expect(result.error).toContain('is not a secret');
    expect(result.error).toContain('cannot be used in script parameters');
    expect(result.error).not.toContain('sup3r-s3cret');
    expect(result.error).not.toContain('plaintext-value');
  });
});

// Plan §2.2 — ignored, not rejected. A stored automation action is validated
// without consulting the referenced script's definitions, so a hard reject
// would turn a previously-valid automation into a delayed runtime failure the
// moment a script author flips a parameter to bound.
describe('resolveSourcedParameters — caller override of a bound key', () => {
  it('drops the caller value, reports the key, and still succeeds', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
          { name: 'site', type: 'string', source: 'builtin', builtinKey: 'site.id' },
        ],
        callerParameters: { token: 'caller-supplied', site: 'caller-site', free: 'kept' },
        variables: varsWith(variable({ key: 'api_token', value: 'from-variable' })),
      }),
    );

    expect(result.parameters).toEqual({ token: 'from-variable', site: 'site-1', free: 'kept' });
    expect(result.ignoredParameters).toEqual(['token', 'site']);
    expect(JSON.stringify(result.parameters)).not.toContain('caller-supplied');
  });

  it('reports nothing when the caller supplied only runtime keys', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
          { name: 'level', type: 'string', source: 'runtime' },
        ],
        callerParameters: { level: 'debug' },
        variables: varsWith(variable({ key: 'api_token', value: 'from-variable' })),
      }),
    );

    expect(result.ignoredParameters).toEqual([]);
  });
});

describe('resolveSourcedParameters — the four sources', () => {
  it('resolves a deviceCustomField binding from the device JSONB', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'license_key' }],
      }),
    );

    expect(result.parameters).toEqual({ lic: 'LK-1' });
  });

  it('treats an absent custom field as missing', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'lic', type: 'string', required: true, source: 'deviceCustomField', fieldKey: 'not_present' },
        ],
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
  });

  it('treats a whitespace-only custom field as blank', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'blank_field', defaultValue: 'fallback' },
        ],
      }),
    );

    expect(result.parameters).toEqual({ lic: 'fallback' });
  });

  // `[object Object]` in a BREEZE_PARAM_* env var is worse than reporting the
  // parameter unresolved, so a non-primitive JSONB value counts as blank.
  it('treats an OBJECT custom field value as blank rather than stringifying it', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'object_field', defaultValue: 'fallback' },
        ],
      }),
    );

    expect(result.parameters).toEqual({ lic: 'fallback' });
  });

  it('treats a null customFields column as having no fields', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'license_key', defaultValue: 'fallback' },
        ],
        device: { ...DEVICE, customFields: null },
      }),
    );

    expect(result.parameters).toEqual({ lic: 'fallback' });
  });

  it('resolves all five builtin keys', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'org_name', type: 'string', source: 'builtin', builtinKey: 'org.name' },
          { name: 'org_id', type: 'string', source: 'builtin', builtinKey: 'org.id' },
          { name: 'site_name', type: 'string', source: 'builtin', builtinKey: 'site.name' },
          { name: 'site_id', type: 'string', source: 'builtin', builtinKey: 'site.id' },
          { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
        ],
        names: { orgName: 'Acme Corp', siteName: 'Headquarters' },
      }),
    );

    expect(result.parameters).toEqual({
      org_name: 'Acme Corp',
      org_id: 'org-a',
      site_name: 'Headquarters',
      site_id: 'site-1',
      host: 'WKS-014',
    });
  });

  it('treats a site builtin on a site-less device as missing, not as an empty value', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'site_id', type: 'string', required: true, source: 'builtin', builtinKey: 'site.id' },
        ],
        device: { ...DEVICE, siteId: null },
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
  });

  it('treats an unavailable org name as missing rather than throwing', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'org_name', type: 'string', source: 'builtin', builtinKey: 'org.name', defaultValue: 'unknown-org' },
        ],
        names: {},
      }),
    );

    expect(result.parameters).toEqual({ org_name: 'unknown-org' });
  });
});

describe('resolveSourcedParameters — unknown and absent definitions', () => {
  it('passes caller parameters through untouched when the script declares none', () => {
    for (const definitions of [[], null, undefined, 'not-an-array']) {
      const result = expectOk(resolve({ definitions, callerParameters: { a: '1', b: 2 } }));
      expect(result.parameters).toEqual({ a: '1', b: 2 });
      expect(result.bindings).toEqual([]);
    }
  });

  it('leaves a caller parameter with no matching definition alone', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime' }],
        callerParameters: { level: 'debug', undeclared: 'still-here' },
      }),
    );

    expect(result.parameters).toEqual({ level: 'debug', undeclared: 'still-here' });
  });

  // `scripts.parameters` was `z.any()` before this PR, so live databases hold
  // definition lists that do not satisfy the new schema. An unparseable
  // UNBOUND element is ignored (nothing validated it before either) — but an
  // unparseable BOUND one must never be downgraded to "the caller may supply
  // it", which is what silently discarding it would do.
  it('ignores an unparseable definition that declares no binding', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'junk' }, { name: 'level', type: 'string', source: 'runtime' }],
        callerParameters: { level: 'debug', junk: 'passthrough' },
      }),
    );

    expect(result.parameters).toEqual({ level: 'debug', junk: 'passthrough' });
  });

  it('FAILS the device on an unparseable definition that declares a BOUND source', () => {
    const result = expectFailed(
      resolve({
        // `tenantVariable` with no `variableKey` — unresolvable by construction.
        definitions: [{ name: 'token', type: 'string', source: 'tenantVariable' }],
        callerParameters: { token: 'caller-supplied' },
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('token');
  });

  it('throws (call-site programming error) when a tenantVariable binding gets no variables map', () => {
    expect(() =>
      resolve({
        definitions: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }],
      }),
    ).toThrow(/variables map is required/i);
  });

  it('needs no variables map for the non-tenantVariable sources', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'license_key' },
        ],
      }),
    );

    expect(result.parameters).toEqual({ host: 'WKS-014', lic: 'LK-1' });
  });
});

// Plan §3 P4 — what dispatch is allowed to PERSIST about a binding.
describe('resolveSourcedParameters — binding descriptors', () => {
  it('records tenant-variable identity and version, never the value', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }],
        variables: varsWith(
          variable({ key: 'api_token', value: 'from-variable', variableId: 'tv-1', version: 9, ownerScope: 'partner' }),
        ),
      }),
    );

    expect(result.bindings).toEqual([
      { key: 'token', source: 'tenantVariable', variableId: 'tv-1', ownerScope: 'partner', version: 9 },
    ]);
    expect(JSON.stringify(result.bindings)).not.toContain('from-variable');
  });

  it('records the other bound sources by key and source alone', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'lic', type: 'string', source: 'deviceCustomField', fieldKey: 'license_key' },
          { name: 'host', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
        ],
      }),
    );

    expect(result.bindings).toEqual([
      { key: 'lic', source: 'deviceCustomField' },
      { key: 'host', source: 'builtin' },
    ]);
    expect(JSON.stringify(result.bindings)).not.toContain('LK-1');
    expect(JSON.stringify(result.bindings)).not.toContain('WKS-014');
  });

  it('emits no descriptor for a runtime parameter (its value is already persisted as a value)', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'level', type: 'string', source: 'runtime' }],
        callerParameters: { level: 'debug' },
      }),
    );

    expect(result.bindings).toEqual([]);
  });

  it('still records the binding when the value came from the default', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'absent', defaultValue: 'the-default' },
        ],
        variables: varsWith(),
      }),
    );

    expect(result.bindings).toEqual([{ key: 'token', source: 'tenantVariable' }]);
  });
});

describe('hasTenantVariableBoundParameters', () => {
  it('detects a tenantVariable binding', () => {
    expect(hasTenantVariableBoundParameters([{ name: 'x', type: 'string', source: 'tenantVariable', variableKey: 'k' }])).toBe(true);
  });

  // Both variable-backed sources gate the SAME scope preload; missing the
  // secret arm here would resolve every secret binding against an empty map.
  it('detects a tenantSecret binding', () => {
    expect(
      hasTenantVariableBoundParameters([{ name: 'x', source: 'tenantSecret', variableKey: 'k' }]),
    ).toBe(true);
  });

  it('is false for the other sources and for legacy definitions', () => {
    expect(hasTenantVariableBoundParameters([{ name: 'x', type: 'string' }])).toBe(false);
    expect(hasTenantVariableBoundParameters([{ name: 'x', type: 'string', source: 'builtin', builtinKey: 'org.id' }])).toBe(false);
    expect(hasTenantVariableBoundParameters(null)).toBe(false);
    expect(hasTenantVariableBoundParameters('nonsense')).toBe(false);
  });

  // The gate it feeds guards a CHEAP action, so the failure to avoid is a
  // false NEGATIVE: one unparseable sibling must not hide a real binding.
  it('still detects a binding when a SIBLING definition is unparseable', () => {
    expect(
      hasTenantVariableBoundParameters([
        { name: 'junk' },
        { name: 'x', type: 'string', source: 'tenantVariable', variableKey: 'k' },
      ]),
    ).toBe(true);
  });
});

describe('scriptNeedsVariableScope (plan §3 P1)', () => {
  it('is true for a script whose CONTENT carries a {{var.*}} token', () => {
    expect(scriptNeedsVariableScope({ content: 'curl {{var.repo_url}}', parameters: [] })).toBe(true);
  });

  // The gap this predicate exists to close: the binding is in
  // `scripts.parameters`, so a content-only gate reports false here and every
  // bound parameter then resolves against an EMPTY scope.
  it('is true for a script with a tenantVariable-bound PARAMETER and no content token', () => {
    expect(
      scriptNeedsVariableScope({
        content: 'echo hi',
        parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' }],
      }),
    ).toBe(true);
  });

  it('is true for a script with a tenantSecret-bound PARAMETER and no content token', () => {
    expect(
      scriptNeedsVariableScope({
        content: 'echo hi',
        parameters: [{ name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' }],
      }),
    ).toBe(true);
  });

  it('is false for a script with neither', () => {
    expect(scriptNeedsVariableScope({ content: 'echo hi', parameters: [] })).toBe(false);
    expect(scriptNeedsVariableScope({ content: 'echo hi', parameters: null })).toBe(false);
    expect(
      scriptNeedsVariableScope({
        content: 'echo hi',
        parameters: [{ name: 'level', type: 'string', source: 'runtime' }],
      }),
    ).toBe(false);
  });

  it('tolerates a null content column', () => {
    expect(scriptNeedsVariableScope({ content: null, parameters: null })).toBe(false);
  });
});

describe('builtinNameContextNeeds', () => {
  it('asks for a lookup only for the two NAME builtins', () => {
    expect(
      builtinNameContextNeeds([
        { name: 'a', type: 'string', source: 'builtin', builtinKey: 'org.id' },
        { name: 'b', type: 'string', source: 'builtin', builtinKey: 'site.id' },
        { name: 'c', type: 'string', source: 'builtin', builtinKey: 'device.hostname' },
      ]),
    ).toEqual({ orgName: false, siteName: false });

    expect(
      builtinNameContextNeeds([{ name: 'a', type: 'string', source: 'builtin', builtinKey: 'org.name' }]),
    ).toEqual({ orgName: true, siteName: false });

    expect(
      builtinNameContextNeeds([{ name: 'a', type: 'string', source: 'builtin', builtinKey: 'site.name' }]),
    ).toEqual({ orgName: false, siteName: true });
  });

  it('asks for nothing when there is no builtin binding at all', () => {
    expect(builtinNameContextNeeds([{ name: 'a', type: 'string', source: 'runtime' }])).toEqual({
      orgName: false,
      siteName: false,
    });
    expect(builtinNameContextNeeds(null)).toEqual({ orgName: false, siteName: false });
  });
});
