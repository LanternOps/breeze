// apps/api/src/services/aiAgents/ticketTriageFindings.ts
/**
 * Phase 2 wave P2-4 (ticket triage, #4191) — Task A8. Turns the
 * `TicketTriageProposal` a `triage`-profile run produced
 * (`runLoop.ts`'s `finalizeTicketTriage`) into at most five gated, TICKET-SCOPED
 * `manage_tickets` action intents — `update_fields`, `link_device`, `comment`,
 * and up to two `draft` calls — plus a per-slot bookkeeping record the caller
 * logs. This module performs NO ticket writes of its own: every effect (the
 * CAS field update, the device link, the private note, the draft row) happens
 * later, when the minted intent actually RELEASES (either immediately, for a
 * creation-time `ticket_autonomy` grant, or after a human decides).
 *
 * Direct sibling of `sweepFindings.ts`'s `persistSweepFindings` (P2-2) and
 * `alertVerdicts.ts`'s `persistAlertVerdict` (P2-1) — read those files'
 * headers first. Same DB-context rules, same "never carry a raw
 * `Error.message` onto a persisted record" posture, same
 * `createActionIntent`-called-bare-outside-`inSystemDbContext` reasoning
 * (`alertVerdicts.ts`'s header has the long version).
 *
 * ## The five slots
 *
 * A proposal is turned into candidates in this FIXED order — deterministic
 * so a `maxActionsPerRun` cap always spends its budget the same way, and so
 * `idempotencyKey: triage:<runId>:<slot>` is stable across a redelivered
 * finalize call. `note` is spent FIRST (controller ruling, review round on
 * #4191 Task A8): spec §4.4 identifies the private note as THE triage
 * deliverable ("comment ... the triage summary. Exactly one per run") — an
 * agent whose cap is spent on optional field/link/draft candidates before
 * ever reaching the one guaranteed slot would silently drop the run's core
 * output. Reordering is safe precisely because idempotency keys are
 * slot-name-based (`triage:<runId>:note`, never a positional index) —
 * nothing about a redelivered finalize call depends on processing order.
 *
 *  1. `note` (`comment`) — ALWAYS attempted: `proposal.summary` is a
 *     required field on the schema, so there is always something to post as
 *     the run's one private note.
 *  2. `fields` (`update_fields`) — one field-patch intent covering every
 *     `TicketTriageFieldProposal` that (a) meets `TICKET_TRIAGE_CONFIDENCE_FLOOR`
 *     and (b) is not already stamped `'user'` in the ticket's LIVE
 *     `field_provenance` (a human already touched it — never overwritten,
 *     never even offered for approval). Both are pre-filters only: the real
 *     CAS lives in `applyAiFieldUpdates` (`ticketService.ts`), re-checked
 *     against a FRESH read at execution time — this module's `human_set`
 *     skip exists so a human is never asked to approve a write that
 *     execution will silently no-op anyway. Skipped entirely (no intent)
 *     when nothing survives both filters.
 *  3. `link` (`link_device`) — only when the proposal named a device
 *     (`hostname` and/or `serial`) AND the ticket does not already have one.
 *     Single-match resolution happens at EXECUTION, never here — the intent
 *     carries identifiers, not a resolved id (spec §4.4).
 *  4. `draft-reply` (`draft`, `kind: 'reply'`) — attempted whenever the
 *     model proposed one; never gated on ticket state (a reply draft can
 *     always be queued for a human "Send as me" decision).
 *  5. `draft-resolution` (`draft`, `kind: 'resolution_note'`) — attempted
 *     only when the model proposed one AND the ticket's LIVE
 *     `resolution_note` is still empty (a human already wrote one — the
 *     model's draft would just be noise).
 *
 * Every candidate that survives its own gate is still subject to the run's
 * `maxActionsPerRun` cap, spent in the slot order above.
 *
 * ## Creation-time autonomy is decided ONCE, cheaply, in advance
 *
 * `determineAutonomyAdvisory` below is a CHEAP, ADVISORY duplicate of the
 * five gates `ticketAutonomy.ts`'s `evaluateTicketAutonomy` re-checks
 * INSIDE `createActionIntent`'s own transaction — that function is
 * intentionally internal to `intentService`/`ticketAutonomy.ts` and is never
 * imported here. This module only has to decide whether it is worth ASKING
 * for autonomy at all (`autonomy: { kind: 'ticket_autonomy' } | undefined`,
 * passed identically to every one of this run's intent creations); the real,
 * authoritative decision is made per-intent by the hook itself, which is why
 * a false-positive advisory result is harmless (the hook simply denies and
 * the intent falls back to `human_required`) while a false negative merely
 * costs an unnecessary human approval — never a security gap either way.
 *
 * IMPORTANT: `autonomous` is a single call-level flag — it says whether
 * autonomy was REQUESTED uniformly, not whether it was GRANTED for every
 * intent. The live gates inside `createActionIntent` can legitimately flip
 * between two sequential calls within the same `persistTicketTriage`
 * invocation (a kill-switch trip, a policy edit mid-loop), so the caller
 * must never treat `autonomous` as a proxy for "every created intent is
 * `approved`". `approvedIntentIds` below is the ground-truth signal:
 * populated per-intent from that intent's OWN returned `status`, never from
 * the advisory flag (review fix, #4191 Task A8 round 2).
 *
 * Mirrors gates 2-4 of `evaluateTicketAutonomy` (gate 1 — "was autonomy
 * requested" — and gate 5 — "is the scope a ticket" — are trivially true
 * here, since this module always requests it for an already ticket-scoped
 * run when the snapshot passes): the run's own immutable
 * `policySnapshot.effective` must already carry `mode: 'act'` +
 * `triggers.ticketAutonomousWrites: true` (cheap, synchronous — checked
 * FIRST so the common "not an autonomous agent" case never pays for a live
 * read), then the LIVE effective policy for the SAME agent identity must
 * also carry both, then the kill switch must not be engaged. ANY read
 * failure (a missing org, a thrown error) denies — this function must never
 * throw, and a denial here always means "proceed down the ordinary
 * `human_required` path", never a lost proposal.
 */
