import {
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  ALERT_SEVERITIES,
  type AiAgentDto,
  type AiAgentKind,
  type AiAgentMode,
} from '@breeze/shared';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';

/**
 * Task 13 (#5051), Order-of-work step 1: extracted from `AiAgentForm.tsx` so
 * both the edit drawer and the four-step guided create flow
 * (`AgentCreateFlow.tsx`) build the identical `Draft` shape and the identical
 * `POST`/`PATCH` body from it — a pure move, not a behavior change. Every
 * export here is exactly the logic `AiAgentForm.tsx` used to own directly.
 */

// Severities come from @breeze/shared, the same constant the server validator
// uses. A local copy meant draftFrom() would silently DROP a stored severity
// the two lists disagreed on, and the next save would write the truncated list.
const SEVERITIES = ALERT_SEVERITIES;
export type Severity = (typeof ALERT_SEVERITIES)[number];

/**
 * Kinds whose runs can ever carry an alert severity — i.e. the only kinds for
 * which `triggers.alertSeverities` is read at all.
 *
 * `runService.ts` evaluates the severity list inside
 * `evaluateAgentTriggerFilters`, which runs ONLY when the admission input
 * carries an `alertContext`, and both producers of one
 * (`alertVerdictSubscriber.ts` and `automationRuntime.ts`) admit with
 * `kind: 'triage'`. A helpdesk agent is admitted from a ticket
 * (`ticketHelpdeskSubscriber.ts`, `ticketContext`), a patch agent from a
 * manual or scheduled trigger — neither carries a severity, so the list is
 * inert for both.
 *
 * Showing the control for those kinds asked the operator to make a choice
 * that could never take effect, and the client-side `.min(1)` check could
 * block a save over a field the server never reads for that kind. Hidden AND
 * omitted from the payload: on PATCH the one-level merge preserves whatever
 * is stored, and on create the server's `aiAgentTriggersSchema` supplies its
 * own `['critical', 'high']` default, so omission is never a `.min(1)` 400.
 */
export const ALERT_SEVERITY_KINDS: ReadonlySet<AiAgentKind> = new Set<AiAgentKind>(['triage']);

