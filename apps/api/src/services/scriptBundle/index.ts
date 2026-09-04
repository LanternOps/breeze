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
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
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
  const secrecyByKey = await lookupVariableSecrecyByKey(scope, keys);
  return keys.filter((key) => secrecyByKey.get(key)?.isSecret === true);
}

/**
 * What the save-time lookup knows about one tenant-variable key.
 *
 * `ownerScope` mirrors `ResolvedVariable.ownerScope`: `'partner'` for a
 * partner-wide row (`tenant_variables.org_id IS NULL`), `'organization'` for
 * an org-owned row (including one that SHADOWS a partner-wide key of the same
 * name — the org row is what this org actually resolves, and it is the org's
 * own value, so it carries no MSP→customer descent).
 */
interface VariableSecrecy {
  isSecret: boolean;
  ownerScope: 'organization' | 'partner';
}

/**
 * The single save-time "what is this key for this scope?" lookup shared by
 * {@link findSecretVariableReferences} (content tokens) and
 * {@link findParameterSecretMismatches} (parameter bindings). One DB round
 * trip per call. A key with no matching row is ABSENT from the result — the
 * two callers each treat absence as "unknown, allow" (see their docblocks).
 */
async function lookupVariableSecrecyByKey(
  scope: ScriptCreateScope,
  keys: string[]
): Promise<Map<string, VariableSecrecy>> {
  const result = new Map<string, VariableSecrecy>();
  if (keys.length === 0) return result;

  if (scope.orgId) {
    const variableScope = await loadTenantVariableScope([scope.orgId]);
    const resolved = resolveForOrg(variableScope, scope.orgId);
    for (const key of keys) {
      const variable = resolved.get(key);
      if (variable) result.set(key, { isSecret: variable.isSecret === true, ownerScope: variable.ownerScope });
    }
    return result;
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
    // `org_id IS NULL` is in the WHERE clause, so every row here is
    // partner-wide by construction — no need to project org_id back out.
    for (const row of rows) result.set(row.key, { isSecret: row.isSecret === true, ownerScope: 'partner' });
    return result;
  }

  return result;
}

/** User-facing 400 message for {@link findSecretVariableReferences}'s non-empty result. Names only KEYS, never a value. */
export function describeSecretVariableRejection(offendingKeys: string[]): string {
  const tokens = offendingKeys.map((key) => `{{var.${key}}}`).join(', ');
  return `Script content references secret variable(s): ${tokens}. Secret variables cannot be substituted into script content.`;
}

export type ParameterSecretMismatchKind = 'secretBoundAsPlain' | 'plainBoundAsSecret' | 'partnerSecretNotPermitted';

export interface ParameterSecretMismatch {
  /** Parameter NAME — never a value. */
  name: string;
  /** Tenant-variable KEY — never a value. */
  variableKey: string;
  kind: ParameterSecretMismatchKind;
}

/**
 * A raw parameter definition element that binds to a tenant variable.
 * Parsed TOLERANTLY, element by element (same posture as `parseDefinitions`
 * in services/sourcedParameters.ts): a malformed sibling must not hide a
 * real mismatch, and this check must not depend on the full union parsing —
 * it only needs `source` and `variableKey`, which it reads straight off the
 * element.
 */
interface VariableBoundParameter {
  name: string;
  source: 'tenantVariable' | 'tenantSecret';
  variableKey: string;
}

function readVariableBoundParameters(parameters: unknown): VariableBoundParameter[] {
  if (!Array.isArray(parameters)) return [];
  const bound: VariableBoundParameter[] = [];
  for (const element of parameters) {
    if (!element || typeof element !== 'object') continue;
    const { name, source, variableKey } = element as Record<string, unknown>;
    if (source !== 'tenantVariable' && source !== 'tenantSecret') continue;
    if (typeof variableKey !== 'string' || variableKey.length === 0) continue;
    bound.push({
      name: typeof name === 'string' ? name : '',
      source,
      variableKey
    });
  }
  return bound;
}

