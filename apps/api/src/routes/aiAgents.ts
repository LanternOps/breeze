import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  AI_AGENT_GRADUATION_BY_ORG_LIMIT,
  AI_AGENT_IMPACT_REBUILD_DAYS,
  AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
  AI_AGENT_KINDS,
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  AI_AGENT_RUN_STATUSES,
  type AgentRunVerdict,
  type AiAgentDto,
  type AiAgentGraduationByOrgDto,
  type AiAgentGraduationDto,
  type AiAgentRunListItemDto,
  type ExposureBudgetDto,
  createAiAgentSchema,
  impactQuerySchema,
  impactRebuildQuerySchema,
  impactWeightsSchema,
  promoteSupervisedKeyRequestSchema,
  triggerAgentRunSchema,
  updateAiAgentSchema,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  actionIntents, aiAgentGraduation, aiAgentRuns, aiAgents, aiToolExecutions, devices, organizations,
  reportRuns, reports, ticketDrafts, type AiAgentRow,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { policyDecideEnabled } from '../config/env';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from '../services/partnerWideAccess';
import { AgentAccessDeniedError } from '../services/aiAgents/access';
import { getCircuitState, resetCircuit } from '../services/aiAgents/agentCircuit';
import { enqueueImpactRollupForOrgs } from '../jobs/aiAgentImpactRollup';
import { loadImpactSummary } from '../services/aiAgents/impactQuery';
import { lastCompleteUtcDay, shiftUtcDay } from '../services/aiAgents/impactRollup';
import {
  ImpactPartnerNotFoundError,
  ImpactPartnerUnresolvedError,
  resolveImpactPartnerId,
  saveImpactWeights,
} from '../services/aiAgents/impactWeights';
import {
  createAgent, disableAgent, getAgent, listAgents, updateAgent,
  ActPrerequisitesNotMetError, AgentInvariantError, AgentKindConflictError,
  InvalidSupervisedActionKeysError, UnsupportedAgentModeError,
} from '../services/aiAgents/agentService';
import { resolveEffectiveAgent, resolveEffectiveAgentSystem } from '../services/aiAgents/effectivePolicy';
import { loadActOpReliability, loadGraduationRows } from '../services/aiAgents/graduationService';
import { demoteSupervisedKey } from '../services/aiAgents/supervisedKeyDemote';
import { POLICY_DECIDABLE_TIER3 } from '../services/actionIntents/policyDecidable';
import { ActionIntentError, createActionIntent } from '../services/actionIntents/intentService';
import { computeExposureBudget } from '../services/actionIntents/exposureBudget';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { InvalidAgentRecipientsError } from '../services/aiAgents/recipients';
import { SUPPORTED_AGENT_MODES } from '../services/aiAgents/constants';
import { buildRunTrace } from '../services/aiAgents/runTrace';
import { recordVerdictFeedback } from '../services/aiAgents/alertVerdicts';
import { sweepFindingDeviceIds } from '../services/aiAgents/sweepFindings';
import { narrativeArtifactProjection } from '../services/aiAgents/narrativeReport';
import {
  buildRunsKeysetPredicate, decodeRunsCursor, encodeRunsCursor, runsCursorFromRow,
} from '../services/aiAgents/runsListCursor';
import { verifyDeviceAccess } from '../services/aiTools';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { resolveOrgId } from './networkShared';

export const aiAgentsRoutes = new Hono();
aiAgentsRoutes.use('*', authMiddleware);

// Dedicated capabilities, NOT organizations:read/write. Authoring an agent
// policy is what will eventually authorize autonomous action on customer
// machines, and organizations:write is held by every org admin — sharing it
// would hand agent-authoring authority to all of them the day wave 4 enables
// `act` mode, with nobody having decided to. Partner Admin keeps access via *:*.
const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

// NOTE (deviation from the plan, deliberate): the agent-MUTATION handlers do
// not call writeRouteAudit. agentService.recordMutation already writes the
// ai.agent.created/updated/disabled audit row through createAuditLog, and both
// paths land in the same audit_logs table — auditing here too would double every
// agent mutation. The service is the single audit point precisely because wave 3
// mutates agents from schedulers that have no Hono context. POST /:id/runs is
// different: createAndEnqueueAgentRun emits console/event-bus observability but
// writes no audit row, so the route must record the human actor who initiated it.

const UUID = z.string().guid();

/**
 * A path id that is not a uuid must never reach a query. Postgres raises
 * 22P02 on the cast, and because the request runs inside one
 * withDbAccessContext transaction that error poisons it — the COMMIT then
 * 500s on what is really a 404.
 */
function uuidParam(c: Context, name: string): string | null {
  const parsed = UUID.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}

/**
 * The wire shape, field by field. Deliberately not `{ ...row }`: spreading
 * would publish createdBy / lastUpdatedBy / disabledBy, and would make every
 * column added to ai_agents in a later wave part of the public API of the table
 * that governs agent authority. Naming AiAgentDto (from @breeze/shared, which
 * the web client also imports) is what keeps the two ends from drifting.
 */
function mapRow(row: AiAgentRow): AiAgentDto {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    model: row.model,
    orgId: row.orgId,
    partnerId: row.partnerId,
    ownerScope: row.partnerId ? 'partner' : 'organization',
    allOrgs: row.partnerId !== null,
    supportedModes: SUPPORTED_AGENT_MODES,
    toolAllowlist: row.toolAllowlist,
    protectedResources: row.protectedResources,
    limits: row.limits,
    triggers: row.triggers,
    recipients: row.recipients,
    actAssets: row.actAssets,
    instructions: row.instructions,
    cooldownSeconds: row.cooldownSeconds,
    // Explicit, rather than relying on JSON.stringify to coerce a Date: the
    // DTO promises a string, and a caller that ever serializes this by another
    // route would otherwise get an object.
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The two partial unique indexes that enforce "one live agent per kind per
 * owner" (`2026-09-02-ai-agents.sql`): one per owner axis, because the table
 * is dual-owned (`ai_agents_one_owner_chk`). Both have to be listed — a
 * partner-wide create races `ai_agents_partner_kind_uq`, an org-owned one
 * races `ai_agents_org_kind_uq`, and the handler cannot know which shape it
 * just lost.
 */
const AGENT_KIND_UNIQUE_INDEXES = ['ai_agents_partner_kind_uq', 'ai_agents_org_kind_uq'] as const;

/**
 * Postgres unique-violation, for the create race the pre-check cannot win.
 *
 * `isPgUniqueViolation`, not a top-level `err.code` read (review fix, #4189):
 * postgres.js raises a PostgresError with `.code === '23505'`, but Drizzle
 * wraps it in a DrizzleQueryError whose own `.code` is undefined — the real
 * SQLSTATE is on `.cause`. A top-level check therefore missed EVERY
 * Drizzle-issued insert, i.e. every real occurrence of the race this mapping
 * exists for, and returned an unactionable 500 instead of the 409.
 *
 * Pinned to the two kind indexes rather than accepting any 23505: an
 * unrelated unique violation raised anywhere else in the same handler would
 * otherwise be reported to the client as "an agent of this kind already
 * exists", which is a false statement about what went wrong.
 */
function isAgentKindConflict(err: unknown): boolean {
  return AGENT_KIND_UNIQUE_INDEXES.some((constraint) => isPgUniqueViolation(err, constraint));
}

export function mapError(c: Context, err: unknown) {
  if (err instanceof UnsupportedAgentModeError) {
    // err.code, not a repeated literal — the class types it as a literal, so
    // this cannot drift from the value the client branches on.
    return c.json({ error: err.message, code: err.code, supportedModes: SUPPORTED_AGENT_MODES }, 422);
  }
  // Task 6 (#3826): the write is mode-legal ('act' is now a supported mode)
  // but would leave the row unable to actually act — no one to notify, or no
  // surface the manifest can ever reach. `missing` names exactly which so the
  // client (Task 8's form) can render an actionable message.
  if (err instanceof ActPrerequisitesNotMetError) {
    return c.json({ error: err.message, code: err.code, missing: err.missing }, 422);
  }
  // Wave 5 Part B (#3827): actAssets.supervisedActionKeys failed write-time
  // registry validation (validateAuthorizationKeys, policyDecidable.ts).
  // `rejected` names exactly which keys and why, same shape as `missing`
  // above, so the client (Task 5's editor) can render an actionable message.
  if (err instanceof InvalidSupervisedActionKeysError) {
    return c.json({ error: err.message, code: err.code, rejected: err.rejected }, 422);
  }
  if (err instanceof AgentKindConflictError) {
    return c.json({ error: err.message, code: err.code }, 409);
  }
  // Membership-validation failure on recipients (services/aiAgents/recipients.ts):
  // actionable client error — the body names exactly which ids were refused.
  if (err instanceof InvalidAgentRecipientsError) {
    return c.json({
      error: 'invalid_recipients',
      invalidUserIds: err.invalidUserIds,
      invalidRoleIds: err.invalidRoleIds,
    }, 400);
  }
  // The pre-check in createAgent cannot win a concurrent create; the partial
  // unique index settles that race. Answer it the same way rather than letting
  // it become an unactionable 500.
  if (isAgentKindConflict(err)) {
    return c.json({ error: 'An agent of this kind already exists', code: 'agent_kind_exists' }, 409);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  // Task 8 (#4193 A8): resolveImpactPartnerId throws this when neither
  // auth.partnerId nor an orgId yield a single partner — practically only a
  // system-scoped caller reaching PUT/DELETE /impact/weights, which takes no
  // orgId. Answered the same "name a target" shape as GET /impact's own
  // system-scope-without-orgId 400, not a 500.
  if (err instanceof ImpactPartnerUnresolvedError) {
    return c.json({ error: 'org_id_required', message: err.message }, 400);
  }
  // saveImpactWeights: the UPDATE matched zero rows (unknown or RLS-declined
  // partnerId) after the caller already passed canManagePartnerWidePolicies —
  // see the class's own docstring. Not "not found" in the everyday sense (the
  // caller can't specify a partnerId at all on this route), but 404 is the
  // honest answer for "nothing to update".
  if (err instanceof ImpactPartnerNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  // AgentInvariantError is deliberately NOT caught: returning a response here
  // would let the request transaction COMMIT, so a create whose RETURNING read
  // came back empty would insert the row, answer "not created", and keep it.
  // Letting it propagate rolls the transaction back and puts it in front of the
  // global onError handler, which logs it and reports it to Sentry.
  if (err instanceof AgentInvariantError) throw err;
  if (err instanceof AgentAccessDeniedError) {
    return c.json({ error: err.message }, 404);
  }
  throw err;
}

aiAgentsRoutes.get(
  '/',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    includeDisabled: z.enum(['1', 'true']).optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const rows = await listAgents(auth, {
      includeDisabled: query.includeDisabled !== undefined,
    });
    return c.json({ data: rows.map(mapRow) });
  },
);

aiAgentsRoutes.get(
  '/effective',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    orgId: z.string().guid(),
    kind: z.enum(AI_AGENT_KINDS),
  })),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, kind } = c.req.valid('query');
    const resolved = await resolveEffectiveAgent(auth, orgId, kind);
    return c.json({ data: resolved });
  },
);