import { and, eq } from 'drizzle-orm';
import {
  TICKET_TRIAGE_CONFIDENCE_FLOOR,
  type AiAgentPolicySnapshot,
  type TicketTriageFieldProposal,
  type TicketTriagePriority,
  type TicketTriageProposal,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tickets } from '../../db/schema/portal';
import type { AuthContext } from '../../middleware/auth';
import { readAiKillState } from '../aiKillState';
import { createActionIntent } from '../actionIntents/intentService';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import { sanitizeSweepText } from './runnerPrompt';

/**
 * Same skip-if-already-system shape as every other file in this directory
 * (see `runLoop.ts`'s own `inSystemDbContext` for the full rationale): a bare
 * system wrapper is a no-op inside an ambient request context, and
 * re-entering from an already-system context would take a SECOND pooled
 * connection while the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** The five deterministic proposal->intent slots — see this file's header. */
export type TicketTriageSlot = 'fields' | 'link' | 'note' | 'draft-reply' | 'draft-resolution';

/**
 * Why a slot did not become an intent. Display strings only — never a raw
 * `Error.message` (same posture as `SweepProposalReason`/
 * `AlertVerdictSuggestionReason`).
 *
 * `no_fields_proposed` / `below_confidence_floor` / `human_set` are the
 * three (mutually exclusive) reasons the `fields` slot can end up empty:
 * nothing was proposed at all, something was proposed but none of it met
 * `TICKET_TRIAGE_CONFIDENCE_FLOOR`, or everything proposed was already
 * human-provenanced. A run mixing a floor-drop with a human-set drop is
 * reported as `below_confidence_floor` — the coarser of the two, since
 * either alone would already have emptied the slot.
 */
export type TicketTriageSkipReason =
  | 'no_fields_proposed'
  | 'below_confidence_floor'
  | 'human_set'
  | 'no_device_proposed'
  | 'device_already_linked'
  | 'no_draft_reply'
  | 'no_draft_resolution'
  | 'resolution_note_exists'
  | 'max_actions_per_run'
  | 'intent_error'
  | 'ticket_not_found';

export interface TicketTriageSkip {
  item: TicketTriageSlot;
  reason: TicketTriageSkipReason;
}

/** The run fields `persistTicketTriage` needs — all already loaded by the
 *  caller (`finalizeTicketTriage`, which owns the `isRunStillRunning` +
 *  `triggerKind === 'ticket'` gate before ever calling this). */
