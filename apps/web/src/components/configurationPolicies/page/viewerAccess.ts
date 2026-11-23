import type { JwtClaimsState } from '@/lib/authScope';
import { hasPermission } from '@/lib/permissions';
import type { Permission } from '../../../stores/auth';

/**
 * Why a caller may view a policy but not change it (spec "States", Viewer).
 * The first three are the API's reasons (plan W03a `policyViewerAccess`);
 * `no_write_permission` and `not_editable` are this page's own.
 */
export type ReadOnlyReason =
  | 'msp_managed_limited_access'
  | 'msp_managed_org_user'
  | 'site_restricted'
  | 'no_write_permission'
  | 'not_editable';

const API_REASONS = new Set<ReadOnlyReason>(['msp_managed_limited_access', 'msp_managed_org_user', 'site_restricted']);

/** `GET /configuration-policies/:id` → `access` (W03a). Absent before W03a. */
export type PolicyAccess = { canEdit: boolean; reason: string | null };

/** Null unless `raw` is a well-formed `access` object. */
export function parsePolicyAccess(raw: unknown): PolicyAccess | null {
  if (!raw || typeof raw !== 'object') return null;
  const { canEdit, reason } = raw as Record<string, unknown>;
  if (typeof canEdit !== 'boolean') return null;
  return { canEdit, reason: typeof reason === 'string' ? reason : null };
}

/** `reason` is null when the page is read-only but cannot yet say why. */
export type ViewerAccess = { canEdit: boolean; reason: ReadOnlyReason | null };

type ViewerInputs = {
  /** The raw `access` field of the policy read; undefined/null = an API before W03a. */
  access: unknown;
  /** null = MSP-managed (partner-owned) policy. */
  policyOrgId: string | null;
  claims: JwtClaimsState;
  /** undefined = not known yet (or a session persisted before the field). */
  permissions: Permission[] | undefined;
  /** /users/me; false for a partner user with access to selected organizations only. Absent = capable. */
  canManagePartnerWide: boolean | undefined;
};

/**
 * Whether the page renders its editing controls. UX only: every write route
 * re-checks on the server.
 *
 * Order: the API's `access` when it sent one; else this page's fail-closed
 * rule for MSP-managed policies; then `devices.write`, which every write
 * needs. An unknown permission list is left to the server rather than
 * locking a session whose stored user predates the field.
 */
export function resolveViewerAccess({
  access,
  policyOrgId,
  claims,
  permissions,
  canManagePartnerWide,
}: ViewerInputs): ViewerAccess {
  const sent = access !== undefined && access !== null;
  const parsed = sent ? parsePolicyAccess(access) : null;
  if (sent && !parsed) {
    // The API sent an access answer this page cannot read: fail closed.
    console.warn('[configuration policies] unreadable access field', access);
    return { canEdit: false, reason: 'not_editable' };
  }
  if (parsed && !parsed.canEdit) {
    const reason = parsed.reason as ReadOnlyReason | null;
    return { canEdit: false, reason: reason && API_REASONS.has(reason) ? reason : 'not_editable' };
  }
  if (!parsed && policyOrgId === null) {
    if (claims.status !== 'resolved') return { canEdit: false, reason: null };
    const { scope } = claims.claims;
    if (scope === 'organization') return { canEdit: false, reason: 'msp_managed_org_user' };
    if (scope === 'partner' && canManagePartnerWide === false) {
      return { canEdit: false, reason: 'msp_managed_limited_access' };
    }
    if (scope !== 'partner' && scope !== 'system') return { canEdit: false, reason: null };
  }
  if (permissions && !hasPermission(permissions, 'devices', 'write')) {
    return { canEdit: false, reason: 'no_write_permission' };
  }
  return { canEdit: true, reason: null };
}