/**
 * Save-time parameter-binding secret check (#3409 PR4c-2) — the parameter-side
 * twin of {@link findSecretVariableReferences}, called at all FOUR write
 * ingresses for `scripts.parameters` right after it: `POST /scripts`,
 * `PUT /scripts/:id`, `POST /scripts/import/:id` (the clone) and
 * {@link importBundle}.
 *
 * Secret delivery is DECLARED, never inferred (settled design §1):
 *
 * - `source: 'tenantVariable'` bound to a SECRET key → `secretBoundAsPlain`.
 *   Dispatch already denies this per device; rejecting it at save time is
 *   what the web form's warning ("the save will be rejected") promises.
 * - `source: 'tenantSecret'` bound to a NON-secret key → `plainBoundAsSecret`.
 *   Dispatch fails that device closed; a save-time 400 says why up front.
 * - `source: 'tenantSecret'` bound to a PARTNER-owned secret from an
 *   ORG-scoped script → `partnerSecretNotPermitted`.
 *
 * ## The ownership-tier rule
 *
 * A script may resolve a secret at or below its own ownership tier, never
 * above:
 *
 * - A partner-wide script (`scripts.org_id IS NULL`) may resolve a
 *   partner-owned OR an org-owned secret. The org-owned case is a PRIMARY use
 *   case: one partner-wide script, each target org's own value resolved per
 *   device. (Such a key is simply INVISIBLE to the partner-wide lookup below,
 *   so it lands in the unknown-key allowance.)
 * - An org-scoped script may resolve only org-owned secrets. A partner-owned
 *   one is denied: `tenantVariableReadCondition` shows partner-wide variable
 *   KEYS to organization-scope sessions and `resolveForOrg` inherits the ROWS
 *   into every org, so without this an org admin could bind the MSP's own
 *   secret into a script they can run and base64 it out through script output
 *   (both redactors are exact-substring). `tenantSecret` delivery is the first
 *   and only channel through which a secret's PLAINTEXT leaves the server.
 *
 * The tier is the SCRIPT's, not the CALLER's capability: a full-partner admin
 * saving an ORG-scoped script is denied too, because that script is afterwards
 * editable and runnable by the customer org's own admins.
 *
 * ## Dispatch is the authority; this is a fast fail
 *
 * The same rule is enforced per device at dispatch, in the `tenantSecret` arm
 * of services/sourcedParameters.ts — which is where it HAS to live. Variable
 * key uniqueness is per-scope, so an org admin can create an org-owned secret
 * shadowing a partner-wide key, save a binding that resolves the ORG row (this
 * check passes, correctly), then delete their own row and let `resolveForOrg`
 * inherit the partner-wide value. Binding a not-yet-existing key is the same
 * hole in time. Save time cannot close either; dispatch can, and does.
 *
 * What this check buys is a good error while the tech is still looking at the
 * form, instead of a per-device failure at run time. It is also why an UNKNOWN
 * key produces NO mismatch: the variable may not exist yet, and a partner-wide
 * script resolves per org at dispatch, where every device is checked against
 * the row it actually resolves.
 *
 * Only one lookup is issued per call, whatever the number of bindings.
 */
export async function findParameterSecretMismatches(
  scope: ScriptCreateScope,
  parameters: unknown
): Promise<ParameterSecretMismatch[]> {
  const bound = readVariableBoundParameters(parameters);
  if (bound.length === 0) return [];

  // The tier the script itself is being written at. Derived from `scope`
  // rather than passed as a separate flag: `scope` is already the scope the
  // row will LIVE at for every ingress (the create/import target, the clone's
  // target org, the PUT's post-rescope effective scope), and a second
  // parameter could only ever disagree with it.
  //
  // No capability check belongs here: producing `orgId === null` at all
  // already requires `canManagePartnerWidePolicies` upstream — see
  // `resolveScriptCreateScope` (services/scriptWrite.ts) for create/import and
  // `resolveRescopeTarget` (routes/scripts.ts) for the PUT re-scope. (System
  // scope also reaches `orgId === null`, and `canManagePartnerWidePolicies`
  // admits system scope, so that path agrees.)
  const scriptIsPartnerWide = scope.orgId === null;

  const keys = [...new Set(bound.map((p) => p.variableKey))];
  const secrecyByKey = await lookupVariableSecrecyByKey(scope, keys);

  const mismatches: ParameterSecretMismatch[] = [];
  for (const parameter of bound) {
    const secrecy = secrecyByKey.get(parameter.variableKey);
    if (secrecy === undefined) continue; // unknown key — allowed
    const { isSecret, ownerScope } = secrecy;
    if (parameter.source === 'tenantVariable' && isSecret) {
      // Checked BEFORE the ownership-tier arm: a `tenantVariable` binding to
      // a secret is rejected at every tier, and its message names the actual
      // fix (switch the source), so it must not be masked by the tier message
      // when the target happens to be partner-owned.
      mismatches.push({ name: parameter.name, variableKey: parameter.variableKey, kind: 'secretBoundAsPlain' });
    } else if (parameter.source === 'tenantSecret' && !isSecret) {
      mismatches.push({ name: parameter.name, variableKey: parameter.variableKey, kind: 'plainBoundAsSecret' });
    } else if (
      parameter.source === 'tenantSecret' &&
      isSecret &&
      ownerScope === 'partner' &&
      !scriptIsPartnerWide
    ) {
      mismatches.push({ name: parameter.name, variableKey: parameter.variableKey, kind: 'partnerSecretNotPermitted' });
    }
  }
  return mismatches;
}