/**
 * Wave 5 Part B (#3827) — the read-only, static POLICY_DECIDABLE_TIER3
 * registry, for the web `supervisedActionKeys` editor (Task 5) to render a
 * multi-select grouped by tool. Registered ahead of GET /:id, same reason as
 * /effective and /runs/:runId above — a literal path segment must not fall
 * into the `:id` param route. Only the wire-relevant fields are projected:
 * `maxTargetCardinality`/`requiresEffectPin` are policyDecidable.ts's own
 * review notes, not client data, and `headlessCompatible` is filtered on
 * (never surfaced) — v1 happens to be all-true, but a future non-headless
 * entry must never be offered as a selectable key here (it structurally can
 * never be policy-decided; see registryCheck in policyDecide.ts).
 */
aiAgentsRoutes.get('/policy-decidable-keys', scopes, requireAiRead, async (c) => {
  return c.json({
    data: POLICY_DECIDABLE_TIER3
      .filter((entry) => entry.headlessCompatible)
      .map((entry) => ({ key: entry.key, toolName: entry.toolName, action: entry.action, note: entry.note })),
  });
});

/**
 * Orgs per system-context transaction in the `byOrg` fan-out of
 * `GET /graduation` below. Exported for the route test, which pins the bound
 * (one context per batch) rather than the incidental call count. 25 x ~7
 * round trips is a short-lived snapshot; the cap on the SIZE of that fan-out
 * is `AI_AGENT_GRADUATION_BY_ORG_LIMIT`.
 */
export const AI_AGENT_GRADUATION_BY_ORG_BATCH = 25;

/**
 * P2-5 (#4192, Task A2-8) — the graduation READ route: the panel (web Task
 * 20) and the partner-wide agent page both read through here. Registered
 * beside GET /policy-decidable-keys, ahead of GET /:id, for the same reason
 * every other literal segment on this router is: it must not fall into the
 * `:id` param route.
 *
 * This route is deliberately NOT gated on `policyDecideEnabled()` — a read is
 * an observation about evidence, never a write (only POST
 * /graduation/promote 409s while the flag is dark; see that route's own
 * docstring). `policyDecideEnabled` is still reported on the DTO so the panel
 * can explain why Promote is disabled.
 *
 * With `orgId`: the effective agent is resolved SERVER-SIDE via
 * `resolveEffectiveAgentSystem` — an org token carries a `partnerId` but
 * never passes `breeze_has_partner_access`, so it cannot read the partner
 * baseline row itself (`effectivePolicy.ts:341-350`) — never an id supplied
 * on the query string. `ownerScope` reports `'organization'` only when THIS
 * org has its own active `ai_agents` row for `kind` (an override); every
 * other org rides the partner baseline and reports `'partner'`.
 *
 * Without `orgId` (partner scope only — an org-scoped caller has no partner
 * axis to fan out over, so it 400s the same way `GET /impact` does for a
 * system-scoped caller with no orgId): the first
 * `AI_AGENT_GRADUATION_BY_ORG_LIMIT` orgs this caller can access, in name
 * order, are resolved the same way and grouped into `byOrg`, in batches of
 * `AI_AGENT_GRADUATION_BY_ORG_BATCH` (see the loop's comment for why BOTH
 * bounds exist). A partner over the cap gets `byOrgTruncated: true`. An org
 * with no active agent for `kind` is omitted rather than reported empty. The
 * top-level `promoteThreshold` is informational only (the per-row `state`/
 * `blockedReason` already apply each org's own merged threshold) — it is the
 * first resolved org's merged value, or the shared default when no org under
 * this partner has an active agent for `kind` yet.
 */

