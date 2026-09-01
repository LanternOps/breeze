/**
 * runFinishedNotify — the run-finished notification delivery body (AI agents
 * wave 4a, Task 6, #3826).
 *
 * Pulled out of `runLoop.ts`'s old inline `notifyRunFinished` into its own
 * leaf module for two reasons:
 *
 * 1. Both the normal in-loop path (`runLoop.ts`'s `finishRun`, immediately
 *    after the run's terminal status CAS commits) and the durable BullMQ
 *    retry lane (`jobs/agentNotifyRetryWorker.ts`) need to call the SAME
 *    notify body by `runId` alone — the retry worker has no in-memory
 *    `RunContext`, only the id its job payload carries, so it re-reads the
 *    run + agent + policy snapshot from the DB fresh. The run row is
 *    immutable by the time either caller reaches this: `finishRun`'s status
 *    CAS has already committed.
 * 2. `runLoop.ts`'s own header explicitly keeps BullMQ out of its module
 *    graph ("so that the guardrail hooks it builds can be driven by
 *    service-level tests ... without dragging BullMQ and Redis into their
 *    module graph"). A module imported by BOTH `runLoop.ts` and the BullMQ
 *    worker must itself stay BullMQ-free, or the two files become circular
 *    imports of each other (the worker needs the notify body FROM the loop;
 *    the loop needs the enqueue function FROM the worker). This module has
 *    zero BullMQ/Redis dependency, which is also what keeps
 *    `agentNotifyRetryWorker`'s import closure short enough to land
 *    `placement: 'global'` in the worker registry (see
 *    `workerEntrypointClosure.contract.test.ts`) instead of inheriting
 *    `runLoop.ts`'s full SDK-tool `socket-owner` graph.
 *
 * Throws on ANY failure (DB read, recipient resolution, notification write)
 * — deliberately, unlike the old inline `notifyRunFinished`, which caught
 * everything itself. The two callers now own that decision differently:
 * `finishRun` catches it and enqueues ONE durable retry job (a notify
 * failure must never redefine the run's terminal status); the retry
 * worker's job processor lets it propagate so BullMQ's own `attempts` +
 * backoff (set at enqueue time) handles repeated failures — no manual
 * re-enqueue loop here.
 */
import { and, eq } from 'drizzle-orm';
import type { AgentRunVerdict, AiAgentPolicySnapshot } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same note as runLoop.ts.
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { tickets } from '../../db/schema/portal';
import { ticketDrafts } from '../../db/schema/ticketDrafts';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';

const RUN_VERDICTS: ReadonlySet<AgentRunVerdict> = new Set([
  'remediated', 'needs_attention', 'partial', 'no_action',
]);

/** `run.outcome` is jsonb, read back untyped — never trust its shape. */
function readRunVerdict(outcome: Record<string, unknown>): AgentRunVerdict | null {
  const value = outcome.runVerdict;
  return typeof value === 'string' && RUN_VERDICTS.has(value as AgentRunVerdict)
    ? (value as AgentRunVerdict)
    : null;
}

interface ActSummary {
  opKey: string;
  verification: string;
  target: string;
}

/**
 * Sanitized per-op summaries for the notification: op key + target NAME
 * only, matching `actTargetSummary` (actVerify.ts) — never a raw tool
 * input/output or a full path list. Only entries that actually went through
 * the act branch (a `verification` field present) are included.
 */
function readActSummaries(outcome: Record<string, unknown>): ActSummary[] {
  const executedActions = Array.isArray(outcome.executedActions) ? outcome.executedActions : [];
  const summaries: ActSummary[] = [];
  for (const raw of executedActions) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.verification !== 'string') continue;
    summaries.push({
      opKey: typeof entry.actOpKey === 'string' ? entry.actOpKey : 'unknown',
      verification: entry.verification,
      target: typeof entry.actTargetName === 'string' ? entry.actTargetName : '',
    });
  }
  return summaries;
}

