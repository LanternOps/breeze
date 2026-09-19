/**
 * Wave 4 Part B — agent-safe remediation-suggestion act resolver (Task 7, #3826).
 *
 * `remediation_suggestion` is a VIRTUAL manifest op (actManifest.ts) — there
 * is no real MCP tool by that name, so `resolveActOperation` can never match
 * it from a model tool call. This module is the actual resolver the plan's
 * virtual entry defers to: given a `suggestionId`, it decides whether that
 * suggestion is currently act-eligible and, if so, resolves it to exactly the
 * `run_script` op + input `revalidateActExecution` (actRevalidation.ts)
 * expects — the SAME normal act pipeline a model-initiated `run_script` call
 * goes through, not a parallel execution path. This module never dispatches
 * a script itself.
 *
 * Deliberately agent-actable BEFORE a human clicks "accept" (`status:
 * 'suggested'`, not `'accepted'`/`'edited'`) — the human-approval route
 * (POST /remediation-suggestions/:id/execute, routes/remediationSuggestions.ts)
 * requires accepted/edited precisely because a human is the one deciding to
 * run it; skipping that wait for a bounded, revalidated, verified, act-eligible
 * suggestion is the entire point of act mode. What still gates it is
 * `validateRemediationExecutionApproval` (reused, not re-implemented, from
 * that same route): high/critical `riskTier` suggestions still require an
 * approved elevation request — act mode does not bypass that upstream
 * human-in-the-loop rail, it only removes the redundant "click accept" step
 * for what elevation approval (or a low/medium risk tier) already clears.
 *
 * actAssets.scriptIds (Task 6) is checked HERE, independently of
 * `revalidateActExecution`'s own gate on the same field — the same
 * defense-in-depth shape Task 3 already established (matches, then
 * revalidates, against the SAME condition twice): once whoever eventually
 * wires this into the run loop feeds `resolved.input` through the normal
 * pipeline, that second check is redundant-but-safe, not the only line of
 * defense.
 *
 * NOT wired to a live agent-facing surface. Wave 3 never exposed
 * `remediationSuggestions` to the agent as a tool or in the triage prompt
 * (grepped: no `aiTools*.ts` file references it), so there is nothing today
 * that calls `resolveActableSuggestion` with a real suggestionId. Per the
 * plan (Task 7 contract: "if there is genuinely no agent-facing surface,
 * implement the resolver + tests and leave the tool wiring as a documented
 * follow-up rather than inventing a new tool") this module is that resolver,
 * fully tested in isolation; the tool/prompt wiring is a deferred follow-up
 * (file as an issue at PR time — plan Self-Review Notes).
 */
import { eq } from 'drizzle-orm';
import type { AiAgentKind } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module import, not the ../../db/schema barrel — same rationale as
// actRevalidation.ts: keeps this leaf module's unit tests from having to
// stub the entire schema surface.
import { remediationSuggestions } from '../../db/schema/remediationSuggestions';
import { validateRemediationExecutionApproval } from '../../routes/remediationSuggestions';
import { ACT_MANIFEST, type ActOperation } from './actManifest';
import { resolveEffectiveAgentSystem } from './effectivePolicy';

/**
 * Same skip-if-already-system shape as every other leaf module in this
 * directory (actRevalidation.ts, executionLedger.ts, runFinishedNotify.ts).
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export interface RemediationActRunContext {
  id: string;
  orgId: string;
  agentId: string;
  agentKind: AiAgentKind;
  deviceId: string;
}

/**
 * Exactly the shape `revalidateActExecution` (actRevalidation.ts) needs to
 * treat this as an ordinary `run_script` act call — `op`/`toolName`/`input`
 * are what a caller would hand to `resolveActOperation`'s output, not a
 * bespoke suggestion-shaped structure.
 */
export interface ResolvedSuggestionAct {
  op: ActOperation;
  toolName: 'run_script';
  input: { scriptId: string; deviceIds: [string]; parameters: Record<string, unknown> };
  suggestionId: string;
  scriptId: string;
}

export type ResolveActableSuggestionResult =
  | { ok: true; resolved: ResolvedSuggestionAct }
  /**
   * `deny` — a structural mismatch (wrong org/device/shape/status, or a
   * still-required elevation approval): nothing to propose, since there was
   * never a real tool call in play. `propose` — the ONE case that mirrors
   * Task 6's run_script contract exactly: a real, in-scope, approvable
   * suggestion whose script just is not in this agent's actAssets.scriptIds
   * ("never act-eligible ... proposals still work").
   */
  | { ok: false; disposition: 'deny' | 'propose'; reason: string };

function normalizeSuggestionParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Resolve `suggestionId` to an act-eligible `run_script` call for this run,
 * or explain why it is not (yet) one. Pure I/O orchestration — never mutates
 * the suggestion row (see `stampSuggestionExecutedByAgent` for that, called
 * only after the resolved call actually executed).
 */
