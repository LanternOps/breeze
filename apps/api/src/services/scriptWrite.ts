/**
 * Single service-layer path for creating `scripts` rows (#3245, #3262 review).
 *
 * Both `POST /scripts` and the bundle importer (`services/scriptBundle`) write
 * through these helpers so the tenancy resolution, the partner-wide capability
 * gate, and the `isSystem` clamp cannot diverge between the two intakes. The
 * #3263 review specifically flagged that the partner-wide gate previously
 * lived only in route handlers with no service-layer chokepoint — this module
 * is that chokepoint. Do not add a second script-insert path that bypasses it.
 */
import type { ScriptParameterDefinition } from '@breeze/shared';
import { db } from '../db';
import { scripts } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE
} from './partnerWideAccess';

export type ScriptWriteAuth = Pick<
  AuthContext,
  'scope' | 'orgId' | 'partnerId' | 'partnerOrgAccess' | 'accessibleOrgIds' | 'canAccessOrg'
>;

export type ScriptCreateScope = { orgId: string | null; partnerId: string | null };
export type ScriptScopeError = { error: string; status: 400 | 403 };

export function isScriptScopeError(
  r: ScriptCreateScope | ScriptScopeError
): r is ScriptScopeError {
  return 'error' in r;
}

/**
 * Resolve the `{ orgId, partnerId }` a new script should be created under.
 * Mirrors (and is now the single source of) the `POST /scripts` tenancy rules:
 *
 * - Org scope: always the caller's own org (a requested orgId is ignored).
 * - Partner scope + `availability: 'partner'`: partner-wide (org_id NULL).
 *   Gated on `canManagePartnerWidePolicies` — partner SCOPE is not the same
 *   as partner-wide CAPABILITY (#3262): a 'selected'-access user must not be
 *   able to create a script that runs as SYSTEM across every org under the
 *   partner, including orgs they hold no grant for and orgs created later.
 * - Partner scope otherwise: the requested org (or the single accessible org),
 *   access-checked.
 * - System scope: any requested org, or none. `availability` is ignored —
 *   system tokens carry no partnerId, so partner-wide creation is not
 *   expressible on this path (parity with the pre-existing route behavior).
 */
export function resolveScriptCreateScope(
  auth: ScriptWriteAuth,
  availability: 'org' | 'partner' | undefined,
  requestedOrgId: string | null | undefined
): ScriptCreateScope | ScriptScopeError {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    return { orgId: auth.orgId, partnerId: auth.partnerId ?? null };
  }

  if (auth.scope === 'partner') {
    if (availability === 'partner') {
      if (!canManagePartnerWidePolicies(auth)) {
        return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
      }
      if (!auth.partnerId) {
        return { error: 'Partner context required', status: 403 };
      }
      return { orgId: null, partnerId: auth.partnerId };
    }

    let orgId = requestedOrgId ?? null;
    if (!orgId) {
      const singleOrg = auth.accessibleOrgIds?.[0];
      if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
        orgId = singleOrg;
      } else {
        return { error: 'orgId is required when partner has multiple organizations', status: 400 };
      }
    }
    if (!auth.canAccessOrg(orgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId, partnerId: auth.partnerId ?? null };
  }

  // System scope.
  return { orgId: requestedOrgId ?? null, partnerId: null };
}

/** The tenancy shape of the script being cloned, as read from its row. */
export type ScriptCloneSource = { orgId: string | null; partnerId: string | null; isSystem: boolean };