/**
 * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — the sweep digest read off
 * `run.outcome.sweepFindings`. Nobody is watching a 06:00 cron occurrence and
 * a sweep leaves no badge on an alert row a technician was already looking at,
 * so this notification IS the surface for it (see `finishRun`'s notify/
 * fix-watch split). `null` for every run that produced no findings outcome,
 * which falls back to the generic title.
 *
 * `kinds` is the distinct set of kinds that actually PRODUCED a finding
 * (sorted, so the list is stable regardless of the order the model emitted
 * them) — not the kinds the schedule swept. Everything else on this
 * digest is an outcome count, and "what was found" is what a recipient acts
 * on; "what was checked" stays on the run-detail trace, which reads it off
 * `trigger_ref` (`projectSweep`).
 *
 * Read defensively at every step: `outcome` is jsonb with no compile-time
 * shape, and a pre-A7 row simply lacks these keys.
 */
interface SweepDigest {
  findings: number;
  critical: number;
  kinds: string[];
  summaryFirstLine: string;
}

function readSweepDigest(outcome: Record<string, unknown>): SweepDigest | null {
  const sweep = outcome.sweepFindings;
  if (!sweep || typeof sweep !== 'object') return null;
  const entry = sweep as Record<string, unknown>;
  const findings = Array.isArray(entry.findings) ? entry.findings : [];

  let critical = 0;
  const kinds = new Set<string>();
  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') continue;
    const finding = raw as Record<string, unknown>;
    if (finding.severity === 'critical') critical += 1;
    if (typeof finding.kind === 'string') kinds.add(finding.kind);
  }

  const summary = typeof entry.summary === 'string' ? entry.summary : '';
  return {
    findings: findings.length,
    critical,
    kinds: [...kinds].sort(),
    summaryFirstLine: summary.split('\n')[0]?.trim() ?? '',
  };
}

/**
 * Phase 2 wave P2-3 (weekly org narrative), Task A7 — the narrative digest.
 * `null` unless the run BOTH produced a narrative and had it persisted as a
 * report artifact (`finalizeNarrative` writes `outcome.narrativeReport` only
 * after the transaction committed).
 *
 * That conjunction is the point: this notification's entire payload is a
 * pointer at a stored document. A narrative run whose persistence lost the CAS
 * or failed has nothing to point at, and falls back to the generic
 * run-finished copy — which links to the RUN, where the reviewer can read the
 * `narrative_persist_*` error code. Announcing a report that does not exist is
 * worse than announcing nothing.
 *
 * `headline` is the only model-authored string that reaches the notification,
 * and it arrives already flattened and length-bounded by
 * `narrativeSubmissionSchema` (160 chars, no control characters). It is
 * re-flattened here anyway, for the same reason the org name is: this reads
 * jsonb, which carries no compile-time shape and no guarantee about who wrote
 * it.
 */
interface NarrativeDigest {
  headline: string;
  reportId: string;
  reportRunId: string;
}

function readNarrativeDigest(outcome: Record<string, unknown>): NarrativeDigest | null {
  const link = outcome.narrativeReport;
  if (!link || typeof link !== 'object') return null;
  const { reportId, reportRunId } = link as Record<string, unknown>;
  if (typeof reportId !== 'string' || typeof reportRunId !== 'string') return null;
  const narrative = outcome.narrative;
  const headline = narrative && typeof narrative === 'object'
    ? flattenNotificationLine((narrative as Record<string, unknown>).headline)
    : '';
  return { headline, reportId, reportRunId };
}

/**
 * Phase 2 wave P2-4 (ticket triage), Task 9 (#4191) — counts how many
 * `ticket_drafts` rows this run has minted so far (any state — a draft the
 * run produced and a human already consumed/discarded still counts as
 * "produced something"). Queried only when `run.intentIds` is already empty
 * (`deliverRunFinishedNotifications`'s caller) — a run WITH live intents
 * never needs this to decide whether to notify.
 *
 * In practice a draft row is written only when its minting intent RELEASES
 * (`aiToolsTicketing.ts`'s `draft` action, run from the durable release
 * worker), which happens strictly AFTER this run has already gone terminal
 * — so this almost always reads back `0` today. It is queried anyway
 * because that is a today-shaped implementation detail, not a contract this
 * notification's suppression logic should assume: a future synchronous
 * release path (or a redelivered notify retry racing a fast release) must
 * not silently start suppressing notifications for a run that DID mint
 * something.
 */
