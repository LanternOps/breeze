import {
  hasVariableTokens,
  SCRIPT_BUILTIN_PARAMETER_KEYS,
  scriptParameterDefinitionSchema,
  type ScriptBuiltinParameterKey,
  type ScriptParameterDefinition,
  type ScriptParameterSource,
} from '@breeze/shared';

import type { ResolvedVariable } from './tenantVariableResolution';

/**
 * Sourced script parameters (#3409 PR3) — per-device resolution of a script's
 * parameter DEFINITIONS into the value map that reaches the agent.
 *
 * This module is deliberately pure: no DB access, no ambient context, no
 * clock. Everything it needs — the device row's own columns, the org/site
 * display names, and the already-resolved tenant-variable map for the
 * device's org — is handed in by `scriptDispatch.ts`, which owns the loading.
 * That is what makes the precedence table below exhaustively unit-testable
 * without a database, and it keeps the ONE place that decides "what value
 * does this parameter have on this device" free of any I/O that could fail
 * halfway and leave a half-resolved map.
 *
 * The precedence table (plan §2.1) is the whole point of the module:
 *
 *   BOUND   (source !== 'runtime'):  source value -> definition default -> missing
 *   RUNTIME (source === 'runtime'):  caller value -> definition default -> missing
 *
 * A caller-supplied value is NOT a candidate for a bound parameter. If it
 * were, a binding would be a suggested default rather than an authoritative
 * source, and an invoker could override the org's configured value simply by
 * naming the key. The supplied value is ignored (not rejected — see
 * {@link ResolveSourcedParametersSuccess.ignoredParameters}) and reported.
 *
 * #3409 PR4c-2 adds one exception to the table, not a new rule inside it: a
 * `tenantSecret` binding has no default and no caller candidate at all, so its
 * precedence is simply `secret variable -> fail the device`, and its value
 * leaves through {@link ResolveSourcedParametersSuccess.secretEnv} rather than
 * `parameters`. That arm additionally carries a PRIVILEGE gate — a script may
 * resolve a secret at or below its own ownership tier, never above (see
 * {@link ResolveSourcedParametersInput.scriptOwnerScope}) — which is why this
 * otherwise device-only resolver is told about the SCRIPT's ownership too.
 */

/** Where `scriptDispatch` reads device-scoped sources from. */
export interface SourcedParameterDevice {
  id: string;
  orgId: string;
  hostname: string | null;
  siteId: string | null;
  /** `devices.custom_fields`, raw JSONB — arbitrary shape until proven otherwise. */
  customFields: unknown;
}

/**
 * The two builtin values that are NOT columns on the device row and therefore
 * need a lookup the caller performs. Both are optional: a script with no
 * `org.name` / `site.name` binding never causes the lookup, and an absent
 * name resolves as missing (default -> required check) rather than throwing.
 */
export interface SourcedParameterNameContext {
  orgName?: string | null;
  siteName?: string | null;
}

/**
 * What dispatch PERSISTS about a bound parameter — identity, never value
 * (plan §3 P4). A resolved value exists only in the command payload that
 * reaches the agent; putting one in `script_executions.parameters` would, in
 * PR4, mean persisting a resolved secret, which is exactly the leak the
 * separate delivery channel exists to prevent.
 *
 * Emitted only for BOUND parameters. A runtime parameter's value is already
 * persisted as a value (it is caller input, in the caller's trust domain), so
 * a descriptor for it would carry no information.
 */
export interface ScriptParameterBindingDescriptor {
  key: string;
  source: ScriptParameterSource;
  /** Present only when the value actually came from a tenant_variables row. */
  variableId?: string;
  ownerScope?: 'organization' | 'partner';
  version?: number;
}