aiAgentsRoutes.get(
  '/graduation',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    orgId: z.string().guid().optional(),
    kind: z.enum(AI_AGENT_KINDS),
  })),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, kind } = c.req.valid('query');
    const flagEnabled = policyDecideEnabled();

    if (orgId !== undefined) {
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Organization not accessible' }, 403);
      }

      const resolved = await resolveEffectiveAgentSystem(orgId, kind);
      if (!resolved) {
        return c.json({ error: 'No active agent policy for this organization/kind' }, 404);
      }

      const [orgOverride] = await db
        .select({ id: aiAgents.id })
        .from(aiAgents)
        .where(and(eq(aiAgents.orgId, orgId), eq(aiAgents.kind, kind), isNull(aiAgents.disabledAt)))
        .limit(1);

      const [rows, actOpReliability] = await Promise.all([
        loadGraduationRows(orgId, resolved.agentId),
        loadActOpReliability(orgId, resolved.agentId),
      ]);

      const dto: AiAgentGraduationDto = {
        version: 1,
        agentId: resolved.agentId,
        ownerScope: orgOverride ? 'organization' : 'partner',
        rows,
        actOpReliability,
        promoteThreshold: resolved.effective.limits.promoteThreshold,
        policyDecideEnabled: flagEnabled,
      };
      return c.json(dto);
    }

    if (auth.scope !== 'partner') {
      return c.json({ error: 'org_id_required', message: 'orgId is required for this scope' }, 400);
    }

    // `+ 1` is a probe row, not slack: it tells the route there IS more
    // without a second COUNT, and is dropped before any work is done for it.
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(auth.orgCondition(organizations.id), isNull(organizations.deletedAt)))
      .orderBy(asc(organizations.name))
      .limit(AI_AGENT_GRADUATION_BY_ORG_LIMIT + 1);

    const byOrgTruncated = orgRows.length > AI_AGENT_GRADUATION_BY_ORG_LIMIT;
    const fanoutOrgs = byOrgTruncated
      ? orgRows.slice(0, AI_AGENT_GRADUATION_BY_ORG_LIMIT)
      : orgRows;

    const byOrg: AiAgentGraduationByOrgDto['byOrg'] = [];
    let promoteThreshold: number | null = null;
    // Two separate bounds, because either alone leaves the pool-starvation
    // shape this router has already been bitten by.
    //
    // COUNT (`AI_AGENT_GRADUATION_BY_ORG_LIMIT`, above): every org here costs
    // a policy resolve plus two ledger reads, so an uncapped partner-wide
    // read is an unbounded per-request workload — the same reason `GET
    // /impact` refuses a fan-out outright and `POST /impact/rebuild` carries
    // `AI_AGENT_IMPACT_REBUILD_MAX_ORGS`. Over the cap the panel reports
    // `byOrgTruncated` and reaches the rest through `?orgId=`, which is never
    // capped.
    //
    // TRANSACTION LIFETIME (`AI_AGENT_GRADUATION_BY_ORG_BATCH`, below):
    // review round 1 collapsed 3N pooled transactions into one by opening a
    // single system context around the loop — resolveEffectiveAgentSystem and
    // graduationService's inSystemDbContext both skip re-opening when
    // getCurrentDbAccessContext() already reads 'system'. That fixed the
    // transaction COUNT and created a new problem: one snapshot held open for
    // N x ~7 sequential round trips, on a second pooled connection, while the
    // request's own auth transaction holds the first. Batching keeps the
    // collapse (one context per 25 orgs, not per org) while bounding how long
    // any single connection is pinned. Batches are independent read-only
    // snapshots, which is correct here — the listing itself is already read
    // outside them.
    //
    // The org listing above deliberately stays in the REQUEST's own context
    // so `auth.orgCondition`'s tenancy pin binds.
    for (let i = 0; i < fanoutOrgs.length; i += AI_AGENT_GRADUATION_BY_ORG_BATCH) {
      const batch = fanoutOrgs.slice(i, i + AI_AGENT_GRADUATION_BY_ORG_BATCH);
      await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        for (const org of batch) {
          const resolved = await resolveEffectiveAgentSystem(org.id, kind);
          if (!resolved) continue;
          if (promoteThreshold === null) promoteThreshold = resolved.effective.limits.promoteThreshold;
          const [rows, actOpReliability] = await Promise.all([
            loadGraduationRows(org.id, resolved.agentId),
            loadActOpReliability(org.id, resolved.agentId),
          ]);
          byOrg.push({ orgId: org.id, orgName: org.name, agentId: resolved.agentId, rows, actOpReliability });
        }
      }, 'aiAgents.graduation.byOrg'));
    }

    const dto: AiAgentGraduationByOrgDto = {
      version: 1,
      promoteThreshold: promoteThreshold ?? AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
      policyDecideEnabled: flagEnabled,
      byOrgTruncated,
      byOrg,
    };
    return c.json(dto);
  },
);

/**
 * P2-5 (#4192, Task A2-5) — RAISE a promotion. This route grants nothing: it
 * creates the Tier-3 FOUR-EYES action intent
 * (`manage_ai_agents:authorize_supervised_key`) whose eventual release runs
 * the grant (`services/aiAgents/supervisedKeyGrant.ts`).
 *
 * Four-eyes AS BUILT is requester + one DIFFERENT approver, first eligible
 * approval wins (`decideApprovalRequest.ts`); the sole-operator WebAuthn
 * self-approval exception (`intentService.ts`) applies here UNCHANGED — a
 * partner whose only eligible approver is the requester can still approve
 * their own request with a hardware credential, exactly as for every other
 * four-eyes tool. This wave adds no new state machine.
 *
 * 409 when `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is off: the whole point
 * of a supervised key is to let `attemptPolicyDecision` release without human
 * fanout, so raising an approval for one while that lane is dark would queue
 * an authority change nobody can use — and the executor would refuse it at
 * release anyway (`policy_decide_disabled`). The graduation READ route is
 * deliberately not gated the same way (Task 18): eligibility is an
 * observation, not a write.
 *
 * `source: 'mcp_api'` is deliberate and is about the DEADLINE, not the
 * caller: `computeExpiresAt` keys the approval window off source first, and
 * only the non-chat branch (24h) is long enough for a second human to reach
 * their inbox. The chat branch would expire the request in 60 minutes.
 *
 * No `requireMfa()` — this raises a request that a second human must still
 * approve; the MFA/assurance bar belongs to that approval (riskTier 'high'
 * floors it at L3), not to asking for it.
 *
 * A key the org ALREADY holds is not rejected here: eligibility is
 * re-established at RELEASE time, not at request time, and a pre-check would
 * be TOCTOU comfort rather than a guarantee. A duplicate therefore surfaces
 * as the intent terminalizing `failed` with reason `already_granted` — the
 * "nothing to do, the key is already live" signal, deliberately not a false
 * success (`services/aiAgents/supervisedKeyGrant.ts` gives the full
 * reasoning, including why the provenance columns are not re-stamped).
 */
aiAgentsRoutes.post(
  '/graduation/promote',
  scopes,
  requireAiWrite,
  zValidator('json', promoteSupervisedKeyRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, kind, opKey } = c.req.valid('json');

    if (!policyDecideEnabled()) {
      return c.json({ error: 'policy_decide_disabled' }, 409);
    }
    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Organization not accessible' }, 403);
    }

    try {
      // `runOutsideDbContext` is LOAD-BEARING, not tidiness — found by
      // `aiAgentGraduation.integration.test.ts` (Task A2-9) against real
      // Postgres, where this route 500'd on every promotion.
      // `createActionIntent` opens its transaction with a bare
      // `withSystemDbAccessContext`, and that is a NO-OP passthrough when a
      // context is already held (`db/index.ts`). This route is not in
      // `SELF_MANAGED_DB_CONTEXT_ROUTES`, so `authMiddleware` runs the whole
      // handler inside the REQUESTER's org-scoped request transaction; the
      // four-eyes fan-out then inserts an `approval_requests` row owned by a
      // DIFFERENT user, and that table's Shape-6 policy is
      // `user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'`
      // — so the insert dies 42501 and the request 500s. Every OTHER caller
      // of `createActionIntent` (the chat SDK, the agent run loop, the
      // verdict/triage/sweep proposers) reaches it from a contextless stack,
      // which is why this is the first route to meet it. Exiting the request
      // context makes the system wrapper actually elevate.
      //
      // No atomicity is lost: nothing else in this handler writes, and
      // `createActionIntent`'s own transaction still commits the intent, its
      // fan-out and its outbox row together.
      const intent = await runOutsideDbContext(() => createActionIntent(auth, {
        toolName: 'manage_ai_agents',
        // `orgId` is carried in the ARGUMENTS as well as on the intent: the
        // effect-digest resolver receives only `(args, database)` and pins
        // this org's authorized-key list from it. createActionIntent rejects
        // an `orgId` argument that disagrees with the intent's own resolved
        // org, so it can only ever name the org this caller is authorized for.
        input: { action: 'authorize_supervised_key', kind, opKey, orgId },
        source: 'mcp_api',
        orgId,
        requestingClientLabel: 'Breeze',
      }));
      return c.json({ intentId: intent.id }, 201);
    } catch (err) {
      // Every ActionIntentError is a caller-fixable refusal (tool blocked or
      // reclassified, org unresolvable, argument mismatch) — answered as a
      // 400 with its code rather than allowed to reach the global handler as
      // a 500.
      if (err instanceof ActionIntentError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      throw err;
    }
  },
);

