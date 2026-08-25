import { randomUUID, createHash } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AssuranceLevel } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';
import {
  actionIntents,
  intentOutbox,
  type ActionIntent,
  type ActionIntentApprovalScope,
  type ActionIntentOriginPrincipalKind,
  type ActionIntentSource,
  type ActionIntentStatus,
} from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
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

/** Statuses the partial `action_intents_org_idem_uniq` index dedupes on
 * (IMPORTANT-4 — migration 2026-07-18-action-intents.sql). Kept as a single
 * source of truth for both the onConflictDoNothing target predicate and the
 * idempotent-replay re-select below, so the two can never drift apart. */
const LIVE_INTENT_STATUSES: readonly ActionIntentStatus[] = ['pending_approval', 'approved', 'executing'];

// Action intents & durable approval layer — core intent service (spec
// docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
// §4, §7). Creates a digest-bound intent, fans it out to eligible approvers,
// and provides the CAS primitive later tasks (decide handler, release worker,
// reaper) use to move it through its state machine.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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

function deriveIdempotencyKey(actorId: string, actionName: string, digest: string): string {
  return createHash('sha256').update(`${actorId}:${actionName}:${digest}`).digest('hex');
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
  // Captured here, at the top level, on purpose: TypeScript discards property
  // narrowing inside the transaction closure below, so reading
  // `auth.principal.kind` at the insert site would widen the type back out.
  const originPrincipalKind: ActionIntentOriginPrincipalKind = auth.principal.kind;

  const guardrail = checkGuardrails(input.toolName, input.input);
  if (!guardrail.allowed || guardrail.tier >= 4) {
    throw new ActionIntentTierError(
      `Tool "${input.toolName}" is not permitted on the action-intent path: ${guardrail.reason ?? 'blocked'}`,
      'tool_blocked',
      guardrail.tier,
    );
  }
  if (guardrail.tier <= 2) {
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
  const requesterId = auth.user.id;
  // Tier-3 supervised/four_eyes classification (Task 1's checkGuardrails).
  // Pre-existing tools that haven't been classified yet (approvalScope
  // absent) fall back to four_eyes — the stricter, pre-split behavior — never
  // the weaker supervised path. Mirrors the column's own DEFAULT 'four_eyes'
  // (migration 2026-08-14-intent-approval-scope-and-deadlines.sql).
  const approvalScope: ActionIntentApprovalScope = guardrail.approvalScope ?? 'four_eyes';

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
  let agentRun: {
    id: string;
    agentId: string;
    orgId: string;
    deviceId: string | null;
  } | null = null;
  let agentRow: { id: string; name: string } | null = null;
  if (auth.principal.kind === 'ai_agent') {
    const principal = auth.principal;
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
        return { run, agent, deviceSiteId };
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

    // Re-verify the verdict from the run's own policy snapshot. deviceId and
    // deviceSiteId come from the RUN row, never from tool input (Task 3:
    // isAgentGuardrailPolicy rejects an absent deviceId, so it must be
    // populated explicitly — a malformed snapshot fails validation inside
    // checkAgentGuardrails and denies, which is the fail-closed shape we
    // want, hence the cast instead of a hand-rolled validator here).
    const effective = loaded.run.policySnapshot?.effective;
    const verdict = checkAgentGuardrails(input.toolName, input.input, {
      enabled: effective?.enabled,
      mode: effective?.mode,
      toolAllowlist: effective?.toolAllowlist,
      protectedResources: effective?.protectedResources,
      deviceId: loaded.run.deviceId ?? null,
      deviceSiteId: loaded.deviceSiteId,
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
    ?? deriveIdempotencyKey(agentRun ? agentRun.id : requesterId, input.toolName, argumentDigest);
  const targetSummary = buildTargetSummary(input.toolName, input.input);
  const impactSummary = buildImpactSummary(input.toolName, guardrail);
  const expiresAt = computeExpiresAt(input.source, approvalScope);
  const requestingClientLabel = input.requestingClientLabel
    ?? (agentRow ? agentRow.name : input.source === 'chat' ? 'Breeze AI' : 'MCP API client');
  // Tier → riskTier mapping mirrors aiAgentSdk.ts's mobile-approval bridge.
  // Tier is always 3 by the time we reach here (T4 refused, T<=2 rejected
  // above), but computed generically for forward-compat.
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
      targetScope = await resolveIntentTargetScope(
        input.toolName,
        input.input,
        { deviceId: agentRun.deviceId },
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
          // `expiresAt` is the legacy column the pre-split reaper still reads;
          // `approvalExpiresAt` is the new Task-2 column the post-split reaper
          // reads. Dual-write the SAME value to both for rolling-upgrade
          // compat during the deploy window where old and new API instances
          // run side by side. Remove the `expiresAt` write (Plan 3 cleanup,
          // once the reaper and every other legacy reader have migrated to
          // approvalExpiresAt).
          expiresAt,
          approvalExpiresAt: expiresAt,
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

      // New intent: fan out the cross-user approval_requests and write the
      // intent_created outbox row, all in this same transaction.
      let approvalRequestIds: string[] = [];
      let requesterApprovalRequestId: string | null = null;
      let fanOutUserIds: string[] = [];

      const approvalRowFor = (userId: string) => ({
        userId,
        requestingClientLabel,
        actionLabel: targetSummary,
        actionToolName: input.toolName,
        actionArguments: input.input,
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
        const rows = await db
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
          const rows = await db
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
        const rows = await db
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
        const [cancelled] = await db
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

      await db.insert(intentOutbox).values({
        intentId: inserted.id,
        eventType: 'intent_created',
        // Ids only, no argument content (spec §3.2).
        payload: { intentId: inserted.id, orgId },
      });

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

  // Best-effort push AFTER the creation transaction commits (#1105) — never
  // hold a DB transaction open across the push network round-trip. Token
  // reads happen inside a fresh context per approver; the sends happen after.
  // Supervised HUMAN intents never push: the sole row belongs to the
  // requester themselves, who is already looking at the chat/MCP response
  // that created it. Agent intents notify at EVERY scope (wave 3b): the
  // proposal is headless — nobody is watching a chat pane, so without this
  // widened gate a supervised agent proposal would notify NOBODY (gap 4).
  if (
    creation.isNew &&
    creation.intent.status === 'pending_approval' &&
    (creation.intent.approvalScope === 'four_eyes' || creation.intent.source === 'ai_agent')
  ) {
    for (let i = 0; i < creation.approvalRequestIds.length; i++) {
      const approvalId = creation.approvalRequestIds[i];
      const userId = creation.fanOutUserIds[i];
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
            metadata: { approvalId, intentId: creation.intent.id },
            // Survives outbox/BullMQ redelivery: one approver, one intent, one
            // row in the bell.
            dedupeKey: `intent-approval:${creation.intent.id}`,
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
            `(intent=${creation.intent.id} approval=${approvalId} user=${userId})`,
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
