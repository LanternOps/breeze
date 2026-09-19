import type { StreamObservation } from '../toolCapture/streamObserver';
import type { GoldenCase } from './goldenPrompts';

export interface CaseScore {
  id: string;
  hit: boolean;
  observedTool: string | null;
  observedAction: string | null;
  answeredWithoutTool: boolean;
}

export function scoreFirstCall(c: GoldenCase, observation: Pick<StreamObservation, 'toolUses'>): CaseScore {
  const first = observation.toolUses.find((use) => use.name !== 'ToolSearch');
  const observedTool = first?.name.replace(/^mcp__(?:breeze|script_builder)__/, '') ?? null;
  const observedAction = typeof first?.input.action === 'string' ? first.input.action : null;
  return {
    id: c.id,
    hit: !!first && c.expect.some((e) => e.tool === observedTool
      && (e.action === undefined || e.action === observedAction)),
    observedTool,
    observedAction,
    answeredWithoutTool: !first,
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