/**
 * Resolve the `{ orgId, partnerId }` a CLONE of `source` should land under
 * (#4887). Delegates every actual tenancy/capability decision to
 * `resolveScriptCreateScope` — this function only decides WHICH availability
 * to ask it for, based on how the clone request relates to its source, so a
 * clone can never silently change tenancy shape:
 *
 * - A system-library script (`is_system`, `org_id` AND `partner_id` both
 *   NULL) is always duplicated into a specific org — the same rule
 *   `POST /import/:id` already applies, the other system-script duplication
 *   path. A caller who omits `orgId` here gets the same "which org?"
 *   resolution `POST /import/:id` and plain create use (own org for an
 *   org-scope caller, the single accessible org for a partner-scope caller
 *   with only one, else a 400). System scope MUST name an org explicitly —
 *   `resolveScriptCreateScope`'s system branch has no "which org" fallback of
 *   its own and would otherwise resolve to `org_id: null, partner_id: null`,
 *   an ownerless row invisible under RLS to everyone who isn't system scope.
 * - An explicit `requestedOrgId` on a non-system source is always an
 *   intentional target: a genuine cross-org copy, or a deliberate narrowing
 *   of a partner-wide script into one org. Checked with the same org-access
 *   rule as create; this is narrowing, not widening, so it never requires the
 *   partner-wide capability.
 * - No `requestedOrgId` on a non-system source: the clone preserves the
 *   SOURCE's scope rather than picking a new one. An org-owned source clones
 *   into that same org. A partner-wide source (`org_id` NULL, `partner_id`
 *   set) stays partner-wide by default — which still runs through
 *   `canManagePartnerWidePolicies` via `resolveScriptCreateScope('partner', …)`,
 *   so a caller who could not have CREATED a partner-wide script is refused
 *   (403) rather than silently getting an org-scoped downgrade of it (CLAUDE.md
 *   Partner-Wide First: never silently narrow ownership either). System-scope
 *   tokens carry no `partnerId` to preserve partner-wide under, so they must
 *   name a target org explicitly in this case too.
 */
export function resolveScriptCloneScope(
  auth: ScriptWriteAuth,
  source: ScriptCloneSource,
  requestedOrgId: string | null | undefined
): ScriptCreateScope | ScriptScopeError {
  if (source.isSystem) {
    if (auth.scope === 'system' && !requestedOrgId) {
      return { error: 'orgId is required to clone this script', status: 400 };
    }
    return resolveScriptCreateScope(auth, 'org', requestedOrgId ?? undefined);
  }

  if (auth.scope === 'organization') {
    return resolveScriptCreateScope(auth, undefined, undefined);
  }

  if (requestedOrgId) {
    return resolveScriptCreateScope(auth, 'org', requestedOrgId);
  }

  if (source.orgId === null) {
    if (auth.scope !== 'partner') {
      return { error: 'orgId is required to clone this script', status: 400 };
    }
    return resolveScriptCreateScope(auth, 'partner', undefined);
  }

  return resolveScriptCreateScope(auth, 'org', source.orgId);
}

export type ScriptInsertInput = {
  name: string;
  description?: string | null;
  category?: string | null;
  osTypes: string[];
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  content: string;
  // Validated DEFINITIONS, never raw jsonb (#3409 PR3): both callers —
  // `POST /scripts` and the bundle importer — now parse through
  // `scriptParameterDefinitionsSchema` before reaching here.
  parameters?: ScriptParameterDefinition[] | null;
  timeoutSeconds: number;
  runAs: 'system' | 'user' | 'elevated';
  exitCodeSeverityMapping?: Record<string, 'critical' | 'high' | 'medium' | 'low' | 'info' | null> | null;
};

/**
 * Insert a script row under an already-resolved scope.
 *
 * `isSystem` is clamped here, not at call sites: only system scope may request
 * it, and only via the explicit `requestedIsSystem` option (the Discussion
 * #633 write hole). The bundle importer never passes the option, so a bundle
 * can NEVER produce an `isSystem: true` row — at any caller scope, including
 * system — which is deliberately stricter than `POST /scripts`.
 */
export async function insertScriptRow(
  auth: Pick<AuthContext, 'scope' | 'user'>,
  scope: ScriptCreateScope,
  input: ScriptInsertInput,
  opts: { requestedIsSystem?: boolean } = {}
) {
  const isSystem = auth.scope === 'system' ? (opts.requestedIsSystem ?? false) : false;

  const [script] = await db
    .insert(scripts)
    .values({
      orgId: isSystem && !scope.orgId ? null : scope.orgId,
      partnerId: scope.partnerId,
      name: input.name,
      description: input.description ?? undefined,
      category: input.category ?? undefined,
      osTypes: input.osTypes,
      language: input.language,
      content: input.content,
      parameters: input.parameters,
      timeoutSeconds: input.timeoutSeconds,
      runAs: input.runAs,
      isSystem,
      version: 1,
      exitCodeSeverityMapping: input.exitCodeSeverityMapping ?? null,
      createdBy: auth.user.id
    })
    .returning();

  return script;
}
