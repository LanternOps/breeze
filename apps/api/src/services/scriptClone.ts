/**
 * `POST /scripts/:id/clone` orchestration (#4887). Kept in its own module
 * rather than folded into `scriptWrite.ts` or `scriptBundle/index.ts` because
 * it depends on BOTH: the tenancy/capability resolver lives in
 * `scriptWrite.ts`, and the secret-binding guards + tag helpers live in
 * `scriptBundle/index.ts` (which itself imports from `scriptWrite.ts`) — a
 * third module importing both is the only way to reuse everything without a
 * cycle.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { normalizeScriptParameterDefinitions } from '@breeze/shared';
import { db } from '../db';
import { scripts, scriptTags, scriptToTags } from '../db/schema';
import {
  resolveScriptCloneScope,
  isScriptScopeError,
  type ScriptScopeError,
} from './scriptWrite';
import {
  findSecretVariableReferences,
  findParameterSecretMismatches,
  describeSecretVariableRejection,
  describeParameterSecretMismatch,
  canReadScript,
  ensureTagIds,
  linkTags,
  type BundleAuth,
} from './scriptBundle';

export type ScriptCloneInput = { name?: string; orgId?: string };
export type ScriptCloneError = ScriptScopeError | { error: string; status: 400 | 403 | 404 };
type ScriptRow = typeof scripts.$inferSelect;

function isScriptCloneError(r: { script: ScriptRow } | ScriptCloneError): r is ScriptCloneError {
  return 'error' in r;
}
export { isScriptCloneError };

/**
 * Deep-copy an accessible script into a new row: content, language, osTypes,
 * category, runAs, timeout, parameter definitions, and tags. Execution
 * history and `lastRun` are never copied — a clone starts with none.
 * `createdBy` is always the caller; the row always gets fresh id/timestamps
 * from the insert defaults. `isSystem` is never copied forward (mirrors
 * `POST /import/:id` — a clone can never mint another system-library row).
 */
export async function cloneScript(
  auth: BundleAuth,
  scriptId: string,
  input: ScriptCloneInput
): Promise<{ script: ScriptRow } | ScriptCloneError> {
  const [source] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);
  if (!source) {
    return { error: 'Script not found', status: 404 };
  }
  // The source must be readable by the caller under RLS AND the app-layer
  // rule the rest of this route file uses for reads (`canReadScript`, shared
  // with the bundle exporter) — never assume "the row came back from a bare
  // `db.select`" means the caller may see it; RLS is the backstop for the
  // org/system branches, but a partner-wide (org_id NULL) row needs the
  // explicit partner check `canReadScript` already encodes. Returned as 404
  // (not 403) so this never confirms a script id exists to someone who can't
  // read it.
  if (!canReadScript(auth, source)) {
    return { error: 'Script not found', status: 404 };
  }

  const scope = resolveScriptCloneScope(auth, source, input.orgId);
  if (isScriptScopeError(scope)) return scope;

  // Reuse the create path's save-time secret checks verbatim (#3409 PR2 /
  // PR4c-2) — a clone copies `content` and `parameters` unmodified, but the
  // TARGET scope can differ from the source's (a cross-org clone, or a
  // narrowing from partner-wide), and that target is exactly what these
  // checks validate against.
  const secretRefs = await findSecretVariableReferences(scope, source.content);
  if (secretRefs.length > 0) {
    return { error: describeSecretVariableRejection(secretRefs), status: 400 };
  }
  // Re-validate the copied parameter definitions through the same schema
  // POST/PUT run (including the BREEZE_PARAM_* collision-folding rule) — a
  // clone introduces no new parameter input, but a pre-existing row created
  // before this validation existed must not be allowed to propagate forward
  // as a fresh row that bypassed it. null/undefined (no parameters) normalize
  // to [] here rather than failing — normalizeScriptParameterDefinitions is
  // the shared "is this a valid stored value" check other read paths use.
  if (normalizeScriptParameterDefinitions(source.parameters) === null) {
    return { error: 'This script’s parameter definitions are invalid and cannot be duplicated', status: 400 };
  }
  const mismatches = await findParameterSecretMismatches(scope, source.parameters);
  if (mismatches.length > 0) {
    return { error: describeParameterSecretMismatch(mismatches), status: 400 };
  }

  // Reserve space for the suffix within the 255-character name limit.
  // Avoid leaving half a surrogate pair when truncating a Unicode name.
  const copyBaseName = source.name.slice(0, 248).replace(/[\uD800-\uDBFF]$/, '');
  const name = input.name?.trim() || `${copyBaseName} (copy)`;

  // Insert + tag copy run in ONE transaction: insertScriptRow/ensureTagIds/
  // linkTags (services/scriptWrite.ts, services/scriptBundle) all hard-code
  // the module-level `db`, so a tag-copy failure after a successful bare
  // insert would otherwise leave a real, untagged clone in place while the
  // caller is told the duplicate failed — a retry then mints a second one.
  // Rolling both back together makes "failed" mean "nothing was created".
  const tagRows = await db
    .select({ name: scriptTags.name })
    .from(scriptToTags)
    .innerJoin(scriptTags, eq(scriptToTags.tagId, scriptTags.id))
    .where(eq(scriptToTags.scriptId, scriptId));

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(scripts)
      .values({
        orgId: scope.orgId,
        partnerId: scope.partnerId,
        name,
        description: source.description ?? undefined,
        category: source.category ?? undefined,
        osTypes: source.osTypes,
        language: source.language,
        content: source.content,
        parameters: source.parameters,
        timeoutSeconds: source.timeoutSeconds,
        runAs: source.runAs,
        isSystem: false,
        version: 1,
        exitCodeSeverityMapping: source.exitCodeSeverityMapping ?? null,
        createdBy: auth.user.id,
      })
      .returning();
    if (!row) return undefined;

    if (tagRows.length > 0) {
      const tagIds = await ensureTagIds(scope, tagRows.map((t) => t.name), tx);
      await linkTags(row.id, tagIds, false, tx);
    }
    return row;
  });
  if (!created) {
    return { error: 'Clone failed', status: 400 };
  }

  return { script: created };
}
