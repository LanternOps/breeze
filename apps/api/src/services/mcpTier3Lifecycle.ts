/**
 * Transport-neutral Tier-3 MCP tool lifecycle (MCP-OAUTH-12; B-W04 #6158,
 * D-B29): ledger (fail closed) -> dispatch -> ledger complete + the uniform
 * `mcp.tool.<name>` audit. Moved verbatim out of routes/mcpServer.ts so the
 * action-intent release worker wraps an `mcp_api` intent's dispatch in the
 * SAME lifecycle the direct MCP path uses. Two seams were generalised, nothing
 * else: the Hono context became an injected McpAuditSink (requestAuditSink /
 * systemAuditSink), and the caller's JSON-RPC response shape became a generic
 * R with explicit ledger-unavailable / unexpected-throw responses.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs } from '../db/schema/audit';
import type { ActionIntent } from '../db/schema/actionIntents';
import type { Context } from 'hono';
import type { AuthContext } from '../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent, type AuditEventInput } from './auditEvents';
import { sanitizeAuditPayload, summarizePayload, summarizeToolResult } from './auditPayloadSanitizer';
import { redactAiToolOutputText } from './aiToolOutput';
import {
  beginMcpToolExecutionLedger,
  completeMcpToolExecutionLedger,
  type McpToolExecutionLedgerHandle,
} from './mcpToolExecutionLedger';
import {
  correlationAuditDetails,
  type McpReleaseCorrelation,
  type McpRequestCorrelation,
} from './mcpRequestCorrelation';
import type { McpApiKeyContext } from './mcpPrincipalAuth';

/** Receives the uniform tool audit event. */
export type McpAuditSink = (event: AuditEventInput) => void;

/** Request path: the Hono context's IP / user agent / auth attribution. */
export function requestAuditSink(c: Context | undefined): McpAuditSink | null {
  if (!c) return null;
  return (event) => writeAuditEvent(c, event);
}

/** Worker path: no request, so no IP / user agent. */
export const systemAuditSink: McpAuditSink = (event) => writeAuditEvent(requestLikeFromSnapshot({}), event);

/** The credential fields the ledger and audit record (an McpApiKeyContext satisfies it). */
export type McpLifecyclePrincipal = Pick<McpApiKeyContext, 'id' | 'orgId' | 'partnerId' | 'oauthGrantId' | 'partnerServicePrincipalId'>;

export type McpLifecycleCorrelation = McpRequestCorrelation | McpReleaseCorrelation;

function isReleaseCorrelation(c: McpLifecycleCorrelation): c is McpReleaseCorrelation {
  return (c as McpReleaseCorrelation).kind === 'intent_release';
}

function lifecycleSessionId(c: McpLifecycleCorrelation): string | null {
  return isReleaseCorrelation(c) ? null : c.sessionId;
}

function lifecycleEra(c: McpLifecycleCorrelation): 'legacy' | 'modern' | 'release' {
  return isReleaseCorrelation(c) ? 'release' : c.era;
}

function lifecycleCorrelationAuditDetails(c: McpLifecycleCorrelation): Record<string, unknown> {
  if (!isReleaseCorrelation(c)) return correlationAuditDetails(c);
  return {
    correlation: {
      kind: c.kind,
      requestId: c.requestId,
      era: 'release',
      intentId: c.intentId,
      creationRequestId: c.creationRequestId,
      principalKey: c.principalKey,
    },
  };
}

/** A fresh correlation for one release attempt of an intent. */
export function buildMcpReleaseCorrelation(intent: {
  id: string;
  correlationId: string;
  originPrincipalKind: string;
  originPrincipalId: string | null;
}): McpReleaseCorrelation {
  return {
    kind: 'intent_release',
    requestId: randomUUID(),
    intentId: intent.id,
    creationRequestId: intent.correlationId,
    principalKey: `${intent.originPrincipalKind}:${intent.originPrincipalId ?? ''}`,
  };
}

