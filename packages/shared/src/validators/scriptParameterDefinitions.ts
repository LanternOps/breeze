import { z } from 'zod';
import { MAX_SCRIPT_PARAMETERS, MAX_SCRIPT_PARAMETER_VALUE_LENGTH, SCRIPT_PARAMETER_KEY_PATTERN } from './scriptParameters';
import { TENANT_VARIABLE_KEY_PATTERN, tenantVariableKeySchema } from './tenantVariables';

/**
 * Script parameter DEFINITIONS (#3409 PR3) — the authoring-time declaration of
 * a script's parameters, as stored in `scripts.parameters` / `script_templates
 * .parameters`.
 *
 * Distinct from `./scriptParameters`, which validates the run-time *values* a
 * caller attaches to one execution. Definitions describe the contract; values
 * satisfy it.
 *
 * This module is the ONE authority. Before it existed the same shape was
 * hand-mirrored in three places with no relationship between them —
 * `apps/web/src/components/scripts/ScriptFormSchema.ts`,
 * `packages/shared/src/validators/ai.ts` (script-builder editor snapshot) and
 * `apps/api/src/services/scriptBuilderTools.ts` (the MCP apply tool) — while
 * the API's own intake was `z.any()`, so nothing validated definitions at all
 * on the way into the database. All four now go through this schema.
 */

/**
 * Where a parameter's value comes from at dispatch time.
 *
 * - `runtime` — the invoker supplies it (today's only behaviour, the default).
 * - `tenantVariable` — a `tenant_variables` row, resolved per target device's
 *   org (org > partner).
 * - `deviceCustomField` — the target device's `custom_fields` JSONB.
 * - `builtin` — an org / site / device property.
 * - `tenantSecret` — a SECRET `tenant_variables` row (#3409 PR4c). The value
 *   never enters the `parameters` map or the script text; it rides the sealed
 *   `secretEnv` envelope and the agent exports it as `BREEZE_VAR_<UPPER(name)>`
 *   (see {@link scriptSecretEnvName}). `tenantVariable` keeps REJECTING a
 *   secret target — secret delivery is declared, never inferred.
 *
 * Order is the web `<select>` order; append, never reorder.
 */
export const SCRIPT_PARAMETER_SOURCES = ['runtime', 'tenantVariable', 'deviceCustomField', 'builtin', 'tenantSecret'] as const;
export type ScriptParameterSource = (typeof SCRIPT_PARAMETER_SOURCES)[number];

export const SCRIPT_PARAMETER_TYPES = ['string', 'number', 'boolean', 'select'] as const;
export type ScriptParameterType = (typeof SCRIPT_PARAMETER_TYPES)[number];

/**
 * `options` is a comma-separated list rendered as a `<select>`; 1000 chars was
 * already the cap on the `ai.ts` mirror and is the strictest of the three
 * pre-existing copies, so adopting it here loses no validation anywhere.
 */
export const MAX_SCRIPT_PARAMETER_OPTIONS_LENGTH = 1000;

/**
 * Mirrors `createCustomFieldSchema.fieldKey` (`apps/api/src/routes/
 * customFields.ts`): lowercase, underscore-separated, `varchar(100)` column.
 * A binding to a key outside this grammar could never match a stored
 * definition, so it is rejected at save rather than failing per device.
 */
export const DEVICE_CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * The built-in vocabulary a parameter may bind to. Deliberately the SAME five
 * keys the installer-variable resolver already supports
 * (`BUILTIN_INSTALLER_VARIABLES` in `apps/web/src/lib/installerVariables.ts`,
 * `resolveKey` in `apps/api/src/services/installerVariables.ts`) — the whole
 * point of a shared constant is that a key offered by one surface is always
 * resolvable by the other. Extending this list requires a matching resolver
 * arm on the API side in the same change.
 */
export const SCRIPT_BUILTIN_PARAMETER_KEYS = [
  'org.name',
  'org.id',
  'site.name',
  'site.id',
  'device.hostname',
] as const;
export type ScriptBuiltinParameterKey = (typeof SCRIPT_BUILTIN_PARAMETER_KEYS)[number];

/**
 * Fields every arm carries. `defaultValue` is meaningful for BOUND parameters
 * too — the resolution precedence is
 * `resolved source value -> definition default -> missing` — so it lives here
 * rather than only on the `runtime` arm.
 */
