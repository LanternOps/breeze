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
import { findVariableTokens } from '@breeze/shared';
import { db } from '../../db';
import { scripts, scriptTags, scriptToTags, scriptVersions, tenantVariables } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  isScriptScopeError,
  resolveScriptCreateScope,
  insertScriptRow,
  type ScriptCreateScope,
  type ScriptScopeError,
  type ScriptWriteAuth
} from '../scriptWrite';
import { loadTenantVariableScope, resolveForOrg } from '../tenantVariableResolution';
import {
  SCRIPT_BUNDLE_VERSION,
  bundleScriptEntrySchema,
  formatEntryIssues,
  type ScriptBundle,
  type ScriptBundleEntry,
  type ScriptBundleEnvelope
} from './schema';

/**
 * Save-time `{{var.<secret>}}` rejection (#3409 PR2) — shared by POST/PUT
 * `/scripts` (routes/scripts.ts) and `importBundle` below, both of which
 * already resolve ownership through `resolveScriptCreateScope` (the single
 * tenancy chokepoint per the module docblock). Reusing its output here rather
 * than re-deriving tenancy is deliberate: two independent notions of "which
 * tenant does this script belong to" is exactly the kind of divergence that
 * chokepoint exists to prevent (#3263 review).
 *
 * A `{{var.<key>}}` reference to an UNKNOWN key is explicitly ALLOWED — a
 * tech may legitimately write the script before creating the variable, and
 * the dispatch path (Task 4) already fails that device loudly per device.
 * Only a token that resolves to an `is_secret = true` row is rejected: PR 2
 * has no delivery channel for secrets (the `BREEZE_VAR_*` / `secretEnv`
 * channel is PR 4), so textual substitution of one into script content would
 * be a permanent leak the moment a script referencing it dispatched.
 *
 * Org-owned scope (`scope.orgId` set): resolved through the exact same
 * org-over-partner-precedence snapshot dispatch itself will use
 * (`loadTenantVariableScope` / `resolveForOrg`), so this agrees with what
 * dispatch will actually see for this script's org.
 *
 * Partner-wide scope (`scope.orgId` null, `scope.partnerId` set): there is no
 * single org to resolve against — a partner-wide script fans out to every org
 * under the partner, and EACH of those re-runs this same secret check per
 * device at dispatch time (Task 4), so a per-org override is still caught
 * there regardless of what this save-time gate decides. This gate only needs
 * to catch the common case — the partner's OWN partner-wide variable
 * definition — so it queries `tenant_variables` directly for
 * `org_id IS NULL AND partner_id = <caller's partner>` rather than going
 * through the resolver, which requires a concrete org to attribute
 * partner-wide rows to.
 *
 * A scope with neither an orgId nor a partnerId (an untenanted system-scope
 * script — only reachable from `POST /scripts`, never from a bundle import;
 * see `unownedScopeError` below) has no tenant variables to check against.
 */
export async function findSecretVariableReferences(
  scope: ScriptCreateScope,
  content: string
): Promise<string[]> {
  const keys = findVariableTokens(content);
  if (keys.length === 0) return [];

  if (scope.orgId) {
    const variableScope = await loadTenantVariableScope([scope.orgId]);
    const resolved = resolveForOrg(variableScope, scope.orgId);
    return keys.filter((key) => resolved.get(key)?.isSecret === true);
  }

  if (scope.partnerId) {
    const rows = await db
      .select({ key: tenantVariables.key, isSecret: tenantVariables.isSecret })
      .from(tenantVariables)
      .where(
        and(
          isNull(tenantVariables.orgId),
          eq(tenantVariables.partnerId, scope.partnerId),
          inArray(tenantVariables.key, keys)
        )
      );
    const secretKeys = new Set(rows.filter((r) => r.isSecret).map((r) => r.key));
    return keys.filter((key) => secretKeys.has(key));
  }

  return [];
}

/** User-facing 400 message for {@link findSecretVariableReferences}'s non-empty result. Names only KEYS, never a value. */
export function describeSecretVariableRejection(offendingKeys: string[]): string {
  const tokens = offendingKeys.map((key) => `{{var.${key}}}`).join(', ');
  return `Script content references secret variable(s): ${tokens}. Secret variables cannot be substituted into script content.`;
}

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

/**
 * Scope condition for conflict lookups. `is_system = false` is load-bearing:
 * a system-library script can share a name with a tenant script, and matching
 * it here would let a `new-version` import rewrite the body of an `is_system`
 * row — the exact edit `PUT /scripts/:id` rejects with "System scripts are
 * read-only". System rows are a different namespace; never conflict against
 * them, never update them from a bundle.
 */
function scopeCondition(scope: ScriptCreateScope) {
  if (scope.orgId) {
    return and(eq(scripts.orgId, scope.orgId), eq(scripts.isSystem, false), isNull(scripts.deletedAt));
  }
  // Partner-wide target: conflict against the partner's own partner-wide rows.
  return and(
    isNull(scripts.orgId),
    eq(scripts.partnerId, scope.partnerId!),
    eq(scripts.isSystem, false),
    isNull(scripts.deletedAt)
  );
}

function sameNameCondition(scope: ScriptCreateScope, name: string) {
  return and(eq(scripts.name, name), scopeCondition(scope));
}