export interface ResolveSourcedParametersInput {
  /** `scripts.parameters` exactly as stored — unvalidated jsonb. */
  definitions: unknown;
  /** The invoker's parameter map (`input.parameters ?? {}` at the dispatch seam). */
  callerParameters: Record<string, unknown>;
  device: SourcedParameterDevice;
  names?: SourcedParameterNameContext;
  /**
   * The tenant-variable map for THIS device's org — i.e. `resolveForOrg(scope,
   * device.orgId)`. Required only when a `tenantVariable` binding is present;
   * an absent map with such a binding is a programming error at the call site
   * and throws, matching the content-substitution path's contract.
   */
  variables?: ReadonlyMap<string, ResolvedVariable>;
  /**
   * Variable keys for this device's org whose row EXISTS but could not be
   * decrypted — i.e. `unreadableForOrg(scope, device.orgId)` (#3409 PR4c-1).
   *
   * Deliberately a second collection rather than sentinel entries in
   * {@link variables}: an unreadable variable must never resolve to a value,
   * and `resolveForOrg`'s map is the "has a value" channel by contract.
   *
   * Optional, and omitting it is not a silent downgrade of anything the
   * resolver would otherwise get right — a key that is unreadable is absent
   * from `variables` either way, so the only difference is WHICH failure the
   * operator is shown ({@link SourceLookup} `'unreadable'` vs `'missing'`).
   * That difference matters: "not set" tells a tech to create the variable,
   * while unreadable means the ciphertext is present and the KEY MATERIAL is
   * wrong — and creating a duplicate mid-rotation is the opposite of the fix.
   */
  unreadableVariableKeys?: ReadonlySet<string>;
  /**
   * The OWNERSHIP TIER of the script being dispatched — `'partner'` for a
   * partner-wide script (`scripts.org_id IS NULL`), `'organization'` for an
   * org-owned one. Derived at the dispatch seam from the script row itself.
   *
   * Enforces one rule, on the `tenantSecret` arm only (#3409 PR4c-2 review):
   *
   *   a script may resolve a secret AT OR BELOW its own ownership tier,
   *   never above.
   *
   * | script       | variable `ownerScope` | outcome |
   * |--------------|-----------------------|---------|
   * | partner-wide | `'partner'`           | allow   |
   * | partner-wide | `'organization'`      | allow — the primary use case: one partner-wide script, each target org's own value resolved per device |
   * | org-owned    | `'organization'`      | allow (necessarily this org's own row — dispatch enforces script/device org equality) |
   * | org-owned    | `'partner'`           | DENY    |
   *
   * REQUIRED, not optional, and deliberately so: an omitted tier would have to
   * default to something, and either default is wrong — `'partner'` opens the
   * escalation for every caller that forgets, while `'organization'` breaks the
   * per-org use case silently. A missing value is a compile error instead.
   *
   * This check is the AUTHORITATIVE one. Save-time validation cannot replace
   * it: variable-key uniqueness is PER SCOPE
   * (`tenant_variables_org_key_uniq` / `tenant_variables_partner_key_uniq`),
   * so an org admin can create an org-owned secret that SHADOWS a partner-wide
   * key, pass a save-time gate against their own row, then delete it — after
   * which `resolveForOrg` inherits the partner-wide row. Binding a key that
   * does not exist yet reaches the same place. Only dispatch, which holds the
   * script row and the freshly-resolved variable, can see the pair that
   * actually ships.
   */
  scriptOwnerScope: 'organization' | 'partner';
}