/**
 * Body of `POST /graduation/revoke`. Kept local to this route rather than
 * added beside `promoteSupervisedKeyRequestSchema` in `@breeze/shared`: the
 * promote body crosses the wire into an action intent's ARGUMENTS (the
 * effect-digest resolver re-reads it), so it has to be canonical in a package
 * both ends import. A revoke is a plain request body that never leaves this
 * handler.
 *
 * `opKey` carries promote's colon-form restriction verbatim: a dot-form
 * act-op key is outcome evidence and was never grantable, so it can never be
 * revocable either — rejecting it at the schema is what keeps a typo from
 * reading as "no such grant".
 *
 * `kind` is OPTIONAL and exists only to disambiguate. Policy-decidable keys
 * are not kind-scoped (`POLICY_DECIDABLE_TIER3` is one flat registry), and
 * `ai_agent_graduation` is unique on `(org_id, agent_id, op_key)` — so one
 * org CAN hold the same key under two agents of different kinds. The panel
 * always knows the kind it is rendering; a caller that omits it gets served
 * only while the answer is unambiguous.
 */
const revokeSupervisedKeyRequestSchema = z.object({
  orgId: z.string().guid(),
  opKey: z.string().min(3).max(120).regex(/^[a-z0-9_]+:[a-z0-9_]+$/),
  kind: z.enum(AI_AGENT_KINDS).optional(),
  /** Operator-authored note. Recorded on the audit row, never on the agent policy. */
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

/**
 * How many graduation rows the precondition read pulls for one
 * `(org_id, op_key)`. Only "one, or more than one" is ever asked — the extra
 * rows exist so the ambiguity branch below can fire instead of the route
 * silently revoking whichever holder Postgres returned first.
 */
const GRADUATION_REVOKE_CANDIDATE_LIMIT = 5;

/**
 * The operator-facing mirror of `POST /graduation/promote`: hand a promoted
 * key back to the approval queue.
 *
 * NO FOUR-EYES, and that is the whole point of it being a route rather than
 * a second `manage_ai_agents` action. Promote's four-eyes ceremony exists
 * because granting unattended authority is irreversible-in-effect once an
 * action runs; revoking strictly REDUCES privilege, so requiring a second
 * human would mean an operator who has just watched an agent misbehave
 * cannot stop it without finding a colleague. Same `scopes` and the same
 * `requireAiWrite` capability as promote; no `requireMfa()`, matching what
 * promote asks of its FIRST approver.
 *
 * NOT GATED ON `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`, deliberately, and
 * for the exact reason promote IS: the flag going dark must stop new grants
 * without stranding a live one on an agent an operator wants stopped.
 * `supervisedKeyDemote.ts` is always-on for the same reason.
 *
 * TENANCY. The precondition read runs in the CALLER's own request context —
 * `ai_agent_graduation` is Shape 1 (`breeze_has_org_access(org_id)`), so RLS
 * is a real gate here and elevating would throw it away (the same reasoning
 * `countEligibleGraduations` records). `auth.orgCondition` is stacked on top
 * because partner scope means ACCESSIBLE orgs, not every org under the
 * partner. Only the EXECUTOR elevates, and it does so itself: unlike
 * promote's `createActionIntent` (a bare system wrapper, which is a no-op
 * inside a request context — hence promote's `runOutsideDbContext`),
 * `demoteSupervisedKey`'s own `inSystemDbContext` already exits the request
 * context before establishing system visibility, so this handler must NOT
 * wrap it.
 *
 * Refusals are all "nothing was revoked", never a false success:
 *   404 `no_promoted_grant`  — no row, or none that ever reached `promoted`
 *   409 `already_demoted`    — this key is already back in the queue
 *   409 `ambiguous_op_key`   — two agents hold it; re-send with `kind`
 *   409 `already_revoked`    — the key had already left the org row (a manual
 *                              PATCH, or a partner-ceiling-only grant), so
 *                              the executor wrote nothing and the stored
 *                              state is stale-promoted. Reporting 200 here
 *                              would claim a `demoted` row that does not
 *                              exist.
 */
aiAgentsRoutes.post(
  '/graduation/revoke',
  scopes,
  requireAiWrite,
  zValidator('json', revokeSupervisedKeyRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, opKey, kind, reason } = c.req.valid('json');

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Organization not accessible' }, 403);
    }

    const rows = await db
      .select({ agentId: aiAgentGraduation.agentId, state: aiAgentGraduation.state })
      .from(aiAgentGraduation)
      .where(and(
        auth.orgCondition(aiAgentGraduation.orgId),
        eq(aiAgentGraduation.orgId, orgId),
        eq(aiAgentGraduation.opKey, opKey),
      ))
      .limit(GRADUATION_REVOKE_CANDIDATE_LIMIT);

    let candidates = rows;
    if (kind !== undefined) {
      // Server-side resolution, never a caller-supplied agent id — the same
      // rule GET /graduation states: an org token carries a partnerId but
      // cannot read the partner baseline row itself.
      const resolved = await resolveEffectiveAgentSystem(orgId, kind);
      if (!resolved) {
        return c.json({ error: 'No active agent policy for this organization/kind' }, 404);
      }
      candidates = rows.filter((row) => row.agentId === resolved.agentId);
    }

    const promoted = candidates.filter((row) => row.state === 'promoted');
    if (promoted.length === 0) {
      if (candidates.some((row) => row.state === 'demoted')) {
        return c.json({ error: 'already_demoted' }, 409);
      }
      return c.json({ error: 'no_promoted_grant' }, 404);
    }
    if (promoted.length > 1) {
      return c.json({
        error: 'ambiguous_op_key',
        message: 'More than one agent holds this key for the organization — re-send with `kind`',
      }, 409);
    }

    const { agentId } = promoted[0]!;
    const { revoked, orgAgentId } = await demoteSupervisedKey({
      orgId,
      agentId,
      opKey,
      reason: 'operator',
      // No disqualifying evidence produced this — a human decided it. The
      // accountable human is on the audit row below, which is also why the
      // executor is left to write its own `ai.agent.supervised_key.revoked`
      // row unchanged: that one records the AUTHORITY CHANGE (and is the same
      // row the two automatic callers produce), this one records WHO.
      runId: null,
      watchId: null,
      intentId: null,
    });
    if (!revoked) {
      return c.json({ error: 'already_revoked', orgAgentId }, 409);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'ai_agent.graduation.revoke',
      resourceType: 'ai_agent',
      resourceId: orgAgentId,
      // The operator's own note is the one piece of free text on this row.
      // It is a HUMAN's words, not a tool result, an alert message or any
      // model-authored rationale — the class `supervisedKeyDemote.ts`'s leak
      // rule excludes from operator-facing surfaces.
      details: { agentId, orgAgentId, opKey, reason: reason ?? null },
      result: 'success',
    });

    return c.json({ revoked: true, orgAgentId, state: 'demoted' as const });
  },
);

/**
 * Wave 6 PR 1 (#3828) — the org+kind unattended-exposure budget readout:
 * "recorded exposure", reusing the EXACT same enforcement calculation
 * `policyDecide.ts`'s authorize transaction gates a policy decision with
 * (`computeExposureBudget`, services/actionIntents/exposureBudget.ts),
 * called here read-only with no `deviceId` (no live decision to project —
 * see that param's docstring). Query shape mirrors `GET /effective` above
 * (`orgId` + `kind`, resolved through the same authorized loader) rather
 * than taking a raw `agentId`, since the org+kind pair — not a specific
 * agent id the caller may not have handy — is the natural key an operator
 * reasons about ("what's my patch agent's unattended budget").
 *
 * `accountingMode` is derived from the live `policyDecideEnabled()` flag,
 * not cached — see `ExposureBudgetDto`'s docstring for why a 'partial' vs
 * 'full' distinction matters while the flag is dark.
 */