async function findExistingByName(scope: ScriptCreateScope, name: string) {
  // Duplicate names are not prevented by any unique index; order by creation
  // so a conflict deterministically resolves to the OLDEST matching row
  // instead of whichever row the query plan happens to return first.
  const [existing] = await db
    .select()
    .from(scripts)
    .where(sameNameCondition(scope, name))
    .orderBy(scripts.createdAt)
    .limit(1);
  return existing;
}

/**
 * A bundle import creates ordinary (non-system) rows, which must belong to
 * SOME tenant. A system-scope caller who supplies no orgId would otherwise
 * resolve to `{ orgId: null, partnerId: null }` — rows invisible to every
 * tenant and conflict lookups comparing `partner_id = NULL` (never true).
 */
function unownedScopeError(scope: ScriptCreateScope): ScriptScopeError | null {
  if (scope.orgId === null && scope.partnerId === null) {
    return { error: 'orgId is required when importing with a system-scope token', status: 400 };
  }
  return null;
}

export type BundlePreviewEntry = {
  index: number;
  name: string;
  status: 'new' | 'name-conflict' | 'invalid';
  error?: string;
  existingScriptId?: string;
  existingVersion?: number;
};

export type BundlePreviewResult = {
  target: ScriptCreateScope & { availability: BundleAvailability };
  entries: BundlePreviewEntry[];
};

type ParsedEntry =
  | { ok: true; entry: ScriptBundleEntry; name: string }
  | { ok: false; error: string; name: string };

function parseEntry(raw: unknown): ParsedEntry {
  const parsed = bundleScriptEntrySchema.safeParse(raw);
  const rawName =
    raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
      ? ((raw as { name: string }).name)
      : '(unnamed)';
  if (!parsed.success) {
    return { ok: false, error: formatEntryIssues(parsed.error), name: rawName.slice(0, 255) };
  }
  return { ok: true, entry: parsed.data, name: parsed.data.name };
}

/**
 * Annotate each bundle entry as `new` / `name-conflict` / `invalid` against
 * the resolved target scope. Performs no writes. Entry validation happens
 * here (per entry), not at the route, so one bad entry doesn't reject the
 * whole bundle.
 */
export async function previewBundle(
  auth: BundleAuth,
  bundle: ScriptBundleEnvelope,
  options: BundleTargetOptions
): Promise<BundlePreviewResult | ScriptScopeError> {
  const scope = resolveScriptCreateScope(auth, options.availability, options.orgId);
  if (isScriptScopeError(scope)) return scope;
  const unowned = unownedScopeError(scope);
  if (unowned) return unowned;

  const entries: BundlePreviewEntry[] = [];
  for (const [index, raw] of bundle.scripts.entries()) {
    const parsed = parseEntry(raw);
    if (!parsed.ok) {
      entries.push({ index, name: parsed.name, status: 'invalid', error: parsed.error });
      continue;
    }
    const existing = await findExistingByName(scope, parsed.entry.name);
    entries.push({
      index,
      name: parsed.entry.name,
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
  // Generate all candidates up front and resolve them with ONE query per
  // entry, not one per candidate — a fully-conflicting 200-entry bundle would
  // otherwise issue up to 20,000 sequential SELECTs.
  const candidates: string[] = [];
  for (let i = 2; i < 2 + MAX_RENAME_ATTEMPTS; i++) {
    // Respect the 255-char column limit when suffixing.
    const suffix = ` (${i})`;
    candidates.push(base.slice(0, 255 - suffix.length) + suffix);
  }
  const taken = await db
    .select({ name: scripts.name })
    .from(scripts)
    .where(and(inArray(scripts.name, candidates), scopeCondition(scope)));
  const takenNames = new Set(taken.map((t) => t.name));
  return candidates.find((c) => !takenNames.has(c)) ?? null;
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
  bundle: ScriptBundleEnvelope,
  options: BundleTargetOptions & { mode: BundleImportMode }
): Promise<BundleImportResult | ScriptScopeError> {
  const scope = resolveScriptCreateScope(auth, options.availability, options.orgId);
  if (isScriptScopeError(scope)) return scope;
  const unowned = unownedScopeError(scope);
  if (unowned) return unowned;

  const result: BundleImportResult = {
    target: { ...scope, availability: options.availability },
    imported: 0,
    skipped: 0,
    renamed: 0,
    versioned: 0,
    errors: [],
    scripts: []
  };

  for (const [index, raw] of bundle.scripts.entries()) {
    const parsed = parseEntry(raw);
    if (!parsed.ok) {
      result.errors.push({ index, name: parsed.name, error: parsed.error });
      continue;
    }
    const entry = parsed.entry;
    try {
      // Save-time secret-variable rejection (#3409 PR2) — see
      // findSecretVariableReferences's docblock. Per-entry, like every other
      // bundle-import failure mode: one script referencing a secret must not
      // sink the rest of the bundle.
      const secretRefs = await findSecretVariableReferences(scope, entry.content);
      if (secretRefs.length > 0) {
        result.errors.push({ index, name: entry.name, error: describeSecretVariableRejection(secretRefs) });
        continue;
      }

      const existing = await findExistingByName(scope, entry.name);

      if (existing && options.mode === 'skip') {
        result.skipped++;
        result.scripts.push({ index, name: entry.name, action: 'skipped', scriptId: existing.id });
        continue;
      }

      if (existing && options.mode === 'new-version' && existing.content === entry.content) {
        // Idempotent re-import: identical content must not pad version
        // history — re-running the same bundle N times would otherwise
        // produce N no-op versions and N identical snapshots.
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
