import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  canonicalizeScriptParameterDefinitions,
  findVariableTokens,
  scriptParameterDefinitionSchema,
} from '@breeze/shared';
import type { Database } from '../../db';
import { devices, scripts } from '../../db/schema';
import { scriptNeedsVariableScope } from '../sourcedParameters';
import {
  loadTenantVariableScope,
  resolveForOrg,
  unreadableForOrg,
  type TenantVariableScope,
} from '../tenantVariableResolution';

/**
 * The verified `run_script` snapshot (#3409 PR4c-1) — everything an approval
 * pins about a script run, gathered once so the effect digest
 * (`effectDigest.ts`'s `run_script` resolver) and dispatch can be built from
 * the SAME observation.
 *
 * WHY THIS EXISTS. `effect_digest` used to pin five script fields (orgId,
 * language, content, timeoutSeconds, runAs) and nothing else. Since #3409 PR3,
 * that is no longer the set of things that determines what executes:
 *
 *   - `scripts.parameters` drives `scriptNeedsVariableScope` and every
 *     per-parameter `tenantVariable` binding at `scriptDispatch.ts`, so
 *     rebinding a parameter to a different variable changes what the device
 *     runs with a byte-identical script body.
 *   - The tenant variables themselves are late-bound per device org. An
 *     approved run could have its variable rotated (new `version`), swapped
 *     (an org override shadowing a partner-wide row: same key, same value,
 *     different `variableId`), reclassified (`isSecret` flipped either way) or
 *     deleted inside the approval window, all invisibly.
 *
 * So the snapshot pins a REFERENCE to each variable the run will consult —
 * `variableId` + `version` + `isSecret` + `ownerScope`, per (org, key).
 *
 * THE INVARIANT: a resolved variable's VALUE never enters this module's
 * digest material. `action_intents.effect_digest` is a widely-readable column
 * and its input must not be reconstructible into tenant plaintext; identity is
 * sufficient to detect drift, so identity is all that is pinned.
 *
 * WHY THE SCOPE IS A SIBLING, NOT A FIELD. The loaded `TenantVariableScope`
 * holds decrypted PLAINTEXT, and dispatch wants to reuse the very scope the
 * digest was pinned against rather than re-loading (and possibly re-resolving)
 * it. Both are true, so it is returned ALONGSIDE the snapshot
 * (`{ kind: 'snapshot', snapshot, scope }`) instead of hanging off it. Nesting
 * it made `RunScriptSnapshot` a plaintext-bearing object one stray
 * `JSON.stringify(snapshot)` in a log or audit path away from a leak, and made
 * "the digest material never reads the scope" a matter of discipline. With the
 * split, `RunScriptSnapshot` is pure digest material — the leak is not guarded
 * against, it is structurally absent.
 */

/**
 * Whether the referenced variable resolved, existed-but-could-not-be-read, or
 * was not defined at all for that org.
 *
 * `unreadable` is a state in its own right, not a flavour of `absent`: a row
 * whose decrypt fails (rotated/By-missing key material) is an operational
 * condition an approver's decision should not survive, and collapsing it into
 * `absent` would make "the variable was deleted" and "the variable can no
 * longer be read" produce the same digest.
 */
export type VariableReferenceState = 'present' | 'absent' | 'unreadable';

/** One (org, key) reference — identity only, NEVER the value. */
export type PinnedVariableReference = {
  orgId: string;
  key: string;
  state: VariableReferenceState;
  /** The four identity fields below are present only when `state === 'present'`. */
  variableId?: string;
  version?: number;
  isSecret?: boolean;
  ownerScope?: 'organization' | 'partner';
};

export type RunScriptSnapshot = {
  script: {
    id: string;
    orgId: string | null;
    language: string;
    content: string;
    timeoutSeconds: number;
    runAs: string;
  };
  /**
   * `scripts.parameters` canonicalized through the shared serializer (narrowed
   * from the plan's `unknown` — it is always a string).
   */
  parameterDefinitions: string;
  /** Unique org ids behind `args.deviceIds`, code-point sorted. */
  deviceOrgIds: string[];
  /** Code-point sorted by (orgId, key). */
  variableReferences: PinnedVariableReference[];
};

export type BuildRunScriptSnapshotResult =
  | {
      kind: 'snapshot';
      /** Digest material only — carries no variable VALUE (see the header). */
      snapshot: RunScriptSnapshot;
      /** The SAME scope dispatch will resolve against. Plaintext-bearing: never digested, never serialized. */
      scope: TenantVariableScope;
      /**
       * The WHOLE `scripts` row this observation read, a third sibling for the
       * same reason the scope is a second one: dispatch needs columns the
       * digest deliberately does not pin (`osTypes`, `partnerId`, and the raw
       * `parameters` jsonb rather than its canonical serialization), and the
       * only way to hand it those without a second read is to carry the row
       * itself. It is NOT folded into `snapshot.script` — that stays the exact
       * narrow set `runScriptDigestMaterial` hashes, so "everything on the
       * snapshot is digest material" remains true by construction rather than
       * by remembering which fields the material projects.
       */
      scriptRow: typeof scripts.$inferSelect;
    }
  | { kind: 'missing_arg' }
  | { kind: 'target_absent' };