aiAgentsRoutes.get(
  '/exposure-budget',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    orgId: z.string().guid(),
    kind: z.enum(AI_AGENT_KINDS),
  })),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, kind } = c.req.valid('query');

    const resolved = await resolveEffectiveAgent(auth, orgId, kind);
    if (!resolved) {
      return c.json({ error: 'No active agent policy for this organization/kind' }, 404);
    }

    const { maxFleetPercentPerDay, maxPolicyDecisionsPerDay } = resolved.effective.limits;
    const budget = await computeExposureBudget({
      orgId,
      agentId: resolved.agentId,
      maxFleetPercentPerDay,
      maxPolicyDecisionsPerDay,
      // No deviceId: this is a readout, not a live decision — see
      // computeExposureBudget's param docstring.
    });

    const dto: ExposureBudgetDto = {
      schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION,
      orgId,
      agentId: resolved.agentId,
      distinctDevices: budget.distinctDevices,
      contractDeviceCount: budget.contractDeviceCount,
      maxFleetPercentPerDay: budget.maxFleetPercentPerDay,
      allowance: budget.allowance,
      // Non-null: this call site never sets shortCircuitOnFleetCapExceeded,
      // so the day-count query always ran.
      policyDecisionsToday: budget.policyDecisionsToday as number,
      maxPolicyDecisionsPerDay: budget.maxPolicyDecisionsPerDay,
      windowHours: 24,
      recordedOnly: true,
      accountingMode: policyDecideEnabled() ? 'full' : 'partial',
    };
    return c.json({ data: dto });
  },
);

/**
 * The wire shape of one `GET /runs` row. Deliberately NOT `{ ...row }` for
 * the same reason `mapRow` (above) isn't: this is a list-item projection, no
 * outcome payload at all — the detail route below is where a caller goes for
 * the trace, ledger, and intents.
 */
function mapRunListItem(row: {
  id: string;
  agentId: string;
  agentName: string | null;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  status: AiAgentRunListItemDto['status'];
  triggerKind: AiAgentRunListItemDto['triggerKind'];
  profile: AiAgentRunListItemDto['profile'];
  runVerdict: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
  costCents: number;
}): AiAgentRunListItemDto {
  return {
    schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION,
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    orgId: row.orgId,
    orgName: row.orgName,
    deviceId: row.deviceId,
    status: row.status,
    triggerKind: row.triggerKind,
    // Phase 2 wave P2-2, Task A7 — the web list badges sweep/verdict rows off
    // this; `triggerKind: 'schedule'` alone cannot identify a sweep.
    profile: row.profile,
    runVerdict: (row.runVerdict as AgentRunVerdict | null) ?? null,
    queuedAt: row.queuedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    costCents: row.costCents,
  };
}

/**
 * Org-wide keyset-paginated runs list (Wave 6 PR 1, #3828) — every run this
 * caller's accessible orgs produced, across every agent, newest first.
 * Distinct from `GET /:id/runs` (agent-scoped, offset-limited) below: that
 * route answers "what has THIS agent done", this one answers "what has
 * happened across the fleet", which is what the runs list page (Task 4)
 * needs. Registered ahead of `GET /:id` — a literal `runs` path segment must
 * never fall into the `:id` param route.
 */