export interface ResolveSourcedParametersSuccess {
  ok: true;
  /** The map that goes on the wire — caller runtime values plus resolved bound values. */
  parameters: Record<string, string | number | boolean>;
  /** Identity-only record of the bound parameters, for `script_executions`. */
  bindings: ScriptParameterBindingDescriptor[];
  /**
   * Resolved SECRET values, keyed by parameter name (#3409 PR4c-2). Always
   * present; `{}` for the overwhelming majority of scripts.
   *
   * Deliberately a SEPARATE map from {@link parameters}: the agent substitutes
   * every entry of `parameters` into the script text and mirrors it as
   * `BREEZE_PARAM_*`, so a secret placed there would be written into the
   * script body, echoed by `-x` tracing and persisted in the command payload.
   * These entries instead ride the sealed `secretEnv` envelope and reach the
   * child process only as `BREEZE_VAR_<UPPER(name)>`.
   *
   * Values are NOT re-validated here. The envelope's `validateSecretEnv`
   * (`services/scriptSecretEnvelope.ts`) is the single authority for the wire
   * rules (key grammar, 4..4096 length); the key grammar is already
   * guaranteed by the `tenantSecret` arm's `name` regex, and the minimum
   * length by `MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH` at variable save
   * (`services/tenantVariables.ts`). Duplicating either check here would give
   * two places to disagree.
   */
  secretEnv: Record<string, string>;
  /** Bound keys the caller supplied a value for. Ignored, never rejected (plan §2.2). */
  ignoredParameters: string[];
}

export interface ResolveSourcedParametersFailure {
  ok: false;
  /**
   * Deliberately DISTINCT from PR2's `unresolved_variables`: a parameter
   * binding failing is not the same operational condition as a `{{var.*}}`
   * token in the content failing, and conflating them would make the two
   * indistinguishable in execution history.
   */
  code: 'unresolved_parameters';
  /** Names KEYS only, never values — this string reaches `script_executions.error_message`. */
  error: string;
  ignoredParameters: string[];
}

export type ResolveSourcedParametersResult =
  | ResolveSourcedParametersSuccess
  | ResolveSourcedParametersFailure;

/**
 * Reserved key under which the binding descriptors ride inside the existing
 * `script_executions.parameters` jsonb.
 *
 * Chosen over a new sibling column because PR3 ships NO migration (plan §7) —
 * and a new column on an org-cascade table is not a free action here: it
 * would also require a `CORE_TENANT_EXPORT_POLICY` classification, which is
 * the registration step this repo has shipped bugs on five times.
 *
 * `$` cannot begin a parameter name (`SCRIPT_PARAMETER_KEY_PATTERN` requires
 * `[A-Za-z_]` first), so this key can never collide with a real parameter,
 * and readers that render the map as key/value pairs see one extra,
 * obviously-reserved entry rather than a corrupted parameter.
 */
export const EXECUTION_PARAMETER_BINDINGS_KEY = '$bindings';

/**
 * Blank rule, mirroring the installer resolver (`installerVariables.ts:91-95`)
 * and widened by plan §2.1 to whitespace-only: a device must never ship a
 * parameter whose value is a blank segment, so `null`, absent, `''` and
 * `'   '` are all "no value" and fall through to the next precedence step.
 *
 * Non-primitive JSONB (an object or array in `custom_fields`) also counts as
 * blank: `String(value)` on it produces `[object Object]`, and injecting that
 * into a `BREEZE_PARAM_*` env var is worse than reporting the parameter
 * unresolved.
 */
function toNonBlankString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  const asString = String(value);
  return asString.trim() === '' ? undefined : asString;
}

/** A definition element we could not parse, retained so a BOUND one can fail loudly. */
interface MalformedDefinition {
  name: string | null;
  boundSource: string | null;
}

interface ParsedDefinitions {
  definitions: ScriptParameterDefinition[];
  malformed: MalformedDefinition[];
}

function readSource(element: unknown): string | null {
  if (element === null || typeof element !== 'object') return null;
  const source = (element as { source?: unknown }).source;
  return typeof source === 'string' ? source : null;
}

