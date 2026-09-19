/**
 * Fleet Designer W03 (#5653) — apply / rollback contract.
 *
 * Item-ref grammar (server-assigned on the outcome, echoed by the client):
 *   functions:<functionKey>
 *   monitoring:<functionKey>:watch:<n> | monitoring:<functionKey>:rule:<n>
 *   retired:<n>
 *   automation:<functionKey>:script:<n>   (W04: creates a script in step 4)
 *   legacy:<scriptId>                     (W04, informational)
 *   roleCorrections:<deviceId>
 *   policy:<functionKey>                  (ledger-only: the policy a function's monitoring lives in)
 *   step:<n>                              (ledger-only: a failed step)
 */

export interface FleetDesignApproval {
  /** functionKeys */
  functions: string[];
  /** monitoring:<key>:watch:<n> | monitoring:<key>:rule:<n> */
  monitoring: string[];
  /** retired:<n> */
  retired: string[];
  /** automation:<key>:script:<n> (W04) */
  automation: string[];
  /** legacy:<scriptId> (W04, informational) */
  legacy: string[];
  /** deviceIds */
  roleCorrections: string[];
  /** policyIds the technician accepts to displace (preview output). */
  displacementsAccepted: string[];
}

export interface FleetDesignApplyPreviewFunction {
  functionKey: string;
  label: string;
  groupId: string | null;
  groupName: string;
  deviceCount: number;
  devicesAdded: string[];
  devicesRemoved: string[];
  keptManual: number;
  missingDevices: string[];
}

export interface FleetDesignApplyDisplacement {
  policyId: string;
  policyName: string;
  featureType: 'monitoring' | 'alert_rule';
  deviceCount: number;
}

export interface FleetDesignApplyPreviewPolicy {
  functionKey: string;
  policyName: string;
  watchCount: number;
  ruleCount: number;
  displaces: FleetDesignApplyDisplacement[];
}

export interface FleetDesignApplyPreviewRetired {
  itemRef: string;
  policyId: string;
  policyName: string;
  kind: 'watch' | 'rule';
  itemName: string;
  found: boolean;
  editable: boolean;
}

export interface FleetDesignApplyPreviewRoleCorrection {
  deviceId: string;
  hostname: string;
  from: string;
  to: string;
  billingRelevant: true;
}

/** Step 4 (W04 #5654): an approved script the apply will create, org-owned,
 *  tagged `fleet-design`. `alreadyExists` = a script of that name is already
 *  in the library, so the created one gets a ` (2)` style suffix. */
export interface FleetDesignApplyPreviewScript {
  itemRef: string;
  functionKey: string;
  name: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  osTypes: string[];
  alreadyExists: boolean;
}

export interface FleetDesignApplyPreview {
  functions: FleetDesignApplyPreviewFunction[];
  policies: FleetDesignApplyPreviewPolicy[];
  retired: FleetDesignApplyPreviewRetired[];
  scripts: FleetDesignApplyPreviewScript[];
  roleCorrections: FleetDesignApplyPreviewRoleCorrection[];
  /** Item refs with an `applied` ledger row (skipped on apply). */
  alreadyApplied: string[];
  blockers: { itemRef: string; reason: string }[];
}

export interface FleetDesignApplyResult {
  applied: string[];
  skipped: string[];
  partial: { failedStep: number; reason: string } | null;
  rollbackAvailable: boolean;
}

export type FleetDesignLedgerStatus = 'applied' | 'rolled_back' | 'failed';
export type FleetDesignLedgerKind = 'function' | 'policy' | 'watch' | 'rule' | 'retired' | 'script' | 'role_correction';

export interface FleetDesignLedgerItem {
  id: string;
  itemRef: string;
  itemKind: FleetDesignLedgerKind;
  status: FleetDesignLedgerStatus;
  step: number;
  createdRefs: Record<string, unknown>;
  error: string | null;
  appliedAt: string;
  rolledBackAt: string | null;
}

export type FleetDesignRollbackRefusal =
  | 'modified_since_apply'
  | 'group_has_other_members'
  | 'policy_missing'
  | 'partner_wide_write_denied'
  /** W04: untagging a created script is a script write; the caller lacks scripts:write. */
  | 'scripts_write_required';

export interface FleetDesignRollbackResult {
  rolledBack: string[];
  refused: { itemRef: string; reason: FleetDesignRollbackRefusal }[];
}

/** `fleet_design_applied_items.created_refs` — ids the apply created or reused. */
export type FleetDesignCreatedRefs = {
  groupId?: string;
  groupCreated?: boolean;
  assessmentIds?: string[];
  policyId?: string;
  monitoringLinkId?: string;
  alertRuleLinkId?: string;
  assignmentId?: string;
  linkId?: string;
  linksSnapshot?: { monitoring: unknown; alertRule: unknown };
  membershipSnapshot?: string[];
  scriptId?: string;
  /** W04: the name the script was created under (may carry a rename suffix). */
  scriptName?: string;
};

/** `fleet_design_applied_items.before_image` — state before the apply, for rollback. */
export type FleetDesignBeforeImage = {
  inlineSettings?: unknown;
  deviceRole?: string;
  deviceRoleSource?: string;
  priorAssessmentIdByDevice?: Record<string, string | null>;
  memberships?: string[];
};
