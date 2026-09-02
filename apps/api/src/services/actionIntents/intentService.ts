import { randomUUID, createHash } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AssuranceLevel } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type Database, type DbAccessContext } from '../../db';
import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';
import { policyDecideEnabled } from '../../config/env';
import {
  actionIntents,
  intentOutbox,
  type ActionIntent,
  type ActionIntentApprovalScope,
  type ActionIntentOriginPrincipalKind,
  type ActionIntentPolicyDecisionState,
  type ActionIntentSource,
  type ActionIntentStatus,
} from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import { tickets } from '../../db/schema/portal';
import { type AuthContext, dbAccessContextFromAuth } from '../../middleware/auth';
import { aiTools, resolveWritableToolOrgId } from '../aiTools';
import {
  checkAgentGuardrails,
  checkGuardrails,
  type AgentGuardrailPolicy,
  type GuardrailCheck,
} from '../aiGuardrails';
import { getUserPermissions, userCanDecideApprovals } from '../permissions';
import { dispatchApprovalPushToTokens, getUserPushTokens } from '../expoPush';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { recordActionIntentEvent } from './metrics';
import {
  resolveAgentIntentApprovers,
  resolveIntentApprovers,
  resolveIntentTargetScope,
  type IntentTargetScope,
} from './intentApprovers';
import { computeEffectDigestOutcome, type EffectDigestOutcome } from './effectDigest';
import {
  assertArgsMatchScope,
  assertArgsMatchTicketScope,
  effectiveTargetDeviceId,
  resolveIntentTargetDevice,
  IntentScopeArgumentMismatchError,
} from './intentTargetScope';
import { evaluateTicketAutonomy } from './ticketAutonomy';

/** Statuses the partial `action_intents_org_idem_uniq` index dedupes on
 * (IMPORTANT-4 — migration 2026-07-18-action-intents.sql). Kept as a single
 * source of truth for both the onConflictDoNothing target predicate and the
 * idempotent-replay re-select below, so the two can never drift apart. */
const LIVE_INTENT_STATUSES: readonly ActionIntentStatus[] = ['pending_approval', 'approved', 'executing'];

/**
 * Shape of the loaded/verified agent run an agent-originated intent carries
 * (populated by the agent-verification block in createActionIntent, null for
 * every human-originated intent). Named so resolvePolicyDecisionState and
 * runHumanFanout below can share it without re-declaring the inline object
 * type at each use site.
 */
type AgentRunRef = {
  id: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
} | null;

// Action intents & durable approval layer — core intent service (spec
// docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
// §4, §7). Creates a digest-bound intent, fans it out to eligible approvers,
// and provides the CAS primitive later tasks (decide handler, release worker,
// reaper) use to move it through its state machine.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The one tool whose `orgId` ARGUMENT must equal the intent's own resolved
 * org. A bare literal rather than an import from
 * `services/aiToolsAiAgentGovernance.ts`: that module reaches the whole
 * `aiTools` registry graph, and this file is imported by the release worker.
 * Kept as a named constant so it is greppable from both ends.
 */
const ORG_PINNED_ARG_TOOL = 'manage_ai_agents';

export class ActionIntentError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ActionIntentError';
  }
}

/** Tier <=2 tools aren't an intent path at all; Tier 4 is refused outright. */
export class ActionIntentTierError extends ActionIntentError {
  constructor(message: string, code: 'tool_not_tier3' | 'tool_blocked', public tier?: number) {
    super(message, code);
    this.name = 'ActionIntentTierError';
  }
}

export class ActionIntentNotFoundError extends ActionIntentError {
  constructor(intentId: string) {
    super(`Action intent ${intentId} not found`, 'not_found');
    this.name = 'ActionIntentNotFoundError';
  }
}