async function countTicketDrafts(runId: string): Promise<number> {
  const rows = await inSystemDbContext(() =>
    db.select({ id: ticketDrafts.id }).from(ticketDrafts).where(eq(ticketDrafts.runId, runId)),
  );
  return rows.length;
}

/**
 * Phase 2 wave P2-4 (ticket triage), Task 9 (#4191) — the ticket's
 * human-facing number for the notification title (`ticket_number`, NEVER
 * `subject` — a ticket subject is customer free-text, not a stable
 * identifier safe to put in every recipient's notification list).
 *
 * Never fatal, same posture as `loadOrgName`: an unreadable/moved ticket
 * still gets a notification, just with a short id-derived label instead of
 * the real ticket number (the one case the brief calls out where "only the
 * uuid exists" — this is that fallback, logged so it is visible rather than
 * silently wrong).
 */
async function loadTicketLabel(ticketId: string | null, orgId: string): Promise<string | null> {
  if (!ticketId) return null;
  try {
    const [row] = await inSystemDbContext(() =>
      db
        .select({ ticketNumber: tickets.ticketNumber })
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
        .limit(1),
    );
    if (row?.ticketNumber) return row.ticketNumber;
    console.warn(
      '[runFinishedNotify] triage ticket row unreadable — falling back to a short id label',
      { ticketId, orgId },
    );
    return ticketId.slice(0, 8);
  } catch (error) {
    console.warn('[runFinishedNotify] could not read the ticket number for a triage notification', {
      ticketId, orgId, error,
    });
    return ticketId.slice(0, 8);
  }
}

/**
 * Collapses a DB- or model-sourced string to one line for display in a
 * notification title/message: every control/format codepoint (C0, DEL, C1, and
 * the bidi overrides that can visually reorder a line) becomes a space, runs of
 * whitespace collapse, and the result is bounded. Same treatment
 * `flattenNarrativeLine` (validators/orgNarrative.ts) gives a bullet — an org
 * name is not model-authored, but it is customer-supplied text rendered into a
 * line-oriented surface.
 */
function flattenNotificationLine(value: unknown, maxChars = 200): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Only the two verdicts the plan names get a distinct title; `partial` and
 *  `no_action`/null keep the existing generic title (still carry `verdict`
 *  in metadata) — most orgs are not act-mode, and this keeps their
 *  notification copy unchanged. */
function verdictAwareTitle(agentName: string, verdict: AgentRunVerdict | null): string {
  if (verdict === 'remediated') return `Agent remediated an issue: ${agentName}`;
  if (verdict === 'needs_attention') return `Agent needs attention: ${agentName}`;
  return 'Agent run finished';
}

/** The only statuses `finishRun` ever commits before calling this. A run
 *  read back in any other status (e.g. a stale/duplicate retry-job delivery
 *  racing an as-yet-uncommitted transition) has nothing to notify about yet. */
const TERMINAL_STATUSES = new Set(['completed', 'awaiting_approval', 'failed']);

interface FinishedRunRow {
  id: string;
  orgId: string;
  agentId: string;
  /** Phase 2 wave P2-2, Task A7 — gates the sweep digest below. Optional
   *  because it can be absent on a row read back through an older
   *  mock/fixture; an absent value simply never matches `'sweep'` and keeps
   *  the generic copy. */
  profile?: string;
  status: string;
  summary: string | null;
  outcome: Record<string, unknown>;
  intentIds: string[];
  policySnapshot: AiAgentPolicySnapshot;
  /** Phase 2 wave P2-4 (ticket triage), Task 9 — the triggering ticket for a
   *  `profile: 'triage'` run; `null` for every other profile (and for an
   *  older row read back through a fixture that predates this column). */
  ticketId?: string | null;
}