/** Newline-separated textarea → trimmed, de-duplicated list. */
export function lines(value: string): string[] {
  return [...new Set(value.split('\n').map((entry) => entry.trim()).filter(Boolean))];
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/**
 * Kinds still creatable for one ownership axis. The DB enforces
 * `(partner_id, kind) WHERE org_id IS NULL` and `(org_id, kind)` as two
 * independent partial uniques, both `WHERE disabled_at IS NULL`, so a kind is
 * only taken for the owner that actually holds it.
 */
export function freeKinds(
  agents: AiAgentDto[],
  ownerScope: OwnerScope,
  orgId: string | null,
): AiAgentKind[] {
  const taken = new Set(
    agents
      .filter((row) =>
        ownerScope === 'partner'
          ? row.ownerScope === 'partner'
          : row.ownerScope === 'organization' && row.orgId === orgId,
      )
      .map((row) => row.kind),
  );
  return AI_AGENT_KINDS.filter((kind) => !taken.has(kind));
}

export function firstFreeKind(
  agents: AiAgentDto[],
  ownerScope: OwnerScope,
  orgId: string | null,
): AiAgentKind | undefined {
  return freeKinds(agents, ownerScope, orgId)[0];
}

export interface Draft {
  ownerScope: OwnerScope;
  kind: AiAgentKind;
  name: string;
  enabled: boolean;
  mode: AiAgentMode;
  severities: Severity[];
  respectMaintenanceWindows: boolean;
  toolAllowlist: string;
  services: string;
  paths: string;
  registryKeys: string;
  limits: typeof AI_AGENT_LIMIT_DEFAULTS;
  cooldownSeconds: number;
  roleIds: string[];
  instructions: string;
  /** Wave 5 Part B (#3827). Operator's per-agent opt-in to unattended
   *  policy-decided authorization — see actAssets in `buildAgentSaveBody` below. */
  supervisedActionKeys: string[];
  /** P2-4 (#4191). Org-row-only opt-in that lifts the forced-shadow behavior
   *  for ticket-triggered runs — same "reads ONLY the org's own override"
   *  merge semantics as `anomalyEnabled` (never itself surfaced on this
   *  form). See `AiAgentTriggers.ticketAutonomousWrites`'s docstring. */
  ticketAutonomousWrites: boolean;
}

export function draftFrom(
  agent: AiAgentDto | null,
  defaults: { ownerScope: OwnerScope; kind: AiAgentKind },
): Draft {
  const severities = (agent?.triggers?.alertSeverities ?? ['critical', 'high']).filter(
    (severity): severity is Severity => (SEVERITIES as readonly string[]).includes(severity),
  );
  return {
    ownerScope: agent?.ownerScope ?? defaults.ownerScope,
    kind: agent?.kind ?? defaults.kind,
    name: agent?.name ?? '',
    // CREATE defaults (the `??` fallbacks only ever apply when `agent` is
    // null): shadow, but SWITCHED OFF.
    //
    // `mode: 'shadow'` is what the first-run panel tells the operator to start
    // with, and the form used to contradict it by defaulting to `off`.
    // `enabled` was flipped to `true` in the same change and that went too far:
    // `enabled` is the live switch, not a mode preview. `syncManagedAutomation`
    // mirrors it onto the seeded automation the moment Save lands, and shadow
    // passes run admission — so creating a partner-wide triage agent started
    // real LLM runs across every org under the partner before anyone had looked
    // at the tool allowlist, the severities or the daily budget on the very
    // form that created it. Off is the only honest default for a switch whose
    // first flip spends money on machines the operator has not scoped yet; the
    // create-only hint beside the checkbox says so, so the unticked box reads
    // as a decision rather than an oversight.
    enabled: agent?.enabled ?? false,
    mode: agent?.mode ?? 'shadow',
    severities,
    respectMaintenanceWindows: agent?.triggers?.respectMaintenanceWindows ?? true,
    toolAllowlist: (agent?.toolAllowlist ?? []).join('\n'),
    services: (agent?.protectedResources?.services ?? []).join('\n'),
    paths: (agent?.protectedResources?.paths ?? []).join('\n'),
    registryKeys: (agent?.protectedResources?.registryKeys ?? []).join('\n'),
    limits: { ...AI_AGENT_LIMIT_DEFAULTS, ...(agent?.limits ?? {}) },
    cooldownSeconds: agent?.cooldownSeconds ?? 900,
    roleIds: agent?.recipients?.roleIds ?? [],
    instructions: agent?.instructions ?? '',
    supervisedActionKeys: agent?.actAssets?.supervisedActionKeys ?? [],
    ticketAutonomousWrites: agent?.triggers?.ticketAutonomousWrites ?? false,
  };
}

/**
 * Builds exactly the JSON body `AiAgentForm.tsx`'s `save()` used to construct
 * inline — the one-level-PATCH-merge reasoning (severities/actAssets
 * omission rules) lives here now, unchanged, so a caller never has to
 * re-derive it. `isCreate` adds the create-only `kind`/`ownerScope`/`orgId`
 * fields; a PATCH body is the policy object alone.
 */
export function buildAgentSaveBody(
  draft: Draft,
  opts: { isCreate: boolean; orgId: string | null },
): Record<string, unknown> {
  // On PATCH the server merges each nested object one level onto the stored
  // jsonb (updatePolicyColumns), so the narrowing fields this form does not
  // expose — triggers.siteIds / deviceGroupIds / deviceTags,
  // protectedResources.deviceTags, recipients.userIds — survive a save rather
  // than being erased, which would silently WIDEN the agent's blast radius.
  // One level is enough only because every sub-value is a scalar or an array
  // today; a nested object inside one of these would need a real deep merge.
  // On create there is nothing to merge — these are written wholesale.
  const policy: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    mode: draft.mode,
    triggers: {
      // Omitted, not sent as the draft value, for a kind whose runs can
      // never carry a severity (see ALERT_SEVERITY_KINDS): the form does not
      // show the control there, and sending a value the operator was never
      // offered would silently rewrite a stored list they cannot see. The
      // PATCH merge keeps what is stored; create takes the server default.
      ...(ALERT_SEVERITY_KINDS.has(draft.kind) ? { alertSeverities: draft.severities } : {}),
      respectMaintenanceWindows: draft.respectMaintenanceWindows,
      ticketAutonomousWrites: draft.ticketAutonomousWrites,
    },
    toolAllowlist: lines(draft.toolAllowlist),
    protectedResources: {
      services: lines(draft.services),
      paths: lines(draft.paths),
      registryKeys: lines(draft.registryKeys),
    },
    limits: draft.limits,
    cooldownSeconds: draft.cooldownSeconds,
    recipients: { roleIds: draft.roleIds },
    instructions: draft.instructions.trim() ? draft.instructions.trim() : null,
    // Wave 5 Part B (#3827): scriptIds is not this form's field to send —
    // omitting it here relies on the SAME one-level PATCH merge the
    // top-of-function comment already documents (updatePolicyColumns
    // merges { ...stored.actAssets, ...input.actAssets }), so an existing
    // scriptIds value survives a save that only ever touches
    // supervisedActionKeys. On create, the server's createAiAgentSchema
    // defaults the omitted scriptIds to [].
    //
    // P2 review fix: the draft KEEPS its supervisedActionKeys selection
    // across a mode change, but a non-act mode can never use them — sent as
    // [] rather than the draft's live value so leaving act genuinely revokes
    // them server-side, not just in the UI, while still letting the
    // operator's selection reappear if they return to act before saving.
    //
    // #5049: an ORG row OMITS `actAssets` entirely instead — the server
    // now 422s (`supervised_keys_grant_only`) any org-row write that ADDS
    // a key the row does not already hold, because a key goes live on an
    // org row only through the four-eyes grant executor (spec §4.4). Neither
    // caller offers an org row an editable selection, so there is nothing of
    // the operator's to send; omitting the property is what "leave the
    // stored value alone" means to the same one-level PATCH merge this
    // function already relies on for scriptIds above, and the server
    // defaults a create's omitted key to `[]`. Partner rows are the ceiling
    // and are still edited directly here, so they keep the
    // live-selection behavior.
    ...(draft.ownerScope === 'organization'
      ? {}
      : { actAssets: { supervisedActionKeys: draft.mode === 'act' ? draft.supervisedActionKeys : [] } }),
  };

  if (!opts.isCreate) return policy;

  const body: Record<string, unknown> = {
    ...policy,
    kind: draft.kind,
    ownerScope: draft.ownerScope,
  };
  if (draft.ownerScope === 'organization') body.orgId = opts.orgId;
  return body;
}
