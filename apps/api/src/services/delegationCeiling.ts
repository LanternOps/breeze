/**
 * Delegation ceiling — a caller may never issue, rotate, or otherwise hand out
 * a credential whose authority exceeds their own (security review 2026-08-16
 * §1.4, same root principle as §1.1 #6).
 *
 * The concrete bug this closes: `POST /api-keys/:id/rotate` looked the key up
 * by id alone and authorized only `ensureOrgAccess(key.orgId, auth)`. Rotation
 * regenerates the secret but leaves scopes, the delegating `created_by`, and
 * therefore the key's whole effective authority untouched — so any user in the
 * org holding `organizations:write` + MFA could rotate a MORE privileged user's
 * key and walk away with a working plaintext credential carrying that user's
 * authority. Org access is not key access.
 *
 * Three axes have to hold, all of them, before plaintext is handed back:
 *
 *   1. SCOPE   — an `organization`-scope caller must not rotate a `partner`- or
 *                `system`-scope credential. Ranked, not equality: a system
 *                caller may rotate anything below it.
 *   2. PERMISSION — every permission the credential carries must be held by the
 *                caller RIGHT NOW. Supplied as a predicate so this module stays
 *                a dependency-free leaf (see below).
 *   3. SITE    — the credential's site allowlist must not be broader than the
 *                caller's. `undefined` means UNRESTRICTED on both sides, so a
 *                site-restricted caller may not touch an unrestricted
 *                credential, while an unrestricted caller may touch anything.
 *                RLS does not defend the site axis at all, so this one is
 *                entirely on the app layer.
 *
 * The org axis is deliberately NOT handled here: routes already enforce it
 * (`ensureOrgAccess` / `auth.canAccessOrg`) and it needs a DB read this module
 * must not take.
 *
 * Like `partnerWideAccess.ts` this is a deliberately dependency-free leaf
 * module (types only). The permission comparison is injected as a
 * `holdsPermission` predicate rather than importing `services/permissions`,
 * which pulls in the db + redis graph and would break every route test that
 * mocks `../db`.
 */

/** A permission grant, structurally compatible with `PERMISSIONS.*`. */
export interface DelegatedPermission {
  resource: string;
  action: string;
}

/**
 * The authority held by a principal — either the caller doing the issuing, or
 * the credential being issued/rotated.
 *
 * `allowedSiteIds: undefined` means UNRESTRICTED (mirrors
 * `AuthContext.allowedSiteIds` / `UserPermissions.allowedSiteIds`); an empty
 * array means restricted to no sites at all.
 */
export interface CredentialAuthority {
  scope: 'system' | 'partner' | 'organization';
  /**
   * Permissions the credential confers. Only consulted for the credential
   * side — the caller side is expressed through `holdsPermission`.
   */
  permissions?: readonly DelegatedPermission[];
  allowedSiteIds?: string[] | null;
}

export type DelegationCeilingViolation = 'scope' | 'permission' | 'site';

export type DelegationCeilingResult =
  | { ok: true }
  | { ok: false; violation: DelegationCeilingViolation; error: string; details?: Record<string, unknown> };

export const DELEGATION_CEILING_DENIED_MESSAGE =
  'You cannot issue or rotate a credential that carries more authority than you hold';

/** Thrown by service-layer issuers. Routes map it to 403. */
export class DelegationCeilingError extends Error {
  readonly violation: DelegationCeilingViolation;

  constructor(violation: DelegationCeilingViolation, message?: string) {
    super(message ?? DELEGATION_CEILING_DENIED_MESSAGE);
    this.name = 'DelegationCeilingError';
    this.violation = violation;
  }
}

const SCOPE_RANK: Record<CredentialAuthority['scope'], number> = {
  organization: 0,
  partner: 1,
  system: 2,
};

/** True when `callerScope` is at least as broad as `credentialScope`. */
export function scopeCoversScope(
  callerScope: CredentialAuthority['scope'],
  credentialScope: CredentialAuthority['scope'],
): boolean {
  return SCOPE_RANK[callerScope] >= SCOPE_RANK[credentialScope];
}

/**
 * True when the credential's site allowlist is no broader than the caller's.
 *
 * `undefined`/`null` = unrestricted on either side:
 *   caller unrestricted            -> always true
 *   caller restricted, cred unrestricted -> FALSE (the credential is broader)
 *   both restricted                -> credential set must be a subset
 */
export function siteAllowlistCovers(
  callerSiteIds: string[] | null | undefined,
  credentialSiteIds: string[] | null | undefined,
): boolean {
  if (callerSiteIds === undefined || callerSiteIds === null) return true;
  if (credentialSiteIds === undefined || credentialSiteIds === null) return false;
  const allowed = new Set(callerSiteIds);
  return credentialSiteIds.every((siteId) => allowed.has(siteId));
}

/**
 * Assert the caller's authority is a superset of the credential's on all three
 * axes. Returns a structured result rather than throwing so routes can map it
 * straight onto a 403 body.
 *
 * `holdsPermission` must answer "does the CALLER hold this permission right
 * now?" — callers pass `(p) => hasPermission(callerPermissions, p.resource,
 * p.action)`. It is required: a missing predicate would silently pass every
 * permission and turn this whole check vacuous, so the type makes it mandatory.
 */
export function checkDelegationCeiling(input: {
  caller: Pick<CredentialAuthority, 'scope' | 'allowedSiteIds'>;
  credential: CredentialAuthority;
  holdsPermission: (permission: DelegatedPermission) => boolean;
}): DelegationCeilingResult {
  const { caller, credential, holdsPermission } = input;

  if (!scopeCoversScope(caller.scope, credential.scope)) {
    return {
      ok: false,
      violation: 'scope',
      error: DELEGATION_CEILING_DENIED_MESSAGE,
      details: { callerScope: caller.scope, credentialScope: credential.scope },
    };
  }

  for (const permission of credential.permissions ?? []) {
    if (!holdsPermission(permission)) {
      return {
        ok: false,
        violation: 'permission',
        error: DELEGATION_CEILING_DENIED_MESSAGE,
        details: { missingPermission: `${permission.resource}:${permission.action}` },
      };
    }
  }

  if (!siteAllowlistCovers(caller.allowedSiteIds, credential.allowedSiteIds)) {
    return {
      ok: false,
      violation: 'site',
      error: DELEGATION_CEILING_DENIED_MESSAGE,
      details: { reason: 'credential is not restricted to the caller\'s sites' },
    };
  }

  return { ok: true };
}
