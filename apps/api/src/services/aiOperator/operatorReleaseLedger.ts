/**
 * The AI Operator release ledger (#10129).
 *
 * An Operator child effect is minted by `effectDispatch.ts` as the plan
 * APPROVER (`buildTaskActorAuthContext`, principal `user_session`) and
 * released by the durable `intentReleaseWorker`. It is not MCP-origin
 * (`isMcpOriginIntent` needs an API key or OAuth grant), so the MCP release
 * ledger never ran for it and the release left NO `ai_tool_executions` row.
 * The /ai-risk activity feed (`GET /ai/admin/tool-executions`) reads only
 * `ai_tool_executions ⋈ ai_sessions`. That feed carries the one credential
 * reveal entry point (`TempPasswordSection`), so `identity_onboarding`'s
 * created-account password could not be reached from the UI.
 *
 * SHAPE. This mirrors `mcpToolExecutionLedger.ts`. Each release writes one
 * fresh `ai_sessions` row and one `ai_tool_executions` row carrying
 * `intent_id`:
 *  - Session `type` is `ai_operator`. That is no member of
 *    `CHAT_SESSION_TYPES` or `CLIENT_SESSION_TYPES`, so chat and client-AI
 *    lists never show it.
 *  - The session is no agent run's session (`ai_agent_runs.session_id` never
 *    names it), so the per-run governance views, which read a run's own
 *    session, never count it.
 *  - Operator effect work has no chat session to join (tasks carry no
 *    session column, and the auth carries `aiOriginSessionId: null`). The
 *    synthetic per-release session is the join target the feed needs, and no
 *    migration is involved because `ai_sessions.type` is free text.
 * The ledger covers EVERY Operator effect release, not only secret-bearing
 * ones, for the same full audit trail the MCP ledger keeps.
 *
 * SECRETS. The ledger never holds a credential. `toolInput.target` is the
 * same redacted `summarizePayload` digest the MCP ledger stores. The caller
 * passes no `ledgerResult` for a secret-bearing or carrier result, so such a
 * release records only status and duration. The sealed credential stays on
 * `action_intents.result`, and the feed derives `tempPasswordState` from its
 * key presence. Reveal still goes through `POST /action-intents/:id/reveal-secret`,
 * which admits only the intent's requester. For a plan child that is the
 * approver, so D-R2-6 is unchanged.
 *
 * FAIL CLOSED. `beginOperatorReleaseLedger` returns null when the rows cannot
 * be written, and the worker then fails the intent before dispatching
 * (`operator_ledger_unavailable`). This is the MCP release's rule: nothing
 * runs without its ledger row. `finish` never throws, because a completion
 * write that fails must not mask the release's own outcome.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { aiSessions, aiToolExecutions } from '../../db/schema/ai';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { summarizePayload, summarizeToolResult } from '../auditPayloadSanitizer';
import { redactAiToolOutputText } from '../aiToolOutput';

/** The `ai_sessions.type` of a synthetic Operator release session. */
export const AI_OPERATOR_SESSION_TYPE = 'ai_operator';
/** `ai_sessions.model` is NOT NULL; no model runs at release. */
const AI_OPERATOR_SESSION_MODEL = 'ai-operator';

type OperatorReleaseIntent = Pick<
  ActionIntent,
  | 'id' | 'orgId' | 'actionName' | 'arguments' | 'riskTier' | 'source' | 'originPrincipalKind'
  | 'taskId' | 'taskStepKey' | 'operationKey' | 'requestedByUserId' | 'decidedByUserId' | 'decidedAt'
>;

/**
 * True for an AI Operator child effect: an `mcp_api` intent requested by a
 * user session and linked to a task. MCP-credential intents are
 * `api_key`/`oauth_grant` (`isMcpOriginIntent`), so the two predicates are
 * disjoint.
 */