export class ActionIntentAuthorizationError extends ActionIntentError {
  constructor(message: string) {
    super(message, 'forbidden');
    this.name = 'ActionIntentAuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Public types (Tasks 5-8 + Plan 2 depend on these exact shapes)
// ---------------------------------------------------------------------------

export interface CreateActionIntentInput {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  /**
   * 'ai_agent' (wave 3b) is valid ONLY for an ai_agent principal — and
   * required for one: createActionIntent enforces the pairing in both
   * directions (agent_source_mismatch). Kept as an explicit literal union
   * (not ActionIntentSource) so a future source value is opted into this
   * public input on purpose, never inherited.
   */
  source: 'chat' | 'mcp_api' | 'ai_agent';
  requestingClientLabel?: string;
  /** MCP callers pass this explicitly; derived deterministically for chat. */
  idempotencyKey?: string;
  /** Resolved via resolveWritableToolOrgId when absent. */
  orgId?: string;
  /**
   * Pins the intent to the M365 connection whose credential will perform the
   * effect (design §5.2). Populates the already-immutable
   * `action_intents.connection_id` / `tenant_id` columns, which the release
   * path compares against the freshly-loaded connection on all four binding
   * fields. Absent for every non-comms tool, which is why it is optional.
   */
  binding?: { connectionId: string; tenantId: string };
  /**
   * P2-2: explicit target device for an intent minted by a DEVICE-LESS run
   * (sweeps). Agent principal only. Becomes `scope_kind='device'`/
   * `scope_device_id`; every downstream reader resolves the target through
   * `resolveIntentTargetDevice` so the run's own device is never consulted
   * when a scope exists.
   *
   * P2-4 (#4191): widened to a discriminated union — `{ ticketId }` is the
   * ticket-triage mirror, agent principal only, becoming
   * `scope_kind='ticket'`/`scope_ticket_id`; every downstream reader
   * resolves it through `resolveIntentTargetTicket`. The two variants are
   * mutually exclusive by construction (the CHECK
   * `action_intents_scope_ticket_chk` pairs `scope_kind='ticket'` with a
   * non-null `scope_ticket_id`, same shape as the device pairing).
   */
  scope?: { deviceId: string } | { ticketId: string };
  /**
   * P2-4 (#4191): requests the creation-transaction ticket-autonomy decision
   * (`ticketAutonomy.ts`'s `evaluateTicketAutonomy`) — honored ONLY for the
   * `ai_agent` principal, and only alongside `scope: { ticketId }` (one of
   * the five gates `evaluateTicketAutonomy` re-checks). A denial never
   * throws: the intent proceeds down the ordinary `human_required` path with
   * an `autonomyDenied` breadcrumb on its `result` column.
   */
  autonomy?: { kind: 'ticket_autonomy' };
}

export type ActionIntentSnapshot = {
  id: string;
  status: ActionIntentStatus;
  actionName: string;
  argumentDigest: string;
  source: ActionIntentSource;
  expiresAt: Date;
  result: unknown;
  errorCode: string | null;
  approvalRequestIds: string[];
  /**
   * The approval_requests row fanned out to the REQUESTER, when one exists —
   * i.e. the sole-operator branch (requester is the only eligible approver) OR
   * a supervised intent (always exactly one requester-owned row). null on a
   * multi-approver four_eyes fan-out (spec §4: the requester is excluded) and
   * when there are no approvers. The web chat card uses this to offer an
   * inline L3 self-approve (WebAuthn) for exactly this row and no other.
   */
  requesterApprovalRequestId: string | null;
  /** Pending-approval deadline (Task 2's approvalExpiresAt column) — split
   * from `expiresAt` by scope (see computeExpiresAt): 5min supervised-chat,
   * 60min four_eyes-chat, 24h mcp_api either scope. */
  approvalExpiresAt: Date | null;
  /** userIds that received a fanned-out approval row on creation, in the same
   * order as approvalRequestIds. Empty on an idempotent replay (no new
   * fan-out happened) and on a read via getActionIntent (fan-out is a
   * creation-time concept only). */
  fanOutUserIds: string[];
};

export interface ActionIntentTransitionPatch {
  decidedAt?: Date | null;
  decidedByUserId?: string | null;
  decidedAssuranceLevel?: AssuranceLevel | null;
  decidedVia?: string | null;
  executionStartedAt?: Date | null;
  executedAt?: Date | null;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Expiry defaults (spec §3.4, extended by the tier3-supervised-four-eyes
// split design §4.2): chat matches the existing 5-minute waitForApproval UX
// for supervised intents; four_eyes chat intents get a longer 60-minute
// window since finding a second approver takes real wall-clock time. mcp_api
// gets a day regardless of scope, since there's no live session blocking on
// it. Constants, not env vars, per the design.
const CHAT_EXPIRY_MS = 5 * 60 * 1000;
const FOUR_EYES_CHAT_EXPIRY_MS = 60 * 60 * 1000;
const MCP_EXPIRY_MS = 24 * 60 * 60 * 1000;
// Headless agent proposals have no human watching a chat pane; give
// reviewers a working day. Deliberate, not inherited from the MCP window
// (which it happens to equal today) — change one without silently changing
// the other.
const AGENT_INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed release lease (tier3-supervised-four-eyes design §4.2): how long an
 * `approved` intent has to actually execute before the reaper reclaims it.
 * Stamped into `release_by` by the approve fan-in
 * (`routes/approvals.ts`) in the same CAS that flips the intent to
 * `approved` — independent of how much of the `approval_expires_at` window
 * was left when the approval landed. Without this, an intent approved with
 * only seconds left on its approval deadline would have only seconds to
 * execute instead of a full lease (the "59:59 trap" — see
 * `jobs/intentExpiryReaper.ts`'s header).
 */
export const RELEASE_LEASE_MS = 10 * 60 * 1000;

/**
 * Version of the tier3-supervised-four-eyes classification ruleset
 * (checkGuardrails' resolveApprovalScope) that produced a given intent's
 * approvalScope. Stamped once at creation into action_intents.classification_version
 * (Task 2) so a future ruleset change can be told apart from intents
 * classified under an older version. Bump when the classification logic
 * changes in a materially observable way.
 *
 * v2 (#3552, 2026-08-14): the policy-prerequisite mutators
 * manage_update_rings / manage_software_policies / manage_peripheral_policies
 * create+update moved from Tier 2 (auto-execute) to Tier 3 `supervised`, so
 * they produce approval intents for the first time. Intents for those pairs
 * only exist from v2 onward; their absence before v2 is a tier gap, not a
 * gap in the record.
 */
export const CLASSIFICATION_VERSION = 2;

const MAX_ARG_VALUE_LEN = 80;

/** Canonical lowercase UUID — the only form the Postgres `uuid` binding
 * columns may receive (design §5.2; an uppercase GUID would 22P02 at INSERT). */
const CANONICAL_UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Summary / digest helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max = MAX_ARG_VALUE_LEN): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stringifyArgValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** target = tool name + top-level arg keys with values truncated to 80 chars (resolved decision). */
function buildTargetSummary(toolName: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return toolName;
  const parts = keys.map((key) => `${key}=${truncate(stringifyArgValue(input[key]))}`);
  return `${toolName}(${parts.join(', ')})`;
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : text).trim();
}

/** impact = first sentence of the tool description (or the guardrail description) — resolved decision. */
function buildImpactSummary(toolName: string, guardrail: GuardrailCheck): string {
  const definitionDescription = aiTools.get(toolName)?.definition.description;
  const description = definitionDescription || guardrail.description || `Execute ${toolName}`;
  return firstSentence(description);
}

/**
 * `scopeDeviceId` (P2-2) is appended to the hashed material ONLY when it is
 * non-null, so every key derived before this parameter existed — and every
 * key derived for an unscoped intent today — is byte-identical to what it
 * always was. A scoped intent must NOT collide with the unscoped one that
 * shares its run/tool/arguments, and two intents that differ only in their
 * scope device (the sweep fan-out case: same tool, same args, one per device)
 * must land on DIFFERENT keys or the partial unique index would collapse the
 * whole sweep to one live intent.
 */
function deriveIdempotencyKey(
  actorId: string,
  actionName: string,
  digest: string,
  scopeDeviceId: string | null = null,
): string {
  const material = scopeDeviceId
    ? `${actorId}:${actionName}:${digest}:${scopeDeviceId}`
    : `${actorId}:${actionName}:${digest}`;
  return createHash('sha256').update(material).digest('hex');
}

function computeExpiresAt(source: ActionIntentSource, approvalScope: ActionIntentApprovalScope): Date {
  if (source === 'ai_agent') return new Date(Date.now() + AGENT_INTENT_EXPIRY_MS);
  if (source !== 'chat') return new Date(Date.now() + MCP_EXPIRY_MS);
  const ms = approvalScope === 'supervised' ? CHAT_EXPIRY_MS : FOUR_EYES_CHAT_EXPIRY_MS;
  return new Date(Date.now() + ms);
}

function toSnapshot(
  intent: ActionIntent,
  approvalRequestIds: string[],
  requesterApprovalRequestId: string | null,
  fanOutUserIds: string[] = [],
): ActionIntentSnapshot {
  return {
    id: intent.id,
    status: intent.status,
    actionName: intent.actionName,
    argumentDigest: intent.argumentDigest,
    source: intent.source,
    expiresAt: intent.expiresAt,
    result: intent.result,
    errorCode: intent.errorCode,
    approvalRequestIds,
    requesterApprovalRequestId,
    approvalExpiresAt: intent.approvalExpiresAt,
    fanOutUserIds,
  };
}

// ---------------------------------------------------------------------------
// createActionIntent
// ---------------------------------------------------------------------------

interface CreationResult {
  intent: ActionIntent;
  approvalRequestIds: string[];
  requesterApprovalRequestId: string | null;
  /** userIds that received a fanned-out approval row, in the same order as approvalRequestIds — used for the post-commit push fan-out. Empty on an idempotent replay. */
  fanOutUserIds: string[];
  isNew: boolean;
  /** Which of effectDigest.ts's three outcomes the pinning attempt produced.
   * Carried out of the transaction so the `unresolved` cases can be audited
   * AFTER commit (the intent id doesn't exist until the insert returns, and
   * an event for a rolled-back intent would be a lie). */
  effectDigestOutcome: EffectDigestOutcome;
}

/**
 * Wave 5 Part B (#3827) — the real decision-state gate. `'unattempted'` iff
 * ALL THREE hold: the sub-flag is on, the intent is agent-originated (a
 * human-authored chat/MCP intent means a human already decided — there is
 * nothing for policy to authorize), and the intent classified `supervised`
 * (four_eyes requires a SECOND human by definition; policy is a mechanism,
 * not a principal, and cannot stand in for that reviewer — locked quorum
 * decision, plan header). Every other case returns `'human_required'`,
 * exactly Part A's stub output — so flag-off is BYTE-IDENTICAL to Part A: no
 * other condition below is even evaluated once the flag check fails.
 *
 * Deliberately NOT checked here (Task 5, #3827 — a later task in this same
 * plan): the run's `mode`. `attemptPolicyDecision` (policyDecide.ts) is the
 * only consumer of the `'unattempted'` state this function produces, and it
 * re-verifies the LIVE effective policy (registry membership, per-agent
 * authorization, guardrails, kill state, caps) before ever authorizing
 * anything — an `'unattempted'` intent from a shadow-mode run degrades to
 * `human_required` there, it does not execute unattended.
 */
function resolvePolicyDecisionState(args: {
  guardrail: GuardrailCheck;
  approvalScope: ActionIntentApprovalScope;
  agentRun: AgentRunRef;
  toolName: string;
  input: Record<string, unknown>;
  /**
   * The run's OWN policy-snapshot mode (loaded.run.policySnapshot?.effective
   * ?.mode above), NOT re-resolved from the agent's current live policy —
   * this is the creation-time half of the LOCKED quorum decision "policy-
   * decide requires mode === 'act'" (plan header, Task 5, #3827).
   * policyDecide.ts's attemptPolicyDecision re-checks the CURRENT live mode
   * again at attempt time (an operator can flip act -> shadow as a brake
   * between creation and attempt) and keeps its own check even after this
   * one ships, as defense in depth — see its comment. Undefined for a
   * malformed/legacy snapshot; anything but the literal string 'act' fails
   * closed to human_required, same as every other branch here.
   */
  agentMode: string | undefined;
  /**
   * P2-2 (#4189): true when the caller pinned an explicit target device
   * (`CreateActionIntentInput.scope`) — i.e. this is a SWEEP-minted proposal
   * from a device-less run. See the `hasScope` branch below.
   */
  hasScope: boolean;
}): ActionIntentPolicyDecisionState {
  void args.toolName;
  void args.input;
  if (!policyDecideEnabled()) return 'human_required';
  // Phase 2 P2-1: a Tier-2 intent (only ever agent-originated + supervised —
  // see the `agentTier2` gate above) is NEVER policy-decidable. Policy-decide
  // exists to stand in for a human on a Tier-3 supervised call the operator
  // has pre-authorized; a Tier-2 call already auto-executes for every OTHER
  // principal and only reaches this function at all because the ai_agent
  // principal is filing it as a supervised intent for a human to see — that
  // human step is the point, not a gap to skip.
  if (args.guardrail.tier < 3) return 'human_required';
  // P2-2 (#4189) — spec §4.2 AMENDMENT: a sweep-minted proposal is a
  // supervised inbox card THIS WAVE, never a policy-decided auto-execution.
  // An explicit `scope` is the only signal creation has that this intent was
  // minted for a device the run itself is not bound to, and it is
  // agent-principal-only (rejected above for every other principal), so it
  // cannot be forged into a decidability change from the outside.
  //
  // Why the scope and not the run's profile: a sweep proposal is fanned out
  // per DEVICE from one device-less run, so the human reviewing it is being
  // shown a target the run never established for itself. Policy-decide's
  // pre-authorization was written against the run-bound target — extending
  // it to a target the operator's per-agent authorization never saw is a
  // wider grant than it was reviewed as. Act-mode auto-execution for sweeps
  // is roadmap #4442 (explicitly OUT of P2-5, quorum 2026-09-01), behind
  // its own review, and is expected to REPLACE this line rather than route
  // around it.
  if (args.hasScope) return 'human_required';
  if (!args.agentRun) return 'human_required';
  if (args.approvalScope !== 'supervised') return 'human_required';
  if (args.agentMode !== 'act') return 'human_required';
  return 'unattempted';
}

interface HumanFanoutArgs {
  /** Same connection/transaction the intent insert ran on (system-scoped). */
  db: Database;
  /** The just-inserted (or freshly re-cancelled) intent row. */
  inserted: ActionIntent;
  toolName: string;
  actionArguments: Record<string, unknown>;
  argumentDigest: string;
  requestingClientLabel: string;
  targetSummary: string;
  riskTier: 'medium' | 'high' | 'critical';
  impactSummary: string;
  expiresAt: Date;
  agentRun: AgentRunRef;
  approvalScope: ActionIntentApprovalScope;
  eligibleApprovers: string[];
  agentEligibleApprovers: string[];
  requesterEligible: boolean;
  requesterId: string;
}

interface HumanFanoutResult {
  approvalRequestIds: string[];
  requesterApprovalRequestId: string | null;
  fanOutUserIds: string[];
  /** `inserted`, or the cancelled row when no eligible approver was found. */
  finalIntent: ActionIntent;
}

/**
 * Verbatim extraction of createActionIntent's pre-refactor inline fan-out
 * block (approval_requests inserts for every scope branch, plus the
 * no-eligible-approver fail-closed cancellation). Runs on the SAME
 * transaction the intent insert used (`args.db`), so the whole thing still
 * commits or rolls back atomically with the insert — moving this out of the
 * closure changes nothing about atomicity, only where the code lives.
 */
async function runHumanFanout(args: HumanFanoutArgs): Promise<HumanFanoutResult> {
  const {
    db: tx,
    inserted,
    toolName,
    actionArguments,
    argumentDigest,
    requestingClientLabel,
    targetSummary,
    riskTier,
    impactSummary,
    expiresAt,
    agentRun,
    approvalScope,
    eligibleApprovers,
    agentEligibleApprovers,
    requesterEligible,
    requesterId,
  } = args;

  let approvalRequestIds: string[] = [];
  let requesterApprovalRequestId: string | null = null;
  let fanOutUserIds: string[] = [];

  const approvalRowFor = (userId: string) => ({
    userId,
    requestingClientLabel,
    actionLabel: targetSummary,
    actionToolName: toolName,
    actionArguments,
    riskTier,
    riskSummary: impactSummary,
    status: 'pending' as const,
    expiresAt,
    intentId: inserted.id,
    boundArgumentDigest: argumentDigest,
    isRecursive: false,
  });

  // Shared by the supervised short-circuit and the four_eyes sole-operator
  // branch below: both create exactly one approval_requests row owned by
  // a single user and derive the same trio of locals from it.
  const insertSingleApproverRow = async (
    userId: string,
  ): Promise<{
    approvalRequestIds: string[];
    requesterApprovalRequestId: string | null;
    fanOutUserIds: string[];
  }> => {
    const rows = await tx
      .insert(approvalRequests)
      .values([approvalRowFor(userId)])
      .returning({ id: approvalRequests.id });
    if (rows[0]) {
      return {
        approvalRequestIds: [rows[0].id],
        requesterApprovalRequestId: rows[0].id,
        fanOutUserIds: [userId],
      };
    }
    return { approvalRequestIds: [], requesterApprovalRequestId: null, fanOutUserIds: [] };
  };

  if (agentRun) {
    // Agent intents have NO requester, so neither the supervised
    // requester short-circuit nor the sole-operator fallback below can
    // apply. Supervised fans out to the action-and-target-eligible humans
    // resolved above (spec §3.4: any human with the action's RBAC AND
    // access to the concrete target); four_eyes keeps the org-wide
    // approvals:decide pool unchanged. An empty pool falls through to the
    // no_eligible_approvers cancellation below.
    const pool = approvalScope === 'four_eyes' ? eligibleApprovers : agentEligibleApprovers;
    if (pool.length > 0) {
      const rows = await tx
        .insert(approvalRequests)
        .values(pool.map(approvalRowFor))
        .returning({ id: approvalRequests.id });
      approvalRequestIds = rows.map((r) => r.id);
      fanOutUserIds = pool;
    }
  } else if (approvalScope === 'supervised') {
    // Supervised short-circuit (tier3-supervised-four-eyes split design
    // §4.2): exactly one approval row, always owned by the requester,
    // BEFORE the eligible-approver branch below — supervised does not
    // require approvals:decide at all, so this must work even when
    // eligibleApprovers is empty and requesterEligible is false (the
    // requester holds no approval permission whatsoever). The
    // assurance-level gate is enforced later in the decide handler
    // (Task 5), same as the sole-operator four_eyes branch.
    ({ approvalRequestIds, requesterApprovalRequestId, fanOutUserIds } =
      await insertSingleApproverRow(requesterId));
  } else if (eligibleApprovers.length > 0) {
    const rows = await tx
      .insert(approvalRequests)
      .values(eligibleApprovers.map(approvalRowFor))
      .returning({ id: approvalRequests.id });
    approvalRequestIds = rows.map((r) => r.id);
    fanOutUserIds = eligibleApprovers;
  } else if (requesterEligible) {
    // Sole-operator branch: the only eligible approver is the requester.
    // Create one row carrying the digest; the assurance-level >= 3 gate is
    // enforced later, in the decide handler (Task 5), not here.
    ({ approvalRequestIds, requesterApprovalRequestId, fanOutUserIds } =
      await insertSingleApproverRow(requesterId));
  }

  let finalIntent: ActionIntent = inserted;
  if (approvalRequestIds.length === 0) {
    // No eligible approvers and the requester isn't one either — fail
    // closed: create then immediately cancel, visible in audit (spec §4
    // step 4 / §8).
    const [cancelled] = await tx
      .update(actionIntents)
      .set({ status: 'cancelled', errorCode: 'no_eligible_approvers', decidedAt: new Date() })
      .where(eq(actionIntents.id, inserted.id))
      .returning();
    finalIntent = cancelled ?? {
      ...inserted,
      status: 'cancelled',
      errorCode: 'no_eligible_approvers',
    };
  }

  return { approvalRequestIds, requesterApprovalRequestId, fanOutUserIds, finalIntent };
}

interface NotifyFannedOutApproversArgs {
  orgId: string;
  intentId: string;
  approvalRequestIds: string[];
  fanOutUserIds: string[];
  requestingClientLabel: string;
  targetSummary: string;
  /** Passed to `withDbAccessContext` for the push-token read only — the
   *  in-app notification always runs system-scoped (see the call below).
   *  `userId` on it may be null (agent-originated fan-out has no requester);
   *  the token read is keyed on the loop's OWN `userId` param, not this
   *  context's — see db/index.ts's `DbAccessContext.userId` doc comment. */
  dbContext: DbAccessContext;
}

/**
 * Best-effort in-app + push notification for a just-fanned-out set of
 * approval rows, AFTER whatever transaction created them commits (#1105) —
 * never hold a DB transaction open across the push network round-trip.
 * Extracted (wave 5 Part B, #3827) so `runDeferredHumanFanout` below can
 * deliver the SAME notifications a normal creation-time human fan-out would
 * have, instead of a second, drifting copy of this loop.
 */
async function notifyFannedOutApprovers(args: NotifyFannedOutApproversArgs): Promise<void> {
  const { orgId, intentId, approvalRequestIds, fanOutUserIds, requestingClientLabel, targetSummary, dbContext } = args;
  for (let i = 0; i < approvalRequestIds.length; i++) {
    const approvalId = approvalRequestIds[i];
    const userId = fanOutUserIds[i];
    if (!approvalId || !userId) continue;
    // In-app FIRST, then push. getUserPushTokens reads mobile_devices
    // exclusively, so before wave 2 an approver with no enrolled phone was
    // notified by NOTHING — no row, no email, no event — while the push
    // failure was swallowed to console.error. The in-app row is the channel
    // that always exists, so it must not be downstream of the phone lookup.
    try {
      // runOutsideDbContext first: a bare system wrapper inside an ambient
      // request context is a passthrough (db/index.ts ~440), and this
      // cross-user insert would then 42501 into the catch below.
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        createNotification({
          userId,
          orgId,
          type: 'approval',
          priority: 'high',
          title: 'Approval requested',
          message: `${requestingClientLabel}: ${targetSummary}`,
          link: '/approvals',
          metadata: { approvalId, intentId },
          // Survives outbox/BullMQ redelivery: one approver, one intent, one
          // row in the bell.
          dedupeKey: `intent-approval:${intentId}`,
        })));
    } catch (err) {
      // Sentry, not just console.error. This is the highest-stakes swallow in
      // the wave: it is the ONLY channel a phoneless approver has, and the
      // wave exists because the equivalent push failure was console.error-only
      // and nobody found out for months. Every neighbouring file in this
      // subsystem pairs the log with captureException; this one must too.
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(
        `[intentService] in-app approval notification failed ` +
          `(intent=${intentId} approval=${approvalId} user=${userId})`,
        err,
      );
    }

    try {
      const tokens = await withDbAccessContext(dbContext, () => getUserPushTokens(userId));
      await dispatchApprovalPushToTokens(tokens, {
        approvalId,
        actionLabel: targetSummary,
        requestingClientLabel,
      });
    } catch (err) {
      console.error('[intentService] approval push dispatch failed', approvalId, err);
    }
  }
}

/**
 * Fire-and-forget trigger for a freshly-`'unattempted'` intent (wave 5 Part
 * B, #3827). Dynamic `import()` — NOT a static import of `./policyDecide` —
 * is load-bearing, not stylistic: `policyDecide.ts` statically imports
 * `runDeferredHumanFanout` from THIS file (its deterministic-failure degrade
 * path), so a static import here in the other direction would be a genuine
 * circular module dependency between the two. Resolved lazily, inside a
 * function body, after both modules have finished evaluating, this never
 * cycles. Errors — INCLUDING `PolicyDecisionTransientError`, the
 * discriminated signal `attemptPolicyDecision` throws for a transient
 * DB/Redis fault (review fix, #3827) — are deliberately swallowed here
 * (never rejected back to this call's own caller, and never retried from
 * this end): this trigger is fire-and-forget and does not survive a
 * crash/restart, so it cannot be the retry lane. The outbox's
 * `intent_created` recovery branch (intentReleaseWorker.ts) is that lane —
 * it's the one durable caller that rethrows `PolicyDecisionTransientError`
 * so BullMQ redelivers the job; this call site logging-and-dropping the same
 * error is correct, not a gap.
 */
function triggerPolicyDecisionAttempt(intentId: string): void {
  import('./policyDecide')
    .then((mod) => mod.attemptPolicyDecision(intentId))
    .catch((err) => {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error(`[intentService] attemptPolicyDecision failed for intent ${intentId}:`, err);
    });
}

export async function createActionIntent(
  auth: AuthContext,
  input: CreateActionIntentInput,
): Promise<ActionIntentSnapshot> {
  // Mutual source/principal consistency (wave 3b): an ai_agent principal may
  // ONLY write source='ai_agent' rows, and nothing else may claim that
  // source. The requester-less attribution facts (requestedByUserId NULL +
  // requestingAgentRunId) key off this pairing, so a mismatch is rejected
  // outright rather than recorded as whatever synthetic user the agent's
  // attribution record carries — or, in the other direction, as a human
  // intent masquerading as an agent proposal.
  const isAgentIntent = auth.principal.kind === 'ai_agent';
  if (isAgentIntent !== (input.source === 'ai_agent')) {
    throw new ActionIntentError(
      isAgentIntent
        ? `AI agent principals must create intents with source 'ai_agent' (got '${input.source}')`
        : `source 'ai_agent' is reserved for ai_agent principals (got principal '${auth.principal.kind}')`,
      'agent_source_mismatch',
    );
  }
  // P2-2 (#4189): an explicit device scope is the SWEEP path's way of minting
  // a device-bound intent from a device-less run. It is agent-principal only —
  // a human/MCP caller's target already comes from the tool arguments the
  // approval card renders, and letting one pin an arbitrary `scope_device_id`
  // would add a second, unaudited target axis to the human approval story.
  if (input.scope && auth.principal.kind !== 'ai_agent') {
    throw new ActionIntentError(
      `scope is only valid for the ai_agent principal (got principal '${auth.principal.kind}')`,
      'scope_not_allowed',
    );
  }
  // `scope_device_id` / `scope_ticket_id` are Postgres `uuid` columns: an
  // uppercase or malformed GUID would raise 22P02 at INSERT (a 500), not a
  // validation error — same reasoning as the `binding` checks further down.
  if (input.scope && 'deviceId' in input.scope && !CANONICAL_UUID_LOWER.test(input.scope.deviceId)) {
    throw new ActionIntentError('scope.deviceId must be a canonical lowercase UUID', 'invalid_scope');
  }
  if (input.scope && 'ticketId' in input.scope && !CANONICAL_UUID_LOWER.test(input.scope.ticketId)) {
    throw new ActionIntentError('scope.ticketId must be a canonical lowercase UUID', 'invalid_scope');
  }
  // Captured here, at the top level, on purpose: TypeScript discards property
  // narrowing inside the transaction closure below, so reading
  // `auth.principal.kind` at the insert site would widen the type back out.
  const originPrincipalKind: ActionIntentOriginPrincipalKind = auth.principal.kind;
  // Same reasoning, for the scope union: every later use site (idempotency
  // key, the insert values, the ticket-autonomy evaluation) needs a plain
  // `string | null` it can read without re-narrowing `input.scope`. The two
  // variants are mutually exclusive (`scope_ticket_chk`), so at most one of
  // these is ever non-null.
  const scopeDeviceId = input.scope && 'deviceId' in input.scope ? input.scope.deviceId : null;
  const scopeTicketId = input.scope && 'ticketId' in input.scope ? input.scope.ticketId : null;

  const guardrail = checkGuardrails(input.toolName, input.input);
  if (!guardrail.allowed || guardrail.tier >= 4) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is not permitted on the action-intent path: ${guardrail.reason ?? 'blocked'}`,
      'tool_blocked',
      guardrail.tier,
    );
  }
  // Phase 2 P2-1: the ai_agent principal may file Tier-2 intents. They are
  // always `supervised` (one human approver from agentEligibleApprovers —
  // the requester-less branch at the fan-out below), never four_eyes, and
  // never policy-decidable (resolvePolicyDecisionState returns
  // human_required for tier < 3). Chat/MCP principals keep the Tier-3-only
  // contract: their Tier-2 calls auto-execute in-session and never need an
  // approval object.
  const agentTier2 = auth.principal.kind === 'ai_agent' && guardrail.tier === 2;
  if (guardrail.tier <= 2 && !agentTier2) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is tier ${guardrail.tier}; action intents are for Tier-3 approval-required tools only`,
      'tool_not_tier3',
      guardrail.tier,
    );
  }

  const resolvedOrg = resolveWritableToolOrgId(auth, input.orgId);
  if (!resolvedOrg.orgId) {
    throw new ActionIntentError(resolvedOrg.error ?? 'Organization context required', 'org_resolution_failed');
  }
  const orgId = resolvedOrg.orgId;
  // P2-5 (#4192): `manage_ai_agents.orgId` is an ADDRESS, not a target
  // selector. It exists only so the effect-digest resolver — which receives
  // `(args, database)` and recomputes under a system context with no ambient
  // org — can name the org whose supervised-key list is being pinned
  // (services/actionIntents/effectDigest.ts). Rejected HERE rather than in
  // the promote route because BOTH creation paths funnel through this
  // function: the route and the chat/MCP `tool()` declaration. The executor
  // re-asserts the same equality against this row's own immutable `org_id`
  // before it writes, so neither check is load-bearing alone.
  if (input.toolName === ORG_PINNED_ARG_TOOL && input.input.orgId !== orgId) {
    throw new ActionIntentError(
      `"${ORG_PINNED_ARG_TOOL}" must name the organization the request is authorized for`,
      'org_argument_mismatch',
    );
  }
  const requesterId = auth.user.id;
  // Tier-3 supervised/four_eyes classification (Task 1's checkGuardrails).
  // Pre-existing tools that haven't been classified yet (approvalScope
  // absent) fall back to four_eyes — the stricter, pre-split behavior — never
  // the weaker supervised path. Mirrors the column's own DEFAULT 'four_eyes'
  // (migration 2026-08-14-intent-approval-scope-and-deadlines.sql).
  const approvalScope: ActionIntentApprovalScope = agentTier2 ? 'supervised' : (guardrail.approvalScope ?? 'four_eyes');

  if (input.binding) {
    // Both columns are Postgres `uuid`. An uppercase or malformed GUID would
    // raise 22P02 at INSERT, surfacing as a 500 rather than a validation
    // error, so reject it here.
    if (!CANONICAL_UUID_LOWER.test(input.binding.connectionId)) {
      throw new ActionIntentError('binding.connectionId must be a canonical lowercase UUID', 'invalid_binding');
    }
    if (!CANONICAL_UUID_LOWER.test(input.binding.tenantId)) {
      throw new ActionIntentError('binding.tenantId must be a canonical lowercase UUID', 'invalid_binding');
    }
  }

  // -------------------------------------------------------------------------
  // Agent-originated intents (wave 3b): load + verify the run, then re-verify
  // the guardrail verdict INSIDE the service. The caller's claimed verdict is
  // never trusted (spec §5.3) — a compromised or buggy runner must not be able
  // to smuggle a proposal past the run's own policy snapshot.
  // -------------------------------------------------------------------------
  let agentRun: AgentRunRef = null;
  let agentRow: { id: string; name: string } | null = null;
  // Task 5 (#3827): the run's own policy-snapshot mode, captured alongside
  // `effective` below — resolvePolicyDecisionState's creation-time act-mode
  // gate reads this, never a fresh live-policy lookup (that re-check is
  // policyDecide.ts's job, at attempt time). Stays undefined for every
  // human-originated intent (agentRun stays null, which already forces
  // human_required on its own).
  let agentRunMode: string | undefined;
  if (auth.principal.kind === 'ai_agent') {
    const principal = auth.principal;
    // scopeDeviceId/scopeTicketId are the top-level consts above — captured
    // there (not re-declared here) so the system read below can close over
    // them via the same variables the later insert/idempotency-key sites use.
    // runOutsideDbContext is load-bearing: a bare system wrapper inside an
    // ambient request context is a passthrough (db/index.ts ~440) and the
    // run/agent/device reads below must not silently run under whatever org
    // context the caller happens to hold.
    const loaded = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [run] = await db
          .select({
            id: aiAgentRuns.id,
            agentId: aiAgentRuns.agentId,
            orgId: aiAgentRuns.orgId,
            deviceId: aiAgentRuns.deviceId,
            policySnapshot: aiAgentRuns.policySnapshot,
          })
          .from(aiAgentRuns)
          .where(eq(aiAgentRuns.id, principal.runId))
          .limit(1);
        if (!run || run.agentId !== principal.agentId || run.orgId !== orgId) return null;
        const [agent] = await db
          .select({ id: aiAgents.id, name: aiAgents.name })
          .from(aiAgents)
          .where(eq(aiAgents.id, run.agentId))
          .limit(1);
        if (!agent) return null;
        let deviceSiteId: string | null = null;
        if (run.deviceId) {
          const [device] = await db
            .select({ siteId: devices.siteId })
            .from(devices)
            .where(eq(devices.id, run.deviceId))
            .limit(1);
          deviceSiteId = device?.siteId ?? null;
        }
        // P2-2: the explicitly scoped device, loaded under the SAME system
        // read as the run/agent above. `orgId` is projected so the caller can
        // pin it to the intent's org — a scoped device from another tenant
        // must be indistinguishable from a nonexistent one (same rule
        // resolveIntentTargetScope applies to device args).
        let scopedDevice: { id: string; orgId: string; siteId: string | null } | null = null;
        if (scopeDeviceId) {
          const [device] = await db
            .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
            .from(devices)
            .where(eq(devices.id, scopeDeviceId))
            .limit(1);
          scopedDevice = device ?? null;
        }
        // P2-4 (#4191): the explicitly scoped ticket, loaded under the SAME
        // system read — mirrors the device projection above. `orgId` lets
        // the caller pin it to the intent's org, same rule as the device
        // case (a cross-tenant ticket id is indistinguishable from a
        // nonexistent one).
        let scopedTicket: { id: string; orgId: string } | null = null;
        if (scopeTicketId) {
          const [ticket] = await db
            .select({ id: tickets.id, orgId: tickets.orgId })
            .from(tickets)
            .where(eq(tickets.id, scopeTicketId))
            .limit(1);
          scopedTicket = ticket ?? null;
        }
        return { run, agent, deviceSiteId, scopedDevice, scopedTicket };
      }),
    );
    if (!loaded) {
      throw new ActionIntentError(
        'AI agent run is missing, belongs to another agent, or targets another org',
        'agent_run_invalid',
      );
    }
    agentRun = loaded.run;
    agentRow = loaded.agent;

    // P2-2 (#4189): an explicit scope must name a device that EXISTS in this
    // intent's org. A missing device and a cross-tenant one hit the same
    // error on purpose — otherwise this is a device-UUID existence oracle for
    // whatever runner produced the id.
    if (scopeDeviceId && (!loaded.scopedDevice || loaded.scopedDevice.orgId !== orgId)) {
      throw new ActionIntentError(
        'scoped device is missing or belongs to another org',
        'scope_device_invalid',
      );
    }
    // P2-4 (#4191): the ticket mirror of the device check above.
    if (scopeTicketId && (!loaded.scopedTicket || loaded.scopedTicket.orgId !== orgId)) {
      throw new ActionIntentError(
        'scoped ticket is missing or belongs to another org',
        'scope_ticket_invalid',
      );
    }
    // ...and the proposed arguments must not reach past that device. Without
    // this a sweep runner could scope an intent to device A (narrowing every
    // release-time guardrail re-run to A's site) while the arguments actually
    // act on device B.
    if (scopeDeviceId) {
      try {
        assertArgsMatchScope(input.toolName, input.input, scopeDeviceId);
      } catch (err) {
        if (err instanceof IntentScopeArgumentMismatchError) {
          throw new ActionIntentError(err.message, 'scope_argument_mismatch');
        }
        throw err;
      }
    }
    // I2 (final review #4191): the ticket mirror of the device args check
    // above — a ticket-scoped intent's arguments must not name a DIFFERENT
    // ticket than the scope. See `assertArgsMatchTicketScope`'s doc comment.
    if (scopeTicketId) {
      try {
        assertArgsMatchTicketScope(input.toolName, input.input, scopeTicketId);
      } catch (err) {
        if (err instanceof IntentScopeArgumentMismatchError) {
          throw new ActionIntentError(err.message, 'scope_argument_mismatch');
        }
        throw err;
      }
    }

    // Re-verify the verdict from the run's own policy snapshot. deviceId and
    // deviceSiteId come from the intent's TARGET — the explicit scope when
    // there is one, otherwise the RUN row — never from tool input (Task 3:
    // isAgentGuardrailPolicy rejects an absent deviceId, so it must be
    // populated explicitly — a malformed snapshot fails validation inside
    // checkAgentGuardrails and denies, which is the fail-closed shape we
    // want, hence the cast instead of a hand-rolled validator here). Feeding
    // the SCOPE here is what lets a device-less sweep run propose a mutation
    // at all: checkAgentGuardrails denies every mutating call whose
    // policy.deviceId is null ("the run is not device-bound").
    const effective = loaded.run.policySnapshot?.effective;
    agentRunMode = effective?.mode;
    // Through the SAME resolver every release/decide-time reader uses, rather
    // than an inline `scope ?? run` — creation and release must not be able to
    // drift on what "the intent's target device" means. A freshly-minted
    // intent can never be a tombstone (the scoped device was just verified
    // above), so this collapses to the scope device or the run's.
    const creationTarget = resolveIntentTargetDevice(
      {
        scopeKind: scopeDeviceId ? 'device' : scopeTicketId ? 'ticket' : null,
        scopeDeviceId,
        scopeTicketId,
      },
      loaded.run,
    );
    const verdict = checkAgentGuardrails(input.toolName, input.input, {
      enabled: effective?.enabled,
      mode: effective?.mode,
      toolAllowlist: effective?.toolAllowlist,
      protectedResources: effective?.protectedResources,
      deviceId: effectiveTargetDeviceId(creationTarget),
      // Review fix (round 1): branch on WHICH device is the target, never
      // `scopedDevice?.siteId ?? deviceSiteId`. `devices.site_id` is nullable,
      // so a scoped device with no site would fall through `??` to the RUN
      // device's site — pairing `deviceId = <scope device>` with
      // `deviceSiteId = <a different device's site>`, which is exactly the
      // input `siteScopeDenial` evaluates. All three release-time readers use
      // `device.siteId ?? null` with NO run fallback, so the `??` form made
      // creation and release disagree for a site-less scoped device.
      deviceSiteId: loaded.scopedDevice ? (loaded.scopedDevice.siteId ?? null) : loaded.deviceSiteId,
      // P2-4 (#4191) forward-compat: `AgentGuardrailPolicy` does not declare
      // a `scope` field yet — Task A4 adds it, threading it through the
      // device-less-mutation deny so a ticket-scoped `manage_tickets` call
      // satisfies the target-binding requirement without a device. Carried
      // here (via the existing `as AgentGuardrailPolicy` cast, so it compiles
      // as an inert extra key today) so creation and release agree on what
      // populates it the moment Task A4 lands, rather than needing a second
      // follow-up PR to wire the creation call site too.
      ...(scopeTicketId ? { scope: { ticketId: scopeTicketId } } : {}),
    } as AgentGuardrailPolicy);
    if (verdict.disposition === 'deny') {
      throw new ActionIntentError(
        `Agent policy denies "${input.toolName}": ${verdict.reason ?? 'denied'}`,
        'agent_policy_denied',
      );
    }
  }

  const canonical = canonicalizeArguments(input.input);
  const argumentDigest = computeArgumentDigest(canonical);
  // Agent default key is RUN-scoped (run id, not the synthetic agent user
  // id): two runs of the same agent proposing identical arguments must
  // yield DISTINCT intents — an intent is immutably attributed to one run,
  // whose policy snapshot the release path evaluates (review major 4).
  const idempotencyKey = input.idempotencyKey
    ?? deriveIdempotencyKey(
      agentRun ? agentRun.id : requesterId,
      input.toolName,
      argumentDigest,
      // The two scope variants are mutually exclusive; either one (or
      // neither) folds into the SAME hashed-material parameter that has
      // always carried the device scope — a ticket-scoped fan-out (multiple
      // ticket-triage proposals for the same tool+args, one per ticket) must
      // land on distinct keys for exactly the same reason a device sweep
      // fan-out does.
      scopeDeviceId ?? scopeTicketId ?? null,
    );
  const targetSummary = buildTargetSummary(input.toolName, input.input);
  const impactSummary = buildImpactSummary(input.toolName, guardrail);
  const expiresAt = computeExpiresAt(input.source, approvalScope);
  const requestingClientLabel = input.requestingClientLabel
    ?? (agentRow ? agentRow.name : input.source === 'chat' ? 'Breeze AI' : 'MCP API client');
  // Tier → riskTier mapping mirrors aiAgentSdk.ts's mobile-approval bridge.
  // T4 is refused above, so only two labels are reachable here: Tier-3 (every
  // non-agent intent, and any agent intent that isn't Tier-2) maps to 'high',
  // which DEFAULT_ASSURANCE_FLOOR (@breeze/shared) floors at L3 — the normal
  // approval bar. Phase 2 P2-1's `agentTier2` path is the ONE way `guardrail.
  // tier` can be 2 here (the tier gate's `tier <= 2 && !agentTier2` throws
  // tool_not_tier3 for a Tier-2 call from every other principal, above), and
  // it deliberately maps to 'medium' → L2,
  // not a bug carried over from a stale "tier is always 3" assumption.
  // CONTROLLER RULING (P2-1 fix round 1): L2 is the INTENDED floor for these
  // rows — an agent-originated Tier-2 approval is a one-click inbox approval
  // of a reversible, single-target, already-auto-executable-for-every-other-
  // principal operation (manage_alerts:suppress and friends); requiring L3
  // re-auth on every one of them would defeat the point of a lightweight
  // supervised lane. Pinned by intentService.tier2Agent.test.ts.
  const riskTier: 'medium' | 'high' | 'critical' =
    guardrail.tier >= 4 ? 'critical' : guardrail.tier >= 3 ? 'high' : 'medium';

  const dbContext: DbAccessContext = {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    userId: requesterId,
  };

  // Resolve eligible approvers (org + partner axis, filtered by
  // approvals:decide, excluding the requester — spec §4 step 4 / CRITICAL-2)
  // BEFORE opening the creation transaction below. resolveIntentApprovers
  // manages its own system-scoped context internally (it must: partner_users
  // is Shape-3 partner-axis RLS, invisible under the requester's org-scoped
  // context — the exact gap CRITICAL-2 exists to close), so resolving it here
  // avoids holding a pooled connection open across the round-trip (the #1105
  // connection-hold class — see apps/api/src/db/index.ts). On a genuine
  // idempotency conflict below, this resolved set is simply discarded —
  // cheap relative to the round-trip savings on the common (non-conflicting)
  // path.
  const eligibleAll = await resolveIntentApprovers(orgId);
  const eligibleApprovers = eligibleAll.filter((userId) => userId !== requesterId);
  const requesterEligible = eligibleAll.includes(requesterId);

  // Agent action-and-target eligibility (Task 3), resolved OUTSIDE the
  // transaction for the same connection-hold reasons as
  // resolveIntentApprovers above — both helpers manage their own
  // system-scoped contexts internally (runOutsideDbContext inside the
  // creation transaction would be actively wrong). Resolved for EVERY agent
  // intent, not just supervised ones, so a proposal citing a nonexistent
  // device is refused before anything is written, regardless of scope.
  let agentEligibleApprovers: string[] = [];
  if (agentRun) {
    let targetScope: IntentTargetScope;
    try {
      // orgId pins the device resolution to the intent's org (review finding
      // 1): a cross-tenant device id must fail exactly like a nonexistent one.
      // P2-2: the device the approvers are resolved against is the intent's
      // TARGET (explicit scope when present), never the run's own device — a
      // sweep run has none, and a scoped intent's approvers must be the humans
      // who can reach the SCOPED device's site.
      targetScope = await resolveIntentTargetScope(
        input.toolName,
        input.input,
        {
          deviceId: effectiveTargetDeviceId(
            resolveIntentTargetDevice(
              {
                scopeKind: scopeDeviceId ? 'device' : scopeTicketId ? 'ticket' : null,
                scopeDeviceId,
                scopeTicketId,
              },
              agentRun,
            ),
          ),
        },
        orgId,
      );
    } catch (err) {
      throw new ActionIntentError(
        err instanceof Error ? err.message : 'Agent intent target could not be resolved',
        'agent_target_invalid',
      );
    }
    agentEligibleApprovers = await resolveAgentIntentApprovers({
      orgId,
      toolName: input.toolName,
      input: input.input,
      targetScope,
    });
  }

  // ONE system-scoped transaction (durability): insert the intent row (or
  // detect an idempotent replay) AND, in the SAME transaction, fan out the
  // cross-user approval_requests and write the intent_created outbox row. The
  // child→parent FKs (approval_requests.intent_id, intent_outbox.intent_id →
  // action_intents.id) are satisfied within one transaction because a
  // transaction sees its own uncommitted parent row — so the historical
  // TX1(org)/TX2(system) split is gone. That split existed ONLY because the two
  // stages ran on separate pooled connections at different scopes (a genuinely
  // separate TX2 connection could not see TX1's uncommitted intent row, and
  // Postgres's FK check fails fast rather than waiting). Collapsing them means a
  // crash or fault anywhere between the insert and the outbox rolls the WHOLE
  // thing back: there is no longer a window where a committed pending_approval
  // intent is stranded with no approvers and no outbox row (the release worker
  // would never see it and no approver could ever decide it).
  //
  // Scope tradeoff (defense-in-depth): collapsing forces the intent INSERT out
  // of the caller's org-scoped RLS context and into system scope — you cannot
  // re-scope mid-transaction, and the approval_requests fan-out REQUIRES system
  // scope (Shape-6 user-scoped RLS: a row for an approver OTHER than the
  // requester denies with 42501 under the requester's org context; migration
  // 2026-05-16-approval-shape6-system-bypass.sql). This trades one layer of
  // defense-in-depth (org-access RLS re-checking the intent insert) for
  // atomicity. Mitigations: (a) app-layer authz (tier gating +
  // resolveWritableToolOrgId) is already complete above; (b) org_id comes from
  // the authenticated `auth`, never user input; (c) the release/decide paths
  // re-validate org access before anything executes; (d) intent_outbox and the
  // fan-out were already system-only, so the whole operation being
  // system-scoped is internally consistent. Cross-tenant READS remain denied —
  // RLS filters reads by org_id regardless of which scope inserted the row
  // (proven by createIntentAtomicity.integration.test.ts).
  let creation: CreationResult;
  try {
    creation = await withSystemDbAccessContext(async (): Promise<CreationResult> => {
      // Effect-digest pinning (tier3-supervised-four-eyes design §4.1,
      // effectDigest.ts) — SCOPE-INDEPENDENT: pinned whenever a resolver
      // exists, supervised as well as four_eyes. It used to be gated on
      // `approvalScope === 'four_eyes'`, which made effectDigest.ts's own
      // motivating resolver (run_script, a SUPERVISED tool) unreachable dead
      // code while leaving its ~10-minute release lease open to exactly the
      // script-body edit the module exists to catch. See effectDigest.ts's
      // header for the full rationale.
      //
      // Computed INSIDE this transaction, via the ambient `db` (same
      // connection/snapshot the insert below runs on), so the pinned content
      // and the row it's attached to are read/written atomically — no window
      // where a concurrent edit lands between "read the target" and "create
      // the intent".
      //
      // Only `pinned` stores a digest. `not_applicable` (no resolver — the
      // expected case for most tools) and `unresolved` (a resolver existed
      // but the id arg was missing or the target row was absent) both leave
      // effect_digest NULL, which both release paths treat as "nothing to
      // check", not a failure. The `unresolved` cases are audited after
      // commit — they are intents that SHOULD have been pinned and weren't.
      const effectDigestOutcome = await computeEffectDigestOutcome(input.toolName, input.input, db);
      const effectDigest = effectDigestOutcome.kind === 'pinned' ? effectDigestOutcome.digest : null;

      // Wave 5 Part A (#3827): resolved BEFORE the insert so it can be
      // stamped as part of the INSERT values, not a second UPDATE — see
      // resolvePolicyDecisionState's doc comment above for what it is (a
      // PR-A stub that always returns 'human_required') and what Part B
      // replaces. On the idempotent-replay path below (`!inserted`), this
      // computed value is simply discarded — the existing row keeps
      // whatever state it was ORIGINALLY stamped with, exactly like every
      // other content column on that path.
      const decisionState = resolvePolicyDecisionState({
        guardrail,
        approvalScope,
        agentRun,
        toolName: input.toolName,
        input: input.input,
        agentMode: agentRunMode,
        hasScope: input.scope !== undefined,
      });

      // P2-4 Task A3 (#4191) — the creation-transaction ticket-autonomy
      // decision. Evaluated here (INSIDE this transaction, via the ambient
      // `db` — the SAME connection/snapshot the insert below runs on) so it
      // can be baked directly into the insert's values rather than a
      // follow-up UPDATE, and so a concurrent policy flip cannot land
      // between "decide" and "insert". Short-circuits to `not_requested`
      // (near-zero cost) for the overwhelming majority of intents that never
      // asked for autonomy at all — see ticketAutonomy.ts's header.
      const autonomyDecision = await evaluateTicketAutonomy({
        requestedAutonomyKind: input.autonomy?.kind,
        principalKind: auth.principal.kind,
        agentRunId: agentRun?.id ?? null,
        orgId,
        scope: input.scope,
      });
      const autonomyGranted = autonomyDecision.granted;
      // A denial is never thrown — it's a breadcrumb on the row that still
      // proceeds down the ordinary human_required path. Only stamped when
      // autonomy was ACTUALLY requested (never for the ordinary case where
      // `input.autonomy` was never set at all, which would otherwise spam
      // `autonomyDenied: 'not_requested'` onto every unrelated intent).
      const autonomyResult: Record<string, unknown> | null =
        input.autonomy?.kind === 'ticket_autonomy' && !autonomyDecision.granted
          ? { autonomyDenied: autonomyDecision.reason }
          : null;

      const [inserted] = await db
        .insert(actionIntents)
        .values({
          orgId,
          partnerId: auth.partnerId ?? null,
          // Agent intents are requester-less by design (wave 3b): the run is
          // the attribution record, never the agent's synthetic user id.
          requestedByUserId: agentRun ? null : requesterId,
          requestingAgentRunId: agentRun?.id ?? null,
          // Record the ORIGIN principal as a fact, at the one moment it is
          // known for certain. Do NOT derive this later from `source` or from
          // which actor column is populated — see the column's doc comment.
          originPrincipalKind,
          originPrincipalId:
            auth.principal.kind === 'api_key'
              ? auth.principal.apiKeyId ?? null
              : auth.principal.kind === 'oauth_grant'
                ? auth.principal.grantId ?? null
                : agentRow
                  ? agentRow.id
                  : null,
          connectionId: input.binding?.connectionId ?? null,
          tenantId: input.binding?.tenantId ?? null,
          // P2-2/P2-4 typed target scope. Immutable except for the non-null
          // -> NULL tombstone the device-delete FK / moveOrg detach (device)
          // and the `manage_tickets:move_org` executor detach (ticket)
          // produce; every reader resolves through `resolveIntentTargetDevice`
          // / `resolveIntentTargetTicket`.
          scopeKind: scopeDeviceId ? ('device' as const) : scopeTicketId ? ('ticket' as const) : null,
          scopeDeviceId,
          scopeTicketId,
          source: input.source,
          requestingClientLabel,
          actionName: input.toolName,
          arguments: input.input,
          argumentDigest,
          targetSummary,
          impactSummary,
          reason: input.reason ?? null,
          riskTier: guardrail.tier,
          idempotencyKey,
          correlationId: randomUUID(),
          approvalScope,
          classificationVersion: CLASSIFICATION_VERSION,
          effectDigest,
          policyDecisionState: decisionState,
          // `expiresAt` is the legacy column the pre-split reaper still reads;
          // `approvalExpiresAt` is the new Task-2 column the post-split reaper
          // reads. Dual-write the SAME value to both for rolling-upgrade
          // compat during the deploy window where old and new API instances
          // run side by side. Remove the `expiresAt` write (Plan 3 cleanup,
          // once the reaper and every other legacy reader have migrated to
          // approvalExpiresAt).
          expiresAt,
          approvalExpiresAt: expiresAt,
          // P2-4 Task A3 (#4191): a granted ticket-autonomy decision is
          // baked directly into the insert, exactly like `runAuthorizeTransaction`
          // (policyDecide.ts) stamps a policy-decided row — `decidedByUserId:
          // null` because no human decided this, `releaseBy` the SAME
          // fixed-lease shape every approved intent gets. Every field here
          // stays at its column default (status 'pending_approval', the rest
          // null) when autonomy was not granted.
          ...(autonomyGranted
            ? {
              status: 'approved' as const,
              decidedVia: 'ticket_autonomy',
              decidedAt: new Date(),
              decidedByUserId: null,
              releaseBy: new Date(Date.now() + RELEASE_LEASE_MS),
            }
            : {}),
          result: autonomyResult,
        })
        // IMPORTANT-4: action_intents_org_idem_uniq is now a PARTIAL unique
        // index (migration 2026-07-18-action-intents.sql) covering only LIVE
        // statuses — a terminal intent must not block a legitimate future
        // identical request. The conflict target's `where` must match the
        // index predicate exactly (LIVE_INTENT_STATUSES) or Postgres can't
        // infer which index to use and raises "no unique or exclusion
        // constraint matching the ON CONFLICT specification".
        .onConflictDoNothing({
          target: [actionIntents.orgId, actionIntents.idempotencyKey],
          where: inArray(actionIntents.status, LIVE_INTENT_STATUSES),
        })
        .returning();

      if (!inserted) {
        // Idempotent replay: converge on the existing LIVE row instead of
        // creating a duplicate (spec §4 step 3 / §13). No new fan-out, no new
        // outbox row — the retry is a no-op beyond returning what already
        // exists. The approver set resolved above is simply unused on this path.
        // Filtered to LIVE_INTENT_STATUSES (not just org_id+idempotency_key)
        // because IMPORTANT-4 means multiple rows can now share the same key —
        // at most one LIVE at a time (which is exactly what the conflict fired
        // against) plus any number of prior terminal ones; an unfiltered select
        // with no ORDER BY could nondeterministically return a stale terminal
        // row instead.
        const [existing] = await db
          .select()
          .from(actionIntents)
          .where(
            and(
              eq(actionIntents.orgId, orgId),
              eq(actionIntents.idempotencyKey, idempotencyKey),
              inArray(actionIntents.status, LIVE_INTENT_STATUSES),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new ActionIntentError(
            'Insert conflicted on (org_id, idempotency_key) but no existing live row was found',
            'idempotency_race',
          );
        }
        // Review major 4: a key collision is only a replay when it is the
        // SAME logical request. Action name, source, run attribution, and the
        // argument digest must all match — otherwise returning the row would
        // hand this caller an intent belonging to someone else (for agents:
        // another run, whose immutably-attributed policy snapshot the release
        // path would then evaluate). The actionName check matters when the
        // caller supplies an EXPLICIT key: two different tools can share a
        // key AND a byte-identical canonical argument shape (e.g. both take
        // only {deviceId}), and treating tool B as a replay of tool A would
        // silently drop proposal B (review finding 2).
        if (
          existing.actionName !== input.toolName ||
          existing.source !== input.source ||
          (existing.requestingAgentRunId ?? null) !== (agentRun?.id ?? null) ||
          existing.argumentDigest !== argumentDigest
        ) {
          throw new ActionIntentError(
            'Idempotency key already belongs to a different live request (action/source/run/arguments mismatch)',
            'idempotency_conflict',
          );
        }
        const approvalRows = await db
          .select({ id: approvalRequests.id, userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, existing.id));
        return {
          intent: existing,
          approvalRequestIds: approvalRows.map((r) => r.id),
          requesterApprovalRequestId:
            approvalRows.find((r) => r.userId === requesterId)?.id ?? null,
          fanOutUserIds: [],
          isNew: false,
          effectDigestOutcome,
        };
      }

      // New intent: fan out the cross-user approval_requests (deferred behind
      // the policy-decision state — Wave 5 Part A, #3827) and write the
      // intent_created outbox row, all in this same transaction.
      //
      // decisionState is the PR-A stub's fixed output ('human_required'), so
      // this branch is ALWAYS taken today and runHumanFanout is a verbatim
      // extraction of what used to run inline here unconditionally — the
      // full intentService + approvals suites passing unchanged is the
      // inertness proof. Once Part B's real resolvePolicyDecisionState can
      // return 'authorized', this becomes the seam that skips fan-out
      // entirely for a policy-decided intent.
      let approvalRequestIds: string[] = [];
      let requesterApprovalRequestId: string | null = null;
      let fanOutUserIds: string[] = [];
      let finalIntent: ActionIntent = inserted;

      // P2-4 Task A3 (#4191): a granted ticket-autonomy decision skips the
      // human fan-out entirely, same as the (not-yet-reachable-here)
      // policy-authorized case would — no approval_requests rows, no
      // approver notification.
      if (!autonomyGranted && decisionState === 'human_required') {
        ({ approvalRequestIds, requesterApprovalRequestId, fanOutUserIds, finalIntent } =
          await runHumanFanout({
            db,
            inserted,
            toolName: input.toolName,
            actionArguments: input.input,
            argumentDigest,
            requestingClientLabel,
            targetSummary,
            riskTier,
            impactSummary,
            expiresAt,
            agentRun,
            approvalScope,
            eligibleApprovers,
            agentEligibleApprovers,
            requesterEligible,
            requesterId,
          }));
      }

      // Outbox insert is unconditional — unchanged regardless of
      // decisionState (PR-B pointer: intentReleaseWorker.ts's intent_created
      // no-op branch is where a policy-authorized intent's outbox row is
      // eventually consumed differently; not touched in this PR).
      await db.insert(intentOutbox).values({
        intentId: inserted.id,
        eventType: 'intent_created',
        // Ids only, no argument content (spec §3.2).
        payload: { intentId: inserted.id, orgId },
      });

      // P2-4 Task A3 (#4191): a granted ticket-autonomy decision ALSO
      // enqueues the SAME durable release job the human-approve path
      // enqueues (`decideApprovalRequest.ts`) / policy-decide's own
      // authorize transaction enqueues (`policyDecide.ts`'s
      // `runAuthorizeTransaction`) — reused verbatim so crash-recovery
      // replays it: `intentReleaseWorker.ts`'s `intent_approved` branch
      // releases this intent regardless of `decidedVia`, unmodified by this
      // task. The `intent_created` row above is a SECOND, independent
      // recovery path for the same release (see that worker's
      // `data.eventType === 'intent_created'` branch, widened by this task
      // to release directly for a `decidedVia: 'ticket_autonomy'` row
      // instead of calling `attemptPolicyDecision`) — a backstop in case
      // this row's own publish is ever the one that gets stuck.
      if (autonomyGranted) {
        await db.insert(intentOutbox).values({
          intentId: inserted.id,
          eventType: 'intent_approved',
          payload: { intentId: inserted.id, orgId },
        });
      }

      return {
        intent: finalIntent,
        approvalRequestIds,
        requesterApprovalRequestId,
        fanOutUserIds,
        isNew: true,
        effectDigestOutcome,
      };
    });
  } catch (err) {
    // One transaction ⇒ any throw already rolled the intent insert back with
    // the fan-out/outbox; there is no committed row to mark 'failed' (the
    // pre-collapse best-effort transitionIntent(...,'failed') is gone with the
    // split). Preserve a deliberate ActionIntentError (e.g. the idempotency_race
    // edge) verbatim so its distinct code survives; wrap anything else (a real
    // DB/RLS fault in the insert, fan-out, or outbox) as fanout_failed so the
    // caller (chat SDK / MCP) sees a real failure, never a false success.
    if (err instanceof ActionIntentError) throw err;
    console.error('[intentService] action intent creation transaction failed (rolled back):', err);
    throw new ActionIntentError(
      'Failed to create action intent (approval fan-out / outbox)',
      'fanout_failed',
    );
  }

  // A replay returns the existing snapshot without push/audit (both gated on
  // isNew below); the final `return toSnapshot(...)` covers it identically to
  // the new-intent path.

  // Wave 5 Part B (#3827): a freshly `'unattempted'` intent has no fan-out to
  // notify (runHumanFanout above was skipped entirely) — instead, kick off
  // the policy-decide attempt AFTER the creation transaction has committed
  // (never inside it: the attempt does its own DB work under its own
  // transaction). Fire-and-forget by design (see triggerPolicyDecisionAttempt's
  // doc comment) — the caller (chat SDK / MCP / agent run loop) gets back the
  // `pending_approval` snapshot exactly as it always did; the attempt's
  // outcome surfaces later via the intent's own state, not this call's return
  // value.
  // `!input.scope` is belt-and-braces, not redundancy with taste: a scoped
  // intent cannot BE 'unattempted' (resolvePolicyDecisionState forces
  // human_required for it — spec §4.2 amendment, #4189), so this second
  // condition only fires if that invariant is ever broken upstream. It is
  // cheap, and the failure it guards against is a sweep proposal
  // auto-executing.
  if (creation.isNew && !input.scope && creation.intent.policyDecisionState === 'unattempted') {
    triggerPolicyDecisionAttempt(creation.intent.id);
  }

  // Best-effort push AFTER the creation transaction commits (#1105) — never
  // hold a DB transaction open across the push network round-trip. Token
  // reads happen inside a fresh context per approver; the sends happen after.
  // Supervised HUMAN intents never push: the sole row belongs to the
  // requester themselves, who is already looking at the chat/MCP response
  // that created it. Agent intents notify at EVERY scope (wave 3b): the
  // proposal is headless — nobody is watching a chat pane, so without this
  // widened gate a supervised agent proposal would notify NOBODY (gap 4).
  // An `'unattempted'` intent has empty approvalRequestIds/fanOutUserIds
  // (fan-out was skipped), so this loop naturally no-ops for it without any
  // extra gating — see notifyFannedOutApprovers.
  if (
    creation.isNew &&
    creation.intent.status === 'pending_approval' &&
    (creation.intent.approvalScope === 'four_eyes' || creation.intent.source === 'ai_agent')
  ) {
    await notifyFannedOutApprovers({
      orgId,
      intentId: creation.intent.id,
      approvalRequestIds: creation.approvalRequestIds,
      fanOutUserIds: creation.fanOutUserIds,
      requestingClientLabel,
      targetSummary,
      dbContext,
    });
  }

  // An intent that SHOULD have been pinned but wasn't (a resolver exists for
  // this tool/action, but the id argument was missing or the target row was
  // absent/soft-deleted) is indistinguishable from "no resolver at all" once
  // it hits the column — all three store NULL, and both release paths read
  // NULL as "nothing to check". Emitting the reason here is the only thing
  // that makes those two silent cases countable and alertable; without it, a
  // surface that quietly stopped being pinnable leaves no trace anywhere.
  // Gated on isNew: a replay recomputes the same outcome for a row that
  // already emitted this once.
  // Agent creations are audited as the AGENT (actorType 'ai_agent', no
  // actorId — the synthetic user id must never masquerade as a person),
  // carrying the agent/run ids in details (gap 13).
  const auditActor = agentRun
    ? { actorType: 'ai_agent' as const }
    : { actorId: requesterId };
  const agentAuditDetails = agentRun && agentRow
    ? { agentId: agentRow.id, agentRunId: agentRun.id }
    : {};

  if (creation.isNew && creation.effectDigestOutcome.kind === 'unresolved') {
    recordActionIntentEvent({
      orgId,
      intentId: creation.intent.id,
      actionName: input.toolName,
      argumentDigest,
      source: input.source,
      outcome: 'effect_digest_unpinned',
      ...auditActor,
      details: {
        reason: creation.effectDigestOutcome.reason,
        approvalScope,
        ...agentAuditDetails,
      },
    });
  }

  if (creation.isNew) {
    const cancelledForNoApprovers = creation.intent.status === 'cancelled';
    recordActionIntentEvent({
      orgId,
      intentId: creation.intent.id,
      actionName: input.toolName,
      argumentDigest,
      source: input.source,
      outcome: cancelledForNoApprovers ? 'cancelled' : 'created',
      ...auditActor,
      details: cancelledForNoApprovers
        ? { errorCode: creation.intent.errorCode ?? 'no_eligible_approvers', ...agentAuditDetails }
        : {
          approverCount: creation.approvalRequestIds.length,
          // Gated on four_eyes: supervised intents always have exactly one
          // fan-out row owned by the requester (the short-circuit at line
          // ~530), but that is the *normal* supervised shape, not a
          // four_eyes sole-operator L3 self-approval — `soleOperator: true`
          // must keep meaning the latter, or it pollutes the sole-operator
          // audit signal with every supervised creation.
          soleOperator:
            approvalScope === 'four_eyes' &&
            creation.fanOutUserIds.length === 1 &&
            creation.fanOutUserIds[0] === requesterId,
          ...agentAuditDetails,
        },
    });
  }

  return toSnapshot(creation.intent, creation.approvalRequestIds, creation.requesterApprovalRequestId, creation.fanOutUserIds);
}

