/**
 * #4177 (W04) — Tier-2 time-entry PROPOSAL from AI-assisted ticket work.
 *
 * When a technician sends an AI-drafted reply or resolves a ticket with an AI
 * resolution note, this module mints a `manage_tickets:log_time_entry`
 * action intent under the run that authored the draft. It is a PROPOSAL and
 * nothing else:
 *
 *  - The intent is created under the run's own `ai_agent` principal, which
 *    `createActionIntent` classifies as `approvalScope: 'supervised'` and
 *    `policyDecisionState: 'human_required'` for every Tier-2 tool — and we
 *    pass an explicit `scope: { ticketId }`, which is human-required a second
 *    time over. No `autonomy` is ever requested here.
 *  - Release (jobs/intentReleaseWorker.ts) executes the entry as the
 *    APPROVING technician (`action_intents.decided_by_user_id`), never as the
 *    agent — `time_entries.user_id` is a `users` FK. See
 *    `USER_OWNED_RELEASE_ACTIONS` there.
 *  - The technician's send/resolve can never fail because of this lane:
 *    ticketService only writes an outbox claim, and the mint happens in
 *    the helpdesk event subscriber after that transaction has committed.
 *    Inside the subscriber the contract is the registry's — a handler MUST
 *    throw on a retry-worthy failure (5× BullMQ retry) and must NOT throw
 *    on a permanent one. So: every business "no" (unresolvable lineage,
 *    org mismatch, a claim the draft row disagrees with, a policy/
 *    idempotency refusal from createActionIntent) is logged and returns
 *    `null`; an infrastructure error (a DB blip, a pool timeout) PROPAGATES
 *    so the retry fires. Minting is idempotent per (run, trigger), so a
 *    retry can never double-mint.
 *
 * Billable and rate come from `getTicketTimeEntryDefaults`, the single
 * existing resolver (`org_ticket_settings.default_billable ??
 * ticket_categories.default_billable ?? false`) — never read the category
 * directly here, or an org-level override silently stops applying to AI
 * proposals while it still applies to manual entries.
 *
 * Duration has no existing resolver because nothing in the schema had a
 * duration default before this wave: `ticket_categories.default_time_entry_minutes`
 * is it, and an unset category falls back to the constant below rather than
 * to zero — a zero-minute proposal is worse than a wrong one, because a
 * technician will approve it without reading it.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { aiAgentRuns, aiAgents, devices, organizations, ticketCategories, ticketDrafts, tickets } from '../db/schema';
import { ActionIntentError, createActionIntent } from './actionIntents/intentService';
import { AgentRunOwnershipError, buildAgentAuthContext } from './aiAgents/agentAuthContext';
import { getTicketTimeEntryDefaults, type TimeEntryActor } from './timeEntryService';

export const AI_TIME_ENTRY_DEFAULT_MINUTES = 15;

export interface AiTimeEntryProposalDefaults {
  durationMinutes: number;
  isBillable: boolean;
}

export type AiTimeEntryProposalTrigger = 'draft_sent' | 'resolved_with_ai_note';

/**
 * The claim `ticketService` writes into the `ticket_outbox` payload when a
 * draft authored by an agent run is consumed. A POINTER only — the
 * subscriber re-reads the draft row and trusts nothing else in it.
 */
export interface AiDraftOutboxClaim {
  draftId: string;
  runId: string;
  trigger: AiTimeEntryProposalTrigger;
}

function parseClaim(raw: unknown): AiDraftOutboxClaim | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.draftId !== 'string' || typeof c.runId !== 'string') return null;
  if (c.trigger !== 'draft_sent' && c.trigger !== 'resolved_with_ai_note') return null;
  return { draftId: c.draftId, runId: c.runId, trigger: c.trigger };
}

/**
 * Read-only actor for `getTicketTimeEntryDefaults`. System-shaped (no partner
 * pin, no org allowlist) because the caller — a service already past the
 * technician's own ticket authorization — is resolving defaults for a ticket
 * it has just written to. NEVER persisted: `resolveTicketLink` only compares
 * `partnerId`/`accessibleOrgIds`, and `userId` is not read on that path. The
 * sentinel below is deliberately not a UUID so it can never satisfy a users
 * FK by accident.
 */
const DEFAULTS_READ_ACTOR: TimeEntryActor = {
  userId: 'ai-time-entry-proposal:read-only',
  partnerId: null,
  manageAll: false,
  accessibleOrgIds: null,
};

/** The draft kind each trigger is minted from — a claim naming the other kind is a forgery or a bug. */
const TRIGGER_DRAFT_KIND: Record<AiTimeEntryProposalTrigger, typeof ticketDrafts.$inferSelect['kind']> = {
  draft_sent: 'reply',
  resolved_with_ai_note: 'resolution_note',
};

