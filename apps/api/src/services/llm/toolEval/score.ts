import type { StreamObservation } from '../toolCapture/streamObserver';
import type { GoldenCase } from './goldenPrompts';
import { toolInputSchemas, validateToolInput } from '../../aiToolSchemas';

export interface CaseScore {
  id: string;
  hit: boolean;
  observedTool: string | null;
  observedAction: string | null;
  answeredWithoutTool: boolean;
  /** True when the first tool_use named a tool the surface's allowedTools
   *  never exposed — such a call can never legitimately count as a hit,
   *  even if it happens to match the case's expected tool name (which can
   *  only happen if the golden case itself expects an unexposed tool). */
  unavailableTool: boolean;
  /** #12421: every non-ToolSearch call's input run through `validateToolInput`; see `scoreSchemaValidity`. Optional so an errored run (no calls) needs no fabricated values. */
  schemaValid?: boolean;
  schemaCheckedCalls?: number;
  schemaValidCalls?: number;
  schemaInvalidCalls?: Array<{ name: string; error: string }>;
}

export type SchemaScore = Required<Pick<CaseScore, 'schemaValid' | 'schemaCheckedCalls' | 'schemaValidCalls' | 'schemaInvalidCalls'>>;

/**
 * Whether the model's tool inputs would pass the production input validator.
 * Unlike `scoreFirstCall` this looks at EVERY call in the observation (a first
 * call can be right while a later one is malformed). ToolSearch is not a
 * registry tool and is skipped, as is any tool without a registered input
 * schema (tenant/BYO tools): those are not counted at all.
 */
export function scoreSchemaValidity(
  observation: Pick<StreamObservation, 'toolUses'>,
  validate: (name: string, input: Record<string, unknown>) => { success: true } | { success: false; error: string } = validateToolInput,
): SchemaScore {
  const invalid: SchemaScore['schemaInvalidCalls'] = [];
  let checked = 0;
  for (const use of observation.toolUses) {
    if (use.name === 'ToolSearch') continue;
    const name = use.name.replace(/^mcp__(?:breeze|script_builder)__/, '');
    // A tool with no registered input schema (tenant/BYO MCP tools, outcome
    // tools) cannot be judged by the validator; it is neither valid nor invalid.
    if (validate === validateToolInput && !Object.hasOwn(toolInputSchemas, name)) continue;
    checked++;
    const result = validate(name, use.input ?? {});
    if (!result.success) invalid.push({ name, error: result.error });
  }
  return { schemaValid: invalid.length === 0, schemaCheckedCalls: checked, schemaValidCalls: checked - invalid.length, schemaInvalidCalls: invalid };
}

/**
 * `allowedTools`, when given, is the full set of `mcp__…__<name>` tool
 * names the surface actually allowed for this run. A first tool_use naming
 * a tool outside that set is never a hit and is flagged `unavailableTool`
 * so the report can render it as "<tool> (not exposed)" instead of a plain
 * miss/hit, which would otherwise look like an ordinary tool-selection
 * error rather than a structural gap in the surface's tool grant.
 */
export function scoreFirstCall(
  c: GoldenCase,
  observation: Pick<StreamObservation, 'toolUses'>,
  allowedTools?: ReadonlySet<string>,
): CaseScore {
  const first = observation.toolUses.find((use) => use.name !== 'ToolSearch');
  const observedTool = first?.name.replace(/^mcp__(?:breeze|script_builder)__/, '') ?? null;
  const observedAction = typeof first?.input.action === 'string' ? first.input.action : null;
  const unavailableTool = !!first && !!allowedTools && !allowedTools.has(first.name);
  return {
    id: c.id,
    hit: !!first && !unavailableTool && c.expect.some((e) => e.tool === observedTool
      && (e.action === undefined || e.action === observedAction)),
    observedTool,
    observedAction,
    answeredWithoutTool: !first,
    unavailableTool,
  };
}

export function summarize(scores: CaseScore[]): {
  total: number; hits: number; accuracy: number; misses: CaseScore[];
  /** Σ valid / Σ checked calls; null when no case checked a call. */
  schemaValidRate: number | null;
  schemaCheckedCalls: number;
  schemaValidCalls: number;
} {
  const hits = scores.filter((score) => score.hit).length;
  const checked = scores.reduce((sum, s) => sum + (s.schemaCheckedCalls ?? 0), 0);
  const valid = scores.reduce((sum, s) => sum + (s.schemaValidCalls ?? 0), 0);
  return {
    schemaValidRate: checked === 0 ? null : valid / checked,
    schemaCheckedCalls: checked,
    schemaValidCalls: valid,
    total: scores.length,
    hits,
    accuracy: scores.length === 0 ? 0 : hits / scores.length,
    misses: scores.filter((score) => !score.hit),
  };
}