// ---------------------------------------------------------------------------
// runDeferredHumanFanout — the human-fallback degrade path (wave 5 Part B, #3827)
// ---------------------------------------------------------------------------

/** Mirrors createActionIntent's own tier→riskTier mapping (line ~666 above) —
 *  kept as a private one-liner rather than a shared export because the two
 *  call sites take DIFFERENT inputs (a live `GuardrailCheck.tier` at creation
 *  vs. a persisted `action_intents.risk_tier` column here) and the shared
 *  formula is a single ternary, not enough surface to be worth a public seam. */
function riskTierLabel(tier: number): 'medium' | 'high' | 'critical' {
  return tier >= 4 ? 'critical' : tier >= 3 ? 'high' : 'medium';
}

/**
 * The `unattempted → human_required` degrade path (wave 5 Part B, #3827):
 * `attemptPolicyDecision` (policyDecide.ts) calls this for every DETERMINISTIC
 * reason a policy decision cannot authorize an intent (key not registry-
 * decidable, not agent-authorized, guardrail/kill denial, caps exhausted, or
 * the intent expired before an attempt landed). It re-derives the SAME
 * approver pool and produces the SAME approval_requests rows + notifications
 * `runHumanFanout` would have produced at creation time, had the stub (or a
 * flag-off `resolvePolicyDecisionState`) sent this intent straight to
 * `'human_required'` in the first place — the agent's proposal still gets a
 * human decision, just a turn late.
 *
 * CAS-guarded (`policyDecisionState: 'unattempted' -> 'human_required'`,
 * inside the SAME transaction as the fan-out) against double-attempt: the
 * post-commit fire-and-forget trigger and the outbox `intent_created`
 * recovery branch can both reach this for the same intent. Whichever call
 * wins the CAS performs the fan-out; the loser's `db.update(...).returning()`
 * comes back empty and this function returns having written nothing and
 * notified nobody — exactly the "no double-fanout" property the plan's
 * design-authority section requires.
 *
 * No-op (silently) when the intent no longer exists, is not agent-originated,
 * or the CAS is lost — every one of those is "someone/something else already
 * has this intent," never a caller error to surface.
 */
