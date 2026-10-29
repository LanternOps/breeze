/**
 * Ledger rows for chat tool calls the pre-tool hook refused (#10411).
 *
 * `createSessionPreToolUse` (aiAgentSdk.ts) can refuse a call at a dozen
 * gates — unknown tool, allowlist, Wisp ceiling, input validation,
 * guardrails, RBAC, rate limit, the launch_specialist precheck — before any
 * `ai_tool_executions` row exists. The handler then echoes the refusal through
 * postToolUse, which for a Tier 1 tool inserted a `failed` row but for a Tier
 * 2+ tool only UPDATEs a row in `executing` — so a refused Tier 2+ call left
 * NO row, and a reviewer counting calls against rows came up short with the
 * reason surviving only in the model's prose.
 *
 * The pre hook now writes the row itself: status `rejected`, the refusal text
 * in `error_message`, `tool_input` redacted exactly like every other row,
 * `tool_output` never written. It then leaves a marker here so the echo's
 * postToolUse writes nothing more (and never UPDATEs a concurrently
 * `executing` sibling of the same name with this call's refusal).
 *
 * Pairing is by the SDK tool_use id both hooks receive for the same call.
 * Only a call the SDK sent without one falls back to tool name + refusal
 * text, which can only mis-pair two same-name refusals with the same text —
 * both are refusals with identical rows, so the ledger stays exact.
 */
import { db, withDbAccessContext } from '../db';
import { aiToolExecutions } from '../db/schema';
import { redactAiToolOutputText, redactSensitiveToolInput } from './aiToolOutput';
import { captureException } from './sentry';
import type { ActiveSession } from './streamingSessionManager';

/** What the row says when the pre hook threw instead of deciding. */
export const PRE_HOOK_THREW_REFUSAL = 'Guardrails check failed';

const REFUSAL_TEXT_MAX_CHARS = 1_000;

interface LedgeredRefusals {
  byToolUseId: Set<string>;
  /** No-id fallback: per tool name, the refusal texts still awaiting their echo. */
  byName: Map<string, string[]>;
}

const ledgeredRefusalsBySession = new WeakMap<ActiveSession, LedgeredRefusals>();

function refusalsFor(session: ActiveSession): LedgeredRefusals {
  let state = ledgeredRefusalsBySession.get(session);
  if (!state) {
    state = { byToolUseId: new Set(), byName: new Map() };
    ledgeredRefusalsBySession.set(session, state);
  }
  return state;
}

/**
 * The `error_message` a refusal row keeps: the refusal (and its detail),
 * passed through the same text redactor as tool output — a validation message
 * can quote a model-supplied value — and bounded.
 */
export function refusalLedgerText(refusal: { error: string; detail?: string }): string {
  const text = redactAiToolOutputText(refusal.detail ? `${refusal.error} — ${refusal.detail}` : refusal.error);
  return text.length > REFUSAL_TEXT_MAX_CHARS ? `${text.slice(0, REFUSAL_TEXT_MAX_CHARS - 1)}…` : text;
}

/**
 * Writes the refused call's one ledger row and marks its echo. Best-effort: a
 * failed write is logged and never changes the verdict (the call is refused
 * either way). No marker is left when the write failed, so the echo keeps the
 * old behaviour and a Tier 1 refusal still gets its `failed` row from there.
 */
export async function recordPreHookRefusal(
  session: ActiveSession,
  toolName: string,
  input: Record<string, unknown>,
  refusal: { error: string; detail?: string },
  toolUseId: string | undefined,
): Promise<void> {
  const errorMessage = refusalLedgerText(refusal);
  try {
    await withDbAccessContext(
      { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
      () =>
        db.insert(aiToolExecutions).values({
          sessionId: session.breezeSessionId,
          toolName,
          toolInput: redactSensitiveToolInput(input),
          status: 'rejected',
          errorMessage,
          durationMs: 0,
          completedAt: new Date(),
        }),
    );
  } catch (err) {
    // The call is refused either way, but this refusal now has no ledger row
    // — the #10411 invariant is broken for it, so it is reported, not just logged.
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'aiChatRefusalLedger', orgId: session.orgId });
    console.error('[AI-SDK] Failed to write the refusal ledger row for tool:', toolName, err instanceof Error ? err.message : err);
    return;
  }
  const state = refusalsFor(session);
  if (toolUseId) {
    state.byToolUseId.add(toolUseId);
    return;
  }
  const pending = state.byName.get(toolName) ?? [];
  pending.push(refusal.error);
  state.byName.set(toolName, pending);
}

function echoedError(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output);
    const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    return typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
}

/**
 * postToolUse side: true when this result is the echo of a refusal whose
 * ledger row the pre hook already wrote — the caller then writes no
 * `ai_tool_executions` row and updates none. Consumes the marker.
 */
export function takeLedgeredRefusal(
  session: ActiveSession,
  toolName: string,
  output: string,
  isError: boolean,
  toolUseId: string | undefined,
): boolean {
  const state = ledgeredRefusalsBySession.get(session);
  if (!state) return false;
  if (toolUseId) return state.byToolUseId.delete(toolUseId);
  if (!isError) return false;
  const pending = state.byName.get(toolName);
  if (!pending?.length) return false;
  const error = echoedError(output);
  if (error === null) return false;
  // The handler may prefix (a thrown pre hook surfaces as
  // `Guardrails check failed: <reason>`); compaction may not lengthen it.
  const index = pending.findIndex((reason) => error === reason || error.startsWith(reason));
  if (index < 0) return false;
  pending.splice(index, 1);
  if (pending.length === 0) state.byName.delete(toolName);
  return true;
}
