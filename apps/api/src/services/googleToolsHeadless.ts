/**
 * Headless dispatch for Google Workspace Tier-3 tools, used by the durable
 * action-intents release worker. Resolves the one-per-org Google connection by
 * an explicit orgId (the immutable intent.orgId) — NO live SSE session — and
 * re-authorizes it (org match + active) at execution time via resolveContextByOrg.
 *
 * The action map is the effective allowlist: only these vetted Tier-3 mutations
 * ever run headless, and a parity test pins it to the tier-3 googleToolTiers set.
 */
import {
  resolveContextByOrg,
  googleResetPasswordAction,
  googleSuspendUserAction,
  googleRestoreUserAction,
  googleSignOutAction,
  googleSetForwardingAction,
  googleDisableForwardingAction,
  googleSetVacationAction,
  googleUpdateUserAction,
  googleShareCalendarAction,
  googleOffboardUserAction,
  googleWipeMobileDeviceAction,
  googleAddToGroupAction,
  googleRemoveFromGroupAction,
  googleMoveOuAction,
  googleRenameUserAction,
  googleResetTwoSvAction,
  googleAddMailDelegateAction,
  googleRemoveMailDelegateAction,
  googleAssignLicenseAction,
  googleRemoveLicenseAction,
  type GoogleToolContext,
} from './aiToolsGoogle';

type GoogleAction = (ctx: GoogleToolContext, input: Record<string, unknown>) => Promise<string>;

/** Thrown when the org's Google connection is missing/rotated/inactive at release. */
export class GoogleConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) {
    super('Google Workspace connection unavailable for headless release');
    this.name = 'GoogleConnectionUnavailableError';
  }
}

export const GOOGLE_HEADLESS_ACTIONS: Record<string, GoogleAction> = {
  google_reset_password: googleResetPasswordAction,
  google_suspend_user: googleSuspendUserAction,
  google_restore_user: googleRestoreUserAction,
  google_signout: googleSignOutAction,
  google_set_forwarding: googleSetForwardingAction,
  google_disable_forwarding: googleDisableForwardingAction,
  google_set_vacation: googleSetVacationAction,
  google_update_user: googleUpdateUserAction,
  google_share_calendar: googleShareCalendarAction,
  google_offboard_user: googleOffboardUserAction,
  google_wipe_mobile_device: googleWipeMobileDeviceAction,
  google_add_to_group: googleAddToGroupAction,
  google_remove_from_group: googleRemoveFromGroupAction,
  google_move_ou: googleMoveOuAction,
  google_rename_user: googleRenameUserAction,
  google_reset_2sv: googleResetTwoSvAction,
  google_add_mail_delegate: googleAddMailDelegateAction,
  google_remove_mail_delegate: googleRemoveMailDelegateAction,
  google_assign_license: googleAssignLicenseAction,
  google_remove_license: googleRemoveLicenseAction,
};
// Invariant: keys(GOOGLE_HEADLESS_ACTIONS) === tier-3 googleToolTiers set.
// Enforced by the parity unit test in googleToolsHeadless.test.ts.

export function isHeadlessGoogleTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GOOGLE_HEADLESS_ACTIONS, name);
}

export async function executeGoogleToolHeadless(
  actionName: string,
  args: unknown,
  orgId: string,
): Promise<string> {
  const action = GOOGLE_HEADLESS_ACTIONS[actionName];
  if (!action) {
    throw new Error(`executeGoogleToolHeadless: "${actionName}" is not a headless Google tool`);
  }
  const ctx = await resolveContextByOrg(orgId);
  if ('error' in ctx) {
    throw new GoogleConnectionUnavailableError(ctx.error);
  }
  return action(ctx, (args ?? {}) as Record<string, unknown>);
}