export async function runDeferredHumanFanout(intentId: string): Promise<void> {
  // Pre-transaction reads (system-scoped; released before opening the write
  // transaction below — #1105): the intent + its run, so the eligible-approver
  // resolvers (which manage their own system contexts and must NOT be called
  // from inside a held transaction) can run first, exactly like
  // createActionIntent itself does.
  const loaded = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
      if (!intent || !intent.requestingAgentRunId) return null;
      const [run] = await db
        .select({
          id: aiAgentRuns.id,
          agentId: aiAgentRuns.agentId,
          orgId: aiAgentRuns.orgId,
          deviceId: aiAgentRuns.deviceId,
        })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, intent.requestingAgentRunId))
        .limit(1);
      if (!run || run.orgId !== intent.orgId) return null;
      return { intent, run };
    }),
  );
  if (!loaded) return;
  const { intent, run } = loaded;

  let targetScope: IntentTargetScope;
  try {
    // P2-2: same resolver as the creation fan-out — a scoped intent's
    // approvers are the humans who can reach the SCOPED device, and the run's
    // own device (null for a sweep) is never consulted. A tombstoned scope
    // collapses to `deviceId: null`, which falls through to the fail-closed
    // 'indirect' rule below exactly like an unresolvable device does.
    targetScope = await resolveIntentTargetScope(
      intent.actionName,
      intent.arguments as Record<string, unknown>,
      { deviceId: effectiveTargetDeviceId(resolveIntentTargetDevice(intent, run)) },
      intent.orgId,
    );
  } catch {
    // A cited device that no longer exists (deleted/moved since the intent
    // was proposed): fail closed to the same 'indirect' rule
    // resolveIntentTargetScope itself uses for an unresolvable target — only
    // site-unrestricted approvers qualify, never "nobody at all can decide."
    targetScope = { kind: 'indirect' };
  }

  const agentEligibleApprovers = await resolveAgentIntentApprovers({
    orgId: intent.orgId,
    toolName: intent.actionName,
    input: intent.arguments as Record<string, unknown>,
    targetScope,
  });

  // `deviceId` here is inert for targeting — AgentRunRef carries it, but the
  // fan-out reads only `agentRun.id` (and its truthiness). The TARGET device
  // was resolved above, through resolveIntentTargetDevice.
  const agentRun: AgentRunRef = { id: run.id, agentId: run.agentId, orgId: run.orgId, deviceId: run.deviceId };

  const fanoutResult = await withSystemDbAccessContext(async (): Promise<HumanFanoutResult | null> => {
    // The CAS: only the caller that actually flips unattempted -> human_required
    // gets to fan out. `.returning()` empty means a concurrent caller already
    // won (or the intent moved on some other way) — this transaction commits
    // having written nothing.
    const [updated] = await db
      .update(actionIntents)
      .set({ policyDecisionState: 'human_required' })
      .where(and(eq(actionIntents.id, intentId), eq(actionIntents.policyDecisionState, 'unattempted')))
      .returning();
    if (!updated) return null;

    return runHumanFanout({
      db,
      inserted: updated,
      toolName: updated.actionName,
      actionArguments: updated.arguments as Record<string, unknown>,
      argumentDigest: updated.argumentDigest,
      requestingClientLabel: updated.requestingClientLabel ?? 'AI Agent',
      targetSummary: updated.targetSummary,
      riskTier: riskTierLabel(updated.riskTier),
      impactSummary: updated.impactSummary,
      // The SAME deadline creation stamped — not a freshly recomputed one; a
      // punted-to-human intent keeps whatever approval window it always had,
      // it does not get a new one for having been attempted first.
      expiresAt: updated.approvalExpiresAt ?? updated.expiresAt,
      agentRun,
      approvalScope: updated.approvalScope,
      // resolvePolicyDecisionState only ever admits approvalScope ===
      // 'supervised' into 'unattempted' — the four_eyes pool is structurally
      // unreachable here, but threaded through (empty) so runHumanFanout's
      // signature doesn't need a narrower agent-only variant.
      eligibleApprovers: [],
      agentEligibleApprovers,
      requesterEligible: false,
      // Agent-originated intents are requester-less by construction
      // (requestedByUserId is NULL) — runHumanFanout's `agentRun` branch
      // never reads this value, but the field is non-optional on
      // HumanFanoutArgs so a placeholder is threaded through rather than
      // widening that type for one caller.
      requesterId: '',
    });
  });
  if (!fanoutResult) return;

  if (fanoutResult.finalIntent.status === 'cancelled') {
    // Same audit shape as createActionIntent's own no-eligible-approver
    // branch — this IS that branch, reached a turn later.
    recordActionIntentEvent({
      orgId: intent.orgId,
      intentId: intent.id,
      actionName: intent.actionName,
      argumentDigest: intent.argumentDigest,
      source: intent.source,
      outcome: 'cancelled',
      actorType: 'ai_agent',
      details: {
        errorCode: fanoutResult.finalIntent.errorCode ?? 'no_eligible_approvers',
        agentId: run.agentId,
        agentRunId: run.id,
      },
    });
    return;
  }

  await notifyFannedOutApprovers({
    orgId: intent.orgId,
    intentId: intent.id,
    approvalRequestIds: fanoutResult.approvalRequestIds,
    fanOutUserIds: fanoutResult.fanOutUserIds,
    requestingClientLabel: intent.requestingClientLabel ?? 'AI Agent',
    targetSummary: intent.targetSummary,
    dbContext: { scope: 'organization', orgId: intent.orgId, accessibleOrgIds: [intent.orgId], userId: null },
  });
}

