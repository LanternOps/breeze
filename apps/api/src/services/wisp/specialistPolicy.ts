/**
 * Wisp W07 — specialist kind policy (Wisp design §3, §7.5; w00 "Specialists
 * (W07)", A30).
 *
 * A specialist request is Wisp handing bounded work to an existing agent: a
 * sweep, a sandbox analysis, an Operator recipe, a patch plan, remediation
 * research, the pinned bulk ticket reply, a device-troubleshooting run
 * (#11084), or Wisp's own assessment of an org on demand (#10406). This table is the ONE place that says, per kind, the chat launch
 * tier (Tier 2 = one ordinary card under per_step; Tier 3 = a supervised
 * approval), whether an assessment may admit it alone (spec §3 "acts alone")
 * or must raise an approval card first, which human permissions the grant's
 * ceiling (and, on the approval path, the approver) must hold, and the budget
 * estimate the coordinator pre-checks against the grant.
 *
 * The two admission answers are separate fields (plan Decision 3, #11084):
 * handing a device off from chat should cost one ordinary click, while an
 * assessment must still not start device work unattended.
 *
 * There is no partner-configurable "auto-approved Tier-2 set" in code (plan
 * reconciliation note 1): the auto-admit set is code-owned here. A partner
 * override is a named follow-up, not this wave.
 *
 * `requiredPermissions` are CEILING terms (w00 A1): the coordinator checks them
 * against the grant ceiling's concrete permission keys (wildcard-aware), and
 * on the user/approval paths against the acting human too. They are not route
 * or tool gates — every Wisp tool gates on `ai_sessions:use`.
 *
 * Leaf module — NO imports — so the coordinator, the tool schemas, the
 * outcome tool and the shared validator can all read it without a cycle.
 */

export type SpecialistKind =
  | 'sweep'
  | 'analysis'
  | 'operator_recipe'
  | 'patch_plan'
  | 'remediation_research'
  | 'bulk_ticket_reply'
  | 'device_troubleshooting'
  | 'assessment';

export const SPECIALIST_KINDS: readonly SpecialistKind[] = Object.freeze([
  'sweep',
  'analysis',
  'operator_recipe',
  'patch_plan',
  'remediation_research',
  'bulk_ticket_reply',
  'device_troubleshooting',
  'assessment',
] as const);

export interface SpecialistKindPolicy {
  readonly kind: SpecialistKind;
  readonly operationKey: `launch_specialist:${SpecialistKind}`;
  /** The chat `launch_specialist` tier: 2 ⇔ TIER2_ACTIONS, 3 ⇔ TIER3(_SUPERVISED)_ACTIONS (aiGuardrails.ts). */
  readonly chatLaunchTier: 2 | 3;
  /** true ⇔ spec §3 "acts alone": an assessment may admit it without a card (coordinator gate 9). */
  readonly autoAdmitFromAssessment: boolean;
  /** Ceiling terms. `ai_agents:write` always; analysis adds `ai_workspace:execute`, device_troubleshooting `devices:execute`. */
  readonly requiredPermissions: readonly string[];
  /** Grant-budget pre-check (coordinator gate 7); admission's own reservation is the real meter. */
  readonly estimateCents: number;
  /** remediation_research and device_troubleshooting: the request must name a device in the org. */
  readonly requiresDevice: boolean;
  /**
   * true ⇔ only a person in chat may launch it (requester `user`): the
   * coordinator refuses the run and approval paths `unknown_kind` (#10406).
   * `autoAdmitFromAssessment: false` alone would only turn an assessment's
   * request into a card, so an assessment could still ask for more.
   */
  readonly chatOnly: boolean;
}

function entry(
  kind: SpecialistKind,
  rest: Omit<SpecialistKindPolicy, 'kind' | 'operationKey'>,
): SpecialistKindPolicy {
  return Object.freeze({
    kind,
    operationKey: `launch_specialist:${kind}` as const,
    ...rest,
    requiredPermissions: Object.freeze([...rest.requiredPermissions]),
  });
}

