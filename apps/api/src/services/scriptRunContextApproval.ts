/**
 * Resolves the run context an approver is being asked to authorise (#4888).
 *
 * Letting an assistant pick `runAs` is a privilege decision, not wiring: a
 * script whose saved default is the logged-in user can now be launched as
 * SYSTEM because the model asked for it. The rule that makes that acceptable
 * is that the human approving the call is TOLD which context it will run in —
 * so this resolves the effective context and hands it to both the approval
 * card and the intent's stored reason.
 *
 * Deliberately fail-soft. Every field can come back null: an approval card
 * that renders "the script's saved run context" because a lookup hiccuped is
 * strictly better than an approval path that 500s, and the caller treats a
 * thrown error as "no run-context line" rather than propagating it.
 */
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { scripts } from '../db/schema';
import { stripMcpPrefix } from './mcpToolNames';
import { captureException } from './sentry';
import type { AiScriptRunContext } from '@breeze/shared/types/ai';

export type ScriptRunAs = 'system' | 'user' | 'elevated';

/**
 * Alias of the shared SSE payload type, not a parallel definition — the value
 * this module produces IS what the `approval_required` event carries, and a
 * second local shape is how the card ends up rendering a field the server
 * stopped sending.
 */
export type ScriptApprovalRunContext = AiScriptRunContext;

/**
 * The tools that launch a saved script. Both names appear: `run_script` is the
 * handler (what the guardrail layer and `ai_tool_executions` are keyed on) and
 * `execute_script_on_device` is what the Script Builder exposes to the model
 * (#4883). Matching both means the card is right regardless of which identity
 * the caller happens to be holding.
 */
const SCRIPT_LAUNCH_TOOL_NAMES = new Set(['run_script', 'execute_script_on_device']);

export function isScriptLaunchTool(toolName: string): boolean {
  return SCRIPT_LAUNCH_TOOL_NAMES.has(stripMcpPrefix(toolName));
}

function asRunAs(value: unknown): ScriptRunAs | null {
  return value === 'system' || value === 'user' || value === 'elevated' ? value : null;
}

/**
 * @returns the run context for a script-launch tool call, or null when the
 *   tool is not one (so the caller adds no run-context line at all).
 */
export async function resolveScriptRunContextForApproval(
  toolName: string,
  input: Record<string, unknown>,
  orgId: string,
): Promise<ScriptApprovalRunContext | null> {
  if (!isScriptLaunchTool(toolName)) return null;

  // Only 'system' / 'user' are accepted from a caller — `executeScriptSchema`
  // refuses 'elevated', which stays a property of the saved script. Reading
  // the raw input here rather than the parsed value keeps this usable at
  // approval time, BEFORE the handler runs; an out-of-range value simply
  // reads as "the assistant chose nothing" and the schema rejects it later.
  const chosen = input.runAs === 'system' || input.runAs === 'user' ? input.runAs : null;
  const targetSessionId = typeof input.targetSessionId === 'number' ? input.targetSessionId : null;

  let scriptDefaultRunAs: ScriptRunAs | null = null;
  const scriptId = typeof input.scriptId === 'string' ? input.scriptId : null;
  if (scriptId) {
    try {
      const [row] = await withDbAccessContext(
        { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
        () => db.select({ runAs: scripts.runAs }).from(scripts).where(eq(scripts.id, scriptId)).limit(1),
      );
      scriptDefaultRunAs = asRunAs(row?.runAs);
    } catch (err) {
      // Non-fatal by design — see the module docstring. Captured rather than
      // swallowed silently so a persistently unreadable script row (an RLS
      // regression, say) is visible instead of just quietly degrading every
      // approval card to the vaguer wording.
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[scriptRunContextApproval] Failed to read script default runAs:', scriptId, err);
    }
  }

  return {
    effectiveRunAs: chosen ?? scriptDefaultRunAs,
    scriptDefaultRunAs,
    chosenByAssistant: chosen !== null,
    targetSessionId,
  };
}

function runAsPhrase(runAs: ScriptRunAs, targetSessionId: number | null): string {
  if (runAs === 'system') return 'SYSTEM (full machine privileges)';
  // NOT "the logged-in user, elevated": the agent's `resolveRunAsSession`
  // returns no session for 'elevated' exactly as it does for 'system'
  // (agent/internal/heartbeat/handlers_script.go), so an elevated run never
  // enters the user's desktop session — it runs in the agent's own context
  // with administrator privileges. On Unix `configureRunAs`
  // (agent/internal/executor/executor.go) prefixes sudo; on Windows nothing
  // elevates at launch time, the agent service must ALREADY be elevated or
  // the run is refused. Wording mirrors the script form's own copy for the
  // same value.
  if (runAs === 'elevated') return 'ELEVATED (administrator privileges)';
  return targetSessionId != null
    ? `the logged-in user in session ${targetSessionId}`
    : 'the logged-in user';
}

/**
 * One English sentence naming the effective run context, appended to the
 * approval description so it reaches every surface that renders one (the chat
 * card, the intent's stored reason, the approvals queue, the mobile push).
 * The web card renders its own localized row from the structured value — this
 * string is the fallback for surfaces that only have prose.
 */
export function describeScriptRunContext(ctx: ScriptApprovalRunContext): string {
  if (!ctx.effectiveRunAs) return "Runs in the script's saved run context";

  const phrase = runAsPhrase(ctx.effectiveRunAs, ctx.targetSessionId);
  if (!ctx.chosenByAssistant) return `Runs as ${phrase} — the script's saved default`;

  // Naming the default only when it DIFFERS keeps the common "the assistant
  // asked for what the script already does" case short, and makes the genuine
  // escalation ("saved default is the logged-in user, this runs as SYSTEM")
  // the sentence that stands out.
  const overrides =
    ctx.scriptDefaultRunAs != null && ctx.scriptDefaultRunAs !== ctx.effectiveRunAs;
  return overrides
    ? `Runs as ${phrase} — chosen by the assistant, overriding the script's saved default of ${runAsPhrase(ctx.scriptDefaultRunAs!, null)}`
    : `Runs as ${phrase} — chosen by the assistant`;
}