const TRIGGER_DESCRIPTION: Record<AiTimeEntryProposalTrigger, string> = {
  draft_sent: 'AI-assisted reply sent',
  resolved_with_ai_note: 'Ticket resolved with AI resolution note',
};

export async function resolveAiTimeEntryDefaults(ticketId: string): Promise<AiTimeEntryProposalDefaults> {
  // System read, escaped from any ambient request context: the caller may be
  // inside a request transaction whose org context can see the ticket but
  // whose scope may not carry the partner-keyed category row's read branch.
  // Same discipline as timeEntryService's getCategoryDefaults.
  const joined = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ defaultTimeEntryMinutes: ticketCategories.defaultTimeEntryMinutes })
        .from(tickets)
        .leftJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
        .where(eq(tickets.id, ticketId))
        .limit(1);
      return row ?? null;
    }),
  );
  const defaults = await getTicketTimeEntryDefaults(ticketId, DEFAULTS_READ_ACTOR);
  const categoryMinutes = joined?.defaultTimeEntryMinutes ?? null;
  return {
    durationMinutes: categoryMinutes != null && categoryMinutes > 0 ? categoryMinutes : AI_TIME_ENTRY_DEFAULT_MINUTES,
    isBillable: defaults.isBillable,
  };
}

interface RunLineage {
  run: { id: string; agentId: string; orgId: string; deviceId: string | null; sessionId: string | null };
  agent: { id: string; orgId: string | null; partnerId: string | null; name: string; kind: typeof aiAgents.$inferSelect['kind'] };
  org: { id: string; partnerId: string };
  deviceSiteId: string | null;
  ticketNumber: string | null;
}

async function loadRunLineage(agentRunId: string, ticketId: string): Promise<RunLineage | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [run] = await db
        .select({
          id: aiAgentRuns.id,
          agentId: aiAgentRuns.agentId,
          orgId: aiAgentRuns.orgId,
          deviceId: aiAgentRuns.deviceId,
          sessionId: aiAgentRuns.sessionId,
        })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, agentRunId))
        .limit(1);
      if (!run) return null;
      const [agent] = await db
        .select({ id: aiAgents.id, orgId: aiAgents.orgId, partnerId: aiAgents.partnerId, name: aiAgents.name, kind: aiAgents.kind })
        .from(aiAgents)
        .where(eq(aiAgents.id, run.agentId))
        .limit(1);
      if (!agent) return null;
      const [org] = await db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, run.orgId))
        .limit(1);
      if (!org) return null;
      let deviceSiteId: string | null = null;
      if (run.deviceId) {
        const [device] = await db
          .select({ siteId: devices.siteId })
          .from(devices)
          .where(eq(devices.id, run.deviceId))
          .limit(1);
        deviceSiteId = device?.siteId ?? null;
      }
      const [ticket] = await db
        .select({ internalNumber: tickets.internalNumber })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      return { run, agent, org, deviceSiteId, ticketNumber: ticket?.internalNumber ?? null };
    }),
  );
}

/**
 * Mint the proposal. Returns `{ intentId }`, or `null` for every PERMANENT
 * reason (see the module header) — each logged with enough context to find
 * the run. Infrastructure errors propagate to the caller's retry.
 *
 * `technicianUserId` is the human whose AI-assisted work the entry would
 * bill. It is recorded on the proposal (`proposedForUserId`) for the
 * approver's benefit and for audit; it is NOT the entry's owner — the
 * approver is (release-time rule, see module header).
 */
