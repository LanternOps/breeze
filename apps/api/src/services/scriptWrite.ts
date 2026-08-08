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

export type ScriptInsertInput = {
  name: string;
  description?: string | null;
  category?: string | null;
  osTypes: string[];
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  content: string;
  parameters?: unknown;
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
