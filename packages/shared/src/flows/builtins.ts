import { z } from 'zod';
import { FLOW_INPUT_NAME_RE } from '../validators/flows';
import { FLOW_RUN_LIMITS } from '../validators/flowRuns';

/**
 * Built-in flow step tools. They live here (not in `aiTools`) because they are only
 * meaningful inside flows. W3 shipped `wait` and `set`; W5 (#5220) adds `notify`,
 * `http_request` and `ai`.
 *
 * A built-in's tier may depend on its input (`http_request` GET/HEAD ⇒ 2, writes ⇒ 3),
 * so each entry has a `maxTier` ceiling and a `tierFor(input)` that never exceeds it.
 * `tierFor` fails closed: an input it cannot read (a templated method, a non-object)
 * resolves to `maxTier`.
 */
export type FlowBuiltinTier = 1 | 2 | 3;

export interface FlowBuiltinEntry {
  maxTier: FlowBuiltinTier;
  tierFor(input: unknown): FlowBuiltinTier;
  description: string;
  inputSchema: z.ZodType;
}

const HTTP_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

const scalar = z.union([z.string().max(4096), z.number(), z.boolean()]);

const boundedRecord = <T extends z.ZodType>(value: T, max: number, label: string) =>
  z.record(z.string().min(1).max(256), value).refine((r) => Object.keys(r).length <= max, {
    message: `${label} may have at most ${max} keys`,
  });

export const FLOW_BUILTIN_STEPS = {
  wait: {
    maxTier: 1,
    tierFor: (_input: unknown) => 1,
    description: 'Pause the flow for a number of minutes (1-1440) before the next step runs.',
    inputSchema: z.object({ minutes: z.number().int().min(1).max(1440) }).strict(),
  },
  set: {
    maxTier: 1,
    tierFor: (_input: unknown) => 1,
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
  notify: {
    maxTier: 2,
    tierFor: (_input: unknown) => 2,
    description: 'Send a short notice to a notification channel (email, Slack, Teams, SMS or Pushover).',
    inputSchema: z.object({
      channelId: z.string().uuid(),
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(4000),
      severity: z.enum(['info', 'warning', 'critical']).default('info'),
    }).strict(),
  },
  http_request: {
    maxTier: 3,
    // GET/HEAD read (Tier 2: an author-chosen origin can still receive tenant data in its URL);
    // every other method writes and parks for approval (Tier 3).
    tierFor: (input: unknown) => {
      const method = input && typeof input === 'object' ? (input as { method?: unknown }).method : undefined;
      return typeof method === 'string' && HTTP_READ_METHODS.has(method) ? 2 : 3;
    },
    description: 'Call an outside HTTPS API anonymously. The method and origin are fixed in the flow; path, query and body may use templates.',
    // Anonymous only in W5 (Decision 12): no credential field.
    inputSchema: z.object({
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().min(1).max(2048),
      query: boundedRecord(scalar, 50, 'query').optional(),
      headers: boundedRecord(z.string().max(4096), 30, 'headers').optional(),
      body: z.unknown().optional(),
    }).strict(),
  },
  ai: {
    maxTier: 1,
    // The step's effective tier is the max live tier of its allowlisted tools (the API's
    // transitive computation); every allowlisted tool must be Tier 1, so this is 1.
    tierFor: (_input: unknown) => 1,
    description: 'Ask the AI one bounded question over Tier-1 read tools and get a structured result.',
    inputSchema: z.object({
      prompt: z.string().min(1).max(8000),
      tools: z.array(z.string().min(1).max(128)).max(FLOW_RUN_LIMITS.aiMaxTools).default([]),
      output: z.record(z.string(), z.unknown()),
      maxTurns: z.number().int().min(1).max(FLOW_RUN_LIMITS.aiMaxTurns).default(4),
      maxOutputTokens: z.number().int().min(256).max(4096).default(1024),
    }).strict(),
  },
} satisfies Record<string, FlowBuiltinEntry>;

export type FlowBuiltinName = keyof typeof FLOW_BUILTIN_STEPS;

/** Built-ins announced but not shipped. Empty since W5; kept for the name-disjointness contract. */
export const FLOW_LATER_BUILTINS = [] as const;

export function isFlowBuiltin(name: string): name is FlowBuiltinName {
  return Object.hasOwn(FLOW_BUILTIN_STEPS, name);
}

/** The tier a built-in step pins for this (unrendered or rendered) input. */
export function flowBuiltinTierFor(name: FlowBuiltinName, input: unknown): FlowBuiltinTier {
  const entry: FlowBuiltinEntry = FLOW_BUILTIN_STEPS[name];
  return Math.min(entry.tierFor(input), entry.maxTier) as FlowBuiltinTier;
}