/**
 * User-facing 400 message for {@link findParameterSecretMismatches}'s
 * non-empty result. Names parameter NAMES and variable KEYS only — never a
 * value (settled design §5). "From a variable" is the web form's label for
 * the `tenantVariable` source, so the message reads against what the tech
 * actually selected.
 */
export function describeParameterSecretMismatch(mismatches: ParameterSecretMismatch[]): string {
  return mismatches
    .map((m) => {
      switch (m.kind) {
        case 'secretBoundAsPlain':
          return `Parameter "${m.name}" binds secret variable "${m.variableKey}" with source "From a variable"; use a secret parameter instead`;
        case 'plainBoundAsSecret':
          return `Parameter "${m.name}" is a secret parameter but variable "${m.variableKey}" is not a secret`;
        case 'partnerSecretNotPermitted':
          return `Parameter "${m.name}" binds partner-wide secret variable "${m.variableKey}"; an organization-scoped script cannot use one — make the script partner-wide, or use an organization-owned secret.`;
      }
    })
    .join('; ');
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

export function canReadScript(auth: BundleAuth, script: ScriptRow): boolean {
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

/**
 * Condition matching the caller's PARTNER-WIDE scripts when the import targets
 * an ORG (#3450). These rows are not writable by an org-target import, but the
 * scripts list renders partner-wide and org rows in one library, so a name that
 * already exists partner-wide is a real collision from the operator's point of
 * view — annotating it `new` and importing it anyway produces a visible
 * same-name duplicate.
 *
 * Returns null when the target IS partner-wide (`scope.orgId` null — then
 * {@link scopeCondition} already covers these rows) or when there is no partner
 * context at all (system-scope import into a specific org).
 *
 * Gating is on the RESOLVED SCOPE, not `auth.scope`: organization-scope users
 * legitimately SEE their MSP's partner-wide scripts — `resolveScriptCreateScope`
 * carries `auth.partnerId` through for them, the list route unions on
 * `partner_id`, and RLS grants the read via the own-partner SELECT branch
 * (`2026-06-13-catalog-partner-read-branch.sql`). They just cannot WRITE them,
 * which is exactly why this is a separate, read-only conflict class.
 */
function partnerWideConflictCondition(scope: ScriptCreateScope) {
  if (!scope.orgId || !scope.partnerId) return null;
  return and(
    isNull(scripts.orgId),
    eq(scripts.partnerId, scope.partnerId),
    eq(scripts.isSystem, false),
    isNull(scripts.deletedAt)
  );
}

/**
 * How a bundle entry's name collided:
 * - `target-scope` — a row the import OWNS and may rewrite (skip/rename/version).
 * - `partner-wide` — a partner-wide row visible to the caller but READ-ONLY for
 *   an org-target import (#3262). Never versioned, never rewritten.
 */
export type BundleConflictKind = 'target-scope' | 'partner-wide';

export type BundleConflict = { row: ScriptRow; kind: BundleConflictKind };

/**
 * Resolve a name to the conflicting row, if any. A `target-scope` match always
 * wins over a `partner-wide` one: when both exist the owned row is the thing
 * the operator's chosen mode should act on, and versioning it is safe.
 */
async function findConflictByName(
  scope: ScriptCreateScope,
  name: string
): Promise<BundleConflict | undefined> {
  // Duplicate names are not prevented by any unique index; order by creation
  // so a conflict deterministically resolves to the OLDEST matching row
  // instead of whichever row the query plan happens to return first.
  const [owned] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.name, name), scopeCondition(scope)))
    .orderBy(scripts.createdAt)
    .limit(1);
  if (owned) return { row: owned, kind: 'target-scope' };

  const partnerWide = partnerWideConflictCondition(scope);
  if (!partnerWide) return undefined;

  const [shared] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.name, name), partnerWide))
    .orderBy(scripts.createdAt)
    .limit(1);
  return shared ? { row: shared, kind: 'partner-wide' } : undefined;
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
  /**
   * Present exactly when `status === 'name-conflict'` (#3450). Deliberately a
   * refinement of the existing status rather than a new status value: a client
   * older than this change still renders a generic conflict badge instead of
   * falling through to "Invalid" on an unrecognised enum member.
   */
  conflictKind?: BundleConflictKind;
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
    const conflict = await findConflictByName(scope, parsed.entry.name);
    entries.push({
      index,
      name: parsed.entry.name,
      status: conflict ? 'name-conflict' : 'new',
      ...(conflict
        ? {
            conflictKind: conflict.kind,
            existingScriptId: conflict.row.id,
            existingVersion: conflict.row.version
          }
        : {})
    });
  }

  return { target: { ...scope, availability: options.availability }, entries };
}

