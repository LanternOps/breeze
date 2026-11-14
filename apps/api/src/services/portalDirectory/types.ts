export type DirectorySource = 'entra' | 'google';
export type IdentityBlocker = 'entra_directory' | 'google_directory' | 'scim' | 'msp';
export type IdentityDisabledReason = 'account_disabled' | 'absent' | 'suspended' | 'archived' | 'scim_deactivated' | 'msp';
export interface DisableIdentityInput {
  orgId: string; identityId: string;
  blocker: IdentityBlocker; reason: IdentityDisabledReason;
  actionId?: string;                                          // directory runs only; W9 passes none
  expect?: { directoryChain: string };                        // the apply-time re-check (D8d); omitted by W9
  now?: Date;
}
export type DisableIdentityResult =
  | { kind: 'disabled'; portalUserId: string; accountDisabled: boolean; keepsPassword: boolean }
  | { kind: 'blocker_added'; portalUserId: string; accountDisabled: boolean }     // already disabled by another blocker
  // action_not_held: the run's action is no longer `held` (dismissed, superseded or already applied
  // between applyRun's read and this action's transaction) — nothing is written.
  | { kind: 'skipped'; reason: 'already_blocked' | 'not_found' | 'chain_changed' | 'rearmed' | 'action_not_held' };
