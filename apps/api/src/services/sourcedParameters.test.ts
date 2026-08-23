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
    // The stricter of the two tiers, so every pre-existing case below keeps
    // its original meaning: an ORG-owned script may only reach an org-owned
    // secret, which is what `variable()`'s default `ownerScope` produces. The
    // ownership-tier cases override this explicitly.
    scriptOwnerScope: 'organization',
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

// #3409 PR4c-2 review finding 2 — every fixture above declares exactly ONE
// `tenantSecret` parameter, so a bug that dropped all but the last entry
// (assigning `secretEnv` instead of accumulating into it) would pass the whole
// suite. These cases put TWO secrets on one script, and then mix them with the
// other two delivery channels, so accumulation is actually asserted.
describe('resolveSourcedParameters — MULTIPLE tenantSecret parameters', () => {
  it('accumulates every secret into secretEnv, with a descriptor each and nothing in parameters', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' },
          { name: 'db_password', source: 'tenantSecret', variableKey: 'vendor_db_password' },
        ],
        variables: varsWith(
          variable({ key: 'vendor_token', value: 'sup3r-s3cret', isSecret: true, variableId: 'var-9', version: 3 }),
          variable({
            key: 'vendor_db_password',
            value: 'hunter2-hunter2',
            isSecret: true,
            variableId: 'var-10',
            version: 5,
            ownerScope: 'partner',
          }),
        ),
        // A PARTNER-WIDE script, because one of the two secrets below is
        // partner-owned and an org-owned script may not reach above its own
        // tier (see the ownership-tier block). Partner-wide is the tier that
        // legitimately spans both, which is what lets this case keep
        // asserting that MIXED `ownerScope` descriptors survive.
        scriptOwnerScope: 'partner',
      }),
    );

    // BOTH keys present, with the right values — an assignment-instead-of-
    // accumulation bug leaves only `db_password` here.
    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret', db_password: 'hunter2-hunter2' });
    // Neither name may appear in the map the agent substitutes into script text.
    expect(result.parameters).toEqual({});
    expect(Object.keys(result.parameters)).not.toContain('api_token');
    expect(Object.keys(result.parameters)).not.toContain('db_password');
    // Both descriptors, identity only — never a value.
    expect(result.bindings).toEqual([
      { key: 'api_token', source: 'tenantSecret', variableId: 'var-9', ownerScope: 'organization', version: 3 },
      { key: 'db_password', source: 'tenantSecret', variableId: 'var-10', ownerScope: 'partner', version: 5 },
    ]);
    expect(JSON.stringify(result.bindings)).not.toContain('sup3r-s3cret');
    expect(JSON.stringify(result.bindings)).not.toContain('hunter2-hunter2');
  });

  it('keeps the three delivery channels separate when two secrets share a script with a runtime and a tenantVariable parameter', () => {
    const result = expectOk(
      resolve({
        definitions: [
          { name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' },
          { name: 'level', type: 'string', source: 'runtime' },
          { name: 'db_password', source: 'tenantSecret', variableKey: 'vendor_db_password' },
          { name: 'repo', type: 'string', source: 'tenantVariable', variableKey: 'repo_url' },
        ],
        callerParameters: { level: 'debug' },
        variables: varsWith(
          variable({ key: 'vendor_token', value: 'sup3r-s3cret', isSecret: true, variableId: 'var-9', version: 3 }),
          variable({ key: 'vendor_db_password', value: 'hunter2-hunter2', isSecret: true, variableId: 'var-10', version: 5 }),
          variable({ key: 'repo_url', value: 'https://repo.example', variableId: 'var-11', version: 2 }),
        ),
      }),
    );

    // Channel 1 — sealed secret envelope: both secrets, nothing else.
    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret', db_password: 'hunter2-hunter2' });
    // Channel 2 — the wire parameter map: the runtime value and the plaintext
    // variable, and NEITHER secret name.
    expect(result.parameters).toEqual({ level: 'debug', repo: 'https://repo.example' });
    // Channel 3 — persisted descriptors: every BOUND parameter, no runtime one.
    expect(result.bindings).toEqual([
      { key: 'api_token', source: 'tenantSecret', variableId: 'var-9', ownerScope: 'organization', version: 3 },
      { key: 'db_password', source: 'tenantSecret', variableId: 'var-10', ownerScope: 'organization', version: 5 },
      { key: 'repo', source: 'tenantVariable', variableId: 'var-11', ownerScope: 'organization', version: 2 },
    ]);
    expect(JSON.stringify(result.parameters)).not.toContain('sup3r-s3cret');
    expect(JSON.stringify(result.parameters)).not.toContain('hunter2-hunter2');
  });
});