aiAgentsRoutes.get(
  '/runs',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    agentId: z.string().guid().optional(),
    status: z.enum(AI_AGENT_RUN_STATUSES).optional(),
    orgId: z.string().guid().optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const { cursor: cursorToken, limit, agentId, status, orgId } = c.req.valid('query');

    const cursor = decodeRunsCursor(cursorToken);
    if (cursorToken && !cursor) {
      return c.json({ error: 'Invalid or malformed cursor' }, 400);
    }

    // Optional single-org filter (must be accessible) — mirrors
    // routes/devices/core.ts's fleet-list pattern. `fetchWithAuth` auto-injects
    // `?orgId=<selected>` whenever the org switcher has one org selected
    // (apps/web/src/stores/auth.ts); without this the query schema silently
    // stripped it and the org switcher never narrowed the list (review fix,
    // #3828 — this route is registered `org-or-all` in routeScope.ts).
    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const conditions: (SQL | undefined)[] = [auth.orgCondition(aiAgentRuns.orgId)];
    if (agentId) conditions.push(eq(aiAgentRuns.agentId, agentId));
    if (status) conditions.push(eq(aiAgentRuns.status, status));
    if (orgId) conditions.push(eq(aiAgentRuns.orgId, orgId));
    if (cursor) conditions.push(buildRunsKeysetPredicate(cursor));

    // Peek one extra row past `limit` to detect "is there a next page" —
    // mirrors routes/devices/core.ts's cursor-mode convention. The
    // (limit+1)th row becomes the nextCursor seed and is trimmed from data.
    const rows = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        agentName: aiAgents.name,
        orgId: aiAgentRuns.orgId,
        // Org name for the fleet (All-organizations) view, where the web list
        // shows an Organization column so cross-org rows stay legible —
        // mirrors routes/alerts/alerts.ts's `orgName` join (review fix, #3828).
        orgName: organizations.name,
        deviceId: aiAgentRuns.deviceId,
        status: aiAgentRuns.status,
        triggerKind: aiAgentRuns.triggerKind,
        profile: aiAgentRuns.profile,
        // Pulled straight out of the outcome jsonb by key rather than
        // selecting the whole column — this is a list endpoint, and the
        // full outcome (which is where the SAFE-projection risk lives) has
        // no business leaving Postgres for a row that isn't the one the
        // caller asked to see in detail.
        runVerdict: sql<string | null>`${aiAgentRuns.outcome}->>'runVerdict'`,
        queuedAt: aiAgentRuns.queuedAt,
        // Full microsecond-precision text of the same column, for the
        // cursor only — never put on the DTO. See runsListCursor.ts's
        // AiAgentRunsCursor.q docstring for why `queuedAt.toISOString()`
        // (millisecond-truncating) must never be what seeds the cursor.
        queuedAtRaw: sql<string>`to_char(${aiAgentRuns.queuedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        finishedAt: aiAgentRuns.finishedAt,
        costCents: aiAgentRuns.costCents,
      })
      .from(aiAgentRuns)
      // LEFT, not INNER: ai_agents is a dual-ownership table (#2135) whose RLS
      // policy denies partner-wide rows to an org-scoped caller entirely
      // (breeze_has_partner_access is false — org tokens carry no accessible
      // partner ids). ai_agent_runs itself is plain org-scoped and stays
      // visible, so an inner join would silently drop every run produced by
      // a partner-wide agent from this list. agentName instead comes back
      // null for those rows (see AiAgentRunListItemDto.agentName).
      .leftJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
      .leftJoin(organizations, eq(aiAgentRuns.orgId, organizations.id))
      .where(and(...conditions))
      .orderBy(desc(aiAgentRuns.queuedAt), desc(aiAgentRuns.id))
      .limit(limit + 1);

    let nextCursor: string | null = null;
    let pageRows = rows;
    if (rows.length > limit) {
      pageRows = rows.slice(0, limit);
      const last = pageRows[pageRows.length - 1];
      if (last) nextCursor = encodeRunsCursor(runsCursorFromRow(last));
    }

    return c.json({ data: pageRows.map(mapRunListItem), nextCursor });
  },
);

/**
 * The stitched execution-trace detail (Wave 6 PR 1, #3828): the run row's
 * display-safe fields plus the SAFE outcome projection, execution ledger,
 * and linked-intent summary — see `buildRunTrace` (services/aiAgents/runTrace.ts)
 * for the safety property this route depends on. Replaces the prior raw-row
 * response; org scoping and 404 semantics are unchanged.
 */
aiAgentsRoutes.get('/runs/:runId', scopes, requireAiRead, async (c) => {
  const runId = uuidParam(c, 'runId');
  if (!runId) return c.json({ error: 'Run not found' }, 404);

  const auth = c.get('auth');
  // Defence-in-depth beside RLS, matching listAgents. RLS is the boundary and
  // it already denies a contextless read — breeze_current_scope() defaults to
  // 'none', not 'system' (migrations/0012-tenant-rls-deny-default.sql), so the
  // policy's every branch is false and the read returns nothing. The predicate
  // stays because the unit-test path mocks the db and has no RLS at all.
  const [run] = await db
    .select({
      id: aiAgentRuns.id,
      agentId: aiAgentRuns.agentId,
      orgId: aiAgentRuns.orgId,
      deviceId: aiAgentRuns.deviceId,
      alertId: aiAgentRuns.alertId,
      anomalyIncidentId: aiAgentRuns.anomalyIncidentId,
      sessionId: aiAgentRuns.sessionId,
      triggerKind: aiAgentRuns.triggerKind,
      modeAtStart: aiAgentRuns.modeAtStart,
      status: aiAgentRuns.status,
      summary: aiAgentRuns.summary,
      // Phase 2 wave P2-2, Task A7 — the sweep projection's occurrence/kinds
      // provenance; `null`/`{}` for every non-sweep run.
      scheduleId: aiAgentRuns.scheduleId,
      triggerRef: aiAgentRuns.triggerRef,
      // Phase 2 wave P2-3 (weekly org narrative), Task A7 — the report_runs
      // artifact a narrative run was materialised into. The TYPED column, not
      // `outcome.narrativeReport`: the FK is `ON DELETE SET NULL`, so this is
      // the only representation that goes back to null when the artifact is
      // deleted.
      reportRunId: aiAgentRuns.reportRunId,
      outcome: aiAgentRuns.outcome,
      intentIds: aiAgentRuns.intentIds,
      turnCount: aiAgentRuns.turnCount,
      costCents: aiAgentRuns.costCents,
      errorCode: aiAgentRuns.errorCode,
      queuedAt: aiAgentRuns.queuedAt,
      startedAt: aiAgentRuns.startedAt,
      finishedAt: aiAgentRuns.finishedAt,
      agentName: aiAgents.name,
      agentKind: aiAgents.kind,
      deviceHostname: devices.hostname,
    })
    .from(aiAgentRuns)
    // LEFT, not INNER — same RLS-visibility gap as `GET /runs` above: a
    // partner-wide agent's ai_agents row is invisible to an org-scoped
    // caller, but the run it produced must still be returned rather than
    // 404ing (see buildRunTrace's `agent: RunTraceAgentInput | null` param).
    .leftJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
    .leftJoin(devices, eq(aiAgentRuns.deviceId, devices.id))
    .where(and(eq(aiAgentRuns.id, runId), auth.orgCondition(aiAgentRuns.orgId)))
    .limit(1);
  if (!run) return c.json({ error: 'Run not found' }, 404);

  // The execution ledger is keyed by session, not run — `run.session_id` is
  // set once, inside `driveSdkLoop`, right after the model resolves
  // (runLoop.ts), and stays null for the lifetime of the run if that
  // best-effort write itself failed.
  const ledgerRows = run.sessionId
    ? await db
      .select({
        toolName: aiToolExecutions.toolName,
        status: aiToolExecutions.status,
        durationMs: aiToolExecutions.durationMs,
        createdAt: aiToolExecutions.createdAt,
        completedAt: aiToolExecutions.completedAt,
        errorMessage: aiToolExecutions.errorMessage,
      })
      .from(aiToolExecutions)
      .where(eq(aiToolExecutions.sessionId, run.sessionId))
      .orderBy(asc(aiToolExecutions.createdAt))
    : [];

  // `run.intent_ids` only ever lists PENDING intents (see the column's
  // docstring in schema/aiAgents.ts and OutcomeProposedAction.intentId's in
  // runLoop.ts) — an intent that was decided or expired drops out of the
  // array, so this summary reflects "what's still awaiting a human", not
  // the full proposal history. The org predicate is defence-in-depth beside
  // RLS, matching the run read above.
  const intentRows = run.intentIds.length > 0
    ? await db
      .select({
        id: actionIntents.id,
        status: actionIntents.status,
        actionName: actionIntents.actionName,
        approvalScope: actionIntents.approvalScope,
        decidedVia: actionIntents.decidedVia,
      })
      .from(actionIntents)
      .where(and(inArray(actionIntents.id, run.intentIds), auth.orgCondition(actionIntents.orgId)))
    : [];

  // Phase 2 wave P2-2 (scheduled sweeps), Task A7 — a sweep run is
  // device-less but its findings each name one device, so the detail needs
  // hostnames for ids that are NOT `run.device_id`. ONE batched read for the
  // whole findings list (never a lookup per finding); empty for every
  // non-sweep run, which skips the query entirely.
  //
  // TWO org predicates, and both are load-bearing (review round 1,
  // IMPORTANT 1). `sweepDeviceIds` are read out of `outcome.sweepFindings`,
  // which is MODEL-AUTHORED text: nothing in the jsonb guarantees those ids
  // belong to this run's org. `auth.orgCondition` alone only bounds them to
  // the CALLER's accessible set — which, for a partner-scoped caller, spans
  // every sibling org — so a finding naming a device in org B would render
  // org B's hostname inside org A's run detail. `eq(devices.orgId,
  // run.orgId)` pins the read to the run's OWN org, and the auth condition
  // stays as defence-in-depth beside RLS (matching the two reads above). A
  // device that fails either simply projects a null hostname.
  const sweepDeviceIds = sweepFindingDeviceIds(run.outcome);
  const hostnameRows = sweepDeviceIds.length > 0
    ? await db
      .select({ id: devices.id, hostname: devices.hostname })
      .from(devices)
      .where(and(
        inArray(devices.id, sweepDeviceIds),
        eq(devices.orgId, run.orgId),
        auth.orgCondition(devices.orgId),
      ))
    : [];
  const deviceHostnames = new Map(hostnameRows.map((row) => [row.id, row.hostname]));

  // Phase 2 wave P2-3 (weekly org narrative), Task A7 — the linked narrative
  // artifact's provenance scalars (period + context-truncation), projected out
  // of `report_runs.result` BY POSTGRES rather than pulled whole: that jsonb
  // carries the full rendered markdown, which the run-detail DTO deliberately
  // does not ship. Skipped entirely for every run that links no artifact.
  //
  // The join to `reports` is what carries the tenancy: `report_runs` has no
  // `org_id` of its own, so the org pin lives on its parent definition. Both
  // predicates are load-bearing for the same reason the hostname read's two
  // are — `eq(reports.orgId, run.orgId)` pins the artifact to the RUN's org
  // (a partner-scoped caller's accessible set spans siblings), and
  // `auth.orgCondition` stays as defence-in-depth beside RLS.
  const [narrativeArtifactRow] = run.reportRunId
    ? await db
      .select(narrativeArtifactProjection)
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(
        eq(reportRuns.id, run.reportRunId),
        eq(reports.orgId, run.orgId),
        auth.orgCondition(reports.orgId),
      ))
      .limit(1)
    : [];
  const narrativeArtifact = narrativeArtifactRow
    ? {
      reportId: narrativeArtifactRow.reportId ?? null,
      periodStart: narrativeArtifactRow.periodStart ?? null,
      periodEnd: narrativeArtifactRow.periodEnd ?? null,
      contextTruncated: narrativeArtifactRow.contextTruncated === true,
    }
    : null;

  // Phase 2 wave P2-4 (#4191), Task A10 — the ticket_drafts rows THIS RUN
  // produced, for ticketProposal.draftsWritten. A LIVE query, not something
  // read off the persisted outcome jsonb: a draft intent left
  // `pending_approval` has not written its `ticket_drafts` row yet (that only
  // happens later, when a human approves and the intent releases through
  // Task 5's `draft` executor) — see `RunTraceDraftRowInput`'s docstring.
  // Skipped entirely for every non-ticket run. `eq(ticketDrafts.orgId,
  // run.orgId)` pins the read to the RUN's own org for the same reason the
  // sweep-hostname and narrative-artifact reads above do (a partner-scoped
  // caller's `auth.orgCondition` alone spans every sibling org); that stays
  // as defence-in-depth beside RLS.
  const draftRows = run.triggerKind === 'ticket'
    ? await db
      .select({ id: ticketDrafts.id, kind: ticketDrafts.kind })
      .from(ticketDrafts)
      .where(and(
        eq(ticketDrafts.runId, run.id),
        eq(ticketDrafts.orgId, run.orgId),
        auth.orgCondition(ticketDrafts.orgId),
      ))
    : [];

  // Both fields come from the same left-joined ai_agents row, so they are
  // either both present or both null together.
  const agent = run.agentName !== null && run.agentKind !== null
    ? { name: run.agentName, kind: run.agentKind }
    : null;
  const detail = buildRunTrace(
    run,
    agent,
    run.deviceHostname ? { hostname: run.deviceHostname } : null,
    ledgerRows,
    intentRows,
    deviceHostnames,
    narrativeArtifact,
    draftRows,
  );
  return c.json({ data: detail });
});

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 8. Thumbs up/down on a verdict a
 * `verdict`-profile run produced — NOT a mutation of customer data (it never
 * touches `alerts` or anything an org admin would consider "theirs"), so
 * this is gated on the same read permission as `GET /runs`/`GET
 * /runs/:runId` above, not `requireAiWrite`. `recordVerdictFeedback` updates
 * by `verdictId` alone and relies on the request's ambient RLS context (see
 * its own docstring) — a verdict outside the caller's org 404s the same way
 * an out-of-org run id does on the routes above.
 *
 * Task 14 carry-in B (PR-A review): a caller must not silently overwrite
 * ANOTHER user's already-recorded feedback (their own changed mind is fine)
 * — `recordVerdictFeedback`'s `'conflict'` result answers 409 here. A
 * successful write is audited (`ai_agent.verdict_feedback`), same as the
 * other two write paths that answer through this file directly (manual
 * trigger, circuit reset) — see the file-level NOTE for why the AGENT
 * mutation handlers above are the exception, not this one.
 */
