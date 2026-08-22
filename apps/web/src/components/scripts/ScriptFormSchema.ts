import { z } from 'zod';
import {
  scriptParameterDefinitionSchema,
  scriptParameterDefinitionsSchema,
  type ScriptParameterSource,
} from '@breeze/shared';
import type { ScriptLanguage, OSType } from './ScriptList';

/**
 * Re-exported from `@breeze/shared` rather than redeclared: this shape used to
 * be hand-mirrored here, in `validators/ai.ts` and in `scriptBuilderTools.ts`,
 * with the API accepting `z.any()`. `scriptParameterDefinitionsSchema` also
 * carries the array-level env-var collision rule (`log-level` vs `log_level`),
 * which no local copy had (#3409 PR3).
 */
export const parameterSchema = scriptParameterDefinitionSchema;

export const severityValues = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof severityValues)[number];

// Sentinel used in form-row state to represent the wire-shape `null`
// (explicitly suppress the alert for this exit code). Kept as a string so
// `<select>` values and `register()` round-trip cleanly; converted to/from
// `null` at the form boundary by rowsToMapping / mappingToRows.
export const SUPPRESS_SEVERITY = '__suppress__' as const;
export type SeverityRowValue = Severity | typeof SUPPRESS_SEVERITY;

// Form-side representation of one exit-code → severity mapping row. Stored as
// a list during editing so order is stable and each row owns its own state;
// converted to/from the wire `Record<string, severity | null>` at form boundaries.
export const exitCodeSeverityRowSchema = z.object({
  exitCode: z.string().regex(/^\d+$/, 'Exit code must be a non-negative integer'),
  severity: z.enum([...severityValues, SUPPRESS_SEVERITY]),
});

export const scriptSchema = z.object({
  name: z.string().min(1, 'Script name is required'),
  description: z.string().optional(),
  category: z.string().min(1, 'Category is required'),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1, 'Select at least one OS'),
  content: z.string().min(1, 'Script content is required'),
  parameters: scriptParameterDefinitionsSchema.optional(),
  timeoutSeconds: z.coerce
    .number({ error: 'Enter a timeout value' })
    .int('Timeout must be a whole number')
    .min(1, 'Timeout must be at least 1 second')
    // 3600 = agent-side executor hard cap; larger values would be silently
    // clamped to 1 hour on the device (#2398).
    .max(3600, 'Timeout cannot exceed 1 hour (3600 seconds)'),
  runAs: z.enum(['system', 'user', 'elevated']),
  exitCodeSeverityMapping: z
    .array(exitCodeSeverityRowSchema)
    .optional()
    .superRefine((rows, ctx) => {
      if (!rows) return;
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        if (seen.has(row.exitCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'exitCode'],
            message: `Duplicate exit code ${row.exitCode}`,
          });
        }
        seen.add(row.exitCode);
      });
    }),
  // Who this script is available to when creating. Only relevant on create for
  // partner-scope users with >1 org; backend ignores it for org-scope users.
  availability: z.enum(['org', 'partner']).optional(),
  // orgId for the "specific organization" case (availability: 'org').
  orgId: z.string().optional(),
});

export type ScriptFormValues = z.infer<typeof scriptSchema>;
/**
 * The INPUT type, deliberately: `ScriptParameter` types definitions read back
 * from the API, and every definition stored before #3409 PR3 has no `source`
 * key (and often no `required`). The output type would claim both are always
 * present, which is false for exactly the rows the UI spends most of its time
 * rendering. Reading `source` therefore correctly forces a `?? 'runtime'`.
 */
export type ScriptParameter = z.input<typeof parameterSchema>;
export type ExitCodeSeverityRow = z.infer<typeof exitCodeSeverityRowSchema>;

/**
 * What a caller may hand `ScriptForm` as `defaultValues`.
 *
 * `parameters` is the INPUT type: definitions come back from the API exactly as
 * they were stored, and every one written before #3409 PR3 lacks `source` (and
 * often `required`). Typing this half as the schema OUTPUT would make the
 * majority of real edit-page loads a type error while changing nothing about
 * what the form actually receives.
 */
