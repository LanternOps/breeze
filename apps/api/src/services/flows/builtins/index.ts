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
import type { BuiltinContext } from './types';

export type { BuiltinContext } from './types';

function invalid(message: string, rendered: Record<string, unknown>): StepOutcome {
  return { kind: 'failed', code: 'input_invalid', message, policy: true, renderedInput: rendered as Record<string, FlowValue> };
}

export async function executeFlowBuiltin(
  name: FlowBuiltinName,
  rendered: Record<string, unknown>,
  ctx: BuiltinContext,
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
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown built-in flow step '${String(exhaustive)}'`);
    }
  }
}