export function isOperatorOriginIntent(intent: {
  source: string;
  originPrincipalKind: string;
  taskId?: string | null;
}): boolean {
  return intent.source === 'mcp_api'
    && intent.originPrincipalKind === 'user_session'
    && intent.taskId != null;
}

export interface OperatorReleaseOutcome {
  status: 'success' | 'failure';
  /** A compact, non-secret result. Never passed for a secret-bearing release. */
  ledgerResult?: string;
  error?: unknown;
}

export interface OperatorReleaseLedger {
  sessionId: string;
  executionId: string;
  /** Close the ledger row with the release's own classification. Never throws. */
  finish(outcome: OperatorReleaseOutcome): Promise<void>;
}

function orgContext(orgId: string, userId: string | null) {
  return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], userId };
}

/**
 * Opens the ledger for the release of an Operator child, before anything is
 * dispatched. Returns null when the rows cannot be written.
 */
export async function beginOperatorReleaseLedger(
  intent: OperatorReleaseIntent,
): Promise<OperatorReleaseLedger | null> {
  const sessionId = crypto.randomUUID();
  const userId = intent.requestedByUserId ?? null;
  const tier = Math.max(3, intent.riskTier ?? 3);
  const operator = {
    taskId: intent.taskId,
    stepKey: intent.taskStepKey ?? null,
    operationKey: intent.operationKey ?? null,
    intentId: intent.id,
  };

  let executionId: string;
  try {
    executionId = await runOutsideDbContext(() =>
      withDbAccessContext(orgContext(intent.orgId, userId), async () => {
        await db.insert(aiSessions).values({
          id: sessionId,
          orgId: intent.orgId,
          userId,
          model: AI_OPERATOR_SESSION_MODEL,
          title: `AI Operator: ${intent.actionName}`.slice(0, 255),
          type: AI_OPERATOR_SESSION_TYPE,
          status: 'closed',
          contextSnapshot: { source: 'ai_operator', ...operator },
          systemPrompt: null,
        });

        const [execution] = await db
          .insert(aiToolExecutions)
          .values({
            sessionId,
            toolName: intent.actionName,
            toolInput: {
              source: 'ai_operator',
              orgId: intent.orgId,
              toolName: intent.actionName,
              tier,
              operator,
              target: summarizePayload(intent.arguments ?? {}, { maxStringLength: 512 }),
            },
            status: 'executing',
            approvedBy: intent.decidedByUserId ?? null,
            approvedAt: intent.decidedAt ?? null,
            intentId: intent.id,
          })
          .returning({ id: aiToolExecutions.id });
        if (!execution?.id) throw new Error('ai_tool_executions insert returned no row');
        return execution.id;
      }),
    );
  } catch (err) {
    console.error('[aiOperator] Failed to open the release ledger for intent', intent.id, err);
    return null;
  }

  const startedAt = Date.now();
  let finished = false;
  return {
    sessionId,
    executionId,
    async finish(outcome) {
      if (finished) return;
      finished = true;
      const durationMs = Date.now() - startedAt;
      const error = outcome.error instanceof Error ? outcome.error : undefined;
      const toolOutput: Record<string, unknown> = { source: 'ai_operator', status: outcome.status, durationMs };
      if (outcome.status === 'success' && outcome.ledgerResult) {
        toolOutput.result = summarizeToolResult(outcome.ledgerResult, { maxStringLength: 500 });
      }
      if (error) toolOutput.errorClass = error.name;
      try {
        await runOutsideDbContext(() =>
          withDbAccessContext(orgContext(intent.orgId, userId), () =>
            db.update(aiToolExecutions)
              .set({
                status: outcome.status === 'success' ? 'completed' : 'failed',
                toolOutput,
                errorMessage: error ? redactAiToolOutputText(error.message).slice(0, 1000) : undefined,
                durationMs,
                completedAt: new Date(),
              })
              .where(eq(aiToolExecutions.id, executionId))),
        );
      } catch (err) {
        console.error('[aiOperator] Failed to close the release ledger for intent', intent.id, err);
      }
    },
  };
}