// ---------------------------------------------------------------------------
// getActionIntent
// ---------------------------------------------------------------------------

export async function getActionIntent(auth: AuthContext, intentId: string): Promise<ActionIntentSnapshot | null> {
  const dbContext = dbAccessContextFromAuth(auth);
  return withDbAccessContext(dbContext, async () => {
    const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    if (!intent) return null;
    const approvalRows = await db
      .select({ id: approvalRequests.id, userId: approvalRequests.userId })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intent.id));
    // Caller-derived, matching the sibling derivation in the idempotent-replay
    // path (`r.userId === requesterId`). The field's contract is "the approval
    // row YOU may self-approve", so it must key on the caller — keying on
    // intent.requestedByUserId would hand an approver looking at somebody
    // else's intent a row id that is not theirs to decide.
    const callerId = auth.user.id;
    return toSnapshot(
      intent,
      approvalRows.map((r) => r.id),
      approvalRows.find((r) => r.userId === callerId)?.id ?? null,
    );
  });
}

// ---------------------------------------------------------------------------
// cancelActionIntent
// ---------------------------------------------------------------------------

export async function cancelActionIntent(
  auth: AuthContext,
  intentId: string,
): Promise<{ ok: boolean; status: ActionIntentStatus }> {
  const dbContext = dbAccessContextFromAuth(auth);
  const intent = await withDbAccessContext(dbContext, async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row ?? null;
  });
  if (!intent) {
    throw new ActionIntentNotFoundError(intentId);
  }

  // Requester-or-approver only (spec §6.2). For an agent-originated intent
  // requestedByUserId is NULL, so this deliberately collapses to "any
  // approvals:decide holder in the org" — a human can dismiss an agent
  // proposal without approving it (owner decision 2026-08-23, wave 3b).
  const isRequester = intent.requestedByUserId === auth.user.id;
  let isApprover = false;
  if (!isRequester) {
    const perms = await getUserPermissions(auth.user.id, { orgId: intent.orgId });
    isApprover = !!perms && userCanDecideApprovals(perms);
  }
  if (!isRequester && !isApprover) {
    throw new ActionIntentAuthorizationError(`Not authorized to cancel action intent ${intentId}`);
  }

  const ok = await transitionIntent(intentId, ['pending_approval', 'approved'], 'cancelled');
  if (ok) {
    return { ok: true, status: 'cancelled' };
  }

  const current = await withDbAccessContext(dbContext, async () => {
    const [row] = await db.select({ status: actionIntents.status }).from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return row?.status ?? intent.status;
  });
  return { ok: false, status: current };
}