// #3409 PR4c-2 review BLOCKER — the secret ownership-tier gate.
//
// Variable-key uniqueness is PER SCOPE (`tenant_variables_org_key_uniq` /
// `tenant_variables_partner_key_uniq`), so an org admin can create an
// org-owned secret that SHADOWS a partner-wide key of the same name, pass the
// save-time gate against their own row, then delete it — after which
// `resolveForOrg` inherits the partner-wide row and the MSP's credential would
// be sealed and delivered to an org-owned script. The rule:
//
//   a script may resolve a secret at or BELOW its own ownership tier, never
//   above.
//
// All four rows of the table are asserted below. The one that is easy to get
// backwards is `partner-wide script + org-owned secret` — that is a PRIMARY
// use case (one partner-wide script, each target org's own value resolved per
// device), not an escalation, so it must ALLOW.
describe('resolveSourcedParameters — secret ownership tier (scriptOwnerScope)', () => {
  const secretParam = () => ({
    name: 'api_token',
    source: 'tenantSecret',
    variableKey: 'vendor_token',
  });

  const secretVar = (ownerScope: 'organization' | 'partner') =>
    varsWith(variable({ key: 'vendor_token', value: 'sup3r-s3cret', isSecret: true, ownerScope }));

  it('ALLOWS a partner-wide script resolving a partner-wide secret (same tier)', () => {
    const result = expectOk(
      resolve({
        definitions: [secretParam()],
        variables: secretVar('partner'),
        scriptOwnerScope: 'partner',
      }),
    );

    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret' });
    expect(result.bindings[0]).toMatchObject({ key: 'api_token', ownerScope: 'partner' });
  });

  // THE use case, not an escalation: one partner-wide script, each target
  // org's own value (a per-org site key) resolved per device.
  it('ALLOWS a partner-wide script resolving an ORG-owned secret (the per-org use case)', () => {
    const result = expectOk(
      resolve({
        definitions: [secretParam()],
        variables: secretVar('organization'),
        scriptOwnerScope: 'partner',
      }),
    );

    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret' });
    expect(result.bindings[0]).toMatchObject({ key: 'api_token', ownerScope: 'organization' });
  });

  it('ALLOWS an org-owned script resolving an org-owned secret (same tier)', () => {
    const result = expectOk(
      resolve({
        definitions: [secretParam()],
        variables: secretVar('organization'),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.secretEnv).toEqual({ api_token: 'sup3r-s3cret' });
  });

  it('DENIES an org-owned script resolving a PARTNER-WIDE secret (the escalation)', () => {
    const SECRET = 'sup3r-s3cret';
    const result = expectFailed(
      resolve({
        definitions: [secretParam()],
        variables: secretVar('partner'),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    // Names both keys and says what to do about it — never the value.
    expect(result.error).toContain('api_token');
    expect(result.error).toContain('vendor_token');
    expect(result.error).toContain('partner-wide secret variable');
    expect(result.error).toMatch(/make the script partner-wide/i);
    expect(result.error).not.toContain(SECRET);
  });

  // The gate is deliberately NOT applied to `tenantVariable`: a partner-wide
  // NON-secret value is already readable by an org session through the
  // variables API, so there is no escalation to prevent — the gate exists
  // solely because a secret's plaintext has no other read path.
  it('does NOT gate a tenantVariable binding to a partner-wide NON-secret value', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'repo', type: 'string', source: 'tenantVariable', variableKey: 'repo_url' }],
        variables: varsWith(
          variable({ key: 'repo_url', value: 'https://git.example.test/x', ownerScope: 'partner' }),
        ),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.parameters).toEqual({ repo: 'https://git.example.test/x' });
  });

  // Ordering: the `isSecret` check comes FIRST, so a plaintext partner-wide
  // target is reported as "not a secret" (reclassify it) rather than as a
  // tier violation (make the script partner-wide) — the latter would send the
  // operator to fix the wrong thing.
  it('reports a partner-wide NON-secret target under a tenantSecret binding as notSecret, not as a tier violation', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretParam()],
        variables: varsWith(
          variable({ key: 'vendor_token', value: 'plaintext-value', isSecret: false, ownerScope: 'partner' }),
        ),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.error).toContain('is not a secret');
    expect(result.error).not.toContain('partner-wide secret variable');
  });

  // A denial, never a fallthrough: the caller's value must not satisfy the
  // key, and the parameter must not be omitted from the run.
  it('is a DENIAL — a caller-supplied value never satisfies the gated key', () => {
    const result = expectFailed(
      resolve({
        definitions: [secretParam()],
        callerParameters: { api_token: 'caller-supplied' },
        variables: secretVar('partner'),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.error).toContain('partner-wide secret variable');
    expect(result.ignoredParameters).toEqual(['api_token']);
  });

  it('reports a tier violation alongside a genuinely missing parameter in one pass', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          secretParam(),
          { name: 'level', type: 'string', required: true, source: 'runtime' },
        ],
        variables: secretVar('partner'),
        scriptOwnerScope: 'organization',
      }),
    );

    expect(result.error).toContain('no value for required parameter(s) "level"');
    expect(result.error).toContain('partner-wide secret variable');
  });
});

