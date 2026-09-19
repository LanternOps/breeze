import type { StreamObservation } from '../toolCapture/streamObserver';
import type { GoldenCase } from './goldenPrompts';

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

export function summarize(scores: CaseScore[]): { total: number; hits: number; accuracy: number; misses: CaseScore[] } {
  const hits = scores.filter((score) => score.hit).length;
  return {
    total: scores.length,
    hits,
    accuracy: scores.length === 0 ? 0 : hits / scores.length,
    misses: scores.filter((score) => !score.hit),
  };
}