function readName(element: unknown): string | null {
  if (element === null || typeof element !== 'object') return null;
  const name = (element as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/**
 * Parse the stored definition list ELEMENT BY ELEMENT rather than through
 * `scriptParameterDefinitionsSchema` as a whole.
 *
 * `scripts.parameters` was `z.any()` until this PR, so a live database
 * contains definition lists that do not satisfy the new schema. Parsing the
 * whole array would make one malformed legacy element (say, a stray
 * `{name:'x'}` with no `type`) discard EVERY definition in the list —
 * including a `tenantVariable` binding to a secret, whose whole purpose is to
 * deny. Per element instead:
 *
 * - parses           -> honoured normally
 * - fails, unbound   -> ignored, exactly as before PR3 (nothing validated it then either)
 * - fails, BOUND     -> fails the device; a binding we cannot read is never
 *                       silently downgraded to "the caller may supply it"
 *
 * The array-level rules the full schema adds (length cap, env-var collision
 * `superRefine`) are save-time concerns, already enforced at the route; they
 * would only cause a dispatch-time false failure if applied here.
 */
function parseDefinitions(value: unknown): ParsedDefinitions {
  if (!Array.isArray(value)) return { definitions: [], malformed: [] };

  const definitions: ScriptParameterDefinition[] = [];
  const malformed: MalformedDefinition[] = [];
  for (const element of value) {
    const parsed = scriptParameterDefinitionSchema.safeParse(element);
    if (parsed.success) {
      definitions.push(parsed.data);
      continue;
    }
    const source = readSource(element);
    malformed.push({
      name: readName(element),
      boundSource: source !== null && source !== 'runtime' ? source : null,
    });
  }
  return { definitions, malformed };
}

/**
 * Does this script's stored definition list contain a binding to EITHER
 * variable-backed source — `tenantVariable` or `tenantSecret` (#3409 PR4c-2)?
 *
 * Both resolve out of the same `resolveForOrg` map, so both must open the
 * scope. The name is kept (it is exported and read at three preload sites)
 * because the question it answers is unchanged: "does dispatching this script
 * require the tenant-variable scope?"
 *
 * Deliberately tolerant — it scans raw elements rather than requiring the
 * whole list to parse. This predicate gates a CHEAP action (loading the
 * variable scope), so the failure it must avoid is a false negative: a list
 * with one unparseable element must not cause every binding in it to resolve
 * against an empty scope. For `tenantSecret` a false negative is worse still:
 * the resolver throws on an absent map rather than failing the device.
 */
export function hasTenantVariableBoundParameters(parameters: unknown): boolean {
  if (!Array.isArray(parameters)) return false;
  return parameters.some((element) => {
    const source = readSource(element);
    return source === 'tenantVariable' || source === 'tenantSecret';
  });
}

/**
 * The extended scope-preload gate (plan §3 P1).
 *
 * `hasVariableTokens(script.content)` alone is not sufficient once parameters
 * can bind to tenant variables: a binding lives in `scripts.parameters`, not
 * in the content, so a content-only gate passes `[]` to
 * `loadTenantVariableScope`, every bound parameter then resolves against an
 * EMPTY scope, and the device fails with "no value set" for a variable that
 * exists. Silent, and indistinguishable from a genuinely-unset variable.
 *
 * Used at all three preload sites: `scriptExecution.ts` (route fan-out),
 * `aiToolsScripts.ts` (AI run_script) and `loadAutomationRunVariableScope`
 * (automation runs).
 */
export function scriptNeedsVariableScope(script: {
  content?: string | null;
  parameters?: unknown;
}): boolean {
  return hasVariableTokens(script.content ?? '') || hasTenantVariableBoundParameters(script.parameters);
}

/**
 * Which builtin names the caller must look up before resolving. `org.id`,
 * `site.id` and `device.hostname` come off the device row for free; only the
 * two display names cost a query, so dispatch skips both queries entirely for
 * the overwhelming majority of scripts.
 */
export function builtinNameContextNeeds(definitions: unknown): { orgName: boolean; siteName: boolean } {
  if (!Array.isArray(definitions)) return { orgName: false, siteName: false };
  let orgName = false;
  let siteName = false;
  for (const element of definitions) {
    if (readSource(element) !== 'builtin') continue;
    const key = (element as { builtinKey?: unknown }).builtinKey;
    if (key === 'org.name') orgName = true;
    if (key === 'site.name') siteName = true;
  }
  return { orgName, siteName };
}

function resolveBuiltin(
  key: ScriptBuiltinParameterKey,
  device: SourcedParameterDevice,
  names: SourcedParameterNameContext,
): unknown {
  switch (key) {
    case 'org.name':
      return names.orgName;
    case 'org.id':
      return device.orgId;
    case 'site.name':
      return names.siteName;
    case 'site.id':
      return device.siteId;
    case 'device.hostname':
      return device.hostname;
  }
}

function readCustomField(customFields: unknown, fieldKey: string): unknown {
  if (customFields === null || typeof customFields !== 'object' || Array.isArray(customFields)) return undefined;
  return (customFields as Record<string, unknown>)[fieldKey];
}

/**
 * One bound parameter's source lookup, before default fallback.
 *
 * The two secret outcomes are opposites, one per variable-backed source, and
 * are kept distinct so neither can be reached from the wrong arm:
 *
 * - `secretAsPlain` — a `tenantVariable` binding whose target IS a secret.
 *   A policy denial (plan §2.4): secret delivery is declared, never inferred.
 * - `notSecret`     — a `tenantSecret` binding whose target is NOT a secret.
 *   Equally a denial: the author declared a credential channel, and quietly
 *   satisfying it from a plaintext row would deliver an unprotected value
 *   through a path that promises protection.
 * - `secretValue`   — the only success path for `tenantSecret`. The value
 *   goes to `secretEnv`, never to `parameters`.
 *
 * `partnerSecretAboveScriptScope` is the privilege denial: an ORG-owned script
 * reaching a PARTNER-WIDE secret. See
 * {@link ResolveSourcedParametersInput.scriptOwnerScope} for the full table
 * and why dispatch is the only place this can be decided.
 *
 * `unreadable` is a third denial, and the reason it is not folded into
 * `missing`: the variable's row exists, it simply could not be DECRYPTED
 * (see `tenantVariableResolution.ts`'s `decryptRow`). Reported as "no value
 * for required parameter", it sends a tech to create a duplicate variable —
 * exactly the wrong remediation during a key rotation, and one that leaves
 * the undecryptable row in place.
 */
type SourceLookup =
  | { kind: 'value'; value: string; descriptor: ScriptParameterBindingDescriptor }
  | { kind: 'missing' }
  | { kind: 'unreadable'; variableKey: string }
  | { kind: 'secretAsPlain'; variableKey: string }
  | { kind: 'notSecret'; variableKey: string }
  | { kind: 'partnerSecretAboveScriptScope'; variableKey: string }
  | { kind: 'secretValue'; value: string; descriptor: ScriptParameterBindingDescriptor };

/**
 * Why a variable key produced no entry in {@link ResolveSourcedParametersInput.variables}.
 *
 * Shared by both variable-backed arms, which had the identical confusion: the
 * map is the "has a readable value" channel, so an unreadable row and a
 * never-created one are both simply absent from it, and only the snapshot's
 * unreadable set can tell them apart.
 *
 * The map wins when it HAS the key: a listing here is only consulted on
 * absence, so a stale entry can never suppress a value that actually resolved.
 */
function lookupAbsent(variableKey: string, input: ResolveSourcedParametersInput): SourceLookup {
  if (input.unreadableVariableKeys?.has(variableKey)) return { kind: 'unreadable', variableKey };
  return { kind: 'missing' };
}

function lookupBoundSource(
  definition: Exclude<ScriptParameterDefinition, { source: 'runtime' }>,
  input: ResolveSourcedParametersInput,
): SourceLookup {
  switch (definition.source) {
    case 'tenantVariable': {
      if (!input.variables) {
        throw new Error(
          'variables map is required to dispatch a script with a tenantVariable-bound parameter',
        );
      }
      const variable = input.variables.get(definition.variableKey);
      if (!variable) return lookupAbsent(definition.variableKey, input);
      // PLAN §2.4 — a secret target is a POLICY DENIAL, not "missing". It must
      // not fall through to the definition default (which would silently
      // substitute a stale plaintext an operator deliberately reclassified),
      // must not fall back to a caller value, and must not be omitted.
      //
      // The denial is PERMANENT, not a placeholder: `tenantVariable` is the
      // plaintext channel, and its values are substituted into the script text
      // and mirrored as `BREEZE_PARAM_*`. There is exactly ONE way to deliver
      // a secret — an explicit `source: 'tenantSecret'` binding, which rides
      // the sealed `secretEnv` envelope. Do NOT "fix" this by routing a
      // secret-valued `tenantVariable` into `secretEnv`: secret delivery is
      // DECLARED by the script author, never inferred from what the target
      // variable happens to be classified as today.
      if (variable.isSecret) return { kind: 'secretAsPlain', variableKey: definition.variableKey };
      const value = toNonBlankString(variable.value);
      if (value === undefined) return { kind: 'missing' };
      return {
        kind: 'value',
        value,
        descriptor: {
          key: definition.name,
          source: 'tenantVariable',
          variableId: variable.variableId,
          ownerScope: variable.ownerScope,
          version: variable.version,
        },
      };
    }
    case 'tenantSecret': {
      if (!input.variables) {
        throw new Error(
          'variables map is required to dispatch a script with a tenantSecret-bound parameter',
        );
      }
      const variable = input.variables.get(definition.variableKey);
      // No default, no caller value, no omission — the arm is always
      // `required: true` and carries no `defaultValue` (the schema rejects
      // one), so a missing target can only fail the device.
      if (!variable) return lookupAbsent(definition.variableKey, input);
      if (!variable.isSecret) return { kind: 'notSecret', variableKey: definition.variableKey };
      // PRIVILEGE GATE — AFTER the `isSecret` check on purpose: a plaintext
      // partner-wide target must be reported as "not a secret" (reclassify it)
      // rather than as a tier violation ("make the script partner-wide"),
      // which would send the operator to fix the wrong thing.
      //
      // An org-scoped actor must not be able to have an MSP's partner-wide
      // credential sealed and delivered by a script they own. Applied to THIS
      // arm only, never to `tenantVariable`: a partner-wide NON-secret value is
      // already readable by an org session through the variables API, so there
      // is no escalation to prevent there. This gate exists solely because a
      // secret's plaintext has no other read path — the sealed envelope is the
      // only way its value ever leaves the server.
      if (variable.ownerScope === 'partner' && input.scriptOwnerScope === 'organization') {
        return { kind: 'partnerSecretAboveScriptScope', variableKey: definition.variableKey };
      }
      // The raw value, NOT `toNonBlankString`: a secret is delivered verbatim
      // or not at all, and silently trimming or blanking a credential would
      // turn an authentication failure into an unexplained one.
      return {
        kind: 'secretValue',
        value: variable.value,
        descriptor: {
          key: definition.name,
          source: 'tenantSecret',
          variableId: variable.variableId,
          ownerScope: variable.ownerScope,
          version: variable.version,
        },
      };
    }
    case 'deviceCustomField': {
      const value = toNonBlankString(readCustomField(input.device.customFields, definition.fieldKey));
      if (value === undefined) return { kind: 'missing' };
      return { kind: 'value', value, descriptor: { key: definition.name, source: 'deviceCustomField' } };
    }
    case 'builtin': {
      const value = toNonBlankString(resolveBuiltin(definition.builtinKey, input.device, input.names ?? {}));
      if (value === undefined) return { kind: 'missing' };
      return { kind: 'value', value, descriptor: { key: definition.name, source: 'builtin' } };
    }
  }
}

/**
 * Resolve one device's parameter map. Never throws for a per-device
 * condition — an unresolvable REQUIRED parameter fails THAT device
 * (`{ok:false}`) so the fan-out continues, exactly like the content-token
 * path. The only throw is a call-site programming error (a
 * `tenantVariable` binding with no variables map), which is not a per-device
 * condition and must not be swallowed.
 */
export function resolveSourcedParameters(
  input: ResolveSourcedParametersInput,
): ResolveSourcedParametersResult {
  const { definitions, malformed } = parseDefinitions(input.definitions);

  const parameters: Record<string, unknown> = { ...input.callerParameters };
  const bindings: ScriptParameterBindingDescriptor[] = [];
  const ignoredParameters: string[] = [];
  const secretEnv: Record<string, string> = {};
  const missing: string[] = [];
  const secretDenied: Array<{ key: string; variableKey: string }> = [];
  const notSecret: Array<{ key: string; variableKey: string }> = [];
  const aboveScope: Array<{ key: string; variableKey: string }> = [];
  const unreadable: Array<{ key: string; variableKey: string }> = [];

  for (const definition of definitions) {
    const name = definition.name;
    // The definition owns this key from here on: whatever the caller sent is
    // either the runtime candidate (below) or discarded. Deleting first means
    // every "missing, optional" path lands on "omit the parameter" without a
    // second delete at each branch.
    const callerValue = Object.prototype.hasOwnProperty.call(input.callerParameters, name)
      ? input.callerParameters[name]
      : undefined;
    delete parameters[name];

    let resolved: string | number | boolean | undefined;

    if (definition.source === 'runtime') {
      // "Explicit invoker value" (plan §2.1) — key present with a non-nullish
      // value. Note the blank rule is NOT applied here: it is specified for
      // bound sources, and treating an explicitly-supplied '' as missing
      // would silently change what today's callers already dispatch.
      if (callerValue !== undefined && callerValue !== null) {
        resolved = callerValue as string | number | boolean;
      }
    } else {
      if (callerValue !== undefined) ignoredParameters.push(name);
      const lookup = lookupBoundSource(definition, input);
      if (lookup.kind === 'unreadable') {
        // A denial, exactly like the two secret denials below — never a
        // fallthrough to the definition default. That default is the stale
        // plaintext the operator's (now unreadable) row was created to
        // replace, so shipping it would substitute the very value the
        // binding overrode, under a variable the UI still shows as set.
        unreadable.push({ key: name, variableKey: lookup.variableKey });
        continue;
      }
      if (lookup.kind === 'secretAsPlain') {
        secretDenied.push({ key: name, variableKey: lookup.variableKey });
        continue; // no default, no caller value, no omission — the device fails
      }
      if (lookup.kind === 'notSecret') {
        notSecret.push({ key: name, variableKey: lookup.variableKey });
        continue; // likewise a denial, not a fallthrough
      }
      if (lookup.kind === 'partnerSecretAboveScriptScope') {
        // A privilege denial, so the same rule as every denial above: no
        // default, no caller value, no omission. The `tenantSecret` arm has
        // no default to fall through to anyway; the `continue` is what keeps
        // the key out of `parameters` and out of the required/missing tail.
        aboveScope.push({ key: name, variableKey: lookup.variableKey });
        continue;
      }
      if (lookup.kind === 'secretValue') {
        // The one branch that never touches `parameters` or `resolved`: the
        // value leaves through `secretEnv` only, and `continue` skips the
        // default/required tail below (the arm has no default and is always
        // required, so reaching that tail could only misreport it as missing).
        secretEnv[name] = lookup.value;
        bindings.push(lookup.descriptor);
        continue;
      }
      if (lookup.kind === 'value') {
        resolved = lookup.value;
        bindings.push(lookup.descriptor);
      }
    }

    if (resolved === undefined) {
      const fallback = toNonBlankString(definition.defaultValue);
      if (fallback !== undefined) {
        resolved = fallback;
        if (definition.source !== 'runtime') {
          bindings.push({ key: name, source: definition.source });
        }
      }
    }

    // `required` is evaluated AFTER precedence, never before (plan §2.1).
    if (resolved === undefined) {
      if (definition.required) missing.push(name);
      continue;
    }
    parameters[name] = resolved;
  }

  // A definition we could not parse but that clearly declares a BOUND source
  // cannot be honoured, and downgrading it to "caller may supply it" would
  // undo the binding's authority. Fail the device instead.
  const malformedBound = malformed.filter((entry) => entry.boundSource !== null);

  if (
    missing.length > 0 ||
    unreadable.length > 0 ||
    secretDenied.length > 0 ||
    notSecret.length > 0 ||
    aboveScope.length > 0 ||
    malformedBound.length > 0
  ) {
    return {
      ok: false,
      code: 'unresolved_parameters',
      error: describeParameterFailure(missing, unreadable, secretDenied, notSecret, aboveScope, malformedBound),
      ignoredParameters,
    };
  }

  return {
    ok: true,
    parameters: parameters as Record<string, string | number | boolean>,
    bindings,
    secretEnv,
    ignoredParameters,
  };
}

const quoteList = (values: string[]): string => values.map((value) => `"${value}"`).join(', ');

/**
 * User-facing failure text. Carries parameter KEY NAMES and tenant-variable
 * KEYS only — never a resolved value, secret or otherwise — because this
 * string is written to `script_executions.error_message` and rendered in the
 * UI.
 */
function describeParameterFailure(
  missing: string[],
  unreadable: Array<{ key: string; variableKey: string }>,
  secretDenied: Array<{ key: string; variableKey: string }>,
  notSecret: Array<{ key: string; variableKey: string }>,
  aboveScope: Array<{ key: string; variableKey: string }>,
  malformedBound: MalformedDefinition[],
): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`no value for required parameter(s) ${quoteList(missing)}`);
  }
  if (unreadable.length > 0) {
    // Its own sentence, and pointedly NOT the "no value" wording above: the
    // row exists, so the operator must go look at key material rather than
    // create the variable again. Names both keys, never a value — there is
    // no plaintext to leak here anyway, but the rule is unconditional.
    parts.push(
      unreadable
        .map(
          (entry) =>
            `"${entry.key}" is bound to variable "${entry.variableKey}", whose stored value could not be read (check the server's encryption keys)`,
        )
        .join('; '),
    );
  }
  if (secretDenied.length > 0) {
    parts.push(
      `${quoteList(secretDenied.map((entry) => entry.key))} ${
        secretDenied.length === 1 ? 'is bound to secret tenant variable' : 'are bound to secret tenant variables'
      } ${quoteList(secretDenied.map((entry) => entry.variableKey))}, which cannot be used in script parameters`,
    );
  }
  if (notSecret.length > 0) {
    // The mirror of the denial above, and worth its own sentence: the author
    // asked for the secure channel and the variable is not eligible for it.
    // Naming both keys tells the operator exactly which one to reclassify.
    parts.push(
      notSecret
        .map((entry) => `"${entry.key}" is a secret parameter but variable "${entry.variableKey}" is not a secret`)
        .join('; '),
    );
  }
  if (aboveScope.length > 0) {
    // Names both keys and BOTH remediations, because the right one depends on
    // intent: if the credential really is the MSP's, the script belongs at the
    // partner tier; if this org needs its own, it needs its own secret. Never
    // a value — and there is a real one behind this key, unlike the notSecret
    // case, so the rule bites here.
    parts.push(
      aboveScope
        .map(
          (entry) =>
            `"${entry.key}" is bound to partner-wide secret variable "${entry.variableKey}", which an organization-scoped script cannot use; make the script partner-wide, or use an organization-owned secret`,
        )
        .join('; '),
    );
  }
  if (malformedBound.length > 0) {
    parts.push(
      `invalid ${quoteList(malformedBound.map((entry) => entry.boundSource ?? 'unknown'))} binding on parameter(s) ${quoteList(
        malformedBound.map((entry) => entry.name ?? '<unnamed>'),
      )}`,
    );
  }
  return `Unresolved script parameter(s): ${parts.join('; ')}`;
}

/** Re-exported so a caller can validate a builtin key without reaching into shared. */
export { SCRIPT_BUILTIN_PARAMETER_KEYS };
