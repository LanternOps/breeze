/**
 * Wisp W07 — specialist kind policy (Wisp design §3, §7.5; w00 "Specialists
 * (W07)", A30).
 *
 * A specialist request is Wisp handing bounded work to an existing agent: a
 * sweep, a sandbox analysis, an Operator recipe, a patch plan, remediation
 * research, or the pinned bulk ticket reply. This table is the ONE place that
 * says, per kind, whether the coordinator may admit it alone (spec §3 "acts
 * alone") or must raise an approval card first, which human permissions the
 * grant's ceiling (and, on the approval path, the approver) must hold, and the
 * budget estimate the coordinator pre-checks against the grant.
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
  | 'bulk_ticket_reply';

export const SPECIALIST_KINDS: readonly SpecialistKind[] = Object.freeze([
  'sweep',
  'analysis',
  'operator_recipe',
  'patch_plan',
  'remediation_research',
  'bulk_ticket_reply',
] as const);

export interface SpecialistKindPolicy {
  readonly kind: SpecialistKind;
  readonly operationKey: `launch_specialist:${SpecialistKind}`;
  /** true ⇔ spec §3 "acts alone": an assessment may admit it without a card. */
  readonly autoAdmit: boolean;
  /** Ceiling terms. `ai_agents:write` always; analysis adds `ai_workspace:execute`. */
  readonly requiredPermissions: readonly string[];
  /** Grant-budget pre-check (coordinator gate 7); admission's own reservation is the real meter. */
  readonly estimateCents: number;
  /** remediation_research only: the request must name a device in the org. */
  readonly requiresDevice: boolean;
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
    autoAdmit: true,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 25,
    requiresDevice: false,
  }),
  analysis: entry('analysis', {
    autoAdmit: true,
    requiredPermissions: ['ai_agents:write', 'ai_workspace:execute'],
    estimateCents: 100,
    requiresDevice: false,
  }),
  operator_recipe: entry('operator_recipe', {
    autoAdmit: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: false,
  }),
  patch_plan: entry('patch_plan', {
    autoAdmit: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: false,
  }),
  remediation_research: entry('remediation_research', {
    autoAdmit: false,
    requiredPermissions: ['ai_agents:write'],
    estimateCents: 50,
    requiresDevice: true,
  }),
  // w00 A30: "sending anything to a client contact" asks first (spec §3) — the
  // card shows the exact ticket list and message; one tap covers the batch.
  bulk_ticket_reply: entry('bulk_ticket_reply', {
    autoAdmit: false,
    requiredPermissions: ['ai_agents:write', 'tickets:write'],
    estimateCents: 50,
    requiresDevice: false,
  }),
});

/** Captured requests beyond this per assessment run are refused `too_many_requests`. */
export const MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT = 3;

export function isSpecialistKind(value: unknown): value is SpecialistKind {
  return typeof value === 'string' && (SPECIALIST_KINDS as readonly string[]).includes(value);
}