export function writeMcpToolAuditEvent(
  audit: McpAuditSink | null,
  event: {
    principal?: McpLifecyclePrincipal;
    auth: AuthContext;
    correlation: McpLifecycleCorrelation;
    orgId?: string | null;
    toolName: string;
    /** Deprecated alias the client sent, when it differed from `toolName`. */
    requestedToolName?: string;
    tier: number;
    toolInput: Record<string, unknown>;
    durationMs: number;
    status: 'success' | 'failure';
    result?: string;
    error?: unknown;
    /** See Tier3LifecycleContext.approvalBypassPrincipal. */
    approvalBypassPrincipal?: string | null;
  },
): void {
  if (!audit || !event.principal) return;
  const principal = event.principal;

  const error = event.error instanceof Error ? event.error : undefined;
  // event.orgId is the authoritative execution org (resolveMcpExecutionContext).
  // NEVER fall back to a raw client-supplied toolInput.orgId here — doing so
  // would let a partner-scoped caller forge cross-tenant audit_logs attribution
  // (audit rows are written under the RLS-bypassed system context).
  const orgId = event.orgId ?? principal.orgId ?? event.auth.orgId ?? null;
  audit({
    orgId,
    actorType: 'api_key',
    actorId: principal.id,
    action: `mcp.tool.${event.toolName}`.slice(0, 100),
    resourceType: 'mcp_tool_execution',
    // B-W03 (#6157, D-B19): the server-minted request id, shared with the
    // request audit row and both ledger representations.
    resourceId: event.correlation.requestId,
    result: event.status === 'success' ? 'success' : 'failure',
    errorMessage: error ? redactAiToolOutputText(error.message).slice(0, 1000) : undefined,
    details: {
      sessionId: lifecycleSessionId(event.correlation),
      approvalId: null,
      ...(event.approvalBypassPrincipal
        ? { approvalBypass: 'unattended_principal', approvalBypassPrincipal: event.approvalBypassPrincipal }
        : {}),
      oauthGrantId: principal.oauthGrantId ?? null,
      ...(principal.partnerServicePrincipalId
        ? { principalType: 'partner_service_principal', partnerServicePrincipalId: principal.partnerServicePrincipalId }
        : {}),
      partnerId: event.auth.partnerId ?? principal.partnerId ?? null,
      orgId: orgId ?? null,
      toolName: event.toolName,
      ...(event.requestedToolName && event.requestedToolName !== event.toolName
        ? { requestedToolName: event.requestedToolName, deprecatedToolAlias: true }
        : {}),
      tier: event.tier,
      target: summarizePayload(event.toolInput, { maxStringLength: 512 }),
      arguments: sanitizeAuditPayload(event.toolInput, { maxStringLength: 2048 }),
      durationMs: event.durationMs,
      ...(event.result ? { result: summarizeToolResult(event.result, { maxStringLength: 500 }) } : {}),
      ...(error ? { errorClass: error.name } : {}),
      ...lifecycleCorrelationAuditDetails(event.correlation),
    },
  });
}

// ============================================
// Shared Tier 3 execution lifecycle (MCP-OAUTH-12)
// ============================================

export interface McpTier3LifecycleContext {
  /** Where the uniform `mcp.tool.<name>` audit goes; null skips it (no request). */
  audit: McpAuditSink | null;
  auth: AuthContext;
  principal: McpLifecyclePrincipal | undefined;
  correlation: McpLifecycleCorrelation;
  /** Set on release: written to ai_tool_executions.intent_id. */
  intentId?: string;
  /** Authoritative execution org (resolveMcpExecutionContext / bootstrap default). */
  orgId: string | null;
  toolName: string;
  /**
   * The name the CLIENT actually sent, when it was a deprecated alias that
   * resolved to a different `toolName` (see services/aiToolAliases.ts). Audit
   * records it so "is anyone still calling the old name?" is a query rather
   * than a grep of ephemeral console output — that is the signal the alias is
   * safe to delete. Undefined on the overwhelmingly common non-aliased call.
   */
  requestedToolName?: string;
  tier: number;
  toolInput: Record<string, unknown>;
  /**
   * Set only when the interactive-approval gate was lifted for this call by
   * MCP_UNATTENDED_TIER3_PRINCIPALS: the principal ref that matched.
   */
  approvalBypassPrincipal?: string | null;
}

export interface McpTier3ExecutionOutcome<R> {
  status: 'success' | 'failure';
  /**
   * Summarized result string recorded on the ledger + uniform audit on SUCCESS.
   * Mirrors the ordinary path, which records `result` on success and `error`
   * (not result) on failure.
   */
  ledgerResult?: string;
  /** On failure: an Error (thrown or a partial-failure marker) for errorClass/message. */
  error?: unknown;
  response: R;
}

/**
 * Ledger begin for a Tier-3 call (fail closed): null when the ledger cannot be
 * created or the context lacks a principal / org — the caller must then NOT
 * dispatch.
 */
async function beginTier3Ledger(ctx: McpTier3LifecycleContext): Promise<McpToolExecutionLedgerHandle | null> {
  if (!ctx.principal || !ctx.orgId) return null;
  const principal = ctx.principal;
  try {
    return await beginMcpToolExecutionLedger({
      orgId: ctx.orgId,
      accessibleOrgIds: ctx.auth.accessibleOrgIds,
      toolName: ctx.toolName,
      tier: ctx.tier,
      toolInput: ctx.toolInput,
      transportSessionId: lifecycleSessionId(ctx.correlation),
      transportRequestId: ctx.correlation.requestId,
      era: lifecycleEra(ctx.correlation),
      ...(ctx.intentId ? { intentId: ctx.intentId } : {}),
      principal: {
        apiKeyId: principal.id,
        oauthGrantId: principal.oauthGrantId ?? null,
        partnerId: ctx.auth.partnerId ?? principal.partnerId ?? null,
        // A partner service principal's `user` is its owner, borrowed for
        // RBAC; the ledger records the principal and owns no user session.
        partnerServicePrincipalId: principal.partnerServicePrincipalId ?? null,
        actorUserId: principal.partnerServicePrincipalId ? null : ctx.auth.user.id,
      },
    });
  } catch (err) {
    console.error('[MCP] Failed to create tool execution ledger:', ctx.toolName, err);
    return null;
  }
}

