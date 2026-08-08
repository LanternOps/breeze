/**
 * Script bundle export / preview / import (#3245).
 *
 * A bundle is untrusted input regardless of who uploads it, and its contents
 * run as SYSTEM on customer endpoints. The security posture:
 *
 * - Intake is bounded by `scriptBundleSchema` (see ./schema.ts) — callers must
 *   parse with it before handing a bundle to this service.
 * - Ownership comes from the caller's auth context ONLY, via
 *   `resolveScriptCreateScope` (services/scriptWrite.ts — the shared
 *   chokepoint with POST /scripts, including the #3262 partner-wide
 *   capability gate). Tenancy identifiers inside a bundle are never read:
 *   the schema strips them.
 * - `isSystem` is never honoured from a bundle, at ANY caller scope —
 *   `insertScriptRow` is called without `requestedIsSystem`, so the clamp
 *   yields `false` even for system-scope callers. Stricter than POST /scripts.
 * - Import never executes anything, and a v1 bundle cannot carry automations,
 *   schedules, or triggers (the schema has no such fields).
 * - Imported rows are ordinary `scripts` rows, so the existing
 *   abuse-signal sweep covers them by construction. That is detection after
 *   the fact — which is why the route audits every imported script with the
 *   bundle's identity.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { scripts, scriptTags, scriptToTags, scriptVersions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  isScriptScopeError,
  resolveScriptCreateScope,
  insertScriptRow,
  type ScriptCreateScope,
  type ScriptScopeError,
  type ScriptWriteAuth
} from '../scriptWrite';
import { SCRIPT_BUNDLE_VERSION, type ScriptBundle, type ScriptBundleEntry } from './schema';

export type BundleAuth = ScriptWriteAuth & Pick<AuthContext, 'user'>;
export type BundleImportMode = 'skip' | 'rename' | 'new-version';
export type BundleAvailability = 'org' | 'partner';

export type BundleTargetOptions = {
  /** Defaults to 'org'. 'partner' is capability-gated in resolveScriptCreateScope. */
  availability: BundleAvailability;
  orgId?: string | null;
};

type ScriptRow = typeof scripts.$inferSelect;

function canReadScript(auth: BundleAuth, script: ScriptRow): boolean {
  if (auth.scope === 'system') return true;
  if (script.isSystem) return true;
  if (script.orgId && auth.canAccessOrg(script.orgId)) return true;
  // Partner-wide (and partner-denormalized) rows are readable by the owning
  // partner's users — same visibility the list route grants.
  if (script.partnerId && auth.partnerId === script.partnerId) return true;
  return false;
}

/**
 * Export the selected scripts as a v1 bundle, scoped to what the caller can
 * already read. Emits NO tenancy identifiers and no `isSystem` flag — system
 * scripts export like any other script, so a round-trip cannot launder them
 * back in as system-library entries.
 */
export async function exportBundle(auth: BundleAuth, ids: string[]): Promise<ScriptBundle> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db
        .select()
        .from(scripts)
        .where(and(inArray(scripts.id, unique), isNull(scripts.deletedAt)))
    : [];

  const readable = rows.filter((s) => canReadScript(auth, s));

  const tagsByScript = new Map<string, string[]>();
  if (readable.length > 0) {
    const tagRows = await db
      .select({ scriptId: scriptToTags.scriptId, name: scriptTags.name })
      .from(scriptToTags)
      .innerJoin(scriptTags, eq(scriptToTags.tagId, scriptTags.id))
      .where(inArray(scriptToTags.scriptId, readable.map((s) => s.id)));
    for (const row of tagRows) {
      const list = tagsByScript.get(row.scriptId) ?? [];
      list.push(row.name);
      tagsByScript.set(row.scriptId, list);
    }
  }

  return {
    bundleVersion: SCRIPT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    scripts: readable.map((s) => {
      const tags = tagsByScript.get(s.id);
      return {
        name: s.name,
        ...(s.description ? { description: s.description } : {}),
        ...(s.category ? { category: s.category } : {}),
        ...(tags && tags.length > 0 ? { tags: tags.sort() } : {}),
        osTypes: s.osTypes as ScriptBundleEntry['osTypes'],
        language: s.language,
        content: s.content,
        ...(s.parameters != null ? { parameters: s.parameters } : {}),
        timeoutSeconds: s.timeoutSeconds,
        runAs: s.runAs,
        ...(s.exitCodeSeverityMapping != null
          ? { exitCodeSeverityMapping: s.exitCodeSeverityMapping }
          : {})
      };
    })
  };
}

