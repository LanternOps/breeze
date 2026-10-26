/**
 * Tool Catalog W05 (#5220), plan Task B5 — the `ai` built-in.
 * Filled in by Task B5; until then it refuses without calling a model.
 */
import type { StepOutcome } from '../stepExecutor';
import type { BuiltinContext } from './types';

export interface AiStepInput {
  prompt: string;
  tools: string[];
  output: Record<string, unknown>;
  maxTurns: number;
  maxOutputTokens: number;
}

export async function executeAiStep(_input: AiStepInput, _ctx: BuiltinContext): Promise<StepOutcome> {
  return { kind: 'failed', code: 'tool_unavailable', message: 'The ai step is not available yet.', policy: true };
}