export type ScriptFormDefaults = Partial<Omit<ScriptFormValues, 'parameters'>> & {
  parameters?: ScriptParameter[];
};

/**
 * Where this parameter's value comes from (#3409 PR3).
 *
 * Every definition stored before PR3 omits `source` entirely, so the fallback
 * is not defensive padding — it is the shape the majority of rows still have.
 * Read the source ONLY through this helper so no surface can drift into
 * treating a legacy row as unbound-by-accident rather than
 * unbound-by-definition.
 */
export function parameterSource(parameter: ScriptParameter): ScriptParameterSource {
  return parameter.source ?? 'runtime';
}

/**
 * Is this parameter supplied by the server per target device rather than by
 * the invoker? Bound parameters are never prompted for, never required of the
 * invoker, and must never appear in the outgoing parameters map — a supplied
 * value would be ignored and reported back in `ignoredParameters`.
 */
export function isBoundParameter(parameter: ScriptParameter): boolean {
  return parameterSource(parameter) !== 'runtime';
}

/** The parameters a run surface actually prompts for. */
export function runtimeParameters(
  parameters: readonly ScriptParameter[] | undefined
): ScriptParameter[] {
  return (parameters ?? []).filter(parameter => !isBoundParameter(parameter));
}

/**
 * The binding target as a display string — the tenant-variable key, the device
 * custom-field key, or the built-in property name. `null` for a runtime
 * parameter, and for a bound row whose key hasn't been chosen yet (mid-edit in
 * the authoring form).
 */
export function parameterBindingKey(parameter: ScriptParameter): string | null {
  switch (parameter.source) {
    case 'tenantVariable':
      return parameter.variableKey || null;
    case 'deviceCustomField':
      return parameter.fieldKey || null;
    case 'builtin':
      return parameter.builtinKey || null;
    // A secret parameter names the variable it binds, exactly like the plain
    // `tenantVariable` arm — the KEY is not sensitive, only the value is, and
    // the run surfaces have to be able to say what will be injected.
    case 'tenantSecret':
      return parameter.variableKey || null;
    default:
      return null;
  }
}

/**
 * Is this parameter delivered as a SECRET environment variable (#3409 PR4c-2)?
 *
 * Secrets ride `BREEZE_VAR_<NAME>` in the sealed envelope, which the user-context
 * helper IPC cannot carry — so run surfaces have to know a script contains one
 * before the operator picks a run context.
 */
export function isSecretParameter(parameter: ScriptParameter): boolean {
  return parameterSource(parameter) === 'tenantSecret';
}

/** Does this parameter list contain at least one secret-backed parameter? */
export function hasSecretParameters(parameters: readonly ScriptParameter[] | undefined): boolean {
  return (parameters ?? []).some(isSecretParameter);
}

/**
 * Would the server refuse to deliver a secret for a run with this context
 * (#3409 PR4c-2)?
 *
 * The ONE web-side mirror of `runAsSupportsSecretEnv`
 * (`apps/api/src/services/scriptSecretDelivery.ts`), which itself mirrors the
 * agent's `runAsSupportsSecrets`: the secret rides an environment variable in
 * the sealed command envelope, and a user-context run OR a run aimed at a
 * specific session is executed through the helper IPC, which carries no
 * environment. `elevated` and an unset run-as both run under the service, so
 * both are fine.
 *
 * Both halves matter, and a surface that states only the run-as half tells the
 * operator a half-truth — hence one shared predicate rather than a per-modal
 * `runAs === 'user'` check that a surface gaining a session picker would
 * silently inherit.
 *
 * ADVISORY ONLY. The server gate is authoritative; no run surface may block on
 * this.
 */
export function secretsBlockedForRun(run: {
  runAs?: 'system' | 'user' | 'elevated' | null;
  targetSessionId?: number | null;
}): boolean {
  // `!= null` on purpose: session 0 is a real Windows session id, so a
  // truthiness check would silently allow the one case the server refuses.
  if (run.targetSessionId != null) return true;
  return run.runAs === 'user';
}