function sameNameCondition(scope: ScriptCreateScope, name: string) {
  if (scope.orgId) {
    return and(eq(scripts.name, name), eq(scripts.orgId, scope.orgId), isNull(scripts.deletedAt));
  }
  // Partner-wide target: conflict against the partner's own partner-wide rows.
  return and(
    eq(scripts.name, name),
    isNull(scripts.orgId),
    eq(scripts.partnerId, scope.partnerId!),
    isNull(scripts.deletedAt)
  );
}

async function findExistingByName(scope: ScriptCreateScope, name: string) {
  const [existing] = await db
    .select()
    .from(scripts)
    .where(sameNameCondition(scope, name))
    .limit(1);
  return existing;
}

export type BundlePreviewEntry = {
  index: number;
  name: string;
  status: 'new' | 'name-conflict';
  existingScriptId?: string;
  existingVersion?: number;
};

export type BundlePreviewResult = {
  target: ScriptCreateScope & { availability: BundleAvailability };
  entries: BundlePreviewEntry[];
};

/**
 * Annotate each bundle entry as `new` or `name-conflict` against the resolved
 * target scope. Performs no writes.
 */
export async function previewBundle(
  auth: BundleAuth,
  bundle: ScriptBundle,
  options: BundleTargetOptions
): Promise<BundlePreviewResult | ScriptScopeError> {
  const scope = resolveScriptCreateScope(auth, options.availability, options.orgId);
  if (isScriptScopeError(scope)) return scope;

  const entries: BundlePreviewEntry[] = [];
  for (const [index, entry] of bundle.scripts.entries()) {
    const existing = await findExistingByName(scope, entry.name);
    entries.push({
      index,
      name: entry.name,
      status: existing ? 'name-conflict' : 'new',
      ...(existing ? { existingScriptId: existing.id, existingVersion: existing.version } : {})
    });
  }

  return { target: { ...scope, availability: options.availability }, entries };
}

/** Resolve tag names to ids within the target scope, creating what's missing. */
async function ensureTagIds(scope: ScriptCreateScope, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const unique = [...new Set(names)];

  const scopeCondition = scope.orgId
    ? eq(scriptTags.orgId, scope.orgId)
    : and(isNull(scriptTags.orgId), eq(scriptTags.partnerId, scope.partnerId!));

  const existing = await db
    .select({ id: scriptTags.id, name: scriptTags.name })
    .from(scriptTags)
    .where(and(inArray(scriptTags.name, unique), scopeCondition));

  const byName = new Map(existing.map((t) => [t.name, t.id]));
  const missing = unique.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    const created = await db
      .insert(scriptTags)
      .values(missing.map((name) => ({ name, orgId: scope.orgId, partnerId: scope.partnerId })))
      .returning({ id: scriptTags.id, name: scriptTags.name });
    for (const t of created) byName.set(t.name, t.id);
  }

  return unique.map((n) => byName.get(n)).filter((id): id is string => typeof id === 'string');
}

async function linkTags(scriptId: string, tagIds: string[], isExistingScript: boolean) {
  if (tagIds.length === 0) return;
  let toLink = tagIds;
  if (isExistingScript) {
    const links = await db
      .select({ tagId: scriptToTags.tagId })
      .from(scriptToTags)
      .where(eq(scriptToTags.scriptId, scriptId));
    const already = new Set(links.map((l) => l.tagId));
    toLink = tagIds.filter((id) => !already.has(id));
  }
  if (toLink.length > 0) {
    await db.insert(scriptToTags).values(toLink.map((tagId) => ({ scriptId, tagId })));
  }
}

const MAX_RENAME_ATTEMPTS = 100;

async function findFreeName(scope: ScriptCreateScope, base: string): Promise<string | null> {
  for (let i = 2; i < 2 + MAX_RENAME_ATTEMPTS; i++) {
    // Respect the 255-char column limit when suffixing.
    const suffix = ` (${i})`;
    const candidate = base.slice(0, 255 - suffix.length) + suffix;
    const existing = await findExistingByName(scope, candidate);
    if (!existing) return candidate;
  }
  return null;
}

