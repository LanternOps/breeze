import { z } from 'zod';

/**
 * Script execution parameters (#3409 PR2 Task 7) — the ONE schema for the
 * `parameters` map a caller attaches to a script run, used at every ingress
 * (manual execute, mobile device action, automation `run_script` action) and
 * canonicalized once at dispatch.
 *
 * Why this exists: the agent's wire type is `map[string]string`
 * (`agent/internal/executor/executor.go:39`) and the heartbeat decoder
 * silently DROPS any parameter whose JSON value isn't already a string
 * (`agent/internal/heartbeat/handlers_script.go:37-43`, `if s, ok := v.(string); ok`).
 * The web UI actively produces real JSON numbers and booleans
 * (`apps/web/src/components/scripts/ScriptExecutionModal.tsx:83-91`), so a
 * `number`/`boolean` parameter left `{{name}}` unsubstituted in the script and
 * never set `BREEZE_PARAM_*`. Accepting those JSON types here — then
 * canonicalizing every value to a string before it reaches the wire — fixes
 * that without touching the Go agent.
 */

/**
 * The agent turns each key into an env var name via
 * `"BREEZE_PARAM_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))`
 * (`agent/internal/executor/executor.go:329-343`), which only normalizes a
 * literal `-`. A key containing a space, a dot, an `=`, or any other
 * shell-meaningful character produces an env var name that is either
 * unusable (silently dropped by the shell/`os.Environ` builder) or, worse,
 * injectable (`=` splits an env entry into two). Restricting keys to this
 * pattern up front guarantees every accepted key survives that
 * transformation as a single well-formed `BREEZE_PARAM_<NAME>` entry.
 */
export const SCRIPT_PARAMETER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Mirrors the agent's `Parameters map[string]string` payload cap concerns:
 * bounds both the per-request JSON size and the number of `BREEZE_PARAM_*`
 * env vars injected into the child process.
 */
export const MAX_SCRIPT_PARAMETERS = 64;

/**
 * Measured against the CANONICALIZED string form (post `String(value)`), not
 * the raw JSON input — a number/boolean's canonical string is always
 * shorter than or equal to any pathological raw representation, and this is
 * the value that actually lands in the env var / substituted template.
 */
export const MAX_SCRIPT_PARAMETER_VALUE_LENGTH = 4096;

const scriptParameterKeySchema = z
  .string()
  .regex(
    SCRIPT_PARAMETER_KEY_PATTERN,
    'Parameter names must start with a letter or underscore and contain only letters, digits, and underscores'
  );

const scriptParameterValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

/**
 * The single script-parameter schema. Accepts strings, finite numbers, and
 * booleans — rejects null, undefined, objects, arrays, NaN, and Infinity
 * (all rejected implicitly: `z.union` above has no branch for them, and
 * `.finite()` excludes NaN/Infinity from the number branch).
 */
export const scriptParametersSchema: z.ZodType<Record<string, string | number | boolean>> = z
  .record(scriptParameterKeySchema, scriptParameterValueSchema)
  .refine((val) => Object.keys(val).length <= MAX_SCRIPT_PARAMETERS, {
    message: `Cannot supply more than ${MAX_SCRIPT_PARAMETERS} script parameters`,
  })
  .refine(
    (val) => Object.values(val).every((v) => String(v).length <= MAX_SCRIPT_PARAMETER_VALUE_LENGTH),
    { message: `Each script parameter value must canonicalize to at most ${MAX_SCRIPT_PARAMETER_VALUE_LENGTH} characters` }
  );

/**
 * Canonicalizes every parameter value to its string wire form —
 * `String(value)`, i.e. `3` -> `'3'`, `true` -> `'true'` — so the payload
 * that reaches the agent is always `map[string]string`, matching
 * `agent/internal/executor/executor.go:39` exactly. Call this ONCE, at the
 * single dispatch chokepoint (`scriptDispatch.ts`), so every ingress —
 * including ones that don't validate through `scriptParametersSchema`
 * directly — gets string values on the wire.
 */
export function canonicalizeScriptParameters(
  input: Record<string, string | number | boolean>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = String(value);
  }
  return result;
}