export interface TicketTriagePersistRunInput {
  id: string;
  orgId: string;
  agentId: string;
  ticketId: string;
  /** The run's IMMUTABLE start-of-run snapshot — gate 2 of the advisory
   *  autonomy check (see this file's header). */
  policySnapshot: AiAgentPolicySnapshot;
  /** The AGENT's effective `limits.maxActionsPerRun` — already resolved by
   *  the caller with the `AI_AGENT_LIMIT_DEFAULTS` v1-v7 fallback. */
  maxActionsPerRun: number;
}

const TICKET_FIELD_KEYS = ['categoryId', 'priority'] as const;

interface FieldFilterResult {
  /** Only the fields that survived both filters — plain values, matching
   *  exactly what `manage_tickets`'s `update_fields` action already accepts
   *  for a human caller (`parseUpdateFields`, `aiToolsTicketing.ts`). The
   *  execution-time CAS (`applyAiFieldUpdates`) computes its OWN
   *  `expectedCurrent` from a fresh read at that moment — this module does
   *  not, and must not, try to snapshot one here: the tool's `fields`
   *  argument has no shape for it, and a stale snapshot would just be
   *  overridden anyway. */
  fields: Record<string, string>;
  anyProposed: boolean;
  anyBelowFloor: boolean;
  anyHumanSet: boolean;
}

/** Gate 1 of the `fields` slot — see this file's header and
 *  `TicketTriageSkipReason`'s docstring for the reason-selection rule. */
function filterEligibleFields(
  proposal: TicketTriageProposal,
  fieldProvenance: Record<string, string>,
): FieldFilterResult {
  const result: FieldFilterResult = { fields: {}, anyProposed: false, anyBelowFloor: false, anyHumanSet: false };

  function consider<T extends string>(key: (typeof TICKET_FIELD_KEYS)[number], field: TicketTriageFieldProposal<T> | undefined): void {
    if (!field) return;
    result.anyProposed = true;
    if (fieldProvenance[key] === 'user') {
      result.anyHumanSet = true;
      return;
    }
    if (field.confidence < TICKET_TRIAGE_CONFIDENCE_FLOOR) {
      result.anyBelowFloor = true;
      return;
    }
    result.fields[key] = field.value;
  }

  consider<string>('categoryId', proposal.fields?.categoryId);
  consider<TicketTriagePriority>('priority', proposal.fields?.priority);

  return result;
}

function fieldsSkipReason(result: FieldFilterResult): TicketTriageSkipReason {
  if (!result.anyProposed) return 'no_fields_proposed';
  if (result.anyHumanSet && !result.anyBelowFloor) return 'human_set';
  return 'below_confidence_floor';
}

/** The `manage_tickets` `comment` action's body: the private-note summary,
 *  plus any proposed talking points as a bullet list — DISPLAY only, never
 *  the input to anything that executes on its own (this file's header /
 *  `TicketTriageProposal`'s own docstring). Each line is sanitized
 *  independently (`sanitizeSweepText`, same helper the sweep prompt uses to
 *  neutralize control/bidi-override codepoints) and rejoined with '\n' so
 *  the note keeps its bullet structure instead of collapsing to one line. */
function noteContent(proposal: TicketTriageProposal): string {
  const summary = sanitizeSweepText(proposal.summary, 2000);
  const notes = (proposal.notes ?? []).map((note) => sanitizeSweepText(note, 500));
  if (notes.length === 0) return summary;
  return `${summary}\n\nNotes:\n${notes.map((note) => `- ${note}`).join('\n')}`;
}

interface Candidate {
  slot: TicketTriageSlot;
  toolInput: Record<string, unknown>;
}

/** Live ticket row this module needs — deliberately NOT the model-facing,
 *  bounded `TicketRunContext` (`ticketContext.ts`): that projection carries
 *  no `field_provenance`/raw `resolutionNote`/`deviceId`, and is a
 *  point-in-time snapshot taken before the run started. */
interface LiveTicketRow {
  deviceId: string | null;
  resolutionNote: string | null;
  fieldProvenance: Record<string, string>;
}