export type BundleImportEntryResult = {
  index: number;
  name: string;
  action: 'imported' | 'renamed' | 'versioned' | 'skipped';
  finalName?: string;
  scriptId?: string;
};

export type BundleImportResult = {
  target: ScriptCreateScope & { availability: BundleAvailability };
  imported: number;
  skipped: number;
  renamed: number;
  versioned: number;
  errors: Array<{ index: number; name: string; error: string }>;
  scripts: BundleImportEntryResult[];
};

/**
 * Import a validated bundle into the caller's resolved scope.
 *
 * Per-entry failures are recorded and the remaining entries proceed. Never
 * executes anything; never honours `isSystem` or tenancy from the bundle.
 */
export async function importBundle(
  auth: BundleAuth,
  bundle: ScriptBundle,
  options: BundleTargetOptions & { mode: BundleImportMode }
): Promise<BundleImportResult | ScriptScopeError> {
  const scope = resolveScriptCreateScope(auth, options.availability, options.orgId);
  if (isScriptScopeError(scope)) return scope;

  const result: BundleImportResult = {
    target: { ...scope, availability: options.availability },
    imported: 0,
    skipped: 0,
    renamed: 0,
    versioned: 0,
    errors: [],
    scripts: []
  };

  for (const [index, entry] of bundle.scripts.entries()) {
    try {
      const existing = await findExistingByName(scope, entry.name);

      if (existing && options.mode === 'skip') {
        result.skipped++;
        result.scripts.push({ index, name: entry.name, action: 'skipped', scriptId: existing.id });
        continue;
      }

      if (existing && options.mode === 'new-version') {
        // Snapshot the current content into scriptVersions FIRST, so the
        // import appends to history rather than replacing it.
        await db.insert(scriptVersions).values({
          scriptId: existing.id,
          version: existing.version,
          content: existing.content,
          changelog: 'Superseded by bundle import',
          createdBy: auth.user.id
        });
        await db
          .update(scripts)
          .set({
            description: entry.description ?? existing.description,
            category: entry.category ?? existing.category,
            osTypes: entry.osTypes,
            language: entry.language,
            content: entry.content,
            parameters: entry.parameters ?? existing.parameters,
            timeoutSeconds: entry.timeoutSeconds,
            runAs: entry.runAs,
            exitCodeSeverityMapping: entry.exitCodeSeverityMapping ?? existing.exitCodeSeverityMapping,
            version: existing.version + 1,
            updatedAt: new Date()
          })
          .where(eq(scripts.id, existing.id));

        const tagIds = await ensureTagIds(scope, entry.tags ?? []);
        await linkTags(existing.id, tagIds, true);

        result.versioned++;
        result.scripts.push({ index, name: entry.name, action: 'versioned', scriptId: existing.id });
        continue;
      }

      let finalName = entry.name;
      let action: 'imported' | 'renamed' = 'imported';
      if (existing) {
        // mode === 'rename'
        const free = await findFreeName(scope, entry.name);
        if (!free) {
          result.errors.push({
            index,
            name: entry.name,
            error: 'Could not find a free name after 100 rename attempts'
          });
          continue;
        }
        finalName = free;
        action = 'renamed';
      }

      // NOTE: never pass requestedIsSystem here — a bundle can never create a
      // system script, at any caller scope (see module docblock).
      const created = await insertScriptRow(auth, scope, {
        name: finalName,
        description: entry.description,
        category: entry.category,
        osTypes: entry.osTypes,
        language: entry.language,
        content: entry.content,
        parameters: entry.parameters,
        timeoutSeconds: entry.timeoutSeconds,
        runAs: entry.runAs,
        exitCodeSeverityMapping: entry.exitCodeSeverityMapping ?? null
      });
      if (!created) {
        result.errors.push({ index, name: entry.name, error: 'Insert returned no row' });
        continue;
      }

      const tagIds = await ensureTagIds(scope, entry.tags ?? []);
      await linkTags(created.id, tagIds, false);

      if (action === 'renamed') result.renamed++;
      else result.imported++;
      result.scripts.push({
        index,
        name: entry.name,
        action,
        ...(action === 'renamed' ? { finalName } : {}),
        scriptId: created.id
      });
    } catch (err) {
      result.errors.push({
        index,
        name: entry.name,
        error: err instanceof Error ? err.message : 'Import failed'
      });
    }
  }

  return result;
}
