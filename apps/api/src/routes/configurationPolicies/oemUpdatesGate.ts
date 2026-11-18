import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { armsBeyond, hasArmedCategory, oemUpdatesInlineSettingsSchema } from '@breeze/shared';
import { OEM_UPDATES_EXECUTE_REQUIRED_MESSAGE } from '../../services/oemUpdates/oemUpdatesLinkWrite';

/**
 * Authorization for every config-policy write that arms vendor updates
 * (`oem_updates`, #11070, plan Decision 6), or newly exposes a device to an
 * armed link. Same shape as `hpCmslGate.ts`: the gate follows EFFECTIVENESS,
 * not the verb.
 *
 * Doors (each route calls `checkOemUpdatesArmAllowed` when its write arms):
 *  - feature-link POST/PATCH: `armsBeyond(in effect before, sent)`;
 *  - assignment POST of a policy whose link in effect is armed;
 *  - creating a child of a parent whose link is armed;
 *  - deleting an override whose revert target (the parent's link) arms beyond it;
 *  - setting status active on a policy whose link in effect is armed.
 * An unresolvable parent fails CLOSED everywhere: "can't tell" must not read as
 * "no parent".
 *
 * Narrowing writes (switching off, removing a category, adding a blocked ID,
 * unassigning, deactivating) are never gated: stopping a bad update never needs
 * more than the normal devices.write + MFA.
 */
export type OemUpdatesGateResult =
  | { allowed: true }
  | { allowed: false; body: { error: string; code: string } };

export function checkOemUpdatesArmAllowed(
  auth: AuthContext,
  perms: UserPermissions | undefined,
): OemUpdatesGateResult {
  // Fail closed: every route behind requireConfigPolicyWrite has permissions
  // resolved, so `undefined` means the middleware chain changed shape.
  if (
    !perms
    || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
  ) {
    return { allowed: false, body: { error: OEM_UPDATES_EXECUTE_REQUIRED_MESSAGE, code: 'oem_updates_execute_required' } };
  }
  // A belt to the route-level requireMfa(): the helper states the whole
  // requirement and stays correct if a route's middleware chain is reshaped.
  if (!hasSatisfiedMfa(auth)) {
    return { allowed: false, body: { error: 'MFA required', code: 'MFA_REQUIRED' } };
  }
  return { allowed: true };
}

export function mayArmOemUpdates(auth: AuthContext, perms: UserPermissions | undefined): boolean {
  return checkOemUpdatesArmAllowed(auth, perms).allowed;
}

type LinkLike = { featureType: string; inlineSettings?: unknown };
export type PolicyLike = {
  parentPolicyId?: string | null;
  featureLinks?: ReadonlyArray<LinkLike> | null;
  parentPolicy?: { featureLinks?: ReadonlyArray<LinkLike> | null } | null;
};

/** Marks a parent that is set but could not be loaded. */
export const UNRESOLVED_PARENT = Symbol('oem_updates_unresolved_parent');

function oemLinkSettings(links: ReadonlyArray<LinkLike> | null | undefined): { found: boolean; settings: unknown } {
  const link = links?.find((l) => l.featureType === 'oem_updates');
  return link ? { found: true, settings: link.inlineSettings ?? null } : { found: false, settings: null };
}

/** The settings a parent hands down, null when it has no link, or UNRESOLVED_PARENT. */
export function inheritedOemUpdatesSettings(policy: PolicyLike): unknown {
  if (!policy.parentPolicyId) return null;
  if (!policy.parentPolicy) return UNRESOLVED_PARENT;
  return oemLinkSettings(policy.parentPolicy.featureLinks).settings;
}

/**
 * The `oem_updates` settings in effect on a policy: its own link, else the one
 * it inherits whole (no merge), else null. UNRESOLVED_PARENT when only an
 * unloadable parent could say.
 */
export function oemUpdatesSettingsInEffect(policy: PolicyLike): unknown {
  const own = oemLinkSettings(policy.featureLinks);
  return own.found ? own.settings : inheritedOemUpdatesSettings(policy);
}

/** True when the link in effect would install anything; an unresolved parent fails closed. */
export function policyArmsOemUpdates(policy: PolicyLike): boolean {
  const settings = oemUpdatesSettingsInEffect(policy);
  return settings === UNRESOLVED_PARENT || hasArmedCategory(settings);
}

/**
 * Deleting the policy's own `oem_updates` link reverts it to the parent's. True
 * when that revert lets a device do more than the deleted override did.
 */
export function overrideDeleteArmsOemUpdates(policy: PolicyLike): boolean {
  const inherited = inheritedOemUpdatesSettings(policy);
  if (inherited === UNRESOLVED_PARENT) return true;
  if (inherited === null) return false;
  // The override as the resolver sees it: one that no longer parses resolves as
  // disabled, so it shields nothing and the revert is compared with nothing.
  const own = oemUpdatesInlineSettingsSchema.safeParse(oemLinkSettings(policy.featureLinks).settings);
  return armsBeyond(own.success ? own.data : null, inherited);
}

/** What a new or edited link is compared against: the settings in effect, null when unresolvable (strict). */
export function oemUpdatesPreviousForWrite(policy: PolicyLike): unknown {
  const settings = oemUpdatesSettingsInEffect(policy);
  return settings === UNRESOLVED_PARENT ? null : settings;
}
