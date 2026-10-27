/**
 * Tool Catalog W05 (#5220), plan Task B2 — the in-process built-in step
 * dispatcher, shared by the runner (stepExecutor, after run-time
 * revalidation; Tier ≤ 2 only) and the release worker's flow branch (an
 * approved Tier-3 built-in, builtins/release.ts). Built-ins are not
 * registered tools: nothing here goes through `executeTool`.
 *
 * `rendered` is the input after rendering (and, from the runner, after the
 * schema parse that revalidation ran). Each executor re-checks what it relies
 * on; the literal `http_request` origin is taken from the PUBLICATION's step
 * definition (`ctx.step`), never from the rendered input.
 */
import { FLOW_BUILTIN_STEPS, isFlowBuiltin, type FlowBuiltinName, type FlowValue } from '@breeze/shared';
import type { StepOutcome } from '../stepExecutor';
import { toStoredFlowOutput } from '../storedOutput';
import { executeAiStep } from './aiStep';
import { literalOriginOf } from './httpPolicy';
import { executeHttpRequestStep } from './httpRequest';
import { executeNotifyStep } from './notify';
import { executeCreateAlert } from './createAlert';
import { executeResolveTargets, type ResolveTargetsInput } from './resolveTargets';
import { executeRunScriptOnTargets, type FleetVerifiedContext, type RunScriptOnTargetsInput } from './runScriptOnTargets';
import type { BuiltinContext } from './types';

export type { BuiltinContext } from './types';

function invalid(message: string, rendered: Record<string, unknown>): StepOutcome {
  return { kind: 'failed', code: 'input_invalid', message, policy: true, renderedInput: rendered as Record<string, FlowValue> };
}

function withRendered(outcome: StepOutcome, renderedInput: Record<string, FlowValue>): StepOutcome {
  return outcome.kind === 'skipped' || outcome.renderedInput ? outcome : { ...outcome, renderedInput };
}

/**
 * `verified` (W6, release path only): what the release worker re-checked under
 * the dispatch claim — the script snapshot and, for a parked fleet step, the
 * device list frozen at intent creation. Only `run_script_on_targets` reads it.
 */
export async function executeFlowBuiltin(
  name: FlowBuiltinName,
  rendered: Record<string, unknown>,
  ctx: BuiltinContext,
  verified?: FleetVerifiedContext,
): Promise<StepOutcome> {
  if (!isFlowBuiltin(name)) throw new Error(`Unknown built-in flow step '${String(name)}'`);
  const renderedInput = rendered as Record<string, FlowValue>;
  switch (name) {
    case 'set': {
      const parsed = FLOW_BUILTIN_STEPS.set.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid set input.', rendered);
      return { kind: 'completed', ...toStoredFlowOutput(parsed.data.values as Record<string, FlowValue>), renderedInput };
    }
    case 'wait': {
      const parsed = FLOW_BUILTIN_STEPS.wait.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid wait input.', rendered);
      const resumeAt = new Date(Date.now() + parsed.data.minutes * 60_000);
      return { kind: 'park_wait', resumeAt, output: { waitUntil: resumeAt.toISOString() }, renderedInput };
    }
    case 'notify': {
      const parsed = FLOW_BUILTIN_STEPS.notify.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid notify input.', rendered);
      return executeNotifyStep(parsed.data, ctx);
    }
    case 'http_request': {
      const parsed = FLOW_BUILTIN_STEPS.http_request.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid http_request input.', rendered);
      const literal = typeof ctx.step.input.url === 'string' ? literalOriginOf(ctx.step.input.url) : null;
      if (!literal?.ok) {
        // Unreachable for a validated publication; never guess an origin.
        return { kind: 'failed', code: 'egress_blocked', message: 'This step has no fixed origin to call.', policy: true, renderedInput };
      }
      return executeHttpRequestStep(parsed.data, { ...ctx, literalOrigin: literal.origin });
    }
    case 'ai': {
      const parsed = FLOW_BUILTIN_STEPS.ai.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid ai input.', rendered);
      return executeAiStep(parsed.data, ctx);
    }
    // ── W6 (#5221) legacy-conversion built-ins ──
    case 'resolve_targets': {
      const parsed = FLOW_BUILTIN_STEPS.resolve_targets.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid resolve_targets input.', rendered);
      return withRendered(await executeResolveTargets(parsed.data as ResolveTargetsInput, ctx), renderedInput);
    }
    case 'create_alert': {
      const parsed = FLOW_BUILTIN_STEPS.create_alert.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid create_alert input.', rendered);
      return withRendered(await executeCreateAlert(parsed.data, ctx), renderedInput);
    }
    case 'run_script_on_targets': {
      const parsed = FLOW_BUILTIN_STEPS.run_script_on_targets.inputSchema.safeParse(rendered);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid run_script_on_targets input.', rendered);
      return withRendered(await executeRunScriptOnTargets(parsed.data as RunScriptOnTargetsInput, ctx, verified), renderedInput);
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown built-in flow step '${String(exhaustive)}'`);
    }
  }
}
