import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { warrantyHpCmslCollectionEffective } from '@breeze/shared/validators';

/**
 * Authorization for the config-policy writes that switch on — or newly expose a
 * device to — device-side HP CMSL warranty collection (#5511 W02, contract D4).
 *
 * Enabling collection causes HP's ~100 MB CMSL module to be installed on every
 * HP endpoint the policy reaches. Creating a software deployment requires
 * `devices.execute` PLUS satisfied MFA (`routes/software.ts`), so a
 * `devices.write` route that causes the same install would be a
 * privilege-escalation path around that gate.
 *
 * Keyed on the RESULT of the write, not on the feature type: a warranty link
 * carrying only alert thresholds installs nothing and keeps the plain
 * devices.write requirement. The check runs in-handler, after the policy row
 * is loaded, because only the payload or the stored link says whether a write
 * exposes a device to collection.
 *
 * Turning collection OFF is not gated. That is the fail-safe direction, and it
 * is audited like every other feature-link write.
 */
export type HpCmslGateResult =
  | { allowed: true }
  | { allowed: false; body: { error: string; code: string } };

export function checkHpCmslWriteAllowed(
  auth: AuthContext,
  perms: UserPermissions | undefined,
): HpCmslGateResult {
  // Fail closed. Every route behind requireConfigPolicyWrite has permissions
  // resolved by requirePermission (middleware/auth.ts:874), so `undefined` here
  // means the middleware chain changed shape — deny rather than infer consent.
  if (
    !perms
    || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
  ) {
    return {
      allowed: false,
      body: {
        error:
          'Enabling HP warranty collection installs HP software on the devices this policy reaches, so it requires the devices:execute permission — the same permission a software deployment requires.',
        code: 'HP_CMSL_EXECUTE_REQUIRED',
      },
    };
  }

  // Every door this gate guards already runs requireMfa() route-level
  // (SEC-107), so this is a belt: the helper states the WHOLE D4 requirement
  // itself and stays correct if a route's middleware chain is ever reshaped.
  // Session-claim strength; the body shape is requireMfa()'s so callers branch
  // on `code` exactly as they do for every other MFA refusal.
  if (!hasSatisfiedMfa(auth)) {
    return { allowed: false, body: { error: 'MFA required', code: 'MFA_REQUIRED' } };
  }

  return { allowed: true };
}

/**
 * True when a policy's OWN feature links contain a warranty link that actually
 * delivers collection (enabled AND consented against the current EULA id).
 *
 * Takes the links array `getConfigPolicy` already returns — for the policy
 * itself or for its `parentPolicy` — so the gates need no extra query.
 */
export function warrantyLinkEnablesCollection(
  links: ReadonlyArray<{ featureType: string; inlineSettings?: unknown }> | undefined | null,
): boolean {
  if (!links) return false;
  const warranty = links.find((l) => l.featureType === 'warranty');
  return warrantyHpCmslCollectionEffective(warranty?.inlineSettings);
}