async function loadLiveTicket(ticketId: string, orgId: string): Promise<LiveTicketRow | null> {
  const [row] = await inSystemDbContext(() => db
    .select({
      deviceId: tickets.deviceId,
      resolutionNote: tickets.resolutionNote,
      fieldProvenance: tickets.fieldProvenance,
    })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
    .limit(1));
  return row ? { ...row, fieldProvenance: row.fieldProvenance ?? {} } : null;
}

/**
 * Advisory duplicate of gates 2-4 of `evaluateTicketAutonomy` — see this
 * file's header for why this is safe to be wrong in either direction, and
 * why it never throws.
 */
async function determineAutonomyAdvisory(run: TicketTriagePersistRunInput): Promise<boolean> {
  const snapshotEffective = run.policySnapshot.effective;
  if (snapshotEffective.mode !== 'act' || snapshotEffective.triggers?.ticketAutonomousWrites !== true) {
    return false;
  }

  try {
    const resolved = await resolveEffectiveAgentSystem(run.orgId, run.policySnapshot.kind);
    if (
      !resolved
      || resolved.agentId !== run.agentId
      || resolved.effective.mode !== 'act'
      || resolved.effective.triggers?.ticketAutonomousWrites !== true
    ) {
      return false;
    }
    const killState = await readAiKillState();
    return !killState.killed;
  } catch (error) {
    console.warn('[ticketTriageFindings] autonomy advisory check failed — proceeding as non-autonomous', {
      runId: run.id, error,
    });
    return false;
  }
}

/**
 * PRECONDITION (inherited from `createActionIntent`, same as
 * `persistSweepFindings`/`persistAlertVerdict`): must NOT be called from
 * inside an ambient DB context. `finalizeTicketTriage` (runLoop.ts)
 * satisfies this — it runs from the background run loop, which holds no
 * ambient context of its own.
 *
 * Never throws for a per-slot failure: a candidate that cannot become an
 * intent is RECORDED as skipped and the remaining candidates are still
 * attempted (same "don't lose the useful half of the run's output" posture
 * as `persistSweepFindings`). A missing/moved ticket is the one case that
 * skips EVERY slot at once — there is nothing left to scope an intent to.
 */
