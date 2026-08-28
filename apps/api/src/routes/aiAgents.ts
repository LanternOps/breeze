import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  AI_AGENT_KINDS,
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  AI_AGENT_RUN_STATUSES,
  type AgentRunVerdict,
  type AiAgentDto,
  type AiAgentRunListItemDto,
  createAiAgentSchema,
  triggerAgentRunSchema,
  updateAiAgentSchema,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { actionIntents, aiAgentRuns, aiAgents, aiToolExecutions, devices, type AiAgentRow } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import { AgentAccessDeniedError } from '../services/aiAgents/access';
import {
  createAgent, disableAgent, getAgent, listAgents, updateAgent,
  ActPrerequisitesNotMetError, AgentInvariantError, AgentKindConflictError,
  InvalidSupervisedActionKeysError, UnsupportedAgentModeError,
} from '../services/aiAgents/agentService';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { POLICY_DECIDABLE_TIER3 } from '../services/actionIntents/policyDecidable';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';
import { InvalidAgentRecipientsError } from '../services/aiAgents/recipients';
import { SUPPORTED_AGENT_MODES } from '../services/aiAgents/constants';
import { buildRunTrace } from '../services/aiAgents/runTrace';
import {
  buildRunsKeysetPredicate, decodeRunsCursor, encodeRunsCursor, runsCursorFromRow,
} from '../services/aiAgents/runsListCursor';
import { verifyDeviceAccess } from '../services/aiTools';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
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

/** Postgres unique-violation, for the create race the pre-check cannot win. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
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
  if (isUniqueViolation(err)) {
    return c.json({ error: 'An agent of this kind already exists', code: 'agent_kind_exists' }, 409);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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
 * The wire shape of one `GET /runs` row. Deliberately NOT `{ ...row }` for
 * the same reason `mapRow` (above) isn't: this is a list-item projection, no
 * outcome payload at all — the detail route below is where a caller goes for
 * the trace, ledger, and intents.
 */
function mapRunListItem(row: {
  id: string;
  agentId: string;
  agentName: string;
  deviceId: string | null;
  status: AiAgentRunListItemDto['status'];
  triggerKind: AiAgentRunListItemDto['triggerKind'];
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
    deviceId: row.deviceId,
    status: row.status,
    triggerKind: row.triggerKind,
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
  })),
  async (c) => {
    const auth = c.get('auth');
    const { cursor: cursorToken, limit, agentId, status } = c.req.valid('query');

    const cursor = decodeRunsCursor(cursorToken);
    if (cursorToken && !cursor) {
      return c.json({ error: 'Invalid or malformed cursor' }, 400);
    }

    const conditions: (SQL | undefined)[] = [auth.orgCondition(aiAgentRuns.orgId)];
    if (agentId) conditions.push(eq(aiAgentRuns.agentId, agentId));
    if (status) conditions.push(eq(aiAgentRuns.status, status));
    if (cursor) conditions.push(buildRunsKeysetPredicate(cursor));

    // Peek one extra row past `limit` to detect "is there a next page" —
    // mirrors routes/devices/core.ts's cursor-mode convention. The
    // (limit+1)th row becomes the nextCursor seed and is trimmed from data.
    const rows = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        agentName: aiAgents.name,
        deviceId: aiAgentRuns.deviceId,
        status: aiAgentRuns.status,
        triggerKind: aiAgentRuns.triggerKind,
        // Pulled straight out of the outcome jsonb by key rather than
        // selecting the whole column — this is a list endpoint, and the
        // full outcome (which is where the SAFE-projection risk lives) has
        // no business leaving Postgres for a row that isn't the one the
        // caller asked to see in detail.
        runVerdict: sql<string | null>`${aiAgentRuns.outcome}->>'runVerdict'`,
        queuedAt: aiAgentRuns.queuedAt,
        finishedAt: aiAgentRuns.finishedAt,
        costCents: aiAgentRuns.costCents,
      })
      .from(aiAgentRuns)
      .innerJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
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
      sessionId: aiAgentRuns.sessionId,
      triggerKind: aiAgentRuns.triggerKind,
      modeAtStart: aiAgentRuns.modeAtStart,
      status: aiAgentRuns.status,
      summary: aiAgentRuns.summary,
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
    .innerJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
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

  const detail = buildRunTrace(
    run,
    { name: run.agentName, kind: run.agentKind },
    run.deviceHostname ? { hostname: run.deviceHostname } : null,
    ledgerRows,
    intentRows,
  );
  return c.json({ data: detail });
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
    const runs = await db
      .select()
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.agentId, row.id), auth.orgCondition(aiAgentRuns.orgId)))
      .orderBy(desc(aiAgentRuns.queuedAt))
      .limit(limit);
    return c.json({ data: runs });
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
