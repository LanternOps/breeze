import { z } from 'zod';
import { MAX_SCRIPT_PARAMETERS, MAX_SCRIPT_PARAMETER_VALUE_LENGTH, SCRIPT_PARAMETER_KEY_PATTERN } from './scriptParameters';
import { tenantVariableKeySchema } from './tenantVariables';

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
 */
export const SCRIPT_PARAMETER_SOURCES = ['runtime', 'tenantVariable', 'deviceCustomField', 'builtin'] as const;
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
 * `["variableKey"]`, not as a four-branch union failure).
 */
export const scriptParameterDefinitionSchema = z.discriminatedUnion(
  'source',
  [
    runtimeParameterDefinitionSchema,
    tenantVariableParameterDefinitionSchema,
    deviceCustomFieldParameterDefinitionSchema,
    builtinParameterDefinitionSchema,
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
 * The array as stored in `scripts.parameters`. Capped at
 * {@link MAX_SCRIPT_PARAMETERS}, the same bound the run-time value map uses —
 * a definition list longer than the value map could accept would declare
 * parameters that can never be supplied.
 */
export const scriptParameterDefinitionsSchema = z
  .array(scriptParameterDefinitionSchema)
  .max(MAX_SCRIPT_PARAMETERS, `A script cannot declare more than ${MAX_SCRIPT_PARAMETERS} parameters`)
  .superRefine(refineScriptParameterKeyCollisions);

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

/** Stable serialization of one definition — key order independent, arm aware. */
function canonicalizeDefinition(definition: ScriptParameterDefinition): string {
  const entries = Object.entries(definition as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
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
 * bumped rather than silently held back.
 */
export function scriptParameterDefinitionsEqual(a: unknown, b: unknown): boolean {
  const left = normalizeScriptParameterDefinitions(a);
  const right = normalizeScriptParameterDefinitions(b);
  if (left === null || right === null) return false;
  if (left.length !== right.length) return false;
  return left.every((definition, index) => {
    const other = right[index];
    return other !== undefined && canonicalizeDefinition(definition) === canonicalizeDefinition(other);
  });
}