export async function persistTicketTriage(
  run: TicketTriagePersistRunInput,
  proposal: TicketTriageProposal,
  agentAuth: AuthContext,
): Promise<{
  intentIds: string[];
  /** GROUND TRUTH subset of `intentIds` whose returned `status` was
   *  `'approved'` at creation (a granted `ticket_autonomy` decision — see
   *  this file's header). Built per-intent from `createActionIntent`'s own
   *  response, never from the call-level `autonomous` advisory flag: the
   *  live gates can flip between two sequential calls in this same
   *  invocation, so `autonomous` alone is not safe to use for run-status
   *  classification. `finalizeTicketTriage` (runLoop.ts) feeds this
   *  directly into `LoopResult.decidedIntentIds`. */
  approvedIntentIds: string[];
  autonomous: boolean;
  skipped: TicketTriageSkip[];
}> {
  const ALL_SLOTS: TicketTriageSlot[] = ['note', 'fields', 'link', 'draft-reply', 'draft-resolution'];

  const ticket = await loadLiveTicket(run.ticketId, run.orgId);
  if (!ticket) {
    console.warn('[ticketTriageFindings] proposal not converted — ticket no longer resolves inside the run org', {
      runId: run.id, orgId: run.orgId, ticketId: run.ticketId,
    });
    return {
      intentIds: [],
      approvedIntentIds: [],
      autonomous: false,
      skipped: ALL_SLOTS.map((item) => ({ item, reason: 'ticket_not_found' as const })),
    };
  }

  const autonomous = await determineAutonomyAdvisory(run);

  const skipped: TicketTriageSkip[] = [];
  const candidates: Candidate[] = [];

  // 1. note — always attempted (`summary` is a required field on the
  // schema), and processed FIRST: spec §4.4 names the private note as the
  // triage deliverable, so it must never be starved by the cap (see this
  // file's header).
  candidates.push({
    slot: 'note',
    toolInput: { action: 'comment', ticketId: run.ticketId, content: noteContent(proposal) },
  });

  // 2. fields
  const fieldFilter = filterEligibleFields(proposal, ticket.fieldProvenance);
  if (Object.keys(fieldFilter.fields).length > 0) {
    candidates.push({
      slot: 'fields',
      toolInput: { action: 'update_fields', ticketId: run.ticketId, fields: fieldFilter.fields },
    });
  } else {
    skipped.push({ item: 'fields', reason: fieldsSkipReason(fieldFilter) });
  }

  // 3. link
  const device = proposal.device;
  const deviceIdentifier = device?.hostname || device?.serial;
  if (!deviceIdentifier) {
    skipped.push({ item: 'link', reason: 'no_device_proposed' });
  } else if (ticket.deviceId !== null) {
    skipped.push({ item: 'link', reason: 'device_already_linked' });
  } else {
    candidates.push({
      slot: 'link',
      toolInput: {
        action: 'link_device',
        ticketId: run.ticketId,
        ...(device?.hostname ? { hostname: device.hostname } : {}),
        ...(device?.serial ? { serial: device.serial } : {}),
      },
    });
  }

  // 4. draft-reply
  if (!proposal.draftReply) {
    skipped.push({ item: 'draft-reply', reason: 'no_draft_reply' });
  } else {
    candidates.push({
      slot: 'draft-reply',
      toolInput: { action: 'draft', ticketId: run.ticketId, kind: 'reply', content: proposal.draftReply },
    });
  }

  // 5. draft-resolution
  if (!proposal.draftResolutionNote) {
    skipped.push({ item: 'draft-resolution', reason: 'no_draft_resolution' });
  } else if (ticket.resolutionNote) {
    skipped.push({ item: 'draft-resolution', reason: 'resolution_note_exists' });
  } else {
    candidates.push({
      slot: 'draft-resolution',
      toolInput: {
        action: 'draft', ticketId: run.ticketId, kind: 'resolution_note', content: proposal.draftResolutionNote,
      },
    });
  }

  const reason = sanitizeSweepText(proposal.summary, 200);
  const intentIds: string[] = [];
  const approvedIntentIds: string[] = [];
  let created = 0;

  for (const candidate of candidates) {
    if (created >= run.maxActionsPerRun) {
      console.warn('[ticketTriageFindings] candidate not converted — the run\'s action cap is spent', {
        runId: run.id, agentId: run.agentId, slot: candidate.slot, maxActionsPerRun: run.maxActionsPerRun,
      });
      skipped.push({ item: candidate.slot, reason: 'max_actions_per_run' });
      continue;
    }

    try {
      const intent = await createActionIntent(agentAuth, {
        toolName: 'manage_tickets',
        input: candidate.toolInput,
        source: 'ai_agent',
        orgId: run.orgId,
        reason,
        // Stable per (run, slot) so a redelivered finalize call cannot mint
        // a second intent for the same slot.
        idempotencyKey: `triage:${run.id}:${candidate.slot}`,
        scope: { ticketId: run.ticketId },
        autonomy: autonomous ? { kind: 'ticket_autonomy' } : undefined,
      });
      // A granted `ticket_autonomy` decision lands as `approved` (no fan-out
      // was ever attempted, so it can never be the "cancelled — no eligible
      // approver" case `pending_approval`-only linking exists to guard
      // against — see `alertVerdicts.ts`'s header). Both statuses are
      // genuinely live, human-or-system-owned intents worth reporting.
      if (intent.status === 'pending_approval' || intent.status === 'approved') {
        intentIds.push(intent.id);
        // Ground truth, not the call-level advisory flag: this intent's OWN
        // returned status is what `finalizeTicketTriage` needs to classify
        // the run correctly, since the live gates inside `createActionIntent`
        // can flip between two sequential calls in this same loop (see this
        // file's header).
        if (intent.status === 'approved') approvedIntentIds.push(intent.id);
        created += 1;
      } else {
        console.warn('[ticketTriageFindings] candidate intent was not left pending or approved', {
          runId: run.id, slot: candidate.slot, intentId: intent.id, status: intent.status,
        });
        skipped.push({ item: candidate.slot, reason: 'intent_error' });
      }
    } catch (error) {
      // agent_policy_denied, scope_argument_mismatch, org_resolution_failed, …
      // The message is LOGGED, never persisted (it can echo tool input).
      console.warn('[ticketTriageFindings] candidate intent not created', {
        runId: run.id, slot: candidate.slot, error: (error as Error).message,
      });
      skipped.push({ item: candidate.slot, reason: 'intent_error' });
    }
  }

  return { intentIds, approvedIntentIds, autonomous, skipped };
}