interface NotifyAgentRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
}

/**
 * Same skip-if-already-system shape as `runLoop.ts`'s own `inSystemDbContext`
 * — duplicated rather than imported so this module's only DB dependency stays
 * `../../db` itself (see the header comment on why this file must not import
 * `runLoop.ts`).
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function loadFinishedRun(
  runId: string,
): Promise<{ run: FinishedRunRow; agent: NotifyAgentRow } | null> {
  return inSystemDbContext(async () => {
    const [run] = await db
      .select({
        id: aiAgentRuns.id,
        orgId: aiAgentRuns.orgId,
        agentId: aiAgentRuns.agentId,
        profile: aiAgentRuns.profile,
        status: aiAgentRuns.status,
        summary: aiAgentRuns.summary,
        outcome: aiAgentRuns.outcome,
        intentIds: aiAgentRuns.intentIds,
        policySnapshot: aiAgentRuns.policySnapshot,
        ticketId: aiAgentRuns.ticketId,
      })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, runId))
      .limit(1);
    if (!run) return null;

    const [agent] = await db
      .select({
        id: aiAgents.id,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        name: aiAgents.name,
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    if (!agent) return null;

    return { run: run as FinishedRunRow, agent: agent as NotifyAgentRow };
  });
}

/**
 * The run org's display name, for the narrative title. Read ONLY on the
 * narrative path (one extra round trip per weekly occurrence, never on the
 * hot full-profile path) and never fatal: an unreadable org row drops the
 * title's suffix rather than failing a notification whose document is already
 * stored.
 */
async function loadOrgName(orgId: string): Promise<string> {
  try {
    const [row] = await inSystemDbContext(() => db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1));
    return flattenNotificationLine(row?.name);
  } catch (error) {
    console.warn('[runFinishedNotify] could not read the org name for a narrative notification', {
      orgId, error,
    });
    return '';
  }
}

/**
 * Delivers the "agent run finished" notification to every resolved recipient
 * of the given run, re-reading the run/agent/policy snapshot from the DB.
 *
 * Silent (logged, not thrown) no-ops: the run or its agent no longer exists,
 * the run is not (yet) in a terminal status, or zero recipients resolve —
 * none of these are failures the durable retry lane exists for. Anything
 * else THROWS; see the header comment for why callers must not swallow it
 * inside this function.
 */