const scriptParameterDefinitionBase = {
  name: z
    .string()
    .regex(
      SCRIPT_PARAMETER_KEY_PATTERN,
      'Parameter names must start with a letter or underscore and contain only letters, digits, underscores and hyphens'
    ),
  type: z.enum(SCRIPT_PARAMETER_TYPES),
  defaultValue: z.string().max(MAX_SCRIPT_PARAMETER_VALUE_LENGTH).optional(),
  required: z.boolean().optional().default(false),
  /** Comma-separated; only meaningful when `type` is `select`. */
  options: z.string().max(MAX_SCRIPT_PARAMETER_OPTIONS_LENGTH).optional(),
};

const runtimeParameterDefinitionSchema = z.object({
  ...scriptParameterDefinitionBase,
  /**
   * Defaulted so every definition stored before PR3 — none of which carry a
   * `source` key — parses unchanged and keeps today's behaviour.
   */
  source: z.literal('runtime').default('runtime'),
});

const tenantVariableParameterDefinitionSchema = z.object({
  ...scriptParameterDefinitionBase,
  source: z.literal('tenantVariable'),
  variableKey: tenantVariableKeySchema,
});

const deviceCustomFieldParameterDefinitionSchema = z.object({
  ...scriptParameterDefinitionBase,
  source: z.literal('deviceCustomField'),
  fieldKey: z
    .string()
    .regex(
      DEVICE_CUSTOM_FIELD_KEY_PATTERN,
      'Custom field key must be lowercase letters, digits and underscores, and start with a letter'
    ),
});

const builtinParameterDefinitionSchema = z.object({
  ...scriptParameterDefinitionBase,
  source: z.literal('builtin'),
  builtinKey: z.enum(SCRIPT_BUILTIN_PARAMETER_KEYS),
});

/**
 * The `tenantSecret` arm deliberately does NOT spread the base:
 *
 * - `name` must match the TENANT-VARIABLE key grammar, not the looser
 *   parameter grammar. The name is the `secretEnv` wire key, the agent's
 *   `ParseSecretEnv` validates it against that grammar and fails the whole
 *   command closed on a miss, and the env var is derived as
 *   `BREEZE_VAR_` + ToUpper(name) with no `-` folding. Rejecting at save beats
 *   failing per device.
 * - `type` is always `string` and `required` is always `true`: a missing or
 *   unreadable secret fails the device closed, so there is no optional secret
 *   and nothing to coerce.
 * - `defaultValue` and `options` are rejected when present. A default would be
 *   a plaintext credential stored in the script definition; the value is never
 *   a choice list. Zod 4 treats a bare `z.undefined()` object field as a
 *   required key (`expected nonoptional`), hence the `.optional()` — the
 *   custom message still fires when the key is present with a value.
 */
const tenantSecretParameterDefinitionSchema = z.object({
  name: z
    .string()
    .regex(
      TENANT_VARIABLE_KEY_PATTERN,
      'Secret parameter names must be lowercase letters, digits and underscores, and start with a letter'
    ),
  source: z.literal('tenantSecret'),
  variableKey: tenantVariableKeySchema,
  type: z.literal('string').default('string'),
  required: z.literal(true).default(true),
  defaultValue: z.undefined({ message: 'A secret parameter cannot carry a default value' }).optional(),
  options: z.undefined({ message: 'A secret parameter cannot declare options' }).optional(),
});

/**
 * One definition, discriminated on `source`, each arm requiring only its own
 * binding field.
 *
 * `unionFallback` is what makes the `source` default reachable. Zod's fast
 * discriminator path looks the RAW input value up in a map
 * (`disc.value.get(input[discriminator])`), which for a legacy definition with
 * no `source` key is `undefined` and matches nothing — the `.default()` never
 * gets a chance to run. With the fallback enabled, that one case falls through
 * to ordinary union matching, where the `runtime` arm applies its default and
 * succeeds. Inputs that DO carry a valid `source` still take the fast path and
 * still get arm-specific errors (e.g. a missing `variableKey` reports at
 * `["variableKey"]`, not as a five-branch union failure).
 */
export const scriptParameterDefinitionSchema = z.discriminatedUnion(
  'source',
  [
    runtimeParameterDefinitionSchema,
    tenantVariableParameterDefinitionSchema,
    deviceCustomFieldParameterDefinitionSchema,
    builtinParameterDefinitionSchema,
    tenantSecretParameterDefinitionSchema,
  ],
  { unionFallback: true }
);

export type ScriptParameterDefinition = z.infer<typeof scriptParameterDefinitionSchema>;