export const SPECIALIST_KIND_POLICY: Readonly<Record<SpecialistKind, SpecialistKindPolicy>> = Object.freeze({
  sweep: entry('sweep', {
    chatLaunchTier: 2,
    autoAdmitFromAssessment: true,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 25,
    requiresDevice: false,
    chatOnly: false,
  }),
  analysis: entry('analysis', {
    chatLaunchTier: 2,
    autoAdmitFromAssessment: true,
    requiredPermissions: ['ai_agents:write', 'ai_workspace:execute'],
    estimateCents: 100,
    requiresDevice: false,
    chatOnly: false,
  }),
  operator_recipe: entry('operator_recipe', {
    chatLaunchTier: 3,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: false,
    chatOnly: false,
  }),
  patch_plan: entry('patch_plan', {
    chatLaunchTier: 3,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: false,
    chatOnly: false,
  }),
  remediation_research: entry('remediation_research', {
    chatLaunchTier: 3,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: true,
    chatOnly: false,
  }),
  // w00 A30: "sending anything to a client contact" asks first (spec §3) — the
  // card shows the exact ticket list and message; one tap covers the batch.
  bulk_ticket_reply: entry('bulk_ticket_reply', {
    chatLaunchTier: 3,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write', 'tickets:write'],
    estimateCents: 50,
    requiresDevice: false,
    chatOnly: false,
  }),
  // #11084: a device-pinned, forced-shadow run whose every change is its own
  // approval intent. A chat hand-off is Tier 2 (the person asked for it);
  // an assessment asking for one raises a wisp_specialist_request card.
  device_troubleshooting: entry('device_troubleshooting', {
    chatLaunchTier: 2,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write', 'devices:execute'],
    estimateCents: 100,
    requiresDevice: true,
    chatOnly: false,
  }),
  // #10406 (spec §3 Option C): "go through the open alerts" from chat starts
  // Wisp's own assessment for the org, or for up to 10 ceiling orgs with open
  // alerts. One ordinary card under per_step, as for a sweep. The estimate is
  // ASSESSMENT_BUDGET_CENTS_PER_RUN (aiAgents/assessmentProfile.ts; this
  // leaf imports nothing, specialistPolicy.test.ts pins the two equal) per
  // org: the launcher pre-checks N x it. Chat-only: an assessment never
  // starts, or asks a person to start, more assessments.
  assessment: entry('assessment', {
    chatLaunchTier: 2,
    autoAdmitFromAssessment: false,
    requiredPermissions: ['ai_agents:write', 'alerts:read'],
    estimateCents: 25,
    requiresDevice: false,
    chatOnly: true,
  }),
});

/** Approval-card copy per kind ("Wisp wants to run <label> at <org>"). */
export const SPECIALIST_KIND_LABELS: Readonly<Record<SpecialistKind, string>> = Object.freeze({
  sweep: 'a health sweep',
  analysis: 'a sandbox analysis',
  operator_recipe: 'an Operator task',
  patch_plan: 'a patch plan',
  remediation_research: 'remediation research',
  bulk_ticket_reply: 'one reply to a set of tickets',
  device_troubleshooting: 'device troubleshooting',
  assessment: 'a Wisp assessment',
});

/** Kinds by chat launch tier, derived from the table (the chat tier tables in aiGuardrails.ts read these). */
export const CHAT_TIER2_SPECIALIST_KINDS: readonly SpecialistKind[] = Object.freeze(
  SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].chatLaunchTier === 2),
);
export const CHAT_TIER3_SPECIALIST_KINDS: readonly SpecialistKind[] = Object.freeze(
  SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].chatLaunchTier === 3),
);
/** Kinds an assessment may admit without an approval card (coordinator gate 9). */
export const ASSESSMENT_AUTO_ADMIT_SPECIALIST_KINDS: readonly SpecialistKind[] = Object.freeze(
  SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].autoAdmitFromAssessment),
);

/** The approval carrier's tool name (plan Task 4). Here, in the leaf, so the tool registry can name it without importing the intent graph. */
export const WISP_SPECIALIST_REQUEST_TOOL = 'wisp_specialist_request';

/** Captured requests beyond this per assessment run are refused `too_many_requests`. */
export const MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT = 3;

export function isSpecialistKind(value: unknown): value is SpecialistKind {
  return typeof value === 'string' && (SPECIALIST_KINDS as readonly string[]).includes(value);
}