aiAgentsRoutes.post(
  '/verdicts/:verdictId/feedback',
  scopes,
  requireAiRead,
  zValidator('json', z.object({ feedback: z.enum(['up', 'down']) })),
  async (c) => {
    const auth = c.get('auth');
    const verdictId = uuidParam(c, 'verdictId');
    if (!verdictId) return c.json({ error: 'Verdict not found' }, 404);

    const { feedback } = c.req.valid('json');
    const result = await recordVerdictFeedback(auth, verdictId, feedback);
    if (result.status === 'not_found') return c.json({ error: 'Verdict not found' }, 404);
    if (result.status === 'conflict') {
      return c.json({ error: 'Feedback already recorded by another user' }, 409);
    }

    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'ai_agent.verdict_feedback',
      resourceType: 'ai_alert_verdict',
      resourceId: verdictId,
      details: { feedback },
      result: 'success',
    });
    return c.json({ ok: true });
  },
);

/**
 * Phase 2 wave P2-6 (#4193), Task A8 — the "AI operations impact" reporting
 * surface: an estimated-time-saved dashboard over `ai_agent_impact_daily`.
 * All four routes are registered here, immediately after the verdict-feedback
 * block and BEFORE `GET /:id` below — same reason as `/effective`,
 * `/policy-decidable-keys` and `/runs/:runId` above them: a literal path
 * segment ("impact") must not fall into the `:id` param route.
 */

/**
 * `GET /ai/agents/impact?window=7|30|90[&orgId]` — no MFA (a read). A
 * system-scoped caller MUST name one org (one weight set belongs to one
 * partner); `orgId` present but outside the caller's accessible set is a
 * 403. `loadImpactSummary` (A7) carries its own defensive copy of both
 * checks — this is the primary gate.
 */
aiAgentsRoutes.get(
  '/impact',
  scopes,
  requireAiRead,
  zValidator('query', impactQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId !== undefined) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system') {
      return c.json({
        error: 'org_id_required',
        message: 'A system-scoped impact query must name one organization — one weight set belongs to one partner.',
      }, 400);
    }

    const data = await loadImpactSummary(auth, query);
    return c.json({ data });
  },
);

/**
 * `POST /ai/agents/impact/rebuild[?orgId]` — manual refresh. Targets one org
 * (`orgId`, 403 if inaccessible) or every org the caller can reach
 * (`auth.accessibleOrgIds`; `null` means unrestricted system scope, which
 * must then name one org the same way `GET /impact` does). Deterministic
 * job ids (`enqueueImpactRollupForOrgs` → `buildImpactRollupJobId`) make a
 * repeated press a natural no-op, so this is safe to call repeatedly.
 */
aiAgentsRoutes.post(
  '/impact/rebuild',
  scopes,
  requireAiWrite,
  zValidator('query', impactRebuildQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('query');

    let orgIds: string[];
    if (orgId !== undefined) {
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      orgIds = [orgId];
    } else if (auth.accessibleOrgIds === null) {
      return c.json({
        error: 'org_id_required',
        message: 'A system-scoped impact rebuild must name one organization.',
      }, 400);
    } else {
      orgIds = auth.accessibleOrgIds;
    }

    if (orgIds.length > AI_AGENT_IMPACT_REBUILD_MAX_ORGS) {
      return c.json({
        error: 'too_many_orgs',
        limit: AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
        count: orgIds.length,
      }, 409);
    }

    const through = lastCompleteUtcDay();
    const from = shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1));
    const queued = await enqueueImpactRollupForOrgs(orgIds, from, through);

    writeRouteAudit(c, {
      orgId: orgId ?? null,
      action: 'ai_agent_impact.rebuild_requested',
      resourceType: 'ai_agent_impact',
      details: { orgCount: orgIds.length, from, through },
      result: 'success',
    });

    return c.json({ queued, from, through }, 202);
  },
);

/**
 * `PUT /ai/agents/impact/weights` — an estimate-model preference, not a
 * credential or a destructive act, so deliberately NO `requireMfa()` (unlike
 * `DELETE /:id` below, which removes an agent policy — plan Deviation 5).
 * Gated on `canManagePartnerWidePolicies`, checked here BEFORE resolving a
 * partnerId so an organization-scoped or selected-access caller 403s without
 * ever needing one; `saveImpactWeights` (A6) re-checks the same capability
 * as a second gate for any future non-route caller.
 */
aiAgentsRoutes.put(
  '/impact/weights',
  scopes,
  requireAiWrite,
  zValidator('json', impactWeightsSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const overrides = c.req.valid('json');
    try {
      const partnerId = await resolveImpactPartnerId(auth);
      const { before, after, effective } = await saveImpactWeights(auth, partnerId, overrides);
      writeRouteAudit(c, {
        orgId: null,
        action: 'ai_agent_impact_weights.updated',
        resourceType: 'ai_agent_impact_weights',
        resourceId: partnerId,
        details: { before, after },
        result: 'success',
      });
      return c.json({ data: { effective, overrides: after } });
    } catch (err) {
      return mapError(c, err);
    }
  },
);

/** `DELETE /ai/agents/impact/weights` — resets to defaults. Same gate as the PUT above. */
aiAgentsRoutes.delete('/impact/weights', scopes, requireAiWrite, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }

  try {
    const partnerId = await resolveImpactPartnerId(auth);
    const { before, after, effective } = await saveImpactWeights(auth, partnerId, null);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ai_agent_impact_weights.updated',
      resourceType: 'ai_agent_impact_weights',
      resourceId: partnerId,
      details: { before, after },
      result: 'success',
    });
    return c.json({ data: { effective, overrides: after } });
  } catch (err) {
    return mapError(c, err);
  }
});

aiAgentsRoutes.get('/:id', scopes, requireAiRead, async (c) => {
  const auth = c.get('auth');
  const id = uuidParam(c, 'id');
  const row = id ? await getAgent(auth, id) : null;
  if (!row) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ data: mapRow(row) });
});

aiAgentsRoutes.get(
  '/:id/runs',
  scopes,
  requireAiRead,
  zValidator('query', z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })),
  async (c) => {
    const auth = c.get('auth');
    const id = uuidParam(c, 'id');
    const row = id ? await getAgent(auth, id) : null;
    if (!row) return c.json({ error: 'Agent not found' }, 404);

    const { limit } = c.req.valid('query');
    // Same org predicate as GET /runs/:runId. A partner-wide agent's runs are
    // owned by the DEVICE's org, not the agent's, so filtering by the agent
    // alone would show a partner admin every org's runs for that baseline
    // regardless of which orgs they can actually reach.
    //
    // Review fix (#3828): projected through the same list-item mapper as the
    // org-wide `GET /runs` above. The prior `db.select()` (no projection)
    // put the whole `outcome` jsonb on the wire under the identical
    // ai_agents:read gate the hardened routes enforce — including
    // proposedActions[].args, the verbatim raw tool input the model
    // proposed. No in-repo consumer of the raw shape exists (apps/web,
    // apps/portal, apps/mobile, e2e-tests grepped clean), so there is no
    // legacy wire shape to preserve.
    const runs = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        orgId: aiAgentRuns.orgId,
        orgName: organizations.name,
        deviceId: aiAgentRuns.deviceId,
        status: aiAgentRuns.status,
        triggerKind: aiAgentRuns.triggerKind,
        profile: aiAgentRuns.profile,
        runVerdict: sql<string | null>`${aiAgentRuns.outcome}->>'runVerdict'`,
        queuedAt: aiAgentRuns.queuedAt,
        finishedAt: aiAgentRuns.finishedAt,
        costCents: aiAgentRuns.costCents,
      })
      .from(aiAgentRuns)
      .leftJoin(organizations, eq(aiAgentRuns.orgId, organizations.id))
      .where(and(eq(aiAgentRuns.agentId, row.id), auth.orgCondition(aiAgentRuns.orgId)))
      .orderBy(desc(aiAgentRuns.queuedAt))
      .limit(limit);
    // agentName comes from the already-loaded, RLS-visible `row` (this route
    // is scoped to one agent), not a join — every run here shares it.
    return c.json({ data: runs.map((r) => mapRunListItem({ ...r, agentName: row.name })) });
  },
);

