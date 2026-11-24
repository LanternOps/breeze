/**
 * The gates an assignment write runs (#12466, plan W02b G1, decision D12).
 *
 * One module, used by the single `POST /:id/assignments`, `DELETE
 * /:id/assignments/:aid` and the staged `POST /:id/assignments/apply`, so the
 * two doors that add or remove an assignment cannot drift apart. The bodies
 * moved here unchanged from the single POST.
 *
 * Not here: target derivation, `validateAssignmentTarget` and the site/device
 * ceiling (`authorizeAssignmentTarget`). Those take a target and read the DB;
 * these three are pure checks over the loaded policy and the caller.
 *
 * The AI tool `apply_configuration_policy` keeps its own refusal semantics.
 */
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import { assignmentWriteAllowed, hasHelperBranding, HELPER_BRANDING_ASSIGNMENT_REFUSAL } from '../../services/helperBranding';
// Imported from configurationPolicy (its re-export), not partnerWideAccess: the
// assignment route tests mock the capability on this module.
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  type getConfigPolicy,
  type ConfigAssignmentLevel,
} from '../../services/configurationPolicy';
import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';
import { checkOemUpdatesArmAllowed, policyArmsOemUpdates } from './oemUpdatesGate';

export type LoadedPolicy = NonNullable<Awaited<ReturnType<typeof getConfigPolicy>>>;

export type AssignmentGateResult =
  | { ok: true }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

const OK: AssignmentGateResult = { ok: true };

/**
 * Partner-owned policies (org_id NULL) are the partner library (#2280). ANY
 * assignment on one, at any level, added or removed, pushes config into (or
 * strips it from) orgs the caller may not fully control, so every assignment
 * write requires full partner org access: the same capability that gates
 * partner-wide create/update/delete.
 */
export function checkPolicyAssignableBy(auth: AuthContext, policy: LoadedPolicy): AssignmentGateResult {
  if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
    return { ok: false, status: 403, body: { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE } };
  }
  return OK;
}

/**
 * Helper branding is partner/organization-only: a site, device-group or device
 * assignment cannot be added to a policy that already carries branding.
 */
export function checkAddLevel(policy: LoadedPolicy, level: ConfigAssignmentLevel): AssignmentGateResult {
  const policyHasBranding = !!policy.featureLinks?.some(
    (l: { featureType: string; inlineSettings?: unknown }) => l.featureType === 'helper' && hasHelperBranding(l.inlineSettings),
  );
  if (!assignmentWriteAllowed(level, policyHasBranding)) {
    return {
      ok: false,
      status: 409,
      body: { error: HELPER_BRANDING_ASSIGNMENT_REFUSAL },
    };
  }
  return OK;
}

/**
 * An added assignment is how an armed policy REACHES devices, so adding one is
 * the same capability as arming it, reached through a second door. Run once per
 * request that adds a row or edits a row's priority or filters (the staged
 * Apply's update); removes do not run it.
 *
 * - #5511 W02 (contract D4), HP CMSL: the effective warranty link is the
 *   policy's own, else the one it inherits (whole link, no merge, D5). An
 *   unresolvable parent fails CLOSED: "can't tell" must not read as "no parent".
 * - #11070, vendor updates: an armed oem_updates link (own, else inherited
 *   whole) needs devices.execute + MFA. Unresolvable parent fails closed.
 */
export function checkAddArming(
  auth: AuthContext,
  permissions: UserPermissions | undefined,
  policy: LoadedPolicy,
): AssignmentGateResult {
  const ownsWarrantyLink = !!policy.featureLinks?.some(
    (l: { featureType: string }) => l.featureType === 'warranty',
  );
  const parentUnresolved = !!policy.parentPolicyId && !policy.parentPolicy;
  const assignmentStartsHpCmslCollection = ownsWarrantyLink
    ? warrantyLinkEnablesCollection(policy.featureLinks)
    : parentUnresolved || warrantyLinkEnablesCollection(policy.parentPolicy?.featureLinks);
  if (assignmentStartsHpCmslCollection) {
    const gate = checkHpCmslWriteAllowed(auth, permissions);
    if (!gate.allowed) return { ok: false, status: 403, body: gate.body };
  }

  if (policyArmsOemUpdates(policy)) {
    const gate = checkOemUpdatesArmAllowed(auth, permissions);
    if (!gate.allowed) return { ok: false, status: 403, body: gate.body };
  }
  return OK;
}