export async function deliverRunFinishedNotifications(runId: string): Promise<void> {
  const loaded = await loadFinishedRun(runId);
  if (!loaded) {
    console.warn('[runFinishedNotify] run or its agent no longer exists — nothing to notify', { runId });
    return;
  }
  const { run, agent } = loaded;

  if (!TERMINAL_STATUSES.has(run.status)) {
    console.warn('[runFinishedNotify] run is not (yet) in a terminal status — skipping', {
      runId, status: run.status,
    });
    return;
  }

  // Task A7 / review fix (#4189): a CLEAN sweep is silent. A sweep is a
  // recurring, unattended job — a daily baseline across a 40-org partner that
  // finds nothing would otherwise manufacture 40 notifications every morning,
  // per recipient, and that steady noise is exactly what makes the ONE
  // morning with a critical finding invisible. Suppressed BEFORE recipient
  // resolution: nothing downstream of here is needed to decide it, and the
  // resolution is a DB round trip per run.
  //
  // Narrow on purpose — `readSweepDigest` returns null when the outcome
  // carries no `sweepFindings` at all, and that case (a sweep that failed, or
  // a pre-A7 row) keeps its generic run-finished notification. Only a sweep
  // that actually ran and produced an EMPTY finding list is silent. The run
  // row itself is untouched and still readable on the run-detail page.
  if (run.profile === 'sweep') {
    const digest = readSweepDigest(run.outcome ?? {});
    if (digest && digest.findings === 0) {
      console.info('[runFinishedNotify] sweep found nothing — no digest notification', {
        runId, orgId: run.orgId, status: run.status,
      });
      return;
    }
  }

  // Task 9 (P2-4 ticket triage, #4191): a triage run that minted NOTHING —
  // zero live `manage_tickets` intents (note/fields/link/draft-reply/
  // draft-resolution all skipped or capped) AND zero already-materialized
  // ticket_drafts rows — has nothing for a human to act on. Same "recurring,
  // system-triggered pass, suppress the empty case so the non-empty case
  // stays visible" posture as the sweep digest above. Checked BEFORE
  // recipient resolution for the same reason; the intent count is already in
  // hand (`run.intentIds`), so the extra `ticket_drafts` round trip only
  // runs when it's actually needed to decide.
  if (run.profile === 'triage' && run.intentIds.length === 0) {
    const draftCount = await countTicketDrafts(run.id);
    if (draftCount === 0) {
      console.info('[runFinishedNotify] triage run minted nothing — no notification', {
        runId, orgId: run.orgId, status: run.status,
      });
      return;
    }
  }

  // The run's immutable snapshot, NOT the agent row's raw `recipients`
  // column — see `mergeAgentPolicies`/`resolveRecipientUserIds` for why the
  // merged, RUN-org-derived set is the correct input (the agent row loaded
  // by `run.agent_id` is always the PARTNER BASELINE and silently drops any
  // recipient an organization added through its own override).
  const userIds = await resolveRecipientUserIds(
    {
      orgId: agent.orgId,
      partnerId: agent.partnerId,
      recipients: run.policySnapshot.effective.recipients,
    },
    run.orgId,
  );
  if (userIds.length === 0) {
    console.warn('[runFinishedNotify] no recipients resolved for finished run', { runId });
    return;
  }

  const firstLine = (run.summary ?? '').split('\n')[0]?.trim() ?? '';
  const executedActionCount =
    typeof run.outcome?.toolExecutionCount === 'number' ? (run.outcome.toolExecutionCount as number) : 0;
  const verdict = readRunVerdict(run.outcome ?? {});
  const actSummary = readActSummaries(run.outcome ?? {});
  // Task A7 — a sweep run gets its own digest copy; every other profile (and
  // a sweep run that never produced findings) keeps the generic verdict-aware
  // title untouched.
  const sweep = run.profile === 'sweep' ? readSweepDigest(run.outcome ?? {}) : null;
  // Task A7 (wave P2-3) — a narrative run that actually produced an artifact
  // gets its own copy; everything else (including a narrative run whose
  // persistence failed) keeps the branch above.
  const narrative = run.profile === 'narrative' ? readNarrativeDigest(run.outcome ?? {}) : null;
  const orgName = narrative ? await loadOrgName(run.orgId) : '';
  // Task 9 (P2-4 ticket triage, #4191). `ticketLabel` is the ticket NUMBER,
  // never the subject — see `loadTicketLabel`'s docstring for the
  // short-id-fallback case. `triageAutonomous` is ground truth, not an
  // advisory flag re-read from anywhere: a triage run only reaches the
  // `completed` status (rather than `awaiting_approval`) when every intent
  // it minted was already decided at creation time
  // (`classifyIntentAwaitingApproval`, runLoop.ts) — i.e. every live intent
  // here was autonomously approved, not left for a human.
  const triage = run.profile === 'triage';
  const ticketLabel = triage ? await loadTicketLabel(run.ticketId ?? null, run.orgId) : null;
  const triageAutonomous = triage && run.status === 'completed' && run.intentIds.length > 0;
  const title = narrative
    ? `Weekly narrative ready${orgName ? ` — ${orgName}` : ''}`
    : sweep
      ? `Sweep finished: ${sweep.findings} finding(s)`
        + `${sweep.critical > 0 ? ` (${sweep.critical} critical)` : ''} — ${agent.name}`
      : (triage && ticketLabel)
        ? `Ticket #${ticketLabel} triaged — ${agent.name}`
        : verdictAwareTitle(agent.name, verdict);
  const baseMessage = narrative
    ? narrative.headline || `${agent.name}: ${firstLine || run.status}`
    : sweep
      ? sweep.summaryFirstLine || `${agent.name}: ${firstLine || run.status}`
      : `${agent.name}: ${firstLine || run.status}`;
  // Autonomy note appended, never substituted — the recipient still gets
  // what the run actually did, plus the fact that it happened unattended.
  const message = triageAutonomous ? `${baseMessage} Executed automatically.` : baseMessage;
  // Anything critical escalates, exactly as `needs_attention` does for a
  // full-profile run — the two are mutually exclusive here (a sweep run never
  // produces a run verdict of its own).
  // A narrative is a scheduled deliverable, never an escalation — it stays at
  // the default priority whatever the week contained. A triage run's own
  // `computeRunVerdict` (runLoop.ts) can only ever land `no_action` (it mints
  // no `executedActions` of its own), so the fallthrough below already keeps
  // it at the default 'normal' priority without a dedicated branch.
  const priority = narrative
    ? null
    : sweep ? (sweep.critical > 0 ? 'high' : null) : (verdict === 'needs_attention' ? 'high' : null);
  const link = narrative
    ? '/reports'
    : (triage && run.ticketId)
      ? `/tickets/${run.ticketId}`
      : `/ai-agents/runs/${run.id}`;

  // AFTER the status commit and outside any held transaction (#1105).
  await inSystemDbContext(async () => {
    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: run.orgId,
        type: 'ai',
        title,
        message,
        // The run-detail page (wave 6.1) surfaces pending approvals itself,
        // so every run-finished notification links there unconditionally —
        // no more branching to '/approvals'.
        //
        // DELIBERATE DEVIATION for a narrative (wave P2-3, Task A7): '/reports'.
        // The deliverable is the stored, downloadable report artifact; the
        // recipient of a weekly narrative wants the document, not the agent's
        // execution trace. This is the one profile whose "what finished" and
        // "what to look at" are different objects. A narrative run WITHOUT an
        // artifact keeps the unconditional run link above — see
        // `readNarrativeDigest`'s docstring.
        //
        // DELIBERATE DEVIATION for triage (Task 9, #4191): '/tickets/<id>'.
        // The recipient wants the TICKET, not the agent's execution trace —
        // same "what finished vs. what to look at" split as narrative above.
        // A triage run with no ticket id (invariant violation; see
        // `finalizeTicketTriage`'s defensive check) keeps the unconditional
        // run link.
        link,
        // Only 'needs_attention' (or, for a sweep, any critical finding)
        // escalates priority — every other verdict, including null, the
        // pre-Part-B/non-act-mode default, keeps the existing 'normal'
        // default createNotification already applies.
        ...(priority ? { priority: 'high' as const } : {}),
        metadata: {
          runId: run.id,
          agentId: agent.id,
          intentIds: run.intentIds,
          status: run.status,
          executedActionCount,
          verdict,
          ...(actSummary.length > 0 ? { actSummary } : {}),
          // `proposals` is the run's own pending-intent count: for a sweep
          // run every entry in `intent_ids` came from a converted proposal
          // (a sweep executes nothing and proposes nothing through the run
          // loop's own tool gate — `sweepLimits` pins `maxActionsPerRun: 0`).
          ...(sweep
            ? {
              sweep: {
                findings: sweep.findings,
                critical: sweep.critical,
                proposals: run.intentIds.length,
                kinds: sweep.kinds,
              },
            }
            : {}),
          // TWO ids and nothing else. The narrative itself — sections,
          // bullets, derived markdown — lives in the report artifact and on
          // the run row; a notification row is neither the place to duplicate
          // a customer-facing document nor a surface with the artifact's
          // access controls.
          ...(narrative
            ? { narrative: { reportRunId: narrative.reportRunId, reportId: narrative.reportId } }
            : {}),
        },
        dedupeKey: `agent-run:${run.id}`,
      });
    }
  });
}