// #3409 PR4c-2 review finding 1 — a variable whose stored row exists but
// cannot be DECRYPTED must not be reported as "not set". The two states demand
// opposite remediations: "not set" tells a tech to create the variable, while
// unreadable means the ciphertext is there and the KEY MATERIAL is wrong — and
// creating a duplicate during a key rotation is precisely the wrong move.
// `unreadableForOrg` (tenantVariableResolution.ts) is the channel that keeps
// them distinguishable; this is the resolver consuming it.
describe('resolveSourcedParameters — unreadable tenant variables', () => {
  it('reports a tenantVariable binding to an unreadable key as unreadable, not as missing', () => {
    const result = expectFailed(
      resolve({
        definitions: [{ name: 'repo', type: 'string', required: true, source: 'tenantVariable', variableKey: 'repo_url' }],
        variables: varsWith(),
        unreadableVariableKeys: new Set(['repo_url']),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('could not be read');
    expect(result.error).toContain('repo');
    expect(result.error).toContain('repo_url');
    // Must NOT be reported through the "operator never set this" bucket.
    expect(result.error).not.toContain('no value for required parameter');
  });

  it('reports a tenantSecret binding to an unreadable key as unreadable, not as missing', () => {
    const result = expectFailed(
      resolve({
        definitions: [{ name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' }],
        variables: varsWith(),
        unreadableVariableKeys: new Set(['vendor_token']),
      }),
    );

    expect(result.code).toBe('unresolved_parameters');
    expect(result.error).toContain('could not be read');
    expect(result.error).toContain('api_token');
    expect(result.error).toContain('vendor_token');
    expect(result.error).not.toContain('no value for required parameter');
    expect(result.error).not.toContain('is not a secret');
  });

  // An unreadable row is a denial, exactly like the secret denials above: the
  // definition default is a stale plaintext the operator's ciphertext was meant
  // to replace, so falling back to it would silently ship the wrong value.
  it('does NOT fall back to the definition default for an unreadable variable', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'repo', type: 'string', source: 'tenantVariable', variableKey: 'repo_url', defaultValue: 'the-default' },
        ],
        variables: varsWith(),
        unreadableVariableKeys: new Set(['repo_url']),
      }),
    );

    expect(result.error).toContain('could not be read');
    expect(result.error).not.toContain('the-default');
  });

  // Discrimination: the unreadable set must be consulted for the bound KEY,
  // not blanket-applied. A genuinely absent variable still reports "not set"
  // even while some OTHER key in the same org is unreadable.
  it('still reports a genuinely absent variable as missing when a DIFFERENT key is unreadable', () => {
    const result = expectFailed(
      resolve({
        definitions: [{ name: 'repo', type: 'string', required: true, source: 'tenantVariable', variableKey: 'repo_url' }],
        variables: varsWith(),
        unreadableVariableKeys: new Set(['some_other_key']),
      }),
    );

    expect(result.error).toContain('no value for required parameter');
    expect(result.error).not.toContain('could not be read');
  });

  // A readable value must win over a stale unreadable listing for the same key
  // — the map is the authority when it has an entry.
  it('prefers the resolved value when the key is both resolvable and (stale) listed unreadable', () => {
    const result = expectOk(
      resolve({
        definitions: [{ name: 'repo', type: 'string', source: 'tenantVariable', variableKey: 'repo_url' }],
        variables: varsWith(variable({ key: 'repo_url', value: 'https://repo.example' })),
        unreadableVariableKeys: new Set(['repo_url']),
      }),
    );

    expect(result.parameters).toEqual({ repo: 'https://repo.example' });
  });

  it('names an unreadable parameter alongside a genuinely missing one in a single pass', () => {
    const result = expectFailed(
      resolve({
        definitions: [
          { name: 'repo', type: 'string', required: true, source: 'tenantVariable', variableKey: 'repo_url' },
          { name: 'gone', type: 'string', required: true, source: 'tenantVariable', variableKey: 'absent' },
        ],
        variables: varsWith(),
        unreadableVariableKeys: new Set(['repo_url']),
      }),
    );

    expect(result.error).toContain('could not be read');
    expect(result.error).toContain('repo_url');
    expect(result.error).toContain('gone');
    expect(result.error).toContain('no value for required parameter');
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