/**
 * A live transaction handle from `db.transaction(async (tx) => …)`, structurally
 * compatible with `db` itself for the query-builder calls these two functions
 * make. Lets a caller (script clone, #4887) run the tag-copy atomically with
 * its own insert; every existing caller omits it and keeps running on the
 * bare pooled `db`, unchanged.
 */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Resolve tag names to ids within the target scope, creating what's missing. */
export async function ensureTagIds(scope: ScriptCreateScope, names: string[], dbOrTx: DbOrTx = db): Promise<string[]> {
  if (names.length === 0) return [];
  const unique = [...new Set(names)];

  const scopeCondition = scope.orgId
    ? eq(scriptTags.orgId, scope.orgId)
    : and(isNull(scriptTags.orgId), eq(scriptTags.partnerId, scope.partnerId!));

  const existing = await dbOrTx
    .select({ id: scriptTags.id, name: scriptTags.name })
    .from(scriptTags)
    .where(and(inArray(scriptTags.name, unique), scopeCondition));

  const byName = new Map(existing.map((t) => [t.name, t.id]));
  const missing = unique.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    const created = await dbOrTx
      .insert(scriptTags)
      .values(missing.map((name) => ({ name, orgId: scope.orgId, partnerId: scope.partnerId })))
      .returning({ id: scriptTags.id, name: scriptTags.name });
    for (const t of created) byName.set(t.name, t.id);
  }

  return unique.map((n) => byName.get(n)).filter((id): id is string => typeof id === 'string');
}

export async function linkTags(scriptId: string, tagIds: string[], isExistingScript: boolean, dbOrTx: DbOrTx = db) {
  if (tagIds.length === 0) return;
  let toLink = tagIds;
  if (isExistingScript) {
    const links = await dbOrTx
      .select({ tagId: scriptToTags.tagId })
      .from(scriptToTags)
      .where(eq(scriptToTags.scriptId, scriptId));
    const already = new Set(links.map((l) => l.tagId));
    toLink = tagIds.filter((id) => !already.has(id));
  }
  if (toLink.length > 0) {
    await dbOrTx.insert(scriptToTags).values(toLink.map((tagId) => ({ scriptId, tagId })));
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
  // Both namespaces are off-limits: a rename that dodges the org rows but lands
  // on a partner-wide name reproduces the very duplicate #3450 is about.
  const partnerWide = partnerWideConflictCondition(scope);
  const visible = partnerWide ? or(scopeCondition(scope), partnerWide) : scopeCondition(scope);
  const taken = await db
    .select({ name: scripts.name })
    .from(scripts)
    .where(and(inArray(scripts.name, candidates), visible));
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
      // Parameter-binding twin of the content check (#3409 PR4c-2, Task 6):
      // a tenantVariable→secret, a tenantSecret→non-secret, and — for an
      // ORG-scoped import target — a tenantSecret→PARTNER-owned-secret binding
      // are all per-entry errors the same way. The ownership tier comes from
      // `scope`, the tier this bundle is being imported at.
      const mismatches = await findParameterSecretMismatches(scope, entry.parameters);
      if (mismatches.length > 0) {
        result.errors.push({ index, name: entry.name, error: describeParameterSecretMismatch(mismatches) });
        continue;
      }

      const conflict = await findConflictByName(scope, entry.name);
      const existing = conflict?.row;

      if (existing && options.mode === 'skip') {
        // Skips on a partner-wide match too (#3450) — the operator asked not to
        // add a name that already exists in the library they are looking at,
        // and partner-wide rows are in that same list.
        result.skipped++;
        result.scripts.push({ index, name: entry.name, action: 'skipped', scriptId: existing.id });
        continue;
      }

      if (existing && options.mode === 'new-version' && existing.content === entry.content) {
        // Idempotent re-import: identical content must not pad version
        // history — re-running the same bundle N times would otherwise
        // produce N no-op versions and N identical snapshots. Applies to a
        // partner-wide match as well: the content is already live for this org
        // under that name, so an org-owned copy would add nothing but a
        // duplicate.
        result.skipped++;
        result.scripts.push({ index, name: entry.name, action: 'skipped', scriptId: existing.id });
        continue;
      }

      if (conflict?.kind === 'partner-wide' && options.mode === 'new-version') {
        // An org-target import may never version a partner-wide row (#3262),
        // and silently creating an org-owned row of the same name is the
        // duplicate #3450 reports. Fail this entry loudly with the two modes
        // that CAN proceed; the rest of the bundle still imports.
        result.errors.push({
          index,
          name: entry.name,
          error:
            `A partner-wide script named "${entry.name}" already exists and is read-only for an ` +
            'organization import. Re-run with the "Skip it" or "Rename" collision mode, or import ' +
            'the bundle as partner-wide to version it.'
        });
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
