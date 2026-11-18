export type DirectorySource = 'entra' | 'google';
export type IdentityBlocker = 'entra_directory' | 'google_directory' | 'scim' | 'msp';
export type IdentityDisabledReason = 'account_disabled' | 'absent' | 'suspended' | 'archived' | 'scim_deactivated' | 'msp';

/**
 * D8d: the directory a run read is no longer the one the org is bound to —
 * the connection was re-consented, re-bound, revoked or removed
 * (`connection_changed`), the Entra tenant is no longer proven
 * (`tenant_not_proven`), or the org or its partner is inactive (`org_inactive`).
 */
export type DirectorySourceRecheckFailure = 'connection_changed' | 'tenant_not_proven' | 'org_inactive';

export interface DisableIdentityInput {
  orgId: string; identityId: string;
  blocker: IdentityBlocker; reason: IdentityDisabledReason;
  actionId?: string;                                          // directory runs only; W9 passes none
  /**
   * The apply-time re-check (D8d); omitted by W9. `verifySource` runs inside
   * the action's transaction AFTER the account and identity locks, so the row
   * locks it takes (`FOR SHARE` on the connection / tenant mapping) are held
   * to commit.
   */
  expect?: { directoryChain: string; verifySource?: () => Promise<DirectorySourceRecheckFailure | null> };
  /**
   * W9 (#11386, plan D10): extra details for the disable's audit row (SCIM
   * passes `{ via: 'scim', scimTokenId }`). Merged UNDER the writer's own
   * fields, so a caller can never overwrite identityId / blocker / reason.
   */
  auditDetails?: Record<string, unknown>;
  now?: Date;
}
export type DisableIdentityResult =
  | { kind: 'disabled'; portalUserId: string; accountDisabled: boolean; keepsPassword: boolean }
  | { kind: 'blocker_added'; portalUserId: string; accountDisabled: boolean }     // already disabled by another blocker
  // action_not_pending: the run's action no longer awaits application (`held`
  //   for a held run, `pending` for an auto-apply run) — dismissed, superseded or
  //   already applied between applyRun's read and this action's transaction.
  // observation_changed: a newer run evaluated the identity since the action was
  //   planned (`directory_last_run_id` is not the action's run).
  // Nothing is written for any skip.
  | {
      kind: 'skipped';
      reason: 'already_blocked' | 'not_found' | 'chain_changed' | 'rearmed' | 'action_not_pending' | 'observation_changed'
        | DirectorySourceRecheckFailure;
    };
