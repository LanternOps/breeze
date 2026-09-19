import type { Context } from 'hono';
import { hasSatisfiedMfa } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from './permissions';
import { readSoftwarePolicyAutoInstall, type SoftwarePolicyArmingInput } from './softwarePolicyService';

/**
 * Install-arming authorization (#5505 D3).
 *
 * Arming `remediationOptions.autoInstall` causes software to be installed on
 * customer machines — exactly what creating a software deployment does, which
 * requires `devices:execute` + `requireMfa()` (`routes/software.ts:1882-1888`).
 * The software-policy write routes require only `devices:write` +
 * `requireMfa()` + the in-handler `canMutateOrgWideGovernance` site ceiling, so
 * the delta needed to reach deployment-grade authorization is `devices.execute`.
 * Without this assertion the policy route is a privilege-escalation path around
 * the deployment gate.
 *
 * Why in-handler and not middleware: middleware cannot see whether the write
 * ARMS install — that depends on the resulting policy, which only exists once
 * the request body has been merged onto the stored row.
 *
 * Both conditions are asserted even though both current call sites already sit
 * behind `requireMfa()`. The assertion must stay correct if it is ever reused
 * on a route without it.
 */

/** The subset of a policy write body that can change install arming. */
export type SoftwarePolicyInstallArmingPatch = {
  mode?: string | null;
  enforceMode?: boolean | null;
  remediationOptions?: unknown;
};

export const ARM_INSTALL_EXECUTE_DENIED_MESSAGE =
  'Arming remediationOptions.autoInstall installs software on managed devices, so it requires the '
  + 'devices.execute permission — the same permission as creating a software deployment.';

/**
 * Post-write arming: `stored` is the row as it exists today (null on create),
 * `patch` is the validated request body. A field the body does not supply keeps
 * its stored value, which mirrors the PATCH handler exactly — note that
 * `remediationOptions` is REPLACED wholesale there
 * (`routes/softwarePolicies.ts:556`), never merged key-by-key.
 */
export function willBeArmedForInstall(
  stored: SoftwarePolicyArmingInput | null,
  patch: SoftwarePolicyInstallArmingPatch
): boolean {
  const mode = patch.mode !== undefined ? patch.mode : stored?.mode;
  const enforceMode = patch.enforceMode !== undefined ? patch.enforceMode : stored?.enforceMode;
  const remediationOptions = patch.remediationOptions !== undefined
    ? patch.remediationOptions
    : stored?.remediationOptions;

  if (mode === 'audit') return false;
  if (enforceMode !== true) return false;
  return readSoftwarePolicyAutoInstall(remediationOptions);
}

/**
 * Returns `null` when the write is allowed, or the 403/401 `Response` the
 * handler must return when it is not:
 *
 *   const denied = await assertMayArmInstall(c, stored, patch);
 *   if (denied) return denied;
 *
 * Refusals use coded bodies rather than `HTTPException` so callers branch on
 * `code` (mirrors `requireMfa()`, `middleware/auth.ts:897-905`).
 */
export async function assertMayArmInstall(
  c: Context,
  stored: SoftwarePolicyArmingInput | null,
  patch: SoftwarePolicyInstallArmingPatch
): Promise<Response | null> {
  if (!willBeArmedForInstall(stored, patch)) return null;

  const auth = c.get('auth');
  if (!auth) {
    return c.json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' }, 401);
  }

  // `requirePermission` populates this (middleware/auth.ts:874) and runs ahead
  // of both current handlers. A missing value means this assertion is being
  // used off a route that never resolved permissions — fail closed.
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(
    perms,
    PERMISSIONS.DEVICES_EXECUTE.resource,
    PERMISSIONS.DEVICES_EXECUTE.action
  )) {
    return c.json({ error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE, code: 'DEVICES_EXECUTE_REQUIRED' }, 403);
  }

  if (!hasSatisfiedMfa(auth)) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }

  return null;
}