// ---------------------------------------------------------------------------
// transitionIntent — the CAS primitive (spec §3.4)
// ---------------------------------------------------------------------------

/**
 * Which deadline column governs an intent in a given status. A tier-3 intent
 * lives under TWO successive deadlines and they are not interchangeable:
 *
 *  - `pending_approval` is bounded by `approval_expires_at` — how long a human
 *    has to decide.
 *  - `approved` / `executing` are bounded by `release_by` — the fixed
 *    RELEASE_LEASE_MS lease stamped at approval time. `approval_expires_at`
 *    stops applying the moment an intent is approved (the "59:59 trap" —
 *    jobs/intentExpiryReaper.ts's header).
 *
 * Terminal statuses have no live deadline at all, which is why they are absent
 * here rather than mapped to something arbitrary: asking for an expiry check
 * on a terminal `from` list is a caller bug, and transitionIntent throws.
 */
export type IntentDeadlinePhase = 'approval' | 'release';

const DEADLINE_PHASE_BY_STATUS: Partial<Record<ActionIntentStatus, IntentDeadlinePhase>> = {
  pending_approval: 'approval',
  approved: 'release',
  executing: 'release',
};

/**
 * `UPDATE ... WHERE id = $1 AND status IN (...from)`. Zero rows affected
 * (lost race / already-terminal / wrong starting state) returns `false`,
 * never throws — callers re-read on a lost race. Runs under system scope so
 * it works regardless of the caller's ambient context (decide handler,
 * release worker, reaper); `withDbAccessContext` no-ops into an ALREADY
 * active caller context rather than re-scoping it, which is fine here since
 * `breeze_has_org_access` also authorizes system scope.
 *
 * `opts.requireNotExpired` names WHICH deadline to fold into the CAS. It used
 * to be a plain `boolean` that unconditionally applied the RELEASE deadline
 * regardless of the `from` status — correct only by the accident that both
 * callers pass `from: 'approved'`. A caller passing `from: 'pending_approval'`
 * would have silently checked the wrong column. `true` is still accepted as a
 * deprecated alias for `'release'` so the two call sites in files owned
 * elsewhere (jobs/intentReleaseWorker.ts, services/aiAgentSdk.ts) keep
 * compiling; both should move to `'release'`.
 *
 * Misuse is rejected loudly: the requested phase must be the phase EVERY
 * status in `from` lives under. A mixed-phase list (e.g.
 * `['pending_approval','approved']`) has no single correct deadline column and
 * throws rather than picking one.
 */