/**
 * The name the agent derives from a parameter key when building the child
 * process environment:
 * `"BREEZE_PARAM_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))`
 * (`agent/internal/executor/executor.go:339-341`). Kept as a function so the
 * collision rule below and any future consumer normalize identically to the
 * agent instead of re-deriving it.
 */
export function scriptParameterEnvSuffix(name: string): string {
  return name.toUpperCase().replaceAll('-', '_');
}

/** Full env var name, e.g. `log-level` -> `BREEZE_PARAM_LOG_LEVEL`. */
export function scriptParameterEnvName(name: string): string {
  return `BREEZE_PARAM_${scriptParameterEnvSuffix(name)}`;
}

/**
 * The env var the agent exports for a `tenantSecret` parameter:
 * `"BREEZE_VAR_" + strings.ToUpper(key)` (`SecretEnv.EnvKey`,
 * `agent/internal/executor/secretenv.go`). No `-` folding, unlike
 * {@link scriptParameterEnvName} — the tenant-key grammar admits no hyphen, so
 * there is nothing to fold. E.g. `api_token` -> `BREEZE_VAR_API_TOKEN`.
 */
export function scriptSecretEnvName(name: string): string {
  return `BREEZE_VAR_${name.toUpperCase()}`;
}

/**
 * Rejects two parameter names that collapse to the SAME `BREEZE_PARAM_*` env
 * var on the agent.
 *
 * This is a live nondeterminism bug, not a hypothetical. `log-level` and
 * `log_level` are distinct JS object keys, both pass every other check, and
 * both reach the agent — where they produce two `BREEZE_PARAM_LOG_LEVEL=`
 * entries in `Cmd.Env`. `exec.Cmd` keeps the LAST duplicate entry and Go
 * randomizes map iteration order, so which value wins varies between runs of
 * the same script on the same device. Uppercasing widens the equivalence
 * class further: `logLevel`, `LOGLEVEL` and `loglevel` all collide too.
 *
 * The rule keys on `name` for EVERY arm, `tenantSecret` included. A secret and
 * a runtime parameter sharing a name land in different env vars
 * (`BREEZE_VAR_` vs `BREEZE_PARAM_`) but are still one parameter name in the
 * run modal and the definition list, so they are rejected as duplicates.
 *
 * Exported separately from the array schema so a caller that needs a different
 * length cap can rebuild the array without re-implementing the rule.
 */
export function refineScriptParameterKeyCollisions(
  definitions: ReadonlyArray<{ name: string }>,
  ctx: z.RefinementCtx
): void {
  const seen = new Map<string, string>();
  definitions.forEach((definition, index) => {
    const envSuffix = scriptParameterEnvSuffix(definition.name);
    const first = seen.get(envSuffix);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message:
          first === definition.name
            ? `Duplicate parameter name "${definition.name}"`
            : `Parameter "${definition.name}" collides with "${first}": both become ${scriptParameterEnvName(definition.name)} on the device`,
      });
      return;
    }
    seen.set(envSuffix, definition.name);
  });
}

/**
 * How many `tenantSecret` parameters one script may declare (#3409 PR4c-2).
 *
 * This MUST equal `MAX_SECRET_ENV_ENTRIES` in
 * `apps/api/src/services/scriptSecretEnvelope.ts`, which is the AUTHORITY —
 * it is the bound the sealed `secretEnv` envelope actually enforces at
 * dispatch. It is restated here rather than imported because `packages/shared`
 * must not depend on `apps/api`; the two are pinned together by an equality
 * assertion in `apps/api/src/services/scriptBundle/index.test.ts`, so they
 * cannot drift.
 *
 * Deliberately LOWER than {@link MAX_SCRIPT_PARAMETERS} (64). Without a
 * save-time rule a script declaring 33+ secret parameters saves cleanly and
 * then throws inside `encryptSensitivePayloadFields` at dispatch — inside
 * `scriptDispatch`'s guarded region, which RETHROWS, and
 * `executeScriptOnDevices` does not wrap the per-device call. The result is a
 * 500 with an internal message that kills the ENTIRE fan-out, not one device.
 */
export const MAX_SECRET_SCRIPT_PARAMETERS = 32;

/**
 * Rejects more `tenantSecret` parameters than the secret-delivery envelope can
 * carry. Reported on the FIRST over-limit element's `source` (not on the whole
 * array) so the web form can point at the parameter the tech should remove,
 * and so it never masks the array-level {@link MAX_SCRIPT_PARAMETERS} cap.
 *
 * Exported alongside {@link refineScriptParameterKeyCollisions} for the same
 * reason: a caller rebuilding the array with a different length cap must be
 * able to reapply this rule without re-implementing it.
 */