/**
 * Test seam, mirroring why `effectDigest.ts` takes `database` rather than
 * importing it: production `loadScope` (below) forwards `buildRunScriptSnapshot`'s
 * own `database` argument straight into `loadTenantVariableScope`'s
 * `opts.database` (#3409 PR4c-1 Task 3b) — every call into this module
 * already runs inside a system-scoped transaction (the effect digest's three
 * entry points: `computeEffectDigestOutcome` from intentService.ts and
 * `computeEffectDigestForRelease` from jobs/intentReleaseWorker.ts and
 * services/aiAgentSdk.ts), so reusing that connection is what avoids
 * acquiring a second pooled one while the caller's transaction is still held.
 * Injecting `loadScope` is what lets the unit suite build snapshots without a
 * live or mocked database module at all. Production callers pass nothing.
 */
export interface RunScriptSnapshotDeps {
  loadScope: (orgIds: string[], database: Database) => Promise<TenantVariableScope>;
}

const DEFAULT_DEPS: RunScriptSnapshotDeps = {
  // Reuses the caller's already-system-scoped `database` (see the interface
  // doc above) rather than letting `loadTenantVariableScope` escape to a
  // second pooled connection — that escape buys nothing here, since every
  // caller of `buildRunScriptSnapshot` is already system-scoped.
  loadScope: (orgIds, database) => loadTenantVariableScope(orgIds, { database }),
};

/**
 * UTF-16 code point order, NEVER `localeCompare`.
 *
 * The material this ordering feeds is hashed and compared across processes
 * (creation in the API request, recomputation in the release worker), and
 * `localeCompare` is a function of the runtime's ICU build and default locale
 * — two workers with different ICU data would disagree about the order of
 * `a_b` vs `a1b` (they genuinely do: locale collation puts `a_b` first, code
 * point puts `a1b` first) and manufacture a spurious `content_changed`. Code
 * point order is total, locale-independent and stable by definition.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every tenant-variable key this run will consult: the union of the content's
 * `{{var.*}}` tokens and every `tenantVariable`- or `tenantSecret`-bound
 * parameter's `variableKey`. A `tenantSecret` reference (#3409 PR4c-2) is
 * pinned by identity exactly like any other — variableId / version /
 * isSecret — so a secret rotated between approval and release is a
 * `content_changed`, while its VALUE never enters the material.
 *
 * Definitions are parsed ELEMENT BY ELEMENT with the shared schema, matching
 * `sourcedParameters.ts`'s `parseDefinitions` — a live database holds lists
 * written before PR3 validated them, and whole-list parsing would let one
 * malformed sibling drop every real binding out of the reference set. A
 * malformed BOUND element contributes no reference (dispatch fails that device
 * outright), but it is still pinned through `parameterDefinitions`, which
 * serializes the raw list when it does not parse as a whole.
 */
function referencedVariableKeys(content: string, parameters: unknown): string[] {
  const keys = new Set(findVariableTokens(content));
  if (Array.isArray(parameters)) {
    for (const element of parameters) {
      const parsed = scriptParameterDefinitionSchema.safeParse(element);
      if (
        parsed.success &&
        (parsed.data.source === 'tenantVariable' || parsed.data.source === 'tenantSecret')
      ) {
        keys.add(parsed.data.variableKey);
      }
    }
  }
  return [...keys].sort(byCodePoint);
}

/** `deviceIds` exactly as the tool schema declares it: a non-empty array of strings. */
function readDeviceIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((id): id is string => typeof id === 'string')) return null;
  return [...new Set(value)];
}

/**
 * Gather everything the approval pins about one `run_script` call.
 *
 * `missing_arg` / `target_absent` carry the same meaning they do in
 * `effectDigest.ts`: a malformed argument versus a resolver that ran and found
 * no target. Both leave the intent unpinned-but-audited; neither is a
 * validation of the caller's authorization, which the tool handler still owns.
 */