export async function transitionIntent(
  intentId: string,
  from: ActionIntentStatus | ActionIntentStatus[],
  to: ActionIntentStatus,
  patch?: ActionIntentTransitionPatch,
  opts?: { requireNotExpired?: IntentDeadlinePhase | boolean },
): Promise<boolean> {
  const fromList = Array.isArray(from) ? from : [from];

  // Resolve + validate BEFORE opening the DB context so a caller bug throws
  // without ever taking a pooled connection.
  let deadlineCondition: ReturnType<typeof sql> | null = null;
  if (opts?.requireNotExpired) {
    const requested: IntentDeadlinePhase =
      opts.requireNotExpired === true ? 'release' : opts.requireNotExpired;
    const fromPhases = new Set(fromList.map((status) => DEADLINE_PHASE_BY_STATUS[status]));
    if (fromPhases.size !== 1 || !fromPhases.has(requested)) {
      throw new ActionIntentError(
        `requireNotExpired: '${requested}' is not the deadline phase governing from-status(es) ` +
          `[${fromList.join(', ')}] — pending_approval is bounded by approval_expires_at, ` +
          `approved/executing by release_by, and terminal statuses by neither`,
        'invalid_deadline_phase',
      );
    }
    // Folds the deadline into the CAS predicate so a claim is atomic with the
    // intent still being live. Without it, an intent approved just before its
    // deadline could be claimed approved -> executing in the window before the
    // 30s expiry reaper terminalizes it, executing an action whose
    // authorization window has already closed. Uses the DB clock (now())
    // rather than a JS timestamp so the comparison is against the same clock
    // that stamped the deadline.
    //
    // Both branches keep their COALESCE fallback to `expires_at` on purpose:
    // that is the rolling-upgrade mechanism for rows written by an older
    // instance that only ever populated `expires_at` (release_by /
    // approval_expires_at are both post-split columns). Do not remove it.
    deadlineCondition =
      requested === 'release'
        ? sql`COALESCE(${actionIntents.releaseBy}, ${actionIntents.expiresAt}) > now()`
        : sql`COALESCE(${actionIntents.approvalExpiresAt}, ${actionIntents.expiresAt}) > now()`;
  }

  return withSystemDbAccessContext(async () => {
    const conditions = [eq(actionIntents.id, intentId), inArray(actionIntents.status, fromList)];
    if (deadlineCondition) conditions.push(deadlineCondition);
    const rows = await db
      .update(actionIntents)
      .set({ status: to, ...patch })
      .where(and(...conditions))
      .returning({ id: actionIntents.id });
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// waitForIntentDecision — chat SDK's blocking poll (spec §6.1)
// ---------------------------------------------------------------------------

/**
 * Mirrors `aiAgent.ts`'s `waitForApproval` poll/backoff loop (500ms initial
 * interval, ×1.5 backoff capped at 3s, abort-signal aware, system-scoped
 * reads) but polls `action_intents.status` instead of
 * `ai_tool_executions.status`, and returns the STATUS itself rather than a
 * boolean.
 *
 * Unlike `waitForApproval`, this function never writes anything — a timeout
 * simply returns the last-read status (almost always still
 * `pending_approval`) and leaves the intent row untouched. That is the whole
 * point of the durable design (spec §6.1): the caller (chat SDK) can give up
 * waiting without cancelling the intent, and an approver can still decide it
 * — and the release worker (`jobs/intentReleaseWorker.ts`) will execute it —
 * after this session has moved on or died.
 *
 * Returns as soon as the status leaves `pending_approval` (any of
 * approved/executing/completed/failed/rejected/expired/cancelled), so a
 * caller only needs to special-case `pending_approval` to detect "still
 * waiting" vs. "a decision (or a worker) already moved this."
 */
export async function waitForIntentDecision(
  intentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ActionIntentStatus> {
  const startTime = Date.now();
  let pollInterval = 500;
  let lastStatus: ActionIntentStatus = 'pending_approval';

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) return lastStatus;

    try {
      const [row] = await withSystemDbAccessContext(() =>
        db
          .select({ status: actionIntents.status })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId))
          .limit(1),
      );

      if (!row) return lastStatus;
      lastStatus = row.status;
      if (lastStatus !== 'pending_approval') return lastStatus;
    } catch (err) {
      console.error(`[intentService] waitForIntentDecision poll error for intent ${intentId}:`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 3000);
  }

  return lastStatus;
}
