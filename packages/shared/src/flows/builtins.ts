import { z } from 'zod';
import { FLOW_INPUT_NAME_RE } from '../validators/flows';

/**
 * Built-in flow step tools. They live here (not in `aiTools`) because they are only
 * meaningful inside flows. W3 ships `wait` and `set`; the rest are later.
 */
export const FLOW_BUILTIN_STEPS = {
  wait: {
    tier: 1 as const,
    description: 'Pause the flow for a number of minutes (1-1440) before the next step runs.',
    inputSchema: z.object({ minutes: z.number().int().min(1).max(1440) }).strict(),
  },
  set: {
    tier: 1 as const,
    description: 'Compute named values from templates for later steps to read as steps.<id>.output.',
    inputSchema: z.object({
      values: z
        .record(z.string().regex(FLOW_INPUT_NAME_RE), z.unknown())
        .refine((v) => {
          const n = Object.keys(v).length;
          return n >= 1 && n <= 20;
        }, { message: 'values must have 1 to 20 keys' }),
    }).strict(),
  },
} satisfies Record<string, { tier: 1; inputSchema: z.ZodType; description: string }>;

export type FlowBuiltinName = keyof typeof FLOW_BUILTIN_STEPS;

export const FLOW_LATER_BUILTINS = ['notify', 'ai', 'http_request'] as const;

export function isFlowBuiltin(name: string): name is FlowBuiltinName {
  return Object.hasOwn(FLOW_BUILTIN_STEPS, name);
}