/**
 * Drop the fields a `tenantSecret` row may not carry, and force the two the
 * schema pins (#3409 PR4c-2).
 *
 * The authoring form seeds every new parameter row with `defaultValue: ''` and
 * `options: ''`, and RHF keeps a field's value when its input unmounts. An
 * empty string is a PRESENT value, and the secret arm rejects a present
 * `defaultValue`/`options` outright ("A secret parameter cannot carry a default
 * value") — so a row switched to `tenantSecret` would fail validation on data
 * the user never typed and can no longer see. Sanitizing on the way INTO the
 * resolver fixes both halves at once: validation sees the real contract, and
 * the sanitized object is what `handleSubmit` hands the caller, so no empty
 * string reaches the API either.
 *
 * Deliberately not a schema `.transform()`: the same normalization has to apply
 * before the union picks an arm, and a transform runs after.
 */
export function stripSecretParameterValueFields<T>(values: T): T {
  const record = values as { parameters?: unknown } | null;
  const parameters = record?.parameters;
  if (!Array.isArray(parameters)) return values;
  let changed = false;
  const next = parameters.map(parameter => {
    const row = parameter as Record<string, unknown> | null;
    if (!row || row.source !== 'tenantSecret') return parameter;
    changed = true;
    const { defaultValue: _default, options: _options, ...rest } = row;
    return { ...rest, type: 'string', required: true };
  });
  if (!changed) return values;
  return { ...(record as object), parameters: next } as T;
}

// Wire shape sent to / received from the API. Form-side editing keeps an
// ordered list of rows for stable React keys + per-row error display; we
// convert at the form boundary. `null` = explicitly suppress the alert for
// that exit code (distinct from omitting the key, which falls back to
// script-level default handling).
export type ExitCodeSeverityMapping = Record<string, Severity | null>;

export type ScriptSubmitValues = Omit<ScriptFormValues, 'exitCodeSeverityMapping'> & {
  exitCodeSeverityMapping?: ExitCodeSeverityMapping;
  availability?: 'org' | 'partner';
  orgId?: string | null;
};

export function rowsToMapping(rows: ExitCodeSeverityRow[] | undefined): ExitCodeSeverityMapping | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows.reduce<ExitCodeSeverityMapping>((acc, { exitCode, severity }) => {
    acc[exitCode] = severity === SUPPRESS_SEVERITY ? null : severity;
    return acc;
  }, {});
}

export function mappingToRows(mapping: ExitCodeSeverityMapping | null | undefined): ExitCodeSeverityRow[] {
  if (!mapping) return [];
  return Object.entries(mapping)
    .map<ExitCodeSeverityRow>(([exitCode, severity]) => ({
      exitCode,
      severity: severity === null ? SUPPRESS_SEVERITY : severity,
    }))
    .sort((a, b) => Number(a.exitCode) - Number(b.exitCode));
}

export const severityOptions: { value: SeverityRowValue; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
  { value: SUPPRESS_SEVERITY, label: 'Suppress alert' },
];

export const languageOptions: { value: ScriptLanguage; label: string; monacoLang: string }[] = [
  { value: 'powershell', label: 'PowerShell', monacoLang: 'powershell' },
  { value: 'bash', label: 'Bash', monacoLang: 'shell' },
  { value: 'python', label: 'Python', monacoLang: 'python' },
  { value: 'cmd', label: 'CMD (Batch)', monacoLang: 'bat' }
];

export const categoryOptions = [
  'Maintenance',
  'Security',
  'Monitoring',
  'Deployment',
  'Backup',
  'Network',
  'User Management',
  'Software',
  'Custom'
];

export const runAsOptions: { value: 'system' | 'user' | 'elevated'; label: string; description: string }[] = [
  { value: 'system', label: 'System', description: 'Run as the system/root account' },
  { value: 'user', label: 'Current User', description: 'Run as the logged-in user' },
  { value: 'elevated', label: 'Elevated', description: 'Run with administrator privileges' }
];

export const parameterTypeOptions: { value: 'string' | 'number' | 'boolean' | 'select'; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'select', label: 'Select' }
];