export async function proposeTimeEntryForAiAssistedWork(args: {
  ticketId: string;
  orgId: string;
  agentRunId: string;
  trigger: AiTimeEntryProposalTrigger;
  technicianUserId: string;
}): Promise<{ intentId: string } | null> {
  const { ticketId, orgId, agentRunId, trigger, technicianUserId } = args;
  try {
    const lineage = await loadRunLineage(agentRunId, ticketId);
    if (!lineage) {
      console.warn('[aiTimeEntryProposal] run lineage unresolvable — no proposal', { agentRunId, ticketId, trigger });
      return null;
    }
    if (lineage.run.orgId !== orgId) {
      console.warn('[aiTimeEntryProposal] run org does not match the ticket org — no proposal', {
        agentRunId, ticketId, trigger, runOrgId: lineage.run.orgId, ticketOrgId: orgId,
      });
      return null;
    }

    // Rebuilt exactly as the runner and the release path rebuild it —
    // `assertRunOwnership` inside re-proves the agent→run→org lineage.
    const agentAuth = buildAgentAuthContext(
      lineage.agent,
      { id: lineage.run.id, orgId: lineage.run.orgId, deviceId: lineage.run.deviceId, deviceSiteId: lineage.deviceSiteId, sessionId: lineage.run.sessionId },
      lineage.org,
    );

    const defaults = await resolveAiTimeEntryDefaults(ticketId);
    // A concrete block ending now, so the existing `log_time_entry` handler
    // (startedAt + endedAt) can execute it unchanged. Anchored at PROPOSAL
    // time on purpose: that is when the work happened, and approval may be
    // days later across an invoice period.
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - defaults.durationMinutes * 60_000);
    const description = TRIGGER_DESCRIPTION[trigger];
    const ticketLabel = lineage.ticketNumber != null ? `ticket #${lineage.ticketNumber}` : 'ticket';

    const intent = await createActionIntent(agentAuth, {
      toolName: 'manage_tickets',
      input: {
        action: 'log_time_entry',
        ticketId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMinutes: defaults.durationMinutes,
        isBillable: defaults.isBillable,
        description,
        proposedForUserId: technicianUserId,
      },
      source: 'ai_agent',
      orgId,
      reason: `${description} — proposed time entry for review`,
      actionLabel: `Log ${defaults.durationMinutes} min${defaults.isBillable ? ' (billable)' : ''} on ${ticketLabel}`,
      // Stable per (run, trigger): a draft is consumed exactly once, so a
      // redelivered call converges on the one live intent.
      idempotencyKey: `ai-time-entry:${agentRunId}:${trigger}`,
      scope: { ticketId },
      // NO `autonomy` — deliberately. evaluateTicketAutonomy governs the
      // triage write lane; a billing-adjacent proposal must always land in
      // the human-review inbox.
    });
    return { intentId: intent.id };
  } catch (err) {
    // Permanent refusals only: a run whose lineage no longer proves
    // ownership, or an intent-service policy/idempotency/scope refusal
    // (agent_policy_denied, idempotency_conflict, agent_run_invalid, …).
    // Anything else is an infrastructure failure and must reach the
    // subscriber's retry — never mask a DB blip as a business "no".
    if (err instanceof AgentRunOwnershipError || err instanceof ActionIntentError) {
      console.warn('[aiTimeEntryProposal] proposal refused — no proposal', {
        agentRunId, ticketId, trigger, technicianUserId,
        code: err instanceof ActionIntentError ? err.code : 'agent_run_ownership_mismatch',
        error: err.message,
      });
      return null;
    }
    throw err;
  }
}

/**
 * Subscriber entry point (services/aiAgents/ticketHelpdeskSubscriber.ts):
 * mint the proposal from an outbox event's `aiDraft` claim. Every claim is
 * verified against the draft row under a system read — the draft must exist,
 * belong to this ticket AND org, be `consumed`, and name the claimed run;
 * the technician is the row's `consumed_by`, never a payload field, and the
 * draft's `kind` must be the one the claimed trigger implies (a reply draft
 * is `draft_sent`, a resolution note is `resolved_with_ai_note`). Any
 * mismatch is logged and dropped (returns null): the event is a redelivered
 * pointer, and a claim that does not match the database is not something to
 * retry into existence. Infrastructure errors propagate (module header).
 */
export async function proposeTimeEntryFromOutboxClaim(args: {
  orgId: string;
  ticketId: string;
  claim: unknown;
}): Promise<{ intentId: string } | null> {
  const claim = parseClaim(args.claim);
  if (!claim) {
    console.warn('[aiTimeEntryProposal] malformed aiDraft claim on outbox event — dropping', {
      orgId: args.orgId, ticketId: args.ticketId, claim: args.claim,
    });
    return null;
  }
  const draft = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          id: ticketDrafts.id,
          ticketId: ticketDrafts.ticketId,
          orgId: ticketDrafts.orgId,
          kind: ticketDrafts.kind,
          state: ticketDrafts.state,
          runId: ticketDrafts.runId,
          consumedBy: ticketDrafts.consumedBy,
        })
        .from(ticketDrafts)
        .where(eq(ticketDrafts.id, claim.draftId))
        .limit(1);
      return row ?? null;
    }),
  );
  if (
    !draft
    || draft.ticketId !== args.ticketId
    || draft.orgId !== args.orgId
    || draft.state !== 'consumed'
    || draft.runId !== claim.runId
    || draft.kind !== TRIGGER_DRAFT_KIND[claim.trigger]
    || !draft.consumedBy
  ) {
    console.warn('[aiTimeEntryProposal] aiDraft claim failed draft verification — dropping', {
      orgId: args.orgId, ticketId: args.ticketId, draftId: claim.draftId, runId: claim.runId, trigger: claim.trigger,
      found: !!draft, state: draft?.state ?? null, kind: draft?.kind ?? null,
    });
    return null;
  }
  return proposeTimeEntryForAiAssistedWork({
    ticketId: args.ticketId,
    orgId: args.orgId,
    agentRunId: claim.runId,
    trigger: claim.trigger,
    technicianUserId: draft.consumedBy,
  });
}