export async function resolveActableSuggestion(args: {
  runContext: RemediationActRunContext;
  suggestionId: string;
}): Promise<ResolveActableSuggestionResult> {
  const { runContext, suggestionId } = args;

  return inSystemDbContext(async () => {
    const [suggestion] = await db
      .select()
      .from(remediationSuggestions)
      .where(eq(remediationSuggestions.id, suggestionId))
      .limit(1);

    if (!suggestion) {
      return { ok: false, disposition: 'deny', reason: 'Suggestion not found' };
    }
    if (suggestion.orgId !== runContext.orgId) {
      return { ok: false, disposition: 'deny', reason: 'Suggestion belongs to a different organization' };
    }
    // Literal `deviceId === run.deviceId` per the plan contract — deliberately
    // NOT the routes/remediationSuggestions.ts `singleTargetDeviceId` derivation
    // (targetDeviceIds fallback): act mode is single-device (Global
    // Constraints), so a suggestion without an unambiguous single deviceId is
    // out of scope here, not a case to reconstruct one for.
    if (suggestion.deviceId !== runContext.deviceId) {
      return { ok: false, disposition: 'deny', reason: 'Suggestion targets a different device than this run' };
    }
    if (suggestion.targetType !== 'script' || !suggestion.scriptId) {
      return { ok: false, disposition: 'deny', reason: 'Only script remediation suggestions are act-eligible' };
    }
    if (suggestion.status !== 'suggested') {
      return {
        ok: false,
        disposition: 'deny',
        reason: `Suggestion status "${suggestion.status}" is not act-eligible (must be "suggested")`,
      };
    }

    // Reused, not re-implemented: high/critical riskTier still requires an
    // approved elevation request, exactly as the human /execute route
    // enforces. Act mode never bypasses this upstream human-in-the-loop rail.
    const approvalError = await validateRemediationExecutionApproval(suggestion, runContext.deviceId);
    if (approvalError) {
      return { ok: false, disposition: 'deny', reason: approvalError };
    }

    const policy = await resolveEffectiveAgentSystem(runContext.orgId, runContext.agentKind);
    if (!policy || policy.agentId !== runContext.agentId) {
      return {
        ok: false,
        disposition: 'deny',
        reason: "Could not re-resolve the live agent policy, or the run's agent is no longer effective",
      };
    }

    // Task 6's per-script gate, checked here too (defense in depth — see
    // module docstring): a suggestion for a script this agent has not been
    // explicitly authorized to run unattended is not act-eligible, but it IS
    // still a legitimate suggestion — proposal, never a deny.
    if (!policy.effective.actAssets.scriptIds.includes(suggestion.scriptId)) {
      return {
        ok: false,
        disposition: 'propose',
        reason: 'Script is not authorized for unattended act-mode execution (actAssets.scriptIds)',
      };
    }

    const runScriptOp = ACT_MANIFEST.find((op) => op.key === 'run_script');
    // Structurally impossible (run_script is a frozen manifest entry —
    // actManifest.test.ts pins it) but never throw out of a resolver.
    if (!runScriptOp) {
      return { ok: false, disposition: 'deny', reason: 'run_script is not present in the act manifest' };
    }

    return {
      ok: true,
      resolved: {
        op: runScriptOp,
        toolName: 'run_script',
        input: {
          scriptId: suggestion.scriptId,
          deviceIds: [runContext.deviceId],
          parameters: normalizeSuggestionParameters(suggestion.parameters),
        },
        suggestionId: suggestion.id,
        scriptId: suggestion.scriptId,
      },
    };
  });
}

/**
 * Reserved key inside `remediation_suggestions.parameters` (an existing,
 * already `excludedOpen`-classified jsonb column — no migration, no new
 * export-policy entry) carrying agent attribution for an act-mode execution.
 * Exact Part A precedent: `script_executions.parameters`'s `$actor` sidecar
 * key (scriptDispatch.ts) — `executedBy` stays a users-FK column and MUST
 * stay NULL for an agent actor (there is no synthetic users row for an
 * `ai_agents.id` to degrade from), so attribution rides in the jsonb instead.
 * `$` can never start a real script parameter name
 * (SCRIPT_PARAMETER_KEY_PATTERN, scriptDispatch.ts), so this can never
 * collide with caller-supplied data.
 */
const SUGGESTION_ACTOR_PARAMETER_KEY = '$actor';

/**
 * Stamp a suggestion as executed by an act-mode agent, once the resolved
 * `run_script` call has actually dispatched and produced a script execution.
 * Best-effort: the real-world mutation the suggestion described has already
 * happened by the time this is called (the script ran), so a failure to
 * update the suggestion row's bookkeeping must never be reported back as an
 * execution failure — same philosophy as `startToolExecution`'s ledger
 * writes (runLoop.ts) and `insertPlaybookExecutionRow` (playbookActExecutor.ts).
 */
export async function stampSuggestionExecutedByAgent(args: {
  suggestionId: string;
  scriptExecutionId: string;
  agentId: string;
  runId: string;
}): Promise<void> {
  try {
    await inSystemDbContext(async () => {
      const [existing] = await db
        .select({ parameters: remediationSuggestions.parameters })
        .from(remediationSuggestions)
        .where(eq(remediationSuggestions.id, args.suggestionId))
        .limit(1);

      const now = new Date();
      await db
        .update(remediationSuggestions)
        .set({
          status: 'executed',
          scriptExecutionId: args.scriptExecutionId,
          // Never a synthetic users-FK id for an agent actor — Part A
          // precedent (script_executions.triggered_by / playbook
          // triggered_by_user_id both null for an ai_agent principal).
          executedBy: null,
          executedAt: now,
          updatedAt: now,
          parameters: {
            ...normalizeSuggestionParameters(existing?.parameters),
            [SUGGESTION_ACTOR_PARAMETER_KEY]: {
              actorType: 'ai_agent',
              actorId: args.agentId,
              runId: args.runId,
            },
          },
        })
        .where(eq(remediationSuggestions.id, args.suggestionId));
    });
  } catch (error) {
    console.error('[remediationActResolver] failed to stamp suggestion as executed', {
      suggestionId: args.suggestionId, scriptExecutionId: args.scriptExecutionId, error,
    });
  }
}