/**
 * Shared Tier 3 begin/execute/complete/audit lifecycle (MCP-OAUTH-12). Used by
 * BOTH the ordinary tools/call path and the bootstrap authTool dispatch so the
 * fail-closed ledger and uniform `mcp.tool.<name>` audit are identical for every
 * Tier 3 mutation.
 *
 * Ordering (preserves Task 6's resolution → ledger → handler → complete+audit):
 *   1. create the execution ledger BEFORE the mutation; fail CLOSED if creation
 *      fails (the handler never runs without a durable ledger row);
 *   2. run the `execute` callback (which owns path-specific response construction
 *      AND classifies its own success/partial-failure/thrown-failure outcome);
 *   3. complete the ledger with the outcome status + duration; and
 *   4. write the uniform `mcp.tool.<name>` audit for BOTH outcomes.
 *
 * Tiers below 3 skip the ledger (as the ordinary path always has) but still emit
 * the uniform audit. The wrapper NEVER skips the ledger for a Tier 3 tool because
 * the principal is inconvenient — OAuth bearers already carry a synthetic
 * `apiKey` context (`oauth:<jti>`), exactly like ordinary Tier 3 bearer calls.
 */
export async function runMcpTier3Lifecycle<R>(
  ctx: McpTier3LifecycleContext,
  execute: (ledger: McpToolExecutionLedgerHandle | null) => Promise<McpTier3ExecutionOutcome<R>>,
  responses: {
    /** The ledger could not be created: nothing was dispatched. */
    ledgerUnavailable: () => R;
    /** The execute callback threw (it should classify its own outcome). */
    unexpectedThrow: () => R;
  },
): Promise<R> {
  let ledgerHandle: McpToolExecutionLedgerHandle | null = null;
  if (ctx.tier >= 3) {
    ledgerHandle = await beginTier3Ledger(ctx);
    if (!ledgerHandle) return responses.ledgerUnavailable();
  }

  const startedAt = Date.now();
  let outcome: McpTier3ExecutionOutcome<R>;
  try {
    outcome = await execute(ledgerHandle);
  } catch (err) {
    // The execute callback is expected to classify its own outcome and never
    // throw. This defensive net STILL completes the ledger + audit (never skip
    // them) before surfacing a generic error.
    console.error('[MCP] Unexpected throw from Tier 3 execute callback:', ctx.toolName, err);
    const failureResponse = responses.unexpectedThrow();
    await finalizeTier3ToolLifecycle(
      ctx,
      ledgerHandle,
      { status: 'failure', error: err, response: failureResponse },
      Date.now() - startedAt,
    );
    return failureResponse;
  }

  await finalizeTier3ToolLifecycle(ctx, ledgerHandle, outcome, Date.now() - startedAt);
  return outcome.response;
}

async function finalizeTier3ToolLifecycle<R>(
  ctx: McpTier3LifecycleContext,
  ledgerHandle: McpToolExecutionLedgerHandle | null,
  outcome: McpTier3ExecutionOutcome<R>,
  durationMs: number,
): Promise<void> {
  if (ledgerHandle) {
    await completeMcpToolExecutionLedger({
      handle: ledgerHandle,
      status: outcome.status,
      durationMs,
      result: outcome.status === 'success' ? outcome.ledgerResult : undefined,
      error: outcome.status === 'failure' ? outcome.error : undefined,
    }).catch((err) => {
      console.error('[MCP] Failed to complete tool execution ledger:', ctx.toolName, err);
    });
  }
  writeMcpToolAuditEvent(ctx.audit, {
    principal: ctx.principal,
    auth: ctx.auth,
    correlation: ctx.correlation,
    orgId: ctx.orgId,
    toolName: ctx.toolName,
    requestedToolName: ctx.requestedToolName,
    tier: ctx.tier,
    toolInput: ctx.toolInput,
    approvalBypassPrincipal: ctx.approvalBypassPrincipal ?? null,
    durationMs,
    status: outcome.status,
    result: outcome.status === 'success' ? outcome.ledgerResult : undefined,
    error: outcome.status === 'failure' ? outcome.error : undefined,
  });
}