// Triggering autonomous work on a customer machine is at least as consequential
// as editing the policy, so it carries the same write-permission and MFA gates as
// every mutating route in this file.
aiAgentsRoutes.post(
  '/:id/runs',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', triggerAgentRunSchema),
  async (c) => {
    const auth = c.get('auth');
    const id = uuidParam(c, 'id');
    if (!id) return c.json({ error: 'Agent not found' }, 404);

    const agent = await getAgent(auth, id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const { deviceId } = c.req.valid('json');
    const access = await verifyDeviceAccess(deviceId, auth);
    if ('error' in access) return c.json({ error: access.error }, 404);

    // Every outcome below is audited: `createAndEnqueueAgentRun` writes no audit
    // row of its own, so this closure is the only record of which human asked
    // for autonomous work on this device — including when the answer was "no".
    const auditTrigger = (result: 'success' | 'failure', details: Record<string, unknown>) => {
      writeRouteAudit(c, {
        orgId: access.device.orgId,
        action: 'ai_agent.run.manual_trigger',
        resourceType: 'ai_agent',
        resourceId: agent.id,
        resourceName: agent.name,
        details,
        result,
      });
    };

    // The loaded row is an authorization/visibility handle and supplies the
    // requested kind. Admission deliberately re-resolves the effective agent,
    // which may be an org override or partner baseline different from this row.
    // Runs belong to the device's organization, never the agent's: a visible
    // partner-wide agent has no orgId of its own.
    const result = await createAndEnqueueAgentRun({
      orgId: access.device.orgId,
      kind: agent.kind,
      triggerKind: 'manual',
      deviceId,
      // A human pressing "run now" twice means twice. Dedupe keys collapse
      // repeated event-driven delivery, not distinct explicit instructions.
      dedupeKey: `manual:${randomUUID()}`,
      triggerRef: { requestedByUserId: auth.user.id, agentId: agent.id },
    });

    if (!result.created) {
      auditTrigger('failure', { deviceId, reason: result.skipped });
      // Admission declined, so no run row exists. An honest conflict — including
      // for `kill_switch_off` — beats reporting success for work nobody queued.
      return c.json({ error: 'run_skipped', reason: result.skipped }, 409);
    }

    if (result.run.status === 'failed') {
      auditTrigger('failure', { deviceId, runId: result.run.id, errorCode: result.run.errorCode });
      // Admission inserted the row and then marked it terminal-failed because the
      // BullMQ enqueue did not land; 202 would promise processing that cannot happen.
      return c.json({
        error: 'run_enqueue_failed',
        code: result.run.errorCode ?? 'enqueue_failed',
        runId: result.run.id,
      }, 503);
    }

    auditTrigger('success', { deviceId, runId: result.run.id, triggerKind: 'manual' });
    return c.json({ data: { runId: result.run.id, status: result.run.status } }, 202);
  },
);

aiAgentsRoutes.post(
  '/',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', createAiAgentSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    let owner: { orgId: string | null; partnerId: string | null };

    if (body.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide agents require partner scope' }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgResult = resolveOrgId(auth, body.orgId, true);
      if ('error' in orgResult) {
        return c.json({ error: orgResult.error }, orgResult.status);
      }
      if (!orgResult.orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }
      owner = { orgId: orgResult.orgId, partnerId: null };
    }

    try {
      const row = await createAgent(auth, owner, body);
      return c.json({ data: mapRow(row) }, 201);
    } catch (err) {
      return mapError(c, err);
    }
  },
);

aiAgentsRoutes.patch(
  '/:id',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', updateAiAgentSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const id = uuidParam(c, 'id');
    if (!id) return c.json({ error: 'Agent not found' }, 404);
    try {
      const row = await updateAgent(auth, id, body);
      return c.json({ data: mapRow(row) });
    } catch (err) {
      return mapError(c, err);
    }
  },
);

aiAgentsRoutes.delete('/:id', scopes, requireAiWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const id = uuidParam(c, 'id');
  if (!id) return c.json({ error: 'Agent not found' }, 404);
  try {
    const row = await disableAgent(auth, id);
    return c.json({ data: mapRow(row) });
  } catch (err) {
    return mapError(c, err);
  }
});

/**
 * Wave 6 PR 2 (#3828) — the per-org circuit breaker's read surface. Circuit
 * state is keyed `(org_id, agent_id)`, not just `agent_id` (a partner-wide
 * agent runs against many orgs and a failure streak in one must not read as
 * open for every other), so — same shape as `GET /effective` /
 * `GET /exposure-budget` above — the caller must resolve which org's view of
 * this agent it wants. `resolveOrgId` auto-resolves it for an
 * organization-scoped caller and a single-org partner; anyone else must pass
 * it explicitly.
 */
aiAgentsRoutes.get(
  '/:id/circuit',
  scopes,
  requireAiRead,
  zValidator('query', z.object({ orgId: z.string().guid().optional() })),
  async (c) => {
    const auth = c.get('auth');
    const id = uuidParam(c, 'id');
    if (!id) return c.json({ error: 'Agent not found' }, 404);
    const agent = await getAgent(auth, id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const { orgId: requestedOrgId } = c.req.valid('query');
    const orgResult = resolveOrgId(auth, requestedOrgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    if (!orgResult.orgId) return c.json({ error: 'orgId is required' }, 400);

    // Authorized resolution (checks `auth.canAccessOrg`), NOT
    // `resolveEffectiveAgentSystem` — that variant is reserved for run
    // admission and release tooling (see its own docstring). Only used here
    // to surface the CURRENT threshold alongside the counter; a missing
    // effective policy (e.g. the agent was disabled since it last ran) falls
    // back to the shared default rather than failing the read.
    const resolved = await resolveEffectiveAgent(auth, orgResult.orgId, agent.kind);
    const maxConsecutiveFailures =
      resolved?.effective.limits.maxConsecutiveFailures ?? AI_AGENT_LIMIT_DEFAULTS.maxConsecutiveFailures;

    const snapshot = await getCircuitState(orgResult.orgId, id);
    return c.json({ data: { ...snapshot, maxConsecutiveFailures } });
  },
);

/**
 * The ONLY way an open circuit closes (wave-6 quorum: "manual MFA reset
 * only" — never automatic, and a config edit on the agent must never touch
 * this row, see `agentService.test.ts`'s coverage). Same write-permission +
 * MFA gate as every other mutating route in this file.
 */
aiAgentsRoutes.post(
  '/:id/circuit/reset',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', z.object({
    orgId: z.string().guid().optional(),
    reason: z.string().trim().min(3).max(1000),
  })),
  async (c) => {
    const auth = c.get('auth');
    const id = uuidParam(c, 'id');
    if (!id) return c.json({ error: 'Agent not found' }, 404);
    const agent = await getAgent(auth, id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    if (!orgResult.orgId) return c.json({ error: 'orgId is required' }, 400);

    const snapshot = await resetCircuit(orgResult.orgId, id, auth.user.id);
    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'ai_agent.circuit_reset',
      resourceType: 'ai_agent',
      resourceId: id,
      resourceName: agent.name,
      details: { reason: body.reason, agentId: id, orgId: orgResult.orgId },
      result: 'success',
    });
    return c.json({ data: snapshot });
  },
);