export async function buildRunScriptSnapshot(
  args: Record<string, unknown>,
  database: Database,
  deps: RunScriptSnapshotDeps = DEFAULT_DEPS,
): Promise<BuildRunScriptSnapshotResult> {
  const scriptId = typeof args.scriptId === 'string' ? args.scriptId : null;
  if (!scriptId) return { kind: 'missing_arg' };

  // JUDGEMENT CALL. `deviceIds` is `required` in run_script's tool schema
  // (`aiToolsScripts.ts`), so absent / empty / non-string-bearing all mean the
  // call is MALFORMED rather than pointing at a target that vanished —
  // `missing_arg`, the same bucket a missing `scriptId` lands in. The
  // alternative (snapshot with an empty device set) would pin an empty
  // reference list for a call that can never execute, which reads as "nothing
  // referenced" instead of "this was never a well-formed run".
  const deviceIds = readDeviceIds(args.deviceIds);
  if (!deviceIds) return { kind: 'missing_arg' };

  // WHOLE ROW, not a projection (#3409 PR4c-1 Task 6). The digest needs seven
  // columns; DISPATCH needs several more (`osTypes`, `partnerId`, the raw
  // `parameters` jsonb). Selecting the row once and returning it as
  // `scriptRow` is what lets the release path hand the handler everything it
  // needs from ONE observation — a projection here would have forced the
  // handler to re-read for the rest, which is exactly the check/use window
  // this task closes.
  const [script] = await database
    .select()
    .from(scripts)
    // Same filter as the tool handler and the pre-PR4c resolver: a script
    // soft-deleted after approval is `target_absent`, so the release fails
    // closed rather than running a deleted script.
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);
  if (!script) return { kind: 'target_absent' };

  const deviceRows: Array<{ id: string; orgId: string }> = await database
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(inArray(devices.id, deviceIds));

  // Fail closed on an unresolvable device rather than skipping it. Dropping it
  // would shrink `deviceOrgIds`, which shrinks the reference set, which can
  // make a digest MATCH while the fan-out the approver signed off on no longer
  // exists.
  if (deviceRows.length !== deviceIds.length) return { kind: 'target_absent' };

  const deviceOrgIds = [...new Set(deviceRows.map((row) => row.orgId))].sort(byCodePoint);
  const content = script.content;
  const keys = referencedVariableKeys(content, script.parameters);

  // Same gate dispatch uses, so the snapshot's scope is exactly the scope
  // dispatch would have loaded — including the empty, query-free scope for the
  // overwhelming majority of scripts that reference nothing.
  const needsScope = scriptNeedsVariableScope({ content, parameters: script.parameters });
  const variableScope = await deps.loadScope(needsScope ? deviceOrgIds : [], database);

  // `keys` non-empty implies `needsScope` (a key comes either from a content
  // token or from a parsed `tenantVariable` binding, and each of those is one
  // of the gate's two disjuncts), so every org below is in the scope and
  // `resolveForOrg`'s membership check cannot throw here.
  const variableReferences: PinnedVariableReference[] = [];
  for (const orgId of keys.length === 0 ? [] : deviceOrgIds) {
    const resolved = resolveForOrg(variableScope, orgId);
    const unreadable = unreadableForOrg(variableScope, orgId);
    for (const key of keys) {
      const variable = resolved.get(key);
      if (variable) {
        variableReferences.push({
          orgId,
          key,
          state: 'present',
          variableId: variable.variableId,
          version: variable.version,
          isSecret: variable.isSecret,
          ownerScope: variable.ownerScope,
        });
        continue;
      }
      variableReferences.push({ orgId, key, state: unreadable.has(key) ? 'unreadable' : 'absent' });
    }
  }
  // Already emitted in (orgId, key) order by the loops above; sorted anyway so
  // the ordering is a stated property of the snapshot rather than a side
  // effect of iteration order that a later refactor could silently drop.
  variableReferences.sort((a, b) => byCodePoint(a.orgId, b.orgId) || byCodePoint(a.key, b.key));

  return {
    kind: 'snapshot',
    snapshot: {
      script: {
        id: script.id,
        orgId: script.orgId ?? null,
        language: script.language,
        content,
        timeoutSeconds: script.timeoutSeconds,
        runAs: script.runAs,
      },
      // An unparseable list still has to be pinned — two different corrupt
      // lists must not hash the same — so fall back to the raw value. It is a
      // jsonb column, so Postgres already normalized its key order and the
      // fallback is stable across reads of the same stored value.
      parameterDefinitions:
        canonicalizeScriptParameterDefinitions(script.parameters) ??
        `unparseable:${JSON.stringify(script.parameters ?? null)}`,
      deviceOrgIds,
      variableReferences,
    },
    scope: variableScope,
    scriptRow: script,
  };
}

/**
 * The string hashed into `action_intents.effect_digest`.
 *
 * Determinism is by construction, not by luck: fixed object-literal field
 * order (the same technique the rest of `effectDigest.ts` uses), explicitly
 * code-point-sorted arrays, and a canonical parameter serialization from
 * `@breeze/shared`. The scope is not in reach of this function at all — it is
 * a sibling of the snapshot, not a field on it (see the header).
 *
 * `v: 2` is load-bearing. The v1 material was a bare five-field object; the
 * envelope guarantees a v1 string can never accidentally equal a v2 one, so a
 * digest pinned before this change fails closed (`content_changed`) on release
 * instead of silently comparing equal against a narrower pin.
 */
export function runScriptDigestMaterial(snapshot: RunScriptSnapshot): string {
  return JSON.stringify({
    v: 2,
    script: {
      orgId: snapshot.script.orgId,
      language: snapshot.script.language,
      content: snapshot.script.content,
      timeoutSeconds: snapshot.script.timeoutSeconds,
      runAs: snapshot.script.runAs,
    },
    parameterDefinitions: snapshot.parameterDefinitions,
    deviceOrgIds: snapshot.deviceOrgIds,
    variableReferences: snapshot.variableReferences.map((reference) => ({
      orgId: reference.orgId,
      key: reference.key,
      state: reference.state,
      variableId: reference.variableId,
      version: reference.version,
      isSecret: reference.isSecret,
      ownerScope: reference.ownerScope,
    })),
  });
}