// ============================================
// B-W04 (#6158, D-B29): release of an mcp_api action intent
// ============================================

export type McpReleaseLifecycle = {
  /** The rebuilt origin auth with the ledger's aiOrigin, as the direct path sets it. */
  auth: AuthContext;
  /** Ledger complete + uniform audit. Idempotent; never throws. */
  finish(outcome: { status: 'success' | 'failure'; ledgerResult?: string; error?: unknown }): Promise<void>;
};

type ReleaseIntent = Pick<
  ActionIntent,
  'id' | 'orgId' | 'actionName' | 'arguments' | 'riskTier' | 'correlationId' | 'originPrincipalKind' | 'originPrincipalId'
>;

/** The credential the rebuilt auth came from, in the lifecycle's principal shape. */
function releasePrincipal(intent: ReleaseIntent, auth: AuthContext): McpLifecyclePrincipal {
  const grantId = auth.principal?.kind === 'oauth_grant' ? auth.principal.grantId ?? null : null;
  return {
    id: grantId ? `oauth:grant:${grantId}` : intent.originPrincipalId ?? 'unknown',
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
    oauthGrantId: grantId,
    partnerServicePrincipalId: null,
  };
}

/**
 * Opens the Tier-3 ledger (ai_tool_executions.intent_id set, era 'release')
 * for the release of an `mcp_api` intent, before anything is dispatched.
 * Returns null when the ledger cannot be created: the worker then fails the
 * intent `mcp_ledger_unavailable` without dispatching.
 */
export async function beginMcpReleaseLifecycle(
  intent: ReleaseIntent,
  auth: AuthContext,
): Promise<McpReleaseLifecycle | null> {
  const ctx: McpTier3LifecycleContext = {
    audit: systemAuditSink,
    auth,
    principal: releasePrincipal(intent, auth),
    correlation: buildMcpReleaseCorrelation(intent),
    intentId: intent.id,
    orgId: intent.orgId,
    toolName: intent.actionName,
    tier: Math.max(3, intent.riskTier ?? 3),
    toolInput: intent.arguments ?? {},
  };
  const handle = await beginTier3Ledger(ctx);
  if (!handle) return null;
  const startedAt = Date.now();
  let finished = false;
  return {
    auth: { ...auth, aiOrigin: handle.aiOrigin },
    async finish(outcome) {
      if (finished) return;
      finished = true;
      try {
        await finalizeTier3ToolLifecycle(ctx, handle, { ...outcome, response: undefined }, Date.now() - startedAt);
      } catch (err) {
        console.error('[MCP] Failed to finalize release lifecycle for intent', intent.id, err);
      }
    },
  };
}

export type McpIntentOutcome = 'rejected' | 'expired' | 'cancelled' | 'release_refused';

/**
 * The uniform `mcp.tool.<name>` failure audit for an `mcp_api` intent that
 * never executed: a terminal non-execution (rejected / expired / cancelled)
 * or a release refused before dispatch. Outbox delivery is at-least-once, so
 * an existing row for (intent, action, intentOutcome) makes this a no-op.
 * Never throws.
 */
export async function writeMcpIntentOutcomeAudit(
  intent: ReleaseIntent & { partnerId?: string | null },
  outcome: McpIntentOutcome,
  errorCode?: string,
): Promise<void> {
  const action = `mcp.tool.${intent.actionName}`.slice(0, 100);
  try {
    const existing = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.resourceType, 'action_intent'),
        eq(auditLogs.resourceId, intent.id),
        eq(auditLogs.action, action),
        sql`${auditLogs.details}->>'intentOutcome' = ${outcome}`,
      ))
      .limit(1)));
    if (existing.length > 0) return;
    const grantId = intent.originPrincipalKind === 'oauth_grant' ? intent.originPrincipalId : null;
    systemAuditSink({
      orgId: intent.orgId,
      actorType: 'api_key',
      actorId: grantId ? `oauth:grant:${grantId}` : intent.originPrincipalId ?? null,
      action,
      resourceType: 'action_intent',
      resourceId: intent.id,
      result: 'failure',
      details: {
        intentOutcome: outcome,
        ...(errorCode ? { errorCode } : {}),
        intentId: intent.id,
        oauthGrantId: grantId,
        partnerId: intent.partnerId ?? null,
        orgId: intent.orgId,
        toolName: intent.actionName,
        tier: Math.max(3, intent.riskTier ?? 3),
        target: summarizePayload(intent.arguments ?? {}, { maxStringLength: 512 }),
        correlation: {
          kind: 'intent_outcome',
          intentId: intent.id,
          creationRequestId: intent.correlationId,
          principalKey: `${intent.originPrincipalKind}:${intent.originPrincipalId ?? ''}`,
        },
      },
    });
  } catch (err) {
    console.error('[MCP] Failed to write intent outcome audit for', intent.id, err);
  }
}