export function refineSecretScriptParameterCap(
  definitions: ReadonlyArray<{ source?: string }>,
  ctx: z.RefinementCtx
): void {
  let secretCount = 0;
  definitions.forEach((definition, index) => {
    if (definition.source !== 'tenantSecret') return;
    secretCount += 1;
    if (secretCount <= MAX_SECRET_SCRIPT_PARAMETERS) return;
    ctx.addIssue({
      code: 'custom',
      path: [index, 'source'],
      message: `A script cannot declare more than ${MAX_SECRET_SCRIPT_PARAMETERS} secret parameters`,
    });
  });
}

/**
 * The array as stored in `scripts.parameters`. Capped at
 * {@link MAX_SCRIPT_PARAMETERS}, the same bound the run-time value map uses —
 * a definition list longer than the value map could accept would declare
 * parameters that can never be supplied. `tenantSecret` rows carry the
 * additional, tighter {@link MAX_SECRET_SCRIPT_PARAMETERS} cap.
 */
export const scriptParameterDefinitionsSchema = z
  .array(scriptParameterDefinitionSchema)
  .max(MAX_SCRIPT_PARAMETERS, `A script cannot declare more than ${MAX_SCRIPT_PARAMETERS} parameters`)
  .superRefine(refineScriptParameterKeyCollisions)
  .superRefine(refineSecretScriptParameterCap);

/**
 * Parse an unvalidated stored/incoming value into normalized definitions.
 * `null` / `undefined` (the column is nullable) normalize to `[]`. Returns
 * `null` when the value is not a valid definition list — callers must decide
 * what an unparseable legacy value means for them rather than getting a
 * silently empty array.
 */
export function normalizeScriptParameterDefinitions(value: unknown): ScriptParameterDefinition[] | null {
  if (value === null || value === undefined) return [];
  const parsed = scriptParameterDefinitionsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Stable serialization of one definition — key order independent, arm aware.
 * Sorted by UTF-16 CODE POINT (`<` / `>`), never `localeCompare`: the output
 * feeds a hash that must be byte-reproducible across processes, and
 * `localeCompare` depends on the runtime's ICU data and default locale. */
function canonicalizeDefinition(definition: ScriptParameterDefinition): string {
  const entries = Object.entries(definition as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Canonical serialization of a whole definition list, or `null` when the value
 * is not a valid definition list.
 *
 * Two lists describe the same parameter contract exactly when their canonical
 * strings are equal — {@link scriptParameterDefinitionsEqual} is defined in
 * terms of this function precisely so the two can never drift. The string is
 * also the form a HASH of the contract should be taken over (#3409 PR4c pins
 * `scripts.parameters` into the `run_script` effect digest): it is normalized
 * through the schema, so a legacy `{name,type}` and its default-materialized
 * equivalent serialize identically, and it is object-key-order independent,
 * so a jsonb round-trip that reorders keys is not mistaken for a change.
 *
 * Element ORDER is significant (parameter order is user-visible in the run
 * modal), so the list is not sorted.
 */
export function canonicalizeScriptParameterDefinitions(value: unknown): string | null {
  const normalized = normalizeScriptParameterDefinitions(value);
  if (normalized === null) return null;
  return JSON.stringify(normalized.map(canonicalizeDefinition));
}

/**
 * Do two definition lists describe the same parameter contract?
 *
 * Both sides are normalized through the schema first, so a legacy stored
 * definition (`{name,type}`) compares equal to the same definition after the
 * schema materializes its `required:false` / `source:'runtime'` defaults —
 * without this, every save of an untouched legacy script would look like a
 * change. Order IS significant: parameter order is user-visible in the run
 * modal.
 *
 * An unparseable value on either side returns `false` (i.e. "changed"), which
 * is the safe answer for the one caller that matters: `script.version` gets
 * bumped rather than silently held back. Note this means two IDENTICALLY
 * unparseable values are still reported as changed — deliberate, and the
 * reason this is not simply `canonical(a) === canonical(b)` with nulls
 * compared.
 */
export function scriptParameterDefinitionsEqual(a: unknown, b: unknown): boolean {
  const left = canonicalizeScriptParameterDefinitions(a);
  const right = canonicalizeScriptParameterDefinitions(b);
  if (left === null || right === null) return false;
  return left === right;
}
