import type { Context } from 'hono';
import { hasSatisfiedMfa } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from './permissions';

/**
 * PAM-governed executable-rules authorization.
 *
 * #5480 moved PAM approval and policy authority to `pam:approve` /
 * `pam:manage_policy`. Software-policy writes, however, are still gated only
 * on `devices:write` + `requireMfa()` + the org-wide-governance site ceiling.
 * A policy's `rules.executable[]` (sha256 / signer / publisher / pathGlob) in
 * `mode:'allowlist'` or `'blocklist'` feeds directly into the PAM bridge's
 * auto-approve/auto-deny evaluation, so setting or arming those rules
 * through this route also requires `pam:manage_policy`, the authority #5480
 * concentrated there.
 *
 * This assertion is evaluated over the POST-WRITE merged state (stored row
 * overlaid with the request body), mirroring `softwarePolicyAuthorization.ts`,
 * so editing the rules or mode of an already-governing policy is gated too.
 */

export type SoftwarePolicyExecutableGovernanceStored = {
  mode: string | null | undefined;
  /** Normalized `rules.executable[]` as currently stored, if any. */
  executable: readonly unknown[] | undefined;
};

export type SoftwarePolicyExecutableGovernancePatch = {
  mode?: string | null;
  /**
   * Normalized `rules.executable[]` this write supplies. `undefined` means
   * the write did not touch `rules` at all (distinct from an explicit empty
   * array, which clears executable rules).
   */
  executable?: readonly unknown[] | undefined;
};

function executableRulesEqual(
  a: readonly unknown[] | undefined,
  b: readonly unknown[] | undefined
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * True when the post-write state changes what PAM's bridge evaluates:
 *   1. the write sets or changes `rules.executable[]` while the resulting
 *      mode is `allowlist`/`blocklist` (the modes the bridge actually reads), or
 *   2. an existing policy's mode is switched while it carries `executable[]`
 *      rules on either side of the write (activates/deactivates PAM effect).
 * A bare `audit`-mode create/update with executable rules is not governed —
 * audit mode never reaches the PAM bridge.
 */
export function willChangePamGovernedExecutableRules(
  stored: SoftwarePolicyExecutableGovernanceStored | null,
  patch: SoftwarePolicyExecutableGovernancePatch
): boolean {
  const storedMode = stored?.mode ?? null;
  const nextMode = patch.mode !== undefined ? patch.mode : storedMode;

  const storedExecutable = stored?.executable;
  const executableTouched = patch.executable !== undefined;
  const nextExecutable = executableTouched ? patch.executable : storedExecutable;

  const storedCount = storedExecutable?.length ?? 0;
  const nextCount = nextExecutable?.length ?? 0;

  if (
    executableTouched
    && (nextMode === 'allowlist' || nextMode === 'blocklist')
    && !executableRulesEqual(storedExecutable, nextExecutable)
    && (storedCount > 0 || nextCount > 0)
  ) {
    return true;
  }

  if (
    stored !== null
    && nextMode !== storedMode
    && (storedCount > 0 || nextCount > 0)
  ) {
    return true;
  }

  return false;
}

export const EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE =
  'Setting or changing PAM executable allow/deny rules (rules.executable[]) requires the pam.manage_policy '
  + 'permission, separate from devices.write.';

/**
 * Returns `null` when the write is allowed, or the 403/401 `Response` the
 * handler must return when it is not:
 *
 *   const denied = await assertMayManageExecutableRules(c, stored, patch);
 *   if (denied) return denied;
 */
export async function assertMayManageExecutableRules(
  c: Context,
  stored: SoftwarePolicyExecutableGovernanceStored | null,
  patch: SoftwarePolicyExecutableGovernancePatch
): Promise<Response | null> {
  if (!willChangePamGovernedExecutableRules(stored, patch)) return null;

  const auth = c.get('auth');
  if (!auth) {
    return c.json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' }, 401);
  }

  // `requirePermission` populates this ahead of both current handlers. A
  // missing value means this assertion runs off a route that never resolved
  // permissions — fail closed.
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(
    perms,
    PERMISSIONS.PAM_MANAGE_POLICY.resource,
    PERMISSIONS.PAM_MANAGE_POLICY.action
  )) {
    return c.json({
      error: EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE,
      code: 'PAM_MANAGE_POLICY_REQUIRED',
    }, 403);
  }

  if (!hasSatisfiedMfa(auth)) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }

  return null;
}
